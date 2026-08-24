import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { MercadoPagoConfig, Payment, PaymentRefund } from 'mercadopago';
import { 
    iniciarWhatsApp, 
    obterStatusWhatsApp, 
    desconectarWhatsApp, 
    enviarMensagemWhatsApp 
} from './whatsappService.js';

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import https from 'https';
import { fileURLToPath } from 'url';

import serviceAccount from './firebaseServiceAccount.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Helper nativo para obter Token Google via Service Account JWT (Zero Dependências)
function getGoogleAccessToken() {
    return new Promise((resolve, reject) => {
        try {
            const now = Math.floor(Date.now() / 1000);
            const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString('base64url');
            const claim = Buffer.from(JSON.stringify({
                iss: serviceAccount.client_email,
                scope: "https://www.googleapis.com/auth/identitytoolkit https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/datastore",
                aud: "https://oauth2.googleapis.com/token",
                exp: now + 3600,
                iat: now
            })).toString('base64url');

            const signer = crypto.createSign('RSA-SHA256');
            signer.update(`${header}.${claim}`);
            const signature = signer.sign(serviceAccount.private_key, 'base64url');

            const jwt = `${header}.${claim}.${signature}`;
            const postData = `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`;

            const req = https.request({
                hostname: 'oauth2.googleapis.com',
                path: '/token',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Content-Length': Buffer.byteLength(postData)
                }
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(data);
                        resolve(parsed.access_token);
                    } catch (e) {
                        reject(e);
                    }
                });
            });
            req.on('error', reject);
            req.write(postData);
            req.end();
        } catch (err) {
            reject(err);
        }
    });
}

function parseFirestoreDoc(doc) {
    if (!doc || !doc.fields) return null;
    const res = {};
    for (const [k, v] of Object.entries(doc.fields)) {
        if (v.stringValue !== undefined) res[k] = v.stringValue;
        else if (v.integerValue !== undefined) res[k] = parseInt(v.integerValue, 10);
        else if (v.doubleValue !== undefined) res[k] = parseFloat(v.doubleValue);
        else if (v.booleanValue !== undefined) res[k] = v.booleanValue;
        else if (v.timestampValue !== undefined) res[k] = v.timestampValue;
        else if (v.nullValue !== undefined) res[k] = null;
        else res[k] = v;
    }
    const nameParts = (doc.name || '').split('/');
    res.id = nameParts[nameParts.length - 1];
    return res;
}

function marcarLembrete4hEnviado(docId, token) {
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify({
            fields: {
                lembrete4hEnviado: { booleanValue: true },
                lembrete4hEnviadoEm: { timestampValue: new Date().toISOString() }
            }
        });

        const req = https.request({
            hostname: 'firestore.googleapis.com',
            path: `/v1/projects/${serviceAccount.project_id}/databases/(default)/documents/agendamentos/${docId}?updateMask.fieldPaths=lembrete4hEnviado&updateMask.fieldPaths=lembrete4hEnviadoEm`,
            method: 'PATCH',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } catch (e) { resolve(null); }
            });
        });
        req.on('error', reject);
        req.write(postData);
        req.end();
    });
}

async function verificarLembretes4hAgenda() {
    try {
        const token = await getGoogleAccessToken();
        const docs = await new Promise((resolve, reject) => {
            const req = https.request({
                hostname: 'firestore.googleapis.com',
                path: `/v1/projects/${serviceAccount.project_id}/databases/(default)/documents/agendamentos?pageSize=100`,
                method: 'GET',
                headers: { 'Authorization': `Bearer ${token}` }
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(data);
                        resolve((parsed.documents || []).map(parseFirestoreDoc).filter(Boolean));
                    } catch (e) { reject(e); }
                });
            });
            req.on('error', reject);
            req.end();
        });

        const agora = new Date();
        const disparos = [];

        for (const ag of docs) {
            if (ag.status === 'cancelado' || ag.status === 'falta' || ag.lembrete4hEnviado) {
                continue;
            }

            if (!ag.dataHora || !ag.telefone) continue;

            const dataAg = new Date(ag.dataHora);
            if (isNaN(dataAg.getTime())) continue;

            const diffMin = (dataAg.getTime() - agora.getTime()) / (60 * 1000);

            // Se o horário estiver entre 3h (180 min) e 4h30 (270 min) no futuro
            if (diffMin >= 180 && diffMin <= 270) {
                const horaFormatada = ag.dataHora.replace('T', ' às ');
                const horaSimples = horaFormatada.split(' às ')[1] || horaFormatada;
                const precoTotal = Number(ag.preco || 0);
                const valorPago = Number(ag.taxaReservaPaga !== undefined ? ag.taxaReservaPaga : (ag.isPlano ? 0 : 10));
                const valorRestante = Math.max(0, precoTotal - valorPago);

                let infoSaldo = "";
                if (ag.isPlano) {
                    infoSaldo = "• *Plano VIP:* Atendimento incluso (R$ 0,00 restante)\n";
                } else if (ag.modalidadePagamento === 'total' || valorRestante === 0) {
                    infoSaldo = "• *Pagamento:* 100% Quitado Online (R$ 0,00 restante)\n";
                } else {
                    infoSaldo = `• *Valor Restante a Pagar no Local:* R$ ${valorRestante.toFixed(2)} (Taxa de R$ ${valorPago.toFixed(2)} já descontada)\n`;
                }

                const msgLembrete = `*EMAÚS Barbearia - Lembrete do seu Atendimento Hoje* ✂️\n\n` +
                    `Olá, *${ag.cliente || 'Cliente'}*! Tudo bem?\n\n` +
                    `Passando para lembrar que o seu atendimento na *EMAÚS Barbearia* está marcado para hoje às *${horaSimples}* (daqui a cerca de 4 horas).\n\n` +
                    `• *Serviço:* ${ag.servico || 'Corte'}\n` +
                    infoSaldo +
                    `• *Local:* EMAÚS Barbearia\n\n` +
                    `Estamos preparando tudo para recebê-lo com a melhor experiência. Solicitamos a gentileza de comparecer com alguns minutos de antecedência.\n\n` +
                    `Te esperamos! 💈\n` +
                    `_EMAÚS Barbearia • Estilo e Tradição_`;

                try {
                    const envio = await enviarMensagemWhatsApp(ag.telefone, msgLembrete);
                    if (envio.success) {
                        await marcarLembrete4hEnviado(ag.id, token);
                        disparos.push({ id: ag.id, cliente: ag.cliente, telefone: ag.telefone, hora: ag.dataHora, status: 'enviado' });
                        console.log(`⏰ Lembrete 4h enviado com sucesso para ${ag.cliente} (${ag.telefone})`);
                    }
                } catch (errEnv) {
                    console.error(`Erro ao enviar lembrete 4h para ${ag.cliente}:`, errEnv.message);
                }
            }
        }

        return { success: true, disparos };
    } catch (e) {
        console.error("Erro na rotina de lembretes 4h:", e.message);
        return { success: false, error: e.message };
    }
}

