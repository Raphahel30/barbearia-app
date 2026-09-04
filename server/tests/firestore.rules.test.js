import { after, before, beforeEach, describe, test } from 'node:test';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
    assertFails,
    assertSucceeds,
    initializeTestEnvironment
} from '@firebase/rules-unit-testing';
import {
    collection,
    deleteDoc,
    doc,
    getDoc,
    getDocs,
    setDoc,
    updateDoc,
    writeBatch
} from 'firebase/firestore';

const PROJECT_ID = 'demo-emaus-barbearia';
const RULES_PATH = fileURLToPath(new URL('../../firestore.rules', import.meta.url));
let testEnv;

before(async () => {
    testEnv = await initializeTestEnvironment({
        projectId: PROJECT_ID,
        firestore: {
            host: '127.0.0.1',
            port: 8080,
            rules: fs.readFileSync(RULES_PATH, 'utf8')
        }
    });
});

beforeEach(async () => {
    await testEnv.clearFirestore();
});

after(async () => {
    await testEnv?.cleanup();
});

function anonymousDb() {
    return testEnv.unauthenticatedContext().firestore();
}

function userDb(uid, email = `${uid}@example.com`, claims = {}) {
    return testEnv.authenticatedContext(uid, { email, ...claims }).firestore();
}

function adminDb() {
    return userDb('admin-1', 'gestor@example.com', { admin: true });
}

async function seed(path, data) {
    await testEnv.withSecurityRulesDisabled(async context => {
        await setDoc(doc(context.firestore(), path), data);
    });
}

describe('dados públicos e negação padrão', () => {
    test('visitante lê serviços, planos, barbeiros, slots e configuração pública', async () => {
        for (const path of [
            'servicos/corte',
            'planosMensais/mensal',
            'planos/basico',
            'barbeiros/principal',
            'slots_agendamentos/slot-1',
            'configuracoes/pagamento'
        ]) {
            await seed(path, { ativo: true });
            await assertSucceeds(getDoc(doc(anonymousDb(), path)));
        }
    });

    test('visitante não grava dados públicos e coleção desconhecida é negada', async () => {
        await assertFails(setDoc(doc(anonymousDb(), 'servicos/invasor'), { ativo: true }));
        await assertFails(getDoc(doc(userDb('alice'), 'colecao_desconhecida/doc-1')));
    });
});

describe('usuários e CRM', () => {
    test('usuário acessa o próprio perfil, mas não o perfil de terceiros', async () => {
        await seed('usuarios/alice', { nome: 'Alice' });
        await seed('usuarios/bob', { nome: 'Bob' });
        const alice = userDb('alice');
        await assertSucceeds(getDoc(doc(alice, 'usuarios/alice')));
        await assertSucceeds(updateDoc(doc(alice, 'usuarios/alice'), { nome: 'Alice Silva' }));
        await assertFails(getDoc(doc(alice, 'usuarios/bob')));
        await assertFails(updateDoc(doc(alice, 'usuarios/bob'), { nome: 'Invasão' }));
    });

    test('CRM de clientes é exclusivo de administrador', async () => {
        await seed('clientes/cliente-1', { nome: 'Cliente' });
        await assertFails(getDoc(doc(userDb('alice'), 'clientes/cliente-1')));
        await assertSucceeds(getDoc(doc(adminDb(), 'clientes/cliente-1')));
        await assertSucceeds(setDoc(doc(adminDb(), 'clientes/cliente-2'), { nome: 'Novo' }));
    });
});

