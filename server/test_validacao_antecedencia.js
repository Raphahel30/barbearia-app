import fs from 'fs';
import path from 'path';

const serverPath = fs.existsSync('./server/src/server.js') 
    ? './server/src/server.js' 
    : (fs.existsSync('./src/server.js') ? './src/server.js' : path.resolve('../server/src/server.js'));

const content = fs.readFileSync(serverPath, 'utf8');

// Extract function validarAntecedenciaMinimaAgendamento
const fnMatch = content.match(/function validarAntecedenciaMinimaAgendamento[\s\S]*?\n\}/);
if (!fnMatch) {
  console.error('Function not found!');
  process.exit(1);
}

const validarAntecedenciaMinimaAgendamento = new Function('dataHora', fnMatch[0].replace('function validarAntecedenciaMinimaAgendamento(dataHora) {', '').replace(/\}\s*$/, ''));

const agoraBrStr = new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' });
const agoraBr = new Date(agoraBrStr);
const hojeAno = agoraBr.getFullYear();
const hojeMes = String(agoraBr.getMonth() + 1).padStart(2, '0');
const hojeDia = String(agoraBr.getDate()).padStart(2, '0');
const hojeIso = `${hojeAno}-${hojeMes}-${hojeDia}`;

console.log('Data Hoje (Brasília):', hojeIso);
console.log('Hora Agora (Brasília):', agoraBr.getHours() + ':' + String(agoraBr.getMinutes()).padStart(2, '0'));

// Test 1: 10 minutes in future (less than 20 min) -> must be blocked
const m10 = agoraBr.getHours() * 60 + agoraBr.getMinutes() + 10;
const h10 = Math.floor(m10 / 60) % 24;
const min10 = m10 % 60;
const time10 = String(h10).padStart(2, '0') + ':' + String(min10).padStart(2, '0');
const r1 = validarAntecedenciaMinimaAgendamento(`${hojeIso}T${time10}`);
console.log('Test 1 (+10 min today - must be blocked):', r1);
if (r1.valido !== false) throw new Error('Test 1 failed!');

// Test 2: 45 minutes in future (more than 20 min) -> must be allowed
const m45 = agoraBr.getHours() * 60 + agoraBr.getMinutes() + 45;
const h45 = Math.floor(m45 / 60);
const min45 = m45 % 60;
if (h45 < 24) {
  const time45 = String(h45).padStart(2, '0') + ':' + String(min45).padStart(2, '0');
  const r2 = validarAntecedenciaMinimaAgendamento(`${hojeIso}T${time45}`);
  console.log('Test 2 (+45 min today - must be allowed):', r2);
  if (r2.valido !== true) throw new Error('Test 2 failed!');
}

// Test 3: Past time today -> must be blocked
const mPast = Math.max(0, agoraBr.getHours() * 60 + agoraBr.getMinutes() - 30);
const hPast = Math.floor(mPast / 60);
const minPast = mPast % 60;
const timePast = String(hPast).padStart(2, '0') + ':' + String(minPast).padStart(2, '0');
const r3 = validarAntecedenciaMinimaAgendamento(`${hojeIso}T${timePast}`);
console.log('Test 3 (Past time today - must be blocked):', r3);
if (r3.valido !== false) throw new Error('Test 3 failed!');

// Test 4: Future date -> must be allowed
const r4 = validarAntecedenciaMinimaAgendamento('2099-01-01T10:00');
console.log('Test 4 (Future date - must be allowed):', r4);
if (r4.valido !== true) throw new Error('Test 4 failed!');

console.log('\n✅ ALL BACKEND VALIDATION TESTS PASSED!');
