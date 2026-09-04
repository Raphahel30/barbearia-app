import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { agendarPlanoMensal, cancelarPlanoMensal } from '../src/monthlyBooking.js';
import { agendarBeneficioGratuito } from '../src/freeBooking.js';
import { cancelarAgendamentoAvulso } from '../src/singleBooking.js';
import { sincronizarEListarBaseCRM, isEmailAdmin } from '../src/server.js';

test('Diagnóstico 1: Cliente mensalista agenda pela aba Planos com consumo semanal atômico', async () => {
    assert.ok(process.env.FIRESTORE_EMULATOR_HOST, 'Execução em emulador');
    const app = initializeApp({ projectId: 'demo-diagnostic-1' }, 'diag-app-1');
    const db = getFirestore(app);

    try {
        const uidVip = 'cliente-vip-carlos';
        await db.collection('usuarios').doc(uidVip).set({ nome: 'Carlos VIP', telefone: '11988887777' });
        await db.collection('assinaturasClientes').doc(uidVip).set({
            status: 'ativo',
            nomePlano: 'Plano VIP Cabelo e Barba',
            dataPagamento: '2026-09-01T10:00:00Z',
            dataFim: '2026-10-01T10:00:00Z',
            semanas: {}
        });

        const dataHoraAgendamento = '2026-09-05T14:00';
        const now = new Date('2026-09-03T12:00:00Z');

        // 1. Cliente mensalista agenda semana 1
        const resAgendamento = await agendarPlanoMensal(db, uidVip, {
            dataHora: dataHoraAgendamento,
            semana: 1,
            barbeiroId: 'barbeiro-principal'
        }, now);

        assert.equal(resAgendamento.status, 'confirmado');
        assert.ok(resAgendamento.agDocId, 'ID do agendamento deve ser retornado');

        // 2. Confere agendamento gravado
        const agSnap = await db.collection('agendamentos').doc(resAgendamento.agDocId).get();
        assert.ok(agSnap.exists);
        assert.equal(agSnap.data().isPlano, true);
        assert.equal(agSnap.data().semanaPlano, 1);
        assert.equal(agSnap.data().preco, 0);

        // 3. Confere semana do plano atualizada
        const planoSnap = await db.collection('assinaturasClientes').doc(uidVip).get();
        assert.equal(planoSnap.data().semanas[1].status, 'agendado');
        assert.equal(planoSnap.data().semanas[1].agendamentoId, resAgendamento.agDocId);

        // 4. Confere slot ocupado
        const slotsSnap = await db.collection('slots_agendamentos').get();
        assert.equal(slotsSnap.size, 1);

        // 5. Tenta agendar a mesma semana novamente -> deve ser bloqueado
        await assert.rejects(
            agendarPlanoMensal(db, uidVip, { dataHora: '2026-09-06T15:00', semana: 1 }, now),
            /já foi utilizado/
        );
    } finally {
        await db.terminate();
        await deleteApp(app);
    }
});

