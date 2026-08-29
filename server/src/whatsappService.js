import https from 'https';
import http from 'http';
import dotenv from 'dotenv';

dotenv.config();

// Configurações da Evolution API (via variáveis de ambiente)
const EVOLUTION_API_URL = (process.env.EVOLUTION_API_URL || '').replace(/\/$/, '');
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || '';
const EVOLUTION_INSTANCE_NAME = process.env.EVOLUTION_INSTANCE_NAME || 'emaus-barbearia';

// Cache em memória de status para respostas ultra-rápidas
let cachedStatus = {
    status: 'disconnected', // 'disconnected' | 'connecting' | 'qr_ready' | 'connected'
    qrCode: null,
    userNumber: null,
    lastChecked: 0
};

// Helper interno para requisições HTTP/HTTPS para a Evolution API com timeout de 8s
function callEvolutionApi(path, method = 'GET', body = null) {
    return new Promise((resolve) => {
        if (!EVOLUTION_API_URL || !EVOLUTION_API_KEY) {
            return resolve({
                success: false,
                notConfigured: true,
                message: 'Evolution API não configurada. Defina EVOLUTION_API_URL e EVOLUTION_API_KEY no painel do Render.'
            });
        }

        try {
            const url = new URL(\\);
            const isHttps = url.protocol === 'https:';
            const client = isHttps ? https : http;

            const postData = body ? JSON.stringify(body) : null;
            const headers = {
                'apikey': EVOLUTION_API_KEY,
                'Content-Type': 'application/json'
            };
            if (postData) {
                headers['Content-Length'] = Buffer.byteLength(postData);
            }

            const options = {
                hostname: url.hostname,
                port: url.port || (isHttps ? 443 : 80),
                path: \\,
                method: method,
                headers: headers,
                timeout: 8000
            };

            const req = client.request(options, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const parsed = data ? JSON.parse(data) : {};
                        resolve({
                            statusCode: res.statusCode,
                            success: res.statusCode >= 200 && res.statusCode < 300,
                            data: parsed
                        });
                    } catch (e) {
                        resolve({
                            statusCode: res.statusCode,
                            success: res.statusCode >= 200 && res.statusCode < 300,
                            data: data
                        });
                    }
                });
            });

            req.on('timeout', () => {
                req.destroy();
                resolve({ success: false, error: 'Timeout ao comunicar com Evolution API' });
            });

            req.on('error', (err) => {
                resolve({ success: false, error: err.message });
            });

            if (postData) req.write(postData);
            req.end();
        } catch (err) {
            resolve({ success: false, error: err.message });
        }
    });
}

/** Guarantees instance exists in Evolution API */
async function garantirInstanciaCriada() {
    if (!EVOLUTION_API_URL || !EVOLUTION_API_KEY) return;
    try {
        const check = await callEvolutionApi(/instance/connectionState/\);
        if (check.statusCode === 404 || (check.data && check.data.error === 'Not Found')) {
            console.log([Evolution API] Criando instância ...);
            await callEvolutionApi('/instance/create', 'POST', {
                instanceName: EVOLUTION_INSTANCE_NAME,
                token: EVOLUTION_API_KEY,
                qrcode: true,
                integration: 'WHATSAPP-BAILEYS'
            });
        }
    } catch (e) {
        console.warn('[Evolution API] Aviso ao verificar/criar instância:', e.message);
    }
}

export async function obterStatusWhatsApp() {
    const now = Date.now();
    if (now - cachedStatus.lastChecked < 3000 && cachedStatus.status === 'connected') {
        return cachedStatus;
    }

    if (!EVOLUTION_API_URL || !EVOLUTION_API_KEY) {
        return {
            status: 'disconnected',
            qrCode: null,
            userNumber: null,
            notConfigured: true,
            message: 'Evolution API não configurada. Defina EVOLUTION_API_URL e EVOLUTION_API_KEY no Render.'
        };
    }

    try {
        const res = await callEvolutionApi(/instance/connectionState/\);
        if (res.success && res.data && res.data.instance) {
            const state = res.data.instance.state;
            const owner = res.data.instance.owner || null;
            let statusStr = 'disconnected';
            if (state === 'open') statusStr = 'connected';
            else if (state === 'connecting') statusStr = 'connecting';

            cachedStatus = {
                status: statusStr,
                qrCode: null,
                userNumber: owner ? owner.split('@')[0] : null,
                lastChecked: now
            };
            return cachedStatus;
        }
    } catch (e) {
        console.warn('[Evolution API] Erro ao obter status:', e.message);
    }

    return cachedStatus;
}

