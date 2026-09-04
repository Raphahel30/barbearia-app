// Codificação de saída: nunca modifica os dados persistidos do cliente.
export function textoHtml(value) {
    const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return String(value ?? '').replace(/[&<>"']/g, c => entities[c]);
}

// Somente para argumentos em atributos de evento legados delimitados por aspas.
// JSON protege a string JavaScript; textoHtml protege o atributo HTML externo.
export function argumentoEvento(value) {
    return textoHtml(JSON.stringify(String(value ?? '')).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029'));
}

export function urlImagemSegura(value) {
    if (typeof value !== 'string') return '';
    const url = value.trim();
    if (!url || /[\u0000-\u001f\u007f<>"'`\\]/.test(url)) return '';
    if (/^data:image\/(?:jpeg|png|webp|gif);base64,[a-zA-Z0-9+/]+=*$/.test(url)) return url;
    if (/^[a-z][a-z0-9+.-]*:/i.test(url) && !/^https?:\/\//i.test(url)) return '';
    try {
        const parsed = new URL(url, 'https://local.invalid/');
        if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) return '';
        return url;
    } catch { return ''; }
}

function elemento(doc, tag, className, text) {
    const node = doc.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = String(text ?? '');
    return node;
}

export function criarCardFoto(foto, { onExcluir, onVisualizar, onBaixar, document: doc = globalThis.document } = {}) {
    const estilo = foto.estiloCorte || foto.titulo || 'Corte EMAÚS Barbearia';
    const card = elemento(doc, 'div', 'bg-gradient-to-b from-zinc-900 to-black p-3 rounded-2xl border border-zinc-800 hover:border-amber-500/60 transition space-y-2.5 shadow-lg group');
    const frame = elemento(doc, 'div', 'relative w-full aspect-square rounded-xl overflow-hidden bg-black border border-zinc-800');
    const imagem = elemento(doc, 'img', 'w-full h-full object-cover group-hover:scale-105 transition duration-300');
    const url = urlImagemSegura(foto.fotoUrl);
    imagem.alt = String(estilo);
    if (url) imagem.src = url;
    frame.appendChild(imagem);
    if (onVisualizar) {
        const abrir = elemento(doc, 'button', 'absolute inset-0 w-full h-full bg-transparent cursor-pointer');
        abrir.type = 'button';
        abrir.setAttribute('aria-label', `Ampliar foto: ${estilo}`);
        abrir.addEventListener('click', onVisualizar);
        frame.appendChild(abrir);
    }
    if (onExcluir) {
        const excluir = elemento(doc, 'button', 'absolute top-2 right-2 bg-red-950/90 text-red-300 p-2 rounded-lg border border-red-800 cursor-pointer', '🗑️');
        excluir.type = 'button';
        excluir.setAttribute('aria-label', `Excluir foto de ${foto.clienteNome || 'cliente'}`);
        excluir.addEventListener('click', onExcluir);
        frame.appendChild(excluir);
    }
    card.appendChild(frame);
    if (foto.clienteNome) card.appendChild(elemento(doc, 'p', 'font-bold text-dourado text-xs truncate', `👤 ${foto.clienteNome}`));
    const titulo = elemento(doc, 'h4', 'font-bold text-white text-xs truncate', estilo);
    titulo.title = String(estilo);
    card.appendChild(titulo);
    card.appendChild(elemento(doc, 'p', 'text-[10px] text-zinc-400 truncate', `💈 ${foto.barbeiroNome || 'Aldo Rodrigues'}`));
    card.appendChild(elemento(doc, 'p', 'text-[10px] text-zinc-400 font-mono', foto.dataHoraFormatada || (foto.dataCriacao ? new Date(foto.dataCriacao).toLocaleDateString('pt-BR') : '')));
    if (foto.observacao) card.appendChild(elemento(doc, 'p', 'text-[10px] text-zinc-500 italic truncate', foto.observacao));
    if (onBaixar) {
        const baixar = elemento(doc, 'button', 'w-full bg-zinc-800 hover:bg-zinc-700 text-white font-bold py-2 rounded-xl text-[11px] border border-zinc-700 cursor-pointer', 'Baixar Foto');
        baixar.type = 'button';
        baixar.disabled = !url;
        baixar.addEventListener('click', () => { if (url) onBaixar(url); });
        card.appendChild(baixar);
    }
    return card;
}
