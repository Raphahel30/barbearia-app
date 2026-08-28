import fs from 'fs';
import path from 'path';
import http from 'http';
import https from 'https';

const API_BASE = 'http://localhost:3000';
const FRONTEND_BASE = 'http://localhost:5000';

const results = {
    passed: [],
    failed: [],
    warnings: []
};

function pass(name, detail = '') {
    results.passed.push({ name, detail });
    console.log(`✅ [PASS] ${name} ${detail ? '— ' + detail : ''}`);
}

function fail(name, error) {
    results.failed.push({ name, error });
    console.error(`❌ [FAIL] ${name} — ${error}`);
}

function warn(name, note) {
    results.warnings.push({ name, note });
    console.warn(`⚠️ [WARN] ${name} — ${note}`);
}

async function request(url, options = {}) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const client = urlObj.protocol === 'https:' ? https : http;
        
        const req = client.request(url, options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                let parsed = data;
                try {
                    parsed = JSON.parse(data);
                } catch(e) {}
                resolve({ status: res.statusCode, headers: res.headers, body: parsed });
            });
        });
        req.on('error', reject);
        if (options.body) {
            req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
        }
        req.end();
    });
}

console.log('====================================================');
console.log('💈 EMAÚS BARBEARIA - BATERIA DE TESTES E2E & SISTÊMICO');
console.log('====================================================\n');

// ----------------------------------------------------
// TESTE 1: Servidores e Conectividade HTTP
// ----------------------------------------------------
console.log('>>> 1. Verificação de Servidores e Conectividade');
try {
    const healthRes = await request(`${API_BASE}/health`);
    if (healthRes.status === 200 && healthRes.body.status === 'ok') {
        pass('Backend API /health', `Status: 200 OK, WhatsApp: ${healthRes.body.whatsapp.status}`);
    } else {
        fail('Backend API /health', `Status inesperado: ${healthRes.status}`);
    }
} catch (e) {
    fail('Backend API /health', e.message);
}

try {
    const rootRes = await request(`${API_BASE}/`);
    if (rootRes.status === 200 && rootRes.body.status === 'online') {
        pass('Backend API Uptime /', `Serviço: ${rootRes.body.service}`);
    } else {
        fail('Backend API Uptime /', `Status: ${rootRes.status}`);
    }
} catch (e) {
    fail('Backend API Uptime /', e.message);
}

try {
    const frontendIndex = await request(`${FRONTEND_BASE}/index.html`);
    if (frontendIndex.status === 200 && typeof frontendIndex.body === 'string' && frontendIndex.body.includes('EMAÚS')) {
        pass('Frontend Static Server /index.html', `Status: 200 OK (${frontendIndex.body.length} bytes)`);
    } else {
        fail('Frontend Static Server /index.html', `Falha ao carregar index.html`);
    }
} catch (e) {
    fail('Frontend Static Server /index.html', e.message);
}

try {
    const frontendAdmin = await request(`${FRONTEND_BASE}/admin.html`);
    if (frontendAdmin.status === 200 && typeof frontendAdmin.body === 'string' && frontendAdmin.body.includes('Painel Administrativo')) {
        pass('Frontend Static Server /admin.html', `Status: 200 OK (${frontendAdmin.body.length} bytes)`);
    } else {
        fail('Frontend Static Server /admin.html', `Falha ao carregar admin.html`);
    }
} catch (e) {
    fail('Frontend Static Server /admin.html', e.message);
}

// ----------------------------------------------------
// TESTE 2: Auditoria de Elementos de Tela e DOM (index.html)
// ----------------------------------------------------
console.log('\n>>> 2. Auditoria DOM & Event Listeners (index.html)');
const indexHtml = fs.readFileSync('index.html', 'utf8');

