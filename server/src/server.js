import dotenv from 'dotenv';
if (process.env.NODE_ENV !== 'test') dotenv.config(); // Testes não carregam credenciais do .env.

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { MercadoPagoConfig, Payment, PaymentRefund } from 'mercadopago';
import { 
    iniciarWhatsApp, 
    obterStatusWhatsApp, 
    desconectarWhatsApp, 
    enviarMensagemWhatsApp,
    gerarCodigoPareamentoWhatsApp
} from './whatsappService.js';

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import https from 'https';
import { fileURLToPath, pathToFileURL } from 'url';

// Importar o app (testes/Vercel) não deve abrir portas nem iniciar tarefas em
// background. Esses efeitos colaterais só pertencem ao processo executado por
// `node server/src/server.js`.
const isMainModule = process.argv[1]
    ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
    : false;

import serviceAccount from './firebaseServiceAccount.js';
import { arquivoPublicoPermitido } from './publicFiles.js';
import { validarCheckout } from './monthlyCheckout.js';
import { prepararConsumoBeneficios } from './bookingBenefits.js';
import { agendarBeneficioGratuito } from './freeBooking.js';
import { solicitarPixManual, decidirPixManual } from './manualBooking.js';
import { agendarPlanoMensal, cancelarPlanoMensal, validarSemanaPlano } from './monthlyBooking.js';
import { cancelarAgendamentoAvulso } from './singleBooking.js';
import { vincularMensalista } from './monthlyIdentity.js';
import { gravarCicloMensal } from './monthlyCycle.js';
import {
    assinaturaMensalEstaAtiva,
    consolidarClientesDuplicadosCRMServidor,
    normalizarEmailCRMServidor,
    normalizarTelefoneCRMServidor
} from './crmUtils.js';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

let firebaseAdminApp = null;
let firebaseAdminAuth = null;
let firebaseAdminFirestore = null;

const emulatorLocal = process.env.EMAUS_LOCAL_EMULATOR === '1';
if (emulatorLocal && (process.env.NODE_ENV !== 'test' || process.env.GCLOUD_PROJECT !== 'demo-emaus-local' || process.env.FIRESTORE_EMULATOR_HOST !== '127.0.0.1:8080' || process.env.FIREBASE_AUTH_EMULATOR_HOST !== '127.0.0.1:9099')) {
    throw new Error('Configuração insegura do ambiente local. Use npm run dev:emulator.');
}
if (emulatorLocal || (serviceAccount && serviceAccount.private_key)) {
    try {
        firebaseAdminApp = emulatorLocal ? initializeApp({ projectId: 'demo-emaus-local' }, 'emaus-local-api') : getApps().length ? getApps()[0] : initializeApp({
            credential: cert(serviceAccount)
        });
        firebaseAdminAuth = getAuth(firebaseAdminApp);
        firebaseAdminFirestore = getFirestore(firebaseAdminApp);
        console.log('✅ [Firebase Admin SDK & Firestore] Inicializado com sucesso!');
    } catch (e) {
        console.warn('Aviso na inicialização do Firebase Admin SDK:', e.message);
    }
}



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
                path: `/v1/projects/${serviceAccount.project_id}/databases/(default)/documents/agendamentos?pageSize=300`,
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

