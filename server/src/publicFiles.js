// Lista explícita: novos arquivos internos nunca se tornam públicos por acidente.
export const PUBLIC_FILES = new Set([
    '/index.html', '/admin.html', '/redefinir-senha.html', '/termos.html',
    '/manifest.json', '/manifest-admin.json', '/sw.js', '/assets/tailwind.css', '/assets/ui-safe.js',
    '/logo.jpg', '/logo.png', '/logo.svg', '/favicon.png', '/apple-touch-icon.png',
    '/icon-192.png', '/icon-512.png', '/Icon.png', '/Icon.png.jpg'
]);

export function arquivoPublicoPermitido(urlPath) {
    try { return PUBLIC_FILES.has(decodeURIComponent(urlPath)); }
    catch { return false; }
}