function requestResetOobCode(token, email) {
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify({
            requestType: "PASSWORD_RESET",
            email: email,
            returnOobLink: true
        });

        const req = https.request({
            hostname: 'identitytoolkit.googleapis.com',
            path: `/v1/projects/${serviceAccount.project_id}/accounts:sendOobCode`,
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(e);
                }
            });
        });
        req.on('error', reject);
        req.write(postData);
        req.end();
    });
}

const app = express();
const port = process.env.PORT || 3000;

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

// Rota raiz para verificação imediata de uptime no Render e UptimeRobot
app.get('/', (req, res) => {
    const waStatus = obterStatusWhatsApp();
    res.json({
        status: 'online',
        service: 'EMAÚS Barbearia - WhatsApp Bot & API 24/7',
        uptime: `${Math.floor(process.uptime())}s`,
        timestamp: new Date().toISOString(),
        whatsapp: {
            status: waStatus.status,
            connectedUser: waStatus.userNumber
        }
    });
});

app.get('/health', (req, res) => {
    const waStatus = obterStatusWhatsApp();
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        whatsapp: waStatus
    });
});

// Inicializa WhatsApp em background somente no servidor dedicado / localhost
if (!process.env.VERCEL) {
    try {
        iniciarWhatsApp().catch(err => console.log('WhatsApp Bot aguardando conexão local/nuvem...'));
    } catch (e) {
        console.warn("Aviso WhatsApp:", e.message);
    }
}

// Endpoint de Recuperação de Senha com Link Direto na Tela de Luxo
app.post('/api/auth/recuperar-senha', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email || !email.includes('@')) {
            return res.status(400).json({ error: 'E-mail inválido.' });
        }

        const token = await getGoogleAccessToken();
        if (!token) {
            return res.status(503).json({ error: 'Não foi possível autenticar com o serviço Google.' });
        }

        const result = await requestResetOobCode(token, email.trim().toLowerCase());
        if (!result || !result.oobCode) {
            const errMsg = result?.error?.message || 'E-mail não encontrado ou inválido.';
            return res.status(400).json({ error: errMsg });
        }

        const oobCode = result.oobCode;
        const directLink = `https://emaus-barbearia.vercel.app/redefinir-senha.html?oobCode=${oobCode}`;

        return res.json({
            success: true,
            link: directLink,
            oobCode: oobCode,
            message: 'Link de redefinição gerado com sucesso!'
        });
    } catch (err) {
        console.error("Erro ao gerar link de recuperação:", err);
        return res.status(400).json({ error: err.message || 'Erro ao gerar link de recuperação.' });
    }
});

// Initialize Mercado Pago SDK client
let activeAccessToken = process.env.MERCADO_PAGO_ACCESS_TOKEN || '';
let client = new MercadoPagoConfig({ 
    accessToken: activeAccessToken || 'DUMMY_TOKEN',
    options: { timeout: 10000 }
});
let paymentClient = new Payment(client);
let refundClient = new PaymentRefund(client);

// Função para buscar e sincronizar token do Mercado Pago direto do Firestore
async function carregarConfiguracoesMercadoPagoFirestore() {
    try {
        const token = await getGoogleAccessToken();
        if (!token) return;
        const data = await new Promise((resolve, reject) => {
            const req = https.request({
                hostname: 'firestore.googleapis.com',
                path: `/v1/projects/${serviceAccount.project_id}/databases/(default)/documents/configuracoes/pagamento`,
                method: 'GET',
                headers: { 'Authorization': `Bearer ${token}` }
            }, (res) => {
                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () => {
                    try { resolve(JSON.parse(body)); } catch(e) { resolve(null); }
                });
            });
            req.on('error', reject);
            req.end();
        });

        if (data && data.fields && data.fields.mpAccessToken && data.fields.mpAccessToken.stringValue) {
            const tokenMp = data.fields.mpAccessToken.stringValue.trim();
            if (tokenMp && tokenMp !== 'SEU_ACCESS_TOKEN_AQUI' && tokenMp.length > 20) {
                activeAccessToken = tokenMp;
                client = new MercadoPagoConfig({ accessToken: activeAccessToken, options: { timeout: 10000 } });
                paymentClient = new Payment(client);
                refundClient = new PaymentRefund(client);
                console.log(`💳 [Mercado Pago] Token sincronizado com sucesso do Firestore: ${activeAccessToken.slice(0, 10)}...`);
            } else {
                activeAccessToken = '';
                client = new MercadoPagoConfig({ accessToken: 'DUMMY_TOKEN', options: { timeout: 10000 } });
                paymentClient = new Payment(client);
                refundClient = new PaymentRefund(client);
            }
        } else {
            activeAccessToken = '';
            client = new MercadoPagoConfig({ accessToken: 'DUMMY_TOKEN', options: { timeout: 10000 } });
            paymentClient = new Payment(client);
            refundClient = new PaymentRefund(client);
        }
    } catch (e) {
        console.warn("Aviso ao carregar token do Mercado Pago no Firestore:", e.message);
    }
}

