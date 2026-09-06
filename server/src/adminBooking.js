import { createHash } from 'node:crypto';
import { agendarPlanoMensal } from './monthlyBooking.js';

const fail = (message, statusCode = 409) => Object.assign(new Error(message), { statusCode });
const horarioEmMinutos = value => /^([01]\d|2[0-3]):[0-5]\d$/.test(value || '')
    ? Number(value.slice(0, 2)) * 60 + Number(value.slice(3))
    : NaN;
const idSeguro = value => typeof value === 'string' && value.length >= 1 && value.length <= 120 && !value.includes('/');
const telefoneNormalizado = value => String(value || '').replace(/\D/g, '').slice(-11);

function validarDataHora(dataHora) {
    if (!/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/.test(dataHora || '')) throw fail('Data e horário inválidos.', 400);
    const data = new Date(`${dataHora}:00-03:00`);
    if (!Number.isFinite(data.getTime())) throw fail('Data e horário inválidos.', 400);
    return data;
}

function validarExpediente(expediente, bloqueado, dataHora, now) {
    const hora = horarioEmMinutos(dataHora.slice(11));
    const abertura = horarioEmMinutos(expediente.abertura || '08:00');
    const fechamento = horarioEmMinutos(expediente.fechamento || '20:00');
    const intervalo = Number(expediente.intervaloMin || 60);
    if (bloqueado || !Number.isFinite(abertura) || !Number.isFinite(fechamento) || !Number.isFinite(intervalo) || intervalo <= 0 ||
        hora < abertura || hora > fechamento || (hora - abertura) % intervalo !== 0 ||
        (expediente.temPausa && hora >= horarioEmMinutos(expediente.pausaInicio) && hora < horarioEmMinutos(expediente.pausaFim))) {
        throw fail('Horário fora do expediente ou data bloqueada.');
    }
    const antecedencia = expediente.bloqueioAntecedenciaAtivo === false ? 0 : 20 * 60000;
    if (validarDataHora(dataHora).getTime() <= now.getTime() + antecedencia) throw fail('Horário passado ou sem antecedência mínima.');
}

