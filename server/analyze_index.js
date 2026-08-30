import fs from 'fs';
const content = fs.readFileSync('index.html', 'utf8');
const lines = content.split('\n');

console.log('Total Lines in index.html:', lines.length);

const ids = [];
lines.forEach((l, idx) => {
  const match = l.match(/id=["']([^"']+)["']/g);
  if (match) {
    match.forEach(m => {
      const id = m.replace(/id=["']/, '').replace(/["']$/, '');
      ids.push({ line: idx + 1, id, snippet: l.trim().slice(0, 110) });
    });
  }
});

console.log('--- Key Sections in index.html ---');
ids.forEach(i => {
  const low = i.id.toLowerCase();
  if (low.includes('painel') || low.includes('aba') || low.includes('modal') || low.includes('perfil') || low.includes('secao') || low.includes('card') || low.includes('barbeiro') || low.includes('fidelidade') || low.includes('grade') || low.includes('header')) {
    console.log(`L${i.line}: [${i.id}] -> ${i.snippet}`);
  }
});
