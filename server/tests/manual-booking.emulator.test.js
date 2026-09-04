import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { solicitarPixManual, decidirPixManual } from '../src/manualBooking.js';

test('Emulator: Pix manual só reserva após aprovação, com conflito e repetição seguros', async () => {
    assert.ok(process.env.FIRESTORE_EMULATOR_HOST, 'Somente Emulator.');
    const app = initializeApp({ projectId: 'demo-emaus-manual' }, 'manual-tests');
    const db = getFirestore(app), now = new Date('2026-09-03T12:00:00Z');
    const pedido = { requestId: 'pedido-pix-manual-12345', data: '2026-09-03', horario: '14:00', servicoBase: 'Corte', modalidade: 'taxa', valorCobrado: 10 };
    try {
        await db.collection('servicos').doc('corte').set({ nome: 'Corte', preco: 40 });
        await db.collection('usuarios').doc('alice').set({ nome: 'Alice' });
        await db.collection('usuarios').doc('bob').set({ nome: 'Bob' });
        const a = await solicitarPixManual(db, 'alice', pedido, now);
        const b = await solicitarPixManual(db, 'bob', pedido, now);
        assert.equal((await solicitarPixManual(db, 'alice', pedido, now)).id, a.id);
        for (const collection of ['agendamentos', 'slots_agendamentos', 'resgates_beneficios']) assert.equal((await db.collection(collection).get()).size, 0);
        const resultados = await Promise.allSettled([decidirPixManual(db, a.id, 'admin', 'aprovar', now), decidirPixManual(db, b.id, 'admin', 'aprovar', now)]);
        assert.equal(resultados.filter(r => r.status === 'fulfilled').length, 1);
        const idx = resultados.findIndex(r => r.status === 'fulfilled');
        const winner = idx === 0 ? a : b, loser = idx === 0 ? b : a;
        const ag = resultados[idx].value.agendamento;
        assert.equal(ag.taxaReservaPaga, 10);
        assert.equal(ag.preco, 40);
        assert.equal((await decidirPixManual(db, winner.id, 'admin-2', 'aprovar', now)).agendamento.alreadyRecorded, true);
        assert.equal((await db.collection('agendamentos').get()).size, 1);
        assert.equal((await db.collection('solicitacoes_pix_manual').doc(loser.id).get()).data().status, 'pendente');
        assert.equal((await decidirPixManual(db, loser.id, 'admin', 'rejeitar', now)).status, 'rejeitado');
        await assert.rejects(decidirPixManual(db, loser.id, 'admin', 'aprovar', now));
        const c = await solicitarPixManual(db, 'alice', { ...pedido, requestId: 'pedido-alterado-12345', horario: '15:00' }, now);
        await db.collection('servicos').doc('corte').update({ preco: 50 });
        await assert.rejects(decidirPixManual(db, c.id, 'admin', 'aprovar', now), /preço mudou/);
        assert.equal((await db.collection('slots_agendamentos').get()).size, 1);
        await assert.rejects(solicitarPixManual(db, 'alice', { ...pedido, requestId: 'pedido-invalido-12345', valorCobrado: 0.01 }, now), /divergente/);
    } finally { await db.terminate(); await deleteApp(app); }
});
