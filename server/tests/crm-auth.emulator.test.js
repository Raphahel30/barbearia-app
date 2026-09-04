import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { isEmailAdmin, sincronizarEListarBaseCRM, executarBatchEmLotes } from '../src/server.js';

test('Emulator: Autenticação de Administrador e Sincronização Segura do CRM', async () => {
    assert.ok(process.env.FIRESTORE_EMULATOR_HOST, 'Este teste deve rodar apenas no Firestore Emulator.');
    const app = initializeApp({ projectId: 'demo-emaus-crm-auth' }, 'crm-auth-tests');
    const db = getFirestore(app);

    try {
        // ==========================================
        // 1. TESTE DE isEmailAdmin (UID e E-mail)
        // ==========================================
        // Cadastro por UID
        await db.collection('administradores').doc('admin-uid-123').set({
            email: 'admin1@emaus.com',
            ativo: true,
            criadoEm: new Date().toISOString()
        });

        // Cadastro legado apenas por e-mail com ID de documento aleatório
        await db.collection('administradores').doc('doc-aleatorio-email').set({
            email: 'admin2@emaus.com',
            ativo: true,
            criadoEm: new Date().toISOString()
        });

        // Verifica por UID correto
        const ehAdminUid = await isEmailAdmin('qualquer@email.com', 'admin-uid-123', db);
        assert.equal(ehAdminUid, true, 'isEmailAdmin deve reconhecer administrador por UID');

        // Verifica por E-mail (quando UID não coincide ou é nulo)
        const ehAdminEmail = await isEmailAdmin('admin2@emaus.com', 'uid-desconhecido', db);
        assert.equal(ehAdminEmail, true, 'isEmailAdmin deve reconhecer administrador por e-mail');

        // Verifica usuário comum
        const ehAdminComum = await isEmailAdmin('cliente@gmail.com', 'cliente-uid-999', db);
        assert.equal(ehAdminComum, false, 'Usuário comum não deve ter privilégios de administrador');

        // ==========================================
        // 2. TESTE DE SINCRONIZAÇÃO SEGURA DO CRM
        // ==========================================
        // Cenário 1: Cliente existente no CRM com anotações e tags manuais
        await db.collection('clientes').doc('cli-carlos').set({
            nome: 'Carlos Silva',
            telefone: '(11) 98888-7777',
            telefoneNormalizado: '11988887777',
            email: 'carlos@gmail.com',
            emailNormalizado: 'carlos@gmail.com',
            observacoes: 'Prefere café sem açúcar e corte militar',
            tags: ['Cliente Antigo', 'Exigente'],
            dataNascimento: '1985-05-20',
            status: 'ativo',
            totalAgendamentos: 0,
            totalConcluidos: 0,
            totalCancelados: 0,
            totalGastoCentavos: 0,
            createdAt: '2026-01-01T10:00:00.000Z'
        });

        // Cenário 2: Usuário cadastrado no app correspondente ao Carlos
        await db.collection('usuarios').doc('usr-carlos').set({
            nome: 'Carlos Silva',
            telefone: '11988887777',
            email: 'carlos@gmail.com',
            tags: []
        });

        // Cenário 3: Usuária cadastrada no app que é assinante de Plano Mensal VIP
        await db.collection('usuarios').doc('usr-ana').set({
            nome: 'Ana Souza',
            telefone: '11977776666',
            email: 'ana@gmail.com',
            tags: []
        });

        await db.collection('assinaturasClientes').doc('usr-ana').set({
            userId: 'usr-ana',
            cliente: 'Ana Souza',
            telefone: '11977776666',
            status: 'ativo',
            nomePlano: 'Plano Mensal VIP',
            dataFim: '2026-12-31T23:59:59.000Z'
        });

        // Cenário 4: Agendamentos históricos (Carlos teve 2 cortes, e um cliente balcão sem cadastro no app teve 1)
        await db.collection('agendamentos').doc('ag-carlos-1').set({
            userId: 'usr-carlos',
            clienteNome: 'Carlos Silva',
            telefone: '11988887777',
            status: 'concluido',
            preco: 50.00,
            dataHora: '2026-08-10T14:00'
        });

        await db.collection('agendamentos').doc('ag-carlos-2').set({
            userId: 'usr-carlos',
            clienteNome: 'Carlos Silva',
            telefone: '11988887777',
            status: 'concluido',
            preco: 60.00,
            dataHora: '2026-08-25T15:00'
        });

        await db.collection('agendamentos').doc('ag-balcao-1').set({
            clienteNome: 'Rodrigo Balcão',
            telefone: '11966665555',
            status: 'concluido',
            preco: 45.00,
            dataHora: '2026-08-30T10:00'
        });

        // Executa a sincronização segura com persistência no banco
        const listaSincronizada = await sincronizarEListarBaseCRM(db, true);

        // Validações
        assert.ok(Array.isArray(listaSincronizada), 'Deve retornar lista consolidada');
        assert.ok(listaSincronizada.length >= 3, 'Deve conter os clientes Carlos, Ana e Rodrigo Balcão');

        // 1. Carlos: Preservação de campos manuais
        const carlos = listaSincronizada.find(c => c.telefoneNormalizado === '11988887777');
        assert.ok(carlos, 'Carlos deve estar na lista consolidada');
        assert.equal(carlos.observacoes, 'Prefere café sem açúcar e corte militar', 'Observações manuais devem ser preservadas!');
        assert.ok(carlos.tags.includes('Cliente Antigo'), 'Tags customizadas devem ser preservadas!');
        assert.ok(carlos.tags.includes('Exigente'), 'Todas as tags customizadas devem ser mantidas!');
        assert.equal(carlos.dataNascimento, '1985-05-20', 'Data de nascimento deve ser preservada!');
        assert.equal(carlos.totalConcluidos, 2, 'Total de concluídos de Carlos deve ser 2');
        assert.equal(carlos.totalGastoCentavos, 11000, 'Gasto total de Carlos deve somar R$ 110,00 (11000 centavos)');

        // 2. Ana: Reconhecimento de VIP e Plano Ativo
        const ana = listaSincronizada.find(c => c.telefoneNormalizado === '11977776666');
        assert.ok(ana, 'Ana deve estar na lista consolidada');
        assert.equal(ana.isVip, true, 'Ana deve estar com isVip = true');
        assert.ok(ana.tags.includes('VIP'), 'Tags de Ana devem incluir VIP');
        assert.equal(ana.planoStatus, 'ativo');

        // 3. Rodrigo Balcão: Cliente sem conta no app foi incluído pelo agendamento
        const rodrigo = listaSincronizada.find(c => c.telefoneNormalizado === '11966665555');
        assert.ok(rodrigo, 'Cliente avulso/balcão de agendamentos deve ser cadastrado no CRM');
        assert.equal(rodrigo.nome, 'Rodrigo Balcão');
        assert.equal(rodrigo.totalConcluidos, 1);
        assert.equal(rodrigo.totalGastoCentavos, 4500);

        // ==========================================
        // 3. TESTE DE EXECUÇÃO EM LOTES (executarBatchEmLotes)
        // ==========================================
        // Testa gravação particionada de 450 itens (supera o limite unitário de 400 por lote)
        const itensMassa = [];
        for (let i = 0; i < 450; i++) {
            itensMassa.push({ id: `item-massa-${i}`, valor: i });
        }

        let gravados = 0;
        await executarBatchEmLotes(db, itensMassa, (batch, item) => {
            const ref = db.collection('teste_lotes').doc(item.id);
            batch.set(ref, { gravado: true, valor: item.valor });
            gravados++;
        }, 400);

        assert.equal(gravados, 450, 'Deve ter processado todas as 450 operações em múltiplos batches sem erro');
        const snapVerificacao = await db.collection('teste_lotes').doc('item-massa-449').get();
        assert.equal(snapVerificacao.exists, true, 'Último item do segundo lote deve ter sido persistido');

    } finally {
        await app.delete();
    }
});
