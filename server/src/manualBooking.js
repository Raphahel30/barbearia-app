import { createHash } from 'node:crypto';
import { calcularPrecoAgendamento, carregarCatalogoAgendamento } from './bookingPricing.js';
import { confirmarReservaSemGateway } from './freeBooking.js';
const fail = message => Object.assign(new Error(message), { statusCode: 409 });

export async function solicitarPixManual(db, uid, input, now = new Date()) {
    if (!uid || !/^[a-zA-Z0-9-]{16,80}$/.test(input.requestId || '')) throw fail('Identificador de solicitação inválido.');
    if (input.isPlano || input.isPlanoMensalistaComExtras) throw fail('Use o pagamento online para planos e seus adicionais.');
    const id = createHash('sha256').update(`${uid}:${input.requestId}`).digest('hex');
    const ref = db.collection('solicitacoes_pix_manual').doc(id);
    return db.runTransaction(async tx => {
        const existente = await tx.get(ref);
        if (existente.exists) return { id, status: existente.data().status, alreadyRecorded: true };
        const pedido = {
            requestId: input.requestId, servicoBase: input.servicoBase, data: input.data, horario: input.horario,
            modalidade: input.modalidade, valorCobrado: Number(input.valorCobrado),
            extras: input.extras || [], produtos: input.produtos || [],
            isFidelidade: input.isFidelidade === true, isAniversario: input.isAniversario === true,
            barbeiroId: String(input.barbeiroId || 'qualquer')
        };
        const catalogo = await carregarCatalogoAgendamento(db, uid, r => tx.get(r));
        const q = calcularPrecoAgendamento({ ...pedido, userId: uid }, catalogo, pedido.valorCobrado, '', now);
        if (new Date(`${q.dataHora}:00-03:00`).getTime() <= now.getTime()) throw fail('Escolha um horário futuro.');
        // Apenas uma solicitação privada. Não cria slot, agenda, venda nem consome benefício/estoque.
        tx.set(ref, { userId: uid, pedido, status: 'pendente', cliente: catalogo.perfil?.nome || 'Cliente',
            telefone: catalogo.perfil?.telefone || '', servico: q.servico, dataHora: q.dataHora,
            precoTotal: q.preco, valorInformado: q.valorCobrado, criadoEm: now.toISOString() });
        return { id, status: 'pendente', alreadyRecorded: false };
    });
}

export async function decidirPixManual(db, id, adminUid, acao, now = new Date()) {
    if (!/^[a-f0-9]{64}$/.test(id || '') || !adminUid || !['aprovar', 'rejeitar'].includes(acao)) throw fail('Decisão inválida.');
    const ref = db.collection('solicitacoes_pix_manual').doc(id);
    if (acao === 'rejeitar') return db.runTransaction(async tx => {
        const snap = await tx.get(ref);
        if (!snap.exists || !['pendente', 'rejeitado'].includes(snap.data().status)) throw fail('Solicitação indisponível.');
        if (snap.data().status === 'pendente') tx.update(ref, { status: 'rejeitado', rejeitadoPor: adminUid, rejeitadoEm: now.toISOString() });
        return { status: 'rejeitado' };
    });
    const snap = await ref.get();
    if (!snap.exists) throw fail('Solicitação não encontrada.');
    const agendamento = await confirmarReservaSemGateway(db, snap.data().userId, snap.data().pedido, now, { ref, adminUid });
    return { status: 'aprovado', agendamento };
}
