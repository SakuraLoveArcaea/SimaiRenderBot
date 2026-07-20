import { DiscordSDK } from '@discord/embedded-app-sdk';
import { simaiDecode } from '../web/Scripts/decode.js';

const $ = id => document.getElementById(id);
const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

const statusEl = $('status');
const songTitleEl = $('songTitle');
const metaLineEl = $('metaLine');
const messageEl = $('message');

const cv = $('chartCanvas'), ctx = cv.getContext('2d');
const dv = $('densityCanvas'), dctx = dv.getContext('2d');
const slider = $('measureSlider'), playBtn = $('playBtn');
const rA = $('rangeA'), rB = $('rangeB');

const params = new URLSearchParams(window.location.search);
const clientId = params.get('client_id') || '1527644569133649960';

// ---------- 簡化繪製邏輯的數學輔助 ----------
const angleOf = p => ((p - 0.5) * 45 - 90) * Math.PI / 180;
const touchR = { A: 0.76, B: 0.45, C: 0, D: 0.76, E: 0.76 };

// 全域錯誤監聽：若有任何 JS 運行或 Promise 錯誤，直接顯示在畫面上，方便開發排查
window.onerror = function(message, source, lineno, colno, error) {
    statusEl.textContent = `JS 錯誤：${message} (L${lineno})`;
    statusEl.className = 'status status-error';
};

window.onunhandledrejection = function(event) {
    statusEl.textContent = `未處理的 Rejection：${event.reason?.message || event.reason}`;
    statusEl.className = 'status status-error';
};

const discordSdk = new DiscordSDK(clientId, { disableConsoleLogOverride: true });
let auth = null;

// 播放器狀態與譜面資料
let M = []; // 小節起始秒數
let N = []; // 所有 Notes
let D = []; // 各小節密度
let DATA = null;
let chartText = ''; // 原始譜面內容

let playing = false;
let realTime = 0;
let lastTs = 0;
let speed = 1.0;
let dragging = false;
let hs = 4.0;
let APPROACH = 2.8 / hs;

let size = 320;
let CX = 160;
let CY = 160;
let R = 134;

function resizeCanvas() {
  const containerWidth = document.querySelector('.container').clientWidth - (window.innerWidth <= 480 ? 24 : 40);
  const viewportHeight = window.innerHeight;
  // 保留頂部、底部與 timeline 的高度空間 (約 340px)
  const maxCanvasHeight = Math.max(200, viewportHeight - 340);
  
  size = Math.min(460, containerWidth, maxCanvasHeight);
  cv.width = cv.height = size * devicePixelRatio;
  cv.style.width = cv.style.height = size + 'px';
  
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(devicePixelRatio, devicePixelRatio);
  
  CX = size / 2;
  CY = size / 2;
  R = size / 2 - 26;
  
  draw(realTime);
  if (M.length > 0) {
    drawDensity(measureIndex(realTime));
  }
}
window.addEventListener('resize', resizeCanvas);
// 初始執行一次
resizeCanvas();

const range = { start: 0, end: 0 };
let previewStop = null;