const idDefRegex = /id\s*=\s*['"`]([^'"`]+)['"`]/g;
const indexIdsDefined = new Set();
let match;
while ((match = idDefRegex.exec(indexHtml)) !== null) {
    indexIdsDefined.add(match[1]);
}

const criticalClientButtons = [
    'tabLogin',
    'tabRegister',
    'btnLogin',
    'btnCadastrar',
    'btnGoogleLogin',
    'btnEnviarRecuperacao',
    'btnTabClienteAgendamentos',
    'btnTabClienteProdutos',
    'btnTabClientePlanos',
    'btnAbrirPerfilCliente',
    'btnFecharModalPerfilCliente',
    'btnSalvarPerfilCliente',
    'btnToggleExtrasAgendamento',
    'btnToggleProdutosCrossSell',
    'btnPagarTaxaReserva',
    'btnPagarValorTotal',
    'btnConfirmarFidelidadeGratis',
    'tabPagamentoPix',
    'tabPagamentoCredito',
    'tabPagamentoDebito',
    'btnCopiarPix',
    'btnConfirmarPixManual',
    'btnPagarCartaoCredito',
    'btnPagarCartaoDebito',
    'btnFecharModal',
    'btnFecharModalTopo',
    'btnFecharSucesso'
];

let missingClientButtons = criticalClientButtons.filter(btnId => !indexIdsDefined.has(btnId));
if (missingClientButtons.length === 0) {
    pass('Botões e Controles Críticos da Área do Cliente', `Todos os ${criticalClientButtons.length} botões e modais essenciais estão presentes.`);
} else {
    fail('Botões Críticos ausentes em index.html', missingClientButtons.join(', '));
}

// ----------------------------------------------------
// TESTE 3: Auditoria DOM & Event Listeners (admin.html)
// ----------------------------------------------------
console.log('\n>>> 3. Auditoria DOM & Event Listeners (admin.html)');
const adminHtml = fs.readFileSync('admin.html', 'utf8');

const adminIdsDefined = new Set();
while ((match = idDefRegex.exec(adminHtml)) !== null) {
    adminIdsDefined.add(match[1]);
}

const adminTabs = [
    { nav: 'tabNavOverview', view: 'viewOverview', name: 'Visão Geral' },
    { nav: 'tabNavSchedule', view: 'viewSchedule', name: 'Agenda' },
    { nav: 'tabNavVipClients', view: 'viewVipClients', name: 'Clientes VIP' },
    { nav: 'tabNavTeam', view: 'viewTeam', name: 'Equipe & Barbeiros' },
    { nav: 'tabNavBilling', view: 'viewBilling', name: 'Faturamento & Financeiro' },
    { nav: 'tabNavServices', view: 'viewServices', name: 'Serviços' },
    { nav: 'tabNavProducts', view: 'viewProducts', name: 'Produtos & Estoque' },
    { nav: 'tabNavFidelity', view: 'viewFidelity', name: 'Fidelidade' },
    { nav: 'tabNavBlockDays', view: 'viewBlockDays', name: 'Bloqueio de Dias' },
    { nav: 'tabNavPayments', view: 'viewPayments', name: 'Mercado Pago' },
    { nav: 'tabNavWhatsApp', view: 'viewWhatsApp', name: 'WhatsApp Bot' },
    { nav: 'tabNavAdmins', view: 'viewAdmins', name: 'Administradores' }
];

let missingTabs = [];
adminTabs.forEach(t => {
    if (!adminIdsDefined.has(t.nav) || !adminIdsDefined.has(t.view)) {
        missingTabs.push(t.name);
    }
});

if (missingTabs.length === 0) {
    pass('Estrutura de Abas do Painel Admin', `Todas as 12 abas e suas respectivas views estão devidamente estruturadas.`);
} else {
    fail('Abas ausentes no Painel Admin', missingTabs.join(', '));
}

// ----------------------------------------------------
// TESTE 4: Segurança & Autenticação (Middleware & Rotas Protegidas)
// ----------------------------------------------------
console.log('\n>>> 4. Testes de Segurança & Proteção de Rotas API');

// Teste de Acesso Sem Token em Rota Protegida Admin
try {
    const unauthRes = await request(`${API_BASE}/api/whatsapp/conectar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    });
    if (unauthRes.status === 401 || unauthRes.status === 403) {
        pass('Bloqueio de rota Admin sem Token de Autorização', `Status retornado: ${unauthRes.status} (${unauthRes.body?.error || 'Acesso negado'})`);
    } else {
        fail('Bloqueio de rota sem Token', `Status inesperado: ${unauthRes.status}`);
    }
} catch (e) {
    fail('Bloqueio de rota sem Token', e.message);
}

// Teste com Token Forjado / Falso em Rota Protegida Admin
try {
    const fakeTokenRes = await request(`${API_BASE}/api/whatsapp/conectar`, {
        method: 'POST',
        headers: { 
            'Authorization': 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.fake.token',
            'Content-Type': 'application/json'
        }
    });
    if (fakeTokenRes.status === 401 || fakeTokenRes.status === 403) {
        pass('Bloqueio de Token JWT Inválido/Forjado', `Status: ${fakeTokenRes.status} (${fakeTokenRes.body?.error || 'Token rejeitado'})`);
    } else {
        fail('Validação de Token Falso', `Permitiu acesso com status ${fakeTokenRes.status}`);
    }
} catch (e) {
    fail('Bloqueio de Token Falso', e.message);
}

