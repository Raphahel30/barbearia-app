import { initAuthCreds, BufferJSON, proto } from '@whiskeysockets/baileys';

/**
 * Verifica se a instância do Firestore está acessível e autenticada
 */
export async function isFirestoreAccessible(firestoreDb) {
    if (!firestoreDb) return false;
    try {
        const testRef = firestoreDb.collection('_whatsapp_session').doc('health_check');
        await testRef.set({ test: true, updatedAt: new Date().toISOString() }, { merge: true });
        return true;
    } catch (e) {
        console.warn('[Firestore AuthState] Firestore indisponível para sessão Baileys:', e.message);
        return false;
    }
}

/**
 * Adaptador de Autenticação Persistente do Baileys utilizando o Cloud Firestore do Firebase.
 * 
 * Benefícios:
 * 1. O Render possui sistema de arquivos efêmero (apaga pastas locais a cada deploy).
 * 2. Ao persistir as credenciais criptografadas no Firestore, o robô carrega a sessão em < 1s após qualquer deploy/restart.
 * 3. O WhatsApp NUNCA desconecta sozinho.
 */
export async function useFirestoreAuthState(firestoreDb, collectionName = '_whatsapp_session', forceNewCredsIfUnregistered = false) {
    const colRef = firestoreDb.collection(collectionName);

    // Helper para sanitizar IDs para documentos do Firestore
    const sanitizeKeyId = (id) => String(id).replace(/\//g, '__slash__').replace(/\\/g, '__bslash__');
    const desanitizeKeyId = (id) => String(id).replace(/__slash__/g, '/').replace(/__bslash__/g, '\\');

    // 1. Carregar creds
    const credsDocRef = colRef.doc('creds');
    let creds;

    try {
        const docSnap = await credsDocRef.get();
        if (docSnap.exists) {
            const rawJson = docSnap.data().data;
            creds = JSON.parse(rawJson, BufferJSON.reviver);
        }
    } catch (e) {
        console.warn('[Firestore AuthState] Aviso ao ler creds do Firestore:', e.message);
    }

    // Se forçando novas credenciais ou se credenciais existem mas NÃO foram registradas/autenticadas
    if (!creds || (forceNewCredsIfUnregistered && !creds.registered)) {
        creds = initAuthCreds();
    }

    // 2. Salvar creds
    const saveCreds = async () => {
        try {
            const serialized = JSON.stringify(creds, BufferJSON.replacer);
            await credsDocRef.set({
                data: serialized,
                updatedAt: new Date().toISOString()
            }, { merge: true });
        } catch (e) {
            console.error('[Firestore AuthState] Erro ao salvar creds no Firestore:', e.message);
        }
    };

    // 3. Objeto de chaves com get e set
    const keys = {
        get: async (type, ids) => {
            const data = {};
            await Promise.all(
                ids.map(async (id) => {
                    try {
                        const docId = `key_${type}_${sanitizeKeyId(id)}`;
                        const docSnap = await colRef.doc(docId).get();
                        if (docSnap.exists) {
                            const rawJson = docSnap.data().data;
                            let value = JSON.parse(rawJson, BufferJSON.reviver);
                            if (type === 'app-state-sync-key' && value) {
                                value = proto.Message.AppStateSyncKeyData.fromObject(value);
                            }
                            data[id] = value;
                        }
                    } catch (err) {
                        console.warn(`[Firestore AuthState] Erro ao obter chave ${type}/${id}:`, err.message);
                    }
                })
            );
            return data;
        },

        set: async (data) => {
            const tasks = [];
            for (const category in data) {
                for (const id in data[category]) {
                    const value = data[category][id];
                    const docId = `key_${category}_${sanitizeKeyId(id)}`;
                    const docRef = colRef.doc(docId);

                    if (value) {
                        const serialized = JSON.stringify(value, BufferJSON.replacer);
                        tasks.push(
                            docRef.set({
                                data: serialized,
                                type: category,
                                rawId: id,
                                updatedAt: new Date().toISOString()
                            })
                        );
                    } else {
                        tasks.push(docRef.delete().catch(() => {}));
                    }
                }
            }
            try {
                await Promise.all(tasks);
            } catch (e) {
                console.error('[Firestore AuthState] Erro ao salvar lote de chaves no Firestore:', e.message);
            }
        }
    };

    // 4. Função auxiliar para limpar toda a sessão em caso de logout voluntário
    const clearSession = async () => {
        try {
            const snapshot = await colRef.get();
            const batch = firestoreDb.batch();
            snapshot.docs.forEach((doc) => {
                batch.delete(doc.ref);
            });
            await batch.commit();
            console.log('[Firestore AuthState] Sessão apagada com sucesso do Firestore.');
        } catch (e) {
            console.warn('[Firestore AuthState] Aviso ao limpar coleção da sessão:', e.message);
        }
    };

    return {
        state: {
            creds,
            keys
        },
        saveCreds,
        clearSession
    };
}
