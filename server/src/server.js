import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { MercadoPagoConfig, Payment, PaymentRefund } from 'mercadopago';
import { 
    iniciarWhatsApp, 
    obterStatusWhatsApp, 
    desconectarWhatsApp, 
    enviarMensagemWhatsApp,
    gerarCodigoPareamentoWhatsApp,
    setFirestoreDatabase
} from './whatsappService.js';

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import https from 'https';
import { fileURLToPath } from 'url';

process.on('uncaughtException', (err) => {
    console.error('⚠️ [UncaughtException capturado]:', err?.message || err);
});
process.on('unhandledRejection', (reason) => {
    console.error('⚠️ [UnhandledRejection capturado]:', reason?.message || reason);
});

import serviceAccount from './firebaseServiceAccount.js';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

let firebaseAdminApp = null;
let firebaseAdminAuth = null;
let firebaseAdminFirestore = null;

if (serviceAccount && serviceAccount.private_key) {
    try {
        firebaseAdminApp = getApps().length ? getApps()[0] : initializeApp({
            credential: cert(serviceAccount)
        });
        firebaseAdminAuth = getAuth(firebaseAdminApp);
        firebaseAdminFirestore = getFirestore(firebaseAdminApp);
        setFirestoreDatabase(firebaseAdminFirestore);
        console.log('✅ [Firebase Admin SDK & Firestore] Inicializado com sucesso!');
    } catch (e) {
        console.warn('Aviso na inicialização do Firebase Admin SDK:', e.message);
    }
}

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
app.set('trust proxy', 1);
const port = process.env.PORT || 3000;
const APP_SITE_URL = process.env.APP_SITE_URL || 'https://agendamento-barbearia-e8ffb.web.app';
const SELF_URL = process.env.SELF_URL || 'https://barbearia-app-1bf5.onrender.com';

// B3: Headers de segurança via helmet (desativa content-security-policy para não bloquear o CDN do Tailwind)
app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
}));

// A3: CORS restrito e estrito exclusivamente às origens legítimas do projeto
const ALLOWED_ORIGINS = [
    APP_SITE_URL,
    'https://agendamento-barbearia-e8ffb.web.app',
    'https://agendamento-barbearia-e8ffb.firebaseapp.com',
    'https://emaus-barbearia.vercel.app',
    'https://barbearia-app-1bf5.onrender.com',
    'http://localhost:3000',
    'http://localhost:5000',
    'http://localhost:5173',
    'http://localhost:5500',
    'http://localhost:8080',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:5000',
    'http://127.0.0.1:5500',
    'http://127.0.0.1:8080',
    SELF_URL
].filter(Boolean);

app.use(cors({
    origin: (origin, callback) => {
        // Permite requisições sem origem (ex: chamadas internas do servidor, webhooks Mercado Pago, cron jobs)
        if (!origin) return callback(null, true);
        
        // Verifica se a origem está rigorosamente na lista explícita de domínios autorizados
        if (ALLOWED_ORIGINS.includes(origin)) {
            return callback(null, true);
        }
        
        console.warn(`[CORS Bloqueado] Origem não autorizada: ${origin}`);
        callback(new Error(`CORS: Origem não autorizada: ${origin}`));
    },
    credentials: true
}));
app.use(express.json());

// M1: Rate limiting — protege endpoints com limites dimensionados para produção e SPAs em tempo real
const limiterGeral = rateLimit({ 
    windowMs: 60 * 1000, 
    max: 300, 
    standardHeaders: true, 
    legacyHeaders: false, 
    message: { error: 'Muitas requisições. Aguarde 1 minuto.' } 
});

const limiterPagamentoCriacao = rateLimit({ 
    windowMs: 60 * 1000, 
    max: 60, 
    standardHeaders: true, 
    legacyHeaders: false, 
    message: { error: 'Muitas tentativas de pagamento. Aguarde 1 minuto.' } 
});

const limiterEstorno = rateLimit({ 
    windowMs: 60 * 1000, 
    max: 60, 
    standardHeaders: true, 
    legacyHeaders: false, 
    message: { error: 'Muitas solicitações de estorno. Aguarde 1 minuto.' } 
});

const limiterAuth = rateLimit({ 
    windowMs: 15 * 60 * 1000, 
    max: 20, 
    standardHeaders: true, 
    legacyHeaders: false, 
    message: { error: 'Muitas tentativas de recuperação de senha. Tente novamente em 15 minutos.' } 
});

const limiterWhatsApp = rateLimit({ 
    windowMs: 60 * 1000, 
    max: 120, 
    standardHeaders: true, 
    legacyHeaders: false, 
    message: { error: 'Muitas requisições ao WhatsApp. Aguarde 1 minuto.' } 
});

app.use('/api/', limiterGeral);
app.use('/api/pagamento/pix', limiterPagamentoCriacao);
app.use('/api/pagamento/cartao', limiterPagamentoCriacao);
app.use('/api/pagamento/estorno', limiterEstorno);
app.use('/api/mercadopago/reembolsar-pagamento', limiterEstorno);
app.use('/api/auth/recuperar-senha', limiterAuth);
app.use('/api/whatsapp/', limiterWhatsApp);

// Lista de e-mails autorizados como Administradores do sistema
const ADMIN_EMAILS = [
    'aldo540@outlook.com',
    'rafaelcassu@hotmail.com',
    'cassurafael30@gmail.com',
    'admin@emausbarbearia.com'
];

let publicCertsCache = null;
let publicCertsExpiry = 0;

// Busca e armazena em cache as chaves públicas oficiais do Firebase Auth (Google x509)
async function getFirebasePublicCerts() {
    const now = Date.now();
    if (publicCertsCache && now < publicCertsExpiry) {
        return publicCertsCache;
    }
    return new Promise((resolve) => {
        https.get('https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com', (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    publicCertsCache = JSON.parse(data);
                    publicCertsExpiry = now + 60 * 60 * 1000; // Cache por 1 hora
                    resolve(publicCertsCache);
                } catch (e) { resolve(null); }
            });
        }).on('error', () => resolve(null));
    });
}

