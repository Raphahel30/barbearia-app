import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    Browsers
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SESSIONS_DIR = process.env.VERCEL 
    ? path.join('/tmp', 'whatsapp_sessions')
    : path.resolve(__dirname, '../sessions/whatsapp');

let sock = null;
let status = 'disconnected'; // 'disconnected' | 'connecting' | 'qr_ready' | 'connected'
let qrCodeDataUrl = null;
let connectedUserNumber = null;
let isInitializing = false;
let reconnectTimer = null;

try {
    if (!fs.existsSync(SESSIONS_DIR)) {
        fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    }
} catch (e) {
    console.warn("Aviso ao criar diretório de sessões WhatsApp:", e.message);
}

export async function iniciarWhatsApp(forceRestart = false) {
    // Se já estiver conectado e não for forçado, não recria socket para não derrubar a sessão ativa
    if (status === 'connected' && sock && !forceRestart) {
        return { status, qrCode: null, userNumber: connectedUserNumber };
    }

    if (isInitializing && !forceRestart) {
        return { status, qrCode: qrCodeDataUrl, userNumber: connectedUserNumber };
    }

    isInitializing = true;
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }

    // Se já existia um socket antigo, fecha e remove todos os listeners para evitar conexões duplicadas
    if (sock) {
        try {
            sock.ev.removeAllListeners();
            sock.end(undefined);
        } catch (e) {}
        sock = null;
    }

    status = 'connecting';
    qrCodeDataUrl = null;

    try {
        const { state, saveCreds } = await useMultiFileAuthState(SESSIONS_DIR);
        const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1015901307] }));

        sock = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: false,
            auth: state,
            browser: Browsers.macOS('Desktop'),
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 25000,
            generateHighQualityLinkPreview: true,
            syncFullHistory: false
        });

        sock.ev.on('creds.update', async () => {
            try {
                await saveCreds();
            } catch (e) {
                console.warn("Erro ao salvar credenciais WhatsApp:", e.message);
            }
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                try {
                    qrCodeDataUrl = await QRCode.toDataURL(qr, { margin: 2, scale: 6 });
                    status = 'qr_ready';
                    console.log('🤖 [WhatsApp] Novo QR Code gerado! Pronto para leitura no painel.');
                } catch (qrErr) {
                    console.error('Erro ao gerar imagem do QR Code:', qrErr);
                }
            }

            if (connection === 'open') {
                status = 'connected';
                qrCodeDataUrl = null;
                isInitializing = false;
                const jid = sock.user?.id || '';
                connectedUserNumber = jid.split(':')[0] || jid.split('@')[0] || '';
                console.log(`✅ [WhatsApp] Sessão conectada com sucesso! Número: +${connectedUserNumber}`);
            }

            if (connection === 'close') {
                isInitializing = false;
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

                console.log(`⚠️ [WhatsApp] Conexão fechada. Motivo statusCode: ${statusCode}. Reconectar: ${shouldReconnect}`);

                if (shouldReconnect) {
                    status = 'connecting';
                    reconnectTimer = setTimeout(() => {
                        iniciarWhatsApp(false);
                    }, 5000);
                } else {
                    status = 'disconnected';
                    qrCodeDataUrl = null;
                    connectedUserNumber = null;
                    try {
                        if (fs.existsSync(SESSIONS_DIR)) {
                            fs.rmSync(SESSIONS_DIR, { recursive: true, force: true });
                            fs.mkdirSync(SESSIONS_DIR, { recursive: true });
                        }
                    } catch (e) {}
                }
            }
        });

        isInitializing = false;
        return { status, qrCode: qrCodeDataUrl, userNumber: connectedUserNumber };

    } catch (err) {
        console.error('❌ [WhatsApp] Erro ao inicializar socket Baileys:', err);
        status = 'disconnected';
        isInitializing = false;
        return { status, error: err.message };
    }
}

export function obterStatusWhatsApp() {
    return {
        status,
        qrCode: qrCodeDataUrl,
        userNumber: connectedUserNumber
    };
}

export async function desconectarWhatsApp() {
    try {
        if (sock) {
            try { sock.ev.removeAllListeners(); } catch (e) {}
            await sock.logout();
        }
    } catch (e) {
        console.warn('Erro ao deslogar socket:', e);
    }
    status = 'disconnected';
    qrCodeDataUrl = null;
    connectedUserNumber = null;
    sock = null;
    try {
        if (fs.existsSync(SESSIONS_DIR)) {
            fs.rmSync(SESSIONS_DIR, { recursive: true, force: true });
            fs.mkdirSync(SESSIONS_DIR, { recursive: true });
        }
    } catch (e) {}
    return { success: true, message: 'WhatsApp desconectado com sucesso.' };
}

export async function enviarMensagemWhatsApp(numeroDestino, texto) {
    if (!numeroDestino || !texto) {
        return { success: false, error: 'Número de destino e texto são obrigatórios.' };
    }

    if (status !== 'connected' || !sock) {
        console.log(`ℹ️ [WhatsApp] Mensagem ignorada (WhatsApp não conectado): Destino ${numeroDestino}`);
        return { success: false, reason: 'whatsapp_not_connected', message: 'WhatsApp não está conectado no momento.' };
    }

    try {
        let cleanNumber = String(numeroDestino).replace(/\D/g, '');
        if (!cleanNumber.startsWith('55') && (cleanNumber.length === 10 || cleanNumber.length === 11)) {
            cleanNumber = '55' + cleanNumber;
        }

        const jid = `${cleanNumber}@s.whatsapp.net`;
        const result = await sock.sendMessage(jid, { text: texto });
        console.log(`📨 [WhatsApp] Mensagem enviada para +${cleanNumber} com ID: ${result?.key?.id}`);
        return { success: true, messageId: result?.key?.id, destinatario: cleanNumber };
    } catch (err) {
        console.error(`❌ [WhatsApp] Erro ao enviar mensagem para ${numeroDestino}:`, err);
        return { success: false, error: err.message };
    }
}