export async function iniciarWhatsApp() {
    await garantirInstanciaCriada();
    const statusAtual = await obterStatusWhatsApp();
    if (statusAtual.status === 'connected') {
        return { success: true, status: 'connected', userNumber: statusAtual.userNumber };
    }

    try {
        const connectRes = await callEvolutionApi(/instance/connect/\);
        if (connectRes.success && connectRes.data) {
            if (connectRes.data.base64 || connectRes.data.qrcode) {
                cachedStatus.status = 'qr_ready';
                cachedStatus.qrCode = connectRes.data.base64 || connectRes.data.qrcode;
                return { success: true, status: 'qr_ready', qrCode: cachedStatus.qrCode };
            }
            if (connectRes.data.instance && connectRes.data.instance.state === 'open') {
                cachedStatus.status = 'connected';
                return { success: true, status: 'connected' };
            }
        }
    } catch (e) {
        console.error('[Evolution API] Erro ao conectar instância:', e.message);
    }

    return { success: false, status: cachedStatus.status };
}

export async function gerarCodigoPareamentoWhatsApp(numeroTelefone) {
    if (!numeroTelefone) {
        return { success: false, error: 'Número de telefone não informado' };
    }

    let cleanNumber = String(numeroTelefone).replace(/\D/g, '');
    if (!cleanNumber.startsWith('55') && (cleanNumber.length === 10 || cleanNumber.length === 11)) {
        cleanNumber = '55' + cleanNumber;
    }

    await garantirInstanciaCriada();

    try {
        const res = await callEvolutionApi(/instance/connect/?number=\);
        if (res.success && res.data) {
            const code = res.data.pairingCode || res.data.code || (res.data.instance && res.data.instance.pairingCode);
            if (code) {
                cachedStatus.status = 'connecting';
                return { success: true, pairingCode: code };
            }
            if (res.data.instance && res.data.instance.state === 'open') {
                cachedStatus.status = 'connected';
                return { success: true, status: 'connected', message: 'WhatsApp já conectado!' };
            }
        }
        return {
            success: false,
            error: (res.data && res.data.response && res.data.response.message) || res.error || 'Não foi possível obter o código da Evolution API'
        };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

export async function desconectarWhatsApp() {
    try {
        await callEvolutionApi(/instance/logout/\, 'DELETE');
        cachedStatus = { status: 'disconnected', qrCode: null, userNumber: null, lastChecked: 0 };
        return { success: true, message: 'Desconectado com sucesso' };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

export async function enviarMensagemWhatsApp(numeroDestino, texto) {
    if (!numeroDestino || !texto) {
        return { success: false, error: 'Número ou texto inválido' };
    }

    if (!EVOLUTION_API_URL || !EVOLUTION_API_KEY) {
        console.log([WhatsApp Simulado - Evolution API não configurada] Para:  | Msg: ...);
        return { success: true, simulated: true };
    }

    let cleanNumber = String(numeroDestino).replace(/\D/g, '');
    if (!cleanNumber.startsWith('55') && (cleanNumber.length === 10 || cleanNumber.length === 11)) {
        cleanNumber = '55' + cleanNumber;
    }

    try {
        const body = {
            number: cleanNumber,
            text: texto,
            options: {
                delay: 1200,
                presence: 'composing',
                linkPreview: true
            }
        };

        const res = await callEvolutionApi(/message/sendText/\, 'POST', body);
        if (res.success) {
            return { success: true, data: res.data };
        }
        return {
            success: false,
            error: (res.data && res.data.response && res.data.response.message) || res.error || 'Erro ao disparar mensagem'
        };
    } catch (err) {
        return { success: false, error: err.message };
    }
}