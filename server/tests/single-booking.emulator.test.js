import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { cancelarAgendamentoAvulso } from '../src/singleBooking.js';
import { validarCheckout } from '../src/monthlyCheckout.js';

test('Regressões: catálogo mensal, recibo de cinco selos, estoque e repetição de estorno', async () => {
    assert.ok(process.env.FIRESTORE_EMULATOR_HOST);
    const app = initializeApp({ projectId: 'demo-emaus-cancel-regression' }, 'cancel-regression');
    const db = getFirestore(app);
    const now = new Date('2026-09-03T12:00:00-03:00');
    try {
        await db.collection('planosMensais').doc('corte').set({ nome: 'Corte', preco: 80, ativo: true });
        const plano = { userId: 'u', plano: { id: 'corte', preco: 1, nome: 'Forjado' } };
        await assert.rejects(validarCheckout(db, plano, 'plano', 1, '', now), /Valor divergente/);
        const cotacao = await validarCheckout(db, plano, 'plano', 80, '', now);
        assert.equal(cotacao.plano.preco, 80);
        assert.equal(cotacao.plano.nome, 'Corte');
        await assert.rejects(validarCheckout(db, { userId: 'u', isPlano: 'true' }, 'agendamento', 1), /Indicador/);
        await db.collection('servicos').doc('barba').set({ nome: 'Barba', preco: 20 });
        const extra = { userId: 'u', isPlanoMensalistaComExtras: true, semanaPlano: 1, dataHora: '2026-09-03T16:00', extras: ['Barba'] };
        await assert.rejects(validarCheckout(db, extra, 'agendamento', 20, '', now), /inativo/);
        await db.collection('assinaturasClientes').doc('u').set({ status: 'ativo', dataPagamento: '2026-09-01T12:00:00Z', dataFim: '2026-10-01T12:00:00Z', semanas: {} });
        await assert.rejects(validarCheckout(db, extra, 'agendamento', 1, '', now), /Valor divergente/);
        assert.equal((await validarCheckout(db, extra, 'agendamento', 20, '', now)).isPlano, true);
        await db.collection('assinaturasClientes').doc('u').update({ 'semanas.1': { status: 'agendado' } });
        await assert.rejects(validarCheckout(db, extra, 'agendamento', 20, '', now), /utilizado/);

        const ref = db.collection('agendamentos').doc('regressao');
        await ref.set({ userId: 'u', status: 'confirmado', dataHora: '2026-09-03T16:00', slotId: 'slot', isFidelidade: true, idPagamento: '123456', taxaReservaPaga: 20, produtos: [{ id: 'pomada', quantidade: 2 }] });
        await db.collection('resgates_beneficios').doc('regressao').set({ userId: 'u', metaSelos: 5 });
        await db.collection('fidelidadeClientes').doc('u').set({ selosAtuais: 0, recompensasUtilizadas: 1 });
        await db.collection('configuracoes').doc('fidelidade').set({ metaSelos: 10 });
        await db.collection('produtos').doc('pomada').set({ estoque: 8 });
        await db.collection('comprasProdutos').doc('compra').set({ paymentId: 'regressao', produtoId: 'pomada', quantidade: 2 });
        await db.collection('slots_agendamentos').doc('slot').set({ status: 'ocupado' });
        await db.collection('slots_proprietarios').doc('slot').set({ userId: 'u', paymentId: 'outra-reserva' });
        const keys = [];
        const processarEstorno = async (_id, valor, _motivo, key) => {
            assert.equal((await ref.get()).data().status, 'cancelado', 'Cancela antes de chamar o gateway');
            assert.equal(valor, 20);
            keys.push(key);
            if (keys.length === 1) throw new Error('Timeout simulado');
            return { success: true };
        };
        const primeiro = await cancelarAgendamentoAvulso(db, 'u', 'regressao', { processarEstorno }, now);
        assert.equal(primeiro.status, 'cancelado');
        assert.equal(primeiro.estornoRealizado, false);
        const segundo = await cancelarAgendamentoAvulso(db, 'u', 'regressao', { processarEstorno }, now);
        assert.equal(segundo.status, 'reembolsado');
        await cancelarAgendamentoAvulso(db, 'u', 'regressao', { processarEstorno }, now);
        assert.deepEqual(keys, ['cancelamento_regressao', 'cancelamento_regressao']);
        const fid = (await db.collection('fidelidadeClientes').doc('u').get()).data();
        assert.equal(fid.selosAtuais, 5, 'Devolve a meta consumida, não a configuração atual de dez');
        assert.equal(fid.recompensaDisponivel, false);
        assert.equal((await db.collection('produtos').doc('pomada').get()).data().estoque, 10);
        assert.ok((await db.collection('comprasProdutos').doc('compra').get()).data().estoqueRestauradoEm);
        assert.equal((await db.collection('slots_agendamentos').doc('slot').get()).exists, true, 'Preserva reserva nova do mesmo cliente');

        await db.collection('agendamentos').doc('legado').set({ userId: 'u', status: 'confirmado', dataHora: '2026-09-03T16:00', produtos: [{ id: 'pomada', quantidade: 2 }], isFidelidade: true });
        const legado = await cancelarAgendamentoAvulso(db, 'u', 'legado', {}, now);
        assert.equal(legado.agendamento.estoqueRequerConferencia, true);
        assert.equal(legado.agendamento.beneficioRequerConferencia, true);
        assert.equal((await db.collection('produtos').doc('pomada').get()).data().estoque, 10);
    } finally {
        await db.terminate();
        await deleteApp(app);
    }
});

