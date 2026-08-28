import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.webp': 'image/webp'
};

const server = http.createServer((req, res) => {
    let reqPath = req.url.split('?')[0];
    if (reqPath === '/') reqPath = '/index.html';
    if (reqPath === '/admin') reqPath = '/admin.html';
    if (reqPath === '/termos') reqPath = '/termos.html';
    if (reqPath === '/redefinir-senha') reqPath = '/redefinir-senha.html';

    const filePath = path.join(rootDir, decodeURIComponent(reqPath));

    fs.stat(filePath, (err, stats) => {
        if (err || !stats.isFile()) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('404 Not Found');
            return;
        }

        const ext = path.extname(filePath).toLowerCase();
        const contentType = mimeTypes[ext] || 'application/octet-stream';

        res.writeHead(200, {
            'Content-Type': contentType,
            'Access-Control-Allow-Origin': '*'
        });

        fs.createReadStream(filePath).pipe(res);
    });
});

const PORT = 5000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Frontend Static Server running on http://localhost:${PORT}`);
});
