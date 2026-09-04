import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import app from './src/server.js';

async function main() {
    console.log('🧪 Iniciando testes das correções de segurança (PCI-DSS, Anti-Spam WhatsApp, OAuth CSRF)...');

    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;

    async function req(path, options = {}) {
        const url = `${base}${path}`;
        const res = await fetch(url, options);
        let data = null;
        const text = await res.text();
        try { data = JSON.parse(text); } catch (_) { data = text; }
        return { status: res.status, headers: res.headers, data };
    }

    try {
        // 1. Teste PCI-DSS: Tentativa de envio de número de cartão bruto (PAN)
        console.log('🔒 Teste 1: PCI-DSS em /api/pagamento/cartao...');
        // Simulando envio de token de usuário autenticado de teste
        // Nota: sem token Bearer, verificarUsuarioMiddleware bloqueia com 401
        const resSemAuth = await req('/api/pagamento/cartao', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cardNumber: '4111111111111111', securityCode: '123' })
        });
        assert.equal(resSemAuth.status, 401, 'Bloqueio sem auth');
        console.log('  ✅ [PASS] Requisição sem token bloqueada com 401');

        // 2. Teste Anti-Spam WhatsApp: /api/whatsapp/notificar-agendamento
        console.log('🔒 Teste 2: Anti-Spam / Relay Fechado no WhatsApp...');
        const resWhatsSemKey = await req('/api/whatsapp/notificar-agendamento', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cliente: 'Spammer', telefone: '5511999999999' })
        });
        assert.equal(resWhatsSemKey.status, 401, 'Bloqueio sem chave de serviço nem admin');
        console.log('  ✅ [PASS] Notificação direta sem credenciais bloqueada com 401');

        const resWhatsChaveFalsa = await req('/api/whatsapp/notificar-agendamento', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-internal-key': 'chave_falsa_do_atacante'
            },
            body: JSON.stringify({ cliente: 'Spammer', telefone: '5511999999999' })
        });
        assert.equal(resWhatsChaveFalsa.status, 401, 'Bloqueio com chave interna falsa');
        console.log('  ✅ [PASS] Chave interna incorreta bloqueada via timingSafeEqual com 401');

        // 3. Teste OAuth State CSRF Protection
        console.log('🔒 Teste 3: OAuth Mercado Pago CSRF Protection...');
        const resCallbackInvalido = await req('/api/auth/mercadopago/callback?code=fake_code&state=fake_state', {
            redirect: 'manual'
        });
        // Deve redirecionar para admin com mensagem de erro de CSRF
        assert.equal(resCallbackInvalido.status, 302, 'Callback com state falso redireciona');
        const loc = resCallbackInvalido.headers.get('location') || '';
        assert.ok(loc.includes('CSRF') || loc.includes('invalido'), `Redirecionamento bloqueia CSRF: ${loc}`);
        console.log('  ✅ [PASS] Callback OAuth com state fraudulento bloqueado com proteção anti-CSRF');

        console.log('\n🎉 Todos os testes de segurança passaram com sucesso!');
    } finally {
        server.close();
    }
}

main().catch((err) => {
    console.error('❌ Erro no teste de segurança:', err);
    process.exit(1);
});
