// Harness exclusivo de homologação. Nunca importar no servidor publicado.
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import https from 'node:https';
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { PUBLIC_FILES } from '../src/publicFiles.js';

if (process.env.FIRESTORE_EMULATOR_HOST !== '127.0.0.1:8080' || process.env.FIREBASE_AUTH_EMULATOR_HOST !== '127.0.0.1:9099' || process.env.GCLOUD_PROJECT !== 'demo-emaus-local') {
    throw new Error('Execute somente via npm run dev:emulator (projeto demo-emaus-local).');
}
for (const key of Object.keys(process.env)) {
    if (/MERCADO|FIREBASE_(SERVICE_ACCOUNT|PRIVATE_KEY|CLIENT_EMAIL)|GOOGLE_APPLICATION_CREDENTIALS|INTERNAL_SERVICE_KEY/.test(key)) delete process.env[key];
}
process.env.NODE_ENV = 'test';
process.env.EMAUS_LOCAL_EMULATOR = '1';
process.env.INTERNAL_SERVICE_KEY = 'emulador-local-sem-acesso-externo';
process.env.APP_SITE_URL = 'http://127.0.0.1:3000';
process.env.SELF_URL = 'http://127.0.0.1:3000';
process.env.WA_SESSION_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'emaus-local-wa-'));
// O backend de homologação não efetua requisições HTTPS (gateway, OAuth, mensagens).
https.request = https.get = () => { throw new Error('HTTPS externo bloqueado na homologação.'); };
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('Rede externa bloqueada na homologação.');
    return originalFetch(input, options);
};

const seedApp = initializeApp({ projectId: 'demo-emaus-local' }, 'local-seed');
const auth = getAuth(seedApp), db = getFirestore(seedApp);
const senha = 'TesteLocal123!';
for (const [uid, email, admin] of [['cliente-local', 'cliente@example.test', false], ['admin-local', 'admin@example.test', true]]) {
    try { await auth.getUser(uid); }
    catch (e) {
        if (e.code !== 'auth/user-not-found') throw e;
        await auth.createUser({ uid, email, password: senha, emailVerified: true, displayName: admin ? 'Administrador fictício' : 'Cliente fictício' });
    }
    await auth.setCustomUserClaims(uid, admin ? { admin: true } : {});
    await db.collection('usuarios').doc(uid).set({ nome: admin ? 'Administrador fictício' : 'Cliente fictício', email, telefone: '', emailVerificado: true }, { merge: true });
}
const inicio = new Date(), fim = new Date(Date.now() + 30 * 86400000);
const dados = {
    'servicos/corte': { nome: 'Corte', preco: 40, ativo: true },
    'servicos/barba': { nome: 'Barba', preco: 20, ativo: true },
    'planosMensais/corte': { nome: 'Plano teste', preco: 100, ativo: true, servicosInclusos: ['Corte'] },
    'barbeiros/principal': { nome: 'Barbeiro fictício', ativo: true, whatsapp: '' },
    'configuracoes/geral': { nomeBarbearia: 'HOMOLOGAÇÃO LOCAL' },
    'configuracoes/pagamento': { taxaReserva: 10, taxaCartaoCredito: 0, taxaCartaoDebito: 0 },
    'assinaturasClientes/cliente-local': { userId: 'cliente-local', nomePlano: 'Plano teste', status: 'ativo', dataPagamento: inicio.toISOString(), dataFim: fim.toISOString(), semanas: {} }
};
for (const [ref, value] of Object.entries(dados)) if (!(await db.doc(ref).get()).exists) await db.doc(ref).set(value);

const root = fileURLToPath(new URL('../../', import.meta.url));
function paginaLocal(file) {
    let html = fs.readFileSync(path.join(root, file), 'utf8');
    const config = /const firebaseConfig = \{[\s\S]*?\};/g;
    if ([...html.matchAll(config)].length !== 1 || !html.includes('const db = getFirestore(app);')) throw new Error(`Bootstrap inesperado: ${file}`);
    html = html.replace(config, 'const firebaseConfig = { apiKey: "demo-key", authDomain: "localhost", projectId: "demo-emaus-local" };');
    html = html.replace('const app = initializeApp(firebaseConfig);', `
        import { connectAuthEmulator } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';
        import { connectFirestoreEmulator } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';
        const app = initializeApp(firebaseConfig);`);
    html = html.replace('const db = getFirestore(app);', `const db = getFirestore(app);
        connectAuthEmulator(auth, 'http://127.0.0.1:9099');
        connectFirestoreEmulator(db, '127.0.0.1', 8080);`);
    html = html.replace('<body', '<body data-homologacao="local"');
    html = html.replaceAll('http://localhost:3000', 'http://127.0.0.1:3000');
    return html.replace('</body>', '<div style="position:fixed;top:0;left:0;right:0;z-index:999999;background:#a16207;color:white;text-align:center;pointer-events:none">HOMOLOGAÇÃO — DADOS FICTÍCIOS — SEM COBRANÇAS</div></body>');
}
const paginas = new Map([['/index.html', paginaLocal('index.html')], ['/admin.html', paginaLocal('admin.html')]]);
const local = express();
local.use((req, res, next) => {
    if (!['127.0.0.1', 'localhost'].includes(req.hostname)) return res.sendStatus(403);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' https://www.gstatic.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src http://127.0.0.1:3000 http://localhost:3000 http://127.0.0.1:8080 http://127.0.0.1:9099; frame-src 'none'; worker-src 'none'; form-action 'self'; base-uri 'self'");
    next();
});
local.get(['/', '/index', '/index.html', '/admin', '/admin.html'], (req, res) => res.type('html').send(paginas.get(req.path.startsWith('/admin') ? '/admin.html' : '/index.html')));
local.use((req, res, next) => {
    // Nunca deixa o servidor interno servir uma página HTML de produção por alias/URL codificada.
    if (!req.path.startsWith('/api/') && (!PUBLIC_FILES.has(req.path) || req.path.endsWith('.html'))) return res.sendStatus(404);
    if (req.path === '/sw.js' || /redefinir-senha|__\/auth/.test(req.path)) return res.sendStatus(404);
    if (req.path.startsWith('/api/') && !/^\/api\/(cliente\/|admin\/pix-manual|pagamento\/pix$|whatsapp\/status(?:-publico)?$)/.test(req.path)) {
        return res.status(503).json({ success: false, error: 'Integração desabilitada na homologação local.' });
    }
    next();
});
const { default: app } = await import('../src/server.js');
local.use(app);
local.listen(3000, '127.0.0.1', async () => {
    console.log(`HOMOLOGAÇÃO: http://127.0.0.1:3000 — cliente@example.test / admin@example.test — senha ${senha}`);
    if (process.argv.includes('--smoke')) {
        try {
            const { verificarHttpLocal } = await import('../tests/local-http-smoke.js');
            await verificarHttpLocal(db);
            process.exit(0);
        } catch (error) { console.error(error); process.exit(1); }
    }
});
