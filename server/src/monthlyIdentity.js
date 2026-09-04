import { assinaturaMensalEstaAtiva, normalizarEmailCRMServidor } from './crmUtils.js';

const fail = (message, statusCode = 409) => Object.assign(new Error(message), { statusCode });
const phone = value => {
    let p = String(value || '').replace(/\D/g, '');
    if ((p.length === 12 || p.length === 13) && p.startsWith('55')) p = p.slice(2);
    return [10, 11].includes(p.length) ? p : '';
};

// A identidade deve vir do Firebase Auth, nunca do formulário/perfil editável.
export async function vincularMensalista(db, identidade, auth, now = new Date()) {
    const uid = identidade.uid;
    if (!uid || uid.includes('/')) throw fail('Identidade inválida.', 401);
    const email = identidade.emailVerified ? normalizarEmailCRMServidor(identidade.email) : '';
    const telefone = phone(identidade.phoneNumber);
    const destino = db.collection('assinaturasClientes').doc(uid);
    return db.runTransaction(async tx => {
        const atual = await tx.get(destino);
        if (atual.exists && assinaturaMensalEstaAtiva(atual.data(), now)) return { assinatura: atual.data(), vinculado: false };
        if (!email && !telefone) return { assinatura: atual.data() || null, vinculado: false, requerIdentidadeVerificada: true };
        const todas = await tx.get(db.collection('assinaturasClientes'));
        const candidatos = todas.docs.filter(doc => {
            const s = doc.data();
            if (doc.id === uid || s.migradoPara || !assinaturaMensalEstaAtiva(s, now)) return false;
            if (!(s.ativadoPorAdmin === true || doc.id.startsWith('mensal_'))) return false;
            const porEmail = email && [s.userEmail, s.email, s.emailNormalizado].some(e => normalizarEmailCRMServidor(e) === email);
            const porTelefone = telefone && phone(s.telefone || s.telefoneNormalizado) === telefone;
            return porEmail || porTelefone;
        });
        if (candidatos.length > 1) throw fail('Mais de um plano corresponde à sua identidade. Peça ao administrador para conferir os cadastros.');
        if (!candidatos.length) return { assinatura: atual.data() || null, vinculado: false };
        const origem = candidatos[0], s = origem.data();
        const titular = String(s.userId || origem.id);
        if (s.vinculadoUid && s.vinculadoUid !== uid) throw fail('Plano já vinculado a outra conta. Procure o administrador.');
        if (titular !== uid) {
            try {
                await auth.getUser(titular);
                throw fail('Plano pertence a outra conta. Procure o administrador.');
            } catch (e) { if (e.code !== 'auth/user-not-found') throw e; }
        }
        const agendamentos = [];
        for (const semana of Object.values(s.semanas || {})) {
            if (!semana?.agendamentoId) continue;
            if (typeof semana.agendamentoId !== 'string' || semana.agendamentoId.includes('/')) throw fail('Semana inconsistente. Procure o administrador.');
            const ag = await tx.get(db.collection('agendamentos').doc(semana.agendamentoId));
            if (!ag.exists) continue;
            if (ag.data().isPlano !== true || ![titular, uid].includes(ag.data().userId)) throw fail('Titularidade do agendamento inconsistente.');
            const slotId = ag.data().slotId;
            const dono = slotId ? await tx.get(db.collection('slots_proprietarios').doc(slotId)) : null;
            agendamentos.push({ ag, dono });
        }
        const crmRef = db.collection('clientes').doc(uid);
        const crm = await tx.get(crmRef);
        const iso = now.toISOString();
        const assinatura = { ...s, userId: uid, vinculadoUid: uid, origemCadastroId: origem.id, vinculadoEm: iso };
        tx.set(destino, assinatura);
        tx.update(origem.ref, { status: 'migrado', migradoPara: uid, migradoEm: iso });
        tx.set(db.collection('vinculos_mensalistas').doc(origem.id), { origemId: origem.id, destinoUid: uid, vinculadoEm: iso, assinaturaAnteriorDestino: atual.data() || null });
        for (const { ag, dono } of agendamentos) {
            tx.update(ag.ref, { userId: uid });
            if (dono?.exists && dono.data().userId === titular) tx.update(dono.ref, { userId: uid });
        }
        tx.set(crmRef, { isVip: true, planoAtivoId: uid, planoStatus: 'ativo', nomePlanoAtivo: s.nomePlano || 'Plano Mensal', planoDataFim: s.dataFim, tags: [...new Set([...(crm.data()?.tags || []), 'VIP'])], updatedAt: iso }, { merge: true });
        return { assinatura, vinculado: true };
    });
}