function sendPasswordResetEmailGoogle(token, email) {
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify({
            requestType: "PASSWORD_RESET",
            email: email
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
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Servir arquivos estáticos do frontend (admin.html, index.html, imagens, assets) localmente
// Somente arquivos explicitamente públicos, nunca credenciais, backups ou código.
const servirArquivoPublico = express.static(path.resolve(__dirname, '../../'), { dotfiles: 'deny' });
app.use((req, res, next) => {
    const aliases = { '/': '/index.html', '/index': '/index.html', '/admin': '/admin.html', '/termos': '/termos.html', '/redefinir-senha': '/redefinir-senha.html', '/__/auth/action': '/redefinir-senha.html' };
    const destino = aliases[req.path] || req.path;
    if (!arquivoPublicoPermitido(destino)) return next();
    if (aliases[req.path]) req.url = destino + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '');
    return servirArquivoPublico(req, res, next);
});

// Rota mock para silenciar 404 de scripts da Vercel em ambiente local
app.all(['/_vercel/insights/script.js', '/_vercel/speed-insights/script.js', '/_vercel/*'], (req, res) => {
    res.type('application/javascript').send('/* vercel analytics disabled locally */');
});

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

// Verifica o cadastro administrativo por UID. Custom claim `admin` é validada
// diretamente pelos middlewares antes deste fallback de migração.
export async function isEmailAdmin(email, uid = null, db = null, claimAdmin = false) {
    const firestore = db || firebaseAdminFirestore;
    if (firestore) {
        try {
            if (uid) {
                const docSnap = await firestore.collection('administradores').doc(uid).get();
                if (docSnap.exists) return docSnap.data().ativo !== false;
            }
            if (email) {
                const emailNormalizado = String(email).trim().toLowerCase();
                const snap = await firestore.collection('administradores')
                    .where('email', '==', emailNormalizado)
                    .limit(1)
                    .get();
                if (!snap.empty) return snap.docs.every(doc => doc.data().ativo !== false);
            }
        } catch (e) {
            console.warn('[AdminCheck] Aviso ao consultar administradores no Firestore:', e.message);
            return false;
        }
    }
    return claimAdmin === true;
}

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

        const ehAdmin = await isEmailAdmin(decoded.email, decoded.uid || decoded.user_id, null, decoded.admin === true);
        if (!ehAdmin) {
            console.warn(`[Segurança] Tentativa de acesso não autorizado por: ${decoded.email}`);
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

// Middleware de Chave Interna de Serviço para rotas de notificação automática
// Aceita chamadas com header X-Internal-Key via comparação de tempo constante
// OU autenticação de Administrador Firebase. Bloqueia relay aberto de spam por clientes.
async function verificarInternalKeyMiddleware(req, res, next) {
    const INTERNAL_KEY = process.env.INTERNAL_SERVICE_KEY || '';

    const providedKey = String(req.headers['x-internal-key'] || '');
    if (providedKey && INTERNAL_KEY) {
        const bufProvided = Buffer.from(providedKey, 'utf8');
        const bufExpected = Buffer.from(INTERNAL_KEY, 'utf8');
        if (bufProvided.length === bufExpected.length && crypto.timingSafeEqual(bufProvided, bufExpected)) {
            return next();
        }
    }

    // Fallback restrito: Apenas Administrador autenticado no Firebase pode acionar notificações
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
    if (token) {
        const decoded = await validarTokenFirebaseAdmin(token);
        if (decoded && decoded.email) {
            const ehAdmin = await isEmailAdmin(decoded.email, decoded.uid || decoded.user_id, null, decoded.admin === true);
            if (ehAdmin) {
                req.authUser = decoded;
                req.ehAdmin = true;
                return next();
            }
            return res.status(403).json({
                success: false,
                error: 'Acesso restrito. Clientes comuns não possuem permissão para disparar notificações.'
            });
        }
    }

    return res.status(401).json({
        success: false,
        error: 'Acesso negado. Chave de serviço ou credencial administrativa obrigatória.'
    });
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
        req.ehAdmin = await isEmailAdmin(decoded.email, decoded.uid || decoded.user_id, null, decoded.admin === true);
        next();
    } catch (err) {
        console.error('Erro na validação de estorno:', err);
        return res.status(500).json({ success: false, error: 'Erro interno ao validar autenticação.' });
    }
}

// Middleware para qualquer rota privada de cliente autenticado.
async function verificarUsuarioMiddleware(req, res, next) {
    try {
        const authHeader = req.headers['authorization'] || '';
        const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
        if (!token) {
            return res.status(401).json({ success: false, error: 'Autenticação obrigatória.' });
        }
        const decoded = await validarTokenFirebaseAdmin(token);
        if (!decoded || !(decoded.uid || decoded.user_id)) {
            return res.status(403).json({ success: false, error: 'Token inválido ou expirado.' });
        }
        req.authUser = decoded;
        req.ehAdmin = await isEmailAdmin(decoded.email, decoded.uid || decoded.user_id, null, decoded.admin === true);
        return next();
    } catch (err) {
        console.error('[Auth Cliente] Erro:', err.message);
        return res.status(500).json({ success: false, error: 'Erro ao validar autenticação.' });
    }
}



app.get('/api/cliente/minha-assinatura', verificarUsuarioMiddleware, async (req, res) => {
    try {
        if (!firebaseAdminFirestore || !firebaseAdminAuth) return res.status(503).json({ success: false, error: 'Banco indisponível.' });
        const identidade = await firebaseAdminAuth.getUser(req.authUser.uid || req.authUser.user_id);
        const resultado = await vincularMensalista(firebaseAdminFirestore, identidade, firebaseAdminAuth);
        return res.json({ success: true, ...resultado });
    } catch (err) {
        return res.status(err.statusCode || 500).json({ success: false, error: err.statusCode ? err.message : 'Não foi possível consultar o plano. Tente novamente.' });
    }
});

app.post('/api/cliente/pix-manual', verificarUsuarioMiddleware, async (req, res) => {
    try {
        if (!firebaseAdminFirestore) return res.status(503).json({ error: 'Banco indisponível.' });
        const solicitacao = await solicitarPixManual(firebaseAdminFirestore, req.authUser.uid || req.authUser.user_id, req.body || {});
        return res.json({ success: true, solicitacao });
    } catch (err) { return res.status(Number(err.statusCode) || 500).json({ error: err.statusCode ? err.message : 'Não foi possível enviar a solicitação.' }); }
});

app.get('/api/admin/pix-manual', verificarAdminMiddleware, async (req, res) => {
    try {
        if (!firebaseAdminFirestore) return res.status(503).json({ error: 'Banco indisponível.' });
        const snap = await firebaseAdminFirestore.collection('solicitacoes_pix_manual').where('status', '==', 'pendente').limit(100).get();
        return res.json({ success: true, solicitacoes: snap.docs.map(d => ({ ...d.data(), id: d.id })) });
    } catch (_) { return res.status(500).json({ error: 'Não foi possível consultar solicitações.' }); }
});

app.post('/api/admin/pix-manual/:id/decidir', verificarAdminMiddleware, async (req, res) => {
    try {
        if (!firebaseAdminFirestore) return res.status(503).json({ error: 'Banco indisponível.' });
        if (req.body?.acao === 'aprovar' && req.body?.pagamentoConferido !== true) return res.status(400).json({ error: 'Confira o recebimento do Pix antes de aprovar.' });
        const resultado = await decidirPixManual(firebaseAdminFirestore, req.params.id, req.adminUser.uid || req.adminUser.user_id, req.body?.acao);
        return res.json({ success: true, ...resultado });
    } catch (err) { return res.status(Number(err.statusCode) || (err.code === 'BENEFICIO_INDISPONIVEL' ? 409 : 500)).json({ error: err.statusCode || err.code === 'BENEFICIO_INDISPONIVEL' ? err.message : 'Não foi possível decidir a solicitação.' }); }
});

app.post('/api/cliente/agendar-gratuito', verificarUsuarioMiddleware, async (req, res) => {
    try {
        if (!firebaseAdminFirestore) return res.status(503).json({ success: false, error: 'Banco de dados indisponível.' });
        const ag = await agendarBeneficioGratuito(firebaseAdminFirestore, req.authUser.uid || req.authUser.user_id, req.body || {});
        let notificacaoPendente = false;
        if (!ag.alreadyRecorded) {
            try {
                const destino = await resolverNumeroBarbeiro(ag.barbeiroWhatsapp);
                const mensagem = `*EMAÚS — Agendamento com benefício*\nCliente: ${ag.cliente}\nServiço: ${ag.servico}\nHorário: ${ag.dataHora}\nProfissional: ${ag.barbeiroNome}`;
                const envios = [];
                if (destino) envios.push(await enviarMensagemWhatsApp(destino, mensagem));
                if (ag.telefone) envios.push(await enviarMensagemWhatsApp(ag.telefone, mensagem));
                notificacaoPendente = !envios.length || envios.some(e => !e?.success || e?.simulated);
            } catch (_) { notificacaoPendente = true; }
        }
        return res.json({ success: true, agendamento: ag, notificacaoPendente });
    } catch (err) {
        const status = err.code === 'BENEFICIO_INDISPONIVEL' ? 409 : Number(err.statusCode) || 500;
        return res.status(status).json({ success: false, error: status === 500 ? 'Não foi possível confirmar o benefício.' : err.message });
    }
});

app.post('/api/cliente/plano/agendar', verificarUsuarioMiddleware, async (req, res) => {
    try {
        if (!firebaseAdminFirestore) return res.status(503).json({ success: false, error: 'Banco de dados indisponível.' });
        const uid = String(req.authUser.uid || req.authUser.user_id || '');
        const agendamento = await agendarPlanoMensal(firebaseAdminFirestore, uid, req.body || {});
        if (!agendamento.alreadyRecorded) {
            try {
                const destino = await resolverNumeroBarbeiro(agendamento.barbeiroWhatsapp);
                const mensagem = `*EMAÚS — Agendamento do Plano Mensal*\nCliente: ${agendamento.cliente}\nHorário: ${agendamento.dataHora}\nSemana: ${agendamento.semanaPlano}`;
                if (destino) await enviarMensagemWhatsApp(destino, mensagem);
            } catch (e) { console.warn('[Plano] Agendado; aviso WhatsApp não enviado:', e.message); }
        }
        return res.json({ success: true, agendamento });
    } catch (err) {
        const status = Number(err.statusCode) || 500;
        return res.status(status).json({ success: false, error: status === 500 ? 'Não foi possível agendar o plano.' : err.message });
    }
});

app.post('/api/cliente/plano/cancelar-semana', verificarUsuarioMiddleware, async (req, res) => {
    try {
        if (!firebaseAdminFirestore) return res.status(503).json({ success: false, error: 'Banco de dados indisponível.' });
        const uid = String(req.authUser.uid || req.authUser.user_id || '');
        const resultado = await cancelarPlanoMensal(firebaseAdminFirestore, uid, req.body?.agendamentoId, new Date(), {
            processarEstorno: (pid, valor, chave) => executarEstornoMercadoPagoInterno(pid, valor, chave)
        });
        let notificacaoPendente = false;
        if (!resultado.alreadyRecorded) {
            try {
                const ag = resultado.agendamento;
                const destino = await resolverNumeroBarbeiro(ag.barbeiroWhatsapp);
                const credito = resultado.status === 'disponivel' ? 'Crédito semanal liberado.' : 'Crédito perdido pela regra de três horas.';
                const mensagem = `*EMAÚS — Cancelamento do Plano*\nCliente: ${ag.cliente}\nHorário: ${ag.dataHora}\n${credito}\nEste aviso não confirma estorno de serviços extras.`;
                const envios = [];
                if (destino) envios.push(await enviarMensagemWhatsApp(destino, mensagem));
                if (ag.telefone) envios.push(await enviarMensagemWhatsApp(ag.telefone, mensagem));
                notificacaoPendente = !envios.length || envios.some(e => !e?.success || e?.simulated);
            } catch (e) {
                notificacaoPendente = true;
                console.warn('[Plano] Cancelado; aviso WhatsApp não confirmado:', e.message);
            }
        }
        return res.json({ success: true, status: resultado.status, alreadyRecorded: resultado.alreadyRecorded, notificacaoPendente, estornoExtrasStatus: resultado.agendamento.estornoExtrasStatus || 'nao_aplicavel' });
    } catch (err) {
        const status = Number(err.statusCode) || 500;
        return res.status(status).json({ success: false, error: status === 500 ? 'Não foi possível cancelar o plano.' : err.message });
    }
});

app.post('/api/cliente/agendamento/cancelar', verificarUsuarioMiddleware, async (req, res) => {
    try {
        if (!firebaseAdminFirestore) return res.status(503).json({ success: false, error: 'Banco de dados indisponível.' });
        const uid = String(req.authUser.uid || req.authUser.user_id || '');
        const agendamentoId = String(req.body?.agendamentoId || '').trim();

        const resultado = await cancelarAgendamentoAvulso(firebaseAdminFirestore, uid, agendamentoId, {
            processarEstorno: (pid, valor, motivo, chave) => executarEstornoMercadoPagoInterno(pid, valor, chave)
        });

        let notificacaoPendente = false;
        if (!resultado.alreadyRecorded) {
            try {
                const ag = resultado.agendamento;
                const destino = await resolverNumeroBarbeiro(ag.barbeiroWhatsapp);
                const infoEstorno = resultado.estornoRealizado
                    ? `Estorno de R$ ${resultado.valorEstornado.toFixed(2)} efetuado via Mercado Pago.`
                    : (resultado.elegivelEstorno && Number(ag.taxaReservaPaga || ag.precoPago || 0) > 0 ? 'Estorno a conferir pelo estabelecimento.' : 'Sem estorno financeiro (<3h ou gratuito).');
                const mensagem = `*EMAÚS — Cancelamento de Agendamento*\nCliente: ${ag.cliente || 'Cliente'}\nHorário: ${ag.dataHora}\nServiço: ${ag.servico || 'Corte'}\n${infoEstorno}`;
                const envios = [];
                if (destino) envios.push(await enviarMensagemWhatsApp(destino, mensagem));
                if (ag.telefone) envios.push(await enviarMensagemWhatsApp(ag.telefone, mensagem));
                notificacaoPendente = !envios.length || envios.some(e => !e?.success || e?.simulated);
            } catch (e) {
                notificacaoPendente = true;
                console.warn('[Agendamento Avulso] Cancelado; aviso WhatsApp não confirmado:', e.message);
            }
        }

        return res.json({
            success: true,
            status: resultado.status,
            alreadyRecorded: resultado.alreadyRecorded,
            estornoRealizado: resultado.estornoRealizado,
            valorEstornado: resultado.valorEstornado,
            elegivelEstorno: resultado.elegivelEstorno,
            motivoCancelamento: resultado.motivoCancelamento,
            notificacaoPendente
        });
    } catch (err) {
        const status = Number(err.statusCode) || 500;
        return res.status(status).json({ success: false, error: status === 500 ? 'Não foi possível cancelar o agendamento.' : err.message });
    }
});

app.post('/api/admin/conceder', verificarAdminMiddleware, async (req, res) => {
    try {
        const email = String(req.body?.email || '').trim().toLowerCase();
        if (!email || !firebaseAdminAuth || !firebaseAdminFirestore) {
            return res.status(400).json({ success: false, error: 'E-mail inválido.' });
        }
        const usuario = await firebaseAdminAuth.getUserByEmail(email);
        await firebaseAdminAuth.setCustomUserClaims(usuario.uid, {
            ...(usuario.customClaims || {}),
            admin: true
        });
        await firebaseAdminFirestore.collection('administradores').doc(usuario.uid).set({
            uid: usuario.uid,
            email,
            adicionadoPor: req.adminUser.email || req.adminUser.uid,
            criadoEm: new Date().toISOString()
        }, { merge: true });
        return res.json({ success: true, uid: usuario.uid, email });
    } catch (err) {
        const status = err.code === 'auth/user-not-found' ? 404 : 500;
        return res.status(status).json({ success: false, error: status === 404 ? 'Crie a conta do usuário antes de conceder acesso.' : 'Erro ao conceder acesso.' });
    }
});

app.post('/api/admin/remover', verificarAdminMiddleware, async (req, res) => {
    try {
        const uid = String(req.body?.uid || '').trim();
        if (!uid || !firebaseAdminAuth || !firebaseAdminFirestore) {
            return res.status(400).json({ success: false, error: 'UID inválido.' });
        }
        const usuario = await firebaseAdminAuth.getUser(uid);
        if (usuario.customClaims?.master === true) {
            return res.status(403).json({ success: false, error: 'O administrador master não pode ser removido.' });
        }
        const novasClaims = { ...(usuario.customClaims || {}) };
        delete novasClaims.admin;
        await firebaseAdminAuth.setCustomUserClaims(uid, novasClaims);
        await firebaseAdminFirestore.collection('administradores').doc(uid).delete();
        return res.json({ success: true });
    } catch (err) {
        console.error('[Admin Remover] Erro:', err.message);
        return res.status(500).json({ success: false, error: 'Erro ao remover acesso.' });
    }
});

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
if (isMainModule) {
    try {
        iniciarWhatsApp({ onlyIfRegistered: true }).catch(err => console.log('WhatsApp Bot aguardando conexão local/nuvem...'));
    } catch (e) {
        console.warn("Aviso WhatsApp:", e.message);
    }

    // Keep-alive interno para manter o Render acordado 24/7 (URL configurável via SELF_URL)
    setInterval(() => {
        https.get(`${SELF_URL}/health`, () => {}).on('error', () => {});
    }, 10 * 60 * 1000).unref();

}

// Endpoint Seguro de Recuperação de Senha (Disparo por E-mail)
app.post('/api/auth/recuperar-senha', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email || !email.includes('@')) {
            return res.status(400).json({ success: false, error: 'E-mail inválido.' });
        }

        const emailLimpo = email.trim().toLowerCase();

        // 1. Tenta envio seguro via Google Identity Toolkit REST API
        try {
            const token = await getGoogleAccessToken();
            if (token) {
                await sendPasswordResetEmailGoogle(token, emailLimpo);
            }
        } catch (eGoogle) {
            console.warn('[Auth] Aviso ao solicitar reset no Google API:', eGoogle.message);
        }

        // Resposta genérica para evitar enumeração de contas e sem vazar oobCode
        return res.json({
            success: true,
            message: 'Se o e-mail informado estiver cadastrado, você receberá um link seguro de redefinição de senha na sua caixa de entrada.'
        });
    } catch (err) {
        console.error("Erro ao solicitar recuperação de senha:", err);
        return res.json({
            success: true,
            message: 'Se o e-mail informado estiver cadastrado, você receberá um link seguro de redefinição de senha na sua caixa de entrada.'
        });
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
if (process.env.NODE_ENV !== 'test') carregarConfiguracoesMercadoPagoFirestore();

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

// Retorna URL de autorização OAuth do Mercado Pago com State Criptográfico Anti-CSRF
app.get('/api/auth/mercadopago/url', verificarAdminMiddleware, (req, res) => {
    const stateNonce = crypto.randomBytes(16).toString('hex');
    const stateTs = Date.now().toString();
    const statePayload = `${stateNonce}.${stateTs}`;
    const stateHmac = crypto.createHmac('sha256', MP_CLIENT_SECRET || 'emaus_oauth_secret')
        .update(statePayload)
        .digest('hex');
    const stateToken = `${statePayload}.${stateHmac}`;

    const authUrl = `https://auth.mercadopago.com/authorization?client_id=${MP_CLIENT_ID}&response_type=code&platform_id=mp&state=${encodeURIComponent(stateToken)}&redirect_uri=${encodeURIComponent(MP_REDIRECT_URI)}`;
    return res.json({ url: authUrl });
});

// Callback oficial do Mercado Pago para troca do código por Access Token
app.get('/api/auth/mercadopago/callback', async (req, res) => {
    const { code, state, error, error_description } = req.query;

    if (error || !code) {
        console.error("Erro no retorno do OAuth Mercado Pago:", error, error_description);
        return res.redirect(`${APP_SITE_URL}/admin.html?mp_status=erro&msg=${encodeURIComponent(error_description || error || 'Autorizacao cancelada')}`);
    }

    // Validação estrita de segurança contra OAuth CSRF
    let stateValido = false;
    if (state && typeof state === 'string') {
        const parts = state.split('.');
        if (parts.length === 3) {
            const [nonce, ts, hmac] = parts;
            const tsNum = Number(ts);
            if (Number.isFinite(tsNum) && Math.abs(Date.now() - tsNum) <= 15 * 60 * 1000) {
                const expectedHmac = crypto.createHmac('sha256', MP_CLIENT_SECRET || 'emaus_oauth_secret')
                    .update(`${nonce}.${ts}`)
                    .digest('hex');
                const bufExp = Buffer.from(expectedHmac, 'utf8');
                const bufAct = Buffer.from(hmac, 'utf8');
                if (bufExp.length === bufAct.length && crypto.timingSafeEqual(bufExp, bufAct)) {
                    stateValido = true;
                }
            }
        }
    }

    if (!stateValido) {
        console.warn(`[OAuth CSRF Bloqueado] Tentativa com state inválido ou expirado: ${state}`);
        return res.redirect(`${APP_SITE_URL}/admin.html?mp_status=erro&msg=${encodeURIComponent('Falha de segurança: Estado OAuth inválido ou expirado (CSRF bloqueado).')}`);
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

// Helper para validar antecedência mínima de 20 minutos e impedir cobranças de horários inválidos
function validarAntecedenciaMinimaAgendamento(dataHora) {
    if (!dataHora || typeof dataHora !== 'string') return { valido: true };
    try {
        const [data, horario] = dataHora.split('T');
        if (!data || !horario) return { valido: true };

        // Obtém data/hora atual no fuso horário oficial de Brasília (America/Sao_Paulo)
        const agoraBrStr = new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' });
        const agoraBr = new Date(agoraBrStr);

        const hojeAno = agoraBr.getFullYear();
        const hojeMes = String(agoraBr.getMonth() + 1).padStart(2, '0');
        const hojeDia = String(agoraBr.getDate()).padStart(2, '0');
        const hojeIso = `${hojeAno}-${hojeMes}-${hojeDia}`;

        // Se a data do agendamento for hoje
        if (data === hojeIso) {
            const [hh, mm] = horario.split(':').map(Number);
            if (isNaN(hh) || isNaN(mm)) return { valido: true };

            const minutosAgendamento = hh * 60 + mm;
            const minutosAgora = agoraBr.getHours() * 60 + agoraBr.getMinutes();

            // 1. Checa se o horário já passou
            if (minutosAgendamento <= minutosAgora) {
                return {
                    valido: false,
                    error: '⚠️ Este horário já passou! Por favor, escolha outro horário disponível.'
                };
            }

            // 2. Trava estrita de antecedência de 20 minutos
            if (minutosAgendamento <= (minutosAgora + 20)) {
                const minRestantes = Math.max(0, minutosAgendamento - minutosAgora);
                return {
                    valido: false,
                    error: `⚡ Horário indisponível: faltam apenas ${minRestantes} minutos para as ${horario}. É necessário no mínimo 20 minutos de antecedência para agendamentos no mesmo dia.`
                };
            }
        }
        return { valido: true };
    } catch (e) {
        console.warn('Aviso ao validar antecedência no backend:', e.message);
        return { valido: true };
    }
}

// Endpoint to create Pix payment
app.post('/api/pagamento/pix', verificarUsuarioMiddleware, async (req, res) => {
    try {
        const { transaction_amount, description, email, nome, cpf, external_reference, dataHora, tipo, dadosCompletos, dadosAgendamento } = req.body;

        if (!transaction_amount || transaction_amount <= 0) {
            return res.status(400).json({ error: 'Valor da transacao invalido.' });
        }

        // Validação estrita de segurança: impede cobrança se faltar 20 min ou menos
        const validacaoTempo = validarAntecedenciaMinimaAgendamento(dataHora);
        if (!validacaoTempo.valido) {
            return res.status(400).json({ error: validacaoTempo.error });
        }

        if (!activeAccessToken || activeAccessToken === 'SEU_ACCESS_TOKEN_AQUI') {
            await carregarConfiguracoesMercadoPagoFirestore();
        }

        if (!activeAccessToken || activeAccessToken === 'SEU_ACCESS_TOKEN_AQUI') {
            return res.status(503).json({
                error: 'Mercado Pago não conectado. É possível solicitar conferência de Pix manual.',
                manualPixAvailable: true
            });
        }

        const nameParts = (nome || 'Cliente Barbearia').trim().split(' ');
        const firstName = nameParts[0] || 'Cliente';
        const lastName = nameParts.slice(1).join(' ') || 'Barbearia';
        const tipoFinal = tipo || (description && description.toLowerCase().includes('produto') ? 'produto' : (description && description.toLowerCase().includes('assinatura') ? 'plano' : 'agendamento'));
        let dadosPayload = dadosCompletos || dadosAgendamento || {
            nome: nome || 'Cliente',
            email: email || '',
            clienteNome: nome || 'Cliente',
            clienteTelefone: (email && email.includes('@cliente.emaus')) ? email.split('@')[0] : '',
            servico: description || 'Corte',
            dataHora: dataHora || '',
            valorCobrado: Number(parseFloat(transaction_amount).toFixed(2))
        };

        const uidAutenticado = req.authUser.uid || req.authUser.user_id;
        dadosPayload = {
            ...dadosPayload,
            userId: uidAutenticado,
            userEmail: req.authUser.email || email || ''
        };

        if (tipoFinal === 'produto') {
            const produtoId = dadosPayload.produto?.id;
            const quantidade = Number(dadosPayload.quantidade || 1);
            if (!firebaseAdminFirestore || !produtoId || !Number.isInteger(quantidade) || quantidade < 1 || quantidade > 20) {
                return res.status(400).json({ error: 'Produto ou quantidade inválida.' });
            }
            const produtoDoc = await firebaseAdminFirestore.collection('produtos').doc(String(produtoId)).get();
            if (!produtoDoc.exists || produtoDoc.data().ativo === false) {
                return res.status(404).json({ error: 'Produto indisponível.' });
            }
            const produtoServidor = produtoDoc.data();
            if (Number(produtoServidor.estoque || 0) < quantidade) {
                return res.status(409).json({ error: 'Estoque insuficiente.' });
            }
            const totalServidor = Number((Number(produtoServidor.preco || 0) * quantidade).toFixed(2));
            if (Math.abs(Number(transaction_amount) - totalServidor) > 0.01) {
                return res.status(400).json({ error: 'Valor da compra divergente do catálogo.' });
            }
            dadosPayload = {
                ...dadosPayload,
                produto: { id: produtoId, nome: produtoServidor.nome || 'Produto', preco: Number(produtoServidor.preco || 0), volumeUnidade: produtoServidor.volumeUnidade || '' },
                quantidade,
                totalPagar: totalServidor
            };
        }

        if (tipoFinal !== 'produto') {
            try {
                dadosPayload = await validarCheckout(
                    firebaseAdminFirestore,
                    dadosPayload,
                    tipoFinal,
                    transaction_amount,
                    ''
                );
            } catch (errPreco) {
                return res.status(errPreco.statusCode || 400).json({
                    error: errPreco.message || 'Valor ou benefício inválido.'
                });
            }
        }

        const metadataMp = {
            tipo: tipoFinal,
            servico: String(dadosPayload.servico || description || 'Corte').slice(0, 100),
            data_hora: String(dadosPayload.dataHora || dataHora || '').slice(0, 50),
            data: String(dadosPayload.data || '').slice(0, 20),
            horario: String(dadosPayload.horario || '').slice(0, 10),
            cliente_nome: String(dadosPayload.clienteNome || nome || 'Cliente').slice(0, 100),
            cliente_telefone: String(dadosPayload.clienteTelefone || '').slice(0, 30),
            user_id: String(dadosPayload.userId || '').slice(0, 100),
            user_email: String(dadosPayload.userEmail || email || '').slice(0, 100),
            barbeiro_id: String(dadosPayload.barbeiroId || 'qualquer').slice(0, 50),
            barbeiro_nome: String(dadosPayload.barbeiroNome || 'Barbearia EMAÚS').slice(0, 100),
            barbeiro_whatsapp: String(dadosPayload.barbeiroWhatsapp || '').slice(0, 30),
            valor_cobrado: Number(parseFloat(transaction_amount).toFixed(2)),
            preco_total: Number(dadosPayload.preco || 0),
            modalidade: String(dadosPayload.modalidade || '').slice(0, 30),
            is_fidelidade: Boolean(dadosPayload.isFidelidade),
            is_aniversario: Boolean(dadosPayload.isAniversario),
            precificado_pelo_servidor: Boolean(dadosPayload.precificadoPeloServidor),
            meta_selos_resgate: Number(dadosPayload.metaSelosResgate || 0),
            ano_resgate_aniversario: Number(dadosPayload.anoResgateAniversario || 0),
            desconto_fidelidade: Number(dadosPayload.descontoFidelidade || 0),
            desconto_aniversario: Number(dadosPayload.descontoAniversario || 0)
        };

        const notificationUrl = `${SELF_URL || 'https://barbearia-app-1bf5.onrender.com'}/api/webhook`;

        const paymentData = {
            transaction_amount: Number(parseFloat(transaction_amount).toFixed(2)),
            description: description || 'Taxa de Reserva - EMAUS Barbearia',
            payment_method_id: 'pix',
            external_reference: external_reference ? String(external_reference) : undefined,
            notification_url: notificationUrl,
            metadata: metadataMp,
            payer: {
                email: email || 'cliente@barbearia.com',
                first_name: firstName,
                last_name: lastName,
                ...(cpf ? { identification: { type: 'CPF', number: cpf.replace(/\D/g, '') } } : {})
            }
        };

        const response = await paymentClient.create({ body: paymentData });

        // Salva a intenção de pagamento no Firestore para confirmação em segundo plano (Webhook / Server Poller)
        if (firebaseAdminFirestore && response && response.id) {
            try {
                const expiraEmDate = new Date(Date.now() + 3 * 60 * 1000).toISOString();
                const agoraIso = new Date().toISOString();

                await firebaseAdminFirestore.collection('pagamentos_pendentes').doc(String(response.id)).set({
                    paymentId: String(response.id),
                    userId: uidAutenticado,
                    tipo: tipoFinal,
                    dados: dadosPayload,
                    status: 'pendente',
                    criadoEm: agoraIso,
                    expiraEm: expiraEmDate,
                    metodo: 'pix_mercadopago'
                }, { merge: true });
                console.log(`[Pagamento Pix] 📝 Intenção pendente registrada no Firestore: ${response.id} (${tipoFinal}) - Expira em 3 min`);
            } catch (errDb) {
                console.warn('[Pagamento Pix] Aviso ao registrar intenção de pagamento pendente:', errDb.message);
            }
        }

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
app.post('/api/pagamento/cartao', verificarUsuarioMiddleware, async (req, res) => {
    try {
        let { token, cardNumber, cardholderName, cardExpirationMonth, cardExpirationYear, securityCode, issuer_id, payment_method_id, transaction_amount, installments, description, email, cpf, tipoCartao, dataHora, tipo, dadosCompletos, dadosAgendamento } = req.body;

        if (!transaction_amount || transaction_amount <= 0) {
            return res.status(400).json({ error: 'Valor da transação inválido.' });
        }

        // Validação estrita de segurança: impede cobrança no cartão se faltar 20 min ou menos
        const validacaoTempo = validarAntecedenciaMinimaAgendamento(dataHora);
        if (!validacaoTempo.valido) {
            return res.status(400).json({ error: validacaoTempo.error });
        }

        if (!activeAccessToken || activeAccessToken === 'SEU_ACCESS_TOKEN_AQUI') {
            await carregarConfiguracoesMercadoPagoFirestore();
        }

        if (!activeAccessToken || activeAccessToken === 'SEU_ACCESS_TOKEN_AQUI') {
            return res.status(500).json({ 
                error: 'Access Token do Mercado Pago não configurado no servidor. Salve as credenciais no painel admin.' 
            });
        }

        const tipoFinal = tipo || (description && description.toLowerCase().includes('produto') ? 'produto' : (description && description.toLowerCase().includes('assinatura') ? 'plano' : 'agendamento'));
        let dadosPayload = dadosCompletos || dadosAgendamento || {
            nome: cardholderName || 'Cliente',
            email: email || '',
            clienteNome: cardholderName || 'Cliente',
            clienteTelefone: (email && email.includes('@cliente.emaus')) ? email.split('@')[0] : '',
            servico: description || 'Corte',
            dataHora: dataHora || '',
            valorCobrado: Number(parseFloat(transaction_amount).toFixed(2))
        };

        const uidAutenticado = req.authUser.uid || req.authUser.user_id;
        dadosPayload = {
            ...dadosPayload,
            userId: uidAutenticado,
            userEmail: req.authUser.email || email || ''
        };

        if (tipoFinal === 'produto') {
            const produtoId = dadosPayload.produto?.id;
            const quantidade = Number(dadosPayload.quantidade || 1);
            if (!firebaseAdminFirestore || !produtoId || !Number.isInteger(quantidade) || quantidade < 1 || quantidade > 20) {
                return res.status(400).json({ error: 'Produto ou quantidade inválida.' });
            }
            const produtoDoc = await firebaseAdminFirestore.collection('produtos').doc(String(produtoId)).get();
            if (!produtoDoc.exists || produtoDoc.data().ativo === false) {
                return res.status(404).json({ error: 'Produto indisponível.' });
            }
            const produtoServidor = produtoDoc.data();
            if (Number(produtoServidor.estoque || 0) < quantidade) {
                return res.status(409).json({ error: 'Estoque insuficiente.' });
            }
            const totalServidor = Number((Number(produtoServidor.preco || 0) * quantidade).toFixed(2));
            if (Math.abs(Number(transaction_amount) - totalServidor) > 0.01) {
                return res.status(400).json({ error: 'Valor da compra divergente do catálogo.' });
            }
            dadosPayload = {
                ...dadosPayload,
                produto: { id: produtoId, nome: produtoServidor.nome || 'Produto', preco: Number(produtoServidor.preco || 0), volumeUnidade: produtoServidor.volumeUnidade || '' },
                quantidade,
                totalPagar: totalServidor
            };
        }

        if (tipoFinal !== 'produto') {
            try {
                const modoCartao = (tipoCartao === 'debito' || payment_method_id?.includes('deb')) ? 'debito' : 'credito';
                dadosPayload = await validarCheckout(
                    firebaseAdminFirestore,
                    dadosPayload,
                    tipoFinal,
                    transaction_amount,
                    modoCartao
                );
            } catch (errPreco) {
                return res.status(errPreco.statusCode || 400).json({
                    error: errPreco.message || 'Valor ou benefício inválido.'
                });
            }
        }

        const metadataMp = {
            tipo: tipoFinal,
            servico: String(dadosPayload.servico || description || 'Corte').slice(0, 100),
            data_hora: String(dadosPayload.dataHora || dataHora || '').slice(0, 50),
            data: String(dadosPayload.data || '').slice(0, 20),
            horario: String(dadosPayload.horario || '').slice(0, 10),
            cliente_nome: String(dadosPayload.clienteNome || cardholderName || 'Cliente').slice(0, 100),
            cliente_telefone: String(dadosPayload.clienteTelefone || '').slice(0, 30),
            user_id: String(dadosPayload.userId || '').slice(0, 100),
            user_email: String(dadosPayload.userEmail || email || '').slice(0, 100),
            barbeiro_id: String(dadosPayload.barbeiroId || 'qualquer').slice(0, 50),
            barbeiro_nome: String(dadosPayload.barbeiroNome || 'Barbearia EMAÚS').slice(0, 100),
            barbeiro_whatsapp: String(dadosPayload.barbeiroWhatsapp || '').slice(0, 30),
            valor_cobrado: Number(parseFloat(transaction_amount).toFixed(2)),
            preco_total: Number(dadosPayload.preco || 0),
            modalidade: String(dadosPayload.modalidade || '').slice(0, 30),
            is_fidelidade: Boolean(dadosPayload.isFidelidade),
            is_aniversario: Boolean(dadosPayload.isAniversario),
            precificado_pelo_servidor: Boolean(dadosPayload.precificadoPeloServidor),
            meta_selos_resgate: Number(dadosPayload.metaSelosResgate || 0),
            ano_resgate_aniversario: Number(dadosPayload.anoResgateAniversario || 0),
            desconto_fidelidade: Number(dadosPayload.descontoFidelidade || 0),
            desconto_aniversario: Number(dadosPayload.descontoAniversario || 0)
        };

        // Conformidade Estrita PCI-DSS:
        // O servidor NUNCA deve receber nem processar PAN (número do cartão) ou CVV em texto plano.
        // A tokenização deve ser realizada exclusivamente client-side via SDK do Mercado Pago.
        if (cardNumber || securityCode) {
            delete req.body.cardNumber;
            delete req.body.securityCode;
            delete req.body.cardExpirationMonth;
            delete req.body.cardExpirationYear;
            cardNumber = null;
            securityCode = null;
            return res.status(400).json({
                error: 'O envio de dados brutos de cartão (PAN/CVV) diretamente ao servidor é proibido por conformidade PCI-DSS. Utilize o token seguro gerado pelo checkout.'
            });
        }

        if (!token || typeof token !== 'string' || !token.trim()) {
            return res.status(400).json({ error: 'Token do cartão seguro é obrigatório para processar o pagamento.' });
        }

        // Detecta bandeira padrão se não enviada
        if (!payment_method_id) {
            payment_method_id = tipoCartao === 'debito' ? 'debvisa' : 'visa';
        }

        const isDebito = tipoCartao === 'debito' || payment_method_id.startsWith('deb');
        const numParcelas = isDebito ? 1 : (Number(installments) || 1);

        const notificationUrl = `${SELF_URL || 'https://barbearia-app-1bf5.onrender.com'}/api/webhook`;

        const paymentData = {
            token,
            issuer_id: issuer_id ? String(issuer_id) : undefined,
            payment_method_id,
            transaction_amount: Number(parseFloat(transaction_amount).toFixed(2)),
            installments: numParcelas,
            description: description || 'EMAÚS Barbearia',
            notification_url: notificationUrl,
            metadata: metadataMp,
            payer: {
                email: email || 'cliente@barbearia.com',
                ...(cpf ? { identification: { type: 'CPF', number: String(cpf).replace(/\D/g, '') } } : {})
            }
        };

        const response = await paymentClient.create({ body: paymentData });

        // Salva a intenção de pagamento no Firestore
        if (firebaseAdminFirestore && response && response.id) {
            try {
                const expiraEmDate = new Date(Date.now() + 3 * 60 * 1000).toISOString();
                const agoraIso = new Date().toISOString();

                await firebaseAdminFirestore.collection('pagamentos_pendentes').doc(String(response.id)).set({
                    paymentId: String(response.id),
                    userId: uidAutenticado,
                    tipo: tipoFinal,
                    dados: dadosPayload,
                    status: 'pendente',
                    criadoEm: agoraIso,
                    expiraEm: expiraEmDate,
                    metodo: isDebito ? 'cartao_debito' : 'cartao_credito'
                }, { merge: true });
                console.log(`[Pagamento Cartão] 📝 Pagamento registrado no Firestore: ${response.id} (${tipoFinal}) status: ${response.status} - Expira em 3 min`);
            } catch (errDb) {
                console.warn('[Pagamento Cartão] Aviso ao registrar pagamento:', errDb.message);
            }
        }

        // Se o pagamento no cartão já foi aprovado imediatamente, processa a conclusão em background
        if (response && response.status === 'approved') {
            processarConclusaoPagamentoServidor(response.id, response, isDebito ? 'cartao_debito' : 'cartao_credito')
                .catch(e => console.warn('[Pagamento Cartão Processamento]:', e.message));
        }

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
app.get('/api/pagamento/status/:id', verificarUsuarioMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        if (!id) return res.status(400).json({ error: 'ID do pagamento obrigatorio.' });

        if (firebaseAdminFirestore && !req.ehAdmin) {
            const pendente = await firebaseAdminFirestore.collection('pagamentos_pendentes').doc(String(id)).get();
            const uid = req.authUser.uid || req.authUser.user_id;
            if (!pendente.exists || pendente.data().userId !== uid) {
                return res.status(403).json({ error: 'Pagamento não pertence ao usuário autenticado.' });
            }
        }

        if (!activeAccessToken || activeAccessToken === 'SEU_ACCESS_TOKEN_AQUI') {
            await carregarConfiguracoesMercadoPagoFirestore();
        }

        // 1. Tenta consulta via SDK oficial do Mercado Pago
        try {
            const response = await paymentClient.get({ id: String(id) });
            if (response && response.status) {
                if (response.status === 'approved') {
                    processarConclusaoPagamentoServidor(id, response, 'pix_mercadopago').catch(e => console.warn('[Status Pix Processamento]:', e.message));
                }
                return res.json({
                    id: response.id,
                    status: response.status,
                    status_detail: response.status_detail,
                    date_approved: response.date_approved
                });
            }
        } catch (sdkErr) {
            console.warn(`[Status Pix] Tentando consulta direta via REST API para ${id}:`, sdkErr.message);
        }

        // 2. Fallback direto via REST API do Mercado Pago
        if (activeAccessToken && activeAccessToken !== 'SEU_ACCESS_TOKEN_AQUI') {
            try {
                const mpRes = await fetch(`https://api.mercadopago.com/v1/payments/${id}`, {
                    headers: { 'Authorization': `Bearer ${activeAccessToken}` }
                });
                const mpData = await mpRes.json();
                if (mpRes.ok && mpData && mpData.status) {
                    if (mpData.status === 'approved') {
                        processarConclusaoPagamentoServidor(id, mpData, 'pix_mercadopago').catch(e => console.warn('[Status Pix Processamento Fallback]:', e.message));
                    }
                    return res.json({
                        id: mpData.id,
                        status: mpData.status,
                        status_detail: mpData.status_detail,
                        date_approved: mpData.date_approved
                    });
                }
            } catch (fetchErr) {
                console.error(`[Status Pix] Erro no fallback REST para ${id}:`, fetchErr.message);
            }
        }

        return res.status(404).json({ error: 'Pagamento não encontrado no Mercado Pago.' });
    } catch (error) {
        console.error(`Erro ao consultar pagamento ${req.params.id}:`, error);
        return res.status(500).json({ error: error.message || 'Erro ao consultar status.' });
    }
});

async function executarEstornoMercadoPagoInterno(paymentId, valor, chave) {
    if (!activeAccessToken || !/^\d+$/.test(String(paymentId)) || !Number.isFinite(valor) || valor <= 0) throw new Error('Estorno indisponível; requer conferência.');
    const result = await refundClient.create({ payment_id: paymentId, body: { amount: valor }, requestOptions: { idempotencyKey: chave } });
    if (!result?.id || result.status !== 'approved' || Math.round(Number(result.amount) * 100) !== Math.round(valor * 100)) throw new Error('Devolução não confirmada pelo Mercado Pago.');
    return { success: true, refundId: result.id, amount: result.amount };
}

// Endpoint to process automatic refund (Devolução Pix ou Estorno Cartão)
app.post('/api/pagamento/estorno', verificarAuthEstornoMiddleware, async (req, res) => {
    try {
        const { paymentId, amount, valorReembolso, reason } = req.body;
        const valorSolicitado = (amount !== undefined && amount !== null) ? amount : valorReembolso;

        if (!paymentId) {
            return res.status(400).json({ success: false, error: 'ID do pagamento obrigatório para estorno.' });
        }

        const cleanPaymentId = String(paymentId).trim();

        // Se for cliente comum (não admin), valida obrigatoriamente se o pagamento pertence a ele
        if (!req.ehAdmin) {
            const userUid = req.authUser?.uid || req.authUser?.user_id;
            const userEmail = req.authUser?.email?.toLowerCase().trim();
            let ehDonoDoPagamento = false;

            if (firebaseAdminFirestore) {
                try {
                    // 1. Checa na coleção agendamentos
                    const agSnap = await firebaseAdminFirestore.collection('agendamentos')
                        .where('idPagamento', '==', cleanPaymentId)
                        .limit(1)
                        .get();
                    if (!agSnap.empty) {
                        const agData = agSnap.docs[0].data();
                        if (agData.userId === userUid || (agData.clienteEmail && agData.clienteEmail.toLowerCase().trim() === userEmail)) {
                            ehDonoDoPagamento = true;
                        }
                    }

                    // 2. Checa na coleção assinaturasClientes
                    if (!ehDonoDoPagamento && userUid) {
                        const subDoc = await firebaseAdminFirestore.collection('assinaturasClientes').doc(userUid).get();
                        if (subDoc.exists && String(subDoc.data().idPagamento || '').trim() === cleanPaymentId) {
                            ehDonoDoPagamento = true;
                        }
                    }

                    // 3. Checa na coleção comprasProdutos
                    if (!ehDonoDoPagamento) {
                        const cpSnap = await firebaseAdminFirestore.collection('comprasProdutos')
                            .where('idPagamento', '==', cleanPaymentId)
                            .limit(1)
                            .get();
                        if (!cpSnap.empty) {
                            const cpData = cpSnap.docs[0].data();
                            if (cpData.userId === userUid || (cpData.email && cpData.email.toLowerCase().trim() === userEmail)) {
                                ehDonoDoPagamento = true;
                            }
                        }
                    }
                } catch (eCheck) {
                    console.warn('[Estorno] Erro ao validar titularidade do pagamento:', eCheck.message);
                }
            }

            if (!ehDonoDoPagamento) {
                console.warn(`[Segurança:Estorno] Tentativa de estorno não autorizada para o pagamento ${cleanPaymentId} pelo usuário ${userEmail} (${userUid})`);
                return res.status(403).json({
                    success: false,
                    error: 'Acesso negado. Este pagamento não pertence à sua conta.'
                });
            }
        }

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
        const requestedAmount = valorSolicitado ? Number(parseFloat(valorSolicitado).toFixed(2)) : 0;
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

// Trava em Memória (Node.js Mutex) para Concorrência Zero entre Webhook e Poller
const locksProcessamentoPagamento = new Set();

// Débito Atômico ACID de Estoque e Registro de Venda no Servidor
async function debitarEstoqueERegistrarVendaBackend(itemVenda, paymentId, metodoPagamento = 'pix_mercadopago', origem = 'loja_direta') {
    if (!firebaseAdminFirestore) return { success: false, reason: 'no_db' };
    const prodId = itemVenda.produtoId || itemVenda.id;
    if (!prodId) return { success: false, reason: 'no_prod_id' };
    const qtd = Number(itemVenda.quantidade || 1);
    if (!Number.isInteger(qtd) || qtd < 1 || qtd > 20) {
        return { success: false, reason: 'invalid_quantity' };
    }
    const cleanPaymentId = String(paymentId || 'manual').trim();
    const compraDocId = `compra_${cleanPaymentId}_${prodId}`;

    try {
        const resultado = await firebaseAdminFirestore.runTransaction(async (transaction) => {
            const prodRef = firebaseAdminFirestore.collection('produtos').doc(prodId);
            const compraRef = firebaseAdminFirestore.collection('comprasProdutos').doc(compraDocId);

            const [prodDoc, compraDoc] = await Promise.all([
                transaction.get(prodRef),
                transaction.get(compraRef)
            ]);
            if (origem === 'carrinho_agendamento') {
                const agenda = await transaction.get(firebaseAdminFirestore.collection('agendamentos').doc(cleanPaymentId));
                if (!agenda.exists || agenda.data().status !== 'confirmado') throw new Error('Agendamento não permite debitar estoque.');
            }

            // Idempotência por Document ID determinístico: se já foi gravada, não debita novamente!
            if (compraDoc.exists) {
                console.log(`[Estoque Backend] ℹ️ Compra ${compraDocId} já registrada anteriormente. Ignorando débito duplicado.`);
                return { success: true, alreadyRecorded: true, compraId: compraDocId };
            }

            if (!prodDoc.exists || prodDoc.data().ativo === false) {
                throw new Error('Produto indisponível.');
            }
            const produtoAtual = prodDoc.data();
            const estAtual = Number(produtoAtual.estoque || 0);
            if (estAtual < qtd) {
                throw new Error('Estoque insuficiente.');
            }
            const novoEstoque = estAtual - qtd;
            const precoCatalogo = Number(produtoAtual.preco || 0);
            transaction.update(prodRef, {
                estoque: novoEstoque,
                atualizadoEm: new Date().toISOString()
            });

            // Grava o registro da compra atomicamente na mesma transação
            transaction.set(compraRef, {
                id: compraDocId,
                userId: itemVenda.userId || '',
                produtoId: prodId,
                produtoNome: produtoAtual.nome || itemVenda.produtoNome || itemVenda.nome || 'Produto',
                volumeUnidade: produtoAtual.volumeUnidade || itemVenda.volumeUnidade || '',
                quantidade: qtd,
                precoUnitario: precoCatalogo,
                valorTotal: Number((precoCatalogo * qtd).toFixed(2)),
                clienteNome: itemVenda.clienteNome || itemVenda.nome || 'Cliente',
                clienteTelefone: itemVenda.clienteTelefone || itemVenda.telefone || '',
                clienteEmail: itemVenda.clienteEmail || itemVenda.email || '',
                origemVenda: origem,
                agendamentoDataHora: itemVenda.agendamentoDataHora || '',
                paymentId: cleanPaymentId,
                status: 'pago',
                metodoPagamento: metodoPagamento || 'pix_mercadopago',
                criadoEm: new Date().toISOString()
            });

            return { success: true, novoEstoque, compraId: compraDocId };
        });

        console.log(`[Estoque Backend] ✅ Transação ACID concluída: Produto ${prodId} (Qtd: ${qtd}) -> Compra ${compraDocId}`);
        return resultado;
    } catch (e) {
        console.error(`[Estoque Backend] ❌ Erro na transação ACID de produto ${prodId}:`, e.message);
        return { success: false, error: e.message };
    }
}

app.post('/api/produtos/restaurar-agendamento', verificarUsuarioMiddleware, async (req, res) => {
    try {
        const id = String(req.body?.agendamentoId || '');
        if (!id || id.includes('/') || !firebaseAdminFirestore) return res.status(400).json({ success: false, error: 'Agendamento inválido.' });
        const snap = await firebaseAdminFirestore.collection('agendamentos').doc(id).get();
        if (!snap.exists) return res.status(404).json({ success: false });
        const ag = snap.data(), uid = req.authUser.uid || req.authUser.user_id;
        if (ag.userId !== uid) return res.status(403).json({ success: false });
        if (!['cancelado', 'reembolsado', 'cancelado_barbeiro'].includes(ag.status)) return res.status(409).json({ success: false, error: 'Cancele pela API de agendamento. Estoque não é devolvido isoladamente.' });
        return res.json({ success: Boolean(ag.estoqueRestauradoEm && !ag.estoqueRequerConferencia), restaurados: 0, alreadyRecorded: true,
            requerConferencia: !ag.estoqueRestauradoEm || !!ag.estoqueRequerConferencia });
    } catch (_) { return res.status(500).json({ success: false, error: 'Consulta indisponível.' }); }
});

// Helper legado
async function restaurarEstoqueProdutoBackend(prodId, qtd) {
    if (!firebaseAdminFirestore || !prodId || qtd <= 0) return;
    try {
        await firebaseAdminFirestore.runTransaction(async (transaction) => {
            const prodRef = firebaseAdminFirestore.collection('produtos').doc(prodId);
            const prodDoc = await transaction.get(prodRef);
            if (prodDoc.exists) {
                const estAtual = Number(prodDoc.data().estoque || 0);
                transaction.update(prodRef, {
                    estoque: estAtual + Number(qtd),
                    atualizadoEm: new Date().toISOString()
                });
            }
        });
        console.log(`[Estoque Backend] ✅ ${qtd} unidade(s) restaurada(s) atomicamente para o produto ${prodId}.`);
    } catch (e) {
        console.warn(`[Estoque Backend] Aviso ao restaurar estoque:`, e.message);
    }
}

// Processamento Centralizado e Idempotente de Pagamentos no Servidor (Background / Webhook)
export async function processarConclusaoPagamentoServidor(paymentId, mpPaymentData = null, metodoPagamento = 'pix_mercadopago') {
    const cleanId = String(paymentId).trim();
    if (!cleanId || !firebaseAdminFirestore) {
        console.warn(`[Pagamento Servidor] Ignorando conclusão: cleanId="${cleanId}", firestore=${!!firebaseAdminFirestore}`);
        return { success: false, reason: 'no_db_or_id' };
    }

    // Camada 1: Mutex em memória do Node.js (bloqueia 2 chamadas simultâneas de Webhook/Poller na mesma instância)
    if (locksProcessamentoPagamento.has(cleanId)) {
        console.log(`[Pagamento Servidor] 🔒 Pagamento ${cleanId} já está sendo processado ativamente por outra thread concorrente. Ignorando chamada redundante.`);
        return { success: true, alreadyProcessing: true };
    }
    locksProcessamentoPagamento.add(cleanId);

    try {
        console.log(`[Pagamento Servidor] 🔄 Iniciando processamento atômico para paymentId: ${cleanId}...`);

        const pendenteRef = firebaseAdminFirestore.collection('pagamentos_pendentes').doc(cleanId);
        
        // Camada 2: Transição de Estados Atômica ACID no Firestore (pendente -> processando)
        let autorizacao = null;
        try {
            autorizacao = await firebaseAdminFirestore.runTransaction(async (transaction) => {
                const pendenteDoc = await transaction.get(pendenteRef);
                const agoraMs = Date.now();

                let pData = pendenteDoc.exists ? pendenteDoc.data() : null;

                if (pData) {
                    if (pData.status === 'processado') {
                        return { podeExecutar: false, reason: 'already_processed', dados: pData.dados, tipo: pData.tipo };
                    }
                    if (pData.status === 'conflito_horario') {
                        return { podeExecutar: false, reason: 'schedule_conflict', dados: pData.dados, tipo: pData.tipo };
                    }
                    if (pData.status === 'processando') {
                        const iniciadoEm = pData.processandoIniciadoEm ? new Date(pData.processandoIniciadoEm).getTime() : 0;
                        // Lock válido por 60 segundos contra travamentos/crashes
                        if (agoraMs - iniciadoEm < 60000) {
                            return { podeExecutar: false, reason: 'already_processing', dados: pData.dados, tipo: pData.tipo };
                        }
                    }
                }

                // Marca atomicamente como "processando"
                transaction.set(pendenteRef, {
                    status: 'processando',
                    processandoIniciadoEm: new Date().toISOString(),
                    metodoPagamento: metodoPagamento,
                    atualizadoEm: new Date().toISOString()
                }, { merge: true });

                return { podeExecutar: true, dados: pData?.dados || null, tipo: pData?.tipo || null };
            });
        } catch (eTxPendente) {
            console.warn('[Pagamento Servidor] Aviso ao obter lock de transação:', eTxPendente.message);
            // Fallback defensivo
            const snap = await pendenteRef.get();
            if (snap.exists && snap.data().status === 'processado') {
                return { success: true, alreadyProcessed: true };
            }
            autorizacao = { podeExecutar: true, dados: snap.exists ? snap.data().dados : null, tipo: snap.exists ? snap.data().tipo : null };
        }

        if (!autorizacao || !autorizacao.podeExecutar) {
            console.log(`[Pagamento Servidor] ℹ️ Pagamento ${cleanId} não deve ser reprocessado (${autorizacao?.reason}).`);
            if (autorizacao?.reason === 'schedule_conflict') {
                return { success: false, reason: 'schedule_conflict', requiresManualResolution: true };
            }
            return { success: true, alreadyProcessed: true };
        }

        // Defesa em profundidade: se pagamentos_pendentes não possuir dados completos, reconstrói a partir do metadata do Mercado Pago
        const meta = mpPaymentData?.metadata || {};
        const tipo = autorizacao.tipo || meta.tipo || (mpPaymentData?.description?.toLowerCase().includes('produto') ? 'produto' : (mpPaymentData?.description?.toLowerCase().includes('assinatura') ? 'plano' : 'agendamento'));
        
        let dados = autorizacao.dados;
        if (!dados && Object.keys(meta).length > 0) {
            console.log(`[Pagamento Servidor] 🛡️ Reconstruindo dados completos do agendamento a partir do metadata do Mercado Pago para ${cleanId}`);
            dados = {
                servico: meta.servico || mpPaymentData?.description || 'Corte',
                preco: Number(meta.preco_total || mpPaymentData?.transaction_amount || 0),
                data: meta.data || '',
                horario: meta.horario || '',
                dataHora: meta.data_hora || (meta.data && meta.horario ? `${meta.data}T${meta.horario}` : ''),
                clienteNome: meta.cliente_nome || mpPaymentData?.payer?.first_name || 'Cliente',
                clienteTelefone: meta.cliente_telefone || '',
                userId: meta.user_id || 'cliente_anonimo',
                userEmail: meta.user_email || mpPaymentData?.payer?.email || '',
                barbeiroId: meta.barbeiro_id || 'qualquer',
                barbeiroNome: meta.barbeiro_nome || 'Barbearia EMAÚS',
                barbeiroWhatsapp: meta.barbeiro_whatsapp || '',
                valorCobrado: Number(meta.valor_cobrado || mpPaymentData?.transaction_amount || 0),
                modalidade: meta.modalidade || '',
                isFidelidade: Boolean(meta.is_fidelidade),
                isAniversario: Boolean(meta.is_aniversario),
                precificadoPeloServidor: Boolean(meta.precificado_pelo_servidor),
                metaSelosResgate: Number(meta.meta_selos_resgate || 0),
                anoResgateAniversario: Number(meta.ano_resgate_aniversario || 0),
                descontoFidelidade: Number(meta.desconto_fidelidade || 0),
                descontoAniversario: Number(meta.desconto_aniversario || 0)
            };
        } else if (!dados) {
            dados = {};
        }

        // 2. Processamento conforme o tipo
        if (tipo === 'agendamento') {
            const agDocRef = firebaseAdminFirestore.collection('agendamentos').doc(cleanId);
            const agDocSnap = await agDocRef.get();

            // Checagem de Idempotência em agendamentos
            if (agDocSnap.exists && ['confirmado', 'cancelado', 'reembolsado', 'cancelado_barbeiro'].includes(agDocSnap.data().status)) {
                console.log(`[Pagamento Servidor] ℹ️ Agendamento ${cleanId} já está confirmado.`);
                await pendenteRef.set({ status: 'processado', processadoEm: new Date().toISOString() }, { merge: true });
                return { success: true, alreadyProcessed: true };
            }

            const { 
                servico, preco, data, horario, modalidade, valorCobrado, 
                extras, produtos, userId, userEmail, clienteNome, clienteTelefone,
                barbeiroId, barbeiroNome, barbeiroWhatsapp,
                isFidelidade, descricaoFidelidade, descontoFidelidade,
                isAniversario, descricaoAniversario, descontoAniversario,
                isPlano
            } = dados;

            const dataHoraCompleta = (data && horario) ? `${data}T${horario}` : (dados.dataHora || '');
            const precoTotalNum = Number(preco || 0);
            const valorEfetivoPago = valorCobrado !== undefined 
                ? Number(valorCobrado) 
                : (modalidade === 'total' ? precoTotalNum : (Number(mpPaymentData?.transaction_amount) || 10.00));
            const listaProdutosAg = Array.isArray(produtos) ? produtos : [];
            const uidFinal = userId || 'cliente_anonimo';
            const nomeFinal = clienteNome || dados.nome || 'Cliente';
            const telFinal = clienteTelefone || dados.telefone || '';

            // Grava ou atualiza documento em agendamentos usando cleanId como Document ID
            const novoAgendamento = {
                userId: uidFinal,
                cliente: nomeFinal,
                telefone: telFinal,
                servico: servico || (dados.servico || 'Corte'),
                preco: precoTotalNum,
                taxaReservaPaga: valorEfetivoPago,
                modalidadePagamento: modalidade || (valorEfetivoPago >= precoTotalNum ? 'total' : 'taxa'),
                idPagamento: cleanId,
                metodoPagamento: metodoPagamento,
                isPlano: isPlano === true,
                semanaPlano: isPlano ? Number(dados.semanaPlano) : null,
                isFidelidade: !!isFidelidade,
                recompensaFidelidade: descricaoFidelidade || '',
                descontoFidelidade: descontoFidelidade || 0,
                isAniversario: !!isAniversario,
                recompensaAniversario: descricaoAniversario || '',
                descontoAniversario: descontoAniversario || 0,
                extras: extras || [],
                produtos: listaProdutosAg,
                barbeiroId: barbeiroId || 'qualquer',
                barbeiroNome: barbeiroNome || 'Barbearia EMAÚS',
                barbeiroWhatsapp: barbeiroWhatsapp || '',
                status: 'confirmado',
                dataHora: dataHoraCompleta,
                confirmadoEm: new Date().toISOString(),
                confirmadoPeloServidor: true
            };

            const slotId = `slot_${dataHoraCompleta}_${barbeiroId || 'principal'}`;
            try {
                await firebaseAdminFirestore.runTransaction(async (t) => {
                    // --- FASE 1: LEITURAS (todas as leituras devem preceder qualquer escrita) ---
                    const agendaAtual = await t.get(agDocRef);
                    if (agendaAtual.exists && ['cancelado', 'reembolsado', 'cancelado_barbeiro'].includes(agendaAtual.data().status)) {
                        throw new Error('Pagamento já vinculado a agendamento cancelado. Requer conferência.');
                    }
                    const slotRef = firebaseAdminFirestore.collection('slots_agendamentos').doc(slotId);
                    const slotDoc = await t.get(slotRef);
                    const donoRef = firebaseAdminFirestore.collection('slots_proprietarios').doc(slotId);
                    const dono = await t.get(donoRef);
                    const subRef = isPlano ? firebaseAdminFirestore.collection('assinaturasClientes').doc(uidFinal) : null;
                    if (subRef) {
                        if (!dados.checkoutMensalValidado) throw new Error('Checkout mensal sem validação. Requer conferência.');
                        validarSemanaPlano((await t.get(subRef)).data(), Number(dados.semanaPlano), dataHoraCompleta);
                    }
                    if (slotDoc.exists) {
                        const sData = slotDoc.data();
                        const pertenceAoMesmoPagamento = String(dono.data()?.paymentId || sData.paymentId || '') === cleanId;
                        if (!pertenceAoMesmoPagamento && (sData.status === 'confirmado' || sData.status === 'pendente' || sData.status === 'pendente_pagamento')) {
                            const erroConflito = new Error('HORARIO_JA_RESERVADO');
                            erroConflito.code = 'HORARIO_JA_RESERVADO';
                            throw erroConflito;
                        }
                    }

                    // Consumo seguro e atômico de benefícios (fidelidade / aniversário)
                    let consumirBeneficios = () => {};
                    if (dados.isFidelidade || dados.isAniversario) {
                        consumirBeneficios = await prepararConsumoBeneficios(firebaseAdminFirestore, t, cleanId, dados);
                    }

                    // --- FASE 2: ESCRITAS (todas as escritas após todas as leituras) ---
                    consumirBeneficios();

                    t.set(slotRef, {
                        slotId: slotId,
                        dataHora: dataHoraCompleta,
                        barbeiroId: barbeiroId || 'principal',
                        barbeiroNome: barbeiroNome || 'Barbearia EMAÚS',
                        status: 'confirmado',
                        expiraEm: null,
                        atualizadoEm: new Date().toISOString()
                    });
                    if (subRef) t.update(subRef, { [`semanas.${Number(dados.semanaPlano)}`]: {
                        status: 'agendado', agendamentoId: cleanId, agendamentoData: dataHoraCompleta, atualizadoEm: new Date().toISOString()
                    } });

                    t.set(firebaseAdminFirestore.collection('slots_proprietarios').doc(slotId), {
                        userId: uidFinal,
                        paymentId: cleanId,
                        atualizadoEm: new Date().toISOString()
                    }, { merge: true });

                    t.set(agDocRef, {
                        ...novoAgendamento,
                        slotId: slotId
                    }, { merge: true });
                });
                console.log(`[Pagamento Servidor] ✅ Agendamento e Slot ${slotId} confirmados atomicamente para ${nomeFinal}!`);
            } catch (eTx) {
                console.warn('[Backend Slot Transaction]:', eTx.message);
                if (eTx.code === 'HORARIO_JA_RESERVADO' || eTx.message === 'HORARIO_JA_RESERVADO') {
                    await pendenteRef.set({
                        status: 'conflito_horario',
                        conflitoHorarioEm: new Date().toISOString(),
                        conflitoDataHora: dataHoraCompleta,
                        conflitoSlotId: slotId,
                        requerResolucaoManual: true
                    }, { merge: true });
                } else if (eTx.code === 'BENEFICIO_INDISPONIVEL' || eTx.message?.includes('Benefício') || eTx.message?.includes('Fidelidade') || eTx.message?.includes('aniversário') || eTx.message?.includes('Saldo de fidelidade')) {
                    await pendenteRef.set({
                        status: 'conflito_beneficio',
                        conflitoBeneficioEm: new Date().toISOString(),
                        motivoConflito: eTx.message,
                        requerResolucaoManual: true
                    }, { merge: true });
                }
                // Nunca confirmar fora da transação: isso reabriria a condição de corrida.
                throw eTx;
            }

            // Debita estoque de produtos adicionais com transação ACID e ID determinístico
            if (listaProdutosAg.length > 0) {
                for (const p of listaProdutosAg) {
                    if (p.id && p.quantidade > 0) {
                        await debitarEstoqueERegistrarVendaBackend({
                            produtoId: p.id,
                            produtoNome: p.nome || '',
                            volumeUnidade: p.volumeUnidade || '',
                            quantidade: Number(p.quantidade || 1),
                            precoUnitario: Number(p.preco || 0),
                            valorTotal: Number(p.preco || 0) * Number(p.quantidade || 1),
                            clienteNome: nomeFinal,
                            clienteTelefone: telFinal,
                            clienteEmail: userEmail || `${telFinal.replace(/\D/g, '')}@cliente.emaus`,
                            agendamentoDataHora: dataHoraCompleta
                        }, cleanId, metodoPagamento, 'carrinho_agendamento');
                    }
                }
            }

            // Fidelidade e aniversário já foram consumidos na transação do agendamento.

            // Dispara notificação de WhatsApp
            try {
                const dataFormatada = dataHoraCompleta ? dataHoraCompleta.replace('T', ' às ') : 'Data a confirmar';
                const numBarbeiroEspecifico = await resolverNumeroBarbeiro(barbeiroWhatsapp);
                const numBarbeiroGeral = await resolverNumeroBarbeiro();
                const numBarbeiroDestino = numBarbeiroEspecifico || numBarbeiroGeral;
                const valorRestante = Math.max(0, precoTotalNum - valorEfetivoPago);

                let produtosTextoBarbeiro = "";
                let produtosTextoCliente = "";
                if (listaProdutosAg.length > 0) {
                    produtosTextoBarbeiro = `\n• *Produtos para Entregar no Balcão:* ` + listaProdutosAg.map(p => `${p.quantidade}x ${p.nome}${p.volumeUnidade ? ` (${p.volumeUnidade})` : ''} (R$ ${Number(p.subtotal || (p.preco * p.quantidade)).toFixed(2)})`).join(', ');
                    produtosTextoCliente = `• *Produtos Adicionados (Retirar no Balcão):* ` + listaProdutosAg.map(p => `${p.quantidade}x ${p.nome} (R$ ${Number(p.subtotal || (p.preco * p.quantidade)).toFixed(2)})`).join(', ') + `\n`;
                }

                if (numBarbeiroDestino) {
                    let tipoPagtoTexto = `Taxa de Reserva Paga (R$ ${valorEfetivoPago.toFixed(2)})`;
                    let restanteBarbeiroTexto = `R$ ${valorRestante.toFixed(2)}`;
                    if (modalidade === 'total' || valorRestante === 0) {
                        tipoPagtoTexto = `Valor Integral Pago Online (R$ ${valorEfetivoPago.toFixed(2)})`;
                        restanteBarbeiroTexto = "R$ 0,00 (Totalmente Quitado)";
                    }

                    const headerBarbeiro = barbeiroNome && barbeiroNome !== 'Qualquer Profissional'
                        ? `*EMAÚS Barbearia - Novo Agendamento (${barbeiroNome})* 📅`
                        : `*EMAÚS Barbearia - Novo Agendamento Confirmado!* 📅`;

                    const msgBarbeiro = `${headerBarbeiro}\n\n` +
                        `• *Cliente:* ${nomeFinal}\n` +
                        `• *Telefone:* ${telFinal || 'Não informado'}\n` +
                        `• *Serviço:* ${servico || 'Corte'}\n` +
                        `• *Data/Hora:* ${dataFormatada}\n` +
                        `• *Profissional:* ${barbeiroNome || 'Barbearia EMAÚS'}\n` +
                        `• *Pagamento:* ${tipoPagtoTexto}\n` +
                        `• *Cobrar no Balcão:* ${restanteBarbeiroTexto}${produtosTextoBarbeiro}\n` +
                        `• *Status:* Confirmado (Mercado Pago)`;

                    await enviarMensagemWhatsApp(numBarbeiroDestino, msgBarbeiro);
                }

                if (telFinal) {
                    let saldoClienteTexto = (modalidade === 'total' || valorRestante === 0)
                        ? `• *Pagamento:* Totalmente Quitado Online (R$ 0,00 restante)\n`
                        : `• *Valor Total:* R$ ${precoTotalNum.toFixed(2)}\n• *Taxa de Reserva Paga:* R$ ${valorEfetivoPago.toFixed(2)}\n• *Restante a Pagar no Atendimento:* R$ ${valorRestante.toFixed(2)}\n`;

                    const msgCliente = `*EMAÚS Barbearia - Confirmação de Agendamento* ✂️\n\n` +
                        `Olá, *${nomeFinal}*!\n` +
                        `Seu agendamento foi confirmado com sucesso.\n\n` +
                        `• *Serviço:* ${servico || 'Corte'}\n` +
                        `• *Data e Horário:* ${dataFormatada}\n` +
                        produtosTextoCliente +
                        saldoClienteTexto +
                        `• *Local:* EMAÚS Barbearia\n\n` +
                        `Agradecemos a preferência. Solicitamos a gentileza de comparecer com alguns minutos de antecedência.\n\n` +
                        `Te esperamos! 💈\n` +
                        `_EMAÚS Barbearia • Estilo e Tradição_`;

                    await enviarMensagemWhatsApp(telFinal, msgCliente);
                }
            } catch (errZap) {
                console.warn('[Pagamento Servidor] Aviso ao disparar WhatsApp automático:', errZap.message);
            }

        } else if (tipo === 'plano') {
            const { plano, userId, userEmail, clienteNome, clienteTelefone } = dados;
            const uidFinal = userId || 'cliente_anonimo';
            const nomeFinal = clienteNome || dados.nome || 'Cliente';
            const telFinal = clienteTelefone || dados.telefone || '';

            const dataPagamento = new Date();
            const dataFim = new Date();
            dataFim.setDate(dataPagamento.getDate() + 30);

            await firebaseAdminFirestore.collection('assinaturasClientes').doc(uidFinal).set({
                userId: uidFinal,
                cliente: nomeFinal,
                telefone: telFinal,
                nomePlano: plano?.nome || 'Plano Mensal VIP',
                precoPlano: Number(plano?.preco || 0),
                servicosInclusos: plano?.servicosInclusos || [],
                dataPagamento: dataPagamento.toISOString(),
                dataFim: dataFim.toISOString(),
                idPagamento: cleanId,
                metodoPagamento: metodoPagamento,
                status: 'ativo',
                atualizadoEm: new Date().toISOString()
            });

            await sincronizarAssinaturaNoCRM(uidFinal, {
                userId: uidFinal,
                cliente: nomeFinal,
                telefone: telFinal,
                userEmail,
                nomePlano: plano?.nome || 'Plano Mensal VIP',
                dataFim: dataFim.toISOString(),
                status: 'ativo'
            });

            console.log(`[Pagamento Servidor] ✅ Assinatura Mensal ativada com sucesso para ${nomeFinal}!`);

            try {
                const numBarbeiro = await resolverNumeroBarbeiro();
                if (numBarbeiro) {
                    const msgBarbeiro = `*EMAÚS Barbearia - Nova Assinatura Mensal!* ✂️\n\n` +
                        `Temos um novo cliente mensalista cadastrado:\n\n` +
                        `• *Cliente:* ${nomeFinal}\n` +
                        `• *Telefone:* ${telFinal || 'Não informado'}\n` +
                        `• *Plano:* ${plano?.nome || 'Plano Mensal'}\n` +
                        `• *Valor Pago:* R$ ${Number(plano?.preco || 0).toFixed(2)}\n` +
                        `• *Validade:* 30 dias (4 atendimentos)`;
                    await enviarMensagemWhatsApp(numBarbeiro, msgBarbeiro);
                }
                if (telFinal) {
                    const msgCliente = `*EMAÚS Barbearia - Assinatura Mensal Confirmada!* ✂️\n\n` +
                        `Parabéns, *${nomeFinal}*! Sua assinatura do plano *${plano?.nome || 'Plano Mensal'}* foi ativada com sucesso.\n\n` +
                        `• *Duração:* 30 dias\n` +
                        `• *Benefício:* 4 cortes (1 corte exclusivo por semana)\n` +
                        `• *Seu corte da Semana 1 já está disponível para agendamento gratuito!*\n\n` +
                        `Agende seus atendimentos diretamente no nosso site:\n` +
                        `👉 ${APP_SITE_URL}\n\n` +
                        `_EMAÚS Barbearia • Estilo e Tradição_`;
                    await enviarMensagemWhatsApp(telFinal, msgCliente);
                }
            } catch (errZap) {
                console.warn('[Pagamento Servidor] Aviso ao disparar WhatsApp de plano:', errZap.message);
            }

        } else if (tipo === 'produto') {
            const { produto, quantidade, totalPagar, nome, telefone, emailComprador, userId } = dados;
            const qtd = Number(quantidade || 1);
            const total = Number(totalPagar || (Number(produto?.preco || 0) * qtd));

            const resVenda = await debitarEstoqueERegistrarVendaBackend({
                produtoId: produto?.id || '',
                userId: userId || '',
                produtoNome: produto?.nome || 'Produto',
                volumeUnidade: produto?.volumeUnidade || '',
                quantidade: qtd,
                precoUnitario: Number(produto?.preco || 0),
                valorTotal: total,
                clienteNome: nome || 'Cliente',
                clienteTelefone: telefone || '',
                clienteEmail: emailComprador || ''
            }, cleanId, metodoPagamento, 'loja_direta');

            if (resVenda.success && !resVenda.alreadyRecorded) {
                try {
                    const numBarbeiro = await resolverNumeroBarbeiro();
                    if (numBarbeiro) {
                        const msgBarbeiro = `🛍️ *EMAÚS Barbearia - Nova Venda de Produto!*\n\n` +
                            `Temos um novo pedido pago pelo site:\n\n` +
                            `• *Cliente:* ${nome || 'Cliente'}\n` +
                            `• *Telefone:* ${telefone || 'Não informado'}\n` +
                            `• *Item:* ${qtd}x ${produto?.nome || 'Produto'} - R$ ${total.toFixed(2)}\n` +
                            `• *Pagamento:* ${metodoPagamento} (Aprovado)`;
                        await enviarMensagemWhatsApp(numBarbeiro, msgBarbeiro);
                    }
                    if (telefone) {
                        const msgCliente = `🛍️ *EMAÚS Barbearia - Pedido Confirmado!*\n\n` +
                            `Olá, *${nome || 'Cliente'}*!\n` +
                            `Seu pedido foi confirmado e o pagamento via ${metodoPagamento} foi aprovado com sucesso.\n\n` +
                            `• *Produto:* ${qtd}x ${produto?.nome || 'Produto'}\n` +
                            `• *Total Pago:* R$ ${total.toFixed(2)}\n\n` +
                            `Você pode retirar seus produtos na barbearia a qualquer momento.\n\n` +
                            `Agradecemos a sua preferência! 💈`;
                        await enviarMensagemWhatsApp(telefone, msgCliente);
                    }
                } catch (errZap) {
                    console.warn('[Pagamento Servidor] Aviso ao disparar WhatsApp de produto:', errZap.message);
                }
            }
        }

        // 3. Transição final de estado: Marca como "processado" em pagamentos_pendentes
        await pendenteRef.set({
            status: 'processado',
            processadoEm: new Date().toISOString()
        }, { merge: true });

        console.log(`[Pagamento Servidor] 🏁 Pagamento ${cleanId} concluído e transicionado para 'processado' com sucesso!`);
        return { success: true, processed: true };

    } catch (errGeral) {
        console.error(`[Pagamento Servidor] ❌ Erro ao processar conclusão para ${cleanId}:`, errGeral);
        return { success: false, error: errGeral.message };
    } finally {
        locksProcessamentoPagamento.delete(cleanId);
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
        if (!MP_WEBHOOK_SECRET) {
            return res.status(503).json({ received: false, reason: 'webhook_not_configured' });
        }

        const xSignature = req.headers['x-signature'] || '';
        const xRequestId = req.headers['x-request-id'] || '';
        const dataId = req.query['data.id'] || req.body?.data?.id || '';

        const signatureParts = xSignature.split(',');
        const tsPart = signatureParts.find(p => p.trim().startsWith('ts='));
        const v1Part = signatureParts.find(p => p.trim().startsWith('v1='));

        if (!tsPart || !v1Part) {
            return res.status(401).json({ received: false, reason: 'missing_signature' });
        }

        const ts = tsPart.split('=')[1];
        const v1 = v1Part.split('=')[1];
        const tsNum = Number(ts);

        // Tolerância máxima de 5 minutos contra Replay Attacks
        if (Number.isFinite(tsNum) && Math.abs(Math.floor(Date.now() / 1000) - tsNum) > 300) {
            return res.status(401).json({ received: false, reason: 'timestamp_expired' });
        }

        const signedManifest = `id:${dataId};request-id:${xRequestId};ts:${ts};`;
        const expectedHmac = crypto.createHmac('sha256', MP_WEBHOOK_SECRET)
            .update(signedManifest)
            .digest('hex');

        const bufExpected = Buffer.from(expectedHmac, 'utf8');
        const bufActual = Buffer.from(String(v1), 'utf8');
        if (bufExpected.length !== bufActual.length || !crypto.timingSafeEqual(bufExpected, bufActual)) {
            console.warn(`[Webhook] Assinatura HMAC diverge. x-request-id: ${xRequestId}`);
            return res.status(401).json({ received: false, reason: 'invalid_signature' });
        }

        const topic = req.query.topic || req.query.type || req.body?.type;
        const rawPaymentId = req.query['data.id'] || req.query.id || req.body?.data?.id;
        const paymentId = String(rawPaymentId || '').trim();

        if (paymentId && /^\d+$/.test(paymentId) && (topic === 'payment' || req.body?.action?.includes('payment') || req.query.topic === 'payment' || req.query.type === 'payment' || !topic)) {
            if (!activeAccessToken || activeAccessToken === 'SEU_ACCESS_TOKEN_AQUI' || activeAccessToken === 'DUMMY_TOKEN') {
                await carregarConfiguracoesMercadoPagoFirestore();
            }
            if (!paymentClient) {
                return res.status(503).json({ received: false, reason: 'payment_client_unavailable' });
            }

            const response = await paymentClient.get({ id: paymentId });
            console.log(`[Webhook] ✅ Pagamento ${paymentId} status: ${response.status} (${response.status_detail})`);

            // Se o status for aprovado, processa a conclusão em background no banco de dados e WhatsApp
            if (response.status === 'approved') {
                const metodo = response.payment_type_id?.includes('card') 
                    ? (response.payment_type_id.includes('deb') ? 'cartao_debito' : 'cartao_credito') 
                    : 'pix_mercadopago';
                await processarConclusaoPagamentoServidor(paymentId, response, metodo);
            }

            // Se o status for rejeitado, cancelado ou expirado, sincroniza e libera reservas pendentes
            if (response.status === 'rejected' || response.status === 'cancelled' || response.status === 'expired') {
                if (firebaseAdminFirestore && paymentId) {
                    try {
                        await firebaseAdminFirestore.collection('pagamentos_pendentes').doc(String(paymentId)).set({
                            status: response.status,
                            statusDetail: response.status_detail || response.status,
                            atualizadoEm: new Date().toISOString()
                        }, { merge: true });

                        // Libera qualquer agendamento pendente associado ao pagamento cancelado/rejeitado
                        const agPendSnap = await firebaseAdminFirestore.collection('agendamentos')
                            .where('idPagamento', '==', String(paymentId))
                            .where('status', '==', 'pendente')
                            .get();
                        
                        agPendSnap.forEach(d => {
                            d.ref.update({
                                status: 'cancelado',
                                motivoCancelamento: `Pagamento ${response.status} no Mercado Pago (${response.status_detail || ''})`,
                                atualizadoEm: new Date().toISOString()
                            }).catch(e => console.warn('[Webhook update agendamento cancelado]:', e.message));
                        });
                    } catch (errCancel) {
                        console.warn('[Webhook Cancel/Reject Sync]:', errCancel.message);
                    }
                }
            }

            // Se o status for estornado/reembolsado, sincroniza automaticamente no banco
            // (removido 'cancelled' daqui: cancelamento já é tratado no bloco acima com status 'cancelado';
            // deixá-lo aqui também sobrescrevia o agendamento para 'reembolsado' mesmo sem reembolso real)
            if (response.status === 'refunded') {
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
// ROTINA CENTRALIZADA E ÚNICA DE AUTO-LIMPEZA (A CADA 3 MINUTOS)
// ==========================================
async function executarAutoLimpezaPendenciasVencidas() {
    if (!firebaseAdminFirestore) return;
    try {
        const agoraMillis = Date.now();
        const limiteVencimentoMillis = agoraMillis - 3 * 60 * 1000; // 3 minutos atrás

        // 1. Limpa pagamentos_pendentes vencidos com conciliação de segurança
        const pendentesSnap = await firebaseAdminFirestore.collection('pagamentos_pendentes')
            .where('status', '==', 'pendente')
            .limit(50)
            .get();

        if (!pendentesSnap.empty) {
            let expiradosQtd = 0;
            let reconciliadosQtd = 0;
            for (const docP of pendentesSnap.docs) {
                const dados = docP.data();
                const pId = dados.paymentId || docP.id;
                let criadoEmMillis = 0;
                if (dados.criadoEm) {
                    if (typeof dados.criadoEm.toMillis === 'function') criadoEmMillis = dados.criadoEm.toMillis();
                    else if (dados.criadoEm._seconds) criadoEmMillis = dados.criadoEm._seconds * 1000;
                    else criadoEmMillis = new Date(dados.criadoEm).getTime();
                }
                let expiraEmMillis = 0;
                if (dados.expiraEm) {
                    if (typeof dados.expiraEm.toMillis === 'function') expiraEmMillis = dados.expiraEm.toMillis();
                    else if (dados.expiraEm._seconds) expiraEmMillis = dados.expiraEm._seconds * 1000;
                    else expiraEmMillis = new Date(dados.expiraEm).getTime();
                }

                const jaVenceu = expiraEmMillis ? (agoraMillis > expiraEmMillis) : (criadoEmMillis > 0 && criadoEmMillis <= limiteVencimentoMillis);
                if (jaVenceu) {
                    // Conciliação de Segurança: Checa status no Mercado Pago caso o Webhook tenha falhado
                    let aprovadoNoMP = false;
                    if (paymentClient && activeAccessToken && activeAccessToken !== 'SEU_ACCESS_TOKEN_AQUI' && activeAccessToken !== 'DUMMY_TOKEN' && pId) {
                        try {
                            const mpRes = await paymentClient.get({ id: pId });
                            if (mpRes && mpRes.status === 'approved') {
                                console.log(`[Reconciliação 3m] ⚡ Pagamento ${pId} detectado como APROVADO no Mercado Pago! Concluindo...`);
                                await processarConclusaoPagamentoServidor(pId, mpRes, dados.metodo || 'pix_mercadopago');
                                aprovadoNoMP = true;
                                reconciliadosQtd++;
                            }
                        } catch (eCheck) {}
                    }

                    if (!aprovadoNoMP) {
                        await docP.ref.set({ status: 'expirado', expiradoEm: new Date().toISOString() }, { merge: true });
                        expiradosQtd++;
                    }
                }
            }
            if (reconciliadosQtd > 0) {
                console.log(`[Auto-Limpeza / Conciliação] ✅ Reconciliados ${reconciliadosQtd} pagamento(s) aprovado(s).`);
            }
            if (expiradosQtd > 0) {
                console.log(`[Auto-Limpeza] 🧹 Expirando ${expiradosQtd} pagamento(s) pendente(s) vencido(s)...`);
            }
        }

        // 2. Limpa agendamentos pendentes órfãos na grade e LIBERA os slots
        const agPendentesSnap = await firebaseAdminFirestore.collection('agendamentos')
            .where('status', '==', 'pendente')
            .limit(50)
            .get();

        if (!agPendentesSnap.empty) {
            let agExpiradosQtd = 0;
            for (const docAg of agPendentesSnap.docs) {
                const dados = docAg.data();
                let criadoEmMillis = 0;
                if (dados.criadoEm) {
                    if (typeof dados.criadoEm.toMillis === 'function') criadoEmMillis = dados.criadoEm.toMillis();
                    else if (dados.criadoEm._seconds) criadoEmMillis = dados.criadoEm._seconds * 1000;
                    else criadoEmMillis = new Date(dados.criadoEm).getTime();
                }
                let expiraEmMillis = 0;
                if (dados.expiraEm) {
                    if (typeof dados.expiraEm.toMillis === 'function') expiraEmMillis = dados.expiraEm.toMillis();
                    else if (dados.expiraEm._seconds) expiraEmMillis = dados.expiraEm._seconds * 1000;
                    else expiraEmMillis = new Date(dados.expiraEm).getTime();
                }

                const jaVenceu = expiraEmMillis ? (agoraMillis > expiraEmMillis) : (criadoEmMillis > 0 && criadoEmMillis <= limiteVencimentoMillis);
                if (jaVenceu) {
                    await docAg.ref.set({
                        status: 'cancelado',
                        motivoCancelamento: 'Expirado por falta de pagamento (3 min)',
                        atualizadoEm: new Date().toISOString()
                    }, { merge: true });

                    // Libera o slot atômico correspondente na grade
                    const slotId = dados.slotId || `slot_${dados.dataHora}_${dados.barbeiroId || 'principal'}`;
                    try {
                        await firebaseAdminFirestore.collection('slots_agendamentos').doc(slotId).delete();
                    } catch (eSlot) {}

                    agExpiradosQtd++;
                }
            }
            if (agExpiradosQtd > 0) {
                console.log(`[Auto-Limpeza] 🧹 Expirando ${agExpiradosQtd} agendamento(s) pendente(s) e liberando slots...`);
            }
        }
    } catch (eClean) {
        console.warn('[Auto-Limpeza Erro]:', eClean.message);
    }
}

// ==========================================
// WORKER ATIVO: CONCILIAÇÃO RÁPIDA DE PAGAMENTOS PENDENTES (15 SEGUNDOS)
// Confirma agendamento mesmo que o cliente feche o site/app para ir ao banco pagar
// ==========================================
let reconciliacaoRapidaEmExecucao = false;
export async function executarConciliacaoRapidaPagamentosPendentes() {
    if (reconciliacaoRapidaEmExecucao || !firebaseAdminFirestore) return;

    reconciliacaoRapidaEmExecucao = true;
    try {
        if (!activeAccessToken || activeAccessToken === 'SEU_ACCESS_TOKEN_AQUI' || activeAccessToken === 'DUMMY_TOKEN') {
            await carregarConfiguracoesMercadoPagoFirestore();
        }
        if (!paymentClient || !activeAccessToken || activeAccessToken === 'SEU_ACCESS_TOKEN_AQUI' || activeAccessToken === 'DUMMY_TOKEN') {
            return;
        }

        const agoraMillis = Date.now();
        const limiteRecenteMillis = agoraMillis - 15 * 60 * 1000; // Últimos 15 minutos

        const snap = await firebaseAdminFirestore.collection('pagamentos_pendentes')
            .where('status', '==', 'pendente')
            .limit(20)
            .get();

        if (snap.empty) return;

        for (const docP of snap.docs) {
            const dados = docP.data();
            const pId = dados.paymentId || docP.id;
            if (!pId || !/^\d+$/.test(String(pId))) continue;

            let criadoEmMillis = 0;
            if (dados.criadoEm) {
                if (typeof dados.criadoEm.toMillis === 'function') criadoEmMillis = dados.criadoEm.toMillis();
                else if (dados.criadoEm._seconds) criadoEmMillis = dados.criadoEm._seconds * 1000;
                else criadoEmMillis = new Date(dados.criadoEm).getTime();
            }

            if (criadoEmMillis > 0 && criadoEmMillis < limiteRecenteMillis) continue;

            try {
                const mpRes = await paymentClient.get({ id: String(pId) });
                if (mpRes && mpRes.status === 'approved') {
                    console.log(`[Worker Background 15s] ⚡ Pagamento ${pId} detectado como APROVADO no Mercado Pago! Concluindo agendamento...`);
                    await processarConclusaoPagamentoServidor(pId, mpRes, dados.metodo || 'pix_mercadopago');
                } else if (mpRes && (mpRes.status === 'cancelled' || mpRes.status === 'rejected')) {
                    console.log(`[Worker Background 15s] ℹ️ Pagamento ${pId} com status ${mpRes.status} no Mercado Pago.`);
                    await docP.ref.set({
                        status: mpRes.status,
                        statusDetail: mpRes.status_detail || mpRes.status,
                        atualizadoEm: new Date().toISOString()
                    }, { merge: true });
                }
            } catch (errCheck) {
                // Silencioso para não poluir logs em oscilações momentâneas de rede
            }
        }
    } catch (e) {
        console.warn('[Worker Background Erro]:', e.message);
    } finally {
        reconciliacaoRapidaEmExecucao = false;
    }
}

if (isMainModule) {
    setInterval(executarConciliacaoRapidaPagamentosPendentes, 15 * 1000).unref();
    setInterval(executarAutoLimpezaPendenciasVencidas, 3 * 60 * 1000).unref();
}

// ==========================================
// ROTAS DE AUTOMAÇÃO DO WHATSAPP (BOT)
// ==========================================

// Retorna apenas status da conexão para clientes sem vazar credenciais ou QR Code
app.get('/api/whatsapp/status-publico', async (req, res) => {
    try {
        const waStatus = await obterStatusWhatsApp();
        return res.json({ status: waStatus?.status || 'disconnected' });
    } catch (e) {
        return res.json({ status: 'disconnected' });
    }
});

// Retorna status atual da conexão e QR Code se disponível (apenas admin)
app.get('/api/whatsapp/status', verificarAdminMiddleware, async (req, res) => {
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
        const force = req.body?.force === true;
        const result = await iniciarWhatsApp({ force });
        return res.json({ success: true, ...result });
    } catch (err) {
        console.error('Erro na rota /api/whatsapp/conectar:', err);
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
        let clean = String(customNumber).trim().replace(/\D/g, '');
        if (!clean.startsWith('55') && (clean.length === 10 || clean.length === 11)) {
            clean = '55' + clean;
        }
        return clean;
    }
    // Consulta dinamicamente a configuração salva no Firestore pelo painel admin
    if (firebaseAdminFirestore) {
        try {
            const snap = await firebaseAdminFirestore.collection('configuracoes').doc('pagamento').get();
            if (snap.exists && snap.data().whatsappAdmin) {
                let clean = String(snap.data().whatsappAdmin).trim().replace(/\D/g, '');
                if (!clean.startsWith('55') && (clean.length === 10 || clean.length === 11)) {
                    clean = '55' + clean;
                }
                if (clean.length >= 10) return clean;
            }
        } catch (_) {}
    }
    return null;
}

// Notificação automática de novo agendamento (Barbeiro + Cliente)
app.post('/api/whatsapp/notificar-agendamento', verificarInternalKeyMiddleware, async (req, res) => {
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
        const numBarbeiroEspecifico = barbeiroWhatsapp
            ? await resolverNumeroBarbeiro(barbeiroWhatsapp)
            : null;
        const numBarbeiroGeral = numBarbeiroEspecifico
            ? null
            : await resolverNumeroBarbeiro(whatsappBarbeiro);
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

        // 1. Mensagem para o Barbeiro (Única)
        let envioBarbeiro = null;
        if (numBarbeiroDestino) {
            let tipoPagtoTexto = `Taxa de Reserva Paga (R$ ${valorPago.toFixed(2)})`;
            let restanteBarbeiroTexto = `R$ ${valorRestante.toFixed(2)}`;

            if (isPlano) {
                tipoPagtoTexto = `Assinatura Mensal (Semana ${semanaPlano || '1'})`;
                restanteBarbeiroTexto = "R$ 0,00 (Plano Mensal - Incluso)";
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
        }

        // 2. Mensagem de Confirmação para o Cliente (se tiver telefone)
        let envioCliente = null;
        if (telefone) {
            let saldoClienteTexto = "";
            if (isPlano) {
                saldoClienteTexto = `• *Plano Mensal:* Corte incluso no pacote (R$ 0,00 restante)\n`;
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

// Notificação de aviso de expiração de corte semanal para assinantes do plano mensal
app.post('/api/whatsapp/lembrete-expiracao-plano', verificarAdminMiddleware, async (req, res) => {
    try {
        const { cliente, telefone, nomePlano, semanaNumero, diasRestantesSemana, dataLimiteSemana } = req.body;
        if (!telefone) {
            return res.status(400).json({ success: false, error: 'Telefone do cliente é obrigatório.' });
        }

        const msgLembrete = `*EMAÚS Barbearia - Aviso de Corte Mensal*\n\n` +
            `Olá, *${cliente || 'Cliente'}*! ✂️\n\n` +
            `Identificamos que você possui *1 atendimento disponível* da *Semana ${semanaNumero || 'atual'}* no seu plano *${nomePlano || 'Plano Mensal'}*.\n\n` +
            `⚠️ *Atenção:* O crédito desta semana expira em *${dataLimiteSemana || 'breve'}* (${diasRestantesSemana || 'poucos'} dias restantes) e não acumula para a próxima semana.\n\n` +
            `Agende seu horário agora mesmo pelo nosso site para garantir o seu atendimento:\n` +
            `👉 ${APP_SITE_URL}\n\n` +
            `_EMAÚS Barbearia • Estilo e Tradição_`;

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
        const lista = Array.isArray(req.body.listaClientes)
            ? req.body.listaClientes
            : (Array.isArray(req.body.clientes) ? req.body.clientes : []);

        if (lista.length === 0) {
            return res.status(400).json({ success: false, error: 'Lista de clientes vazia ou inválida.' });
        }

        const resultados = [];
        let enviadosCount = 0;
        for (const item of lista) {
            if (!item.telefone) continue;
            const msgLembrete = `*EMAÚS Barbearia - Aviso de Corte Mensal*\n\n` +
                `Olá, *${item.cliente || 'Cliente'}*! ✂️\n\n` +
                `Lembramos que o seu corte da *Semana ${item.semanaNumero || 'atual'}* do plano *${item.nomePlano || 'Plano Mensal'}* está *disponível* e expira em *${item.dataLimiteSemana || 'breve'}*.\n\n` +
                `Garanta o seu horário no link abaixo para não perder seu crédito semanal:\n` +
                `👉 ${APP_SITE_URL}\n\n` +
                `_EMAÚS Barbearia_`;

            try {
                const envio = await enviarMensagemWhatsApp(item.telefone, msgLembrete);
                const ok = Boolean(envio && envio.success);
                if (ok) enviadosCount++;
                resultados.push({ cliente: item.cliente, telefone: item.telefone, enviado: ok });
            } catch (errEnvio) {
                resultados.push({ cliente: item.cliente, telefone: item.telefone, enviado: false, error: errEnvio.message });
            }
        }

        return res.json({ success: true, enviados: enviadosCount, total: lista.length, resultados });
    } catch (err) {
        console.error('Erro na rota disparar-lembretes-expiracao-lote:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// Notificação Instantânea de Cancelamento de Agendamento (Barbeiro + Cliente)
app.post('/api/whatsapp/notificar-cancelamento', verificarInternalKeyMiddleware, async (req, res) => {
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
        const numBarbeiro = await resolverNumeroBarbeiro(whatsappBarbeiro);

        // Libera o slot no banco para liberar a grade imediatamente
        if (firebaseAdminFirestore && dataHora) {
            try {
                const bId = req.body.barbeiroId || 'principal';
                const slotId = `slot_${dataHora}_${bId}`;
                await firebaseAdminFirestore.collection('slots_agendamentos').doc(slotId).delete();
                console.log(`[Backend Slot Release] ✅ Slot ${slotId} liberado com sucesso após cancelamento.`);
            } catch (eSlot) {
                console.warn('[Backend Slot Release]:', eSlot.message);
            }
        }

        // 1. Mensagem para o Barbeiro
        let statusEstornoTexto = "Sem estorno (Cancelamento fora do prazo de 3h)";
        if (isPlano) {
            statusEstornoTexto = "Plano Mensal (Crédito semanal restaurado)";
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
                msgCliente += `✂️ *Plano Mensal:* O crédito do seu corte semanal já está disponível para você reagendar quando desejar.\n\n`;
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

// Notificação Instantânea de Compra de Pacote/Plano Mensal (Barbeiro + Cliente)
app.post('/api/whatsapp/notificar-compra-plano', verificarInternalKeyMiddleware, async (req, res) => {
    try {
        const { cliente, telefone, nomePlano, preco, dataFim, whatsappBarbeiro, plano } = req.body;
        const numBarbeiro = await resolverNumeroBarbeiro(whatsappBarbeiro);
        const nomePlanoFinal = nomePlano || plano?.nome || 'Plano Mensal VIP';
        const precoFinal = preco !== undefined ? preco : (plano?.preco || 0);

        // 1. Mensagem para o Barbeiro
        const msgBarbeiro = `*EMAÚS Barbearia - Nova Assinatura Mensal!* ✂️\n\n` +
            `Temos um novo cliente mensalista cadastrado:\n\n` +
            `• *Cliente:* ${cliente || 'Cliente'}\n` +
            `• *Telefone:* ${telefone || 'Não informado'}\n` +
            `• *Plano:* ${nomePlanoFinal}\n` +
            `• *Valor Pago:* R$ ${Number(precoFinal || 0).toFixed(2)}\n` +
            `• *Validade:* 30 dias (4 atendimentos)`;

        let envioBarbeiro = null;
        if (numBarbeiro) {
            envioBarbeiro = await enviarMensagemWhatsApp(numBarbeiro, msgBarbeiro);
        }

        // 2. Mensagem de Boas-Vindas para o Cliente Mensalista
        let envioCliente = null;
        if (telefone) {
            const msgCliente = `*EMAÚS Barbearia - Assinatura VIP Confirmada!* 👑\n\n` +
                `Parabéns, *${cliente || 'Cliente'}*! Sua assinatura do plano *${nomePlanoFinal}* foi ativada com sucesso.\n\n` +
                `• *Duração:* 30 dias\n` +
                `• *Benefício:* 4 cortes (1 corte exclusivo por semana)\n` +
                `• *Seu corte da Semana 1 já está disponível para agendamento gratuito!*\n\n` +
                `Agende seus atendimentos diretamente no nosso site:\n` +
                `👉 ${APP_SITE_URL}\n\n` +
                `_EMAÚS Barbearia • Estilo e Tradição_`;

            envioCliente = await enviarMensagemWhatsApp(telefone, msgCliente);
        }

        return res.json({ success: true, barbeiro: envioBarbeiro, cliente: envioCliente });
    } catch (err) {
        console.error('Erro na rota notificar-compra-plano:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// Sincronização & Migração em Massa de Mensalistas Existentes
app.post('/api/admin/sincronizar-mensalistas', verificarAdminMiddleware, async (req, res) => {
    try {
        if (!firebaseAdminFirestore) {
            return res.status(500).json({ success: false, error: 'Banco de dados Firestore não inicializado no servidor.' });
        }

        // 1. Carrega todos os usuários para mapeamento
        const usersSnap = await firebaseAdminFirestore.collection('usuarios').get();
        const mapaUsuarios = new Map();
        const mapaPorTelefone = new Map();
        const mapaPorEmail = new Map();
        const mapaPorNome = new Map();

        const normStr = (str) => String(str || '').toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();

        usersSnap.forEach(docSnap => {
            const u = docSnap.data();
            const uId = docSnap.id;
            mapaUsuarios.set(uId, { id: uId, ...u });

            if (u.telefone) {
                const telClean = String(u.telefone).replace(/\D/g, '');
                if (telClean) {
                    mapaPorTelefone.set(telClean, { id: uId, ...u });
                    if (telClean.length >= 10 && !telClean.startsWith('55')) {
                        mapaPorTelefone.set('55' + telClean, { id: uId, ...u });
                    }
                    if (telClean.startsWith('55') && telClean.length > 11) {
                        mapaPorTelefone.set(telClean.slice(2), { id: uId, ...u });
                    }
                    if (telClean.length >= 9) {
                        mapaPorTelefone.set(telClean.slice(-9), { id: uId, ...u });
                    }
                    if (telClean.length >= 8) {
                        mapaPorTelefone.set(telClean.slice(-8), { id: uId, ...u });
                    }
                }
            }
            if (u.email) {
                mapaPorEmail.set(u.email.toLowerCase().trim(), { id: uId, ...u });
            }
            if (u.nome) {
                const nNorm = normStr(u.nome);
                if (nNorm.length > 4) {
                    mapaPorNome.set(nNorm, { id: uId, ...u });
                }
            }
        });

        // 2. Carrega todas as assinaturas
        const subSnap = await firebaseAdminFirestore.collection('assinaturasClientes').get();
        let totalAssinaturas = 0;
        let vinculadas = 0;
        let jaVinculadas = 0;
        let naoEncontradas = 0;
        const detalhes = [];

        for (const docSnap of subSnap.docs) {
            totalAssinaturas++;
            const subId = docSnap.id;
            const subData = docSnap.data();

            // Se já está vinculado a um ID de usuário real existente
            if (mapaUsuarios.has(subId)) {
                jaVinculadas++;
                continue;
            }

            // Tenta encontrar o usuário correspondente
            let usuarioAlvo = null;
            if (subData.userId && mapaUsuarios.has(subData.userId)) {
                usuarioAlvo = mapaUsuarios.get(subData.userId);
            }

            if (!usuarioAlvo && subData.telefone) {
                const telClean = String(subData.telefone).replace(/\D/g, '');
                usuarioAlvo = mapaPorTelefone.get(telClean) ||
                              (telClean.length >= 9 ? mapaPorTelefone.get(telClean.slice(-9)) : null) ||
                              (telClean.length >= 8 ? mapaPorTelefone.get(telClean.slice(-8)) : null);
            }

            if (!usuarioAlvo && subId.startsWith('vip_')) {
                const telClean = subId.replace(/^vip_/, '').replace(/\D/g, '');
                usuarioAlvo = mapaPorTelefone.get(telClean) ||
                              (telClean.length >= 9 ? mapaPorTelefone.get(telClean.slice(-9)) : null) ||
                              (telClean.length >= 8 ? mapaPorTelefone.get(telClean.slice(-8)) : null);
            }

            if (!usuarioAlvo && (subData.userEmail || subData.email)) {
                const em = String(subData.userEmail || subData.email).toLowerCase().trim();
                usuarioAlvo = mapaPorEmail.get(em);
            }

            if (!usuarioAlvo && subData.cliente) {
                const nNorm = normStr(subData.cliente);
                if (nNorm.length > 4) {
                    usuarioAlvo = mapaPorNome.get(nNorm);
                }
            }

            if (usuarioAlvo) {
                const targetUid = usuarioAlvo.id;
                const dadosAtualizados = {
                    ...subData,
                    userId: targetUid,
                    cliente: usuarioAlvo.nome || subData.cliente || 'Cliente VIP',
                    telefone: usuarioAlvo.telefone || subData.telefone || '',
                    sincronizadoEm: new Date().toISOString(),
                    atualizadoEm: new Date().toISOString()
                };

                // Grava no documento correto correspondente ao UID do cliente
                await firebaseAdminFirestore.collection('assinaturasClientes').doc(targetUid).set(dadosAtualizados, { merge: true });

                // Se o ID original era um "vip_*" temporário, deleta o temporário para evitar duplicidade
                if (subId !== targetUid && subId.startsWith('vip_')) {
                    try {
                        await firebaseAdminFirestore.collection('assinaturasClientes').doc(subId).delete();
                    } catch (eDel) {
                        console.warn('[Sync Mensalistas] Aviso ao remover documento antigo:', eDel.message);
                    }
                }

                vinculadas++;
                detalhes.push({
                    origemId: subId,
                    usuarioId: targetUid,
                    cliente: usuarioAlvo.nome || subData.cliente,
                    status: 'migrado'
                });
            } else {
                naoEncontradas++;
                detalhes.push({
                    origemId: subId,
                    cliente: subData.cliente,
                    telefone: subData.telefone,
                    status: 'pendente_cadastro'
                });
            }
        }

        console.log(`[Sync Mensalistas] ✅ Sincronização concluída: ${vinculadas} assinaturas vinculadas com sucesso.`);
        return res.json({
            success: true,
            totalAssinaturas,
            vinculadas,
            jaVinculadas,
            naoEncontradas,
            detalhes
        });
    } catch (err) {
        console.error('Erro na sincronização de mensalistas:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// Notificação Instantânea de Compra de Produtos da Barbearia (Barbeiro + Cliente)
app.post('/api/whatsapp/notificar-compra-produto', verificarInternalKeyMiddleware, async (req, res) => {
    try {
        const {
            cliente,
            telefone,
            produtos,
            valorTotal,
            metodoPagamento,
            whatsappBarbeiro
        } = req.body;

        const numBarbeiro = await resolverNumeroBarbeiro(whatsappBarbeiro);
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

// ==========================================
// ROTAS DE GALERIA DE CORTES (FIREBASE ADMIN)
// ==========================================
// Salvar foto requer privilégios de administrador autenticado (barbeiro logado no painel)
app.post('/api/galeria/salvar', verificarAdminMiddleware, async (req, res) => {
    try {
        const { clienteId, clienteNome, clienteTelefone, barbeiroNome, estiloCorte, observacao, fotoUrl } = req.body;
        if (!clienteNome || !fotoUrl) {
            return res.status(400).json({ success: false, error: 'Nome do cliente e foto são obrigatórios.' });
        }

        const agora = new Date();
        const dataHoraFormatada = `${String(agora.getDate()).padStart(2, '0')}/${String(agora.getMonth() + 1).padStart(2, '0')}/${agora.getFullYear()} às ${String(agora.getHours()).padStart(2, '0')}:${String(agora.getMinutes()).padStart(2, '0')}`;
        const telLimpo = clienteTelefone ? clienteTelefone.replace(/\D/g, '') : '';

        const docData = {
            clienteId: clienteId || '',
            clienteNome,
            clienteTelefone: clienteTelefone || '',
            clienteTelefoneLimpo: telLimpo,
            barbeiroNome: barbeiroNome || 'Aldo Rodrigues',
            estiloCorte: estiloCorte || 'Corte EMAÚS Barbearia',
            observacao: observacao || '',
            fotoUrl,
            dataCriacao: agora.toISOString(),
            dataHoraFormatada
        };

        if (firebaseAdminFirestore) {
            const ref = await firebaseAdminFirestore.collection('galeria_cortes_clientes').add(docData);
            return res.json({ success: true, id: ref.id, ...docData });
        } else {
            return res.status(500).json({ success: false, error: 'Firestore Admin SDK não inicializado no servidor.' });
        }
    } catch (e) {
        console.error('Erro em /api/galeria/salvar:', e);
        return res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/api/galeria/listar', verificarAdminMiddleware, async (req, res) => {
    try {
        const { clienteId, telefone } = req.query;
        if (!firebaseAdminFirestore) {
            return res.json({ success: true, fotos: [] });
        }

        let query = firebaseAdminFirestore.collection('galeria_cortes_clientes');
        
        if (clienteId) {
            query = query.where('clienteId', '==', String(clienteId));
        } else if (telefone) {
            const telLimpo = String(telefone).replace(/\D/g, '');
            query = query.where('clienteTelefoneLimpo', '==', telLimpo);
        }

        const snap = await query.get();
        const fotos = [];
        snap.forEach(doc => {
            fotos.push({ id: doc.id, ...doc.data() });
        });

        fotos.sort((a, b) => new Date(b.dataCriacao || 0) - new Date(a.dataCriacao || 0));
        return res.json({ success: true, fotos });
    } catch (e) {
        console.error('Erro em /api/galeria/listar:', e);
        return res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/galeria/excluir', verificarAdminMiddleware, async (req, res) => {
    try {
        const { id } = req.body;
        if (!id) return res.status(400).json({ success: false, error: 'ID da foto é obrigatório.' });
        if (firebaseAdminFirestore) {
            await firebaseAdminFirestore.collection('galeria_cortes_clientes').doc(id).delete();
            return res.json({ success: true });
        }
        return res.status(500).json({ success: false, error: 'Banco de dados não disponível.' });
    } catch (e) {
        console.error('Erro em /api/galeria/excluir:', e);
        return res.status(500).json({ success: false, error: e.message });
    }
});

// ==========================================
// MÓDULO: CRM DE CLIENTES (ADMIN SDK)
// ==========================================

async function montarDadosClienteComAssinatura(assinaturaId, assinatura) {
    const clienteId = String(assinatura.userId || assinaturaId || '').trim();
    if (!clienteId) throw new Error('Assinatura sem identificador de cliente.');

    const clienteRef = firebaseAdminFirestore.collection('clientes').doc(clienteId);
    const usuarioRef = firebaseAdminFirestore.collection('usuarios').doc(clienteId);
    const [clienteSnap, usuarioSnap] = await Promise.all([clienteRef.get(), usuarioRef.get()]);
    const clienteAtual = clienteSnap.exists ? clienteSnap.data() : {};
    const usuario = usuarioSnap.exists ? usuarioSnap.data() : {};
    const ativo = assinaturaMensalEstaAtiva(assinatura);
    const tags = Array.isArray(clienteAtual.tags)
        ? [...clienteAtual.tags]
        : (Array.isArray(usuario.tags) ? [...usuario.tags] : []);
    const tagsSemVip = tags.filter(tag => String(tag).trim().toLowerCase() !== 'vip');
    if (ativo) tagsSemVip.push('VIP');

    return {
        clienteRef,
        dados: {
            nome: clienteAtual.nome || usuario.nome || usuario.displayName || assinatura.cliente || 'Cliente',
            nomeNormalizado: String(clienteAtual.nome || usuario.nome || usuario.displayName || assinatura.cliente || 'Cliente')
                .toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim(),
            telefone: clienteAtual.telefone || usuario.telefone || assinatura.telefone || '',
            telefoneNormalizado: normalizarTelefoneCRMServidor(clienteAtual.telefone || usuario.telefone || assinatura.telefone),
            email: clienteAtual.email || usuario.email || assinatura.userEmail || assinatura.email || '',
            emailNormalizado: String(clienteAtual.email || usuario.email || assinatura.userEmail || assinatura.email || '').toLowerCase().trim(),
            status: clienteAtual.status || usuario.status || 'ativo',
            tags: tagsSemVip,
            isVip: ativo,
            planoAtivoId: ativo ? assinaturaId : null,
            planoStatus: ativo ? 'ativo' : String(assinatura.status || 'inativo').toLowerCase(),
            nomePlanoAtivo: ativo ? (assinatura.nomePlano || 'Plano Mensal') : null,
            planoDataFim: ativo ? (assinatura.dataFim || null) : null,
            updatedAt: new Date().toISOString(),
            ...(clienteSnap.exists ? {} : { createdAt: new Date().toISOString() })
        }
    };
}

async function sincronizarAssinaturaNoCRM(assinaturaId, assinatura) {
    if (!firebaseAdminFirestore) return;
    const { clienteRef, dados } = await montarDadosClienteComAssinatura(assinaturaId, assinatura);
    await clienteRef.set(dados, { merge: true });
}

app.post('/api/admin/mensalistas/ativar', verificarAdminMiddleware, async (req, res) => {
    try {
        if (!firebaseAdminFirestore) {
            return res.status(500).json({ success: false, error: 'Firestore Admin SDK não inicializado.' });
        }
        let userId = String(req.body?.userId || '').trim();
        const userEmail = normalizarEmailCRMServidor(req.body?.userEmail || req.body?.email);
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(userEmail) || userId.includes('/')) return res.status(400).json({ success: false, error: 'Informe um e-mail válido do cliente.' });
        let vinculadoUid = null;
        try {
            const conta = await firebaseAdminAuth.getUserByEmail(userEmail);
            if (userId && userId !== conta.uid && !userId.startsWith('mensal_')) return res.status(409).json({ success: false, error: 'O cliente selecionado não corresponde ao e-mail. Confira o cadastro.' });
            userId = conta.uid;
            vinculadoUid = conta.uid;
        } catch (e) {
            if (e.code !== 'auth/user-not-found') throw e;
            // O identificador de uma conta existente nunca é ocupado por e-mail de outra pessoa.
            if (userId) {
                try { await firebaseAdminAuth.getUser(userId); return res.status(409).json({ success: false, error: 'O e-mail não corresponde à conta selecionada.' }); }
                catch (err) { if (err.code !== 'auth/user-not-found') throw err; }
            }
            userId = 'mensal_' + crypto.createHash('sha256').update(userEmail).digest('hex').slice(0, 32);
        }
        const cliente = String(req.body?.cliente || '').trim();
        const telefone = String(req.body?.telefone || '').trim();
        const planoId = String(req.body?.planoId || '').trim();
        const nomePlano = String(req.body?.nomePlano || 'Plano Mensal').trim();
        const servicosInclusos = Array.isArray(req.body?.servicosInclusos) ? req.body.servicosInclusos : [];
        const dataPagamento = new Date(req.body?.dataPagamento || Date.now());
        const dataFim = new Date(req.body?.dataFim || (dataPagamento.getTime() + 30 * 86400000));
        const precoPlano = Number(req.body?.precoPlano || 0);
        if (!userId || !cliente || !telefone || !planoId || Number.isNaN(dataPagamento.getTime()) || Number.isNaN(dataFim.getTime())) {
            return res.status(400).json({ success: false, error: 'Dados obrigatórios da assinatura são inválidos.' });
        }

        const assinatura = {
            userId,
            userEmail,
            emailNormalizado: userEmail,
            vinculadoUid,
            cliente,
            telefone,
            planoId,
            nomePlano,
            precoPlano,
            servicosInclusos,
            dataPagamento: dataPagamento.toISOString(),
            dataFim: dataFim.toISOString(),
            idPagamento: String(req.body?.idPagamento || `manual_admin_${Date.now()}`),
            metodoPagamento: String(req.body?.metodoPagamento || 'Balcão'),
            status: 'ativo',
            ativadoPorAdmin: true,
            ativadoPor: req.adminUser?.email || req.adminUser?.uid || 'admin',
            atualizadoEm: new Date().toISOString()
        };
        const { clienteRef, dados } = await montarDadosClienteComAssinatura(userId, assinatura);
        const ciclo = await gravarCicloMensal(firebaseAdminFirestore, userId, assinatura, clienteRef, dados);
        return res.json({ success: true, userId, status: 'ativo', ...ciclo });
    } catch (e) {
        console.error('Erro em /api/admin/mensalistas/ativar:', e);
        return res.status(e.statusCode || 500).json({ success: false, error: e.statusCode ? e.message : 'Erro ao ativar e sincronizar mensalista.' });
    }
});

app.post('/api/admin/mensalistas/sincronizar', verificarAdminMiddleware, async (req, res) => {
    try {
        if (!firebaseAdminFirestore) {
            return res.status(500).json({ success: false, error: 'Firestore Admin SDK não inicializado.' });
        }
        const [subsSnap, clientesSnap] = await Promise.all([
            firebaseAdminFirestore.collection('assinaturasClientes').get(),
            firebaseAdminFirestore.collection('clientes').get()
        ]);
        const idsAtivos = new Set();
        let sincronizados = 0;
        let ativos = 0;

        for (const subDoc of subsSnap.docs) {
            const assinatura = subDoc.data();
            if (assinaturaMensalEstaAtiva(assinatura)) {
                idsAtivos.add(String(assinatura.userId || subDoc.id));
                ativos += 1;
            }
            await sincronizarAssinaturaNoCRM(subDoc.id, assinatura);
            sincronizados += 1;
        }

        for (const clienteDoc of clientesSnap.docs) {
            const dados = clienteDoc.data();
            if ((dados.isVip === true || dados.planoAtivoId) && !idsAtivos.has(clienteDoc.id)) {
                const tags = Array.isArray(dados.tags)
                    ? dados.tags.filter(tag => String(tag).trim().toLowerCase() !== 'vip')
                    : [];
                await clienteDoc.ref.set({
                    isVip: false,
                    planoAtivoId: null,
                    planoStatus: 'inativo',
                    nomePlanoAtivo: null,
                    planoDataFim: null,
                    tags,
                    updatedAt: new Date().toISOString()
                }, { merge: true });
            }
        }

        return res.json({ success: true, sincronizados, ativos });
    } catch (e) {
        console.error('Erro em /api/admin/mensalistas/sincronizar:', e);
        return res.status(500).json({ success: false, error: 'Erro ao sincronizar mensalistas com o CRM.' });
    }
});

export async function executarBatchEmLotes(firestore, itens, operacaoFn, tamanhoLote = 400) {
    if (!Array.isArray(itens) || itens.length === 0) return;
    for (let i = 0; i < itens.length; i += tamanhoLote) {
        const pedaco = itens.slice(i, i + tamanhoLote);
        const batch = firestore.batch();
        for (const item of pedaco) {
            operacaoFn(batch, item);
        }
        await batch.commit();
    }
}

export async function sincronizarEListarBaseCRM(firestore, persistirAlteracoes = true) {
    const [clientesSnap, uSnap, agSnap, subSnap] = await Promise.all([
        firestore.collection('clientes').get(),
        firestore.collection('usuarios').get(),
        firestore.collection('agendamentos').get(),
        firestore.collection('assinaturasClientes').get().catch(() => ({ docs: [], forEach: () => {} }))
    ]);

    const mapaAgendamentos = new Map();
    const clientesDeAgendamentos = new Map();

    agSnap.forEach(d => {
        const ag = d.data();
        const tel = normalizarTelefoneCRMServidor(ag.telefone || ag.clienteTelefone || ag.tel);
        const email = normalizarEmailCRMServidor(ag.clienteEmail || ag.email);
        const uid = String(ag.userId || ag.clienteId || '').trim();
        const nome = String(ag.clienteNome || ag.cliente || ag.nome || '').trim();

        const chaves = [tel, email, uid].filter(Boolean);
        if (chaves.length === 0) return;

        const cancelado = ag.status === 'cancelado' || ag.status === 'cancelado_barbeiro';
        const preco = Number(ag.preco) || Number(ag.valorPago) || 0;
        const dataHora = ag.dataHora || null;

        chaves.forEach(ch => {
            if (!mapaAgendamentos.has(ch)) {
                mapaAgendamentos.set(ch, {
                    total: 0,
                    concluidos: 0,
                    cancelados: 0,
                    gastoCentavos: 0,
                    ultimoAtendimento: null
                });
            }
            const s = mapaAgendamentos.get(ch);
            s.total++;
            if (cancelado) {
                s.cancelados++;
            } else {
                s.concluidos++;
                s.gastoCentavos += Math.round(preco * 100);
            }
            if (dataHora && (!s.ultimoAtendimento || dataHora > s.ultimoAtendimento)) {
                s.ultimoAtendimento = dataHora;
            }
        });

        if (tel && !clientesDeAgendamentos.has(tel)) {
            clientesDeAgendamentos.set(tel, {
                id: `cli_ag_${tel}`,
                nome: nome || 'Cliente',
                telefone: ag.telefone || ag.clienteTelefone || tel,
                telefoneNormalizado: tel,
                email: email,
                emailNormalizado: email,
                createdAt: ag.dataHora || ag.createdAt || new Date().toISOString()
            });
        }
    });

    const assinantesVipSet = new Set();
    const assinaturasAtivasMap = new Map();
    const assinaturasPorId = new Map();
    const assinaturasPorTelefone = new Map();

    subSnap.forEach(d => {
        const sub = d.data();
        const assinaturaComId = { id: d.id, ...sub };
        const tel = normalizarTelefoneCRMServidor(sub.telefone || sub.clienteTelefone);
        const idKey = String(sub.userId || d.id);
        assinaturasPorId.set(idKey, assinaturaComId);
        if (tel) assinaturasPorTelefone.set(tel, assinaturaComId);

        if (assinaturaMensalEstaAtiva(sub)) {
            if (tel) {
                assinantesVipSet.add(tel);
                assinaturasAtivasMap.set(tel, assinaturaComId);
            }
            if (d.id) {
                assinantesVipSet.add(d.id);
                assinaturasAtivasMap.set(d.id, assinaturaComId);
            }
            if (sub.userId) {
                assinantesVipSet.add(String(sub.userId));
                assinaturasAtivasMap.set(String(sub.userId), assinaturaComId);
            }
        }
    });

    // 1. Carrega clientes existentes preservando notas manuais e tags customizadas
    let listaClientesRaw = [];
    const chavesExistentes = new Set();

    clientesSnap.forEach(doc => {
        const c = { id: doc.id, ...doc.data() };
        listaClientesRaw.push(c);
        chavesExistentes.add(`id:${c.id}`);
        const tel = normalizarTelefoneCRMServidor(c.telefone || c.telefoneNormalizado);
        const em = normalizarEmailCRMServidor(c.email || c.emailNormalizado);
        if (tel) chavesExistentes.add(`tel:${tel}`);
        if (em) chavesExistentes.add(`email:${em}`);
    });

    // 2. Adiciona usuários da coleção 'usuarios' que ainda não estão no CRM
    uSnap.forEach(d => {
        const u = d.data();
        const telLimpo = normalizarTelefoneCRMServidor(u.telefone || u.tel);
        const emailLimpo = normalizarEmailCRMServidor(u.email);
        const jaExiste = chavesExistentes.has(`id:${d.id}`)
            || (telLimpo && chavesExistentes.has(`tel:${telLimpo}`))
            || (emailLimpo && chavesExistentes.has(`email:${emailLimpo}`));

        if (jaExiste) return;

        const stats = (telLimpo && mapaAgendamentos.get(telLimpo))
            || (emailLimpo && mapaAgendamentos.get(emailLimpo))
            || mapaAgendamentos.get(d.id)
            || { total: 0, concluidos: 0, cancelados: 0, gastoCentavos: 0, ultimoAtendimento: null };

        const isVip = assinantesVipSet.has(telLimpo) || assinantesVipSet.has(d.id);
        const assinaturaAtiva = assinaturasAtivasMap.get(d.id) || (telLimpo && assinaturasAtivasMap.get(telLimpo)) || null;
        const tags = Array.isArray(u.tags) ? [...u.tags] : [];
        if (isVip && !tags.some(tag => String(tag).toLowerCase() === 'vip')) tags.push('VIP');
        if (stats.total >= 3 && !tags.some(tag => String(tag).toLowerCase() === 'frequente')) tags.push('Frequente');

        const clienteDoc = {
            id: d.id,
            nome: u.nome || u.displayName || 'Cliente',
            nomeNormalizado: String(u.nome || u.displayName || 'Cliente').toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim(),
            telefone: u.telefone || '',
            telefoneNormalizado: telLimpo,
            email: u.email || '',
            emailNormalizado: emailLimpo,
            status: 'ativo',
            tags,
            observacoes: u.observacoes || '',
            dataNascimento: u.dataNascimento || '',
            ultimoAgendamentoEm: stats.ultimoAtendimento || null,
            totalAgendamentos: stats.total,
            totalConcluidos: stats.concluidos,
            totalCancelados: stats.cancelados,
            totalGastoCentavos: stats.gastoCentavos,
            isVip,
            planoAtivoId: assinaturaAtiva?.id || null,
            planoStatus: assinaturaAtiva ? 'ativo' : 'inativo',
            nomePlanoAtivo: assinaturaAtiva?.nomePlano || null,
            planoDataFim: assinaturaAtiva?.dataFim || null,
            createdAt: u.createdAt || new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        listaClientesRaw.push(clienteDoc);
        chavesExistentes.add(`id:${d.id}`);
        if (telLimpo) chavesExistentes.add(`tel:${telLimpo}`);
        if (emailLimpo) chavesExistentes.add(`email:${emailLimpo}`);
    });

    // 3. Adiciona clientes de agendamentos avulsos/balcão
    clientesDeAgendamentos.forEach((cliAg, tel) => {
        const jaExiste = chavesExistentes.has(`id:${cliAg.id}`)
            || chavesExistentes.has(`tel:${tel}`)
            || (cliAg.emailNormalizado && chavesExistentes.has(`email:${cliAg.emailNormalizado}`));
        if (jaExiste) return;

        const stats = mapaAgendamentos.get(tel) || { total: 0, concluidos: 0, cancelados: 0, gastoCentavos: 0, ultimoAtendimento: null };
        const assinaturaAtiva = assinaturasAtivasMap.get(tel) || null;
        const isVip = Boolean(assinaturaAtiva);
        const tags = [];
        if (isVip) tags.push('VIP');
        if (stats.total >= 3) tags.push('Frequente');

        const clienteDoc = {
            id: cliAg.id,
            nome: cliAg.nome || 'Cliente',
            nomeNormalizado: String(cliAg.nome || 'Cliente').toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim(),
            telefone: cliAg.telefone || '',
            telefoneNormalizado: tel,
            email: cliAg.email || '',
            emailNormalizado: cliAg.emailNormalizado || '',
            status: 'ativo',
            tags,
            observacoes: '',
            dataNascimento: '',
            ultimoAgendamentoEm: stats.ultimoAtendimento || null,
            totalAgendamentos: stats.total,
            totalConcluidos: stats.concluidos,
            totalCancelados: stats.cancelados,
            totalGastoCentavos: stats.gastoCentavos,
            isVip,
            planoAtivoId: assinaturaAtiva?.id || null,
            planoStatus: assinaturaAtiva ? 'ativo' : 'inativo',
            nomePlanoAtivo: assinaturaAtiva?.nomePlano || null,
            planoDataFim: assinaturaAtiva?.dataFim || null,
            createdAt: cliAg.createdAt || new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        listaClientesRaw.push(clienteDoc);
        chavesExistentes.add(`id:${cliAg.id}`);
        chavesExistentes.add(`tel:${tel}`);
        if (cliAg.emailNormalizado) chavesExistentes.add(`email:${cliAg.emailNormalizado}`);
    });

    // 4. Adiciona mensalistas que não constavam nas coleções anteriores
    subSnap.forEach(d => {
        const sub = d.data();
        const assinatura = { id: d.id, ...sub };
        const clienteId = String(assinatura.userId || d.id);
        const telLimpo = normalizarTelefoneCRMServidor(assinatura.telefone || assinatura.clienteTelefone);
        const emailLimpo = normalizarEmailCRMServidor(assinatura.userEmail || assinatura.email);

        const jaExiste = chavesExistentes.has(`id:${clienteId}`)
            || (telLimpo && chavesExistentes.has(`tel:${telLimpo}`))
            || (emailLimpo && chavesExistentes.has(`email:${emailLimpo}`));
        if (jaExiste) return;

        const ativo = assinaturaMensalEstaAtiva(assinatura);
        const clienteDoc = {
            id: clienteId,
            nome: assinatura.cliente || 'Cliente Mensalista',
            nomeNormalizado: String(assinatura.cliente || 'Cliente Mensalista').toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim(),
            telefone: assinatura.telefone || '',
            telefoneNormalizado: telLimpo,
            email: assinatura.userEmail || assinatura.email || '',
            emailNormalizado: emailLimpo,
            status: 'ativo',
            tags: ativo ? ['VIP'] : [],
            isVip: ativo,
            planoAtivoId: ativo ? assinatura.id : null,
            planoStatus: ativo ? 'ativo' : String(assinatura.status || 'inativo').toLowerCase(),
            nomePlanoAtivo: assinatura.nomePlano || null,
            planoDataFim: assinatura.dataFim || null,
            assinaturaAtiva: ativo ? assinatura : null,
            totalAgendamentos: 0,
            totalConcluidos: 0,
            totalCancelados: 0,
            totalGastoCentavos: 0,
            createdAt: assinatura.dataPagamento || assinatura.atualizadoEm || new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        listaClientesRaw.push(clienteDoc);
        chavesExistentes.add(`id:${clienteId}`);
        if (telLimpo) chavesExistentes.add(`tel:${telLimpo}`);
        if (emailLimpo) chavesExistentes.add(`email:${emailLimpo}`);
    });

    // 5. Atualiza status de assinatura e estatísticas acumuladas preservando notas e tags customizadas
    const listaAtualizada = listaClientesRaw.map(cliente => {
        const tel = normalizarTelefoneCRMServidor(cliente.telefone || cliente.telefoneNormalizado);
        const em = normalizarEmailCRMServidor(cliente.email || cliente.emailNormalizado);
        const idStr = String(cliente.id);

        const assinatura = assinaturasPorId.get(idStr) || (tel && assinaturasPorTelefone.get(tel));
        const stats = (tel && mapaAgendamentos.get(tel)) || (em && mapaAgendamentos.get(em)) || mapaAgendamentos.get(idStr);

        let clienteModificado = { ...cliente };

        if (stats) {
            clienteModificado.totalAgendamentos = Math.max(Number(clienteModificado.totalAgendamentos) || 0, stats.total);
            clienteModificado.totalConcluidos = Math.max(Number(clienteModificado.totalConcluidos) || 0, stats.concluidos);
            clienteModificado.totalCancelados = Math.max(Number(clienteModificado.totalCancelados) || 0, stats.cancelados);
            clienteModificado.totalGastoCentavos = Math.max(Number(clienteModificado.totalGastoCentavos) || 0, stats.gastoCentavos);
            if (stats.ultimoAtendimento && (!clienteModificado.ultimoAgendamentoEm || stats.ultimoAtendimento > clienteModificado.ultimoAgendamentoEm)) {
                clienteModificado.ultimoAgendamentoEm = stats.ultimoAtendimento;
            }
        }

        const tags = Array.isArray(clienteModificado.tags) ? [...clienteModificado.tags] : [];
        const tagsSemVip = tags.filter(t => String(t).trim().toLowerCase() !== 'vip');

        if (assinatura) {
            const ativo = assinaturaMensalEstaAtiva(assinatura);
            if (ativo) tagsSemVip.push('VIP');
            clienteModificado = {
                ...clienteModificado,
                tags: tagsSemVip,
                isVip: ativo,
                planoAtivoId: ativo ? assinatura.id : null,
                planoStatus: ativo ? 'ativo' : String(assinatura.status || 'inativo').toLowerCase(),
                nomePlanoAtivo: ativo ? (assinatura.nomePlano || 'Plano Mensal') : null,
                planoDataFim: ativo ? (assinatura.dataFim || null) : null,
                assinaturaAtiva: ativo ? assinatura : null
            };
        } else if (clienteModificado.planoAtivoId) {
            clienteModificado = {
                ...clienteModificado,
                tags: tagsSemVip,
                isVip: false,
                planoAtivoId: null,
                planoStatus: 'inativo',
                nomePlanoAtivo: null,
                planoDataFim: null,
                assinaturaAtiva: null
            };
        }

        return clienteModificado;
    });

    // 6. Consolida duplicados sem perda de informações
    let listaFinal = consolidarClientesDuplicadosCRMServidor(listaAtualizada);

    // 7. Persiste no Firestore em lotes particionados (<= 400 docs por batch)
    if (persistirAlteracoes) {
        const itensParaSalvar = listaFinal.map(c => ({
            id: String(c.id),
            dados: {
                nome: c.nome || 'Cliente',
                nomeNormalizado: String(c.nome || 'Cliente').toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim(),
                telefone: c.telefone || '',
                telefoneNormalizado: normalizarTelefoneCRMServidor(c.telefone || c.telefoneNormalizado),
                email: c.email || '',
                emailNormalizado: normalizarEmailCRMServidor(c.email || c.emailNormalizado),
                status: c.status || 'ativo',
                tags: Array.isArray(c.tags) ? c.tags : [],
                observacoes: c.observacoes || '',
                dataNascimento: c.dataNascimento || '',
                ultimoAgendamentoEm: c.ultimoAgendamentoEm || null,
                totalAgendamentos: Number(c.totalAgendamentos) || 0,
                totalConcluidos: Number(c.totalConcluidos) || 0,
                totalCancelados: Number(c.totalCancelados) || 0,
                totalGastoCentavos: Number(c.totalGastoCentavos) || 0,
                isVip: Boolean(c.isVip),
                planoAtivoId: c.planoAtivoId || null,
                planoStatus: c.planoStatus || 'inativo',
                nomePlanoAtivo: c.nomePlanoAtivo || null,
                planoDataFim: c.planoDataFim || null,
                updatedAt: new Date().toISOString()
            }
        }));

        await executarBatchEmLotes(firestore, itensParaSalvar, (batch, item) => {
            const ref = firestore.collection('clientes').doc(item.id);
            batch.set(ref, item.dados, { merge: true });
        }, 400);
    }

    // 8. Ordena pela última atividade
    listaFinal.sort((a, b) => {
        const dtA = a.ultimoAgendamentoEm || a.createdAt || '';
        const dtB = b.ultimoAgendamentoEm || b.createdAt || '';
        return dtB.localeCompare(dtA);
    });

    return listaFinal;
}

app.get('/api/crm/clientes/listar', verificarAdminMiddleware, async (req, res) => {
    try {
        if (!firebaseAdminFirestore) {
            return res.status(500).json({ success: false, error: 'Firestore Admin SDK não inicializado.' });
        }
        const clientes = await sincronizarEListarBaseCRM(firebaseAdminFirestore, false);
        return res.json({ success: true, clientes });
    } catch (e) {
        console.error('Erro em /api/crm/clientes/listar:', e);
        return res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/crm/clientes/salvar', verificarAdminMiddleware, async (req, res) => {
    try {
        if (!firebaseAdminFirestore) {
            return res.status(500).json({ success: false, error: 'Firestore Admin SDK não inicializado.' });
        }

        const { id, nome, telefone, email, dataNascimento, status, tags, observacoes } = req.body;
        if (!nome || !telefone) {
            return res.status(400).json({ success: false, error: 'Nome e telefone são obrigatórios.' });
        }

        const telLimpo = normalizarTelefoneCRMServidor(telefone);
        const docId = id || (`cli_${telLimpo || Date.now()}`);

        const dadosCliente = {
            nome: nome.trim(),
            nomeNormalizado: String(nome).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim(),
            telefone: telefone.trim(),
            telefoneNormalizado: telLimpo,
            email: email ? email.trim() : '',
            emailNormalizado: normalizarEmailCRMServidor(email),
            dataNascimento: dataNascimento || '',
            status: status || 'ativo',
            tags: Array.isArray(tags) ? tags : [],
            observacoes: observacoes || '',
            updatedAt: new Date().toISOString()
        };

        if (!id) {
            dadosCliente.createdAt = new Date().toISOString();
            dadosCliente.totalAgendamentos = 0;
            dadosCliente.totalGastoCentavos = 0;
        }

        await firebaseAdminFirestore.collection('clientes').doc(docId).set(dadosCliente, { merge: true });
        return res.json({ success: true, id: docId, cliente: { id: docId, ...dadosCliente } });
    } catch (e) {
        console.error('Erro em /api/crm/clientes/salvar:', e);
        return res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/crm/clientes/sincronizar', verificarAdminMiddleware, async (req, res) => {
    try {
        if (!firebaseAdminFirestore) {
            return res.status(500).json({ success: false, error: 'Firestore Admin SDK não inicializado.' });
        }
        const clientes = await sincronizarEListarBaseCRM(firebaseAdminFirestore, true);
        return res.json({ success: true, total: clientes.length, clientes });
    } catch (e) {
        console.error('Erro em /api/crm/clientes/sincronizar:', e);
        return res.status(500).json({ success: false, error: e.message });
    }
});

if (isMainModule) {
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
}

export default app;
