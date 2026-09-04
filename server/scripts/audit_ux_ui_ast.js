import fs from 'node:fs';
import { parse } from 'acorn';

console.log('🔍 Auditoria AST e UX/UI: Verificação Estática de Variáveis e Manipuladores de DOM...');

const html = fs.readFileSync('index.html', 'utf8');

// 1. Extração dos IDs do DOM no HTML
const domIds = new Set();
for (const match of html.matchAll(/id=["']([^"']+)["']/gi)) {
    domIds.add(match[1]);
}
console.log(`📋 Total de elementos com ID no DOM: ${domIds.size}`);

// 2. Extração de scripts
const scriptMatches = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)];
console.log(`📋 Total de blocos <script>: ${scriptMatches.length}`);

function walk(node, visitor) {
    if (!node || typeof node !== 'object') return;
    visitor(node);
    for (const key of Object.keys(node)) {
        if (key === 'loc' || key === 'range') continue;
        const child = node[key];
        if (Array.isArray(child)) {
            child.forEach(c => walk(c, visitor));
        } else if (child && typeof child === 'object') {
            walk(child, visitor);
        }
    }
}

let potentialErrors = [];

scriptMatches.forEach((m, scriptIdx) => {
    const code = m[2];
    if (!code.trim()) return;

    try {
        const ast = parse(code, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true });
        
        walk(ast, (node) => {
            if (node.type === 'CallExpression') {
                if (node.callee?.property?.name === 'getElementById') {
                    const arg = node.arguments[0];
                    if (arg?.type === 'Literal' && typeof arg.value === 'string') {
                        if (!domIds.has(arg.value)) {
                            potentialErrors.push({
                                type: 'ORPHAN_DOM_ID',
                                id: arg.value,
                                detail: `getElementById("${arg.value}")`
                            });
                        }
                    }
                }
            }
        });
    } catch (err) {
        potentialErrors.push({ type: 'SYNTAX_ERROR', detail: `Script #${scriptIdx + 1}: ${err.message}` });
    }
});

console.log(`✅ Análise AST concluída.`);
const orphans = potentialErrors.filter(e => e.type === 'ORPHAN_DOM_ID');
const errors = potentialErrors.filter(e => e.type === 'SYNTAX_ERROR');
console.log(`Erros de Sintaxe AST: ${errors.length}`);
console.log(`Total de chamadas getElementById para elementos criados dinamicamente: ${orphans.length}`);

// Agrupa por ID para identificar se algum é suspeito
const idCounts = {};
orphans.forEach(o => idCounts[o.id] = (idCounts[o.id] || 0) + 1);

console.log('\nExemplos de IDs verificados em tempo de execução:');
Object.entries(idCounts).slice(0, 20).forEach(([id, count]) => {
    console.log(`  - [${count}x] ${id}`);
});
