import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { agendarBeneficioGratuito } from '../src/freeBooking.js';

test('Emulator: resgate gratuito valida preço, horário, saldo, estoque e concorrência', async () => {
    assert.ok(process.env.FIRESTORE_EMULATOR_HOST, 'Somente Emulator.');
    const app = initializeApp({ projectId: 'demo-emaus-gratuito' }, 'free-booking-tests');
    const db = getFirestore(app), now = new Date('2026-09-03T12:00:00Z');
    const input = { requestId: 'pedido-gratuito-12345', data: '2026-09-03', horario: '14:00', servicoBase: 'Corte', isFidelidade: true };
    try {
        await Promise.all([
            db.collection('servicos').doc('corte').set({ nome: 'Corte', preco: 40 }),
            db.collection('produtos').doc('pomada').set({ nome: 'Pomada', preco: 20, estoque: 1 }),
            db.collection('configuracoes').doc('fidelidade').set({ metaSelos: 5, tipoRecompensa: 'desconto_porcentagem', porcentagemDesconto: 100 }),
            ...['alice', 'bob'].flatMap(uid => [
                db.collection('fidelidadeClientes').doc(uid).set({ selosAtuais: 5 }),
                db.collection('usuarios').doc(uid).set({ nome: uid, telefone: '11999999999' })
            ])
        ]);
        const book = (uid, patch = {}) => agendarBeneficioGratuito(db, uid, { ...input, ...patch }, now);
        await assert.rejects(book('alice', { isFidelidade: false, preco: 0, precoFinal: 0 }), /divergente/);
        await assert.rejects(book('alice', { horario: '08:00' }), /antecedência/);
        await assert.rejects(book('alice', { horario: '14:30' }), /expediente/);
        await db.collection('diasBloqueados').doc('2026-09-03').set({ motivo: 'Fechado' });
        await assert.rejects(book('alice'), /expediente/);
        await db.collection('diasBloqueados').doc('2026-09-03').delete();
        assert.equal((await db.collection('resgates_beneficios').get()).size, 0);
        const produto = { produtos: [{ id: 'pomada', quantidade: 1, preco: 0.01 }] };
        const resultados = await Promise.allSettled([book('alice', produto), book('bob', produto)]);
        assert.equal(resultados.filter(r => r.status === 'fulfilled').length, 1);
        const ag = resultados.find(r => r.status === 'fulfilled').value;
        const perdedor = ag.userId === 'alice' ? 'bob' : 'alice';
        assert.equal(ag.cliente, ag.userId);
        assert.equal(ag.produtos[0].preco, 20);
        assert.equal(ag.preco, 0);
        assert.equal((await db.collection('produtos').doc('pomada').get()).data().estoque, 0);
        assert.equal((await db.collection('fidelidadeClientes').doc(perdedor).get()).data().selosAtuais, 5);
        assert.equal((await book(ag.userId, produto)).alreadyRecorded, true);
        assert.equal((await db.collection('agendamentos').get()).size, 1);
        assert.equal((await db.collection('resgates_beneficios').get()).size, 1);
        await assert.rejects(book(perdedor, { ...produto, horario: '15:00', requestId: 'novo-pedido-1234567' }), /estoque/);
        await assert.rejects(book(ag.userId, { horario: '15:00', requestId: 'novo-pedido-1234567' }), /indisponível/);
        await db.collection('configuracoes').doc('geral').set({ modoMultiBarbeiro: true });
        await db.collection('barbeiros').doc('barbeiro-1').set({ nome: 'Profissional', ativo: true });
        await assert.rejects(book(perdedor, { horario: '15:00', barbeiroId: 'inexistente' }), /Profissional/);
        const segundo = await book(perdedor, { horario: '15:00', barbeiroId: 'barbeiro-1' });
        assert.equal(segundo.barbeiroId, 'barbeiro-1');
    } finally {
        await db.terminate();
        await deleteApp(app);
    }
});
