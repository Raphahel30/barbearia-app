import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let serviceAccount = {};

if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    } catch (e) {
        console.warn("Erro ao fazer parse de FIREBASE_SERVICE_ACCOUNT:", e.message);
    }
} else {
    const localPaths = [
        path.resolve(__dirname, './firebase-service-account.json'),
        path.resolve(__dirname, '../firebase-service-account.json'),
        path.resolve(__dirname, '../../firebase-service-account.json')
    ];
    for (const p of localPaths) {
        if (fs.existsSync(p)) {
            try {
                serviceAccount = JSON.parse(fs.readFileSync(p, 'utf8'));
                break;
            } catch (e) {}
        }
    }
}

export default serviceAccount;