// Validador criptográfico de ID Tokens do Firebase Authentication (Oficial Firebase Admin SDK)
async function validarTokenFirebaseAdmin(idToken) {
    if (!idToken || typeof idToken !== 'string') return null;
    
    // 1. Verificação Primária via Firebase Admin SDK oficial
    try {
        if (!firebaseAdminAuth && firebaseAdminApp) {
            firebaseAdminAuth = getAuth(firebaseAdminApp);
        }
        if (firebaseAdminAuth) {
            const decoded = await firebaseAdminAuth.verifyIdToken(idToken);
            return decoded;
        }
    } catch (errAdmin) {
        console.warn('[Firebase Admin SDK] Aviso na validação do token:', errAdmin.message);
    }

    // 2. Fallback de alta disponibilidade via validação nativa RS256 x509 Google
    try {
        const parts = idToken.split('.');
        if (parts.length !== 3) return null;

        const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));

        const now = Math.floor(Date.now() / 1000);
        if (payload.exp && payload.exp < now) return null;
        if (payload.iss !== 'https://securetoken.google.com/agendamento-barbearia-e8ffb') return null;
        if (payload.aud !== 'agendamento-barbearia-e8ffb') return null;

        const certs = await getFirebasePublicCerts();
        if (!certs || !certs[header.kid]) return null;

        const publicKey = certs[header.kid];
        const verifier = crypto.createVerify('RSA-SHA256');
        verifier.update(`${parts[0]}.${parts[1]}`);
        const isValid = verifier.verify(publicKey, parts[2], 'base64url');

        return isValid ? payload : null;
    } catch (e) {
        console.warn('[Auth] Erro no fallback de validação:', e.message);
        return null;
    }
}

// Middleware de Proteção de Rotas Administrativas
async function verificarAdminMiddleware(req, res, next) {
    try {
        const authHeader = req.headers['authorization'] || '';
        const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;

        if (!token) {
            return res.status(401).json({
                success: false,
                error: 'Acesso negado. Token de autorização não fornecido.'
            });
        }

        const decoded = await validarTokenFirebaseAdmin(token);
        if (!decoded || !decoded.email) {
            return res.status(403).json({
                success: false,
                error: 'Acesso negado. Token de administrador inválido ou expirado.'
            });
        }

        const emailLower = decoded.email.toLowerCase().trim();
        if (!ADMIN_EMAILS.includes(emailLower)) {
            console.warn(`[Segurança] Tentativa de acesso não autorizado por: ${emailLower}`);
            return res.status(403).json({
                success: false,
                error: 'Acesso restrito. Este usuário não possui privilégios de Administrador.'
            });
        }

        req.adminUser = decoded;
        next();
    } catch (err) {
        console.error('Erro no middleware de autenticação admin:', err);
        return res.status(500).json({ success: false, error: 'Erro interno ao validar credenciais.' });
    }
}

// Middleware para Estorno: Permite Admin OU Cliente Autenticado no Firebase
async function verificarAuthEstornoMiddleware(req, res, next) {
    try {
        const authHeader = req.headers['authorization'] || '';
        const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;

        if (!token) {
            return res.status(401).json({
                success: false,
                error: 'Acesso negado. Token de autenticação não fornecido para processar estorno.'
            });
        }

        const decoded = await validarTokenFirebaseAdmin(token);
        if (!decoded || !decoded.email) {
            return res.status(403).json({
                success: false,
                error: 'Acesso negado. Token de autenticação inválido ou expirado.'
            });
        }

        req.authUser = decoded;
        req.ehAdmin = ADMIN_EMAILS.includes(decoded.email.toLowerCase().trim());
        next();
    } catch (err) {
        console.error('Erro na validação de estorno:', err);
        return res.status(500).json({ success: false, error: 'Erro interno ao validar autenticação.' });
    }
}

// Rota raiz para verificação imediata de uptime no Render e UptimeRobot
app.get('/', (req, res) => {
    const waStatus = obterStatusWhatsApp();
    res.json({
        status: 'online',
        service: 'EMAÚS Barbearia - WhatsApp Bot (Firestore 24/7)',
        uptime: `${Math.floor(process.uptime())}s`,
        timestamp: new Date().toISOString(),
        whatsapp: {
            status: waStatus.status,
            connectedUser: waStatus.userNumber
        }
    });
});

