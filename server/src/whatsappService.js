import https from 'https';
import http from 'http';
import dotenv from 'dotenv';

dotenv.config();

// ============================================================================
// CONFIGURAÇÕES DA EVOLUTION API
// ============================================================================
const EVOLUTION_API_URL = (process.env.EVOLUTION_API_URL || '').trim().replace(/\/+$/, '');
const EVOLUTION_API_KEY = (process.env.EVOLUTION_API_KEY || '').trim();
const EVOLUTION_INSTANCE_NAME = (process.env.EVOLUTION_INSTANCE_NAME || 'emaus-barbearia').trim();

// Cache de status para respostas instantâneas ao painel administrativo
let cachedStatus = {
    status: 'disconnected', // 'disconnected' | 'connecting' | 'qr_ready' | 'connected'
    qrCode: null,
    pairingCode: null,
    userNumber: null,
    notConfigured: false,
    lastChecked: 0
};

// ============================================================================
// CLIENTE HTTP NATIVO PARA EVOLUTION API (Zero Dependências Pesadas)
// ============================================================================
function callEvolutionApi(path, method = 'GET', body = null) {
    return new Promise((resolve) => {
        if (!EVOLUTION_API_URL || !EVOLUTION_API_KEY) {
            return resolve({
                success: false,
                notConfigured: true,
                error: 'Evolution API não configurada. Defina EVOLUTION_API_URL e EVOLUTION_API_KEY no painel do Render.'
            });
        }

        try {
            const fullUrl = `${EVOLUTION_API_URL}${path.startsWith('/') ? path : '/' + path}`;
            const parsedUrl = new URL(fullUrl);
            const isHttps = parsedUrl.protocol === 'https:';
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
                hostname: parsedUrl.hostname,
                port: parsedUrl.port || (isHttps ? 443 : 80),
                path: `${parsedUrl.pathname}${parsedUrl.search}`,
                method: method,
                headers: headers,
                timeout: 10000 // 10s timeout
            };

            const req = client.request(options, (res) => {
                let rawData = '';
                res.on('data', chunk => rawData += chunk);
                res.on('end', () => {
                    let parsed = null;
                    try {
                        parsed = rawData ? JSON.parse(rawData) : {};
                    } catch (_) {
                        parsed = { raw: rawData };
                    }
                    resolve({
                        statusCode: res.statusCode,
                        success: res.statusCode >= 200 && res.statusCode < 300,
                        data: parsed
                    });
                });
            });

            req.on('timeout', () => {
                req.destroy();
                resolve({ success: false, error: 'Timeout ao conectar com a Evolution API (10s).' });
            });

            req.on('error', (err) => {
                resolve({ success: false, error: `Falha de rede com Evolution API: ${err.message}` });
            });

            if (postData) req.write(postData);
            req.end();
        } catch (err) {
            resolve({ success: false, error: `Erro na URL da Evolution API: ${err.message}` });
        }
    });
}

// ============================================================================
// GARANTIR EXISTÊNCIA DA INSTÂNCIA NA EVOLUTION API
// ============================================================================
export async function garantirInstanciaCriada() {
    if (!EVOLUTION_API_URL || !EVOLUTION_API_KEY) return { success: false, notConfigured: true };

    try {
        const check = await callEvolutionApi(`/instance/connectionState/${EVOLUTION_INSTANCE_NAME}`);
        if (check.statusCode === 404 || (check.data && (check.data.error === 'Not Found' || check.data.status === 404))) {
            console.log(`[Evolution API] Instância '${EVOLUTION_INSTANCE_NAME}' não encontrada. Criando...`);
            const createRes = await callEvolutionApi('/instance/create', 'POST', {
                instanceName: EVOLUTION_INSTANCE_NAME,
                token: EVOLUTION_API_KEY,
                qrcode: true,
                integration: 'WHATSAPP-BAILEYS'
            });
            return createRes;
        }
        return { success: true };
    } catch (e) {
        console.warn('[Evolution API] Aviso ao verificar/criar instância:', e.message);
        return { success: false, error: e.message };
    }
}

// ============================================================================
// CONSULTA DE STATUS EM TEMPO REAL
// ============================================================================
export async function obterStatusWhatsApp() {
    const now = Date.now();
    // Cache de 3 segundos para conexões ativas
    if (now - cachedStatus.lastChecked < 3000 && cachedStatus.status === 'connected') {
        return cachedStatus;
    }

    if (!EVOLUTION_API_URL || !EVOLUTION_API_KEY) {
        return {
            status: 'disconnected',
            qrCode: null,
            pairingCode: null,
            userNumber: null,
            notConfigured: true,
            message: 'Evolution API não configurada. Defina EVOLUTION_API_URL e EVOLUTION_API_KEY no Render.'
        };
    }

    try {
        const res = await callEvolutionApi(`/instance/connectionState/${EVOLUTION_INSTANCE_NAME}`);
        if (res.success && res.data) {
            const inst = res.data.instance || res.data;
            const state = (inst.state || res.data.state || '').toLowerCase();
            const owner = inst.owner || res.data.owner || null;

            let statusStr = 'disconnected';
            if (state === 'open') statusStr = 'connected';
            else if (state === 'connecting') statusStr = 'connecting';

            cachedStatus = {
                status: statusStr,
                qrCode: cachedStatus.qrCode,
                pairingCode: cachedStatus.pairingCode,
                userNumber: owner ? String(owner).split('@')[0].split(':')[0] : null,
                notConfigured: false,
                lastChecked: now
            };
            return cachedStatus;
        } else if (res.statusCode === 404) {
            await garantirInstanciaCriada();
        }
    } catch (e) {
        console.warn('[Evolution API] Erro ao obter status:', e.message);
    }

    cachedStatus.lastChecked = now;
    return cachedStatus;
}

