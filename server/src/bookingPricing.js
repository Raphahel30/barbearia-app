const invalid = message => Object.assign(new Error(message), { statusCode: 400 });
const dinheiro = (value, label = 'Valor') => {
    if (!['number', 'string'].includes(typeof value) || String(value).trim() === '') throw invalid(`${label} inválido.`);
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > 1000000) throw invalid(`${label} inválido.`);
    return Math.round((n + Number.EPSILON) * 100);
};
const reais = cents => cents / 100;
const ativo = item => item && item.ativo !== false && item.status !== 'inativo';

function promocaoNaData(p, data) {
    return ativo(p) && ((p.tipoAplicacao === 'dia_semana' && Number(p.diaSemana) === dataValida(data).getUTCDay()) ||
        (p.tipoAplicacao === 'data_especifica' && p.dataEspecifica === data));
}

function descontoPromocional(promo, base) {
    if (promo?.tipoDesconto === 'fixo') return Math.min(base, dinheiro(promo.valorDesconto || 0));
    if (promo?.tipoDesconto === 'porcentagem') {
        const pct = Number(promo.valorDesconto || 0);
        if (!Number.isFinite(pct) || pct < 0 || pct > 100) throw invalid('Promoção inválida.');
        return Math.round(base * pct / 100);
    }
    return 0;
}

function diaBrasil(now) {
    const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
    return ['year', 'month', 'day'].map(key => p.find(x => x.type === key).value).join('-');
}

function dataValida(date) {
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw invalid('Data inválida.');
    const parsed = new Date(`${date}T12:00:00Z`);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) throw invalid('Data inválida.');
    return parsed;
}

function servicoPorNome(catalogo, nome) {
    const encontrados = catalogo.filter(s => ativo(s) && s.nome === nome);
    if (typeof nome !== 'string' || encontrados.length !== 1) throw invalid('Serviço indisponível ou ambíguo. Atualize a página.');
    return encontrados[0];
}

function descontoRecompensa(config, total, base, valorPadrao, percentualPadrao) {
    if (config.tipoRecompensa === 'servico_gratis') return Math.min(total, base);
    if (!config.tipoRecompensa || config.tipoRecompensa === 'desconto_valor') return Math.min(total, dinheiro(config.valorDesconto || valorPadrao));
    if (config.tipoRecompensa === 'desconto_porcentagem') {
        const pct = Number(config.porcentagemDesconto || percentualPadrao);
        if (!Number.isFinite(pct) || pct < 0 || pct > 100) throw invalid('Percentual de benefício inválido.');
        return Math.min(total, Math.round(total * pct / 100));
    }
    throw invalid('Benefício não configurado.');
}

function aniversarioElegivel(perfil, config, now) {
    const hoje = diaBrasil(now), ano = Number(hoje.slice(0, 4));
    if (config.ativo === false || Number(perfil.anoUltimoResgateAniversario || 0) === ano) return false;
    try { dataValida(perfil.dataNascimento); } catch { return false; }
    const mesDia = perfil.dataNascimento.slice(5), mesAtual = hoje.slice(5, 7);
    const janela = config.janelaValidade || 'mes_aniversario';
    if (janela === 'mes_aniversario') return mesDia.slice(0, 2) === mesAtual;
    if (janela === 'dia_exato') return mesDia === hoje.slice(5);
    if (janela !== 'semana_aniversario') return false;
    const today = new Date(`${hoje}T12:00:00Z`);
    let birthday = new Date(`${ano}-${mesDia}T12:00:00Z`);
    if (birthday < today) birthday = new Date(`${ano + 1}-${mesDia}T12:00:00Z`);
    const dias = Math.ceil((birthday - today) / 86400000);
    return dias <= 7 || (mesDia.slice(0, 2) === mesAtual && Math.abs(Number(hoje.slice(8)) - Number(mesDia.slice(3))) <= 3);
}

