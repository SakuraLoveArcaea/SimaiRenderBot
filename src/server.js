import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ENGINE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine');

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.cjs': 'text/javascript; charset=utf-8',
    '.png': 'image/png',
    '.ttf': 'font/ttf',
    '.css': 'text/css; charset=utf-8',
};

/** 起一個只服務 engine/ 目錄的靜態伺服器，回傳 { url, close }。 */
export async function startStaticServer() {
    const server = http.createServer(async (req, res) => {
        try {
            const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
            const safePath = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
            const filePath = path.join(ENGINE_ROOT, safePath === '/' ? 'headless-render.html' : safePath);
            if (!filePath.startsWith(ENGINE_ROOT)) {
                res.writeHead(403).end();
                return;
            }
            const data = await fs.readFile(filePath);
            res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] ?? 'application/octet-stream' });
            res.end(data);
        } catch {
            res.writeHead(404).end('not found');
        }
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    return {
        url: `http://127.0.0.1:${port}/headless-render.html`,
        close: () => new Promise((r) => server.close(r)),
    };
}
