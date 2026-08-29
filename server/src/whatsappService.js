import { makeWASocket, useMultiFileAuthState, DisconnectReason, makeCacheableSignalKeyStore } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── PERSISTÊNCIA DE SESSÃO ──────────────────────────────────────────────────
// Sessão salva em disco. No Render Free, o disco é efêmero entre deploys,
// mas a reconexão via QR Code ou Código de 8 dígitos é rápida.
// Para persistência real entre deploys, use RENDER DISK ou salve o estado
// no Firestore (upgrade futuro).
const SESSION_DIR = process.env.WA_SESSION_DIR || path.join(__dirname, '../../.wa_session');

// ─── ESTADO GLOBAL ────────────────────────────────────────────────────────────
let sock = null;
let isConnecting = false;
let currentQrCode = null;
let currentPairingCode = null;
let connectionStatus = 'disconnected'; // 'disconnected' | 'connecting' | 'connected'
let connectedNumber = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
let reconnectTimer = null;

const logger = pino({ level: 'silent' }); // silencia logs verbosos do Baileys no console

// ─── FUNÇÕES EXPORTADAS ───────────────────────────────────────────────────────

export function obterStatusWhatsApp() {
    return {
        status: connectionStatus,
        qrCode: currentQrCode,
        pairingCode: currentPairingCode,
        userNumber: connectedNumber,
        reconnectAttempts
    };
}

export async function iniciarWhatsApp() {
    if (sock && connectionStatus === 'connected') {
        return { success: true, status: 'connected', userNumber: connectedNumber };
    }
    if (isConnecting) {
        return { success: true, status: 'connecting', message: 'Conexão em andamento...' };
    }
    return _conectar({ gerarQr: true });
}

export async function gerarCodigoPareamentoWhatsApp(numeroTelefone) {
    if (!numeroTelefone) {
        return { success: false, error: 'Número de telefone não informado' };
    }

    let cleanNumber = String(numeroTelefone).replace(/\D/g, '');
    if (!cleanNumber.startsWith('55') && (cleanNumber.length === 10 || cleanNumber.length === 11)) {
        cleanNumber = '55' + cleanNumber;
    }
    if (cleanNumber.length < 12) {
        return { success: false, error: `Número inválido: ${cleanNumber}. Use o formato com DDD e DDI (55DDD9XXXXXXXX).` };
    }

    if (sock && connectionStatus === 'connected') {
        return { success: true, status: 'connected', message: 'WhatsApp já está conectado!' };
    }

    // Se já havia um socket aberto não conectado (ex: aguardando QR), encerra para iniciar modo pareamento limpo
    if (sock && connectionStatus !== 'connected') {
        try {
            sock.end(new Error('Reset para código de pareamento'));
        } catch (_) {}
        sock = null;
        isConnecting = false;
    }

    // Inicia conexão sem QR, modo pairing code
    const resultado = await _conectar({ gerarQr: false, numeroPairing: cleanNumber });
    if (resultado.success && resultado.pairingCode) {
        return { success: true, pairingCode: resultado.pairingCode };
    }
    return resultado;
}

export async function desconectarWhatsApp() {
    try {
        _limparReconexao();
        if (sock) {
            await sock.logout();
            sock = null;
        }
        _limparSessao();
        connectionStatus = 'disconnected';
        connectedNumber = null;
        currentQrCode = null;
        currentPairingCode = null;
        reconnectAttempts = 0;
        return { success: true, message: 'Desconectado e sessão apagada com sucesso.' };
    } catch (e) {
        connectionStatus = 'disconnected';
        sock = null;
        return { success: false, error: e.message };
    }
}

export async function enviarMensagemWhatsApp(numeroDestino, texto) {
    if (!numeroDestino || !texto) {
        return { success: false, error: 'Número ou texto inválido' };
    }

    let cleanNumber = String(numeroDestino).replace(/\D/g, '');
    if (!cleanNumber.startsWith('55') && (cleanNumber.length === 10 || cleanNumber.length === 11)) {
        cleanNumber = '55' + cleanNumber;
    }
    const jid = `${cleanNumber}@s.whatsapp.net`;

    if (!sock || connectionStatus !== 'connected') {
        console.log(`[WhatsApp] Não conectado — mensagem descartada para ${cleanNumber}: ${texto.slice(0, 60)}...`);
        return { success: false, error: 'WhatsApp não está conectado no momento.' };
    }

    try {
        await sock.sendMessage(jid, { text: texto });
        return { success: true };
    } catch (err) {
        console.error('[WhatsApp] Erro ao enviar mensagem:', err.message);
        return { success: false, error: err.message };
    }
}

// ─── LÓGICA INTERNA ───────────────────────────────────────────────────────────