describe('agendamentos e slots', () => {
    test('solicitações Pix são privadas e decisões são exclusivas da API', async () => {
        await seed('solicitacoes_pix_manual/pedido', { userId: 'alice', status: 'pendente' });
        await assertSucceeds(getDoc(doc(userDb('alice'), 'solicitacoes_pix_manual/pedido')));
        await assertSucceeds(getDoc(doc(adminDb(), 'solicitacoes_pix_manual/pedido')));
        await assertFails(getDoc(doc(userDb('bob'), 'solicitacoes_pix_manual/pedido')));
        await assertFails(updateDoc(doc(userDb('alice'), 'solicitacoes_pix_manual/pedido'), { status: 'aprovado' }));
        await assertFails(updateDoc(doc(adminDb(), 'solicitacoes_pix_manual/pedido'), { status: 'aprovado' }));
        await assertFails(setDoc(doc(userDb('alice'), 'agendamentos/forjado'), { userId: 'alice', status: 'confirmado', taxaReservaPaga: 100 }));
        await assertSucceeds(setDoc(doc(adminDb(), 'agendamentos/balcao'), { userId: 'alice', status: 'confirmado' }));
    });
    test('cliente não cria agendamento direto nem para o próprio UID', async () => {
        const alice = userDb('alice');
        await assertFails(setDoc(doc(alice, 'agendamentos/ag-1'), {
            userId: 'alice', clienteEmail: 'alice@example.com', dataHora: '2026-09-10T10:00'
        }));
        await assertFails(setDoc(doc(alice, 'agendamentos/ag-2'), {
            userId: 'bob', clienteEmail: 'bob@example.com', dataHora: '2026-09-10T11:00'
        }));
    });

    test('cliente não pode alterar nem excluir agendamentos diretamente no Firestore; somente admin', async () => {
        await seed('agendamentos/alice-ag', { userId: 'alice', clienteEmail: 'alice@example.com' });
        await seed('agendamentos/bob-ag', { userId: 'bob', clienteEmail: 'bob@example.com' });
        const alice = userDb('alice');
        await assertFails(updateDoc(doc(alice, 'agendamentos/alice-ag'), { status: 'cancelado' }));
        await assertFails(deleteDoc(doc(alice, 'agendamentos/alice-ag')));
        await assertFails(updateDoc(doc(alice, 'agendamentos/bob-ag'), { status: 'cancelado' }));
        await assertFails(deleteDoc(doc(alice, 'agendamentos/bob-ag')));
        await assertSucceeds(updateDoc(doc(adminDb(), 'agendamentos/alice-ag'), { status: 'cancelado' }));
        await assertSucceeds(deleteDoc(doc(adminDb(), 'agendamentos/alice-ag')));
    });

    test('cliente lê somente a própria agenda e administrador possui controle total', async () => {
        await seed('agendamentos/ag-1', { userId: 'bob', dataHora: '2026-09-10T10:00' });
        await seed('agendamentos/ag-2', { userId: 'alice', dataHora: '2026-09-10T11:00' });
        await assertFails(getDocs(collection(anonymousDb(), 'agendamentos')));
        await assertFails(getDoc(doc(userDb('alice'), 'agendamentos/ag-1')));
        await assertSucceeds(getDoc(doc(userDb('alice'), 'agendamentos/ag-2')));
        await assertSucceeds(deleteDoc(doc(adminDb(), 'agendamentos/ag-1')));
    });

    test('cliente não reserva ou libera slot diretamente; grade permanece pública', async () => {
        const alice = userDb('alice');
        const batch = writeBatch(alice);
        batch.set(doc(alice, 'slots_agendamentos/slot-alice'), {
            slotId: 'slot-alice',
            dataHora: '2026-09-10T10:00',
            barbeiroId: 'principal',
            barbeiroNome: 'Barbearia',
            status: 'confirmado',
            expiraEm: null,
            atualizadoEm: '2026-09-01T10:00:00Z'
        });
        batch.set(doc(alice, 'slots_proprietarios/slot-alice'), {
            userId: 'alice', paymentId: null, atualizadoEm: '2026-09-01T10:00:00Z'
        });
        await assertFails(batch.commit());
        await seed('slots_agendamentos/slot-alice', { dataHora: '2026-09-10T10:00', status: 'confirmado' });
        await seed('slots_proprietarios/slot-alice', { userId: 'alice' });
        await assertSucceeds(getDoc(doc(anonymousDb(), 'slots_agendamentos/slot-alice')));
        await assertFails(getDoc(doc(anonymousDb(), 'slots_proprietarios/slot-alice')));
        await assertFails(getDoc(doc(userDb('bob'), 'slots_proprietarios/slot-alice')));
        await assertFails(deleteDoc(doc(userDb('bob'), 'slots_agendamentos/slot-alice')));
        const liberar = writeBatch(alice);
        liberar.delete(doc(alice, 'slots_agendamentos/slot-alice'));
        liberar.delete(doc(alice, 'slots_proprietarios/slot-alice'));
        await assertFails(liberar.commit());
    });

    test('nem administrador grava dados pessoais no slot público', async () => {
        const publico = { slotId: 'seguro', dataHora: '2026-09-10T10:00', status: 'confirmado', barbeiroId: 'principal' };
        await assertSucceeds(setDoc(doc(adminDb(), 'slots_agendamentos/seguro'), publico));
        for (const campo of ['userId', 'cliente', 'telefone', 'paymentId']) {
            await assertFails(setDoc(doc(adminDb(), 'slots_agendamentos/seguro'), { ...publico, [campo]: 'privado' }));
        }
    });

    test('slot público rejeita dados pessoais mesmo quando o proprietário é válido', async () => {
        const alice = userDb('alice');
        const batch = writeBatch(alice);
        batch.set(doc(alice, 'slots_agendamentos/slot-com-pii'), {
            slotId: 'slot-com-pii', dataHora: '2026-09-10T12:00', barbeiroId: 'principal',
            barbeiroNome: 'Barbearia', status: 'confirmado', expiraEm: null,
            atualizadoEm: '2026-09-01T10:00:00Z', telefone: '11999999999'
        });
        batch.set(doc(alice, 'slots_proprietarios/slot-com-pii'), {
            userId: 'alice', paymentId: null, atualizadoEm: '2026-09-01T10:00:00Z'
        });
        await assertFails(batch.commit());
    });

    test('cliente não pode assumir slot diretamente mesmo após expiração', async () => {
        const agora = Date.now();
        const dadosPublicos = expiraEm => ({
            slotId: 'slot-teste', dataHora: '2026-09-10T13:00', barbeiroId: 'principal',
            barbeiroNome: 'Barbearia', status: 'pendente', expiraEm,
            atualizadoEm: '2026-09-01T10:00:00Z'
        });

        async function tentarAssumir(slotId) {
            const bob = userDb('bob');
            const batch = writeBatch(bob);
            batch.set(doc(bob, `slots_agendamentos/${slotId}`), {
                ...dadosPublicos(null), slotId, status: 'confirmado', expiraEm: null
            });
            batch.set(doc(bob, `slots_proprietarios/${slotId}`), {
                userId: 'bob', paymentId: 'pag-bob', atualizadoEm: '2026-09-01T10:05:00Z'
            });
            return batch.commit();
        }

        await seed('slots_agendamentos/slot-ativo', { ...dadosPublicos(agora + 60_000), slotId: 'slot-ativo' });
        await seed('slots_proprietarios/slot-ativo', { userId: 'alice', paymentId: 'pag-alice' });
        await assertFails(tentarAssumir('slot-ativo'));

        await seed('slots_agendamentos/slot-expirado', { ...dadosPublicos(agora - 60_000), slotId: 'slot-expirado' });
        await seed('slots_proprietarios/slot-expirado', { userId: 'alice', paymentId: 'pag-alice' });
        await assertFails(tentarAssumir('slot-expirado'));
    });
});

