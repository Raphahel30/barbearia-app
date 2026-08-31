import assert from 'assert';
import fs from 'fs';

console.log('🧪 Verificando integridade das regras para Pix, Cartão, Webhook e Server Poller...');

const serverCode = fs.readFileSync('./server/src/server.js', 'utf8');
const indexCode = fs.readFileSync('./index.html', 'utf8');

// 1. notification_url presente no Pix e Cartão
assert(serverCode.includes("notification_url: notificationUrl"), "server.js deve enviar notification_url para o Mercado Pago");

// 2. data.id capturado no Webhook
assert(serverCode.includes("req.query['data.id']"), "server.js deve capturar data.id do Mercado Pago");

// 3. Server Poller de 5 segundos
assert(serverCode.includes("[Server Poller]"), "server.js deve ter o Server Poller de monitoramento ativo");

// 4. Salva com ID do pagamento no Firestore
assert(serverCode.includes("agendamentos').doc(String(response.id)).set"), "server.js deve pré-salvar com o ID do pagamento no Firestore");

// 5. Expiração de 3 minutos
assert(serverCode.includes("Date.now() + 3 * 60 * 1000"), "server.js deve definir expiraEm de 3 minutos");

console.log('✅ Validação completa com 100% de sucesso!');
