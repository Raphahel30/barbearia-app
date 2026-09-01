import { makeWASocket, DisconnectReason, makeCacheableSignalKeyStore, useMultiFileAuthState, Browsers } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import QRCode from 'qrcode';
import fs from 'fs';
import path from 'path';

// ============================================================================
// ESTADO GLOBAL DO SERVIÇO DE WHATSAPP (EXCLUSIVO RENDER)
// ============================================================================
const WA_SESSION_DIR = path.resolve(process.cwd(), '.wa_session');

let sock = null;
let isConnecting = false;
let currentQrCode = null;
let currentPairingCode = null;
let connectionStatus = 'disconnected'; // 'disconnected' | 'connecting' | 'qr_ready' | 'connected'
let connectedNumber = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
let reconnectTimer = null;

const logger = pino({ level: 'silent' }); // Silencia logs de debug do Baileys para máxima velocidade

// ============================================================================
// CONSULTA DE STATUS EM TEMPO REAL
// ============================================================================
export function obterStatusWhatsApp() {
    return {
        status: connectionStatus,
        qrCode: currentQrCode,
        pairingCode: currentPairingCode,
        userNumber: connectedNumber,
        reconnectAttempts
    };
}

// ============================================================================
// CONEXÃO POR QR CODE
// ============================================================================
export async function iniciarWhatsApp({ force = false, onlyIfRegistered = false } = {}) {
    if (sock && connectionStatus === 'connected' && !force) {
        return { success: true, status: 'connected', userNumber: connectedNumber };
    }

    _limparReconexao();

    // Fecha socket anterior de forma segura e remove ouvintes
    if (sock && (connectionStatus !== 'connected' || force)) {
        try {
            sock.ev.removeAllListeners('connection.update');
            sock.ev.removeAllListeners('creds.update');
            sock.end(new Error('Reset para nova conexão'));
        } catch (_) {}
        sock = null;
    }

    isConnecting = false;
    currentQrCode = null;
    currentPairingCode = null;
    reconnectAttempts = 0;

    return _conectar({ gerarQr: true, forceNewCredsIfUnregistered: true, onlyIfRegistered });
}

// ============================================================================
// CONEXÃO POR CÓDIGO DE 8 DÍGITOS (Sem Câmera - Direto no WhatsApp)
// ============================================================================
export async function gerarCodigoPareamentoWhatsApp(numeroTelefone) {
    if (!numeroTelefone) {
        return { success: false, error: 'Número de telefone não informado.' };
    }

    let cleanNumber = String(numeroTelefone).replace(/\D/g, '');
    if (!cleanNumber.startsWith('55') && (cleanNumber.length === 10 || cleanNumber.length === 11)) {
        cleanNumber = '55' + cleanNumber;
    }
    if (cleanNumber.length < 12) {
        return { success: false, error: 'Número inválido. Digite com DDD (ex: 11993448991).' };
    }

    if (sock && connectionStatus === 'connected') {
        return { success: true, status: 'connected', userNumber: connectedNumber, message: 'WhatsApp já está conectado!' };
    }

    _limparReconexao();
    if (sock) {
        try {
            sock.ev.removeAllListeners('connection.update');
            sock.ev.removeAllListeners('creds.update');
            sock.end(new Error('Reset para geração de código de pareamento'));
        } catch (_) {}
        sock = null;
    }

    isConnecting = false;
    currentQrCode = null;
    currentPairingCode = null;
    reconnectAttempts = 0;

    const resultado = await _conectar({ gerarQr: false, numeroPairing: cleanNumber, forceNewCredsIfUnregistered: true });
    if (resultado && resultado.success && resultado.pairingCode) {
        return { success: true, pairingCode: resultado.pairingCode };
    }
    return resultado;
}

