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
const [assinaturasSnap, clientesSnap] = await Promise.all([
    db.collection('assinaturasClientes').get(),
    db.collection('clientes').get()
]);
const agora = new Date();
const agoraIso = agora.toISOString();
const idsAtivos = new Set();
const operacoes = [];
let ativos = 0;
let inativos = 0;

function estaAtiva(assinatura) {
    if (String(assinatura.status || '').trim().toLowerCase() !== 'ativo') return false;
    const dataFim = assinatura.dataFim?.toDate ? assinatura.dataFim.toDate() : new Date(assinatura.dataFim || 0);
    return !Number.isNaN(dataFim.getTime()) && dataFim >= agora;
}

for (const documento of assinaturasSnap.docs) {
    const assinatura = documento.data();
    const clienteId = String(assinatura.userId || documento.id).trim();
    if (!clienteId) continue;
    const [clienteSnap, usuarioSnap] = await Promise.all([
        db.collection('clientes').doc(clienteId).get(),
        db.collection('usuarios').doc(clienteId).get()
    ]);
    const cliente = clienteSnap.exists ? clienteSnap.data() : {};
    const usuario = usuarioSnap.exists ? usuarioSnap.data() : {};
    const ativa = estaAtiva(assinatura);
    const tagsOriginais = Array.isArray(cliente.tags)
        ? cliente.tags
        : (Array.isArray(usuario.tags) ? usuario.tags : []);
    const tags = tagsOriginais.filter(tag => String(tag).trim().toLowerCase() !== 'vip');
    if (ativa) {
        tags.push('VIP');
        idsAtivos.add(clienteId);
        ativos += 1;
    } else {
        inativos += 1;
    }

    operacoes.push({
        ref: db.collection('clientes').doc(clienteId),
        dados: {
            nome: cliente.nome || usuario.nome || usuario.displayName || assinatura.cliente || 'Cliente',
            nomeNormalizado: String(cliente.nome || usuario.nome || usuario.displayName || assinatura.cliente || 'Cliente')
                .toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim(),
            telefone: cliente.telefone || usuario.telefone || assinatura.telefone || '',
            telefoneNormalizado: String(cliente.telefone || usuario.telefone || assinatura.telefone || '').replace(/\D/g, ''),
            email: cliente.email || usuario.email || assinatura.userEmail || assinatura.email || '',
            emailNormalizado: String(cliente.email || usuario.email || assinatura.userEmail || assinatura.email || '').trim().toLowerCase(),
            status: cliente.status || usuario.status || 'ativo',
            tags,
            isVip: ativa,
            planoAtivoId: ativa ? documento.id : null,
            planoStatus: ativa ? 'ativo' : String(assinatura.status || 'inativo').trim().toLowerCase(),
            nomePlanoAtivo: ativa ? (assinatura.nomePlano || 'Plano Mensal') : null,
            planoDataFim: ativa ? (assinatura.dataFim || null) : null,
            updatedAt: agoraIso,
            ...(clienteSnap.exists ? {} : { createdAt: agoraIso })
        }
    });
}

for (const documento of clientesSnap.docs) {
    const cliente = documento.data();
    if (!idsAtivos.has(documento.id) && (cliente.isVip === true || cliente.planoAtivoId)) {
        operacoes.push({
            ref: documento.ref,
            dados: {
                tags: (Array.isArray(cliente.tags) ? cliente.tags : []).filter(tag => String(tag).trim().toLowerCase() !== 'vip'),
                isVip: false,
                planoAtivoId: null,
                planoStatus: 'inativo',
                nomePlanoAtivo: null,
                planoDataFim: null,
                updatedAt: agoraIso
            }
        });
    }
}

if (aplicar) {
    for (let inicio = 0; inicio < operacoes.length; inicio += 400) {
        const batch = db.batch();
        operacoes.slice(inicio, inicio + 400).forEach(({ ref, dados }) => batch.set(ref, dados, { merge: true }));
        await batch.commit();
    }
}

console.log(`${aplicar ? 'Sincronização aplicada' : 'Simulação concluída'}: ${assinaturasSnap.size} assinatura(s).`);
console.log(`Planos ativos: ${ativos}; inativos ou expirados: ${inativos}; perfis a atualizar: ${operacoes.length}.`);
if (!aplicar) {
    console.log('Nenhuma gravação foi feita. Execute com --apply somente após conferir este resumo.');
} else {
    const perfisAtivos = await Promise.all([...idsAtivos].map(id => db.collection('clientes').doc(id).get()));
    const confirmados = perfisAtivos.filter(documento => {
        const dados = documento.data() || {};
        return documento.exists && dados.isVip === true && dados.planoStatus === 'ativo' && Boolean(dados.planoAtivoId);
    }).length;
    console.log(`Verificação após gravação: ${confirmados}/${idsAtivos.size} perfil(is) com plano ativo no CRM.`);
    if (confirmados !== idsAtivos.size) process.exitCode = 1;
}

if (!process.exitCode) process.exit(0);
