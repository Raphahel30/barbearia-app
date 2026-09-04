const DAY = 86400000;
const fail = (message, statusCode = 409) => Object.assign(new Error(message), { statusCode });

export async function cancelarPlanoMensal(db, uid, agendamentoId, now = new Date()) {
    if (!agendamentoId || typeof agendamentoId !== 'string' || agendamentoId.includes('/')) throw fail('Agendamento inválido.', 400);
    const agRef = db.collection('agendamentos').doc(agendamentoId);
    const subRef = db.collection('assinaturasClientes').doc(uid);
    return db.runTransaction(async tx => {
        const [agSnap, subSnap] = await Promise.all([tx.get(agRef), tx.get(subRef)]);
        if (!agSnap.exists || !subSnap.exists) throw fail('Plano ou agendamento não encontrado.', 404);
        const ag = agSnap.data();
        if (ag.userId !== uid || ag.isPlano !== true) throw fail('Acesso negado.', 403);
        if (ag.semanaCanceladaEm) return { status: ag.statusSemanaAposCancelamento, alreadyRecorded: true, agendamento: ag };
        if (!['confirmado', 'cancelado', 'reembolsado'].includes(ag.status)) throw fail('Este agendamento não pode ser cancelado.');
        const semanas = subSnap.data().semanas || {};
        const semana = Object.keys(semanas).find(k => semanas[k]?.agendamentoId === agendamentoId && semanas[k]?.status === 'agendado');
        if (!semana) throw fail('Semana do plano não identificada.');
        const horario = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(ag.dataHora || '') ? `${ag.dataHora}:00-03:00` : ag.dataHora;
        const data = new Date(horario);
        if (!Number.isFinite(data.getTime())) throw fail('Horário inválido. Procure o administrador.');
        const status = data.getTime() - now.getTime() > 3 * 3600000 ? 'disponivel' : 'falta';
        const iso = now.toISOString();
        const slotId = ag.slotId || `slot_${ag.dataHora}_${ag.barbeiroId || 'principal'}`;
        const slotRef = db.collection('slots_agendamentos').doc(slotId);
        const donoRef = db.collection('slots_proprietarios').doc(slotId);
        const [slot, dono] = await Promise.all([tx.get(slotRef), tx.get(donoRef)]);
        // Uma repetição antiga nunca remove uma reserva nova. Só a transição
        // confirmado -> cancelado libera o slot, dentro da mesma transação.
        if (ag.status === 'confirmado' && slot.exists) {
            if (!dono.exists || dono.data().userId !== uid || slot.data().dataHora !== ag.dataHora) throw fail('Titularidade do horário inconsistente. Procure o administrador.');
            tx.delete(slotRef);
            tx.delete(donoRef);
        }
        const semanaAtualizada = {
            status, agendamentoId: status === 'disponivel' ? null : agendamentoId,
            agendamentoData: status === 'disponivel' ? null : ag.dataHora, atualizadoEm: iso,
            versaoReserva: Number(semanas[semana].versaoReserva || 0) + (status === 'disponivel' ? 1 : 0)
        };
        const atualizacao = { status: ag.status === 'reembolsado' ? 'reembolsado' : 'cancelado', canceladoEm: iso, canceladoPor: 'cliente', semanaCanceladaEm: iso, statusSemanaAposCancelamento: status, atualizadoEm: iso };
        tx.update(subRef, { [`semanas.${semana}`]: semanaAtualizada, atualizadoEm: iso });
        tx.update(agRef, atualizacao);
        return { status, alreadyRecorded: false, agendamento: { ...ag, ...atualizacao } };
    });
}

function asDate(value) {
    return value?.toDate ? value.toDate() : new Date(value);
}

function brazilDay(value) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(asDate(value));
    const get = type => parts.find(part => part.type === type)?.value;
    return `${get('year')}-${get('month')}-${get('day')}`;
}

export function validarSemanaPlano(assinatura, semana, dataHora, now = new Date()) {
    if (!Number.isInteger(semana) || semana < 1 || semana > 4) throw fail('Semana inválida.', 400);
    if (!/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/.test(dataHora || '')) throw fail('Data e horário inválidos.', 400);
    const atendimento = new Date(`${dataHora}:00-03:00`);
    if (!Number.isFinite(atendimento.getTime()) || brazilDay(atendimento) !== dataHora.slice(0, 10)) throw fail('Data inválida.', 400);
    if (!assinatura || assinatura.status !== 'ativo' || !assinatura.dataPagamento || !assinatura.dataFim) throw fail('Plano mensal inativo.');
    const inicio = new Date(`${brazilDay(assinatura.dataPagamento)}T00:00:00-03:00`).getTime();
    const fimPlano = new Date(`${brazilDay(assinatura.dataFim)}T23:59:59.999-03:00`).getTime();
    const inicioSemana = inicio + (semana - 1) * 7 * DAY;
    const fimSemana = Math.min(fimPlano, semana === 4 ? fimPlano : inicio + semana * 7 * DAY - 1);
    if (now.getTime() < inicioSemana || now.getTime() > fimSemana) throw fail('Esta semana ainda não está disponível ou já expirou.');
    if (atendimento.getTime() < inicioSemana || atendimento.getTime() > fimSemana) throw fail('Escolha um horário dentro da semana selecionada.');
    const status = assinatura.semanas?.[semana]?.status || 'disponivel';
    if (status !== 'disponivel') throw fail('O crédito desta semana já foi utilizado.');
    return atendimento;
}

