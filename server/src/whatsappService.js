import { makeWASocket, DisconnectReason, makeCacheableSignalKeyStore, useMultiFileAuthState } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import QRCode from 'qrcode';
import { useFirestoreAuthState } from './firestoreAuthState.js';

// ============================================================================
// ESTADO GLOBAL DO SERVIÇO DE WHATSAPP
// ============================================================================
let sock = null;
let firestoreDbInstance = null;
let clearFirestoreSessionFn = null;

let isConnecting = false;
let currentQrCode = null;
let currentPairingCode = null;
let connectionStatus = 'disconnected'; // 'disconnected' | 'connecting' | 'qr_ready' | 'connected'
let connectedNumber = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 8;
let reconnectTimer = null;

const logger = pino({ level: 'silent' }); // Silencia logs de debug do Baileys para performance

// ============================================================================
// CONFIGURAÇÃO DO BANCO DE DADOS (FIRESTORE)
// ============================================================================
export function setFirestoreDatabase(db) {
    if (db) {
        firestoreDbInstance = db;
        console.log('✅ [WhatsApp Bot] Firestore Database vinculado com sucesso para Sessão Persistente 24/7!');
    }
}

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
export async function iniciarWhatsApp() {
    if (sock && connectionStatus === 'connected') {
        return { success: true, status: 'connected', userNumber: connectedNumber };
    }
    if (isConnecting) {
        return { success: true, status: 'connecting', message: 'Conexão já em andamento...' };
    }
    return _conectar({ gerarQr: true });
}

// ============================================================================
// CONEXÃO POR CÓDIGO DE 8 DÍGITOS (Sem Câmera)
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
        return { success: true, status: 'connected', message: 'WhatsApp já está conectado!' };
    }

    // Se já existia um socket aguardando QR Code, encerra limpo para iniciar o modo pareamento
    if (sock && connectionStatus !== 'connected') {
        try {
            sock.end(new Error('Reset para geração de código de pareamento'));
        } catch (_) {}
        sock = null;
        isConnecting = false;
    }

    const resultado = await _conectar({ gerarQr: false, numeroPairing: cleanNumber });
    if (resultado.success && resultado.pairingCode) {
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
                await sock.logout();
            } catch (_) {}
            sock = null;
        }

        if (clearFirestoreSessionFn) {
            await clearFirestoreSessionFn();
        }

        connectionStatus = 'disconnected';
        connectedNumber = null;
        currentQrCode = null;
        currentPairingCode = null;
        reconnectAttempts = 0;
        return { success: true, message: 'WhatsApp desconectado e sessão apagada com sucesso.' };
    } catch (e) {
        connectionStatus = 'disconnected';
        sock = null;
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
        return { success: true };
    } catch (err) {
        console.error('[WhatsApp] Erro ao disparar mensagem:', err.message);
        return { success: false, error: err.message };
    }
}

// ============================================================================
// LÓGICA INTERNA DE CONEXÃO E RECONEXÃO COM FIRESTORE
// ============================================================================
async function _conectar({ gerarQr = true, numeroPairing = null } = {}) {
    if (isConnecting && !numeroPairing) {
        return { success: true, status: 'connecting', message: 'Aguardando autenticação...' };
    }

    isConnecting = true;
    connectionStatus = 'connecting';
    currentQrCode = null;
    currentPairingCode = null;

    try {
        let authState;
        let saveCreds;

        if (firestoreDbInstance) {
            const firestoreAuth = await useFirestoreAuthState(firestoreDbInstance, '_whatsapp_session');
            authState = firestoreAuth.state;
            saveCreds = firestoreAuth.saveCreds;
            clearFirestoreSessionFn = firestoreAuth.clearSession;
        } else {
            const localAuth = await useMultiFileAuthState('./.wa_session');
            authState = localAuth.state;
            saveCreds = localAuth.saveCreds;
        }

        const isNewSession = !authState.creds?.registered;

        sock = makeWASocket({
            auth: {
                creds: authState.creds,
                keys: makeCacheableSignalKeyStore(authState.keys, logger)
            },
            logger,
            printQRInTerminal: false,
            browser: ['EMAUS Barbearia', 'Chrome', '120.0.0'],
            connectTimeoutMs: 60000,
            keepAliveIntervalMs: 15000,
            retryRequestDelayMs: 250,
            syncFullHistory: false,
            markOnlineOnConnect: false,
            generateHighQualityLinkPreview: false,
            getMessage: async () => ({ conversation: '' })
        });

        // Modo Pareamento por Código de 8 Dígitos
        if (isNewSession && numeroPairing && !gerarQr) {
            // Aguarda 1.5s para handshake do socket
            await new Promise(resolve => setTimeout(resolve, 1500));
            try {
                const code = await sock.requestPairingCode(numeroPairing);
                currentPairingCode = code;
                console.log(`[WhatsApp Bot] 🔑 Código de pareamento gerado com sucesso: ${code}`);
                isConnecting = false;
                return { success: true, pairingCode: code };
            } catch (pairingErr) {
                console.error('[WhatsApp Bot] Erro ao solicitar código de pareamento:', pairingErr.message);
                isConnecting = false;
                return { success: false, error: `Erro ao gerar código: ${pairingErr.message}` };
            }
        }

        // ─── EVENTOS DO BAILEYS ────────────────────────────────────────────────
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
                console.log('[WhatsApp Bot] 📱 QR Code gerado e disponível para o Barbeiro.');
            }

            if (connection === 'open') {
                isConnecting = false;
                connectionStatus = 'connected';
                currentQrCode = null;
                currentPairingCode = null;
                reconnectAttempts = 0;
                _limparReconexao();
                connectedNumber = sock.user?.id?.split(':')[0] || sock.user?.id?.split('@')[0] || null;
                console.log(`[WhatsApp Bot] ✅ Conectado com sucesso! Barbeiro: +${connectedNumber}`);
            }

            if (connection === 'close') {
                isConnecting = false;
                const statusCode = lastDisconnect?.error instanceof Boom ? lastDisconnect.error.output.statusCode : 0;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                const wasLoggedOut = statusCode === DisconnectReason.loggedOut;

                console.log(`[WhatsApp Bot] Conexão finalizada. Código: ${statusCode} | Reconectar: ${shouldReconnect}`);

                if (wasLoggedOut) {
                    connectionStatus = 'disconnected';
                    connectedNumber = null;
                    sock = null;
                    if (clearFirestoreSessionFn) await clearFirestoreSessionFn();
                    console.log('[WhatsApp Bot] Logout do usuário detectado. Sessão apagada.');
                } else if (shouldReconnect && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                    connectionStatus = 'connecting';
                    reconnectAttempts++;
                    const delay = Math.min(3000 * reconnectAttempts, 20000);
                    console.log(`[WhatsApp Bot] Reconectando em ${delay / 1000}s (Tentativa ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
                    _limparReconexao();
                    reconnectTimer = setTimeout(() => _conectar({ gerarQr: false }), delay);
                } else {
                    connectionStatus = 'disconnected';
                    sock = null;
                    console.log('[WhatsApp Bot] Reconexão em standby. Aguardando comando.');
                }
            }
        });

        return { success: true, status: 'connecting', message: 'Aguardando autenticação...' };
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
