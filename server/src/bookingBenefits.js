const conflito = message => Object.assign(new Error(message), { code: 'BENEFICIO_INDISPONIVEL' });

// Faz todas as leituras antes de devolver as escritas para a transação do agendamento.
// dados deve vir exclusivamente do checkout persistido pelo servidor.
export async function prepararConsumoBeneficios(db, transaction, paymentId, dados, now = new Date()) {
    if (!dados.isFidelidade && !dados.isAniversario) return () => {};
    if (dados.precificadoPeloServidor !== true || dados.isPlano || !dados.userId) {
        throw conflito('Benefício sem orçamento validado: requer revisão manual.');
    }
    const reciboRef = db.collection('resgates_beneficios').doc(paymentId);
    const recibo = await transaction.get(reciboRef);
    if (recibo.exists) {
        if (recibo.data().userId !== dados.userId) throw conflito('Resgate pertence a outro cliente.');
        return () => {};
    }
    const writes = [];
    const atualizadoEm = now.toISOString();
    if (dados.isFidelidade === true) {
        const meta = Number(dados.metaSelosResgate);
        if (!Number.isInteger(meta) || meta < 1 || !(dados.descontoFidelidade > 0)) throw conflito('Meta de fidelidade não validada.');
        const ref = db.collection('fidelidadeClientes').doc(dados.userId);
        const snap = await transaction.get(ref);
        const saldo = Number(snap.data()?.selosAtuais || 0);
        const utilizadas = Number(snap.data()?.recompensasUtilizadas || 0);
        if (!Number.isInteger(saldo) || saldo < meta || !Number.isInteger(utilizadas) || utilizadas < 0) throw conflito('Saldo de fidelidade insuficiente ou inválido.');
        writes.push([ref, { selosAtuais: saldo - meta, recompensasUtilizadas: utilizadas + 1, recompensaDisponivel: saldo - meta >= meta, atualizadoEm }]);
    }
    if (dados.isAniversario === true) {
        const ano = Number(dados.anoResgateAniversario);
        if (!Number.isInteger(ano) || ano < 2000 || !(dados.descontoAniversario > 0)) throw conflito('Ano do benefício não validado.');
        const ref = db.collection('usuarios').doc(dados.userId);
        const snap = await transaction.get(ref);
        if (!snap.exists || Number(snap.data().anoUltimoResgateAniversario || 0) >= ano) throw conflito('Presente de aniversário já utilizado.');
        writes.push([ref, { anoUltimoResgateAniversario: ano, atualizadoEm }]);
    }
    return () => {
        for (const [ref, data] of writes) transaction.set(ref, data, { merge: true });
        transaction.set(reciboRef, {
            userId: dados.userId, paymentId, metaSelos: dados.isFidelidade ? dados.metaSelosResgate : 0,
            anoAniversario: dados.isAniversario ? dados.anoResgateAniversario : null, criadoEm: atualizadoEm
        });
    };
}
