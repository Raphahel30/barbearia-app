const fail = (m, statusCode = 409) => Object.assign(new Error(m), { statusCode });

export async function cancelarAgendamentoAvulso(db, uid, id, dependencies = {}, now = new Date()) {
    if (typeof id !== 'string' || !id || id.includes('/')) throw fail('Agendamento inválido.', 400);
    const ref = db.collection('agendamentos').doc(id), iso = now.toISOString();
    const result = await db.runTransaction(async tx => {
        const snap = await tx.get(ref);
        if (!snap.exists) throw fail('Agendamento não encontrado.', 404);
        const ag = snap.data();
        if (ag.userId !== uid) throw fail('Acesso negado.', 403);
        if (ag.isPlano) throw fail('Use o cancelamento do plano mensal.', 400);
        if (['cancelado', 'reembolsado', 'cancelado_barbeiro'].includes(ag.status)) return { agendamento: ag, alreadyRecorded: true };
        if (!['confirmado', 'pendente', 'pendente_pagamento'].includes(ag.status)) throw fail('Estado não permite cancelamento.');
        const horario = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(ag.dataHora || '') ? `${ag.dataHora}:00-03:00` : ag.dataHora;
        const timestamp = new Date(horario).getTime();
        if (!Number.isFinite(timestamp)) throw fail('Horário inválido.');
        const elegivelEstorno = timestamp - now.getTime() >= 3 * 3600000;
        const slotId = ag.slotId || `slot_${ag.dataHora}_${ag.barbeiroId || 'principal'}`;
        const slotRef = db.collection('slots_agendamentos').doc(slotId), donoRef = db.collection('slots_proprietarios').doc(slotId);
        const reciboRef = db.collection('resgates_beneficios').doc(id);
        const [slot, dono, recibo, compras] = await Promise.all([
            tx.get(slotRef), tx.get(donoRef), tx.get(reciboRef), tx.get(db.collection('comprasProdutos').where('paymentId', '==', id))
        ]);
        const quantidades = new Map();
        const comprasRestaurar = compras.docs.filter(d => !d.data().estoqueRestauradoEm);
        const itens = ag.estoqueDebitado === true && !ag.estoqueRestauradoEm
            ? (ag.produtos || []).map(p => ({ produtoId: p.id, quantidade: p.quantidade }))
            : comprasRestaurar.map(d => d.data());
        for (const p of itens) {
            if (typeof p.produtoId !== 'string' || !p.produtoId || p.produtoId.includes('/') || !Number.isInteger(Number(p.quantidade)) || Number(p.quantidade) <= 0) throw fail('Registro de estoque inconsistente.');
            quantidades.set(p.produtoId, (quantidades.get(p.produtoId) || 0) + Number(p.quantidade));
        }
        const produtos = await Promise.all([...quantidades].map(async ([produtoId, qtd]) => {
            const pRef = db.collection('produtos').doc(produtoId);
            return { ref: pRef, qtd, snap: await tx.get(pRef) };
        }));
        const resgate = recibo.data();
        const restituir = elegivelEstorno && resgate?.userId === uid && !resgate.restituidoEm;
        const fidRef = db.collection('fidelidadeClientes').doc(uid), userRef = db.collection('usuarios').doc(uid);
        const [fid, user, cfg] = await Promise.all([tx.get(fidRef), tx.get(userRef), tx.get(db.collection('configuracoes').doc('fidelidade'))]);
        const meta = Number(resgate?.metaSelos || 0);
        if (restituir && (!Number.isInteger(meta) || meta < 0)) throw fail('Recibo de benefício inválido.');
        // Todas as leituras terminam aqui. Só libera a ocupação identificada como esta reserva.
        const d = dono.data() || {};
        const pertence = (d.paymentId === id || d.agendamentoId === id) && (!d.userId || d.userId === uid);
        if (slot.exists && pertence) { tx.delete(slotRef); tx.delete(donoRef); }
        let estoquePendente = Boolean((ag.produtos || []).length && !ag.estoqueDebitado && !compras.size);
        for (const p of produtos) {
            if (!p.snap.exists) { estoquePendente = true; continue; }
            tx.update(p.ref, { estoque: Number(p.snap.data().estoque || 0) + p.qtd, atualizadoEm: iso });
        }
        for (const compra of comprasRestaurar) tx.update(compra.ref, { estoqueRestauradoEm: iso, status: 'cancelado' });
        if (restituir && meta > 0) {
            const saldo = Number(fid.data()?.selosAtuais || 0) + meta;
            tx.set(fidRef, { selosAtuais: saldo, recompensasUtilizadas: Math.max(0, Number(fid.data()?.recompensasUtilizadas || 0) - 1), recompensaDisponivel: saldo >= Number(cfg.data()?.metaSelos || 10), atualizadoEm: iso }, { merge: true });
        }
        if (restituir && resgate.anoAniversario && user.exists && user.data().anoUltimoResgateAniversario === resgate.anoAniversario) tx.update(userRef, { anoUltimoResgateAniversario: null });
        if (restituir) tx.update(reciboRef, { restituidoEm: iso });
        const valor = Number(ag.taxaReservaPaga ?? ag.precoPago ?? 0);
        const gateway = elegivelEstorno && valor > 0 && /^\d+$/.test(String(ag.idPagamento || ''));
        const update = {
            status: 'cancelado', canceladoEm: iso, canceladoPor: 'cliente', atualizadoEm: iso,
            elegivelEstorno, estornoRealizado: false, valorEstornado: 0,
            estornoStatus: gateway ? 'pendente' : valor > 0 && elegivelEstorno ? 'manual' : 'nao_aplicavel',
            estoqueRestauradoEm: iso, estoqueRequerConferencia: estoquePendente,
            beneficioRequerConferencia: elegivelEstorno && Boolean(ag.isFidelidade || ag.isAniversario) && !resgate,
            slotRequerConferencia: slot.exists && !pertence,
            motivoCancelamento: 'Cancelado pelo cliente; devoluções financeiras dependem de confirmação.'
        };
        tx.update(ref, update);
        return { agendamento: { ...ag, ...update }, alreadyRecorded: false };
    });
    let ag = result.agendamento;
    // Efeito externo depois do cancelamento persistido. Repetições usam a MESMA chave.
    if (ag.estornoStatus === 'pendente' && typeof dependencies.processarEstorno === 'function') {
        try {
            const valor = Number(ag.taxaReservaPaga ?? ag.precoPago ?? 0);
            const refund = await dependencies.processarEstorno(ag.idPagamento, valor, 'Cancelamento pelo cliente', `cancelamento_${id}`);
            if (!refund?.success) throw new Error(refund?.error || 'Estorno não confirmado.');
            const update = { status: 'reembolsado', estornoStatus: 'confirmado', estornoRealizado: true, valorEstornado: valor, estornoConfirmadoEm: new Date().toISOString() };
            await ref.update(update);
            ag = { ...ag, ...update };
        } catch (err) { await ref.update({ estornoErro: String(err.message).slice(0, 300) }); }
    }
    return { ...result, agendamento: ag, status: ag.status, elegivelEstorno: !!ag.elegivelEstorno, estornoRealizado: !!ag.estornoRealizado, valorEstornado: Number(ag.valorEstornado || 0) };
}