// Inicializa o token do Mercado Pago na inicialização
carregarConfiguracoesMercadoPagoFirestore();

// Health check endpoint
app.get('/api/health', async (req, res) => {
    if (!activeAccessToken || activeAccessToken === 'SEU_ACCESS_TOKEN_AQUI') {
        await carregarConfiguracoesMercadoPagoFirestore();
    }
    const waStatus = obterStatusWhatsApp();
    res.json({ 
        status: 'ok', 
        message: 'EMAUS Barbearia Backend Online',
        hasToken: Boolean(activeAccessToken && activeAccessToken !== 'SEU_ACCESS_TOKEN_AQUI'),
        tokenType: activeAccessToken.startsWith('TEST') ? 'TEST' : (activeAccessToken.startsWith('APP_USR') ? 'PROD' : 'UNKNOWN'),
        whatsapp: {
            status: waStatus.status,
            connectedUser: waStatus.userNumber
        }
    });
});

const MP_CLIENT_ID = process.env.MP_CLIENT_ID || '356528958695682';
const MP_CLIENT_SECRET = process.env.MP_CLIENT_SECRET || 'YZXrwo6Ye49ucWHenOGQggjylxUJXjCI';
const MP_REDIRECT_URI = process.env.MP_REDIRECT_URI || 'https://barbearia-app-1bf5.onrender.com/api/auth/mercadopago/callback';

// Retorna URL de autorização OAuth do Mercado Pago (Conectar com 1 Clique)
app.get('/api/auth/mercadopago/url', (req, res) => {
    const authUrl = `https://auth.mercadopago.com/authorization?client_id=${MP_CLIENT_ID}&response_type=code&platform_id=mp&state=emaus_admin&redirect_uri=${encodeURIComponent(MP_REDIRECT_URI)}`;
    return res.json({ url: authUrl });
});

// Callback oficial do Mercado Pago para troca do código por Access Token
app.get('/api/auth/mercadopago/callback', async (req, res) => {
    const { code, state, error, error_description } = req.query;

    if (error || !code) {
        console.error("Erro no retorno do OAuth Mercado Pago:", error, error_description);
        return res.redirect(`https://emaus-barbearia.vercel.app/admin.html?mp_status=erro&msg=${encodeURIComponent(error_description || error || 'Autorizacao cancelada')}`);
    }

    try {
        const postData = JSON.stringify({
            client_id: MP_CLIENT_ID,
            client_secret: MP_CLIENT_SECRET,
            grant_type: 'authorization_code',
            code: code,
            redirect_uri: MP_REDIRECT_URI
        });

        const tokenData = await new Promise((resolve, reject) => {
            const tokenReq = https.request({
                hostname: 'api.mercadopago.com',
                path: '/oauth/token',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(postData)
                }
            }, (tokenRes) => {
                let body = '';
                tokenRes.on('data', chunk => body += chunk);
                tokenRes.on('end', () => {
                    try { resolve(JSON.parse(body)); } catch (e) { resolve(null); }
                });
            });
            tokenReq.on('error', reject);
            tokenReq.write(postData);
            tokenReq.end();
        });

        if (!tokenData || !tokenData.access_token) {
            console.error("Erro ao obter access token no OAuth:", tokenData);
            return res.redirect(`https://emaus-barbearia.vercel.app/admin.html?mp_status=erro&msg=${encodeURIComponent(tokenData?.message || 'Falha ao autenticar com o Mercado Pago')}`);
        }

        // Atualiza memória do servidor
        activeAccessToken = tokenData.access_token;
        client = new MercadoPagoConfig({ accessToken: activeAccessToken, options: { timeout: 10000 } });
        paymentClient = new Payment(client);
        refundClient = new PaymentRefund(client);

        console.log(`✅ [Mercado Pago OAuth] Conta vinculada com sucesso! User ID: ${tokenData.user_id}`);

        // Salva no Firestore
        try {
            const googleToken = await getGoogleAccessToken();
            if (googleToken) {
                const patchData = JSON.stringify({
                    fields: {
                        mpAccessToken: { stringValue: tokenData.access_token },
                        mpUserId: { stringValue: String(tokenData.user_id || '') },
                        mpPublicKey: { stringValue: tokenData.public_key || '' },
                        mpConectadoViaOAuth: { booleanValue: true },
                        atualizadoEm: { timestampValue: new Date().toISOString() }
                    }
                });

                await new Promise((resolve) => {
                    const fsReq = https.request({
                        hostname: 'firestore.googleapis.com',
                        path: `/v1/projects/${serviceAccount.project_id}/databases/(default)/documents/configuracoes/pagamento?updateMask.fieldPaths=mpAccessToken&updateMask.fieldPaths=mpUserId&updateMask.fieldPaths=mpPublicKey&updateMask.fieldPaths=mpConectadoViaOAuth&updateMask.fieldPaths=atualizadoEm`,
                        method: 'PATCH',
                        headers: {
                            'Authorization': `Bearer ${googleToken}`,
                            'Content-Type': 'application/json',
                            'Content-Length': Buffer.byteLength(patchData)
                        }
                    }, (fsRes) => {
                        let d = '';
                        fsRes.on('data', c => d += c);
                        fsRes.on('end', resolve);
                    });
                    fsReq.on('error', resolve);
                    fsReq.write(patchData);
                    fsReq.end();
                });
            }
        } catch (fsErr) {
            console.warn("Aviso ao salvar OAuth no Firestore:", fsErr);
        }

        return res.redirect(`https://emaus-barbearia.vercel.app/admin.html?mp_status=sucesso&user_id=${encodeURIComponent(tokenData.user_id || '')}&token=${encodeURIComponent(tokenData.access_token || '')}&pub_key=${encodeURIComponent(tokenData.public_key || '')}`);

    } catch (err) {
        console.error("Erro no processamento do callback OAuth:", err);
        return res.redirect(`https://emaus-barbearia.vercel.app/admin.html?mp_status=erro&msg=${encodeURIComponent(err.message)}`);
    }
});

