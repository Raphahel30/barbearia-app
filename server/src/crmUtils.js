export function normalizarTelefoneCRMServidor(valor) {
    return String(valor || '').replace(/\D/g, '');
}

export function assinaturaMensalEstaAtiva(assinatura, agora = new Date()) {
    if (!assinatura || String(assinatura.status || '').trim().toLowerCase() !== 'ativo') return false;
    const valorFim = assinatura.dataFim?.toDate ? assinatura.dataFim.toDate() : new Date(assinatura.dataFim || 0);
    return !Number.isNaN(valorFim.getTime()) && valorFim >= agora;
}

export function consolidarClientesDuplicadosCRMServidor(clientes) {
    if (!Array.isArray(clientes) || clientes.length < 2) return Array.isArray(clientes) ? clientes : [];
    const pais = clientes.map((_, indice) => indice);
    const encontrar = indice => {
        while (pais[indice] !== indice) {
            pais[indice] = pais[pais[indice]];
            indice = pais[indice];
        }
        return indice;
    };
    const unir = (a, b) => {
        const raizA = encontrar(a);
        const raizB = encontrar(b);
        if (raizA !== raizB) pais[raizB] = raizA;
    };
    const porTelefone = new Map();
    const porEmail = new Map();
    clientes.forEach((cliente, indice) => {
        const telefone = normalizarTelefoneCRMServidor(cliente.telefone || cliente.telefoneNormalizado);
        const email = String(cliente.email || cliente.emailNormalizado || '').trim().toLowerCase();
        if (telefone) {
            if (porTelefone.has(telefone)) unir(indice, porTelefone.get(telefone));
            else porTelefone.set(telefone, indice);
        }
        if (email) {
            if (porEmail.has(email)) unir(indice, porEmail.get(email));
            else porEmail.set(email, indice);
        }
    });
    const grupos = new Map();
    clientes.forEach((cliente, indice) => {
        const raiz = encontrar(indice);
        if (!grupos.has(raiz)) grupos.set(raiz, []);
        grupos.get(raiz).push(cliente);
    });
    const pontuar = cliente => {
        const assinatura = cliente.assinaturaAtiva;
        const idAssinatura = String(assinatura?.userId || assinatura?.id || '');
        let pontos = assinatura ? 1000 : (cliente.planoAtivoId || cliente.isVip ? 500 : 0);
        if (idAssinatura && idAssinatura === String(cliente.id)) pontos += 200;
        ['nome', 'telefone', 'email', 'observacoes', 'dataNascimento'].forEach(campo => {
            if (cliente[campo]) pontos += 1;
        });
        return pontos;
    };
    const dataMaisRecente = (a, b) => String(a || '') > String(b || '') ? a : b;
    return [...grupos.values()].map(grupo => {
        const ordenado = [...grupo].sort((a, b) => pontuar(b) - pontuar(a));
        const base = { ...ordenado[0] };
        const idsRelacionados = new Set();
        const tags = new Map();
        ordenado.forEach(cliente => {
            if (cliente.id) idsRelacionados.add(String(cliente.id));
            (cliente.idsRelacionados || []).forEach(id => idsRelacionados.add(String(id)));
            (Array.isArray(cliente.tags) ? cliente.tags : []).forEach(tag => {
                const chave = String(tag).trim().toLowerCase();
                if (chave && !tags.has(chave)) tags.set(chave, tag);
            });
            ['nome', 'telefone', 'telefoneNormalizado', 'email', 'emailNormalizado', 'observacoes', 'dataNascimento'].forEach(campo => {
                if (!base[campo] && cliente[campo]) base[campo] = cliente[campo];
            });
            base.totalAgendamentos = Math.max(Number(base.totalAgendamentos) || 0, Number(cliente.totalAgendamentos) || 0);
            base.totalConcluidos = Math.max(Number(base.totalConcluidos) || 0, Number(cliente.totalConcluidos) || 0);
            base.totalCancelados = Math.max(Number(base.totalCancelados) || 0, Number(cliente.totalCancelados) || 0);
            base.totalGastoCentavos = Math.max(Number(base.totalGastoCentavos) || 0, Number(cliente.totalGastoCentavos) || 0);
            base.ultimoAgendamentoEm = dataMaisRecente(base.ultimoAgendamentoEm, cliente.ultimoAgendamentoEm);
            base.proximoAgendamentoEm = dataMaisRecente(base.proximoAgendamentoEm, cliente.proximoAgendamentoEm);
            base.ultimaVisitaEm = dataMaisRecente(base.ultimaVisitaEm, cliente.ultimaVisitaEm);
            if (!base.assinaturaAtiva && cliente.assinaturaAtiva) base.assinaturaAtiva = cliente.assinaturaAtiva;
            if (!base.planoAtivoId && cliente.planoAtivoId) base.planoAtivoId = cliente.planoAtivoId;
            base.isVip = Boolean(base.isVip || cliente.isVip || cliente.assinaturaAtiva || cliente.planoAtivoId);
        });
        base.tags = [...tags.values()];
        if (base.isVip && !base.tags.some(tag => String(tag).trim().toLowerCase() === 'vip')) base.tags.push('VIP');
        base.idsRelacionados = [...idsRelacionados];
        return base;
    });
}
