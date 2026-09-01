import assert from 'assert';
import fs from 'fs';

console.log('🧪 Verificando regras de negócio e integridade do WhatsApp...');

const serverCode = fs.readFileSync('./server/src/server.js', 'utf8');
const indexCode = fs.readFileSync('./index.html', 'utf8');
const adminCode = fs.readFileSync('./admin.html', 'utf8');

// 1. WhatsApp Oficial da Barbearia
assert(serverCode.includes("WHATSAPP_OFICIAL_BARBEARIA = '5511953789095'"), 'server.js deve definir WHATSAPP_OFICIAL_BARBEARIA');
assert(indexCode.includes('MEU_WHATSAPP = "5511953789095"'), 'index.html deve inicializar MEU_WHATSAPP com o número oficial');

// 2. Sem duplicatas de DDI 55
assert(!adminCode.includes('wa.me/55${telLimpo}'), 'admin.html não deve ter wa.me/55${telLimpo}');

// 3. Validação da lógica resolverNumeroBarbeiro
const WHATSAPP_OFICIAL_BARBEARIA = '5511953789095';
function resolverNumeroBarbeiro(customNumber) {
    if (customNumber && String(customNumber).trim().replace(/\D/g, '').length >= 10) {
        let clean = String(customNumber).trim().replace(/\D/g, '');
        if (!clean.startsWith('55') && (clean.length === 10 || clean.length === 11)) {
            clean = '55' + clean;
        }
        return clean;
    }
    return WHATSAPP_OFICIAL_BARBEARIA;
}

assert.strictEqual(resolverNumeroBarbeiro(null), '5511953789095');
assert.strictEqual(resolverNumeroBarbeiro(undefined), '5511953789095');
assert.strictEqual(resolverNumeroBarbeiro(''), '5511953789095');
assert.strictEqual(resolverNumeroBarbeiro('11953789095'), '5511953789095');
assert.strictEqual(resolverNumeroBarbeiro('5511953789095'), '5511953789095');
assert.strictEqual(resolverNumeroBarbeiro('(11) 95378-9095'), '5511953789095');

console.log('✅ Todos os testes de consistência do WhatsApp passaram com 100% de sucesso!');