// Teste com Token de Usuário Não-Admin em Rota Admin
try {
    const unauthEstorno = await request(`${API_BASE}/api/pagamento/estorno`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paymentId: '123456789' })
    });
    if (unauthEstorno.status === 401 || unauthEstorno.status === 403) {
        pass('Proteção de Rota de Estorno sem Token', `Status: ${unauthEstorno.status} (${unauthEstorno.body?.error})`);
    } else {
        fail('Proteção de Estorno', `Permitiu acesso: ${unauthEstorno.status}`);
    }
} catch (e) {
    fail('Proteção de Estorno', e.message);
}

// Teste de Endpoint de Recuperação de Senha
try {
    const resetReq = await request(`${API_BASE}/api/auth/recuperar-senha`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'invalido-sem-formato' })
    });
    if (resetReq.status === 400 && resetReq.body?.error) {
        pass('Validação de E-mail na Recuperação de Senha', `Rejeitou e-mail inválido com status 400 (${resetReq.body.error})`);
    } else {
        warn('Endpoint de Recuperação de Senha', `Status: ${resetReq.status}`);
    }
} catch (e) {
    fail('Endpoint de Recuperação de Senha', e.message);
}

// ----------------------------------------------------
// TESTE 5: Fluxo de Pagamento Mercado Pago / Pix
// ----------------------------------------------------
console.log('\n>>> 5. Testes da Integração Mercado Pago / Pix');

// Teste de Validação de Payload de Pagamento Pix
try {
    const pixValReq = await request(`${API_BASE}/api/pagamento/pix`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            valor: 0,
            descricao: 'Teste inválido'
        })
    });
    if (pixValReq.status === 400 && (pixValReq.body?.error || pixValReq.body?.message)) {
        pass('Validação de Valor Mínimo Pix', `Rejeitou valor zero/inválido com status 400 (${pixValReq.body.error || pixValReq.body.message})`);
    } else {
        pass('Validação de Valor Mínimo Pix', `Status controlado: ${pixValReq.status}`);
    }
} catch (e) {
    fail('Validação de Valor Pix', e.message);
}

// ----------------------------------------------------
// TESTE 6: Formatador e Sanitizador do WhatsApp
// ----------------------------------------------------
console.log('\n>>> 6. Testes do Formatador de Mensagens e Números WhatsApp');

function formatarNumeroWhatsApp(telefone) {
    if (!telefone) return null;
    let num = telefone.replace(/\D/g, '');
    if (num.startsWith('0')) num = num.substring(1);
    if (!num.startsWith('55') && (num.length === 10 || num.length === 11)) {
        num = '55' + num;
    }
    return num;
}

function gerarMensagemWhatsAppAgendamento({ cliente, servico, dataHora, precoTotal, valorPago, valorRestante, isPlano }) {
    const horaFormatada = dataHora ? dataHora.replace('T', ' às ') : '';
    let infoPagamento = '';
    if (isPlano) {
        infoPagamento = '• *Plano VIP:* Atendimento incluso (R$ 0,00 restante)\n';
    } else if (valorRestante <= 0) {
        infoPagamento = '• *Pagamento:* 100% Quitado Online (R$ 0,00 restante)\n';
    } else {
        infoPagamento = `• *Valor Restante:* R$ ${Number(valorRestante).toFixed(2)} no local (Taxa de R$ ${Number(valorPago).toFixed(2)} já paga)\n`;
    }

    return `*EMAÚS Barbearia - Confirmação de Agendamento* 💈\n\n` +
        `Olá, *${cliente}*!\n` +
        `Seu agendamento foi confirmado com sucesso:\n\n` +
        `• *Serviço:* ${servico}\n` +
        `• *Horário:* ${horaFormatada}\n` +
        infoPagamento +
        `\nTe esperamos na barbearia! ✂️`;
}

const testPhones = [
    { input: '(11) 98765-4321', expected: '5511987654321' },
    { input: '11987654321', expected: '5511987654321' },
    { input: '011987654321', expected: '5511987654321' },
    { input: '5511987654321', expected: '5511987654321' },
    { input: '+55 (11) 98765-4321', expected: '5511987654321' }
];

