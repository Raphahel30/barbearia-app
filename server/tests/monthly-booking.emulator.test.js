import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { agendarPlanoMensal, cancelarPlanoMensal } from '../src/monthlyBooking.js';

test('Emulator: reserva e semana são atômicas e rejeitam duas reservas concorrentes', async () => {
    assert.ok(process.env.FIRESTORE_EMULATOR_HOST, 'Este teste nunca deve acessar produção.');
    const app = initializeApp({ projectId: 'demo-emaus-planos' }, 'monthly-booking-tests');
    const db = getFirestore(app);
    try {
        const uid = 'monthly-test-client';
        await db.collection('assinaturasClientes').doc(uid).set({ status: 'ativo', dataPagamento: '2026-09-01T12:00:00Z', dataFim: '2026-10-01T12:00:00Z', nomePlano: 'Corte', semanas: {} });
        await db.collection('usuarios').doc(uid).set({ nome: 'Cliente teste' });
        const now = new Date('2026-09-03T12:00:00Z');
        const resultados = await Promise.allSettled([
            agendarPlanoMensal(db, uid, { dataHora: '2026-09-03T14:00', semana: 1 }, now),
            agendarPlanoMensal(db, uid, { dataHora: '2026-09-03T15:00', semana: 1 }, now)
        ]);
        assert.equal(resultados.filter(r => r.status === 'fulfilled').length, 1);
        assert.equal(resultados.filter(r => r.status === 'rejected').length, 1);
        const agenda = await db.collection('agendamentos').get();
        assert.equal(agenda.size, 1);
        const assinatura = (await db.collection('assinaturasClientes').doc(uid).get()).data();
        assert.equal(assinatura.semanas[1].agendamentoId, agenda.docs[0].id);
        const ag = agenda.docs[0].data();
        const repetido = await agendarPlanoMensal(db, uid, { dataHora: ag.dataHora, semana: 1 }, now);
        assert.equal(repetido.alreadyRecorded, true);
        assert.equal((await db.collection('slots_agendamentos').get()).size, 1);
        await db.collection('assinaturasClientes').doc('outro-cliente').set({ status: 'ativo' });
        await assert.rejects(cancelarPlanoMensal(db, 'outro-cliente', agenda.docs[0].id, now), /Acesso negado/);
        const cancelamento = await cancelarPlanoMensal(db, uid, agenda.docs[0].id, now);
        assert.equal(cancelamento.status, 'disponivel');
        assert.equal((await db.collection('agendamentos').doc(agenda.docs[0].id).get()).data().status, 'cancelado');
        assert.equal((await db.collection('slots_agendamentos').get()).size, 0);
        assert.equal((await db.collection('slots_proprietarios').get()).size, 0);
        assert.equal((await db.collection('assinaturasClientes').doc(uid).get()).data().semanas[1].status, 'disponivel');
        const novo = await agendarPlanoMensal(db, uid, { dataHora: ag.dataHora, semana: 1 }, now);
        assert.notEqual(novo.agDocId, agenda.docs[0].id);
        const repeticaoAntiga = await cancelarPlanoMensal(db, uid, agenda.docs[0].id, now);
        assert.equal(repeticaoAntiga.alreadyRecorded, true);
        assert.equal((await db.collection('slots_agendamentos').get()).size, 1);
        const tarde = new Date(new Date(`${ag.dataHora}:00-03:00`).getTime() - 2 * 3600000);
        const canceladoTarde = await cancelarPlanoMensal(db, uid, novo.agDocId, tarde);
        assert.equal(canceladoTarde.status, 'falta');
        const repeticaoCancelamento = await cancelarPlanoMensal(db, uid, novo.agDocId, new Date(tarde.getTime() + 3600000));
        assert.equal(repeticaoCancelamento.alreadyRecorded, true);
        assert.equal(repeticaoCancelamento.status, 'falta');
    } finally {
        await db.terminate();
        await deleteApp(app);
    }
});
