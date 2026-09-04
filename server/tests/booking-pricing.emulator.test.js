import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { validarPrecoAgendamento } from '../src/bookingPricing.js';

test('Emulator: preço é recalculado com catálogo e saldo persistidos', async () => {
    assert.ok(process.env.FIRESTORE_EMULATOR_HOST, 'Este teste nunca deve acessar produção.');
    const app = initializeApp({ projectId: 'demo-emaus-precos' }, 'booking-pricing-tests');
    const db = getFirestore(app);
    try {
        await Promise.all([
            db.collection('servicos').doc('corte').set({ nome: 'Corte', preco: 40 }),
            db.collection('servicos').doc('barba').set({ nome: 'Barba', preco: 20 }),
            db.collection('produtos').doc('pomada').set({ nome: 'Pomada', preco: 15, estoque: 3 }),
            db.collection('configuracoes').doc('fidelidade').set({ metaSelos: 5, tipoRecompensa: 'desconto_valor', valorDesconto: 10 }),
            db.collection('fidelidadeClientes').doc('cliente').set({ selosAtuais: 5 })
        ]);
        const dados = { userId: 'cliente', servicoBase: 'Corte', data: '2026-09-04', horario: '14:00', modalidade: 'total', extras: ['Barba'], produtos: [{ id: 'pomada', quantidade: 1, preco: 0.01 }], isFidelidade: true, preco: 0.01 };
        await assert.rejects(validarPrecoAgendamento(db, dados, 'agendamento', 0.01), /divergente/);
        const quote = await validarPrecoAgendamento(db, dados, 'agendamento', 65);
        assert.equal(quote.preco, 65);
        assert.equal(quote.produtos[0].preco, 15);
        assert.equal(quote.metaSelosResgate, 5);
        await db.collection('servicos').doc('corte').update({ preco: 45 });
        await assert.rejects(validarPrecoAgendamento(db, dados, 'agendamento', 65), /divergente/);
        assert.equal((await validarPrecoAgendamento(db, dados, 'agendamento', 70)).preco, 70);
        await db.collection('fidelidadeClientes').doc('cliente').update({ selosAtuais: 0 });
        await assert.rejects(validarPrecoAgendamento(db, dados, 'agendamento', 70), /indisponível/);
        assert.equal((await db.collection('pagamentos_pendentes').get()).size, 0);
    } finally {
        await db.terminate();
        await deleteApp(app);
    }
});