test('Diagnóstico 2: Todos os clientes conseguem agendar pela aba Agendamentos (comum, mensalista avulso e benefício fidelidade)', async () => {
    assert.ok(process.env.FIRESTORE_EMULATOR_HOST, 'Execução em emulador');
    const app = initializeApp({ projectId: 'demo-diagnostic-2' }, 'diag-app-2');
    const db = getFirestore(app);

    try {
        // Setup: serviço, fidelidade e 3 perfis de clientes
        await db.collection('servicos').doc('corte-cabelo').set({ nome: 'Corte Degradê', preco: 45 });
        await db.collection('configuracoes').doc('fidelidade').set({
            metaSelos: 5,
            tipoRecompensa: 'servico_gratis',
            ativo: true
        });

        const cliComum = 'cli-comum-joao';
        const cliMensalista = 'cli-mensalista-marcos';
        const cliFidelidade = 'cli-fidelidade-pedro';

        await db.collection('usuarios').doc(cliComum).set({ nome: 'João Comum', telefone: '11977771111' });
        await db.collection('usuarios').doc(cliMensalista).set({ nome: 'Marcos Mensal', telefone: '11977772222' });
        await db.collection('assinaturasClientes').doc(cliMensalista).set({ status: 'ativo', nomePlano: 'Corte' });
        await db.collection('usuarios').doc(cliFidelidade).set({ nome: 'Pedro Fiel', telefone: '11977773333' });
        await db.collection('fidelidadeClientes').doc(cliFidelidade).set({ selosAtuais: 5, recompensaDisponivel: true });

        const now = new Date('2026-09-03T10:00:00Z');

        // A. Cliente Comum agenda corte avulso (simulação pós-reserva do servidor)
        const slot1Id = '2026-09-05T09:00_principal';
        await db.collection('slots_agendamentos').doc(slot1Id).set({
            dataHora: '2026-09-05T09:00',
            barbeiroId: 'principal',
            status: 'confirmado'
        });
        await db.collection('agendamentos').doc('ag-joao').set({
            clienteId: cliComum,
            cliente: 'João Comum',
            servico: 'Corte Degradê',
            dataHora: '2026-09-05T09:00',
            status: 'confirmado',
            precoFinal: 45
        });

        // B. Cliente Mensalista também agenda um corte EXTRA/avulso para seu amigo/filho pela aba de agendamentos
        const slot2Id = '2026-09-05T10:00_principal';
        await db.collection('slots_agendamentos').doc(slot2Id).set({
            dataHora: '2026-09-05T10:00',
            barbeiroId: 'principal',
            status: 'confirmado'
        });
        await db.collection('agendamentos').doc('ag-marcos-extra').set({
            clienteId: cliMensalista,
            cliente: 'Marcos Mensal',
            servico: 'Corte Degradê',
            dataHora: '2026-09-05T10:00',
            status: 'confirmado',
            precoFinal: 45
        });

        // C. Cliente com Fidelidade Resgata corte 100% grátis diretamente na aba Agendamentos
        const resGratuito = await agendarBeneficioGratuito(db, cliFidelidade, {
            data: '2026-09-05',
            horario: '11:00',
            servicoBase: 'Corte Degradê',
            isFidelidade: true,
            barbeiroId: 'principal',
            requestId: 'req-pedro-fidelidade-123456'
        }, now);

        assert.equal(resGratuito.status, 'confirmado');
        assert.equal(resGratuito.preco, 0);

        // Verifica que todos os 3 agendamentos existem na base
        const totalAgendamentos = await db.collection('agendamentos').get();
        assert.equal(totalAgendamentos.size, 3);
        const totalSlots = await db.collection('slots_agendamentos').get();
        assert.equal(totalSlots.size, 3);
    } finally {
        await db.terminate();
        await deleteApp(app);
    }
});

