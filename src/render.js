import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { startStaticServer } from './server.js';

const RENDER_FPS = 15; // 瀏覽器逐幀渲染的 fps，對齊 GIF 主要輸出 fps（不再畫 30fps 再丟一半）

/**
 * 常駐渲染服務：起一次瀏覽器 + 靜態伺服器，之後每次 render 重用同一個分頁
 * （圖片素材與字型只載入一次，bot 連續處理請求會快很多）。
 */
export class SimaiRenderService {
    #browser = null;
    #page = null;
    #server = null;
    #queue = Promise.resolve();
    #frameSink = null; // 當前渲染任務收幀的 callback；渲染以 #queue 序列化，同時只會有一個

    async init() {
        this.#server = await startStaticServer();
        this.#browser = await launchBrowser();
        this.#page = await this.#browser.newPage({ viewport: { width: 800, height: 800 } });
        this.#page.on('console', (msg) => {
            if (msg.type() === 'error') console.error('[page]', msg.text());
        });
        // 瀏覽器每畫好一幀就呼叫這裡，把 PNG(base64) 交回 Node
        await this.#page.exposeBinding('__emitFrame', (_source, b64) => {
            this.#frameSink?.(Buffer.from(b64, 'base64'));
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

    /** 給 /chart 用：回傳 { comboTimes, endTime, bpm, indexToTime }，把 combo 序號對回譜面時間 */
    async comboInfo(simaiText) {
        return this.#enqueue(() =>
            this.#page.evaluate((text) => window.chartComboInfo(text), simaiText)
        );
    }

    /** 依長度與音符數估計渲染耗時（毫秒），不用實際跑一次就能給使用者心理預期 */
    estimateRenderMs(durationSec, totalNotes) {
        return estimateRenderMs(durationSec, totalNotes);
    }

    /**
     * simai 文字 → GIF buffer。
     * opts: { width, start, end, maxDuration, sizeLimit }
     */
    async renderGif(simaiText, opts = {}) {
        return this.#enqueue(async () => {
            const {
                width = 480,
                start = 0,
                end = null,
                maxDuration = 30,
                sizeLimit = 9.5 * 1024 * 1024, // Discord 免費上限 10MB，留餘裕
            } = opts;

            // 瀏覽器逐幀渲染，PNG 幀透過 __emitFrame binding 一幀幀進到這個陣列
            const frames = [];
            this.#frameSink = (buf) => frames.push(buf);
            let result;
            try {
                result = await this.#page.evaluate(
                    ([text, o]) => window.renderChartToFrames(text, o),
                    [simaiText, { width, height: width, fps: RENDER_FPS, start, end, maxDuration }]
                );
            } finally {
                this.#frameSink = null;
            }
            if (!frames.length) throw new Error('NO_FRAMES: 未收到任何影格');

            // 所有 PNG 併成一塊，重複餵給 ffmpeg 走壓縮階梯（不用重新渲染）
            const frameData = Buffer.concat(frames);

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
                gifBuf = await framesToGif(frameData, RENDER_FPS, rung);
                gifBuf = await optimizeGif(gifBuf); // gifsicle lossy 後處理（未安裝則原樣回傳）
                used = rung;
                if (gifBuf.length <= sizeLimit) break;
            }
            if (gifBuf.length > sizeLimit) {
                throw new Error(`GIF_TOO_LARGE: 壓到最低品質仍有 ${(gifBuf.length / 1e6).toFixed(1)}MB，請縮短渲染範圍`);
            }

            return {
                gif: gifBuf,
                duration: result.duration,
                warns: result.warns,
                warnpos: result.warnpos,
                quality: used,
            };
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

/**
 * 渲染耗時估算：ms ≈ 523 + 143.6*秒數 + 65*總音符數，PNG 串流管線下重新擬合（9 組長度×密度組合，誤差多在 ±3%）。
 * 乘上 1.15 安全緩衝——寧可預估保守一點，讓實際比預估快完成，別讓使用者覺得「怎麼比說的還久」。
 */
export function estimateRenderMs(durationSec, totalNotes) {
    const base = 523 + 143.6 * durationSec + 65 * totalNotes;
    return Math.round(base * 1.15);
}

/** 跑一個吃 stdin bytes、吐 stdout bytes 的子行程，回傳收集到的輸出 Buffer。 */
function runPipe(cmd, args, inputBuf) {
    return new Promise((resolve, reject) => {
        const proc = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
        const out = [];
        let stderr = '';
        proc.stdout.on('data', (d) => out.push(d));       // 持續清空 stdout，避免管線塞滿造成死結
        proc.stderr.on('data', (d) => (stderr += d));
        proc.on('error', reject);
        proc.on('close', (code) => {
            if (code === 0) resolve(Buffer.concat(out));
            else reject(new Error(`${cmd} 失敗 (exit ${code}):\n${stderr.slice(-800)}`));
        });
        proc.stdin.on('error', () => { }); // ffmpeg 若提早結束會觸發 EPIPE，忽略即可
        proc.stdin.end(inputBuf);
    });
}

let gifsicleReadyPromise = null;

function gifsicleAvailable() {
    return (gifsicleReadyPromise ??= new Promise((resolve) => {
        const p = spawn('gifsicle', ['--version'], { stdio: 'ignore' });
        p.on('close', (code) => resolve(code === 0));
        p.on('error', () => resolve(false));
    }).then((ok) => {
        if (!ok) console.warn('[render] 找不到 gifsicle，跳過 GIF 二次壓縮（brew install gifsicle 可再省 30~50% 體積）');
        return ok;
    }));
}

/** 用 gifsicle -O3 --lossy 再壓一手（同一張 GIF 通常還能再省 30~50%，肉眼難辨）。 */
async function optimizeGif(gifBuf) {
    if (!(await gifsicleAvailable())) return gifBuf;
    return runPipe('gifsicle', ['-O3', '--lossy=100'], gifBuf); // 無檔名參數 = 讀 stdin、寫 stdout
}

/**
 * 逐幀 PNG（併成一塊）→ GIF Buffer。
 * ffmpeg 從 stdin 讀 image2pipe 的 PNG 序列，兩段式調色盤（palettegen + paletteuse）轉 GIF 寫 stdout，
 * 全程走管線、不落地暫存檔。inputFps = 瀏覽器渲染 fps；rung.fps 若較低由 fps 濾鏡負責抽幀。
 */
function framesToGif(frameData, inputFps, { fps, width, colors, bayerScale }) {
    const vf = [
        `fps=${fps}`,
        `scale=${width}:-1:flags=lanczos`,
        `split[s0][s1]`,
        `[s0]palettegen=max_colors=${colors}:stats_mode=diff[p]`,
        `[s1][p]paletteuse=dither=bayer:bayer_scale=${bayerScale}:diff_mode=rectangle`,
    ].join(',');

    return runPipe('ffmpeg', [
        '-y',
        '-f', 'image2pipe', '-framerate', String(inputFps), '-i', '-',
        '-vf', vf, '-f', 'gif', '-loop', '0', 'pipe:1',
    ], frameData);
}
