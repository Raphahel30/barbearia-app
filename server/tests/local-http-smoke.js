import assert from 'node:assert/strict';

export async function verificarHttpLocal(db) {
    assert.equal(process.env.GCLOUD_PROJECT, 'demo-emaus-local');
    assert.equal(process.env.FIRESTORE_EMULATOR_HOST, '127.0.0.1:8080');
    const base = 'http://127.0.0.1:3000';
    const entrar = async email => {
        const r = await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'TesteLocal123!', returnSecureToken: true })
        });
        assert.equal(r.status, 200);
        return (await r.json()).idToken;
    };
    const cliente = await entrar('cliente@example.test'), admin = await entrar('admin@example.test');
    const call = async (route, token, body) => {
        const r = await fetch(`${base}${route}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
        return { status: r.status, body: await r.json() };
    };
    for (const url of ['/', '/admin.html']) {
        const r = await fetch(`${base}${url}`), html = await r.text();
        assert.equal(r.status, 200);
        assert.match(html, /connectAuthEmulator\(auth/);
        assert.match(html, /connectFirestoreEmulator\(db/);
        assert.match(html, /projectId: "demo-emaus-local"/);
        assert.ok(!html.includes('http://localhost:3000'));
        assert.ok(!r.headers.get('content-security-policy').includes('connect-src *'));
    }
    assert.equal((await call('/api/admin/pix-manual', cliente)).status, 403);
    assert.equal((await call('/api/admin/pix-manual', admin)).status, 200);
    assert.equal((await call('/api/pagamento/cartao', cliente, {})).status, 503);
    assert.equal((await fetch(`${base}/index%2ehtml`)).status, 404);
    assert.equal((await fetch(`${base}/sw.js`)).status, 404);
    const amanha = new Date(Date.now() + 86400000).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
    const reserva = await call('/api/cliente/plano/agendar', cliente, { semana: 1, dataHora: `${amanha}T14:00` });
    assert.equal(reserva.status, 200, JSON.stringify(reserva.body));
    assert.equal((await db.collection('agendamentos').get()).size, 1);
    assert.equal((await db.doc('assinaturasClientes/cliente-local').get()).data().semanas[1].status, 'agendado');
    const antes = (await db.collection('slots_agendamentos').get()).size;
    const pedido = await call('/api/cliente/pix-manual', cliente, { requestId: 'homologacao-http-manual', data: amanha, horario: '15:00', servicoBase: 'Corte', modalidade: 'taxa', valorCobrado: 10 });
    assert.equal(pedido.status, 200, JSON.stringify(pedido.body));
    assert.equal((await db.collection('slots_agendamentos').get()).size, antes, 'Solicitação não reserva horário');
    const id = pedido.body.solicitacao.id;
    const rota = `/api/admin/pix-manual/${id}/decidir`;
    assert.equal((await call(rota, cliente, { acao: 'aprovar', pagamentoConferido: true })).status, 403);
    assert.equal((await call(rota, admin, { acao: 'aprovar' })).status, 400);
    const aprovado = await call(rota, admin, { acao: 'aprovar', pagamentoConferido: true });
    assert.equal(aprovado.status, 200, JSON.stringify(aprovado.body));
    assert.equal((await db.collection('slots_agendamentos').get()).size, antes + 1);
    console.log('SMOKE HTTP LOCAL APROVADO: login cliente/admin, páginas isoladas, mensalista, Pix manual sem reserva antecipada, aprovação autorizada e bloqueio de cartão.');
}
