import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let serviceAccount = {};

// 1. Tenta carregar da variável de ambiente FIREBASE_SERVICE_ACCOUNT (JSON puro ou Base64)
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
        const raw = process.env.FIREBASE_SERVICE_ACCOUNT.trim();
        if (raw.startsWith('{')) {
            serviceAccount = JSON.parse(raw);
        } else {
            const decoded = Buffer.from(raw, 'base64').toString('utf8');
            serviceAccount = JSON.parse(decoded);
        }
    } catch (e) {
        console.warn('[Firebase Auth] Erro ao processar FIREBASE_SERVICE_ACCOUNT da variável de ambiente:', e.message);
    }
}

// 2. Fallback para desenvolvimento local via arquivo .json seguro (ignorado no git)
if (!serviceAccount || !serviceAccount.private_key) {
    const localPaths = [
        path.join(__dirname, '..', 'firebase-service-account.json'),
        path.join(__dirname, '..', '..', 'firebase-service-account.json')
    ];

    for (const p of localPaths) {
        if (fs.existsSync(p)) {
            try {
                serviceAccount = JSON.parse(fs.readFileSync(p, 'utf8'));
                console.log(`[Firebase Auth] Credenciais carregadas do arquivo local seguro: ${p}`);
                break;
            } catch (err) {
                console.warn(`[Firebase Auth] Erro ao ler ${p}:`, err.message);
            }
        }
    }
}

if (!serviceAccount || !serviceAccount.private_key) {
    console.warn('⚠️ [Firebase Auth] Nenhuma credencial de Service Account encontrada. Defina FIREBASE_SERVICE_ACCOUNT no painel do Render/Vercel.');
}

export default serviceAccount;