// Status da conexão OAuth do Mercado Pago
app.get('/api/auth/mercadopago/status', (req, res) => {
    res.json({
        connected: Boolean(activeAccessToken && activeAccessToken.length > 20 && activeAccessToken !== 'SEU_ACCESS_TOKEN_AQUI'),
        tokenType: activeAccessToken.startsWith('TEST') ? 'TEST' : (activeAccessToken.startsWith('APP_USR') ? 'PROD' : 'NONE'),
        tokenPreview: activeAccessToken && activeAccessToken.length > 10 ? activeAccessToken.slice(0, 10) + '...' : null
    });
});

// Desconecta a conta do Mercado Pago
app.post('/api/auth/mercadopago/desconectar', async (req, res) => {
    try {
        activeAccessToken = '';
        client = new MercadoPagoConfig({ accessToken: 'DUMMY_TOKEN', options: { timeout: 10000 } });
        paymentClient = new Payment(client);
        refundClient = new PaymentRefund(client);

        try {
            const googleToken = await getGoogleAccessToken();
            if (googleToken) {
                const patchData = JSON.stringify({
                    fields: {
                        mpAccessToken: { stringValue: '' },
                        mpUserId: { stringValue: '' },
                        mpPublicKey: { stringValue: '' },
                        mpConectadoViaOAuth: { booleanValue: false },
                        atualizadoEm: { timestampValue: new Date().toISOString() }
                    }
                });

                await new Promise((resolve) => {
                    const fsReq = https.request({
                        hostname: 'firestore.googleapis.com',
                        path: `/v1/projects/${serviceAccount.project_id}/databases/(default)/documents/configuracoes/pagamento?updateMask.fieldPaths=mpAccessToken&updateMask.fieldPaths=mpUserId&updateMask.fieldPaths=mpPublicKey&updateMask.fieldPaths=mpConectadoViaOAuth&updateMask.fieldPaths=atualizadoEm`,
                        method: 'PATCH',
                        headers: {
                            'Authorization': `Bearer ${googleToken}`,
                            'Content-Type': 'application/json',
                            'Content-Length': Buffer.byteLength(patchData)
                        }
                    }, (fsRes) => {
                        let d = '';
                        fsRes.on('data', c => d += c);
                        fsRes.on('end', resolve);
                    });
                    fsReq.on('error', resolve);
                    fsReq.write(patchData);
                    fsReq.end();
                });
            }
        } catch (fsErr) {
            console.warn("Aviso ao limpar Firestore no desconectar:", fsErr);
        }

        return res.json({ success: true, message: 'Mercado Pago desconectado com sucesso.' });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// Endpoint to update or test Mercado Pago token from admin dashboard
app.post('/api/configuracoes/mercadopago', (req, res) => {
    const { accessToken } = req.body;
    if (accessToken && accessToken.trim()) {
        activeAccessToken = accessToken.trim();
        client = new MercadoPagoConfig({ accessToken: activeAccessToken, options: { timeout: 10000 } });
        paymentClient = new Payment(client);
        refundClient = new PaymentRefund(client);
        console.log(`[Config] Access Token atualizado via Admin: ${activeAccessToken.slice(0, 8)}...`);
        return res.json({ success: true, message: 'Token atualizado com sucesso no backend.' });
    }
    return res.status(400).json({ error: 'Token invalido.' });
});

// Endpoint de Teste em tempo real do Token do Mercado Pago
app.post('/api/pagamento/testar-token', async (req, res) => {
    const { accessToken } = req.body;
    const tokenParaTestar = (accessToken && accessToken.trim()) ? accessToken.trim() : activeAccessToken;

    if (!tokenParaTestar || tokenParaTestar === 'SEU_ACCESS_TOKEN_AQUI') {
        return res.status(400).json({ success: false, error: 'Nenhum token fornecido para teste.' });
    }

    try {
        const testClient = new MercadoPagoConfig({ accessToken: tokenParaTestar, options: { timeout: 10000 } });
        const testPayment = new Payment(testClient);

        const resp = await testPayment.create({
            body: {
                transaction_amount: 1.00,
                description: 'Verificacao de Conexao EMAUS Barbearia',
                payment_method_id: 'pix',
                payer: {
                    email: 'cliente.teste.emaus@gmail.com',
                    first_name: 'Cliente',
                    last_name: 'Teste'
                }
            }
        });

        const isTest = tokenParaTestar.startsWith('TEST');
        return res.json({
            success: true,
            ambiente: isTest ? 'Modo Teste (Sandbox)' : 'Produção Real',
            id: resp.id,
            status: resp.status,
            message: `Token válido e funcionando com sucesso em modo ${isTest ? 'Teste (TEST-)' : 'Produção (APP_USR-)'}!`
        });

    } catch (err) {
        console.error("Erro no teste de token Mercado Pago:", err);
        let errorMsg = err.message || 'Erro desconhecido ao validar token com o Mercado Pago.';
        if (errorMsg.includes('Unauthorized use of live credentials')) {
            errorMsg = 'O Mercado Pago recusou o token porque ele é de Produção (APP_USR) e sua conta de desenvolvedor ainda não ativou as credenciais de produção no painel do Mercado Pago. Para testar agora, use o Token de Teste (iniciado em TEST-).';
        }
        return res.status(400).json({
            success: false,
            error: errorMsg,
            details: err.cause || err.api_response || null
        });
    }
});

// Endpoint to create Pix payment
app.post('/api/pagamento/pix', async (req, res) => {
    try {
        const { transaction_amount, description, email, nome, cpf, external_reference } = req.body;

        if (!transaction_amount || transaction_amount <= 0) {
            return res.status(400).json({ error: 'Valor da transacao invalido.' });
        }

        if (!activeAccessToken || activeAccessToken === 'SEU_ACCESS_TOKEN_AQUI') {
            await carregarConfiguracoesMercadoPagoFirestore();
        }

        if (!activeAccessToken || activeAccessToken === 'SEU_ACCESS_TOKEN_AQUI') {
            return res.status(500).json({ 
                error: 'Access Token do Mercado Pago não configurado no servidor. Salve as credenciais no painel admin.' 
            });
        }

        const nameParts = (nome || 'Cliente Barbearia').trim().split(' ');
        const firstName = nameParts[0] || 'Cliente';
        const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : 'Barbearia';

        const paymentData = {
            transaction_amount: Number(parseFloat(transaction_amount).toFixed(2)),
            description: description || 'Taxa de Reserva - EMAUS Barbearia',
            payment_method_id: 'pix',
            external_reference: external_reference ? String(external_reference) : undefined,
            payer: {
                email: email || 'cliente@barbearia.com',
                first_name: firstName,
                last_name: lastName,
                ...(cpf ? { identification: { type: 'CPF', number: cpf.replace(/\D/g, '') } } : {})
            }
        };

        const response = await paymentClient.create({ body: paymentData });

        const transactionData = response.point_of_interaction?.transaction_data;

        return res.status(201).json({
            id: response.id,
            status: response.status,
            status_detail: response.status_detail,
            qr_code: transactionData?.qr_code || '',
            qr_code_base64: transactionData?.qr_code_base64 || '',
            ticket_url: transactionData?.ticket_url || '',
            date_of_expiration: response.date_of_expiration
        });
    } catch (error) {
        console.error('Erro ao criar pagamento Pix:', error);
        let userMessage = error.message || 'Erro ao processar pagamento Pix no Mercado Pago.';
        if (userMessage.includes('Unauthorized use of live credentials')) {
            userMessage = 'O Mercado Pago recusou o token de produção (APP_USR). Ative suas credenciais de produção no painel do Mercado Pago Developers ou use o Token de Teste (iniciado em TEST-).';
        }
        return res.status(500).json({ 
            error: userMessage,
            details: error.cause || error.api_response || null
        });
    }
});

// Endpoint to process Credit Card payment
app.post('/api/pagamento/cartao', async (req, res) => {
    try {
        const { token, issuer_id, payment_method_id, transaction_amount, installments, description, email, cpf } = req.body;

        if (!token || !transaction_amount || !payment_method_id) {
            return res.status(400).json({ error: 'Dados incompletos para pagamento com cartao.' });
        }

        if (!activeAccessToken || activeAccessToken === 'SEU_ACCESS_TOKEN_AQUI') {
            await carregarConfiguracoesMercadoPagoFirestore();
        }

        if (!activeAccessToken || activeAccessToken === 'SEU_ACCESS_TOKEN_AQUI') {
            return res.status(500).json({ 
                error: 'Access Token do Mercado Pago não configurado no servidor. Salve as credenciais no painel admin.' 
            });
        }

        const paymentData = {
            token,
            issuer_id: issuer_id ? String(issuer_id) : undefined,
            payment_method_id,
            transaction_amount: Number(parseFloat(transaction_amount).toFixed(2)),
            installments: Number(installments) || 1,
            description: description || 'Agendamento - EMAUS Barbearia',
            payer: {
                email: email || 'cliente@barbearia.com',
                ...(cpf ? { identification: { type: 'CPF', number: cpf.replace(/\D/g, '') } } : {})
            }
        };

        const response = await paymentClient.create({ body: paymentData });

        return res.status(200).json({
            id: response.id,
            status: response.status,
            status_detail: response.status_detail
        });
    } catch (error) {
        console.error('Erro ao processar cartao:', error);
        return res.status(500).json({ 
            error: error.message || 'Erro ao processar pagamento com cartao.' 
        });
    }
});

// Endpoint to check payment status in real-time
app.get('/api/pagamento/status/:id', async (req, res) => {
    try {
        const { id } = req.params;
        if (!id) return res.status(400).json({ error: 'ID do pagamento obrigatorio.' });

        const response = await paymentClient.get({ id });
        return res.json({
            id: response.id,
            status: response.status,
            status_detail: response.status_detail,
            date_approved: response.date_approved
        });
    } catch (error) {
        console.error(`Erro ao consultar pagamento ${req.params.id}:`, error);
        return res.status(500).json({ error: error.message || 'Erro ao consultar status.' });
    }
});

// Endpoint to process automatic refund (Devolução Pix ou Estorno Cartão)
app.post('/api/pagamento/estorno', async (req, res) => {
    try {
        const { paymentId, amount, reason } = req.body;

        if (!paymentId) {
            return res.status(400).json({ success: false, error: 'ID do pagamento obrigatório para estorno.' });
        }

        if (!activeAccessToken || activeAccessToken === 'SEU_ACCESS_TOKEN_AQUI') {
            await carregarConfiguracoesMercadoPagoFirestore();
        }

        if (!activeAccessToken || activeAccessToken === 'SEU_ACCESS_TOKEN_AQUI') {
            return res.status(500).json({ 
                success: false, 
                error: 'Token do Mercado Pago não configurado no servidor. Salve as credenciais no painel admin.' 
            });
        }

        console.log(`[Estorno] Solicitando estorno para o pagamento ${paymentId}. Motivo: ${reason || 'Cancelamento de agendamento'}`);

        let refundResult = null;

        // Try using PaymentRefund SDK
        try {
            if (amount && Number(amount) > 0) {
                refundResult = await refundClient.create({
                    payment_id: paymentId,
                    body: { amount: Number(parseFloat(amount).toFixed(2)) }
                });
            } else {
                refundResult = await refundClient.total({ payment_id: paymentId });
            }
        } catch (sdkErr) {
            console.warn('[Estorno SDK Falhou, tentando via REST API]:', sdkErr.message);
            // Fallback to direct REST API
            const restRes = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}/refunds`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${activeAccessToken}`,
                    'Content-Type': 'application/json',
                    'X-Idempotency-Key': `refund_${paymentId}_${Date.now()}`
                },
                body: (amount && Number(amount) > 0) ? JSON.stringify({ amount: Number(parseFloat(amount).toFixed(2)) }) : JSON.stringify({})
            });
            const restData = await restRes.json();
            if (!restRes.ok) {
                throw new Error(restData.message || restData.error || 'Falha ao estornar no Mercado Pago');
            }
            refundResult = restData;
        }

        console.log(`[Estorno Sucesso] Pagamento ${paymentId} estornado:`, refundResult?.status || 'Aprovado');

        return res.json({
            success: true,
            status: refundResult?.status || 'approved',
            refundId: refundResult?.id,
            amount: refundResult?.amount || amount,
            message: 'Estorno realizado com sucesso no Mercado Pago!'
        });

    } catch (error) {
        console.error('Erro ao processar estorno no Mercado Pago:', error);
        return res.status(500).json({
            success: false,
            error: error.message || 'Erro ao processar estorno no Mercado Pago.'
        });
    }
});

