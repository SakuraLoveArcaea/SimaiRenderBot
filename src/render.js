import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { startStaticServer } from './server.js';

/**
 * 常駐渲染服務：起一次瀏覽器 + 靜態伺服器，之後每次 render 重用同一個分頁
 * （圖片素材與字型只載入一次，bot 連續處理請求會快很多）。
 */
export class SimaiRenderService {
    #browser = null;
    #page = null;
    #server = null;
    #queue = Promise.resolve();

    async init() {
        this.#server = await startStaticServer();
        this.#browser = await launchBrowser();
        this.#page = await this.#browser.newPage({ viewport: { width: 800, height: 800 } });
        this.#page.on('console', (msg) => {
            if (msg.type() === 'error') console.error('[page]', msg.text());
        });
        await this.#page.goto(this.#server.url);
        await this.#page.waitForFunction(() => window.__rendererReady === true, null, { timeout: 15000 });
    }

    /** 只解析、不渲染：回傳 { endTime, bpm, noteCounts, warns } */
    async inspect(simaiText) {
        return this.#enqueue(() =>
            this.#page.evaluate((text) => window.inspectChart(text), simaiText)
        );
    }

    /**
     * simai 文字 → GIF buffer。
     * opts: { fps, width, start, end, maxDuration, sizeLimit }
     */
    async renderGif(simaiText, opts = {}) {
        return this.#enqueue(async () => {
            const {
                fps = 30,
                width = 480,
                start = 0,
                end = null,
                maxDuration = 30,
                sizeLimit = 9.5 * 1024 * 1024, // Discord 免費上限 10MB，留餘裕
            } = opts;

            const result = await this.#page.evaluate(
                ([text, o]) => window.renderChart(text, o),
                [simaiText, { width, height: width, fps, start, end, maxDuration }]
            );

            const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'simai-'));
            try {
                const videoPath = path.join(tmpDir, `in${result.ext}`);
                await fs.writeFile(videoPath, Buffer.from(result.base64, 'base64'));

                // 壓縮階梯：fps 固定在 15（流暢度優先，不妥協），
                // 大小主要靠色數 / 寬度 / dither 妥協，最後一級才不得已降 fps。
                const ladder = [
                    { fps: 15, width: 360, colors: 64, bayerScale: 3 },
                    { fps: 15, width: 320, colors: 48, bayerScale: 4 },
                    { fps: 15, width: 280, colors: 32, bayerScale: 5 },
                    { fps: 12, width: 240, colors: 24, bayerScale: 5 },
                ];

                let gifBuf = null;
                let used = null;
                for (const rung of ladder) {
                    const gifPath = path.join(tmpDir, `out-${rung.width}.gif`);
                    await videoToGif(videoPath, gifPath, rung);
                    gifBuf = await optimizeGif(gifPath); // gifsicle lossy 後處理（未安裝則原樣跳過）
                    used = rung;
                    if (gifBuf.length <= sizeLimit) break;
                }
                if (gifBuf.length > sizeLimit) {
                    throw new Error(`GIF_TOO_LARGE: 壓到最低品質仍有 ${(gifBuf.length / 1e6).toFixed(1)}MB，請縮短渲染範圍`);
                }

                return {
                    gif: gifBuf,
                    video: await fs.readFile(videoPath),
                    videoExt: result.ext,
                    duration: result.duration,
                    warns: result.warns,
                    quality: used,
                };
            } finally {
                await fs.rm(tmpDir, { recursive: true, force: true });
            }
        });
    }

    async dispose() {
        await this.#browser?.close();
        await this.#server?.close();
    }

    /** 同一個分頁不能並行渲染，排隊處理 */
    #enqueue(job) {
        const run = this.#queue.then(job, job);
        this.#queue = run.catch(() => { });
        return run;
    }
}

/** 優先用系統 Chrome（含完整編碼器），其次 Edge，最後 Playwright 內建 Chromium。 */
async function launchBrowser() {
    const attempts = [
        { channel: 'chrome' },
        { channel: 'msedge' },
        {},
    ];
    let lastErr = null;
    for (const opt of attempts) {
        try {
            return await chromium.launch({ ...opt, headless: true });
        } catch (e) {
            lastErr = e;
        }
    }
    throw new Error(
        `找不到可用的瀏覽器。請安裝 Google Chrome，或執行 npx playwright install chromium\n${lastErr?.message}`
    );
}

let gifsicleChecked = false;
let gifsicleAvailable = false;

/** 用 gifsicle -O3 --lossy 再壓一手（同一張 GIF 通常還能再省 30~50%，肉眼難辨）。 */
async function optimizeGif(gifPath) {
    if (!gifsicleChecked) {
        gifsicleChecked = true;
        gifsicleAvailable = await new Promise((resolve) => {
            const p = spawn('gifsicle', ['--version'], { stdio: 'ignore' });
            p.on('close', (code) => resolve(code === 0));
            p.on('error', () => resolve(false));
        });
        if (!gifsicleAvailable) {
            console.warn('[render] 找不到 gifsicle，跳過 GIF 二次壓縮（brew install gifsicle 可再省 30~50% 體積）');
        }
    }
    if (!gifsicleAvailable) return fs.readFile(gifPath);

    const optPath = gifPath.replace(/\.gif$/, '.opt.gif');
    await new Promise((resolve, reject) => {
        const proc = spawn('gifsicle', ['-O3', '--lossy=100', gifPath, '-o', optPath], {
            stdio: ['ignore', 'ignore', 'pipe'],
        });
        let stderr = '';
        proc.stderr.on('data', (d) => (stderr += d));
        proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`gifsicle 失敗: ${stderr.slice(-400)}`))));
        proc.on('error', reject);
    });
    return fs.readFile(optPath);
}

/** ffmpeg 兩段式調色盤轉 GIF（palettegen + paletteuse），品質/體積平衡的標準做法。 */
function videoToGif(videoPath, gifPath, { fps, width, colors, bayerScale }) {
    const vf = [
        `fps=${fps}`,
        `scale=${width}:-1:flags=lanczos`,
        `split[s0][s1]`,
        `[s0]palettegen=max_colors=${colors}:stats_mode=diff[p]`,
        `[s1][p]paletteuse=dither=bayer:bayer_scale=${bayerScale}:diff_mode=rectangle`,
    ].join(',');

    return new Promise((resolve, reject) => {
        const proc = spawn('ffmpeg', ['-y', '-i', videoPath, '-vf', vf, '-loop', '0', gifPath], {
            stdio: ['ignore', 'ignore', 'pipe'],
        });
        let stderr = '';
        proc.stderr.on('data', (d) => (stderr += d));
        proc.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`ffmpeg 失敗 (exit ${code}):\n${stderr.slice(-800)}`));
        });
        proc.on('error', (e) => reject(new Error(`無法執行 ffmpeg，請先安裝: ${e.message}`)));
    });
}