export async function criarAgendamentoPeloAdmin(db, adminUid, input, now = new Date()) {
    if (!db || !idSeguro(adminUid)) throw fail('Administrador inválido.', 403);
    if (!input || typeof input !== 'object' || !/^[a-zA-Z0-9-]{16,100}$/.test(input.requestId || '')) throw fail('Identificador da solicitação inválido.', 400);
    const clienteId = String(input.clienteId || '').trim();
    const planoClienteId = String(input.planoClienteId || clienteId).trim();
    const dataHora = String(input.dataHora || '');
    validarDataHora(dataHora);

    if (input.usarPlano === true) {
        if (!idSeguro(planoClienteId)) throw fail('Cliente do plano inválido.', 400);
        const agendamento = await agendarPlanoMensal(db, planoClienteId, {
            dataHora,
            semana: Number(input.semanaPlano),
            barbeiroId: input.barbeiroId
        }, now);
        if (!agendamento.alreadyRecorded) {
            await db.collection('agendamentos').doc(agendamento.agDocId).set({
                criadoPeloAdmin: true,
                criadoPorAdminUid: adminUid,
                origem: 'painel_admin',
                observacaoInterna: String(input.observacao || '').trim().slice(0, 500),
                atualizadoEm: now.toISOString()
            }, { merge: true });
        }
        return agendamento;
    }

    const nomeNovo = String(input.clienteNovo?.nome || '').trim().slice(0, 100);
    const telefoneNovo = telefoneNormalizado(input.clienteNovo?.telefone);
    if (!idSeguro(clienteId) && (!nomeNovo || telefoneNovo.length < 10)) throw fail('Selecione ou cadastre um cliente válido.', 400);
    if (!idSeguro(String(input.servicoId || ''))) throw fail('Selecione um serviço.', 400);
    const extraIds = Array.isArray(input.extraIds) ? input.extraIds.map(String) : [];
    if (extraIds.length > 10 || new Set(extraIds).size !== extraIds.length || extraIds.some(id => !idSeguro(id) || id === input.servicoId)) throw fail('Serviços adicionais inválidos.', 400);
    if (!['pagar_local', 'pago', 'cortesia'].includes(input.pagamento)) throw fail('Forma de pagamento inválida.', 400);

    const novoId = nomeNovo ? `cli_${createHash('sha256').update(telefoneNovo).digest('hex').slice(0, 24)}` : '';
    const idClienteFinal = idSeguro(clienteId) ? clienteId : novoId;
    const id = `admin_${createHash('sha256').update(`${adminUid}:${input.requestId}`).digest('hex')}`;
    const agRef = db.collection('agendamentos').doc(id);
    const clienteRef = db.collection('clientes').doc(idClienteFinal);
    const usuarioRef = db.collection('usuarios').doc(idClienteFinal);
    const servicoRefs = [String(input.servicoId), ...extraIds].map(item => db.collection('servicos').doc(item));
    const configRef = db.collection('configuracoes').doc('geral');
    const expedienteRef = db.collection('configuracoes').doc('expediente');
    const bloqueioRef = db.collection('diasBloqueados').doc(dataHora.slice(0, 10));

    return db.runTransaction(async tx => {
        const existente = await tx.get(agRef);
        if (existente.exists) {
            if (existente.data().criadoPorAdminUid !== adminUid) throw fail('Agendamento duplicado inconsistente.');
            return { agDocId: id, ...existente.data(), alreadyRecorded: true };
        }
        const [clienteSnap, usuarioSnap, configSnap, expedienteSnap, bloqueioSnap, barbeirosSnap, ...servicosSnap] = await Promise.all([
            tx.get(clienteRef), tx.get(usuarioRef), tx.get(configRef), tx.get(expedienteRef), tx.get(bloqueioRef),
            tx.get(db.collection('barbeiros')), ...servicoRefs.map(ref => tx.get(ref))
        ]);
        validarExpediente(expedienteSnap.data() || {}, bloqueioSnap.exists, dataHora, now);
        const perfil = clienteSnap.exists ? clienteSnap.data() : usuarioSnap.exists ? usuarioSnap.data() : null;
        if (!perfil && !nomeNovo) throw fail('Cliente não encontrado.', 404);
        if (servicosSnap.some(s => !s.exists || s.data().ativo === false || s.data().status === 'inativo')) throw fail('Serviço indisponível. Atualize a página.');

        const geral = configSnap.data() || {};
        const desejado = String(input.barbeiroId || 'qualquer');
        const candidatos = geral.modoMultiBarbeiro === true
            ? barbeirosSnap.docs.filter(d => d.data().ativo !== false && d.data().status !== 'inativo' && (desejado === 'qualquer' || d.id === desejado)).map(d => ({ id: d.id, ...d.data() }))
            : [{ id: 'qualquer', nome: 'Barbearia EMAÚS', whatsapp: '' }];
        if (!candidatos.length) throw fail('Profissional indisponível.');
        const slotRefs = candidatos.map(b => db.collection('slots_agendamentos').doc(`slot_${dataHora}_${b.id}`));
        const slots = await Promise.all(slotRefs.map(ref => tx.get(ref)));
        const livre = slots.findIndex(s => !s.exists || ['cancelado', 'expirado'].includes(s.data().status) ||
            (['pendente', 'pendente_pagamento'].includes(s.data().status) && Number(s.data().expiraEm) > 0 && Number(s.data().expiraEm) <= now.getTime()));
        if (livre < 0) throw fail('Este horário acabou de ser reservado. Escolha outro.');

        const principal = servicosSnap[0].data();
        const adicionais = servicosSnap.slice(1).map(s => s.data());
        const total = [principal, ...adicionais].reduce((soma, item) => soma + Number(item.preco || 0), 0);
        if (!Number.isFinite(total) || total < 0) throw fail('Preço dos serviços inválido.');
        const barbeiro = candidatos[livre], slotRef = slotRefs[livre], iso = now.toISOString();
        const cliente = perfil?.nome || nomeNovo;
        const telefone = perfil?.telefone || telefoneNovo;
        const agendamento = {
            userId: idClienteFinal, cliente, telefone,
            servico: principal.nome + (adicionais.length ? ` (+ ${adicionais.map(a => a.nome).join(', ')})` : ''),
            preco: input.pagamento === 'cortesia' ? 0 : total,
            precoOriginal: total,
            taxaReservaPaga: input.pagamento === 'pago' ? total : 0,
            modalidadePagamento: input.pagamento,
            metodoPagamento: input.pagamento === 'pago' ? 'registrado_pelo_admin' : input.pagamento,
            idPagamento: input.pagamento === 'pago' ? 'manual_admin' : '',
            extras: adicionais.map(a => a.nome), produtos: [], isPlano: false,
            barbeiroId: barbeiro.id, barbeiroNome: barbeiro.nome || 'Barbearia EMAÚS', barbeiroWhatsapp: barbeiro.whatsapp || '',
            status: 'confirmado', dataHora, slotId: slotRef.id, criadoEm: iso, atualizadoEm: iso,
            confirmadoPeloServidor: true, criadoPeloAdmin: true, criadoPorAdminUid: adminUid, origem: 'painel_admin',
            observacaoInterna: String(input.observacao || '').trim().slice(0, 500)
        };
        tx.set(slotRef, { slotId: slotRef.id, dataHora, barbeiroId: barbeiro.id, barbeiroNome: agendamento.barbeiroNome, status: 'confirmado', expiraEm: null, atualizadoEm: iso });
        tx.set(db.collection('slots_proprietarios').doc(slotRef.id), { userId: idClienteFinal, agendamentoId: id, paymentId: id, atualizadoEm: iso });
        tx.set(agRef, agendamento);
        tx.set(clienteRef, {
            nome: cliente, telefone, telefoneNormalizado: telefoneNormalizado(telefone), status: 'ativo',
            proximoAgendamentoEm: dataHora, updatedAt: iso, ...(clienteSnap.exists ? {} : { createdAt: iso })
        }, { merge: true });
        return { agDocId: id, ...agendamento, alreadyRecorded: false };
    });
}