// Função pura: somente o argumento catalogo é autoridade para preços e benefícios.
export function calcularPrecoAgendamento(dados, catalogo, valorSolicitado, tipoCartao = '', now = new Date(), permitirGratuito = false) {
    if (!dados || typeof dados !== 'object' || !catalogo) throw invalid('Agendamento inválido.');
    if (!['', 'credito', 'debito'].includes(tipoCartao)) throw invalid('Tipo de cartão inválido.');
    if (!['taxa', 'total'].includes(dados.modalidade)) throw invalid('Modalidade de pagamento inválida.');
    const data = dados.data || String(dados.dataHora || '').slice(0, 10);
    const horario = dados.horario || String(dados.dataHora || '').slice(11);
    dataValida(data);
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(horario)) throw invalid('Horário inválido.');
    if (dados.dataHora && dados.dataHora !== `${data}T${horario}`) throw invalid('Data e horário divergentes.');
    const principal = servicoPorNome(catalogo.servicos, dados.servicoBase || dados.servico);
    const baseOriginal = dinheiro(principal.preco, 'Preço do serviço');
    if (dados.extras != null && !Array.isArray(dados.extras)) throw invalid('Adicionais inválidos.');
    const nomesExtras = (dados.extras || []).map(e => typeof e === 'string' ? e : e?.nome);
    if (nomesExtras.length > 20 || new Set(nomesExtras).size !== nomesExtras.length || nomesExtras.includes(principal.nome)) throw invalid('Adicionais repetidos ou inválidos.');
    const extras = nomesExtras.map(nome => servicoPorNome(catalogo.servicos, nome));
    const subtotalExtras = extras.reduce((total, e) => total + dinheiro(e.preco, 'Preço do adicional'), 0);
    if (dados.produtos != null && !Array.isArray(dados.produtos)) throw invalid('Produtos inválidos.');
    const selecionados = dados.produtos || [];
    if (selecionados.length > 20 || new Set(selecionados.map(p => p?.id)).size !== selecionados.length) throw invalid('Produtos repetidos ou inválidos.');
    const produtos = selecionados.map(item => {
        const p = catalogo.produtos.find(p => p.id === item?.id && ativo(p));
        const quantidade = Number(item?.quantidade);
        if (!p || !Number.isInteger(quantidade) || quantidade < 1 || quantidade > 20 || !Number.isFinite(Number(p.estoque)) || Number(p.estoque || 0) < quantidade) throw invalid('Produto indisponível ou estoque insuficiente.');
        const precoBase = dinheiro(p.preco, 'Preço do produto');
        // Produtos seguem a promoção da compra; serviços seguem a data do atendimento.
        const promoProduto = (catalogo.promocoes || []).find(promo => promocaoNaData(promo, diaBrasil(now)) &&
            (promo.aplicarEm === 'todos_produtos' || (promo.aplicarEm === 'produto_especifico' &&
                (promo.itemAlvoId === p.id || promo.itemAlvoNome === p.nome))));
        const preco = precoBase - descontoPromocional(promoProduto, precoBase);
        return { id: p.id, nome: p.nome, volumeUnidade: p.volumeUnidade || '', quantidade, preco: reais(preco), subtotal: reais(preco * quantidade) };
    });
    const subtotalProdutos = produtos.reduce((sum, p) => sum + dinheiro(p.subtotal), 0);
    const promo = (catalogo.promocoes || []).find(p => promocaoNaData(p, data) &&
        (p.aplicarEm === 'todos_servicos' || (p.aplicarEm === 'servico_especifico' && [p.itemAlvoNome, p.itemAlvoId].includes(principal.nome))));
    const descontoPromocao = descontoPromocional(promo, baseOriginal);
    const base = baseOriginal - descontoPromocao;
    let total = base + subtotalExtras + subtotalProdutos;
    const precoSemBeneficios = total;
    let descontoFidelidade = 0, descontoAniversario = 0, metaSelosResgate = 0;
    if (dados.isFidelidade === true) {
        const cfg = catalogo.fidelidadeConfig || {}, fid = catalogo.fidelidade || {};
        const meta = Number(cfg.metaSelos || 10);
        if (cfg.ativo === false || !Number.isInteger(meta) || meta < 1 || Number(fid.selosAtuais || 0) < meta) throw invalid('Recompensa de fidelidade indisponível.');
        descontoFidelidade = descontoRecompensa(cfg, total, base, 15, 20);
        total -= descontoFidelidade;
        if (descontoFidelidade) metaSelosResgate = meta;
    }
    if (dados.isAniversario === true) {
        const cfg = catalogo.aniversarioConfig || {};
        if (!aniversarioElegivel(catalogo.perfil || {}, cfg, now)) throw invalid('Benefício de aniversário indisponível.');
        descontoAniversario = descontoRecompensa(cfg, total, base, 20, 50);
        total -= descontoAniversario;
    }
    const reserva = catalogo.reserva || {};
    if (dados.modalidade === 'taxa' && reserva.taxaReservaAtiva === false) throw invalid('Taxa de reserva desativada. Escolha pagamento total.');
    const cobrar = dados.modalidade === 'total' ? total : Math.min(total, dinheiro(reserva.valorTaxaReserva || 10));
    const cfgPagamento = catalogo.pagamento || {};
    const taxa = Number(tipoCartao === 'debito' ? (cfgPagamento.taxaCartaoDebito || 0) : tipoCartao === 'credito' ? (cfgPagamento.taxaCartaoCredito || 0) : 0);
    if (!Number.isFinite(taxa) || taxa < 0 || taxa > 100) throw invalid('Taxa de cartão inválida.');
    const esperado = Math.round(cobrar * (1 + taxa / 100));
    if ((!permitirGratuito && esperado <= 0) || dinheiro(valorSolicitado) !== esperado) throw invalid('Valor divergente do catálogo. Atualize a página antes de pagar.');
    return {
        ...dados, servicoBase: principal.nome,
        servico: principal.nome + (extras.length ? ` (+ ${extras.map(e => e.nome).join(', ')})` : '') + (produtos.length ? ` [📦 + ${produtos.map(p => p.nome).join(', ')}]` : ''),
        data, horario, dataHora: `${data}T${horario}`, extras: extras.map(e => e.nome), produtos,
        subtotalExtras: reais(subtotalExtras), subtotalProdutos: reais(subtotalProdutos), precoOriginal: reais(baseOriginal + subtotalExtras + subtotalProdutos),
        precoSemBeneficios: reais(precoSemBeneficios), preco: reais(total), precoFinal: reais(total), valorCobrado: reais(esperado),
        promocao: promo?.titulo || '', descontoPromocao: reais(descontoPromocao), descontoFidelidade: reais(descontoFidelidade), descontoAniversario: reais(descontoAniversario),
        isFidelidade: descontoFidelidade > 0, isAniversario: descontoAniversario > 0,
        descricaoFidelidade: descontoFidelidade ? (catalogo.fidelidadeConfig?.descricaoRecompensa || '') : '',
        descricaoAniversario: descontoAniversario ? (catalogo.aniversarioConfig?.descricaoRecompensa || '') : '',
        metaSelosResgate, anoResgateAniversario: descontoAniversario ? Number(diaBrasil(now).slice(0, 4)) : null,
        precificadoPeloServidor: true
    };
}

