import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { prepararConsumoBeneficios } from '../src/bookingBenefits.js';

test('Emulator: benefícios atômicos, meta configurada, repetição e concorrência', async () => {
    assert.ok(process.env.FIRESTORE_EMULATOR_HOST, 'Somente Emulator.');
    const app = initializeApp({ projectId: 'demo-emaus-beneficios' }, 'benefits-tests');
    const db = getFirestore(app);
    const dados = { userId: 'cliente', precificadoPeloServidor: true, isFidelidade: true, metaSelosResgate: 5, descontoFidelidade: 10, isAniversario: true, anoResgateAniversario: 2026, descontoAniversario: 10 };
    const consume = (id, payload = dados, abort = false) => db.runTransaction(async t => {
        const write = await prepararConsumoBeneficios(db, t, id, payload);
        write();
        if (abort) throw new Error('horário ocupado');
        t.set(db.collection('agendamentos').doc(id), { userId: payload.userId, status: 'confirmado' });
    });
    try {
        await db.collection('fidelidadeClientes').doc('cliente').set({ selosAtuais: 10 });
        await db.collection('usuarios').doc('cliente').set({ nome: 'Teste' });
        await assert.rejects(consume('abortado', dados, true), /ocupado/);
        assert.equal((await db.collection('fidelidadeClientes').doc('cliente').get()).data().selosAtuais, 10);
        assert.equal((await db.collection('resgates_beneficios').get()).size, 0);
        const resultados = await Promise.allSettled([consume('a'), consume('b')]);
        assert.equal(resultados.filter(r => r.status === 'fulfilled').length, 1);
        assert.equal(resultados.filter(r => r.status === 'rejected').length, 1);
        const agenda = await db.collection('agendamentos').get();
        assert.equal(agenda.size, 1);
        const id = agenda.docs[0].id;
        await consume(id);
        const fid = (await db.collection('fidelidadeClientes').doc('cliente').get()).data();
        assert.equal(fid.selosAtuais, 5);
        assert.equal(fid.recompensasUtilizadas, 1);
        assert.equal(fid.recompensaDisponivel, true);
        assert.equal((await db.collection('usuarios').doc('cliente').get()).data().anoUltimoResgateAniversario, 2026);
        await assert.rejects(consume('legado', { ...dados, precificadoPeloServidor: false }), /revisão manual/);
        await assert.rejects(consume(id, { ...dados, userId: 'outro' }), /outro cliente/);
        const semAniversario = { ...dados, isAniversario: false };
        const concorrentes = await Promise.allSettled([consume('c', semAniversario), consume('d', semAniversario)]);
        assert.equal(concorrentes.filter(r => r.status === 'fulfilled').length, 1);
        assert.equal((await db.collection('fidelidadeClientes').doc('cliente').get()).data().selosAtuais, 0);
        assert.equal((await db.collection('agendamentos').get()).size, 2);
        assert.equal((await db.collection('resgates_beneficios').get()).size, 2);
    } finally {
        await db.terminate();
        await deleteApp(app);
    }
});
