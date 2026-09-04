import { validarSemanaPlano } from './monthlyBooking.js';
import { validarPrecoAgendamento } from './bookingPricing.js';
const fail = m => Object.assign(new Error(m), { statusCode: 400 });

export async function validarCheckout(db, dados, tipo, valor, cartao = '', now = new Date()) {
    if (!['agendamento', 'plano', 'produto'].includes(tipo) || !dados?.userId) throw fail('Pedido inválido.');
    if (tipo === 'produto') return dados; // O catálogo do produto é validado pela rota.
    for (const flag of ['isPlano', 'isPlanoMensalistaComExtras']) {
        if (dados[flag] !== undefined && typeof dados[flag] !== 'boolean') throw fail('Indicador de plano inválido.');
    }
    const mensal = dados.isPlano === true || dados.isPlanoMensalistaComExtras === true;
    if (tipo === 'agendamento' && !mensal) return validarPrecoAgendamento(db, dados, tipo, valor, cartao);
    if (!db || !['', 'credito', 'debito'].includes(cartao)) throw fail('Checkout indisponível.');
    if (dados.isFidelidade || dados.isAniversario) throw fail('Benefício avulso não se aplica ao checkout mensal.');
    let base, canonico;
    if (tipo === 'plano') {
        const id = String(dados.plano?.id || '');
        if (!id || id.includes('/')) throw fail('Plano inválido.');
        const doc = await db.collection('planosMensais').doc(id).get();
        if (!doc.exists || doc.data().ativo === false) throw fail('Plano indisponível.');
        const p = doc.data();
        base = Number(p.preco);
        canonico = { ...dados, plano: { id, nome: p.nome, preco: base, servicosInclusos: p.servicosInclusos || [] } };
    } else {
        const sub = (await db.collection('assinaturasClientes').doc(dados.userId).get()).data();
        const dataHora = dados.dataHora || `${dados.data}T${dados.horario}`;
        validarSemanaPlano(sub, Number(dados.semanaPlano), dataHora, now);
        if (new Date(`${dataHora}:00-03:00`).getTime() <= now.getTime() + 20 * 60000) throw fail('Horário sem antecedência mínima.');
        const extras = (Array.isArray(dados.extras) ? dados.extras : []).map(e => typeof e === 'string' ? e : e?.nome);
        if (!extras.length || extras.length > 20 || new Set(extras).size !== extras.length || (dados.produtos || []).length) throw fail('Adicionais mensais inválidos.');
        const catalogo = (await db.collection('servicos').get()).docs.map(d => d.data());
        base = extras.reduce((s, nome) => {
            const encontrados = catalogo.filter(p => p.nome === nome && p.ativo !== false);
            if (encontrados.length !== 1 || !Number.isFinite(Number(encontrados[0].preco)) || Number(encontrados[0].preco) < 0) throw fail('Adicional indisponível.');
            return s + Number(encontrados[0].preco);
        }, 0);
        canonico = { ...dados, isPlano: true, semanaPlano: Number(dados.semanaPlano), extras, produtos: [], servico: `${sub.nomePlano || 'Plano mensal'} + ${extras.join(' + ')}`, dataHora, data: dataHora.slice(0, 10), horario: dataHora.slice(11), preco: base, precoFinal: base, modalidade: 'total' };
    }
    const cfg = (await db.collection('configuracoes').doc('pagamento').get()).data() || {};
    const taxa = Number(cartao === 'credito' ? cfg.taxaCartaoCredito || 0 : cartao === 'debito' ? cfg.taxaCartaoDebito || 0 : 0);
    const cents = Math.round(base * (1 + taxa / 100) * 100);
    if (!Number.isFinite(base) || base <= 0 || !Number.isFinite(taxa) || taxa < 0 || taxa > 100 || Math.round(Number(valor) * 100) !== cents) throw fail('Valor divergente do catálogo mensal.');
    return { ...canonico, isFidelidade: false, isAniversario: false, valorCobrado: cents / 100, checkoutMensalValidado: true };
}
