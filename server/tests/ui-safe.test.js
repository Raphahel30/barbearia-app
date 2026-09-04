import test from 'node:test';
import assert from 'node:assert/strict';
import { textoHtml, argumentoEvento, urlImagemSegura, criarCardFoto } from '../../assets/ui-safe.js';

test('texto de cliente não cria tags nem encerra atributos HTML', () => {
    assert.equal(textoHtml('<img src=x onerror="alert(1)"> & O\'Connor'), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; O&#39;Connor');
    assert.equal(textoHtml(null), '');
});

test('argumentos legados preservam dados sem executar código ou entidades', () => {
    const entities = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };
    for (const dado of ["');alert(1);//", '" onmouseover="alert(1)', '&quot;);alert(1)', 'João\nD\'Ávila\\teste', '\u2028\u2029']) {
        const encoded = argumentoEvento(dado);
        assert.ok(!/[<>"']/.test(encoded));
        const decoded = encoded.replace(/&(amp|lt|gt|quot|#39);/g, (_, key) => entities[key]);
        assert.equal(JSON.parse(decoded), dado);
    }
});

test('URLs de fotos rejeitam scripts, SVG inline, credenciais e quebra de atributos', () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'data:image/svg+xml;base64,PHN2Zz4=', 'https://a.test/" onerror="alert(1)', 'java\nscript:alert(1)', 'https://usuario:senha@a.test/foto.png']) {
        assert.equal(urlImagemSegura(url), '');
    }
    for (const url of ['logo.jpg', '/logo.png', 'https://a.test/foto.jpg?v=2', 'data:image/jpeg;base64,/9j/AA==']) assert.equal(urlImagemSegura(url), url);
});

class ElementoTeste {
    constructor(tag) { this.tagName = tag; this.children = []; this.events = {}; this.attributes = {}; }
    set innerHTML(_) { throw new Error('Dados não podem ser inseridos via innerHTML'); }
    appendChild(child) { this.children.push(child); }
    setAttribute(key, value) { assert.ok(!/^on/i.test(key)); this.attributes[key] = value; }
    addEventListener(key, fn) { assert.equal(typeof fn, 'function'); this.events[key] = fn; }
}
const doc = { createElement: tag => new ElementoTeste(tag) };
const flatten = el => [el, ...el.children.flatMap(flatten)];

test('cartão de galeria usa texto e callbacks para dados hostis', () => {
    const hostil = '<img src=x onerror=alert(1)> " \' &quot;';
    let excluiu = 0, abriu = 0, baixou = '';
    const foto = { fotoUrl: 'https://a.test/foto.jpg', clienteNome: hostil, estiloCorte: hostil, barbeiroNome: hostil, observacao: hostil, dataHoraFormatada: hostil };
    const card = criarCardFoto(foto, { document: doc, onExcluir: () => excluiu++, onVisualizar: () => abriu++, onBaixar: url => { baixou = url; } });
    const elements = flatten(card);
    assert.equal(elements.filter(e => e.tagName === 'img').length, 1);
    assert.ok(elements.some(e => e.textContent === hostil));
    for (const el of elements) el.events.click?.();
    assert.equal(excluiu, 1);
    assert.equal(abriu, 1);
    assert.equal(baixou, foto.fotoUrl);
});

test('download de foto com URL inválida permanece bloqueado', () => {
    let baixou = false;
    const nodes = flatten(criarCardFoto({ fotoUrl: 'javascript:alert(1)' }, { document: doc, onBaixar: () => { baixou = true; } }));
    assert.equal(nodes.find(n => n.tagName === 'img').src, undefined);
    const btn = nodes.find(n => n.tagName === 'button');
    assert.equal(btn.disabled, true);
    btn.events.click();
    assert.equal(baixou, false);
});
