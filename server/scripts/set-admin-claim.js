import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import serviceAccount from '../src/firebaseServiceAccount.js';

const email = String(process.argv[2] || '').trim().toLowerCase();
const master = process.argv.includes('--master');

if (!email || !email.includes('@')) {
    console.error('Uso: npm run admin:grant -- usuario@exemplo.com [--master]');
    process.exit(1);
}
if (!serviceAccount?.private_key) {
    console.error('Configure FIREBASE_SERVICE_ACCOUNT antes de executar.');
    process.exit(1);
}

const app = getApps()[0] || initializeApp({ credential: cert(serviceAccount) });
const auth = getAuth(app);
const db = getFirestore(app);
const user = await auth.getUserByEmail(email);
const { master: _claimMasterAnterior, ...claimsPreservadas } = user.customClaims || {};

await auth.setCustomUserClaims(user.uid, {
    ...claimsPreservadas,
    admin: true,
    ...(master ? { master: true } : {})
});
await db.collection('administradores').doc(user.uid).set({
    uid: user.uid,
    email,
    admin: true,
    master,
    atualizadoEm: new Date().toISOString()
}, { merge: true });

console.log(`Administrador configurado: ${email} (${user.uid})${master ? ' [master]' : ''}`);
process.exit(0);
