import test from 'node:test';
import assert from 'node:assert/strict';
import {
    assinaturaMensalEstaAtiva,
    consolidarClientesDuplicadosCRMServidor,
    selecionarAssinaturaClienteServidor
} from '../src/crmUtils.js';

test('plano mensal só fica ativo com status ativo e data futura', () => {
    const agora = new Date('2026-09-01T12:00:00.000Z');
    assert.equal(assinaturaMensalEstaAtiva({ status: 'ativo', dataFim: '2026-09-10T12:00:00.000Z' }, agora), true);
    assert.equal(assinaturaMensalEstaAtiva({ status: 'cancelado', dataFim: '2026-09-10T12:00:00.000Z' }, agora), false);
    assert.equal(assinaturaMensalEstaAtiva({ status: 'ativo', dataFim: '2026-08-10T12:00:00.000Z' }, agora), false);
});

test('CRM consolida duplicados por telefone ou email e preserva o plano ativo', () => {
    const clientes = [
        {
            id: 'cadastro-antigo', nome: 'Rafael', telefone: '(11) 99999-0000',
            email: 'rafael@example.com', totalAgendamentos: 3, totalGastoCentavos: 9000,
            tags: ['Frequente']
        },
        {
            id: 'uid-plano', nome: 'Rafael C.', telefone: '11999990000',
            totalAgendamentos: 3, totalGastoCentavos: 9000, tags: ['VIP'],
            isVip: true, planoAtivoId: 'uid-plano',
            assinaturaAtiva: { id: 'uid-plano', userId: 'uid-plano', status: 'ativo' }
        },
        {
            id: 'cadastro-email', email: 'RAFAEL@example.com', observacoes: 'Prefere atendimento à tarde',
            tags: []
        }
    ];

    const resultado = consolidarClientesDuplicadosCRMServidor(clientes);
    assert.equal(resultado.length, 1);
    assert.equal(resultado[0].id, 'uid-plano');
    assert.equal(resultado[0].isVip, true);
    assert.equal(resultado[0].totalAgendamentos, 3, 'não deve somar estatísticas repetidas');
    assert.equal(resultado[0].observacoes, 'Prefere atendimento à tarde');
    assert.deepEqual(new Set(resultado[0].idsRelacionados), new Set(['cadastro-antigo', 'uid-plano', 'cadastro-email']));
});

test('assinatura manual é localizada por telefone verificado exato e vinculável ao UID autenticado', () => {
    const agora = new Date('2026-09-01T12:00:00.000Z');
    const resultado = selecionarAssinaturaClienteServidor([
        {
            id: 'mensal_11999990000', userId: 'mensal_11999990000',
            telefone: '(11) 99999-0000', status: 'ativo', dataFim: '2026-09-20T12:00:00.000Z'
        }
    ], { uid: 'uid-firebase-cliente', telefone: '11999990000' }, agora);

    assert.equal(resultado.ambiguo, false);
    assert.equal(resultado.assinatura.id, 'mensal_11999990000');
});

test('telefone brasileiro com ou sem código do país representa a mesma conta', () => {
    const agora = new Date('2026-09-01T12:00:00.000Z');
    const resultado = selecionarAssinaturaClienteServidor([
        { id: 'mensal_5511999990000', telefone: '5511999990000', status: 'ativo', dataFim: '2026-09-20T12:00:00.000Z' }
    ], { uid: 'uid-firebase-cliente', telefone: '11999990000' }, agora);

    assert.equal(resultado.ambiguo, false);
    assert.equal(resultado.assinatura.id, 'mensal_5511999990000');
});

test('assinatura manual é localizada pelo e-mail confirmado sem depender do telefone do perfil', () => {
    const agora = new Date('2026-09-01T12:00:00.000Z');
    const resultado = selecionarAssinaturaClienteServidor([
        { id: 'mensal-provisorio', userEmail: 'CLIENTE@EXEMPLO.COM', status: 'ativo', dataFim: '2026-09-20T12:00:00.000Z' }
    ], { uid: 'uid-firebase-cliente', email: 'cliente@exemplo.com', telefone: '' }, agora);

    assert.equal(resultado.ambiguo, false);
    assert.equal(resultado.assinatura.id, 'mensal-provisorio');
});

test('assinatura paga no UID tem prioridade e telefone parcial não vincula outra conta', () => {
    const agora = new Date('2026-09-01T12:00:00.000Z');
    const resultado = selecionarAssinaturaClienteServidor([
        { id: 'uid-correto', userId: 'uid-correto', telefone: '11999990000', status: 'ativo', dataFim: '2026-09-20T12:00:00.000Z' },
        { id: 'mensal-outro', telefone: '21999990000', status: 'ativo', dataFim: '2026-09-20T12:00:00.000Z' }
    ], { uid: 'uid-correto', telefone: '999990000' }, agora);

    assert.equal(resultado.ambiguo, false);
    assert.equal(resultado.assinatura.id, 'uid-correto');
});

test('duas assinaturas ativas legadas com a mesma identidade exigem revisão do admin', () => {
    const agora = new Date('2026-09-01T12:00:00.000Z');
    const resultado = selecionarAssinaturaClienteServidor([
        { id: 'legado-1', telefone: '11999990000', status: 'ativo', dataFim: '2026-09-20T12:00:00.000Z' },
        { id: 'legado-2', telefone: '(11) 99999-0000', status: 'ativo', dataFim: '2026-09-21T12:00:00.000Z' }
    ], { uid: 'uid-novo', telefone: '11999990000' }, agora);

    assert.equal(resultado.ambiguo, true);
    assert.equal(resultado.assinatura, null);
});