// 動態譜面前處理與密度計算
function processChartData(decoded) {
    const bpm = decoded.bpm || 60;
    const firstBpm = decoded.tags.find(t => t.type === 'bpm')?.value || bpm;
    const measureDuration = 240 / firstBpm;
    const endTime = decoded.endTime || 0;

    // 計算小節刻度 (M)
    const M_arr = [];
    const offset = measureDuration; // maimai 譜面第一小節為偏置 (1 measure)
    for (let t = offset; t <= endTime + measureDuration; t += measureDuration) {
        M_arr.push(t);
    }
    if (M_arr.length === 0) {
        M_arr.push(offset);
    }

    // 計算密度圖 (D)
    const D_arr = Array.from({ length: M_arr.length }, () => ({
        tap: 0, hold: 0, slide: 0, touch: 0, brk: 0
    }));

    for (const n of decoded.notes) {
        let idx = 0;
        for (let i = 0; i < M_arr.length; i++) {
            if (n.time >= M_arr[i]) {
                idx = i;
            } else {
                break;
            }
        }
        
        const type = n.type; // 'tap', 'hold', 'slide', 'touch'
        const isBreak = n.isBreak; // boolean
        
        if (isBreak) {
            D_arr[idx].brk++;
        } else if (type === 'tap') {
            D_arr[idx].tap++;
        } else if (type === 'hold') {
            D_arr[idx].hold++;
        } else if (type === 'slide') {
            D_arr[idx].slide++;
        } else if (type === 'touch') {
            D_arr[idx].touch++;
        }
    }

    return {
        meta: {
            bpm: firstBpm,
            total: decoded.notes.length,
            counts: decoded.notesConts || {
                tap: decoded.notes.filter(n => n.type === 'tap' && !n.isBreak).length,
                hold: decoded.notes.filter(n => n.type === 'hold' && !n.isBreak).length,
                slide: decoded.notes.filter(n => n.type === 'slide' && !n.isBreak).length,
                touch: decoded.notes.filter(n => n.type === 'touch' && !n.isBreak).length,
                break: decoded.notes.filter(n => n.isBreak).length,
            },
            endTime: endTime
        },
        measures: M_arr,
        density: D_arr,
        notes: decoded.notes
    };
}

async function setup() {
    statusEl.textContent = '連線中：正在初始化 SDK…';
    statusEl.className = 'status status-connecting';
    await discordSdk.ready();

    statusEl.textContent = '連線中：正在向用戶端申請授權…';
    const { code } = await discordSdk.commands.authorize({
        client_id: clientId,
        response_type: 'code',
        state: '',
        prompt: 'none',
        scope: ['identify'],
    });

    statusEl.textContent = '連線中：正在與本地後端交換 Token…';
    const res = await fetch('/.proxy/api/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
    });
    if (!res.ok) throw new Error(`token 交換失敗：${res.status}`);
    const { access_token } = await res.json();

    statusEl.textContent = '連線中：正在進行用戶身份驗證…';
    auth = await discordSdk.commands.authenticate({ access_token });

    statusEl.textContent = '連線中：正在獲取譜面資料…';
    const chartRes = await fetch('/.proxy/api/chart');
    if (!chartRes.ok) throw new Error(`譜面獲取失敗：${chartRes.status}`);
    const chartData = await chartRes.json();

    chartText = chartData.text;
    songTitleEl.textContent = chartData.name;

    statusEl.textContent = '連線中：正在解析譜面…';
    const decoded = simaiDecode(chartText, true);
    if (decoded.failed) {
        throw new Error('譜面解析失敗：請檢查語法');
    }

    // 初始化播放器資料
    DATA = processChartData(decoded);
    M = DATA.measures;
    N = DATA.notes;
    D = DATA.density;

    // 更新 UI 文字
    $('hudBpm').textContent = Math.round(DATA.meta.bpm);
    $('hudMeasureMax').textContent = M.length - 1;
    const c = DATA.meta.counts;
    metaLineEl.textContent = `TAP ${c.tap} · HOLD ${c.hold} · SLIDE ${c.slide} · TOUCH ${c.touch} · BREAK ${c.break} — ALL ${DATA.meta.total}`;

    // 更新 Sliders 範圍與最大值
    slider.max = M.length - 1;
    rA.max = rB.max = M.length - 1;
    rA.value = 0;
    rB.value = M.length - 1;
    range.start = 0;
    range.end = M.length - 1;

    // 啟用控制 UI
    setInputsDisabled(false);

    statusEl.textContent = `連線成功：${auth.user.global_name ?? auth.user.username}`;
    statusEl.className = 'status status-ready';

    resizeCanvas();
    syncRange();
    seek(0);
}