export async function agendarPlanoMensal(db, uid, input, now = new Date()) {
    const dataHora = String(input.dataHora || '');
    const semana = Number(input.semana);
    const assinaturaRef = db.collection('assinaturasClientes').doc(uid);
    const perfilRef = db.collection('usuarios').doc(uid);
    const configRef = db.collection('configuracoes').doc('geral');
    const expedienteRef = db.collection('configuracoes').doc('expediente');
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(dataHora)) throw fail('Data e horário inválidos.', 400);
    const bloqueioRef = db.collection('diasBloqueados').doc(dataHora.slice(0, 10));
    // A escolha do profissional e o catálogo são lidos no servidor, nunca aceitos do navegador.
    const [config, barbeiros] = await Promise.all([configRef.get(), db.collection('barbeiros').get()]);
    const multi = config.data()?.modoMultiBarbeiro === true;
    const desejado = String(input.barbeiroId || 'qualquer');
    const candidatos = multi
        ? barbeiros.docs.filter(d => d.data().status !== 'inativo' && (desejado === 'qualquer' || desejado === d.id)).map(d => ({ id: d.id, ...d.data() }))
        : [{ id: 'qualquer', nome: 'Barbearia EMAÚS', whatsapp: '' }];
    if (!candidatos.length) throw fail('Profissional indisponível.');
    return db.runTransaction(async tx => {
        const slotRefs = candidatos.map(b => db.collection('slots_agendamentos').doc(`slot_${dataHora}_${b.id}`));
        const [assinaturaSnap, perfilSnap, expedienteSnap, bloqueioSnap, ...slots] = await Promise.all([
            tx.get(assinaturaRef), tx.get(perfilRef), tx.get(expedienteRef), tx.get(bloqueioRef), ...slotRefs.map(ref => tx.get(ref))
        ]);
        const versaoReserva = Number(assinaturaSnap.data()?.semanas?.[semana]?.versaoReserva || 0);
        const agendamentoRef = db.collection('agendamentos').doc(`plano_${uid}_${dataHora.replace(/[^0-9]/g, '')}${versaoReserva ? `_r${versaoReserva}` : ''}`);
        const existente = await tx.get(agendamentoRef);
        if (existente.exists && existente.data().status === 'confirmado' && existente.data().semanaPlano === semana &&
            assinaturaSnap.data()?.semanas?.[semana]?.agendamentoId === agendamentoRef.id) {
            return { agDocId: agendamentoRef.id, ...existente.data(), alreadyRecorded: true };
        }
        const assinatura = assinaturaSnap.data();
        const atendimento = validarSemanaPlano(assinatura, semana, dataHora, now);
        const cfg = expedienteSnap.data() || {};
        const minutos = horario => { const [h, m] = horario.split(':').map(Number); return h * 60 + m; };
        const hora = minutos(dataHora.slice(11));
        const abertura = minutos(cfg.abertura || '08:00');
        const fechamento = minutos(cfg.fechamento || '20:00');
        const intervalo = Number(cfg.intervaloMin || 60);
        if (bloqueioSnap.exists || hora < abertura || hora > fechamento || intervalo <= 0 || (hora - abertura) % intervalo !== 0 ||
            (cfg.temPausa && cfg.pausaInicio && cfg.pausaFim && hora >= minutos(cfg.pausaInicio) && hora < minutos(cfg.pausaFim))) throw fail('Horário fora do expediente.');
        const antecedencia = cfg.bloqueioAntecedenciaAtivo === false ? 0 : 20 * 60000;
        if (atendimento.getTime() <= now.getTime() + antecedencia) throw fail('Horário passado ou sem a antecedência mínima.');
        const livre = slots.findIndex(s => !s.exists || ['cancelado', 'expirado'].includes(s.data().status) ||
            (['pendente', 'pendente_pagamento'].includes(s.data().status) && Number(s.data().expiraEm) > 0 && Number(s.data().expiraEm) <= now.getTime()));
        if (livre < 0) throw fail('Este horário acabou de ser reservado. Escolha outro.');
        const barbeiro = candidatos[livre];
        const slotRef = slotRefs[livre];
        const perfil = perfilSnap.data() || {};
        const servico = (Array.isArray(assinatura.servicosInclusos) ? assinatura.servicosInclusos.map(s => typeof s === 'string' ? s : s.nome).filter(Boolean).join(' + ') : '') || assinatura.nomePlano || 'Corte do plano';
        const iso = now.toISOString();
        const agendamento = {
            userId: uid, cliente: perfil.nome || assinatura.cliente || 'Cliente', telefone: perfil.telefone || assinatura.telefone || '',
            servico: `${servico} (Plano Mensal - Semana ${semana})`, preco: 0, taxaReservaPaga: 0,
            modalidadePagamento: 'plano_vip', idPagamento: 'plano_vip', metodoPagamento: 'plano_vip',
            isPlano: true, semanaPlano: semana, extras: [], barbeiroId: barbeiro.id, barbeiroNome: barbeiro.nome || 'Barbearia EMAÚS',
            barbeiroWhatsapp: barbeiro.whatsapp || '', status: 'confirmado', dataHora, slotId: slotRef.id, criadoEm: iso, confirmadoPeloServidor: true
        };
        tx.set(slotRef, { slotId: slotRef.id, dataHora, barbeiroId: barbeiro.id, barbeiroNome: agendamento.barbeiroNome, status: 'confirmado', expiraEm: null, atualizadoEm: iso });
        tx.set(db.collection('slots_proprietarios').doc(slotRef.id), { userId: uid, paymentId: null, atualizadoEm: iso });
        tx.set(agendamentoRef, agendamento);
        tx.update(assinaturaRef, { [`semanas.${semana}`]: { status: 'agendado', agendamentoId: agendamentoRef.id, agendamentoData: dataHora, servico, versaoReserva, atualizadoEm: iso }, atualizadoEm: iso });
        return { agDocId: agendamentoRef.id, ...agendamento };
    });
}
