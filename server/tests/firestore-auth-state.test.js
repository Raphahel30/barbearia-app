import test from 'node:test';
import assert from 'node:assert/strict';
import { useFirestoreAuthState } from '../src/firestoreAuthState.js';

function criarFirestoreEmMemoria() {
    const dados = new Map();
    const ref = (colecao, id) => ({
        path: `${colecao}/${id}`,
        async get() {
            return { exists: dados.has(this.path), data: () => dados.get(this.path) };
        },
        async set(valor, options = {}) {
            const anterior = options.merge ? (dados.get(this.path) || {}) : {};
            dados.set(this.path, { ...anterior, ...valor });
        },
        async delete() { dados.delete(this.path); }
    });
    return {
        dados,
        collection(nome) {
            return {
                doc: (id) => ref(nome, id),
                async get() {
                    const docs = [...dados.keys()]
                        .filter(chave => chave.startsWith(`${nome}/`))
                        .map(chave => ({ ref: ref(nome, chave.slice(nome.length + 1)) }));
                    return { docs };
                }
            };
        },
        batch() {
            const exclusoes = [];
            return {
                delete: (documento) => exclusoes.push(documento),
                commit: async () => Promise.all(exclusoes.map(documento => documento.delete()))
            };
        }
    };
}

test('sessão do WhatsApp sobrevive a reinicialização e pode ser apagada', async () => {
    const db = criarFirestoreEmMemoria();
    const primeiro = await useFirestoreAuthState(db);
    primeiro.state.creds.registered = true;
    await primeiro.saveCreds();
    await primeiro.state.keys.set({ session: { 'cliente/1': { chave: 'persistida' } } });

    const reiniciado = await useFirestoreAuthState(db);
    assert.equal(reiniciado.state.creds.registered, true);
    assert.deepEqual(await reiniciado.state.keys.get('session', ['cliente/1']), {
        'cliente/1': { chave: 'persistida' }
    });

    await reiniciado.clearSession();
    assert.equal(db.dados.size, 0);
});