// ---------- 小節導航與 Seek 運算 ----------
function measureIndex(t) {
  let lo = 0, hi = M.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    M[mid] <= t + 1e-6 ? lo = mid : hi = mid - 1;
  }
  return lo;
}

function seek(t) {
  realTime = Math.max(0, Math.min(DATA.meta.endTime, t));
  syncUI();
  draw(realTime);
}

function jumpMeasure(d) {
  seek(M[Math.max(0, Math.min(M.length - 1, measureIndex(realTime) + d))]);
}

function syncUI() {
  const mi = measureIndex(realTime);
  if (!dragging) slider.value = mi;
  $('hudMeasure').textContent = mi;
  $('hudTime').textContent = realTime.toFixed(2);
  drawDensity(mi);
}

// ---------- 播放按鈕與滑桿監聽 ----------
$('b_m5').onclick = () => jumpMeasure(-5);
$('b_m1').onclick = () => jumpMeasure(-1);
$('b_p1').onclick = () => jumpMeasure(+1);
$('b_p5').onclick = () => jumpMeasure(+5);
$('b_f1').onclick = () => seek(realTime - 0.1);
$('b_f2').onclick = () => seek(realTime + 0.1);
$('speedSel').onchange = e => speed = +e.target.value;

playBtn.onclick = () => {
  playing = !playing;
  if (!playing) previewStop = null;
  playBtn.textContent = playing ? '⏸' : '▶';
  if (playing) {
    lastTs = performance.now();
    requestAnimationFrame(loop);
  }
};

slider.addEventListener('pointerdown', () => dragging = true);
window.addEventListener('pointerup', () => dragging = false);
slider.addEventListener('input', () => seek(M[+slider.value]));

// ---------- 密度圖拖曳跳轉 ----------
function densSeek(ev) {
  const r = dv.getBoundingClientRect();
  const frac = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
  seek(M[Math.round(frac * (M.length - 1))]);
}
dv.addEventListener('pointerdown', ev => { dragging = true; densSeek(ev); });
dv.addEventListener('pointermove', ev => { if (dragging) densSeek(ev); });

// ---------- 密度圖繪製 (型別分色堆疊) ----------
function drawDensity(playheadMi) {
  const w = dv.clientWidth * devicePixelRatio, h = 50 * devicePixelRatio;
  if (dv.width !== w) { dv.width = w; dv.height = h; }
  dctx.clearRect(0, 0, w, h);
  const bw = w / M.length;
  const maxD = Math.max(1, ...D.map(d => d.tap + d.hold + d.slide + d.touch + d.brk));
  const order = [['tap', '--tap'], ['hold', '--hold'], ['slide', '--slide'], ['touch', '--touch'], ['brk', '--brk']];
  
  D.forEach((d, i) => {
    let y = h;
    order.forEach(([k, varName]) => {
      if (!d[k]) return;
      const bh = (d[k] / maxD) * (h - 6);
      y -= bh;
      dctx.fillStyle = css(varName);
      dctx.fillRect(i * bw + 0.5, y, Math.max(1, bw - 1), bh);
    });
  });

  // 選取範圍高亮
  if (typeof range !== 'undefined') {
    dctx.fillStyle = 'rgba(255, 255, 255, 0.13)';
    dctx.fillRect(range.start * bw, 0, (range.end - range.start + 1) * bw, h);
    dctx.fillStyle = css('--slide');
    dctx.fillRect(range.start * bw, 0, 2, h);
    dctx.fillRect((range.end + 1) * bw - 2, 0, 2, h);
  }

  // 播放頭
  dctx.fillStyle = '#ffffff';
  dctx.fillRect(playheadMi * bw, 0, Math.max(2, bw * 0.6), h);
}

// ---------- 範圍選取同步與預覽 ----------
function syncRange() {
  range.start = Math.min(+rA.value, +rB.value);
  range.end   = Math.max(+rA.value, +rB.value);
  $('rangeLabel').textContent = range.start + ' - ' + range.end;
  drawDensity(measureIndex(realTime));
}
rA.addEventListener('input', syncRange);
rB.addEventListener('input', syncRange);

