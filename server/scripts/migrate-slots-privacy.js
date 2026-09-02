import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import serviceAccount from '../src/firebaseServiceAccount.js';

const aplicar = process.argv.includes('--apply');

if (!serviceAccount?.private_key) {
    console.error('Configure FIREBASE_SERVICE_ACCOUNT antes de executar.');
    process.exit(1);
}

const app = getApps()[0] || initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore(app);
const snapshot = await db.collection('slots_agendamentos').get();
const agoraIso = new Date().toISOString();

let total = 0;
let comProprietario = 0;
let semProprietario = 0;
let batch = db.batch();
let operacoes = 0;

async function confirmarBatchSeNecessario(forcar = false) {
    if (operacoes === 0 || (!forcar && operacoes < 400)) return;
    if (aplicar) await batch.commit();
    batch = db.batch();
    operacoes = 0;
}

for (const slotDoc of snapshot.docs) {
    const dados = slotDoc.data();
    const userId = String(dados.userId || '').trim();
    const dadosPublicos = {
        slotId: slotDoc.id,
        dataHora: dados.dataHora || '',
        barbeiroId: dados.barbeiroId || 'principal',
        barbeiroNome: dados.barbeiroNome || 'Barbearia EMAÚS',
        status: dados.status || 'confirmado',
        expiraEm: dados.expiraEm ?? null,
        atualizadoEm: agoraIso
    };

    batch.set(slotDoc.ref, dadosPublicos);
    operacoes += 1;
    total += 1;

    if (userId) {
        batch.set(db.collection('slots_proprietarios').doc(slotDoc.id), {
            userId,
            paymentId: dados.paymentId ? String(dados.paymentId) : null,
            atualizadoEm: agoraIso
        });
        operacoes += 1;
        comProprietario += 1;
    } else {
        semProprietario += 1;
    }

    await confirmarBatchSeNecessario();
}

await confirmarBatchSeNecessario(true);

console.log(`${aplicar ? 'Migração aplicada' : 'Simulação concluída'}: ${total} slot(s).`);
console.log(`Com proprietário: ${comProprietario}; sem proprietário: ${semProprietario}.`);
if (!aplicar) {
    console.log('Nenhuma gravação foi feita. Use --apply somente após conferir este resumo.');
}

process.exit(0);
