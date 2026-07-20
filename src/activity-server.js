import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadChart } from './chart.js';

const PUBLIC_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'activity', 'public');
const WEB_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.png': 'image/png',
    '.ttf': 'font/ttf',
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
                console.log('[Activity Server] 收到 Token 交換請求');
                return await handleToken(req, res, appId, clientSecret);
            }
            if (req.method === 'POST' && url.pathname === '/api/notify') {
                console.log('[Activity Server] 收到通知請求');
                return await handleNotify(req, res, client);
            }
            if (req.method === 'POST' && url.pathname === '/api/render') {
                console.log('[Activity Server] 收到渲染請求');
                return await handleRender(req, res, client, service);
            }
            if (req.method === 'GET' && url.pathname === '/api/chart') {
                console.log('[Activity Server] 收到獲取譜面請求');
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
    
    // 優先讀取 activity/public/ 的檔案
    const filePath = path.join(PUBLIC_ROOT, safePath === '/' ? 'index.html' : safePath);
    if (filePath.startsWith(PUBLIC_ROOT)) {
        try {
            const data = await fs.readFile(filePath);
            res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] ?? 'application/octet-stream' });
            res.end(data);
            return;
        } catch {
            // 讀不到則繼續嘗試 web/ 底下的資源 (如 Skin, Fonts)
        }
    }

    // 備份讀取 web/ 的檔案
    const webFilePath = path.join(WEB_ROOT, safePath);
    if (webFilePath.startsWith(WEB_ROOT)) {
        try {
            const data = await fs.readFile(webFilePath);
            res.writeHead(200, { 'Content-Type': MIME[path.extname(webFilePath)] ?? 'application/octet-stream' });
            res.end(data);
            return;
        } catch {
            // 找不到
        }
    }

    res.writeHead(404).end();
}

async function readJsonBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

/** 前端拿 authorize() 給的 code 換 access_token（client_secret 只能留在後端，不能進前端 bundle） */
async function handleToken(req, res, appId, clientSecret) {
    if (!clientSecret) {
        console.warn('[Activity Server] Token 交換失敗：後端未設定 DISCORD_CLIENT_SECRET');
        res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: '後端未設定 DISCORD_CLIENT_SECRET' }));
        return;
    }
    const { code } = await readJsonBody(req);
    console.log('[Activity Server] 正在與 Discord API 交換 Token, code:', code);
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
        console.warn('[Activity Server] Token 交換失敗，Discord 回傳錯誤:', body);
        res.writeHead(tokenRes.status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
        return;
    }
    console.log('[Activity Server] Token 交換成功！');
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
    const { channelId, userId, username, simai, startCombo, endCombo } = await readJsonBody(req);
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
        // 利用 comboInfo 來解析並換算開始與結束時間
        const { comboTimes, endTime } = await service.comboInfo(simai);
        
        let start = 0;
        let end = endTime;
        if (typeof startCombo === 'number' && startCombo >= 0 && startCombo < comboTimes.length) {
            start = comboTimes[startCombo];
        }
        if (typeof endCombo === 'number' && endCombo >= 0 && endCombo < comboTimes.length) {
            // 結束點多加 0.8 秒以確保最後一顆 Note 的特效能畫完
            end = Math.min(endTime, comboTimes[endCombo] + 0.8);
        }

        const notesInRange = comboTimes.filter(t => t >= start && t <= end).length;
        const estMs = service.estimateRenderMs(end - start, notesInRange);
        const estSec = Math.ceil(estMs / 1000);

        // 立即發送進度提示訊息到 Discord 頻道中
        const progressMsg = await channel.send({
            content: `🎬 <@${userId}> 正在渲染所選區段的譜面（Combo ${startCombo} - ${endCombo}），預估約 ${estSec} 秒，請稍候…`,
            allowedMentions: { users: [userId] }
        });

        // 立即回覆前端 200 OK，讓前端可以立刻關閉 Activity 視窗，不需要等待渲染
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true }));

        // 在背景非同步執行實際渲染與傳送
        (async () => {
            try {
                const renderOpts = { maxDuration: 30 };
                if (typeof start === 'number' && !isNaN(start)) renderOpts.start = start;
                if (typeof end === 'number' && !isNaN(end)) renderOpts.end = end;

                const { gif } = await service.renderGif(simai, renderOpts);

                await channel.send({
                    content: userId 
                        ? `<@${userId}>（${username ?? '未知'}）的譜面預覽 GIF 渲染完成：` 
                        : `🎬 譜面預覽 GIF 渲染完成：`,
                    files: [{ attachment: gif, name: 'render.gif' }],
                    allowedMentions: userId ? { users: [userId] } : undefined,
                });
            } catch (e) {
                console.error('[async-render-error]', e);
                await channel.send({
                    content: `❌ <@${userId}> 譜面預覽渲染失敗：${e.message || String(e)}`,
                    allowedMentions: { users: [userId] }
                });
            } finally {
                // 刪除進度提示訊息
                await progressMsg.delete().catch(() => null);
            }
        })();
    } catch (e) {
        console.error('[activity-server-render]', e);
        res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: e.message || String(e) }));
    }
}

/** 獲取內建的 testChart 譜面資料 */
async function handleGetChart(req, res) {
    try {
        console.log('[Activity Server] 正在讀取譜面檔案...');
        const chart = await loadChart();
        console.log('[Activity Server] 譜面讀取成功:', chart.name);
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(chart));
    } catch (e) {
        console.error('[Activity Server] 讀取譜面失敗:', e);
        res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: e.message || String(e) }));
    }
}


