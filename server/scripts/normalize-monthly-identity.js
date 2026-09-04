// Execute sem --apply primeiro. Não altera titularidade, créditos ou status.
import { cert, initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import serviceAccount from '../src/firebaseServiceAccount.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

if (!serviceAccount?.private_key) throw new Error('Configure FIREBASE_SERVICE_ACCOUNT.');
if (serviceAccount.project_id !== 'agendamento-barbearia-e8ffb') throw new Error('Projeto Firebase inesperado.');
const app = initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore(app);
try {
    const snap = await db.collection('assinaturasClientes').get();
    if (process.argv.includes('--apply')) {
        const backupDir = process.env.MONTHLY_BACKUP_DIR;
        if (!backupDir) throw new Error('Defina MONTHLY_BACKUP_DIR fora da pasta publicada.');
        mkdirSync(backupDir, { recursive: true });
        const backup = snap.docs.map(d => ({ id: d.id, updateTime: d.updateTime.toDate().toISOString(), ...Object.fromEntries(['emailNormalizado', 'telefoneNormalizado'].map(k => [k, { present: Object.hasOwn(d.data(), k), value: d.data()[k] ?? null }])) }));
        writeFileSync(join(backupDir, `monthly-identity-${Date.now()}.json`), JSON.stringify({ project: serviceAccount.project_id, records: backup }, null, 2), { flag: 'wx' });
    }
    let candidatos = 0;
    for (const doc of snap.docs) {
        const s = doc.data();
        const emailNormalizado = String(s.userEmail || s.email || s.emailNormalizado || '').trim().toLowerCase();
        let telefoneNormalizado = String(s.telefone || s.telefoneNormalizado || '').replace(/\D/g, '');
        if ([12, 13].includes(telefoneNormalizado.length) && telefoneNormalizado.startsWith('55')) telefoneNormalizado = telefoneNormalizado.slice(2);
        if (![10, 11].includes(telefoneNormalizado.length)) telefoneNormalizado = '';
        if (s.emailNormalizado === emailNormalizado && s.telefoneNormalizado === telefoneNormalizado) continue;
        candidatos++;
        // Precondição impede sobrescrever um cadastro alterado durante a leitura.
        if (process.argv.includes('--apply')) await doc.ref.update({ emailNormalizado, telefoneNormalizado }, { lastUpdateTime: doc.updateTime });
    }
    console.log(`${process.argv.includes('--apply') ? 'Normalizados' : 'A normalizar (sem gravação)'}: ${candidatos}/${snap.size}`);
} finally {
    await db.terminate();
    await deleteApp(app);
}