app.get('/health', async (req, res) => {
    const waStatus = await obterStatusWhatsApp();
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

    // Keep-alive interno para manter o Render acordado 24/7 (URL configurável via SELF_URL)
    setInterval(() => {
        https.get(`${SELF_URL}/health`, () => {}).on('error', () => {});
    }, 10 * 60 * 1000);
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
        const directLink = `${APP_SITE_URL}/redefinir-senha.html?oobCode=${oobCode}`;

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

        // 1. Tenta carregar do documento protegido configuracoes/pagamento_privado
        let data = await new Promise((resolve) => {
            const req = https.request({
                hostname: 'firestore.googleapis.com',
                path: `/v1/projects/${serviceAccount.project_id}/databases/(default)/documents/configuracoes/pagamento_privado`,
                method: 'GET',
                headers: { 'Authorization': `Bearer ${token}` }
            }, (res) => {
                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () => {
                    try { resolve(JSON.parse(body)); } catch(e) { resolve(null); }
                });
            });
            req.on('error', () => resolve(null));
            req.end();
        });

        // 2. Fallback de migração caso ainda esteja no documento antigo
        if (!data || !data.fields || !data.fields.mpAccessToken) {
            data = await new Promise((resolve) => {
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
                req.on('error', () => resolve(null));
                req.end();
            });
        }

        if (data && data.fields && data.fields.mpAccessToken && data.fields.mpAccessToken.stringValue) {
            const tokenMp = data.fields.mpAccessToken.stringValue.trim();
            if (tokenMp && tokenMp !== 'SEU_ACCESS_TOKEN_AQUI' && tokenMp.length > 20) {
                activeAccessToken = tokenMp;
                client = new MercadoPagoConfig({ accessToken: activeAccessToken, options: { timeout: 10000 } });
                paymentClient = new Payment(client);
                refundClient = new PaymentRefund(client);
                console.log(`💳 [Mercado Pago] Token sincronizado com sucesso de pagamento_privado: ${activeAccessToken.slice(0, 10)}...`);
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

const MP_CLIENT_ID = process.env.MP_CLIENT_ID || '';
const MP_CLIENT_SECRET = process.env.MP_CLIENT_SECRET || '';
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
        return res.redirect(`${APP_SITE_URL}/admin.html?mp_status=erro&msg=${encodeURIComponent(error_description || error || 'Autorizacao cancelada')}`);
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
            return res.redirect(`${APP_SITE_URL}/admin.html?mp_status=erro&msg=${encodeURIComponent(tokenData?.message || 'Falha ao autenticar com o Mercado Pago')}`);
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
                        path: `/v1/projects/${serviceAccount.project_id}/databases/(default)/documents/configuracoes/pagamento_privado?updateMask.fieldPaths=mpAccessToken&updateMask.fieldPaths=mpUserId&updateMask.fieldPaths=mpPublicKey&updateMask.fieldPaths=mpConectadoViaOAuth&updateMask.fieldPaths=atualizadoEm`,
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

        return res.redirect(`${APP_SITE_URL}/admin.html?mp_status=sucesso`);

    } catch (err) {
        console.error("Erro no processamento do callback OAuth:", err);
        return res.redirect(`${APP_SITE_URL}/admin.html?mp_status=erro&msg=${encodeURIComponent(err.message)}`);
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
app.post('/api/auth/mercadopago/desconectar', verificarAdminMiddleware, async (req, res) => {
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

                // Limpa documento privado
                await new Promise((resolve) => {
                    const fsReq = https.request({
                        hostname: 'firestore.googleapis.com',
                        path: `/v1/projects/${serviceAccount.project_id}/databases/(default)/documents/configuracoes/pagamento_privado?updateMask.fieldPaths=mpAccessToken&updateMask.fieldPaths=mpUserId&updateMask.fieldPaths=mpPublicKey&updateMask.fieldPaths=mpConectadoViaOAuth&updateMask.fieldPaths=atualizadoEm`,
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

                // Limpa também documento público
                await new Promise((resolve) => {
                    const fsReq = https.request({
                        hostname: 'firestore.googleapis.com',
                        path: `/v1/projects/${serviceAccount.project_id}/databases/(default)/documents/configuracoes/pagamento?updateMask.fieldPaths=mpAccessToken`,
                        method: 'PATCH',
                        headers: {
                            'Authorization': `Bearer ${googleToken}`,
                            'Content-Type': 'application/json',
                            'Content-Length': Buffer.byteLength(JSON.stringify({ fields: { mpAccessToken: { stringValue: '' } } }))
                        }
                    }, (fsRes) => {
                        let d = '';
                        fsRes.on('data', c => d += c);
                        fsRes.on('end', resolve);
                    });
                    fsReq.on('error', resolve);
                    fsReq.write(JSON.stringify({ fields: { mpAccessToken: { stringValue: '' } } }));
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
app.post('/api/configuracoes/mercadopago', verificarAdminMiddleware, (req, res) => {
    const { accessToken } = req.body;
    if (accessToken && accessToken.trim()) {
        activeAccessToken = accessToken.trim();
        client = new MercadoPagoConfig({ accessToken: activeAccessToken, options: { timeout: 10000 } });
        paymentClient = new Payment(client);
        refundClient = new PaymentRefund(client);
        console.log(`[Config] Access Token atualizado via Admin: ${activeAccessToken.slice(0, 10)}...`);
        return res.json({ success: true, message: 'Token atualizado com sucesso no backend.' });
    }
    return res.status(400).json({ error: 'Token invalido.' });
});

// Endpoint de Teste em tempo real do Token do Mercado Pago
app.post(['/api/pagamento/testar-token', '/api/configuracoes/mercadopago/testar'], verificarAdminMiddleware, async (req, res) => {
    const { accessToken } = req.body;
    let tokenParaTestar = (accessToken && accessToken.trim()) ? accessToken.trim() : activeAccessToken;

    if (!tokenParaTestar || tokenParaTestar === 'SEU_ACCESS_TOKEN_AQUI') {
        await carregarConfiguracoesMercadoPagoFirestore();
        tokenParaTestar = activeAccessToken;
    }

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

// Endpoint to process Card (Credit or Debit) payment
app.post('/api/pagamento/cartao', async (req, res) => {
    try {
        let { token, cardNumber, cardholderName, cardExpirationMonth, cardExpirationYear, securityCode, issuer_id, payment_method_id, transaction_amount, installments, description, email, cpf, tipoCartao } = req.body;

        if (!transaction_amount || transaction_amount <= 0) {
            return res.status(400).json({ error: 'Valor da transação inválido.' });
        }

        if (!activeAccessToken || activeAccessToken === 'SEU_ACCESS_TOKEN_AQUI') {
            await carregarConfiguracoesMercadoPagoFirestore();
        }

        if (!activeAccessToken || activeAccessToken === 'SEU_ACCESS_TOKEN_AQUI') {
            return res.status(500).json({ 
                error: 'Access Token do Mercado Pago não configurado no servidor. Salve as credenciais no painel admin.' 
            });
        }

        // Se o frontend enviou dados do cartão em vez de token prévio, geramos o token no Mercado Pago
        if (!token && cardNumber) {
            const cleanCardNumber = String(cardNumber).replace(/\s/g, '');
            const cleanCpf = cpf ? String(cpf).replace(/\D/g, '') : '';
            const expMonth = Number(cardExpirationMonth);
            const expYearRaw = String(cardExpirationYear).trim();
            const expYear = Number(expYearRaw.length === 2 ? `20${expYearRaw}` : expYearRaw);

            const cardTokenResp = await fetch(`https://api.mercadopago.com/v1/card_tokens`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${activeAccessToken}`
                },
                body: JSON.stringify({
                    card_number: cleanCardNumber,
                    expiration_month: expMonth,
                    expiration_year: expYear,
                    security_code: String(securityCode).trim(),
                    cardholder: {
                        name: (cardholderName || 'CLIENTE BARBEARIA').toUpperCase(),
                        identification: cleanCpf ? { type: 'CPF', number: cleanCpf } : undefined
                    }
                })
            });

            const cardTokenData = await cardTokenResp.json();
            if (cardTokenData && cardTokenData.id) {
                token = cardTokenData.id;
            } else {
                console.error("Erro ao gerar card_token no Mercado Pago:", cardTokenData);
                const msgErro = cardTokenData?.message || (cardTokenData?.cause && cardTokenData?.cause[0]?.description) || 'Dados do cartão inválidos.';
                return res.status(400).json({ error: msgErro, details: cardTokenData });
            }
        }

        if (!token) {
            return res.status(400).json({ error: 'Token do cartão ou dados do cartão são obrigatórios.' });
        }

        // Detecta bandeira padrão se não enviada
        if (!payment_method_id) {
            const cleanNum = cardNumber ? String(cardNumber).replace(/\s/g, '') : '';
            if (cleanNum.startsWith('4')) {
                payment_method_id = tipoCartao === 'debito' ? 'debvisa' : 'visa';
            } else if (/^(5[1-5]|2[2-7])/.test(cleanNum)) {
                payment_method_id = tipoCartao === 'debito' ? 'debmaster' : 'master';
            } else if (/^(4011|4312|4389|4514|4576|5041|5066|5090|6277|6362|6363|6500|6504|6505|6507|6509|6516|6550)/.test(cleanNum)) {
                payment_method_id = tipoCartao === 'debito' ? 'debelo' : 'elo';
            } else if (/^(606282|3841)/.test(cleanNum)) {
                payment_method_id = 'hipercard';
            } else if (/^(34|37)/.test(cleanNum)) {
                payment_method_id = 'amex';
            } else {
                payment_method_id = tipoCartao === 'debito' ? 'debvisa' : 'visa';
            }
        }

        const isDebito = tipoCartao === 'debito' || payment_method_id.startsWith('deb');
        const numParcelas = isDebito ? 1 : (Number(installments) || 1);

        const paymentData = {
            token,
            issuer_id: issuer_id ? String(issuer_id) : undefined,
            payment_method_id,
            transaction_amount: Number(parseFloat(transaction_amount).toFixed(2)),
            installments: numParcelas,
            description: description || 'EMAÚS Barbearia',
            payer: {
                email: email || 'cliente@barbearia.com',
                ...(cpf ? { identification: { type: 'CPF', number: String(cpf).replace(/\D/g, '') } } : {})
            }
        };

        const response = await paymentClient.create({ body: paymentData });

        return res.status(200).json({
            id: response.id,
            status: response.status,
            status_detail: response.status_detail,
            date_approved: response.date_approved
        });
    } catch (error) {
        console.error('Erro ao processar cartão:', error);
        let userMessage = error.message || 'Erro ao processar pagamento com cartão.';
        if (userMessage.includes('Unauthorized use of live credentials')) {
            userMessage = 'O Mercado Pago recusou o token de produção (APP_USR). Ative suas credenciais de produção no painel do Mercado Pago Developers ou use o Token de Teste (iniciado em TEST-).';
        }
        return res.status(500).json({ 
            error: userMessage,
            details: error.cause || error.api_response || null
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
app.post('/api/pagamento/estorno', verificarAuthEstornoMiddleware, async (req, res) => {
    try {
        const { paymentId, amount, reason } = req.body;

        if (!paymentId) {
            return res.status(400).json({ success: false, error: 'ID do pagamento obrigatório para estorno.' });
        }

        const cleanPaymentId = String(paymentId).trim();

        // Se for pagamento manual, pix manual ou plano vip que não passa pelo Mercado Pago
        if (cleanPaymentId === 'manual' || cleanPaymentId === 'pix_manual' || cleanPaymentId === 'plano_vip' || cleanPaymentId.startsWith('manual_')) {
            console.log(`[Estorno Manual] Pagamento ${cleanPaymentId} marcado como cancelado.`);
            return res.json({
                success: true,
                status: 'approved',
                message: 'Pagamento manual registrado como cancelado (sem cobrança no Mercado Pago).'
            });
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

        console.log(`[Estorno] Solicitando estorno para o pagamento ${cleanPaymentId}. Motivo: ${reason || 'Cancelamento de agendamento'}`);

        // Consulta prévia do status do pagamento no Mercado Pago
        let paymentInfo = null;
        try {
            const payRes = await fetch(`https://api.mercadopago.com/v1/payments/${cleanPaymentId}`, {
                headers: { 'Authorization': `Bearer ${activeAccessToken}` }
            });
            if (payRes.ok) {
                paymentInfo = await payRes.json();
            }
        } catch (e) {
            console.warn("Consulta prévia do pagamento:", e.message);
        }

        if (paymentInfo) {
            if (paymentInfo.status === 'refunded') {
                return res.json({
                    success: true,
                    status: 'approved',
                    refundId: paymentInfo.refunds?.[0]?.id || 'already_refunded',
                    amount: paymentInfo.transaction_amount_refunded || amount,
                    message: 'Este pagamento já havia sido estornado no Mercado Pago.'
                });
            }

            if (paymentInfo.status === 'pending' || paymentInfo.status === 'in_process') {
                try {
                    await fetch(`https://api.mercadopago.com/v1/payments/${cleanPaymentId}`, {
                        method: 'PUT',
                        headers: {
                            'Authorization': `Bearer ${activeAccessToken}`,
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({ status: 'cancelled' })
                    });
                } catch (eCanc) {}

                return res.json({
                    success: true,
                    status: 'cancelled',
                    message: 'Pagamento pendente cancelado com sucesso no Mercado Pago.'
                });
            }

            if (paymentInfo.status === 'cancelled') {
                return res.json({
                    success: true,
                    status: 'cancelled',
                    message: 'Pagamento já estava cancelado no Mercado Pago.'
                });
            }
        }

        const transactionAmount = paymentInfo?.transaction_amount ? Number(paymentInfo.transaction_amount) : 0;
        const requestedAmount = amount ? Number(parseFloat(amount).toFixed(2)) : 0;
        const ehEstornoTotal = (!requestedAmount || (transactionAmount > 0 && requestedAmount >= transactionAmount));

        let refundResult = null;

        try {
            if (ehEstornoTotal) {
                // Estorno Total nativo do Pix / Cartão (sem passar amount fracionado para máxima compatibilidade)
                try {
                    refundResult = await refundClient.total({ payment_id: cleanPaymentId });
                } catch (sdkTotErr) {
                    console.warn('[Estorno Total SDK falhou, tentando REST API]:', sdkTotErr.message);
                    const restRes = await fetch(`https://api.mercadopago.com/v1/payments/${cleanPaymentId}/refunds`, {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${activeAccessToken}`,
                            'Content-Type': 'application/json',
                            'X-Idempotency-Key': `refund_${cleanPaymentId}_${Date.now()}`
                        },
                        body: JSON.stringify({})
                    });
                    const restData = await restRes.json();
                    if (!restRes.ok) {
                        throw new Error(restData.message || restData.error || 'Falha ao processar estorno total no Mercado Pago');
                    }
                    refundResult = restData;
                }
            } else {
                // Estorno Parcial
                try {
                    refundResult = await refundClient.create({
                        payment_id: cleanPaymentId,
                        body: { amount: requestedAmount }
                    });
                } catch (sdkParcErr) {
                    console.warn('[Estorno Parcial SDK falhou, tentando REST API]:', sdkParcErr.message);
                    const restRes = await fetch(`https://api.mercadopago.com/v1/payments/${cleanPaymentId}/refunds`, {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${activeAccessToken}`,
                            'Content-Type': 'application/json',
                            'X-Idempotency-Key': `refund_${cleanPaymentId}_${Date.now()}`
                        },
                        body: JSON.stringify({ amount: requestedAmount })
                    });
                    const restData = await restRes.json();
                    if (!restRes.ok) {
                        throw new Error(restData.message || restData.error || 'Falha ao processar estorno parcial no Mercado Pago');
                    }
                    refundResult = restData;
                }
            }

            console.log(`[Estorno Sucesso] Pagamento ${cleanPaymentId} estornado:`, refundResult?.status || 'Aprovado');

            // Sincroniza status no Firestore em segundo plano
            sincronizarEstornoNoFirestore(cleanPaymentId, refundResult?.amount || amount).catch(e => console.warn("Aviso Firestore Sync:", e.message));

            return res.json({
                success: true,
                status: refundResult?.status || 'approved',
                refundId: refundResult?.id,
                amount: refundResult?.amount || amount,
                message: 'Estorno realizado com sucesso no Mercado Pago!'
            });

        } catch (error) {
            console.error('Erro ao processar estorno no Mercado Pago:', error);
            const errStr = (error.message || '').toLowerCase();
            
            if (errStr.includes('already refunded') || errStr.includes('total_refunded_amount') || errStr.includes('ja foi estornado')) {
                sincronizarEstornoNoFirestore(cleanPaymentId, amount).catch(e => console.warn("Aviso Firestore Sync:", e.message));
                return res.json({
                    success: true,
                    status: 'approved',
                    message: 'Este pagamento já havia sido estornado no Mercado Pago.'
                });
            }

            let msgAmigavel = error.message || 'Erro ao processar estorno no Mercado Pago.';
            if (errStr.includes('unauthorized') || errStr.includes('policy') || errStr.includes('insufficient_amount') || errStr.includes('saldo')) {
                msgAmigavel = 'O Mercado Pago não autorizou o estorno automático. Verifique se a sua conta do Mercado Pago possui saldo disponível suficiente ou realize a devolução manualmente pelo aplicativo do Mercado Pago.';
            }

            return res.status(400).json({
                success: false,
                error: msgAmigavel,
                podeEstornarManualmente: true
            });
        }
    } catch (errGeral) {
        console.error('Erro geral no endpoint de estorno:', errGeral);
        return res.status(500).json({
            success: false,
            error: errGeral.message || 'Erro interno no servidor de estorno.'
        });
    }
});

// Helper para sincronizar status 'reembolsado' no Firestore
async function sincronizarEstornoNoFirestore(paymentId, amount = 0) {
    try {
        if (!paymentId) return;
        const cleanId = String(paymentId).trim();
        const token = await getGoogleAccessToken();
        if (!token) return;

        const collections = ['agendamentos', 'assinaturasClientes', 'comprasProdutos'];
        const nowIso = new Date().toISOString();

        for (const col of collections) {
            const queryData = JSON.stringify({
                structuredQuery: {
                    from: [{ collectionId: col }],
                    where: {
                        fieldFilter: {
                            field: { fieldPath: 'idPagamento' },
                            op: 'EQUAL',
                            value: { stringValue: cleanId }
                        }
                    }
                }
            });

            await new Promise((resolve) => {
                const req = https.request({
                    hostname: 'firestore.googleapis.com',
                    path: `/v1/projects/${serviceAccount.project_id}/databases/(default)/documents:runQuery`,
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(queryData)
                    }
                }, (res) => {
                    let d = '';
                    res.on('data', c => d += c);
                    res.on('end', async () => {
                        try {
                            const results = JSON.parse(d);
                            if (Array.isArray(results)) {
                                for (const r of results) {
                                    if (r.document && r.document.name) {
                                        const docPath = r.document.name.split('/documents/')[1];
                                        const patchData = JSON.stringify({
                                            fields: {
                                                status: { stringValue: 'reembolsado' },
                                                estornadoEm: { timestampValue: nowIso },
                                                estornoRealizado: { booleanValue: true },
                                                motivoCancelamento: { stringValue: 'Reembolsado no Mercado Pago' },
                                                ...(amount > 0 ? { valorEstornado: { doubleValue: Number(amount) } } : {})
                                            }
                                        });
                                        const patchMask = amount > 0 
                                            ? 'updateMask.fieldPaths=status&updateMask.fieldPaths=estornadoEm&updateMask.fieldPaths=estornoRealizado&updateMask.fieldPaths=motivoCancelamento&updateMask.fieldPaths=valorEstornado'
                                            : 'updateMask.fieldPaths=status&updateMask.fieldPaths=estornadoEm&updateMask.fieldPaths=estornoRealizado&updateMask.fieldPaths=motivoCancelamento';

                                        await new Promise((pRes) => {
                                            const pReq = https.request({
                                                hostname: 'firestore.googleapis.com',
                                                path: `/v1/projects/${serviceAccount.project_id}/databases/(default)/documents/${docPath}?${patchMask}`,
                                                method: 'PATCH',
                                                headers: {
                                                    'Authorization': `Bearer ${token}`,
                                                    'Content-Type': 'application/json',
                                                    'Content-Length': Buffer.byteLength(patchData)
                                                }
                                            }, (pres2) => {
                                                let pd = '';
                                                pres2.on('data', c => pd += c);
                                                pres2.on('end', pRes);
                                            });
                                            pReq.on('error', pRes);
                                            pReq.write(patchData);
                                            pReq.end();
                                        });
                                        console.log(`[Firestore Sync] Documento ${docPath} marcado como reembolsado.`);
                                    }
                                }
                            }
                        } catch (e) {
                            console.warn(`[Firestore Sync Warning] Erro ao processar ${col}:`, e.message);
                        }
                        resolve();
                    });
                });
                req.on('error', resolve);
                req.write(queryData);
                req.end();
            });
        }
    } catch (err) {
        console.warn('[Firestore Sync] Falha geral ao sincronizar estorno:', err.message);
    }
}

// C1: Alias para compatibilidade — /api/mercadopago/reembolsar-pagamento → /api/pagamento/estorno
app.post('/api/mercadopago/reembolsar-pagamento', verificarAdminMiddleware, async (req, res) => {
    // Redireciona para o handler de estorno existente, repassando o body
    req.url = '/api/pagamento/estorno';
    app.handle(req, res);
});

// A2: Webhook com validação de assinatura HMAC (X-Signature do Mercado Pago)
app.post('/api/webhook', async (req, res) => {
    try {
        const MP_WEBHOOK_SECRET = process.env.MP_WEBHOOK_SECRET || '';

        // Valida assinatura se o secret estiver configurado
        if (MP_WEBHOOK_SECRET) {
            const xSignature = req.headers['x-signature'] || '';
            const xRequestId = req.headers['x-request-id'] || '';
            const dataId = req.query['data.id'] || req.body?.data?.id || '';

            // Monta o manifesto de validação conforme docs oficiais do Mercado Pago
            const manifest = `id:${dataId};request-id:${xRequestId};ts:${xSignature.split(',').find(p => p.startsWith('ts='))?.split('=')?.[1] || ''};`;
            const signatureParts = xSignature.split(',');
            const tsPart = signatureParts.find(p => p.trim().startsWith('ts='));
            const v1Part = signatureParts.find(p => p.trim().startsWith('v1='));

            if (tsPart && v1Part) {
                const ts = tsPart.split('=')[1];
                const v1 = v1Part.split('=')[1];
                const signedManifest = `id:${dataId};request-id:${xRequestId};ts:${ts};`;
                const expectedHmac = crypto.createHmac('sha256', MP_WEBHOOK_SECRET)
                    .update(signedManifest)
                    .digest('hex');

                if (expectedHmac !== v1) {
                    console.warn(`[Webhook] Assinatura inválida — possível requisição não autorizada. x-request-id: ${xRequestId}`);
                    return res.status(200).json({ received: false, reason: 'invalid_signature' });
                }
            }
        }

        const topic = req.query.topic || req.body?.type;
        const paymentId = req.query.id || req.body?.data?.id;

        if (paymentId && (topic === 'payment' || req.body?.action?.includes('payment'))) {
            const response = await paymentClient.get({ id: paymentId });
            console.log(`[Webhook] ✅ Pagamento ${paymentId} status: ${response.status} (${response.status_detail})`);

            // Se o status for estornado/reembolsado, sincroniza automaticamente no banco
            if (response.status === 'refunded' || response.status === 'cancelled') {
                sincronizarEstornoNoFirestore(paymentId, response.transaction_amount_refunded || 0)
                    .catch(e => console.warn("[Webhook Sync Error]:", e.message));
            }

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
app.get('/api/whatsapp/status', async (req, res) => {
    try {
        const statusInfo = await obterStatusWhatsApp();
        return res.json(statusInfo);
    } catch (e) {
        return res.status(500).json({ status: 'disconnected', error: e.message });
    }
});

// Inicia ou reinicia conexão para gerar QR Code
app.post('/api/whatsapp/conectar', verificarAdminMiddleware, async (req, res) => {
    try {
        const result = await iniciarWhatsApp();
        return res.json({ success: true, ...result });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// Gera Código de Pareamento de 8 dígitos para conectar direto pelo celular (sem câmera)
app.post('/api/whatsapp/codigo-pareamento', verificarAdminMiddleware, async (req, res) => {
    try {
        const { telefone } = req.body;
        if (!telefone) {
            return res.status(400).json({ success: false, error: 'Digite seu número de WhatsApp com DDD para gerar o código.' });
        }
        const resultado = await gerarCodigoPareamentoWhatsApp(telefone);
        return res.json(resultado);
    } catch (err) {
        console.error('Erro na rota codigo-pareamento:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// Desconecta a sessão do WhatsApp
app.post('/api/whatsapp/desconectar', verificarAdminMiddleware, async (req, res) => {
    try {
        const result = await desconectarWhatsApp();
        return res.json(result);
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// Envio de mensagem direta de texto (restrito a admin)
app.post('/api/whatsapp/enviar', verificarAdminMiddleware, async (req, res) => {
    const { numero, mensagem } = req.body;
    if (!numero || !mensagem) {
        return res.status(400).json({ error: 'Numero e mensagem sao obrigatorios.' });
    }
    const result = await enviarMensagemWhatsApp(numero, mensagem);
    return res.json(result);
});

// Teste rápido para o WhatsApp do Barbeiro
app.post('/api/whatsapp/testar-barbeiro', verificarAdminMiddleware, async (req, res) => {
    try {
        const { numero } = req.body;
        if (!numero || String(numero).replace(/\D/g, '').length < 10) {
            return res.status(400).json({ success: false, error: 'Digite um número de WhatsApp válido com DDD para realizar o teste.' });
        }
        const msgTeste = `💈 *EMAÚS Barbearia - Teste de Notificação*\n\n` +
            `Olá, Barbeiro! ✂️\n\n` +
            `Seu WhatsApp foi configurado com sucesso no sistema da Barbearia EMAÚS via Evolution API.\n\n` +
            `✅ A partir de agora, você receberá aqui todos os resumos de agendamentos, cancelamentos e vendas da loja em tempo real!\n\n` +
            `_EMAÚS Barbearia • Sistema de Gestão 24/7_`;

        const result = await enviarMensagemWhatsApp(numero, msgTeste);
        return res.json(result);
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

async function resolverNumeroBarbeiro(customNumber) {
    if (customNumber && String(customNumber).trim().replace(/\D/g, '').length >= 10) {
        return String(customNumber).trim().replace(/\D/g, '');
    }
    const statusWa = await obterStatusWhatsApp();
    if (statusWa && statusWa.userNumber) {
        return statusWa.userNumber;
    }
    return null;
}

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
            produtos,
            isPlano, 
            semanaPlano,
            whatsappBarbeiro,
            barbeiroNome,
            barbeiroWhatsapp
        } = req.body;

        const dataFormatada = dataHora ? dataHora.replace('T', ' às ') : 'Data a confirmar';
        const numBarbeiroEspecifico = resolverNumeroBarbeiro(barbeiroWhatsapp);
        const numBarbeiroGeral = resolverNumeroBarbeiro(whatsappBarbeiro);
        const numBarbeiroDestino = numBarbeiroEspecifico || numBarbeiroGeral;

        const precoTotal = Number(preco || 0);
        const valorPago = Number(taxaReservaPaga !== undefined ? taxaReservaPaga : (isPlano ? 0 : 10));
        const valorRestante = Math.max(0, precoTotal - valorPago);

        let produtosTextoBarbeiro = "";
        let produtosTextoCliente = "";
        if (Array.isArray(produtos) && produtos.length > 0) {
            produtosTextoBarbeiro = `\n• *Produtos para Entregar no Balcão:* ` + produtos.map(p => `${p.quantidade}x ${p.nome}${p.volumeUnidade ? ` (${p.volumeUnidade})` : ''} (R$ ${Number(p.subtotal || (p.preco * p.quantidade)).toFixed(2)})`).join(', ');
            produtosTextoCliente = `• *Produtos Adicionados (Retirar no Balcão):* ` + produtos.map(p => `${p.quantidade}x ${p.nome} (R$ ${Number(p.subtotal || (p.preco * p.quantidade)).toFixed(2)})`).join(', ') + `\n`;
        }

        // 1. Mensagem para o Barbeiro
        let envioBarbeiro = null;
        if (numBarbeiroDestino) {
            let tipoPagtoTexto = `Taxa de Reserva Paga (R$ ${valorPago.toFixed(2)})`;
            let restanteBarbeiroTexto = `R$ ${valorRestante.toFixed(2)}`;

            if (isPlano) {
                tipoPagtoTexto = `Assinatura VIP (Semana ${semanaPlano || '1'})`;
                restanteBarbeiroTexto = "R$ 0,00 (Plano VIP - Isento)";
            } else if (modalidade === 'total' || valorRestante === 0) {
                tipoPagtoTexto = `Valor Integral Pago Online (R$ ${valorPago.toFixed(2)})`;
                restanteBarbeiroTexto = "R$ 0,00 (Totalmente Quitado)";
            }

            const headerBarbeiro = barbeiroNome && barbeiroNome !== 'Qualquer Profissional'
                ? `*EMAÚS Barbearia - Novo Agendamento (${barbeiroNome})* 📅`
                : `*EMAÚS Barbearia - Novo Agendamento* 📅`;

            const msgBarbeiro = `${headerBarbeiro}\n\n` +
                `• *Cliente:* ${cliente || 'Cliente'}\n` +
                `• *Telefone:* ${telefone || 'Não informado'}\n` +
                `• *Serviço:* ${servico || 'Corte'} (Total R$ ${precoTotal.toFixed(2)})\n` +
                `• *Data/Hora:* ${dataFormatada}\n` +
                `• *Pagamento Online:* ${tipoPagtoTexto}\n` +
                `• *Restante a Receber no Atendimento:* ${restanteBarbeiroTexto}` +
                produtosTextoBarbeiro;

            envioBarbeiro = await enviarMensagemWhatsApp(numBarbeiroDestino, msgBarbeiro);

            // Se o barbeiro específico for diferente do dono principal, envia cópia de acompanhamento para o dono
            if (numBarbeiroGeral && numBarbeiroEspecifico && numBarbeiroGeral !== numBarbeiroEspecifico) {
                try {
                    await enviarMensagemWhatsApp(numBarbeiroGeral, `*[Aviso Master]* Novo agendamento para o profissional *${barbeiroNome || 'da Equipe'}*:\n` + msgBarbeiro);
                } catch (eMaster) { console.warn("Aviso ao notificar master:", eMaster.message); }
            }
        }

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
                produtosTextoCliente +
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
app.post('/api/whatsapp/lembrete-expiracao-plano', verificarAdminMiddleware, async (req, res) => {
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
            `👉 ${APP_SITE_URL}\n\n` +
            `_EMAÚS Barbearia • Estilo e Alta Performance_`;

        const resultado = await enviarMensagemWhatsApp(telefone, msgLembrete);
        return res.json({ success: true, resultado });
    } catch (err) {
        console.error('Erro na rota lembrete-expiracao-plano:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// Disparo em lote de lembretes para múltiplos clientes com crédito expirando
app.post('/api/whatsapp/disparar-lembretes-expiracao-lote', verificarAdminMiddleware, async (req, res) => {
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
                `👉 ${APP_SITE_URL}\n\n` +
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
        const numBarbeiro = resolverNumeroBarbeiro(whatsappBarbeiro);

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

        let envioBarbeiro = null;
        if (numBarbeiro) {
            envioBarbeiro = await enviarMensagemWhatsApp(numBarbeiro, msgBarbeiro);
        }

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
                `👉 ${APP_SITE_URL}\n\n` +
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
        const numBarbeiro = resolverNumeroBarbeiro(whatsappBarbeiro);

        // 1. Mensagem para o Barbeiro
        const msgBarbeiro = `*EMAÚS Barbearia - Nova Assinatura VIP!* 👑\n\n` +
            `Temos um novo cliente mensalista cadastrado:\n\n` +
            `• *Cliente:* ${cliente || 'Cliente'}\n` +
            `• *Telefone:* ${telefone || 'Não informado'}\n` +
            `• *Plano:* ${nomePlano || 'Pacote Mensal'}\n` +
            `• *Valor Pago:* R$ ${Number(preco || 0).toFixed(2)}\n` +
            `• *Validade:* 30 dias (4 atendimentos)`;

        let envioBarbeiro = null;
        if (numBarbeiro) {
            envioBarbeiro = await enviarMensagemWhatsApp(numBarbeiro, msgBarbeiro);
        }

        // 2. Mensagem de Boas-Vindas para o Cliente VIP
        let envioCliente = null;
        if (telefone) {
            const msgCliente = `*EMAÚS Barbearia - Assinatura VIP Confirmada!* 👑\n\n` +
                `Parabéns, *${cliente || 'Cliente'}*! Sua assinatura do plano *${nomePlano || 'Mensal VIP'}* foi ativada com sucesso.\n\n` +
                `• *Duração:* 30 dias\n` +
                `• *Benefício:* 4 cortes (1 corte exclusivo por semana)\n` +
                `• *Seu corte da Semana 1 já está disponível para agendamento gratuito!*\n\n` +
                `Agende seus atendimentos diretamente no nosso site:\n` +
                `👉 ${APP_SITE_URL}\n\n` +
                `_EMAÚS Barbearia • Estilo e Alta Performance_`;

            envioCliente = await enviarMensagemWhatsApp(telefone, msgCliente);
        }

        return res.json({ success: true, barbeiro: envioBarbeiro, cliente: envioCliente });
    } catch (err) {
        console.error('Erro na rota notificar-compra-plano:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// Notificação Instantânea de Compra de Produtos da Barbearia (Barbeiro + Cliente)
app.post('/api/whatsapp/notificar-compra-produto', async (req, res) => {
    try {
        const {
            cliente,
            telefone,
            produtos,
            valorTotal,
            metodoPagamento,
            whatsappBarbeiro
        } = req.body;

        const numBarbeiro = resolverNumeroBarbeiro(whatsappBarbeiro);
        const totalNum = Number(valorTotal || 0);

        let itensTexto = '';
        if (Array.isArray(produtos)) {
            itensTexto = produtos.map(p => `  ▫️ ${p.quantidade || 1}x ${p.nome} ${p.volumeUnidade ? '(' + p.volumeUnidade + ')' : ''} - R$ ${Number(p.subtotal || (p.preco * (p.quantidade || 1))).toFixed(2)}`).join('\n');
        } else if (typeof produtos === 'string') {
            itensTexto = `  ▫️ ${produtos}`;
        } else {
            itensTexto = `  ▫️ Produtos da Barbearia`;
        }

        // 1. Mensagem para o Barbeiro
        const msgBarbeiro = `🛍️ *EMAÚS Barbearia - Nova Venda de Produto!*\n\n` +
            `Temos um novo pedido pago pelo site:\n\n` +
            `• *Cliente:* ${cliente || 'Cliente'}\n` +
            `• *Telefone:* ${telefone || 'Não informado'}\n` +
            `• *Itens Comprados:*\n${itensTexto}\n\n` +
            `• *Total Pago:* R$ ${totalNum.toFixed(2)} (${metodoPagamento || 'Pix'})\n` +
            `• *Status:* ✅ Pagamento Aprovado - Separar para Retirada!`;

        let envioBarbeiro = null;
        if (numBarbeiro) {
            envioBarbeiro = await enviarMensagemWhatsApp(numBarbeiro, msgBarbeiro);
        }

        // 2. Mensagem de Confirmação para o Cliente
        let envioCliente = null;
        if (telefone) {
            const msgCliente = `🛍️ *EMAÚS Barbearia - Compra Confirmada!*\n\n` +
                `Olá, *${cliente || 'Cliente'}*!\n` +
                `Recebemos o seu pedido e o seu pagamento via Pix foi *aprovado com sucesso*!\n\n` +
                `• *Itens do seu Pedido:*\n${itensTexto}\n\n` +
                `• *Valor Total Pago:* R$ ${totalNum.toFixed(2)}\n\n` +
                `📍 *Retirada:* Seus produtos já estão reservados e podem ser retirados diretamente na Barbearia EMAÚS no seu próximo atendimento ou quando você passar por aqui.\n\n` +
                `Agradecemos a sua preferência! 💈✨`;

            envioCliente = await enviarMensagemWhatsApp(telefone, msgCliente);
        }

        return res.json({ success: true, barbeiro: envioBarbeiro, cliente: envioCliente });
    } catch (err) {
        console.error('Erro na rota notificar-compra-produto:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// Notificação Instantânea de Parabéns e Presente de Aniversário (Cliente)
app.post('/api/whatsapp/notificar-aniversario', verificarAdminMiddleware, async (req, res) => {
    try {
        const { cliente, telefone, descricaoRecompensa, mensagemCustomizada } = req.body;
        if (!telefone) {
            return res.status(400).json({ success: false, error: 'Telefone do cliente é obrigatório.' });
        }

        const msgAniversario = mensagemCustomizada || 
            `🎂 *EMAÚS Barbearia - Feliz Aniversário!* 🎉\n\n` +
            `Fala, *${cliente || 'Amigo'}*! Tudo bem?\n\n` +
            `A equipe da *EMAÚS Barbearia* deseja a você um Feliz Aniversário, com muita saúde, sucesso e realizações! ✂️✨\n\n` +
            `🎁 Para comemorar o seu dia com estilo, preparamos um presente especial para você:\n` +
            `👉 *${descricaoRecompensa || 'Desconto Especial no seu próximo corte'}*\n\n` +
            `Acesse nosso site para resgatar seu presente e agendar seu horário:\n` +
            `🔗 ${APP_SITE_URL}\n\n` +
            `_EMAÚS Barbearia • Atendimento de Alta Performance_`;

        const resultado = await enviarMensagemWhatsApp(telefone, msgAniversario);
        return res.json({ success: true, resultado });
    } catch (err) {
        console.error('Erro na rota notificar-aniversario:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// Rota para disparar checagem e envio de lembretes 4h antes (restrito a admin)
app.all('/api/whatsapp/disparar-lembretes-4h', verificarAdminMiddleware, async (req, res) => {
    try {
        const resultado = await verificarLembretes4hAgenda();
        return res.json(resultado);
    } catch (err) {
        console.error('Erro ao disparar lembretes 4h:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

if (!process.env.VERCEL) {
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
