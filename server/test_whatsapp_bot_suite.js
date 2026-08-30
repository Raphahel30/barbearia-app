import { 
    iniciarWhatsApp, 
    obterStatusWhatsApp, 
    desconectarWhatsApp, 
    enviarMensagemWhatsApp,
    gerarCodigoPareamentoWhatsApp
} from './src/whatsappService.js';
import app from './src/server.js';
import http from 'http';

console.log('\n================================================================');
console.log('🧪 INICIANDO SUÍTE COMPLETA DE TESTES DO WHATSAPP BOT - EMAÚS');
console.log('================================================================\n');

let passedTests = 0;
let failedTests = 0;

function assert(condition, testName, details = '') {
    if (condition) {
        console.log(`  ✅ [PASS] ${testName}`);
        passedTests++;
    } else {
        console.error(`  ❌ [FAIL] ${testName} - ${details}`);
        failedTests++;
    }
}

async function runTests() {
    console.log('📦 1. Testando Métodos Nativos do WhatsAppService.js:');

    // 1.1 Status Inicial
    const status1 = obterStatusWhatsApp();
    assert(status1 && typeof status1.status === 'string', 'obterStatusWhatsApp retorna objeto com campo status');
    assert('qrCode' in status1 && 'pairingCode' in status1 && 'userNumber' in status1, 'obterStatusWhatsApp possui todos os campos esperados');

    // 1.2 Validação de Número no Código de Pareamento
    const resPairVazio = await gerarCodigoPareamentoWhatsApp('');
    assert(resPairVazio.success === false, 'gerarCodigoPareamentoWhatsApp rejeita número vazio');

    const resPairCurto = await gerarCodigoPareamentoWhatsApp('12345');
    assert(resPairCurto.success === false, 'gerarCodigoPareamentoWhatsApp rejeita número inválido/curto');

    // 1.3 Envio de Mensagem com Parâmetros Inválidos
    const resMsgVazia = await enviarMensagemWhatsApp('', 'Olá');
    assert(resMsgVazia.success === false, 'enviarMensagemWhatsApp rejeita número de destino vazio');

    const resMsgSemTexto = await enviarMensagemWhatsApp('11999999999', '');
    assert(resMsgSemTexto.success === false, 'enviarMensagemWhatsApp rejeita mensagem vazia');

    // 1.4 Envio de Mensagem em Modo Offline / Simulado
    const resEnvioOffline = await enviarMensagemWhatsApp('11999999999', 'Teste de envio offline');
    assert(resEnvioOffline.success === false && resEnvioOffline.error.includes('desconectado'), 'enviarMensagemWhatsApp lida graciosamente com robô offline');

    // 1.5 Desconexão Limpa
    const resDesconectar = await desconectarWhatsApp();
    assert(resDesconectar.success === true, 'desconectarWhatsApp executa reset limpo de sessão');
    const statusAposDesc = obterStatusWhatsApp();
    assert(statusAposDesc.status === 'disconnected', 'Status pós desconexão é "disconnected"');

    console.log('\n🌐 2. Testando Rotas da API REST do Servidor Express:');

    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, resolve));
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;

    async function apiRequest(endpoint, method = 'GET', body = null, headers = {}) {
        const fetchHeaders = {
            'Content-Type': 'application/json',
            ...headers
        };
        const options = {
            method,
            headers: fetchHeaders
        };
        if (body) options.body = JSON.stringify(body);
        const res = await fetch(`${baseUrl}${endpoint}`, options);
        let json = null;
        try {
            json = await res.json();
        } catch (_) {}
        return { status: res.status, data: json };
    }

    // 2.1 GET /api/whatsapp/status (Público)
    const statusApi = await apiRequest('/api/whatsapp/status');
    assert(statusApi.status === 200, 'GET /api/whatsapp/status responde 200 OK');
    assert(statusApi.data && typeof statusApi.data.status === 'string', 'GET /api/whatsapp/status retorna dados estruturados');

    // 2.2 Rotas que exigem Autenticação Admin ou Chave Interna (verificar bloqueio sem token/chave)
    const rotasProtegidas = [
        { path: '/api/whatsapp/conectar', method: 'POST', body: {} },
        { path: '/api/whatsapp/codigo-pareamento', method: 'POST', body: { telefone: '11999999999' } },
        { path: '/api/whatsapp/desconectar', method: 'POST', body: {} },
        { path: '/api/whatsapp/enviar', method: 'POST', body: { numero: '11999999999', mensagem: 'Oi' } },
        { path: '/api/whatsapp/testar-barbeiro', method: 'POST', body: { numero: '11999999999' } },
        { path: '/api/whatsapp/lembrete-expiracao-plano', method: 'POST', body: { telefone: '11999999999' } },
        { path: '/api/whatsapp/disparar-lembretes-expiracao-lote', method: 'POST', body: { clientes: [] } },
        { path: '/api/whatsapp/notificar-aniversario', method: 'POST', body: { telefone: '11999999999' } },
        { path: '/api/whatsapp/disparar-lembretes-4h', method: 'GET' },
        { path: '/api/whatsapp/notificar-agendamento', method: 'POST', body: { cliente: 'Teste' } },
        { path: '/api/whatsapp/notificar-cancelamento', method: 'POST', body: { cliente: 'Teste' } },
        { path: '/api/whatsapp/notificar-compra-plano', method: 'POST', body: { cliente: 'Teste' } },
        { path: '/api/whatsapp/notificar-compra-produto', method: 'POST', body: { cliente: 'Teste' } }
    ];

    for (const rota of rotasProtegidas) {
        const resProt = await apiRequest(rota.path, rota.method, rota.body);
        assert(resProt.status === 401 || resProt.status === 403, `Segurança: ${rota.method} ${rota.path} bloqueia acesso não-autorizado (HTTP ${resProt.status})`);
    }

    // Headers autenticados via Chave Interna de Serviço
    const internalHeaders = {
        'x-internal-key': process.env.INTERNAL_SERVICE_KEY || '81c4e36048d120da4a23d25fb91065bc0549da7b776516b36760a5ff7768d157'
    };

    // 2.3 Testando Rotas de Notificação de Agendamento (Completas com x-internal-key)
    console.log('\n📲 3. Testando Rotas de Notificações de Negócio (com x-internal-key):');

    // 3.1 Notificar Novo Agendamento Padrão
    const resAgendamento = await apiRequest('/api/whatsapp/notificar-agendamento', 'POST', {
        cliente: 'Lucas Silva',
        telefone: '11988887777',
        servico: 'Corte Degradê Navalhado',
        dataHora: '2026-08-30T15:00',
        preco: 45,
        taxaReservaPaga: 10,
        modalidade: 'reserva',
        whatsappBarbeiro: '11999998888',
        barbeiroNome: 'Aldo Rodrigues'
    }, internalHeaders);
    assert(resAgendamento.status === 200, 'POST /api/whatsapp/notificar-agendamento responde 200 OK');
    assert(resAgendamento.data.success === true, 'POST /api/whatsapp/notificar-agendamento processa barbeiro e cliente com sucesso');

    // 3.2 Notificar Novo Agendamento com Produtos Cross-Sell
    const resAgendamentoProdutos = await apiRequest('/api/whatsapp/notificar-agendamento', 'POST', {
        cliente: 'Marcos Souza',
        telefone: '11977776666',
        servico: 'Corte + Barba',
        dataHora: '2026-08-30T16:30',
        preco: 70,
        taxaReservaPaga: 70,
        modalidade: 'total',
        produtos: [
            { nome: 'Pomada Matte EMAÚS', quantidade: 1, volumeUnidade: '150g', subtotal: 45 },
            { nome: 'Óleo para Barba', quantidade: 1, volumeUnidade: '30ml', subtotal: 35 }
        ],
        whatsappBarbeiro: '11999998888',
        barbeiroNome: 'Aldo Rodrigues'
    }, internalHeaders);
    assert(resAgendamentoProdutos.status === 200 && resAgendamentoProdutos.data.success === true, 'POST /api/whatsapp/notificar-agendamento com produtos no balcão processa com sucesso');

    // 3.3 Notificar Agendamento de Assinante Plano Mensal VIP
    const resAgendamentoVip = await apiRequest('/api/whatsapp/notificar-agendamento', 'POST', {
        cliente: 'Rodrigo VIP',
        telefone: '11966665555',
        servico: 'Corte Semanal VIP',
        dataHora: '2026-08-30T18:00',
        preco: 0,
        taxaReservaPaga: 0,
        isPlano: true,
        semanaPlano: 2,
        whatsappBarbeiro: '11999998888'
    }, internalHeaders);
    assert(resAgendamentoVip.status === 200 && resAgendamentoVip.data.success === true, 'POST /api/whatsapp/notificar-agendamento para Assinante VIP processa com sucesso');

    // 3.4 Notificar Cancelamento de Agendamento
    const resCancelamento = await apiRequest('/api/whatsapp/notificar-cancelamento', 'POST', {
        cliente: 'Lucas Silva',
        telefone: '11988887777',
        servico: 'Corte Degradê Navalhado',
        dataHora: '2026-08-30T15:00',
        motivo: 'Imprevisto no trabalho',
        canceladoPor: 'cliente',
        estornoRealizado: true,
        valorEstornado: 10,
        whatsappBarbeiro: '11999998888'
    }, internalHeaders);
    assert(resCancelamento.status === 200 && resCancelamento.data.success === true, 'POST /api/whatsapp/notificar-cancelamento processa com sucesso');

    // 3.5 Notificar Compra de Plano Mensal VIP
    const resCompraPlano = await apiRequest('/api/whatsapp/notificar-compra-plano', 'POST', {
        cliente: 'Carlos Eduardo',
        telefone: '11955554444',
        nomePlano: 'Plano Mensal Cabelo VIP (4 Cortes)',
        preco: 129.90,
        dataFim: '2026-09-30',
        whatsappBarbeiro: '11999998888'
    }, internalHeaders);
    assert(resCompraPlano.status === 200 && resCompraPlano.data.success === true, 'POST /api/whatsapp/notificar-compra-plano processa com sucesso');

    // 3.6 Notificar Compra de Produtos da Barbearia (Loja Física / Pix Online)
    const resCompraProduto = await apiRequest('/api/whatsapp/notificar-compra-produto', 'POST', {
        cliente: 'Fernando Lima',
        telefone: '11944443333',
        produtos: [
            { nome: 'Shampoo Mentolado EMAÚS', quantidade: 2, volumeUnidade: '250ml', subtotal: 60 }
        ],
        valorTotal: 60,
        metodoPagamento: 'Pix',
        whatsappBarbeiro: '11999998888'
    }, internalHeaders);
    assert(resCompraProduto.status === 200 && resCompraProduto.data.success === true, 'POST /api/whatsapp/notificar-compra-produto processa com sucesso');

    server.close(() => {
        console.log('\n================================================================');
        console.log(`📊 RESULTADO FINAL DOS TESTES: ${passedTests} Passaram | ${failedTests} Falharam`);
        console.log('================================================================\n');

        if (failedTests > 0) {
            process.exit(1);
        } else {
            process.exit(0);
        }
    });
}

runTests().catch(err => {
    console.error('Erro fatal durante a execução dos testes:', err);
    process.exit(1);
});
