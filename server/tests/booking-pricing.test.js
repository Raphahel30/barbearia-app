import test from 'node:test';
import assert from 'node:assert/strict';
import { calcularPrecoAgendamento, validarPrecoAgendamento } from '../src/bookingPricing.js';

const now = new Date('2026-09-03T12:00:00Z');
const dados = { userId: 'cliente', servicoBase: 'Corte', data: '2026-09-04', horario: '14:00', modalidade: 'total' };
const catalogo = () => ({
    servicos: [{ nome: 'Corte', preco: 40 }, { nome: 'Barba', preco: 20 }],
    produtos: [{ id: 'pomada', nome: 'Pomada', preco: 15, estoque: 3 }],
    reserva: { valorTaxaReserva: 10 }, pagamento: { taxaCartaoCredito: 5, taxaCartaoDebito: 2 },
    fidelidadeConfig: { metaSelos: 5, tipoRecompensa: 'desconto_valor', valorDesconto: 15 },
    fidelidade: { selosAtuais: 5 }, perfil: { dataNascimento: '1990-09-10' },
    aniversarioConfig: { tipoRecompensa: 'desconto_valor', valorDesconto: 10 }
});
const quote = (d = {}, c = {}, valor = 40, card = '') => calcularPrecoAgendamento({ ...dados, ...d }, { ...catalogo(), ...c }, valor, card, now);

test('recalcula serviço, extras e produtos e descarta valores adulterados', () => {
    const q = quote({ preco: 1, precoFinal: 1, descontoFidelidade: 999, extras: ['Barba'], produtos: [{ id: 'pomada', quantidade: 2, preco: 0.01, nome: 'Falso' }] }, {}, 90);
    assert.equal(q.preco, 90);
    assert.equal(q.subtotalExtras, 20);
    assert.equal(q.subtotalProdutos, 30);
    assert.equal(q.produtos[0].nome, 'Pomada');
    assert.equal(q.produtos[0].preco, 15);
    assert.equal(q.descontoFidelidade, 0);
    assert.equal(q.precificadoPeloServidor, true);
    assert.throws(() => quote({}, {}, 0.01), /Valor divergente/);
});

test('taxa de reserva é limitada pelo total e cartão usa a taxa do catálogo', () => {
    assert.equal(quote({ modalidade: 'taxa' }, {}, 10).valorCobrado, 10);
    assert.equal(quote({ modalidade: 'taxa' }, { reserva: { valorTaxaReserva: 100 } }, 40).valorCobrado, 40);
    assert.equal(quote({}, {}, 42, 'credito').valorCobrado, 42);
    assert.equal(quote({ modalidade: 'taxa' }, {}, 10.2, 'debito').valorCobrado, 10.2);
    assert.throws(() => quote({ modalidade: 'taxa' }, { reserva: { taxaReservaAtiva: false } }, 10), /desativada/);
    assert.throws(() => quote({}, {}, 40, 'credito'), /divergente/);
});

test('promoção de serviço considera atendimento e produto considera compra no Brasil', () => {
    const promocoes = [
        { aplicarEm: 'todos_servicos', tipoAplicacao: 'dia_semana', diaSemana: 5, tipoDesconto: 'porcentagem', valorDesconto: 25 },
        { aplicarEm: 'produto_especifico', itemAlvoId: 'pomada', tipoAplicacao: 'data_especifica', dataEspecifica: '2026-09-03', tipoDesconto: 'fixo', valorDesconto: 5 }
    ];
    const q = quote({ produtos: [{ id: 'pomada', quantidade: 2 }] }, { promocoes }, 50);
    assert.equal(q.descontoPromocao, 10);
    assert.equal(q.subtotalProdutos, 20);
    assert.equal(q.precoFinal, 50);
});

test('desconsidera promoções inativas ou de outro serviço', () => {
    const promocoes = [
        { ativo: false, aplicarEm: 'todos_servicos', tipoAplicacao: 'data_especifica', dataEspecifica: dados.data, tipoDesconto: 'fixo', valorDesconto: 30 },
        { aplicarEm: 'servico_especifico', itemAlvoNome: 'Barba', tipoAplicacao: 'data_especifica', dataEspecifica: dados.data, tipoDesconto: 'fixo', valorDesconto: 30 }
    ];
    assert.equal(quote({}, { promocoes }).descontoPromocao, 0);
});

