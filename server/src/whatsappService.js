import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion
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

try {
    if (!fs.existsSync(SESSIONS_DIR)) {
        fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    }
} catch (e) {
    console.warn("Aviso ao criar diretório de sessões WhatsApp:", e.message);
}

export async function iniciarWhatsApp(forceRestart = false) {
    if (isInitializing && !forceRestart) return { status, qrCode: qrCodeDataUrl };
    if (status === 'connected' && sock && !forceRestart) {
        return { status, qrCode: null, userNumber: connectedUserNumber };
    }

    isInitializing = true;
    status = 'connecting';
    qrCodeDataUrl = null;

    try {
        const { state, saveCreds } = await useMultiFileAuthState(SESSIONS_DIR);
        const { version } = await fetchLatestBaileysVersion();

        sock = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: false,
            auth: state,
            browser: ['EMAUS Barbearia', 'Chrome', '1.0.0'],
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000
        });

        sock.ev.on('creds.update', saveCreds);

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
                    setTimeout(() => iniciarWhatsApp(), 3000);
                } else {
                    status = 'disconnected';
                    qrCodeDataUrl = null;
                    connectedUserNumber = null;
                    try {
                        fs.rmSync(SESSIONS_DIR, { recursive: true, force: true });
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
            await sock.logout();
        }
    } catch (e) {
        console.warn('Erro ao deslogar socket:', e);
    }
    status = 'disconnected';
    qrCodeDataUrl = null;
    connectedUserNumber = null;
    try {
        fs.rmSync(SESSIONS_DIR, { recursive: true, force: true });
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