describe('estoque e compras', () => {
    test('estoque é somente leitura para cliente e escrita para administrador', async () => {
        await seed('produtos/pomada', { nome: 'Pomada', preco: 45, estoque: 10 });
        const alice = userDb('alice');
        await assertFails(updateDoc(doc(alice, 'produtos/pomada'), {
            estoque: 9, atualizadoEm: '2026-09-01T10:00:00Z'
        }));
        await assertFails(updateDoc(doc(alice, 'produtos/pomada'), { preco: 1 }));
        await assertFails(deleteDoc(doc(alice, 'produtos/pomada')));
        await assertSucceeds(updateDoc(doc(adminDb(), 'produtos/pomada'), { preco: 50 }));
    });

    test('compra é criada pelo backend/admin e lida somente pelo proprietário', async () => {
        const alice = userDb('alice');
        await assertFails(setDoc(doc(alice, 'comprasProdutos/compra-forjada'), {
            userId: 'alice', clienteEmail: 'alice@example.com', valorTotal: 45
        }));
        await seed('comprasProdutos/compra-1', { userId: 'alice', valorTotal: 45 });
        await assertSucceeds(getDoc(doc(alice, 'comprasProdutos/compra-1')));
        await assertFails(getDoc(doc(userDb('bob'), 'comprasProdutos/compra-1')));
        await assertFails(updateDoc(doc(alice, 'comprasProdutos/compra-1'), { valorTotal: 0 }));
    });
});