// Webhook endpoint to receive instant notifications from Mercado Pago
app.post('/api/webhook', async (req, res) => {
    try {
        const topic = req.query.topic || req.body?.type;
        const paymentId = req.query.id || req.body?.data?.id;

        if (paymentId && (topic === 'payment' || req.body?.action?.includes('payment'))) {
            const response = await paymentClient.get({ id: paymentId });
            console.log(`[Webhook] Pagamento ${paymentId} status: ${response.status} (${response.status_detail})`);
            
            // Webhook received and validated
            return res.status(200).json({ received: true, status: response.status, id: paymentId });
        }

        return res.status(200).json({ received: true });
    } catch (error) {
        console.error('Erro no processamento do webhook:', error);
        return res.status(200).json({ received: true, error: error.message });
    }
});

// ==========================================
// ROTAS DE AUTOMAÇÃO DO WHATSAPP (BOT)
// ==========================================

// Retorna status atual da conexão e QR Code se disponível
app.get('/api/whatsapp/status', (req, res) => {
    const statusInfo = obterStatusWhatsApp();
    return res.json(statusInfo);
});

// Inicia ou reinicia conexão para gerar QR Code
app.post('/api/whatsapp/conectar', async (req, res) => {
    try {
        const waStatus = obterStatusWhatsApp();
        const force = waStatus.status !== 'connected';
        const result = await iniciarWhatsApp(force);
        return res.json({ success: true, ...result });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// Desconecta a sessão do WhatsApp
app.post('/api/whatsapp/desconectar', async (req, res) => {
    try {
        const result = await desconectarWhatsApp();
        return res.json(result);
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// Envio de mensagem direta de texto
app.post('/api/whatsapp/enviar', async (req, res) => {
    const { numero, mensagem } = req.body;
    if (!numero || !mensagem) {
        return res.status(400).json({ error: 'Numero e mensagem sao obrigatorios.' });
    }
    const result = await enviarMensagemWhatsApp(numero, mensagem);
    return res.json(result);
});

// Notificação automática de novo agendamento (Barbeiro + Cliente)
app.post('/api/whatsapp/notificar-agendamento', async (req, res) => {
    try {
        const { 
            cliente, 
            telefone, 
            servico, 
            dataHora, 
            preco, 
            taxaReservaPaga, 
            modalidade,
            isPlano, 
            semanaPlano,
            whatsappBarbeiro 
        } = req.body;

        const dataFormatada = dataHora ? dataHora.replace('T', ' às ') : 'Data a confirmar';
        const numBarbeiro = whatsappBarbeiro || '5511953789095';

        const precoTotal = Number(preco || 0);
        const valorPago = Number(taxaReservaPaga !== undefined ? taxaReservaPaga : (isPlano ? 0 : 10));
        const valorRestante = Math.max(0, precoTotal - valorPago);

        // 1. Mensagem para o Barbeiro
        let tipoPagtoTexto = `Taxa de Reserva Paga (R$ ${valorPago.toFixed(2)})`;
        let restanteBarbeiroTexto = `R$ ${valorRestante.toFixed(2)}`;

        if (isPlano) {
            tipoPagtoTexto = `Assinatura VIP (Semana ${semanaPlano || '1'})`;
            restanteBarbeiroTexto = "R$ 0,00 (Plano VIP - Isento)";
        } else if (modalidade === 'total' || valorRestante === 0) {
            tipoPagtoTexto = `Valor Integral Pago Online (R$ ${valorPago.toFixed(2)})`;
            restanteBarbeiroTexto = "R$ 0,00 (Totalmente Quitado)";
        }

        const msgBarbeiro = `*EMAÚS Barbearia - Novo Agendamento* 📅\n\n` +
            `• *Cliente:* ${cliente || 'Cliente'}\n` +
            `• *Telefone:* ${telefone || 'Não informado'}\n` +
            `• *Serviço:* ${servico || 'Corte'} (Total R$ ${precoTotal.toFixed(2)})\n` +
            `• *Data/Hora:* ${dataFormatada}\n` +
            `• *Pagamento Online:* ${tipoPagtoTexto}\n` +
            `• *Restante a Receber no Atendimento:* ${restanteBarbeiroTexto}`;

        const envioBarbeiro = await enviarMensagemWhatsApp(numBarbeiro, msgBarbeiro);

        // 2. Mensagem de Confirmação para o Cliente (se tiver telefone)
        let envioCliente = null;
        if (telefone) {
            let saldoClienteTexto = "";
            if (isPlano) {
                saldoClienteTexto = `• *Plano VIP:* Corte incluso no pacote (R$ 0,00 restante)\n`;
            } else if (modalidade === 'total' || valorRestante === 0) {
                saldoClienteTexto = `• *Pagamento:* Totalmente Quitado Online (R$ 0,00 restante)\n`;
            } else {
                saldoClienteTexto = `• *Valor Total:* R$ ${precoTotal.toFixed(2)}\n` +
                    `• *Taxa de Reserva Paga:* R$ ${valorPago.toFixed(2)}\n` +
                    `• *Restante a Pagar no Atendimento:* R$ ${valorRestante.toFixed(2)}\n`;
            }

            const msgCliente = `*EMAÚS Barbearia - Confirmação de Agendamento* ✂️\n\n` +
                `Olá, *${cliente || 'Cliente'}*!\n` +
                `Seu agendamento foi confirmado com sucesso.\n\n` +
                `• *Serviço:* ${servico || 'Corte'}\n` +
                `• *Data e Horário:* ${dataFormatada}\n` +
                saldoClienteTexto +
                `• *Local:* EMAÚS Barbearia\n\n` +
                `Agradecemos a preferência. Solicitamos a gentileza de comparecer com alguns minutos de antecedência.\n\n` +
                `Te esperamos! 💈\n` +
                `_EMAÚS Barbearia • Estilo e Tradição_`;

            envioCliente = await enviarMensagemWhatsApp(telefone, msgCliente);
        }

        return res.json({
            success: true,
            barbeiro: envioBarbeiro,
            cliente: envioCliente
        });

    } catch (err) {
        console.error('Erro na rota notificar-agendamento:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// Notificação de aviso de expiração de corte semanal para assinantes VIP
app.post('/api/whatsapp/lembrete-expiracao-plano', async (req, res) => {
    try {
        const { cliente, telefone, nomePlano, semanaNumero, diasRestantesSemana, dataLimiteSemana } = req.body;
        if (!telefone) {
            return res.status(400).json({ success: false, error: 'Telefone do cliente é obrigatório.' });
        }

        const msgLembrete = `*EMAÚS Barbearia - Aviso de Crédito VIP*\n\n` +
            `Olá, *${cliente || 'Cliente'}*! 👑\n\n` +
            `Identificamos que você possui *1 atendimento disponível* da *Semana ${semanaNumero || 'atual'}* no seu plano *${nomePlano || 'Mensal VIP'}*.\n\n` +
            `⚠️ *Atenção:* O crédito desta semana expira em *${dataLimiteSemana || 'breve'}* (${diasRestantesSemana || 'poucos'} dias restantes) e não acumula para a próxima semana.\n\n` +
            `Agende seu horário agora mesmo pelo nosso site para garantir o seu atendimento:\n` +
            `👉 https://emaus-barbearia.vercel.app\n\n` +
            `_EMAÚS Barbearia • Estilo e Alta Performance_`;

        const resultado = await enviarMensagemWhatsApp(telefone, msgLembrete);
        return res.json({ success: true, resultado });
    } catch (err) {
        console.error('Erro na rota lembrete-expiracao-plano:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// Disparo em lote de lembretes para múltiplos clientes com crédito expirando
app.post('/api/whatsapp/disparar-lembretes-expiracao-lote', async (req, res) => {
    try {
        const { listaClientes } = req.body;
        if (!Array.isArray(listaClientes) || listaClientes.length === 0) {
            return res.status(400).json({ success: false, error: 'Lista de clientes vazia ou inválida.' });
        }

        const resultados = [];
        for (const item of listaClientes) {
            if (!item.telefone) continue;
            const msgLembrete = `*EMAÚS Barbearia - Aviso de Crédito VIP*\n\n` +
                `Olá, *${item.cliente || 'Cliente'}*! 👑\n\n` +
                `Lembramos que o seu corte da *Semana ${item.semanaNumero || 'atual'}* do plano *${item.nomePlano || 'Mensal VIP'}* está *disponível* e expira em *${item.dataLimiteSemana || 'breve'}*.\n\n` +
                `Garanta o seu horário no link abaixo para não perder seu crédito semanal:\n` +
                `👉 https://emaus-barbearia.vercel.app\n\n` +
                `_EMAÚS Barbearia_`;

            try {
                const envio = await enviarMensagemWhatsApp(item.telefone, msgLembrete);
                resultados.push({ cliente: item.cliente, telefone: item.telefone, enviado: envio.success });
            } catch (errEnvio) {
                resultados.push({ cliente: item.cliente, telefone: item.telefone, enviado: false, error: errEnvio.message });
            }
        }

        return res.json({ success: true, total: listaClientes.length, resultados });
    } catch (err) {
        console.error('Erro na rota disparar-lembretes-expiracao-lote:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// Notificação Instantânea de Cancelamento de Agendamento (Barbeiro + Cliente)
app.post('/api/whatsapp/notificar-cancelamento', async (req, res) => {
    try {
        const {
            cliente,
            telefone,
            servico,
            dataHora,
            motivo,
            canceladoPor,
            estornoRealizado,
            valorEstornado,
            isPlano,
            whatsappBarbeiro
        } = req.body;

        const dataFormatada = dataHora ? dataHora.replace('T', ' às ') : 'Data não informada';
        const numBarbeiro = whatsappBarbeiro || '5511953789095';

        // 1. Mensagem para o Barbeiro
        let statusEstornoTexto = "Sem estorno (Cancelamento fora do prazo de 3h)";
        if (isPlano) {
            statusEstornoTexto = "Plano VIP (Crédito semanal restaurado)";
        } else if (estornoRealizado) {
            statusEstornoTexto = `Estorno de R$ ${Number(valorEstornado || 0).toFixed(2)} efetuado via Mercado Pago`;
        }

        const msgBarbeiro = `*EMAÚS Barbearia - Cancelamento de Horário* 🚫\n\n` +
            `• *Cliente:* ${cliente || 'Cliente'}\n` +
            `• *Telefone:* ${telefone || 'Não informado'}\n` +
            `• *Serviço:* ${servico || 'Corte'}\n` +
            `• *Data/Hora:* ${dataFormatada}\n` +
            `• *Cancelado por:* ${canceladoPor === 'barbeiro' ? 'Barbeiro / Estabelecimento' : 'Cliente'}\n` +
            `• *Status:* ${statusEstornoTexto}`;

        const envioBarbeiro = await enviarMensagemWhatsApp(numBarbeiro, msgBarbeiro);

        // 2. Mensagem para o Cliente (se tiver telefone)
        let envioCliente = null;
        if (telefone) {
            let msgCliente = `*EMAÚS Barbearia - Cancelamento de Horário* ⚠️\n\n` +
                `Olá, *${cliente || 'Cliente'}*.\n` +
                `Informamos que o seu agendamento para *${servico || 'Corte'}* marcado para *${dataFormatada}* foi cancelado.\n\n`;

            if (isPlano) {
                msgCliente += `👑 *Plano VIP:* O crédito do seu corte semanal já está disponível para você reagendar quando desejar.\n\n`;
            } else if (estornoRealizado) {
                msgCliente += `💸 *Estorno:* A devolução de R$ ${Number(valorEstornado || 0).toFixed(2)} foi processada com sucesso.\n\n`;
            }

            msgCliente += `Caso deseje agendar um novo horário, acesse nosso site:\n` +
                `👉 https://emaus-barbearia.vercel.app\n\n` +
                `_EMAÚS Barbearia_`;

            envioCliente = await enviarMensagemWhatsApp(telefone, msgCliente);
        }

        return res.json({ success: true, barbeiro: envioBarbeiro, cliente: envioCliente });
    } catch (err) {
        console.error('Erro na rota notificar-cancelamento:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// Notificação Instantânea de Compra de Pacote Mensal VIP (Barbeiro + Cliente)
app.post('/api/whatsapp/notificar-compra-plano', async (req, res) => {
    try {
        const { cliente, telefone, nomePlano, preco, dataFim, whatsappBarbeiro } = req.body;
        const numBarbeiro = whatsappBarbeiro || '5511953789095';

        // 1. Mensagem para o Barbeiro
        const msgBarbeiro = `*EMAÚS Barbearia - Nova Assinatura VIP!* 👑\n\n` +
            `Temos um novo cliente mensalista cadastrado:\n\n` +
            `• *Cliente:* ${cliente || 'Cliente'}\n` +
            `• *Telefone:* ${telefone || 'Não informado'}\n` +
            `• *Plano:* ${nomePlano || 'Pacote Mensal'}\n` +
            `• *Valor Pago:* R$ ${Number(preco || 0).toFixed(2)}\n` +
            `• *Validade:* 30 dias (4 atendimentos)`;

        const envioBarbeiro = await enviarMensagemWhatsApp(numBarbeiro, msgBarbeiro);

        // 2. Mensagem de Boas-Vindas para o Cliente VIP
        let envioCliente = null;
        if (telefone) {
            const msgCliente = `*EMAÚS Barbearia - Assinatura VIP Confirmada!* 👑\n\n` +
                `Parabéns, *${cliente || 'Cliente'}*! Sua assinatura do plano *${nomePlano || 'Mensal VIP'}* foi ativada com sucesso.\n\n` +
                `• *Duração:* 30 dias\n` +
                `• *Benefício:* 4 cortes (1 corte exclusivo por semana)\n` +
                `• *Seu corte da Semana 1 já está disponível para agendamento gratuito!*\n\n` +
                `Agende seus atendimentos diretamente no nosso site:\n` +
                `👉 https://emaus-barbearia.vercel.app\n\n` +
                `_EMAÚS Barbearia • Estilo e Alta Performance_`;

            envioCliente = await enviarMensagemWhatsApp(telefone, msgCliente);
        }

        return res.json({ success: true, barbeiro: envioBarbeiro, cliente: envioCliente });
    } catch (err) {
        console.error('Erro na rota notificar-compra-plano:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// Rota para disparar checagem e envio de lembretes 4h antes (pode ser chamada por Cron ou manualmente)
app.all('/api/whatsapp/disparar-lembretes-4h', async (req, res) => {
    try {
        const resultado = await verificarLembretes4hAgenda();
        return res.json(resultado);
    } catch (err) {
        console.error('Erro ao disparar lembretes 4h:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

const isMain = process.argv[1] && (process.argv[1].replace(/\\/g, '/').endsWith('server.js') || process.argv[1].replace(/\\/g, '/').endsWith('server/src/server.js'));

if (isMain && !process.env.VERCEL) {
    try {
        app.listen(port, '0.0.0.0', () => {
            console.log(`🚀 Servidor EMAÚS Barbearia rodando em 0.0.0.0:${port}`);
            
            // Inicia checagem periódica de lembretes 4h da agenda a cada 5 minutos
            setInterval(() => {
                verificarLembretes4hAgenda().catch(e => console.warn("Aviso cron 4h:", e.message));
            }, 5 * 60 * 1000);

            // Executa uma checagem inicial 30 segundos após ligar
            setTimeout(() => {
                verificarLembretes4hAgenda().catch(e => console.warn("Aviso checagem inicial 4h:", e.message));
            }, 30000);
        });
    } catch (e) {
        console.warn("Aviso servidor:", e.message);
    }
}

export default app;
