import test from 'node:test';
import assert from 'node:assert/strict';
import { criarAgendamentoPeloAdmin } from '../src/adminBooking.js';

function firestoreEmMemoria(inicial = {}) {
    const dados = new Map(Object.entries(inicial));
    const snapshot = (path, ref) => ({
        id: path.split('/').at(-1), ref, exists: dados.has(path), data: () => dados.get(path)
    });
    const documento = path => ({
        id: path.split('/').at(-1), path,
        async get() { return snapshot(path, this); },
        async set(valor, opcoes = {}) { dados.set(path, opcoes.merge ? { ...(dados.get(path) || {}), ...valor } : valor); },
        async update(valor) { dados.set(path, { ...(dados.get(path) || {}), ...valor }); }
    });
    const colecao = nome => ({
        nome,
        doc: id => documento(`${nome}/${id}`),
        async get() {
            const docs = [...dados.keys()].filter(path => path.startsWith(`${nome}/`) && !path.slice(nome.length + 1).includes('/'))
                .map(path => snapshot(path, documento(path)));
            return { docs, empty: docs.length === 0, size: docs.length };
        }
    });
    const db = {
        dados,
        collection: colecao,
        async runTransaction(callback) {
            const tx = {
                get: alvo => alvo.get(),
                set: (ref, valor, opcoes = {}) => { dados.set(ref.path, opcoes.merge ? { ...(dados.get(ref.path) || {}), ...valor } : valor); },
                update: (ref, valor) => { dados.set(ref.path, { ...(dados.get(ref.path) || {}), ...valor }); },
                delete: ref => dados.delete(ref.path)
            };
            return callback(tx);
        }
    };
    return db;
}

const base = {
    'clientes/cliente-123': { nome: 'Cliente Teste', telefone: '11999998888' },
    'servicos/corte': { nome: 'Corte', preco: 40, ativo: true },
    'servicos/barba': { nome: 'Barba', preco: 20, ativo: true },
    'configuracoes/geral': { modoMultiBarbeiro: false },
    'configuracoes/expediente': { abertura: '08:00', fechamento: '18:00', intervaloMin: 60, bloqueioAntecedenciaAtivo: true }
};

test('admin cria horário confirmado com preço do catálogo e ocupa o slot', async () => {
    const db = firestoreEmMemoria(base);
    const ag = await criarAgendamentoPeloAdmin(db, 'admin-123', {
        requestId: 'pedido-admin-0001', clienteId: 'cliente-123', servicoId: 'corte', extraIds: ['barba'],
        dataHora: '2026-09-07T10:00', barbeiroId: 'qualquer', pagamento: 'pagar_local', observacao: 'Cliente prefere tesoura.'
    }, new Date('2026-09-06T12:00:00Z'));
    assert.equal(ag.status, 'confirmado');
    assert.equal(ag.preco, 60);
    assert.equal(ag.servico, 'Corte (+ Barba)');
    assert.equal(ag.criadoPeloAdmin, true);
    assert.equal(db.dados.get('slots_agendamentos/slot_2026-09-07T10:00_qualquer').status, 'confirmado');
});

test('admin não consegue reservar um horário já ocupado', async () => {
    const db = firestoreEmMemoria({
        ...base,
        'slots_agendamentos/slot_2026-09-07T10:00_qualquer': { status: 'confirmado' }
    });
    await assert.rejects(() => criarAgendamentoPeloAdmin(db, 'admin-123', {
        requestId: 'pedido-admin-0002', clienteId: 'cliente-123', servicoId: 'corte', extraIds: [],
        dataHora: '2026-09-07T10:00', barbeiroId: 'qualquer', pagamento: 'pago'
    }, new Date('2026-09-06T12:00:00Z')), /acabou de ser reservado/);
});

test('cadastro rápido cria cliente e cortesia não registra valor pago', async () => {
    const db = firestoreEmMemoria(base);
    const ag = await criarAgendamentoPeloAdmin(db, 'admin-123', {
        requestId: 'pedido-admin-0003', clienteId: '', clienteNovo: { nome: 'Novo Cliente', telefone: '(11) 98888-7777' },
        servicoId: 'corte', extraIds: [], dataHora: '2026-09-07T11:00', barbeiroId: 'qualquer', pagamento: 'cortesia'
    }, new Date('2026-09-06T12:00:00Z'));
    assert.equal(ag.cliente, 'Novo Cliente');
    assert.equal(ag.preco, 0);
    assert.equal(ag.precoOriginal, 40);
    assert.ok([...db.dados.keys()].some(path => path.startsWith('clientes/cli_')));
});