test('benefícios usam saldo, configuração e perfil persistidos, não desconto enviado', () => {
    const q = quote({ isFidelidade: true, isAniversario: true, descontoFidelidade: 39 }, {}, 15);
    assert.equal(q.descontoFidelidade, 15);
    assert.equal(q.descontoAniversario, 10);
    assert.equal(q.preco, 15);
    assert.equal(q.metaSelosResgate, 5);
    assert.equal(q.anoResgateAniversario, 2026);
    assert.throws(() => quote({ isFidelidade: true }, { fidelidade: { selosAtuais: 4 } }, 25), /indisponível/);
    assert.throws(() => quote({ isAniversario: true }, { perfil: { dataNascimento: '1990-08-01' } }, 30), /indisponível/);
    assert.throws(() => quote({ isAniversario: true }, { perfil: { dataNascimento: '1990-09-10', anoUltimoResgateAniversario: 2026 } }, 30), /indisponível/);
});

test('recompensas percentual e serviço grátis preservam adicionais pagos', () => {
    assert.equal(quote({ isFidelidade: true }, { fidelidadeConfig: { metaSelos: 5, tipoRecompensa: 'desconto_porcentagem', porcentagemDesconto: 20 } }, 32).preco, 32);
    assert.equal(quote({ isFidelidade: true, extras: ['Barba'] }, { fidelidadeConfig: { metaSelos: 5, tipoRecompensa: 'servico_gratis' } }, 20).preco, 20);
});

test('rejeita catálogo ambíguo, adicionais repetidos e produtos inválidos', () => {
    assert.throws(() => quote({}, { servicos: [{ nome: 'Corte', preco: 40 }, { nome: 'Corte', preco: 40 }] }), /ambíguo/);
    assert.throws(() => quote({ extras: ['Barba', 'Barba'] }), /repetidos/);
    assert.throws(() => quote({ servicoBase: 'Inexistente' }), /indisponível/);
    for (const quantidade of [-1, 0, 1.5, 4, 'NaN']) {
        assert.throws(() => quote({ produtos: [{ id: 'pomada', quantidade }] }), /estoque/);
    }
    assert.throws(() => quote({ produtos: [{ id: 'pomada', quantidade: 1 }] }, { produtos: [{ id: 'pomada', preco: 15, estoque: 'inválido' }] }), /estoque/);
});

test('rejeita data, horário, modalidade e preços inválidos', () => {
    for (const d of [{ data: '2026-02-30' }, { horario: '25:00' }, { dataHora: '2026-09-05T14:00' }, { modalidade: 'gratis' }]) assert.throws(() => quote(d));
    for (const valor of [NaN, Infinity, -1, '', null]) assert.throws(() => quote({}, {}, valor));
    assert.throws(() => quote({}, { servicos: [{ nome: 'Corte', preco: -1 }] }));
});

test('carregador consulta apenas o usuário autenticado informado e normaliza IDs', async () => {
    const records = { servicos: [{ nome: 'Corte', preco: 40 }], produtos: [], promocoes: [] };
    const paths = [];
    const db = { collection(name) { return {
        get: async () => ({ docs: records[name].map((data, i) => ({ id: String(i), data: () => data })) }),
        doc(id) { paths.push(`${name}/${id}`); return { get: async () => ({ data: () => undefined }) }; }
    }; } };
    const result = await validarPrecoAgendamento(db, dados, 'agendamento', 40);
    assert.equal(result.preco, 40);
    assert.ok(paths.includes('usuarios/cliente'));
    assert.ok(paths.includes('fidelidadeClientes/cliente'));
    await assert.rejects(validarPrecoAgendamento(null, dados, 'agendamento', 40));
    await assert.rejects(validarPrecoAgendamento(db, dados, 'desconhecido', 40));
    await assert.rejects(validarPrecoAgendamento(db, null, 'agendamento', 40));
});