describe('dados privados, financeiros e administrativos', () => {
    test('configuração privada de pagamento é invisível ao cliente', async () => {
        await seed('configuracoes/pagamento_privado', { accessToken: 'segredo' });
        await assertFails(getDoc(doc(anonymousDb(), 'configuracoes/pagamento_privado')));
        await assertFails(getDoc(doc(userDb('alice'), 'configuracoes/pagamento_privado')));
        await assertSucceeds(getDoc(doc(adminDb(), 'configuracoes/pagamento_privado')));
    });

    test('gastos e despesas são exclusivos de administrador', async () => {
        await seed('gastos/g-1', { valor: 100 });
        await seed('despesas/d-1', { valor: 200 });
        for (const path of ['gastos/g-1', 'despesas/d-1']) {
            await assertFails(getDoc(doc(userDb('alice'), path)));
            await assertSucceeds(getDoc(doc(adminDb(), path)));
        }
    });

    test('cliente lê seu pagamento mas não cria, reprocessa, altera nem exclui', async () => {
        const alice = userDb('alice');
        await assertFails(setDoc(doc(alice, 'pagamentos_pendentes/p-1'), {
            userId: 'alice', status: 'pendente'
        }));
        await seed('pagamentos_pendentes/p-1', { userId: 'alice', status: 'processado' });
        await assertSucceeds(getDoc(doc(alice, 'pagamentos_pendentes/p-1')));
        await assertFails(getDoc(doc(userDb('bob'), 'pagamentos_pendentes/p-1')));
        await assertFails(updateDoc(doc(userDb('bob'), 'pagamentos_pendentes/p-1'), { userId: 'bob', status: 'cancelado' }));
        await assertFails(updateDoc(doc(alice, 'pagamentos_pendentes/p-1'), { status: 'pendente' }));
        await assertFails(updateDoc(doc(alice, 'pagamentos_pendentes/p-1'), { dados: { preco: 0 } }));
        await assertFails(deleteDoc(doc(alice, 'pagamentos_pendentes/p-1')));
        await assertSucceeds(deleteDoc(doc(adminDb(), 'pagamentos_pendentes/p-1')));
    });

    test('resgates de benefícios pertencem ao cliente e whatsapp session é inacessível no client SDK', async () => {
        const alice = userDb('alice');
        const bob = userDb('bob');
        const admin = adminDb();
        const anon = anonymousDb();

        // resgates_beneficios
        await seed('resgates_beneficios/resgate-1', { userId: 'alice', pontos: 10 });
        await assertSucceeds(getDoc(doc(alice, 'resgates_beneficios/resgate-1')));
        await assertFails(getDoc(doc(bob, 'resgates_beneficios/resgate-1')));
        await assertFails(getDoc(doc(anon, 'resgates_beneficios/resgate-1')));
        await assertSucceeds(getDoc(doc(admin, 'resgates_beneficios/resgate-1')));
        await assertFails(setDoc(doc(alice, 'resgates_beneficios/resgate-2'), { userId: 'alice', pontos: 10 }));
        await assertSucceeds(setDoc(doc(admin, 'resgates_beneficios/resgate-2'), { userId: 'alice', pontos: 10 }));

        // _whatsapp_session
        await seed('_whatsapp_session/creds', { me: 'bot' });
        await assertFails(getDoc(doc(anon, '_whatsapp_session/creds')));
        await assertFails(getDoc(doc(alice, '_whatsapp_session/creds')));
        await assertFails(getDoc(doc(admin, '_whatsapp_session/creds')));
        await assertFails(setDoc(doc(alice, '_whatsapp_session/creds'), { hack: true }));
        await assertFails(setDoc(doc(admin, '_whatsapp_session/creds'), { hack: true }));
    });
});

