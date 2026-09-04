import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { vincularMensalista } from '../src/monthlyIdentity.js';
import { gravarCicloMensal } from '../src/monthlyCycle.js';
import { cancelarPlanoMensal } from '../src/monthlyBooking.js';

test('Regressão: ciclo não reinicia créditos e extras têm estorno idempotente', async () => {
    assert.ok(process.env.FIRESTORE_EMULATOR_HOST);
    const app = initializeApp({ projectId: 'demo-cycle-regression' }, 'cycle-regression');
    const db = getFirestore(app), now = new Date('2026-09-04T12:00:00-03:00');
    try {
        const ref = db.doc('assinaturasClientes/u');
        const assinatura = { status: 'ativo', dataFim: '2026-10-01', idPagamento: 'primeiro' };
        await gravarCicloMensal(db, 'u', assinatura, db.doc('clientes/u'), { nome: 'Teste' }, now);
        await ref.update({ 'semanas.1': { status: 'agendado', agendamentoId: 'ag' } });
        assert.equal((await gravarCicloMensal(db, 'u', assinatura, db.doc('clientes/u'), {}, now)).alreadyRecorded, true);
        await assert.rejects(gravarCicloMensal(db, 'u', { ...assinatura, idPagamento: 'segundo' }, db.doc('clientes/u'), {}, now), /ciclo vigente/);
        assert.equal((await ref.get()).data().semanas[1].agendamentoId, 'ag');
        await db.doc('agendamentos/ag').set({ userId: 'u', isPlano: true, status: 'confirmado', slotId: 's', dataHora: '2026-09-04T15:00', idPagamento: '12345', taxaReservaPaga: 20 });
        await db.doc('slots_agendamentos/s').set({ dataHora: '2026-09-04T15:00' });
        await db.doc('slots_proprietarios/s').set({ userId: 'u', paymentId: 'ag' });
        const keys = [];
        const processarEstorno = async (id, valor, key) => {
            assert.equal(id, '12345'); assert.equal(valor, 20);
            assert.equal((await db.doc('agendamentos/ag').get()).data().status, 'cancelado');
            keys.push(key);
            if (keys.length === 1) throw new Error('timeout');
            return { success: true };
        };
        const a = await cancelarPlanoMensal(db, 'u', 'ag', now, { processarEstorno });
        assert.equal(a.status, 'disponivel', 'Exatamente três horas preserva o crédito');
        assert.equal(a.agendamento.estornoExtrasStatus, 'pendente');
        const b = await cancelarPlanoMensal(db, 'u', 'ag', now, { processarEstorno });
        assert.equal(b.agendamento.estornoExtrasStatus, 'confirmado');
        await cancelarPlanoMensal(db, 'u', 'ag', now, { processarEstorno });
        assert.deepEqual(keys, ['cancelamento_ag', 'cancelamento_ag']);
        assert.equal((await db.doc('estornos_extras/ag').get()).data().status, 'confirmado');
        await ref.update({ dataFim: '2026-09-01' });
        const renovacoes = await Promise.allSettled(['r1', 'r2'].map(idPagamento => gravarCicloMensal(db, 'u', { ...assinatura, idPagamento }, db.doc('clientes/u'), {}, now)));
        assert.equal(renovacoes.filter(r => r.status === 'fulfilled').length, 1);
        assert.equal((await db.collection('assinaturas_historico').get()).size, 1);
    } finally { await db.terminate(); await deleteApp(app); }
});

test('Emulator: Vínculo automático de assinatura cadastrada pelo Admin via e-mail e telefone', async () => {
    assert.ok(process.env.FIRESTORE_EMULATOR_HOST, 'Execução em emulador');
    const app = initializeApp({ projectId: 'demo-identity-link' }, 'id-link-app');
    const db = getFirestore(app);

    try {
        const emailCliente = 'joao.silva@teste.com';
        const telefoneCliente = '11999998888';
        const adminDocId = 'mensal_abc1234567890';
        const now = new Date('2026-09-03T12:00:00Z');

        // 1. Simula o Admin ativando o mensalista no balcão (sem UID do Firebase Auth conhecido)
        await db.collection('assinaturasClientes').doc(adminDocId).set({
            userId: adminDocId,
            userEmail: emailCliente,
            emailNormalizado: emailCliente,
            telefone: telefoneCliente,
            cliente: 'João da Silva Balcão',
            planoId: 'plano-vip-mensal',
            nomePlano: 'Plano VIP Completo',
            dataPagamento: '2026-09-01T10:00:00Z',
            dataFim: '2026-10-01T10:00:00Z',
            status: 'ativo',
            ativadoPorAdmin: true,
            semanas: {
                1: { status: 'disponivel', versaoReserva: 1 }
            }
        });

        // 2. Mock do Firebase Auth retornando a conta do cliente recém-logado
        const novoUidCliente = 'usr_joao_firebase_auth_789';
        const identidadeAuth = {
            uid: novoUidCliente,
            email: emailCliente,
            emailVerified: true,
            phoneNumber: '+5511999998888'
        };

        const mockAuth = {
            getUser: async (id) => {
                if (id === novoUidCliente) return identidadeAuth;
                const err = new Error('User not found');
                err.code = 'auth/user-not-found';
                throw err;
            }
        };

        // 3. Cliente chama a consulta de assinatura (/api/cliente/minha-assinatura -> vincularMensalista)
        const resVinculo = await vincularMensalista(db, identidadeAuth, mockAuth, now);

        assert.equal(resVinculo.vinculado, true, 'O vínculo automático deve ser realizado');
        assert.ok(resVinculo.assinatura, 'A assinatura deve ser retornada ao cliente');
        assert.equal(resVinculo.assinatura.userId, novoUidCliente);
        assert.equal(resVinculo.assinatura.origemCadastroId, adminDocId);

        // 4. Confere no banco que a assinatura foi gravada na chave do UID do cliente
        const assDestinoSnap = await db.collection('assinaturasClientes').doc(novoUidCliente).get();
        assert.ok(assDestinoSnap.exists, 'Assinatura deve existir com chave do novo UID');
        assert.equal(assDestinoSnap.data().status, 'ativo');
        assert.equal(assDestinoSnap.data().nomePlano, 'Plano VIP Completo');

        // 5. Confere que a assinatura de origem foi marcada como migrada
        const assOrigemSnap = await db.collection('assinaturasClientes').doc(adminDocId).get();
        assert.equal(assOrigemSnap.data().status, 'migrado');
        assert.equal(assOrigemSnap.data().migradoPara, novoUidCliente);

        // 6. Confere que o CRM do cliente recebeu a tag VIP e dados do plano
        const crmSnap = await db.collection('clientes').doc(novoUidCliente).get();
        assert.ok(crmSnap.exists);
        assert.equal(crmSnap.data().isVip, true);
        assert.ok(crmSnap.data().tags.includes('VIP'));

        // 7. Chamada subsequente (já vinculado) não tenta vincular novamente
        const resRepetida = await vincularMensalista(db, identidadeAuth, mockAuth, now);
        assert.equal(resRepetida.vinculado, false);
        assert.equal(resRepetida.assinatura.userId, novoUidCliente);
    } finally {
        await db.terminate();
        await deleteApp(app);
    }
});
