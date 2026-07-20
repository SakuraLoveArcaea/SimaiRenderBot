import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadChart } from './chart.js';

const PUBLIC_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'activity', 'public');

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
};

/**
 * 【測試用】Discord Activity 的後端：靜態頁面 + OAuth token 交換 + 按鈕通知。
 * 跟 server.js（給 puppeteer 用的內部渲染伺服器）無關，這個是要給 Discord 用戶端
 * 透過 `/.proxy/...` 存取的，所以綁 0.0.0.0，測試時要搭配 cloudflared 這類 tunnel openen 對外。
 */
export function startActivityServer(client, service) {
    const appId = process.env.DISCORD_APP_ID;
    const clientSecret = process.env.DISCORD_CLIENT_SECRET;
    const port = Number(process.env.ACTIVITY_PORT ?? 3000);

    const server = http.createServer(async (req, res) => {
        try {
            const url = new URL(req.url, 'http://localhost');

            if (req.method === 'POST' && url.pathname === '/api/token') {
                return await handleToken(req, res, appId, clientSecret);
            }
            if (req.method === 'POST' && url.pathname === '/api/notify') {
                return await handleNotify(req, res, client);
            }
            if (req.method === 'POST' && url.pathname === '/api/render') {
                return await handleRender(req, res, client, service);
            }
            if (req.method === 'GET' && url.pathname === '/api/chart') {
                return await handleGetChart(req, res);
            }
            if (req.method === 'GET') {
                return await handleStatic(url.pathname, res);
            }
            res.writeHead(404).end();
        } catch (e) {
            console.error('[activity-server]', e);
            res.writeHead(500).end();
        }
    });

    server.listen(port, '0.0.0.0', () => {
        console.log(`Activity 測試伺服器已啟動：http://0.0.0.0:${port}（需搭配 tunnel 才能被 Discord 讀到）`);
    });

    return { close: () => new Promise((r) => server.close(r)) };
}

async function handleStatic(pathname, res) {
    const safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
    const filePath = path.join(PUBLIC_ROOT, safePath === '/' ? 'index.html' : safePath);
    if (!filePath.startsWith(PUBLIC_ROOT)) {
        res.writeHead(403).end();
        return;
    }
    const data = await fs.readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] ?? 'application/octet-stream' });
    res.end(data);
}

async function readJsonBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

/** 前端拿 authorize() 給的 code 換 access_token（client_secret 只能留在後端，不能進前端 bundle） */
async function handleToken(req, res, appId, clientSecret) {
    if (!clientSecret) {
        res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: '後端未設定 DISCORD_CLIENT_SECRET' }));
        return;
    }
    const { code } = await readJsonBody(req);
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: appId,
            client_secret: clientSecret,
            grant_type: 'authorization_code',
            code,
            redirect_uri: process.env.DISCORD_REDIRECT_URI || 'https://127.0.0.1',
        }),
    });
    const body = await tokenRes.json();
    if (!tokenRes.ok) {
        res.writeHead(tokenRes.status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
        return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ access_token: body.access_token }));
}

/** 按鈕點擊：回覆呼叫者，公開發在指令當初被呼叫的頻道 */
async function handleNotify(req, res, client) {
    const { channelId, userId, username } = await readJsonBody(req);
    if (!channelId || !userId) {
        res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: '缺少 channelId 或 userId' }));
        return;
    }
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) {
        res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: '找不到頻道' }));
        return;
    }
    await channel.send({
        content: `<@${userId}>（${username}）在互動頁面按下了按鈕！`,
        allowedMentions: { users: [userId] },
    });
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true }));
}

/** 互動頁面渲染請求：呼叫渲染引擎產出 GIF 並發到對應頻道 */
async function handleRender(req, res, client, service) {
    const { channelId, userId, username, simai, start, end } = await readJsonBody(req);
    if (!channelId || !simai) {
        res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: '缺少 channelId 或 simai' }));
        return;
    }
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) {
        res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: '找不到頻道' }));
        return;
    }

    try {
        const renderOpts = { maxDuration: 30 };
        if (typeof start === 'number' && !isNaN(start)) renderOpts.start = start;
        if (typeof end === 'number' && !isNaN(end)) renderOpts.end = end;

        const { gif } = await service.renderGif(simai, renderOpts);

        await channel.send({
            content: userId 
                ? `<@${userId}>（${username ?? '未知'}）在互動頁面渲染了譜面：` 
                : `🎬 在互動頁面渲染的譜面：`,
            files: [{ attachment: gif, name: 'render.gif' }],
            allowedMentions: userId ? { users: [userId] } : undefined,
        });

        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true }));
    } catch (e) {
        console.error('[activity-server-render]', e);
        res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: e.message || String(e) }));
    }
}

/** 獲取內建的 testChart 譜面資料 */
async function handleGetChart(req, res) {
    try {
        const chart = await loadChart();
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(chart));
    } catch (e) {
        console.error('[activity-server-chart]', e);
        res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: e.message || String(e) }));
    }
}


