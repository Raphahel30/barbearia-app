import { createHash } from 'node:crypto';
import { calcularPrecoAgendamento, carregarCatalogoAgendamento } from './bookingPricing.js';
import { prepararConsumoBeneficios } from './bookingBenefits.js';

const fail = message => Object.assign(new Error(message), { statusCode: 409 });
const minutos = value => /^([01]\d|2[0-3]):[0-5]\d$/.test(value || '') ? Number(value.slice(0, 2)) * 60 + Number(value.slice(3)) : NaN;

export async function agendarBeneficioGratuito(db, uid, input, now = new Date()) {
    return confirmarReservaSemGateway(db, uid, input, now);
}

// A opção manual só é passada pela rota administrativa, nunca pelo corpo da requisição do cliente.
export async function confirmarReservaSemGateway(db, uid, input, now = new Date(), manual = null) {
    if (!uid || !/^[a-zA-Z0-9-]{16,80}$/.test(input.requestId || '')) throw fail('Identificador de confirmação inválido.');
    const id = `${manual ? 'manual' : 'gratis'}_${createHash('sha256').update(`${uid}:${input.requestId}`).digest('hex')}`;
    const agRef = db.collection('agendamentos').doc(id);
    return db.runTransaction(async tx => {
        let solicitacao;
        if (manual) {
            solicitacao = (await tx.get(manual.ref)).data();
            if (!solicitacao || solicitacao.userId !== uid || !['pendente', 'aprovado'].includes(solicitacao.status)) throw fail('Solicitação indisponível.');
            input = solicitacao.pedido;
        }
        const existente = await tx.get(agRef);
        if (existente.exists) {
            if (manual) {
                if (solicitacao.status !== 'aprovado' || solicitacao.agendamentoId !== id) throw fail('Registro de aprovação inconsistente.');
                return { ...existente.data(), agDocId: id, alreadyRecorded: true };
            }
            const recibo = await tx.get(db.collection('resgates_beneficios').doc(id));
            if (!recibo.exists || recibo.data().userId !== uid || existente.data().userId !== uid) throw fail('Registro inconsistente. Procure o administrador.');
            return { ...existente.data(), agDocId: id, alreadyRecorded: true };
        }
        if (manual && solicitacao.status === 'aprovado') throw fail('Aprovação sem agendamento correspondente. Procure o administrador.');
        const catalogo = await carregarCatalogoAgendamento(db, uid, ref => tx.get(ref));
        const q = calcularPrecoAgendamento({
            userId: uid, modalidade: manual ? input.modalidade : 'total', data: input.data, horario: input.horario,
            servicoBase: input.servicoBase, extras: input.extras, produtos: input.produtos,
            isFidelidade: input.isFidelidade === true, isAniversario: input.isAniversario === true
        }, catalogo, manual ? input.valorCobrado : 0, '', now, !manual);
        if (!manual && !q.isFidelidade && !q.isAniversario) throw fail('Nenhum benefício gratuito disponível.');
        if (manual && q.preco !== solicitacao.precoTotal) throw fail('O preço mudou. Confira o pagamento e solicite um novo pedido.');
        const [geral, expediente, bloqueio, barbeiros] = await Promise.all([
            tx.get(db.collection('configuracoes').doc('geral')), tx.get(db.collection('configuracoes').doc('expediente')),
            tx.get(db.collection('diasBloqueados').doc(q.data)), tx.get(db.collection('barbeiros'))
        ]);
        const cfg = expediente.data() || {};
        const hora = minutos(q.horario), inicio = minutos(cfg.abertura || '08:00'), fim = minutos(cfg.fechamento || '20:00');
        const intervalo = Number(cfg.intervaloMin || 60);
        if (bloqueio.exists || !Number.isFinite(inicio) || !Number.isFinite(fim) || !Number.isFinite(intervalo) || intervalo <= 0 ||
            hora < inicio || hora > fim || (hora - inicio) % intervalo !== 0 ||
            (cfg.temPausa && hora >= minutos(cfg.pausaInicio) && hora < minutos(cfg.pausaFim))) throw fail('Horário fora do expediente.');
        const antecedencia = cfg.bloqueioAntecedenciaAtivo === false ? 0 : 20 * 60000;
        if (new Date(`${q.dataHora}:00-03:00`).getTime() <= now.getTime() + antecedencia) throw fail('Horário passado ou sem antecedência mínima.');
        const desejado = input.barbeiroId || 'qualquer';
        const candidatos = geral.data()?.modoMultiBarbeiro === true
            ? barbeiros.docs.filter(d => d.data().ativo !== false && d.data().status !== 'inativo' && (desejado === 'qualquer' || d.id === desejado)).map(d => ({ ...d.data(), id: d.id }))
            : [{ id: 'qualquer', nome: 'Barbearia EMAÚS', whatsapp: '' }];
        if (!candidatos.length) throw fail('Profissional indisponível.');
        const refs = candidatos.map(b => db.collection('slots_agendamentos').doc(`slot_${q.dataHora}_${b.id}`));
        const slots = await Promise.all(refs.map(ref => tx.get(ref)));
        const livre = slots.findIndex(s => !s.exists || ['cancelado', 'expirado'].includes(s.data().status) ||
            (['pendente', 'pendente_pagamento'].includes(s.data().status) && Number(s.data().expiraEm) > 0 && Number(s.data().expiraEm) <= now.getTime()));
        if (livre < 0) throw fail('Este horário acabou de ser reservado.');
        const b = candidatos[livre], slot = refs[livre], iso = now.toISOString();
        const consumir = await prepararConsumoBeneficios(db, tx, id, q, now);
        const ag = {
            userId: uid, cliente: catalogo.perfil?.nome || 'Cliente', telefone: catalogo.perfil?.telefone || '',
            servico: q.servico, preco: manual ? q.preco : 0, taxaReservaPaga: manual ? q.valorCobrado : 0, modalidadePagamento: manual ? q.modalidade : 'fidelidade_resgate',
            idPagamento: manual ? 'manual' : 'fidelidade_resgate', metodoPagamento: manual ? 'pix_manual' : 'Benefício gratuito', isPlano: false,
            isFidelidade: q.isFidelidade, descontoFidelidade: q.descontoFidelidade, recompensaFidelidade: q.descricaoFidelidade,
            isAniversario: q.isAniversario, descontoAniversario: q.descontoAniversario, recompensaAniversario: q.descricaoAniversario,
            extras: q.extras, produtos: q.produtos, estoqueDebitado: true, barbeiroId: b.id, barbeiroNome: b.nome || 'Barbearia EMAÚS', barbeiroWhatsapp: b.whatsapp || '',
            status: 'confirmado', dataHora: q.dataHora, slotId: slot.id, criadoEm: iso, confirmadoPeloServidor: true,
            ...(manual ? { solicitacaoPixManualId: manual.ref.id, aprovadoPor: manual.adminUid, pagamentoConferidoEm: iso } : {})
        };
        consumir();
        for (const p of q.produtos) {
            const estoque = Number(catalogo.produtos.find(item => item.id === p.id).estoque);
            tx.update(db.collection('produtos').doc(p.id), { estoque: estoque - p.quantidade });
        }
        tx.set(slot, { slotId: slot.id, dataHora: q.dataHora, barbeiroId: b.id, barbeiroNome: ag.barbeiroNome, status: 'confirmado', expiraEm: null, atualizadoEm: iso });
        tx.set(db.collection('slots_proprietarios').doc(slot.id), { userId: uid, paymentId: id, atualizadoEm: iso });
        tx.set(agRef, ag);
        if (manual) tx.update(manual.ref, { status: 'aprovado', agendamentoId: id, aprovadoPor: manual.adminUid, aprovadoEm: iso });
        return { ...ag, agDocId: id, alreadyRecorded: false };
    });
}
