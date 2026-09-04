import test from 'node:test';
import assert from 'node:assert/strict';
import { validarSemanaPlano } from '../src/monthlyBooking.js';

const assinatura = { status: 'ativo', dataPagamento: '2026-09-01T12:00:00Z', dataFim: '2026-10-01T12:00:00Z', semanas: {} };
const agora = new Date('2026-09-03T12:00:00Z');
test('plano novo sem mapa de semanas libera a primeira semana', () => {
    assert.equal(validarSemanaPlano(assinatura, 1, '2026-09-03T14:00', agora).toISOString(), '2026-09-03T17:00:00.000Z');
});
test('plano rejeita semana futura, horário fora da semana e crédito consumido', () => {
    assert.throws(() => validarSemanaPlano(assinatura, 2, '2026-09-10T14:00', agora));
    assert.throws(() => validarSemanaPlano(assinatura, 1, '2026-09-10T14:00', agora));
    assert.throws(() => validarSemanaPlano({ ...assinatura, semanas: { 1: { status: 'agendado' } } }, 1, '2026-09-03T14:00', agora));
});
test('plano rejeita status inativo, data inválida e semana fora do intervalo', () => {
    assert.throws(() => validarSemanaPlano({ ...assinatura, status: 'pendente' }, 1, '2026-09-03T14:00', agora));
    assert.throws(() => validarSemanaPlano(assinatura, 0, '2026-09-03T14:00', agora));
    assert.throws(() => validarSemanaPlano(assinatura, 1, '2026-02-30T14:00', agora));
});