// ============================================================================
// CONEXÃO POR QR CODE (Ler com Câmera)
// ============================================================================
export async function iniciarWhatsApp() {
    await garantirInstanciaCriada();
    const statusAtual = await obterStatusWhatsApp();
    if (statusAtual.status === 'connected') {
        return { success: true, status: 'connected', userNumber: statusAtual.userNumber };
    }

    try {
        const connectRes = await callEvolutionApi(`/instance/connect/${EVOLUTION_INSTANCE_NAME}`);
        if (connectRes.success && connectRes.data) {
            const qr = connectRes.data.base64 || connectRes.data.qrcode || connectRes.data.code;
            if (qr) {
                const qrFinal = String(qr).startsWith('data:image') ? qr : `data:image/png;base64,${qr}`;
                cachedStatus.status = 'qr_ready';
                cachedStatus.qrCode = qrFinal;
                return { success: true, status: 'qr_ready', qrCode: qrFinal };
            }
            if (connectRes.data.instance && connectRes.data.instance.state === 'open') {
                cachedStatus.status = 'connected';
                return { success: true, status: 'connected' };
            }
        }
        return {
            success: false,
            error: (connectRes.data && connectRes.data.response && connectRes.data.response.message) || connectRes.error || 'Não foi possível gerar o QR Code na Evolution API.'
        };
    } catch (e) {
        console.error('[Evolution API] Erro ao conectar instância:', e.message);
        return { success: false, error: e.message };
    }
}

// ============================================================================
// CONEXÃO POR CÓDIGO DE 8 DÍGITOS (Sem Câmera)
// ============================================================================
export async function gerarCodigoPareamentoWhatsApp(numeroTelefone) {
    if (!numeroTelefone) {
        return { success: false, error: 'Número de telefone não informado' };
    }

    let cleanNumber = String(numeroTelefone).replace(/\D/g, '');
    if (!cleanNumber.startsWith('55') && (cleanNumber.length === 10 || cleanNumber.length === 11)) {
        cleanNumber = '55' + cleanNumber;
    }
    if (cleanNumber.length < 12) {
        return { success: false, error: 'Número inválido. Digite com DDD (ex: 11993448991).' };
    }

    await garantirInstanciaCriada();

    try {
        // Tenta endpoint padrão com parâmetro number
        const res = await callEvolutionApi(`/instance/connect/${EVOLUTION_INSTANCE_NAME}?number=${cleanNumber}`);
        if (res.success && res.data) {
            const code = res.data.pairingCode || res.data.code || (res.data.instance && res.data.instance.pairingCode);
            if (code) {
                cachedStatus.status = 'connecting';
                cachedStatus.pairingCode = code;
                return { success: true, pairingCode: code };
            }
            if (res.data.instance && res.data.instance.state === 'open') {
                cachedStatus.status = 'connected';
                return { success: true, status: 'connected', message: 'WhatsApp já conectado!' };
            }
        }

        // Fallback para endpoint v2: /instance/pairing-code/:name
        const fallbackRes = await callEvolutionApi(`/instance/pairing-code/${EVOLUTION_INSTANCE_NAME}`, 'POST', {
            number: cleanNumber
        });
        if (fallbackRes.success && fallbackRes.data) {
            const fallbackCode = fallbackRes.data.pairingCode || fallbackRes.data.code;
            if (fallbackCode) {
                cachedStatus.status = 'connecting';
                cachedStatus.pairingCode = fallbackCode;
                return { success: true, pairingCode: fallbackCode };
            }
        }

        return {
            success: false,
            error: (res.data && res.data.response && res.data.response.message) || res.error || 'Não foi possível obter o código da Evolution API.'
        };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

// ============================================================================
// DESCONECTAR / TROCAR WHATSAPP
// ============================================================================
export async function desconectarWhatsApp() {
    try {
        await callEvolutionApi(`/instance/logout/${EVOLUTION_INSTANCE_NAME}`, 'DELETE');
        cachedStatus = {
            status: 'disconnected',
            qrCode: null,
            pairingCode: null,
            userNumber: null,
            notConfigured: false,
            lastChecked: 0
        };
        return { success: true, message: 'WhatsApp desconectado com sucesso na Evolution API.' };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

// ============================================================================
// DISPARO DE MENSAGEM DE TEXTO (Notificações, Lembretes e Alertas)
// ============================================================================
export async function enviarMensagemWhatsApp(numeroDestino, texto) {
    if (!numeroDestino || !texto) {
        return { success: false, error: 'Número ou texto inválido.' };
    }

    if (!EVOLUTION_API_URL || !EVOLUTION_API_KEY) {
        console.log(`[WhatsApp Simulado - Evolution API não configurada] Para: ${numeroDestino} | Msg: ${String(texto).slice(0, 60)}...`);
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

        const res = await callEvolutionApi(`/message/sendText/${EVOLUTION_INSTANCE_NAME}`, 'POST', body);
        if (res.success) {
            return { success: true, data: res.data };
        }
        return {
            success: false,
            error: (res.data && res.data.response && res.data.response.message) || res.error || 'Erro ao disparar mensagem pela Evolution API.'
        };
    } catch (err) {
        return { success: false, error: err.message };
    }
}