test('Diagnóstico 3: Sistema 100% sincronizado entre Admin e Cliente', async () => {
    assert.ok(process.env.FIRESTORE_EMULATOR_HOST, 'Execução em emulador');
    const app = initializeApp({ projectId: 'demo-diagnostic-3' }, 'diag-app-3');
    const db = getFirestore(app);

    try {
        const adminUid = 'admin-supremo';
        await db.collection('administradores').doc(adminUid).set({ email: 'admin@barbearia.com', ativo: true });
        assert.equal(await isEmailAdmin('admin@barbearia.com', adminUid, db), true);

        // 1. Admin bloqueia feriado/dia fechado
        await db.collection('diasBloqueados').doc('2026-09-07').set({ motivo: 'Feriado da Independência' });

        // Cliente tenta agendar no dia bloqueado pelo admin -> deve falhar
        await db.collection('servicos').doc('corte').set({ nome: 'Corte', preco: 40 });
        await db.collection('configuracoes').doc('fidelidade').set({
            metaSelos: 5,
            tipoRecompensa: 'servico_gratis',
            ativo: true
        });
        await db.collection('usuarios').doc('cli-lucas').set({ nome: 'Lucas', telefone: '11999990000' });
        await db.collection('fidelidadeClientes').doc('cli-lucas').set({ selosAtuais: 5 });

        await assert.rejects(
            agendarBeneficioGratuito(db, 'cli-lucas', {
                data: '2026-09-07',
                horario: '10:00',
                servicoBase: 'Corte',
                isFidelidade: true,
                barbeiroId: 'principal',
                requestId: 'req-feriado-bloqueado-123'
            }, new Date('2026-09-03T10:00:00Z')),
            /fora do expediente/
        );

        // 2. Admin desbloqueia a data
        await db.collection('diasBloqueados').doc('2026-09-07').delete();

        // Cliente agora consegue agendar normalmente
        const agSucesso = await agendarBeneficioGratuito(db, 'cli-lucas', {
            data: '2026-09-07',
            horario: '10:00',
            servicoBase: 'Corte',
            isFidelidade: true,
            barbeiroId: 'principal',
            requestId: 'req-feriado-liberado-123'
        }, new Date('2026-09-03T10:00:00Z'));
        assert.equal(agSucesso.status, 'confirmado');

        // 3. Admin visualiza agendamento no CRM
        const baseCRM = await sincronizarEListarBaseCRM(db);
        const lucasNoCRM = baseCRM.find(c => c.nome === 'Lucas');
        assert.ok(lucasNoCRM, 'Cliente deve ser sincronizado no CRM do admin');
        assert.equal(lucasNoCRM.totalAgendamentos, 1);

        // 4. Cancelamento pelo cliente sincroniza agenda do admin (libera slot)
        const cancelado = await cancelarAgendamentoAvulso(
            db,
            'cli-lucas',
            agSucesso.agDocId,
            {},
            new Date('2026-09-04T10:00:00Z') // > 3h antes
        );
        assert.equal(cancelado.status, 'cancelado');
        assert.equal((await db.collection('slots_agendamentos').get()).size, 0, 'Slot deve estar livre');
    } finally {
        await db.terminate();
        await deleteApp(app);
    }
});

test('Diagnóstico 4: Regras de negócio e propósito geral (3h de antecedência e cancelamento)', async () => {
    assert.ok(process.env.FIRESTORE_EMULATOR_HOST, 'Execução em emulador');
    const app = initializeApp({ projectId: 'demo-diagnostic-4' }, 'diag-app-4');
    const db = getFirestore(app);

    try {
        const uid = 'cliente-teste-regras';
        const agId = 'ag-regra-antecedencia';
        const slotId = '2026-09-04T15:00_principal';

        await db.collection('usuarios').doc(uid).set({ nome: 'Regra Teste', telefone: '11988889999' });
        await db.collection('slots_agendamentos').doc(slotId).set({ slotId, dataHora: '2026-09-04T15:00', status: 'confirmado' });
        await db.collection('slots_proprietarios').doc(slotId).set({ agendamentoId: agId });
        await db.collection('agendamentos').doc(agId).set({
            userId: uid,
            clienteId: uid,
            dataHora: '2026-09-04T15:00',
            status: 'confirmado',
            slotId,
            valorCobrado: 40,
            pagamentoStatus: 'pago'
        });

        // Teste de cancelamento tardio (apenas 1 hora antes)
        // Horário do corte: 15:00. Tentativa às 14:00:
        const horarioTardio = new Date('2026-09-04T14:00:00-03:00');
        const resTardio = await cancelarAgendamentoAvulso(db, uid, agId, {}, horarioTardio);
        assert.equal(resTardio.status, 'cancelado');
        assert.equal(resTardio.elegivelEstorno, false, 'Cancelamento com menos de 3h não deve estornar');

        const agPos = (await db.collection('agendamentos').doc(agId).get()).data();
        assert.equal(agPos.status, 'cancelado');
        assert.equal(agPos.elegivelEstorno, false);
    } finally {
        await db.terminate();
        await deleteApp(app);
    }
});