// ============================================================================
// DESCONECTAR / TROCAR NÚMERO DE WHATSAPP
// ============================================================================
export async function desconectarWhatsApp() {
    try {
        _limparReconexao();
        if (sock) {
            try {
                sock.ev.removeAllListeners('connection.update');
                sock.ev.removeAllListeners('creds.update');
                await sock.logout();
            } catch (_) {}
            try {
                sock.end(new Error('Logout efetuado'));
            } catch (_) {}
            sock = null;
        }

        // Apaga pasta local de sessão no servidor Render
        if (fs.existsSync(WA_SESSION_DIR)) {
            try {
                fs.rmSync(WA_SESSION_DIR, { recursive: true, force: true });
                console.log('[WhatsApp Bot] Sessão local apagada com sucesso no Render.');
            } catch (errRm) {
                console.warn('[WhatsApp Bot] Aviso ao apagar pasta de sessão:', errRm.message);
            }
        }

        connectionStatus = 'disconnected';
        connectedNumber = null;
        currentQrCode = null;
        currentPairingCode = null;
        reconnectAttempts = 0;
        isConnecting = false;
        return { success: true, message: 'WhatsApp desconectado e sessão apagada com sucesso.' };
    } catch (e) {
        connectionStatus = 'disconnected';
        sock = null;
        isConnecting = false;
        return { success: false, error: e.message };
    }
}

// ============================================================================
// DISPARO DE MENSAGENS
// ============================================================================
export async function enviarMensagemWhatsApp(numeroDestino, texto) {
    if (!numeroDestino || !texto) {
        return { success: false, error: 'Número ou mensagem inválidos.' };
    }

    let cleanNumber = String(numeroDestino).replace(/\D/g, '');
    if (!cleanNumber.startsWith('55') && (cleanNumber.length === 10 || cleanNumber.length === 11)) {
        cleanNumber = '55' + cleanNumber;
    }
    const jid = `${cleanNumber}@s.whatsapp.net`;

    if (!sock || connectionStatus !== 'connected') {
        console.log(`[WhatsApp Simulado / Offline] Para: ${cleanNumber} | Texto: ${String(texto).slice(0, 60)}...`);
        return { success: false, error: 'Robô do WhatsApp desconectado no momento.' };
    }

    try {
        await sock.sendMessage(jid, { text: texto });
        console.log(`[WhatsApp Bot] 📨 Mensagem enviada com sucesso para +${cleanNumber}`);
        return { success: true };
    } catch (err) {
        console.error(`[WhatsApp Bot] ❌ Erro ao disparar mensagem para +${cleanNumber}:`, err.message);
        return { success: false, error: err.message };
    }
}