async function _conectar({ gerarQr = true, numeroPairing = null } = {}) {
    if (isConnecting && !numeroPairing) {
        return { success: true, status: 'connecting', message: 'Já aguardando conexão...' };
    }

    isConnecting = true;
    connectionStatus = 'connecting';
    currentQrCode = null;
    currentPairingCode = null;

    try {
        if (!fs.existsSync(SESSION_DIR)) {
            fs.mkdirSync(SESSION_DIR, { recursive: true });
        }

        const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
        const isNewSession = !state.creds?.registered;

        sock = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger)
            },
            logger,
            printQRInTerminal: false,
            browser: ['EMAUS Barbearia', 'Chrome', '120.0.0'],
            connectTimeoutMs: 60000,
            keepAliveIntervalMs: 10000,
            retryRequestDelayMs: 250,
            syncFullHistory: false,
            markOnlineOnConnect: false,
            generateHighQualityLinkPreview: false,
            getMessage: async () => ({ conversation: '' })
        });

        // Gerar pairing code se necessário (DEVE ser chamado antes do primeiro QR ser emitido)
        if (isNewSession && numeroPairing && !gerarQr) {
            // Aguarda 1.5s para o socket estar inicializado e pronto para solicitar o código
            await new Promise(resolve => setTimeout(resolve, 1500));
            try {
                const code = await sock.requestPairingCode(numeroPairing);
                currentPairingCode = code;
                console.log(`[WhatsApp] Código de pareamento gerado com sucesso: ${code}`);
                isConnecting = false;
                return { success: true, pairingCode: code };
            } catch (pairingErr) {
                console.error('[WhatsApp] Erro ao gerar código de pareamento:', pairingErr.message);
                isConnecting = false;
                return { success: false, error: `Erro ao gerar código de pareamento: ${pairingErr.message}` };
            }
        }

        // ─── EVENT HANDLERS ────────────────────────────────────────────────────
        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr && gerarQr) {
                currentQrCode = `data:image/png;base64,${Buffer.from(qr).toString('base64')}`;
                // Gera QR Code como data URL para exibir no painel
                try {
                    const { default: QRCode } = await import('qrcode');
                    currentQrCode = await QRCode.toDataURL(qr);
                } catch (_) {
                    // fallback: envia o texto bruto do QR
                    currentQrCode = qr;
                }
                connectionStatus = 'connecting';
                console.log('[WhatsApp] QR Code disponível para escaneamento.');
            }

            if (connection === 'open') {
                isConnecting = false;
                connectionStatus = 'connected';
                currentQrCode = null;
                currentPairingCode = null;
                reconnectAttempts = 0;
                _limparReconexao();
                connectedNumber = sock.user?.id?.split(':')[0] || sock.user?.id?.split('@')[0] || null;
                console.log(`[WhatsApp] ✅ Conectado! Número: ${connectedNumber}`);
            }

            if (connection === 'close') {
                isConnecting = false;
                const statusCode = lastDisconnect?.error instanceof Boom ? lastDisconnect.error.output.statusCode : 0;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                const wasLoggedOut = statusCode === DisconnectReason.loggedOut;

                console.log(`[WhatsApp] Conexão encerrada. Código: ${statusCode} | Reconectar: ${shouldReconnect}`);

                if (wasLoggedOut) {
                    connectionStatus = 'disconnected';
                    connectedNumber = null;
                    sock = null;
                    _limparSessao();
                    console.log('[WhatsApp] Logout detectado. Sessão apagada.');
                } else if (shouldReconnect && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                    connectionStatus = 'connecting';
                    reconnectAttempts++;
                    const delay = Math.min(5000 * reconnectAttempts, 30000);
                    console.log(`[WhatsApp] Tentativa ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} de reconexão em ${delay / 1000}s...`);
                    _limparReconexao();
                    reconnectTimer = setTimeout(() => _conectar({ gerarQr: false }), delay);
                } else {
                    connectionStatus = 'disconnected';
                    sock = null;
                    console.log('[WhatsApp] Reconexão esgotada ou desconectado definitivamente.');
                }
            }
        });

        return { success: true, status: 'connecting', message: 'Aguardando QR Code ou código de pareamento...' };
    } catch (err) {
        isConnecting = false;
        connectionStatus = 'disconnected';
        console.error('[WhatsApp] Erro crítico ao conectar:', err.message);
        return { success: false, error: err.message };
    }
}

function _limparSessao() {
    try {
        if (fs.existsSync(SESSION_DIR)) {
            fs.rmSync(SESSION_DIR, { recursive: true, force: true });
        }
    } catch (e) {
        console.warn('[WhatsApp] Aviso ao limpar sessão:', e.message);
    }
}

function _limparReconexao() {
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
}

// Auto-inicializar ao subir o servidor se houver sessão salva
(async () => {
    if (fs.existsSync(SESSION_DIR) && fs.readdirSync(SESSION_DIR).length > 0) {
        console.log('[WhatsApp] Sessão anterior encontrada — reconectando automaticamente...');
        await _conectar({ gerarQr: false }).catch(e => console.warn('[WhatsApp] Auto-reconexão falhou:', e.message));
    }
})();