test('Emulator: cancelamento de agendamento avulso no servidor valida dono, 3h de antecedência, estorno e estoque', async () => {
    assert.ok(process.env.FIRESTORE_EMULATOR_HOST, 'Este teste deve rodar apenas no Firestore Emulator.');
    const app = initializeApp({ projectId: 'demo-emaus-single-booking' }, 'single-booking-tests');
    const db = getFirestore(app);

    try {
        const uid = 'cliente-avulso-1';
        const outroUid = 'cliente-invasor-2';
        const now = new Date('2026-09-03T12:00:00-03:00');

        // Cria agendamento futuro (+4h de antecedência)
        const agId = 'ag-teste-avulso-1';
        const slotId = '2026-09-03_16:00_barbeiro-1';
        await db.collection('agendamentos').doc(agId).set({
            userId: uid,
            cliente: 'Cliente Teste',
            servico: 'Corte',
            dataHora: '2026-09-03T16:00',
            barbeiroId: 'barbeiro-1',
            slotId,
            status: 'confirmado',
            idPagamento: '12345',
            estoqueDebitado: true,
            taxaReservaPaga: 40.00,
            produtos: [{ id: 'prod-pomada', quantidade: 2 }]
        });

        await db.collection('slots_agendamentos').doc(slotId).set({
            slotId,
            dataHora: '2026-09-03T16:00',
            barbeiroId: 'barbeiro-1',
            status: 'ocupado'
        });

        await db.collection('slots_proprietarios').doc(slotId).set({
            userId: uid, paymentId: agId
        });

        await db.collection('produtos').doc('prod-pomada').set({
            nome: 'Pomada Modeladora',
            estoque: 8
        });

        // 1. Tentar cancelar agendamento de terceiro deve falhar com 403 / Acesso negado
        await assert.rejects(
            cancelarAgendamentoAvulso(db, outroUid, agId, {}, now),
            /Acesso negado/
        );

        // 2. Cancelar com +3h de antecedência deve conceder elegibilidade de estorno e restaurar estoque e slot
        let estornoChamadoCom = null;
        const mockEstorno = async (paymentId, valor, motivo) => {
            estornoChamadoCom = { paymentId, valor, motivo };
            return { success: true, refundId: 'ref-999' };
        };

        const res1 = await cancelarAgendamentoAvulso(db, uid, agId, { processarEstorno: mockEstorno }, now);

        assert.equal(res1.status, 'reembolsado');
        assert.equal(res1.elegivelEstorno, true);
        assert.equal(res1.estornoRealizado, true);
        assert.equal(res1.valorEstornado, 40.00);
        assert.equal(res1.alreadyRecorded, false);
        assert.ok(estornoChamadoCom);
        assert.equal(estornoChamadoCom.paymentId, '12345');
        assert.equal(estornoChamadoCom.valor, 40.00);

        // Verifica estado no banco
        const agSnap = await db.collection('agendamentos').doc(agId).get();
        assert.equal(agSnap.data().status, 'reembolsado');
        assert.equal(agSnap.data().canceladoPor, 'cliente');

        // Slot deve ter sido liberado
        const slotSnap = await db.collection('slots_agendamentos').doc(slotId).get();
        assert.equal(slotSnap.exists, false);

        // Estoque deve ter sido devolvido (8 + 2 = 10)
        const prodSnap = await db.collection('produtos').doc('prod-pomada').get();
        assert.equal(prodSnap.data().estoque, 10);

        // 3. Chamada repetida (idempotência) deve retornar alreadyRecorded: true sem reexecutar estorno
        estornoChamadoCom = null;
        const resRepetido = await cancelarAgendamentoAvulso(db, uid, agId, { processarEstorno: mockEstorno }, now);
        assert.equal(resRepetido.alreadyRecorded, true);
        assert.equal(estornoChamadoCom, null);

        // 4. Teste de cancelamento com menos de 3h de antecedência (sem direito a estorno)
        const agIdTarde = 'ag-teste-avulso-tarde';
        const slotIdTarde = '2026-09-03_14:00_barbeiro-1';
        await db.collection('agendamentos').doc(agIdTarde).set({
            userId: uid,
            cliente: 'Cliente Teste',
            servico: 'Barba',
            dataHora: '2026-09-03T14:00', // Apenas 2h para as 12:00
            barbeiroId: 'barbeiro-1',
            slotId: slotIdTarde,
            status: 'confirmado',
            idPagamento: 'mp-payment-67890',
            taxaReservaPaga: 25.00
        });

        await db.collection('slots_agendamentos').doc(slotIdTarde).set({ slotId: slotIdTarde, status: 'ocupado' });

        const resTarde = await cancelarAgendamentoAvulso(db, uid, agIdTarde, { processarEstorno: mockEstorno }, now);
        assert.equal(resTarde.status, 'cancelado');
        assert.equal(resTarde.elegivelEstorno, false);
        assert.equal(resTarde.estornoRealizado, false);
        assert.equal(resTarde.valorEstornado, 0);

        const agTardeSnap = await db.collection('agendamentos').doc(agIdTarde).get();
        assert.equal(agTardeSnap.data().status, 'cancelado');
        assert.equal(agTardeSnap.data().estornoRealizado, false);
    } finally {
        await db.terminate();
        await deleteApp(app);
    }
});