// ============================================================================
// LÓGICA INTERNA DE CONEXÃO E RECONEXÃO 100% NATIVA NO RENDER
// ============================================================================
async function _conectar({ gerarQr = true, numeroPairing = null, forceNewCredsIfUnregistered = false, onlyIfRegistered = false } = {}) {
    if (isConnecting && !numeroPairing && !forceNewCredsIfUnregistered) {
        return { success: true, status: connectionStatus, qrCode: currentQrCode, message: 'Aguardando autenticação...' };
    }

    isConnecting = true;
    connectionStatus = 'connecting';
    currentQrCode = null;
    currentPairingCode = null;

    try {
        // Carrega estado de autenticação exclusivamente do disco do Render
        const { state: authState, saveCreds } = await useMultiFileAuthState(WA_SESSION_DIR);
        const isRegistered = !!authState.creds?.registered;

        // Se foi solicitado iniciar APENAS se já existir sessão salva (ex: boot do servidor)
        if (onlyIfRegistered && !isRegistered) {
            isConnecting = false;
            connectionStatus = 'disconnected';
            return { success: true, status: 'disconnected', message: 'Nenhuma sessão registrada. Aguardando comando.' };
        }

        const browserConfig = (Browsers && Browsers.ubuntu) 
            ? Browsers.ubuntu('Chrome') 
            : ['Ubuntu', 'Chrome', '22.04.4'];

        sock = makeWASocket({
            auth: {
                creds: authState.creds,
                keys: makeCacheableSignalKeyStore(authState.keys, logger)
            },
            logger,
            printQRInTerminal: false,
            browser: browserConfig,
            connectTimeoutMs: 60000,
            keepAliveIntervalMs: 15000,
            retryRequestDelayMs: 250,
            syncFullHistory: false,
            markOnlineOnConnect: false,
            generateHighQualityLinkPreview: false,
            getMessage: async () => ({ conversation: '' })
        });

        // ─── PROMISE PARA RETORNO IMEDIATO DO QR CODE OU STATUS ──────────────
        return new Promise(async (resolve) => {
            let settled = false;

            const timeoutTimer = setTimeout(() => {
                if (!settled) {
                    settled = true;
                    resolve({
                        success: true,
                        status: connectionStatus,
                        qrCode: currentQrCode,
                        message: currentQrCode ? 'QR Code pronto!' : 'Aguardando resposta do WhatsApp...'
                    });
                }
            }, 6000); // 6 segundos de janela para resposta imediata ao frontend

            const settleWithResult = (data) => {
                if (!settled) {
                    settled = true;
                    clearTimeout(timeoutTimer);
                    resolve(data);
                }
            };

            // ─── EVENTOS DO BAILEYS ────────────────────────────────────────────
            sock.ev.on('creds.update', saveCreds);

            sock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect, qr } = update;

                if (qr && gerarQr) {
                    try {
                        currentQrCode = await QRCode.toDataURL(qr);
                    } catch (_) {
                        currentQrCode = `data:image/png;base64,${Buffer.from(qr).toString('base64')}`;
                    }
                    connectionStatus = 'qr_ready';
                    console.log('[WhatsApp Bot] 📱 QR Code gerado e pronto para leitura.');
                    settleWithResult({ success: true, status: 'qr_ready', qrCode: currentQrCode });
                }

                if (connection === 'open') {
                    isConnecting = false;
                    connectionStatus = 'connected';
                    currentQrCode = null;
                    currentPairingCode = null;
                    reconnectAttempts = 0;
                    _limparReconexao();
                    connectedNumber = sock.user?.id?.split(':')[0] || sock.user?.id?.split('@')[0] || null;
                    console.log(`[WhatsApp Bot] ✅ Conectado com sucesso no Render! Barbeiro: +${connectedNumber}`);
                    settleWithResult({ success: true, status: 'connected', userNumber: connectedNumber });
                }

                if (connection === 'close') {
                    isConnecting = false;
                    const statusCode = lastDisconnect?.error instanceof Boom ? lastDisconnect.error.output.statusCode : 0;
                    const wasLoggedOut = statusCode === DisconnectReason.loggedOut;
                    const shouldReconnect = !wasLoggedOut;

                    console.log(`[WhatsApp Bot] Conexão finalizada. Código: ${statusCode} | Reconectar: ${shouldReconnect}`);

                    if (wasLoggedOut) {
                        connectionStatus = 'disconnected';
                        connectedNumber = null;
                        sock = null;
                        if (fs.existsSync(WA_SESSION_DIR)) {
                            try { fs.rmSync(WA_SESSION_DIR, { recursive: true, force: true }); } catch (_) {}
                        }
                        console.log('[WhatsApp Bot] Logout do usuário detectado. Sessão apagada do Render.');
                    } else if (shouldReconnect && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                        connectionStatus = 'connecting';
                        reconnectAttempts++;
                        const delay = Math.min(3000 * reconnectAttempts, 15000);
                        console.log(`[WhatsApp Bot] Reconectando em ${delay / 1000}s (Tentativa ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
                        _limparReconexao();
                        reconnectTimer = setTimeout(() => _conectar({ gerarQr: false }), delay);
                    } else {
                        connectionStatus = 'disconnected';
                        currentQrCode = null;
                        currentPairingCode = null;
                        sock = null;
                        _limparReconexao();
                        console.log('[WhatsApp Bot] Sessão em repouso. Aguardando comando.');
                    }
                }
            });

            // Modo Pareamento por Código de 8 Dígitos
            if (!isRegistered && numeroPairing && !gerarQr) {
                await new Promise(r => setTimeout(r, 1200));
                try {
                    const code = await sock.requestPairingCode(numeroPairing);
                    currentPairingCode = code;
                    console.log(`[WhatsApp Bot] 🔑 Código de pareamento gerado com sucesso: ${code}`);
                    isConnecting = false;
                    settleWithResult({ success: true, pairingCode: code });
                } catch (pairingErr) {
                    console.error('[WhatsApp Bot] Erro ao solicitar código de pareamento:', pairingErr.message);
                    isConnecting = false;
                    settleWithResult({ success: false, error: `Erro ao gerar código: ${pairingErr.message}` });
                }
            }
        });
    } catch (err) {
        isConnecting = false;
        connectionStatus = 'disconnected';
        console.error('[WhatsApp Bot] Erro ao inicializar conexão:', err.message);
        return { success: false, error: err.message };
    }
}

function _limparReconexao() {
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
}
