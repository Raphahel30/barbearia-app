import assert from 'assert';
import fs from 'fs';
import path from 'path';

console.log('🧪 Verificando integridade das regras para Pix, Cartão, Webhook e Reconciliação...');

// Suporta execução a partir da raiz do repositório ou de dentro de server/
const serverPath = fs.existsSync('./server/src/server.js') 
    ? './server/src/server.js' 
    : (fs.existsSync('./src/server.js') ? './src/server.js' : path.resolve('../server/src/server.js'));
const indexPath = fs.existsSync('./index.html') 
    ? './index.html' 
    : (fs.existsSync('../index.html') ? '../index.html' : path.resolve('../../index.html'));

const serverCode = fs.readFileSync(serverPath, 'utf8');
const indexCode = fs.readFileSync(indexPath, 'utf8');

// 1. notification_url presente no Pix e Cartão
assert(serverCode.includes("notification_url: notificationUrl"), "server.js deve enviar notification_url para o Mercado Pago");

// 2. data.id capturado no Webhook
assert(serverCode.includes("req.query['data.id']"), "server.js deve capturar data.id do Mercado Pago");

// 3. Processamento de conclusão de pagamento via Webhooks oficiais
assert(serverCode.includes("processarConclusaoPagamentoServidor"), "server.js deve processar a conclusão de pagamento via Webhook/Servidor");

// 4. Salva com ID do pagamento no Firestore (pagamentos_pendentes e agendamentos)
assert(serverCode.includes("pagamentos_pendentes") && serverCode.includes("agendamentos"), "server.js deve sincronizar pagamentos e agendamentos no Firestore");

// 5. Expiração e conciliação de 3 minutos
assert(serverCode.includes("3 * 60 * 1000"), "server.js deve definir janela de 3 minutos");

console.log('✅ Validação completa com 100% de sucesso!');