$('setStart').onclick = () => {
  const mi = measureIndex(realTime);
  rA.value = mi;
  rB.value = Math.max(range.end, mi);
  syncRange();
};
$('setEnd').onclick = () => {
  const mi = measureIndex(realTime);
  rB.value = mi;
  rA.value = Math.min(range.start, mi);
  syncRange();
};
$('goStart').onclick = () => seek(M[range.start]);
$('previewRange').onclick = () => {
  seek(M[range.start]);
  previewStop = range.end + 1 < M.length ? M[range.end + 1] : DATA.meta.endTime;
  if (!playing) playBtn.click();
};

// ---------- 流速 (ハイスピ) 控制 ----------
$('hsSlider').addEventListener('input', e => {
  const newHs = +e.target.value;
  $('hsVal').textContent = newHs.toFixed(1);
  APPROACH = 2.8 / newHs;
  draw(realTime);
});

// ---------- GIF 渲染並傳送 ----------
$('exportGifBtn').onclick = async () => {
  setInputsDisabled(true);
  showMessage('🎬 正在向 Bot 發送渲染請求，請稍候…', 'info');

  const startTime = M[range.start];
  const endTime = range.end + 1 < M.length ? M[range.end + 1] : DATA.meta.endTime;

  try {
    const res = await fetch('/.proxy/api/render', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channelId: discordSdk.channelId,
        userId: auth.user.id,
        username: auth.user.global_name ?? auth.user.username,
        simai: chartText,
        start: startTime,
        end: endTime,
      }),
    });

    const data = await res.json().catch(() => ({}));

    if (res.ok) {
      showMessage('✅ 譜面預覽 GIF 渲染成功，已傳送至 Discord 頻道！', 'success');
    } else {
      showMessage(`❌ 渲染失敗：${data.error || res.statusText}`, 'error');
    }
  } catch (e) {
    console.error('Export request failed:', e);
    showMessage(`❌ 網路錯誤，無法傳送請求：${e.message}`, 'error');
  } finally {
    setInputsDisabled(false);
  }
};

// ---------- 簡化繪製邏輯 ----------

