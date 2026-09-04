import crypto from 'node:crypto';

export async function gravarCicloMensal(db, userId, assinatura, clienteRef, dadosCRM, now = new Date()) {
    const ref = db.collection('assinaturasClientes').doc(userId);
    return db.runTransaction(async tx => {
        const snap = await tx.get(ref), anterior = snap.data();
        if (anterior?.idPagamento && anterior.idPagamento === assinatura.idPagamento) return { alreadyRecorded: true };
        const fimAnterior = anterior?.dataFim?.toDate ? anterior.dataFim.toDate().getTime() : new Date(anterior?.dataFim).getTime();
        if (anterior && (!Number.isFinite(fimAnterior) || fimAnterior >= now.getTime() || Object.values(anterior.semanas || {}).some(s => s?.status === 'agendado'))) {
            throw Object.assign(new Error('Este cliente ainda possui um ciclo vigente ou reserva vinculada. Não é possível substituir o plano; conclua o ciclo antes de renovar.'), { statusCode: 409 });
        }
        const cicloId = crypto.createHash('sha256').update(`${userId}:${assinatura.idPagamento}`).digest('hex');
        if (anterior) tx.set(db.collection('assinaturas_historico').doc(`${userId}_${cicloId}`), { ...anterior, arquivadoEm: now.toISOString() });
        let telefoneNormalizado = String(assinatura.telefone || '').replace(/\D/g, '');
        if ([12, 13].includes(telefoneNormalizado.length) && telefoneNormalizado.startsWith('55')) telefoneNormalizado = telefoneNormalizado.slice(2);
        tx.set(ref, { ...assinatura, telefoneNormalizado, cicloId, semanas: {} });
        tx.set(clienteRef, dadosCRM, { merge: true });
        return { alreadyRecorded: false, cicloId };
    });
}
