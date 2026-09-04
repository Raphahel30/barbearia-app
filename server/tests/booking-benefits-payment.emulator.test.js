import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { validarPrecoAgendamento } from '../src/bookingPricing.js';
import { prepararConsumoBeneficios } from '../src/bookingBenefits.js';

test('Emulator: validação autoritativa de orçamento e proteção contra gasto duplo de selos', async () => {
    assert.ok(process.env.FIRESTORE_EMULATOR_HOST, 'Este teste deve rodar apenas no Firestore Emulator.');
    const app = initializeApp({ projectId: 'demo-emaus-benefits-payment' }, 'benefits-payment-tests');
    const db = getFirestore(app);

    try {
        const uid = 'cliente-beneficio-1';
        const now = new Date('2026-09-03T12:00:00-03:00');

        // Configurações do catálogo
        await db.collection('configuracoes').doc('fidelidade').set({
            ativo: true,
            metaSelos: 10,
            tipoRecompensa: 'desconto_valor',
            valorDesconto: 15,
            descricaoRecompensa: 'Desconto de R$ 15,00'
        });

        await db.collection('configuracoes').doc('aniversario').set({
            ativo: true,
            janelaValidade: 'mes_aniversario',
            tipoRecompensa: 'desconto_valor',
            valorDesconto: 20,
            descricaoRecompensa: 'Presente de Aniversário'
        });

        await db.collection('configuracoes').doc('taxaReserva').set({
            taxaReservaAtiva: true,
            valorTaxaReserva: 10.00
        });

        await db.collection('configuracoes').doc('pagamento').set({
            taxaCartaoCredito: 0,
            taxaCartaoDebito: 0
        });

        await db.collection('servicos').doc('corte-simples').set({
            nome: 'Corte Cabelo',
            preco: 40.00,
            ativo: true
        });

        // Cliente possui 10 selos
        await db.collection('fidelidadeClientes').doc(uid).set({
            selosAtuais: 10,
            recompensasUtilizadas: 0,
            recompensaDisponivel: true
        });

        await db.collection('usuarios').doc(uid).set({
            nome: 'Cliente Fiel',
            email: 'fiel@test.com',
            dataNascimento: '1995-09-15'
        });

        // 1. Validação de Orçamento no Servidor (Checkout)
        // Tentativa 1A: Forjar preço menor que a taxa de reserva
        await assert.rejects(
            validarPrecoAgendamento(db, {
                userId: uid,
                servico: 'Corte Cabelo',
                data: '2026-09-04',
                horario: '14:00',
                modalidade: 'taxa'
            }, 'agendamento', 1.00),
            /Valor divergente do catálogo/
        );

        // Tentativa 1B: Reivindicar desconto de fidelidade legítimo com taxa de reserva
        const dadosOrcados = await validarPrecoAgendamento(db, {
            userId: uid,
            servico: 'Corte Cabelo',
            data: '2026-09-04',
            horario: '14:00',
            modalidade: 'total',
            isFidelidade: true
        }, 'agendamento', 25.00); // 40 - 15 = 25

        assert.equal(dadosOrcados.precificadoPeloServidor, true);
        assert.equal(dadosOrcados.descontoFidelidade, 15);
        assert.equal(dadosOrcados.metaSelosResgate, 10);
        assert.equal(dadosOrcados.precoFinal, 25);

        // 2. Proteção contra Race Condition / Gasto Duplo em Concorrência Real
        // Dois pagamentos concorrentes (pay-a e pay-b) foram abertos antes do débito
        const payA = 'mp-pay-concorrente-A';
        const payB = 'mp-pay-concorrente-B';

        const executarConclusaoTransacional = async (paymentId) => {
            const slotId = `slot_2026-09-04T14:00_${paymentId}`;
            return db.runTransaction(async (t) => {
                // Leituras
                const slotRef = db.collection('slots_agendamentos').doc(slotId);
                await t.get(slotRef);

                const consumirBeneficios = await prepararConsumoBeneficios(
                    db,
                    t,
                    paymentId,
                    dadosOrcados,
                    now
                );

                // Escritas
                consumirBeneficios();

                t.set(slotRef, {
                    slotId,
                    status: 'confirmado',
                    paymentId,
                    userId: uid
                });

                t.set(db.collection('agendamentos').doc(paymentId), {
                    idPagamento: paymentId,
                    userId: uid,
                    status: 'confirmado',
                    isFidelidade: true,
                    preco: 25
                });
            });
        };

        // Dispara ambos concorrentemente
        const resultados = await Promise.allSettled([
            executarConclusaoTransacional(payA),
            executarConclusaoTransacional(payB)
        ]);

        const sucessos = resultados.filter(r => r.status === 'fulfilled');
        const rejeitados = resultados.filter(r => r.status === 'rejected');

        // Exatamente um deve suceder e o outro deve ser rejeitado por saldo insuficiente
        assert.equal(sucessos.length, 1);
        assert.equal(rejeitados.length, 1);
        assert.match(rejeitados[0].reason.message, /Saldo de fidelidade insuficiente/);

        // O saldo de fidelidade deve ser exatamente 0 (10 - 10), nunca negativo
        const fidFinal = (await db.collection('fidelidadeClientes').doc(uid).get()).data();
        assert.equal(fidFinal.selosAtuais, 0);
        assert.equal(fidFinal.recompensasUtilizadas, 1);

        // Apenas 1 agendamento e 1 recibo devem existir
        const agSnap = await db.collection('agendamentos').get();
        assert.equal(agSnap.size, 1);

        const recibosSnap = await db.collection('resgates_beneficios').get();
        assert.equal(recibosSnap.size, 1);

    } finally {
        await db.terminate();
        await deleteApp(app);
    }
});