export async function validarPrecoAgendamento(db, dados, tipo, valor, tipoCartao = '') {
    if (!['agendamento', 'plano', 'produto'].includes(tipo)) throw invalid('Tipo de compra inválido.');
    if (!dados || typeof dados !== 'object' || Array.isArray(dados)) throw invalid('Dados da compra inválidos.');
    if (tipo !== 'agendamento' || dados.isPlano === true || dados.isPlanoMensalistaComExtras === true) return dados;
    if (!db || !dados.userId) throw invalid('Não foi possível consultar o catálogo.');
    return calcularPrecoAgendamento(dados, await carregarCatalogoAgendamento(db, dados.userId), valor, tipoCartao);
}

export async function carregarCatalogoAgendamento(db, uid, ler = ref => ref.get()) {
    const refs = [
        db.collection('servicos'), db.collection('produtos'), db.collection('promocoes'),
        db.collection('configuracoes').doc('taxaReserva'), db.collection('configuracoes').doc('pagamento'),
        db.collection('configuracoes').doc('fidelidade'), db.collection('configuracoes').doc('aniversario'),
        db.collection('fidelidadeClientes').doc(uid), db.collection('usuarios').doc(uid)
    ];
    const [servicos, produtos, promocoes, reserva, pagamento, fidelidadeConfig, aniversarioConfig, fidelidade, perfil] = await Promise.all(refs.map(ler));
    const lista = snap => snap.docs.map(d => ({ ...d.data(), id: d.id }));
    return {
        servicos: lista(servicos), produtos: lista(produtos), promocoes: lista(promocoes), reserva: reserva.data(), pagamento: pagamento.data(),
        fidelidadeConfig: fidelidadeConfig.data(), aniversarioConfig: aniversarioConfig.data(), fidelidade: fidelidade.data(), perfil: perfil.data()
    };
}