describe('assinaturas, fidelidade, galeria e promoções', () => {
    test('cliente não ativa plano, altera semanas nem forja um agendamento mensal', async () => {
        const alice = userDb('alice');
        await assertFails(setDoc(doc(alice, 'assinaturasClientes/alice'), { status: 'ativo' }));
        await seed('assinaturasClientes/alice', { status: 'ativo', semanas: {} });
        await assertFails(updateDoc(doc(alice, 'assinaturasClientes/alice'), { 'semanas.1.status': 'disponivel' }));
        await assertFails(setDoc(doc(alice, 'agendamentos/plano-forjado'), { userId: 'alice', isPlano: true }));
    });
    test('cadastro normal é permitido, mas perfil não aceita privilégios', async () => {
        const alice = userDb('alice');
        await assertSucceeds(setDoc(doc(alice, 'usuarios/alice'), { nome: 'Alice', email: 'alice@example.com', telefone: '11999999999', dataNascimento: '' }));
        await assertFails(updateDoc(doc(alice, 'usuarios/alice'), { admin: true }));
    });
    test('fidelidade não permite aumentar selos e permite o consumo exato da meta', async () => {
        const alice = userDb('alice');
        await seed('configuracoes/fidelidade', { metaSelos: 10 });
        await seed('fidelidadeClientes/alice', { selosAtuais: 10, recompensaDisponivel: true, recompensasUtilizadas: 0 });
        await assertFails(updateDoc(doc(alice, 'fidelidadeClientes/alice'), { selosAtuais: 100 }));
        await assertSucceeds(updateDoc(doc(alice, 'fidelidadeClientes/alice'), { selosAtuais: 0, recompensaDisponivel: false, recompensasUtilizadas: 1 }));
    });
    test('assinatura e fidelidade ficam restritas ao dono e administrador', async () => {
        for (const path of ['assinaturasClientes/alice', 'fidelidadeClientes/alice']) {
            await seed(path, { ativo: true });
            await assertSucceeds(getDoc(doc(userDb('alice'), path)));
            await assertFails(getDoc(doc(userDb('bob'), path)));
            await assertSucceeds(updateDoc(doc(adminDb(), path), { ativo: false }));
        }
    });

    test('galeria é privada e escrita exige admin; promoção também exige admin', async () => {
        await seed('galeria_cortes_clientes/foto-1', { clienteId: 'alice' });
        await seed('promocoes/promo-1', { desconto: 10 });
        await assertFails(getDoc(doc(anonymousDb(), 'galeria_cortes_clientes/foto-1')));
        await assertSucceeds(getDoc(doc(userDb('alice'), 'galeria_cortes_clientes/foto-1')));
        await assertFails(getDoc(doc(userDb('bob'), 'galeria_cortes_clientes/foto-1')));
        await assertFails(setDoc(doc(anonymousDb(), 'galeria_cortes_clientes/foto-2'), { clienteId: 'alice' }));
        await assertFails(setDoc(doc(userDb('alice'), 'galeria_cortes_clientes/foto-2'), { clienteId: 'alice' }));
        await assertSucceeds(setDoc(doc(adminDb(), 'galeria_cortes_clientes/foto-2'), { clienteId: 'alice' }));
        await assertSucceeds(getDoc(doc(anonymousDb(), 'promocoes/promo-1')));
        await assertFails(updateDoc(doc(userDb('alice'), 'promocoes/promo-1'), { desconto: 99 }));
        await assertSucceeds(updateDoc(doc(adminDb(), 'promocoes/promo-1'), { desconto: 15 }));
    });
});