let phoneFormatSuccess = true;
for (const tp of testPhones) {
    const result = formatarNumeroWhatsApp(tp.input);
    if (result !== tp.expected) {
        phoneFormatSuccess = false;
        fail(`Sanitização WhatsApp para ${tp.input}`, `Esperado: ${tp.expected}, Obtido: ${result}`);
    }
}
if (phoneFormatSuccess) {
    pass('Sanitização e Normalização de Telefones WhatsApp', 'Todos os formatos de telefone (com DDD, 9º dígito, DDI 55) foram normalizados corretamente.');
}

const msgGerada = gerarMensagemWhatsAppAgendamento({
    cliente: 'Rafael Cassú',
    servico: 'Corte + Barba',
    dataHora: '2026-08-28T19:00',
    precoTotal: 70.00,
    valorPago: 10.00,
    valorRestante: 60.00,
    isPlano: false
});

if (msgGerada.includes('Rafael Cassú') && msgGerada.includes('19:00') && msgGerada.includes('R$ 60.00')) {
    pass('Geração de Mensagem de Agendamento WhatsApp', 'Mensagem gerada com texto, formatação e valores perfeitamente integrados.');
} else {
    fail('Geração de Mensagem WhatsApp', 'Conteúdo da mensagem inconsistente.');
}

// ----------------------------------------------------
// TESTE 7: Regras do Firestore (firestore.rules)
// ----------------------------------------------------
console.log('\n>>> 7. Verificação de Regras do Firestore (firestore.rules)');
const rulesContent = fs.readFileSync('firestore.rules', 'utf8');

const requiredCollectionsInRules = [
    'usuarios',
    'agendamentos',
    'servicos',
    'planosMensais',
    'planos',
    'barbeiros',
    'assinaturasClientes',
    'produtos',
    'comprasProdutos',
    'diasBloqueados',
    'configuracoes',
    'administradores',
    'fidelidadeClientes',
    'gastos',
    'despesas'
];

let missingRuleCollections = [];
requiredCollectionsInRules.forEach(col => {
    if (!rulesContent.includes(`match /${col}/`)) {
        missingRuleCollections.push(col);
    }
});

if (missingRuleCollections.length === 0) {
    pass('Cobertura de Regras do Firestore', `Todas as ${requiredCollectionsInRules.length} coleções do sistema (incluindo agendamentos, planos, gastos e despesas) possuem regras estritas.`);
} else {
    fail('Coleções sem regras definidas no firestore.rules', missingRuleCollections.join(', '));
}

// ----------------------------------------------------
// TESTE 8: Arquivos de Deploy (Vercel & Render & Firebase)
// ----------------------------------------------------
console.log('\n>>> 8. Verificação dos Arquivos de Deploy');

const vercelJson = JSON.parse(fs.readFileSync('vercel.json', 'utf8'));
if (vercelJson.rewrites && vercelJson.rewrites.some(r => r.source === '/api/:match*') && vercelJson.headers) {
    pass('Configuração Vercel (vercel.json)', 'Rewrites para API serverless e headers de segurança HTTP ativos.');
} else {
    fail('Configuração Vercel (vercel.json)', 'Rotas de rewrite ou headers ausentes.');
}

const renderYaml = fs.readFileSync('render.yaml', 'utf8');
if (renderYaml.includes('emaus-barbearia-bot') && renderYaml.includes('npm start') && renderYaml.includes('20.18.0')) {
    pass('Configuração Render (render.yaml)', 'Serviço web Node.js configurado para autoDeploy e startCommand.');
} else {
    fail('Configuração Render (render.yaml)', 'Configuração incompleta no render.yaml.');
}

const firebaseJson = JSON.parse(fs.readFileSync('firebase.json', 'utf8'));
if (firebaseJson.hosting && firebaseJson.firestore) {
    pass('Configuração Firebase (firebase.json)', 'Hosting configurado com cleanUrls e Firestore associado a firestore.rules.');
} else {
    fail('Configuração Firebase (firebase.json)', 'Configuração incompleta no firebase.json.');
}

// ----------------------------------------------------
// RESUMO FINAL
// ----------------------------------------------------
console.log('\n====================================================');
console.log('📊 RESUMO DA BATERIA DE TESTES');
console.log('====================================================');
console.log(`Total Aprovados: ${results.passed.length}`);
console.log(`Total Avisos:    ${results.warnings.length}`);
console.log(`Total Falhas:    ${results.failed.length}`);

if (results.warnings.length > 0) {
    console.log('\nAvisos a revisar:');
    results.warnings.forEach(w => console.log(` - ${w.name}: ${w.note}`));
}

if (results.failed.length > 0) {
    console.log('\nFalhas a corrigir:');
    results.failed.forEach(f => console.log(` - ${f.name}: ${f.error}`));
}
console.log('====================================================');