function draw(t) {
  ctx.clearRect(0, 0, size, size);
  // 外圈 + 8 個按鍵孔
  ctx.strokeStyle = '#3c3c74'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(CX, CY, R, 0, 7); ctx.stroke();
  for (let p = 1; p <= 8; p++) {
    const a = angleOf(p);
    ctx.fillStyle = '#3c3c74';
    ctx.beginPath(); ctx.arc(CX + R*Math.cos(a), CY + R*Math.sin(a), 5, 0, 7); ctx.fill();
  }

  for (const n of N) {
    const isTouch = n.type === 'touch';
    const appear = n.time - APPROACH;
    const gone = n.time + (n.holdDuration || 0) + (n.slideDuration || 0) + 0.08;
    if (t < appear || t > gone) continue;
    const prog = Math.min(1, (t - appear) / APPROACH);
    const a = angleOf(n.pos);
    const col = n.isBreak ? css('--brk')
              : n.type === 'slide' ? css('--slide')
              : isTouch ? css('--touch')
              : n.isHold ? css('--hold') : css('--tap');

    if (isTouch) {
      const tr = (touchR[n.touchPos] ?? 0.6) * R;
      const off = n.touchPos === 'E' || n.touchPos === 'D' ? Math.PI/8 : 0;
      const x = CX + tr * Math.cos(a + off), y = CY + tr * Math.sin(a + off);
      ctx.strokeStyle = col; ctx.lineWidth = 2.5;
      const s = 16 * (1.6 - 0.6 * prog);
      ctx.strokeRect(x - s/2, y - s/2, s, s);
      continue;
    }

    const r = prog * R;
    const x = CX + r * Math.cos(a), y = CY + r * Math.sin(a);

    if (n.isHold && t > n.time) { // Hold 進行中
      ctx.strokeStyle = col; ctx.lineWidth = 7; ctx.globalAlpha = 0.5;
      ctx.beginPath();
      ctx.moveTo(CX + R*0.85*Math.cos(a), CY + R*0.85*Math.sin(a));
      ctx.lineTo(CX + R*Math.cos(a), CY + R*Math.sin(a));
      ctx.stroke(); ctx.globalAlpha = 1;
    }
    if (n.type === 'slide' && n.slideEnd && t > n.time) { // Slide 進行中
      const ea = angleOf(n.slideEnd);
      const sp = Math.min(1, (t - n.time) / (n.slideDuration || 0.3));
      ctx.strokeStyle = col; ctx.lineWidth = 3; ctx.globalAlpha = 0.6;
      ctx.setLineDash([6, 6]);
      ctx.beginPath();
      ctx.moveTo(CX + R*Math.cos(a), CY + R*Math.sin(a));
      ctx.lineTo(CX + R*(1-sp)*Math.cos(a) + R*sp*Math.cos(ea),
                 CY + R*(1-sp)*Math.sin(a) + R*sp*Math.sin(ea));
      ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
    }

    ctx.lineWidth = 3.5;
    ctx.strokeStyle = col;
    ctx.fillStyle = n.isEx ? col : 'transparent';
    if (n.isStar || n.type === 'slide') { // 星形
      star(x, y, 11);
    } else {
      ctx.beginPath(); ctx.arc(x, y, 10, 0, 7); ctx.stroke();
      if (n.isEx) { ctx.globalAlpha = 0.35; ctx.fill(); ctx.globalAlpha = 1; }
    }
  }
}

function star(x, y, r) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const rr = i % 2 ? r * 0.45 : r;
    const a = -Math.PI/2 + i * Math.PI/5;
    i ? ctx.lineTo(x + rr*Math.cos(a), y + rr*Math.sin(a))
      : ctx.moveTo(x + rr*Math.cos(a), y + rr*Math.sin(a));
  }
  ctx.closePath(); ctx.stroke();
}

// ---------- 播放 Loop 迴圈 ----------
function loop(ts) {
  if (!playing) return;
  const dt = Math.min(100, ts - lastTs) / 1000;
  lastTs = ts;
  realTime += dt * speed;
  if (previewStop !== null && realTime >= previewStop) {
    realTime = previewStop;
    playing = false;
    previewStop = null;
    playBtn.textContent = '▶';
  }
  if (realTime >= DATA.meta.endTime) {
    realTime = DATA.meta.endTime;
    playing = false;
    playBtn.textContent = '▶';
  }
  syncUI();
  draw(realTime);
  if (playing) requestAnimationFrame(loop);
}

function setInputsDisabled(disabled) {
  $('b_m5').disabled = disabled;
  $('b_m1').disabled = disabled;
  $('b_f1').disabled = disabled;
  playBtn.disabled = disabled;
  $('b_f2').disabled = disabled;
  $('b_p1').disabled = disabled;
  $('b_p5').disabled = disabled;
  $('speedSel').disabled = disabled;
  $('hsSlider').disabled = disabled;
  slider.disabled = disabled;
  
  rA.disabled = disabled;
  rB.disabled = disabled;
  $('setStart').disabled = disabled;
  $('setEnd').disabled = disabled;
  $('goStart').disabled = disabled;
  $('previewRange').disabled = disabled;
  $('exportGifBtn').disabled = disabled;
}

function showMessage(text, type) {
  messageEl.textContent = text;
  messageEl.className = `message ${type}`;
}

setup().catch((e) => {
    console.error(e);
    statusEl.textContent = `初始化失敗：${e.message}`;
    statusEl.className = 'status status-error';
});
