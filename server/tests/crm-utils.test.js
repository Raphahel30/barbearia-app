import test from 'node:test';
import assert from 'node:assert/strict';
import {
    assinaturaMensalEstaAtiva,
    consolidarClientesDuplicadosCRMServidor
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
