import { DiscordSDK } from '@discord/embedded-app-sdk';
import { simaiDecode } from '../web/Scripts/decode.js';
import { SimaiRenderer } from '../web/Scripts/renderer.js';
import { loadAllImages, SimaiLogicControler, scaleBase, audioManager } from '../web/Scripts/helper.js';

// 除錯用：手機上的 Discord App 內建 WebView 不開放 Safari 遠端除錯，看不到 console，
// 所以改用 sendBeacon 把生命週期關鍵事件回報到我們自己的後端（印在 bot 的終端機），
// 用來排查 Activity 被關閉前最後執行到哪一步。sendBeacon 專門設計成連頁面正在被卸載時
// 也能盡量送出，失敗也不影響主流程。
function logRemote(event, data) {
  try {
    const payload = JSON.stringify({ event, data, ts: new Date().toISOString(), ua: navigator.userAgent });
    navigator.sendBeacon('/.proxy/api/debug-log', new Blob([payload], { type: 'application/json' }));
  } catch (e) {
    // 忽略：僅為除錯用途
  }
}

logRemote('script:loaded', { persisted: false });

// 手機瀏覽器（尤其 iOS）常會用 bfcache 把「關閉」的分頁凍結保留，下次「重新打開」時
// 直接復原舊分頁而非真正重新載入頁面 —— 這會讓 DiscordSDK 沿用第一次連線時的舊內部狀態，
// 導致第二次進入時被 Discord 判定 session 已失效而直接踢出。偵測到復原就強制整頁重載，
// 確保每次打開 Activity 都會建立全新的 DiscordSDK 連線。
window.addEventListener('pageshow', (event) => {
  logRemote('pageshow', { persisted: event.persisted });
  if (event.persisted) {
    window.location.reload();
  }
});

// 除錯用：如果閃退時有機會看到這則 log，代表是「正常的頁面卸載/導覽」；
// 如果完全沒收到，代表 WebView 是被更底層（原生 App 層級）直接砍掉，
// 連 JS 卸載事件都沒機會觸發。
window.addEventListener('pagehide', (event) => {
  logRemote('pagehide', { persisted: event.persisted });
});
document.addEventListener('visibilitychange', () => {
  logRemote('visibilitychange', { state: document.visibilityState });
});

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

// 全域錯誤監聽：只顯示自己程式碼的錯誤（過濾第三方 SDK 內部錯誤），但不論來源都回報除錯 log
window.onerror = function (message, source, lineno, colno, error) {
  logRemote('window.onerror', { message, source, lineno, colno });
  // 忽略來自第三方 SDK bundle 的錯誤
  if (source && !source.includes('main.js') && !source.includes('localhost')) return true;
  statusEl.textContent = `JS 錯誤：${message} (L${lineno})`;
  statusEl.className = 'status status-error';
};

window.onunhandledrejection = function (event) {
  const msg = event.reason?.message || String(event.reason);
  logRemote('unhandledrejection', { msg });
  statusEl.textContent = `未處理的 Rejection：${msg}`;
  statusEl.className = 'status status-error';
};

const discordSdk = new DiscordSDK(clientId, { disableConsoleLogOverride: true });

// 手機版 Discord 會在畫面最上方疊加自己的活動列（返回鈕／活動名稱／退出鈕），
// 那是原生 App 畫在 WebView 之上的，網頁這邊量不到高度。這裡改用兩個能取得的線索組合：
//   1. discordSdk.platform 判斷是不是手機（桌機完全不需要留白）
//   2. env(safe-area-inset-top) 取得該裝置的瀏海／狀態列高度，Discord 的活動列就疊在它下面
// 實際留白由 CSS 的 calc(safe-area-inset-top + 活動列高度) 算出，不同機型會自動調整。
if (discordSdk.platform === 'mobile') {
  document.documentElement.classList.add('platform-mobile');
}
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
let sfxVolume = 0.5; // SFX 音量（0.0 - 1.0）
let dragging = false;
let hs = 4.0;
let APPROACH = 2.8 / hs;

const defaultSettings = {
  speed: 6.5,
  touchSpeed: 7,
  slideSpeed: 0,
  middleDisplay: 1,
  moviebrightness: -4,
  showSensor: true,
  rotateStars: true,
  pinkStars: false,
  middleDistance: 0.25,
  effectDecayTime: 0.4,
  hanabiEffectDecayTime: 0.8,
  noteBaseSize: 11,
  maxSlideCount: 500,
  renderSurroundingAuxiliaryText: true,
  slideIllegalRed: false,
  showUI: false,
  notPlayHoldEnd: false,
  backgroundColor: '#0c0c1e', // 暗色系背景
  sfxVolumes: {},
};

let renderer = null;
let logic = null;
let playScoreRes = { tap: 0, hold: 0, slide: 0, touch: 0, break: 0, score: 0, breakScore: 0, invScore: 0 };
let outlineImage = null;
let images = null;
let nowIndexLocal = 0;

let size = 320;

function resizeCanvas() {
  // 譜面必須是正方形：取 #stage 可用寬高的較小值。
  // #stage 的寬高是由 flex 版面決定（不受畫布影響），所以這裡不會產生互相拉扯的迴圈。
  const stage = $('stage');
  const avail = stage
    ? Math.min(stage.clientWidth, stage.clientHeight)
    : Math.min(320, document.querySelector('.container').clientWidth - 40);

  size = Math.max(100, Math.floor(avail));
  cv.style.width = cv.style.height = size + 'px';
  cv.width = cv.height = size * devicePixelRatio;

  draw(realTime, 0);
  if (M.length > 0) {
    drawDensity(measureIndex(realTime));
  }
}
window.addEventListener('resize', resizeCanvas);

// 版面（尤其手機版的彈性高度）變動時重新同步畫布解析度
const stageEl = $('stage');
if (stageEl && window.ResizeObserver) {
  let lastSize = 0;
  new ResizeObserver(() => {
    const rect = cv.getBoundingClientRect();
    const now = Math.round(Math.min(rect.width, rect.height));
    if (now > 0 && Math.abs(now - lastSize) >= 1) {
      lastSize = now;
      resizeCanvas();
    }
  }).observe(stageEl);
}

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
    notes: decoded.notes,
    tags: decoded.tags
  };
}

async function setup() {
  console.log('[Activity] 開始初始化...');
  logRemote('setup:start');
  statusEl.textContent = '連線中：正在初始化 SDK…';
  statusEl.className = 'status status-connecting';
  await discordSdk.ready();
  console.log('[Activity] SDK 初始化完成，正在申請授權...');
  logRemote('setup:sdk_ready');

  statusEl.textContent = '連線中：正在向用戶端申請授權…';
  const { code } = await discordSdk.commands.authorize({
    client_id: clientId,
    response_type: 'code',
    state: '',
    prompt: 'none',
    scope: ['identify'],
  });
  console.log('[Activity] 授權成功，code:', code);
  logRemote('setup:authorized');

  statusEl.textContent = '連線中：正在與本地後端交換 Token…';
  const res = await fetch('/.proxy/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  if (!res.ok) throw new Error(`token 交換失敗：${res.status}`);
  const { access_token } = await res.json();
  console.log('[Activity] Token 交換成功，正在驗證身分...');
  logRemote('setup:token_exchanged');

  statusEl.textContent = '連線中：正在進行用戶身份驗證…';
  auth = await discordSdk.commands.authenticate({ access_token });
  console.log('[Activity] 身分驗證成功，使用者:', auth.user.username);
  logRemote('setup:authenticated', { username: auth.user.username });

  statusEl.textContent = '連線中：正在獲取譜面資料…';
  const chartRes = await fetch('/.proxy/api/chart');
  if (!chartRes.ok) throw new Error(`譜面獲取失敗：${chartRes.status}`);
  const chartData = await chartRes.json();
  console.log('[Activity] 譜面獲取成功:', chartData.name);
  logRemote('setup:chart_fetched', { name: chartData.name });

  chartText = chartData.text;
  songTitleEl.textContent = chartData.name;

  statusEl.textContent = '連線中：正在解析譜面…';
  const decoded = simaiDecode(chartText, true);
  if (decoded.failed) {
    throw new Error('譜面解析失敗：請檢查語法');
  }
  console.log('[Activity] 譜面解析成功');
  logRemote('setup:chart_decoded');

  statusEl.textContent = '連線中：正在載入圖片素材…';
  images = await loadAllImages();
  logRemote('setup:images_loaded');

  // 音效不在此處預載，改為使用者按下播放/預覽時才載入
  audioManager.setSFXVolume(sfxVolume);
  try {
    const blob = await (async () => {
      try {
        return await (await fetch('Skin/outline.png')).blob();
      } catch {
        return null;
      }
    })();
    if (blob) {
      outlineImage = await createImageBitmap(blob);
    }
  } catch (e) {
    console.error('Failed to load outline image:', e);
  }
  logRemote('setup:outline_loaded');
  await document.fonts.ready;
  logRemote('setup:fonts_ready');

  // 初始化播放器資料與核心引擎
  DATA = processChartData(decoded);
  M = DATA.measures;
  N = DATA.notes;
  D = DATA.density;

  renderer = new SimaiRenderer(cv, defaultSettings);
  renderer.setImages(images);
  renderer.setContext(ctx);
  logic = new SimaiLogicControler();

  // 更新 UI 文字
  $('hudBpm').textContent = Math.round(DATA.meta.bpm);
  $('hudMeasureMax').textContent = M.length - 1;
  $('hudComboMax').textContent = N.length;
  const c = DATA.meta.counts;
  metaLineEl.textContent = `TAP ${c.tap} · HOLD ${c.hold} · SLIDE ${c.slide} · TOUCH ${c.touch} · BREAK ${c.break} — ALL ${DATA.meta.total}`;

  // 更新 Sliders 範圍與最大值
  slider.max = M.length - 1;
  const maxCombo = N.length - 1;
  rA.max = rB.max = maxCombo;
  rA.value = 0;
  rB.value = maxCombo;
  range.start = 0;
  range.end = maxCombo;

  // 啟用控制 UI
  setInputsDisabled(false);

  statusEl.textContent = `連線成功：${auth.user.global_name ?? auth.user.username}`;
  statusEl.className = 'status status-ready';

  resizeCanvas();

  // 預設由進度條吃方向鍵，碰過端點才會換手
  setActiveEndpoint(null);

  // 若使用者是從訊息上的「繼續看譜」進來的，還原當初那一段的選取區間與播放位置
  const resumed = await restoreResumeSession(maxCombo);

  // 一般開啟（不是從「繼續看譜」進來）一律讓兩個端點回到最兩側＝整首全選。
  // 這裡重新指定一次，確保不受載入過程中任何順序問題影響。
  if (!resumed) {
    rA.value = 0;
    rB.value = maxCombo;
    range.start = 0;
    range.end = maxCombo;
  }

  syncRange();
  seek(resumed ? (N[range.start]?.time ?? 0) : 0);
  logRemote('setup:complete', resumed ? { resumed: [range.start, range.end] } : undefined);
}

/**
 * 從後端取回「繼續看譜」要還原的區間（由 bot 端在按鈕被按下時暫存）。
 * 取得後套用到兩個 range 滑桿；沒有就維持預設全選。
 */
async function restoreResumeSession(maxCombo) {
  try {
    const res = await fetch(`/.proxy/api/resume?userId=${encodeURIComponent(auth.user.id)}`);
    if (!res.ok) return false;
    const s = await res.json();
    if (typeof s.startCombo !== 'number' || typeof s.endCombo !== 'number') return false;

    const start = Math.max(0, Math.min(s.startCombo, maxCombo));
    const end = Math.max(start, Math.min(s.endCombo, maxCombo));
    rA.value = start;
    rB.value = end;
    range.start = start;
    range.end = end;
    showMessage('↩️ 已回到訊息中那一段的位置', 'info');
    return true;
  } catch (e) {
    console.warn('[Resume] 還原續看位置失敗:', e);
    return false;
  }
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
  // Seek 時清空音效佇列，避免舊音效在新時間點爆出
  audioManager.soundQueue = [];
  audioManager.stopAllScheduledSounds();
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
  $('hudCombo').textContent = currentComboIndex();
  drawDensity(mi);
}

// ---------- 播放按鈕與滑桿監聽 ----------
// 導覽鍵：移動播放頭；若先前有點過/拖過某個端點，該端點會跟著一起走，
// 方便「邊看邊微調」選取範圍（見 syncActiveEndpoint）
$('b_m5').onclick = () => { jumpMeasure(-5); syncActiveEndpoint(); };
$('b_m1').onclick = () => { jumpMeasure(-1); syncActiveEndpoint(); };
$('b_p1').onclick = () => { jumpMeasure(+1); syncActiveEndpoint(); };
$('b_p5').onclick = () => { jumpMeasure(+5); syncActiveEndpoint(); };
$('b_f1').onclick = () => { seek(realTime - 0.1); syncActiveEndpoint(); };
$('b_f2').onclick = () => { seek(realTime + 0.1); syncActiveEndpoint(); };
$('speedSlider').addEventListener('input', e => {
  speed = +e.target.value;
  $('speedVal').textContent = `${speed.toFixed(2)}×`;
});

// ---------- 音效模式：關 / 簡易（即時合成，免下載）/ 完整（wav 音效檔） ----------
// 完整模式的檔案只在使用者主動切到該模式時才下載；下載期間先用簡易合成音頂著，
// 載完之後 audioManager 找得到 buffer 就會自動改用真正的音效。
const SFX_MODES = ['off', 'simple', 'full'];
const SFX_MODE_LABEL = { off: '🔇 靜音', simple: '🔉 簡易', full: '🔊 完整' };
let sfxMode = 'simple';
let sfxFullLoading = false;
let sfxFullLoaded = false;

const sfxModeBtn = $('sfxModeBtn');
const controlSettings = document.querySelector('.control-settings');

function applySfxMode() {
  audioManager.muted = sfxMode === 'off';
  audioManager.synthFallback = sfxMode !== 'off';
  sfxModeBtn.textContent = SFX_MODE_LABEL[sfxMode];
  controlSettings.classList.toggle('sfx-off', sfxMode === 'off');
  if (sfxMode === 'off') {
    audioManager.soundQueue = [];
    audioManager.stopAllScheduledSounds();
  }
}

function loadFullSfx() {
  if (sfxFullLoaded || sfxFullLoading) return;
  sfxFullLoading = true;
  showMessage('🔊 正在載入完整音效…（先以簡易音播放）', 'info');
  audioManager.init((pct) => {
    showMessage(`🔊 正在載入完整音效… ${Math.round(pct)}%（先以簡易音播放）`, 'info');
  }).catch(e => console.warn('[Audio] 音效載入部分失敗:', e)).then(() => {
    audioManager.setSFXVolume(sfxVolume);
    sfxFullLoaded = true;
    sfxFullLoading = false;
    if (sfxMode === 'full') showMessage('✅ 完整音效已就緒', 'success');
    setTimeout(() => showMessage('', ''), 1500);
  });
}

sfxModeBtn.addEventListener('click', () => {
  sfxMode = SFX_MODES[(SFX_MODES.indexOf(sfxMode) + 1) % SFX_MODES.length];
  applySfxMode();
  // 這裡是使用者手勢，順便解鎖 AudioContext
  unlockAudio();
  if (sfxMode === 'full') loadFullSfx();
});

/** 解鎖瀏覽器 AudioContext（必須在使用者手勢中同步呼叫） */
function unlockAudio() {
  audioManager.ensureContextSync();
  if (audioManager.ctx?.state === 'suspended') {
    audioManager.ctx.resume().catch(() => { });
  }
}

playBtn.onclick = () => {
  playing = !playing;
  if (!playing) previewStop = null;
  playBtn.textContent = playing ? '⏸' : '▶';
  if (playing) {
    unlockAudio();
    lastTs = performance.now();
    requestAnimationFrame(loop);
  }
};

// 碰過進度條就把方向鍵的控制權交還給播放進度（不再是選取範圍的端點）
slider.addEventListener('pointerdown', () => { dragging = true; setActiveEndpoint(null); });
window.addEventListener('pointerup', () => dragging = false);
slider.addEventListener('input', () => { setActiveEndpoint(null); seek(M[+slider.value]); });

// ---------- 密度圖拖曳跳轉 ----------
function densSeek(ev) {
  const r = dv.getBoundingClientRect();
  const frac = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
  seek(M[Math.round(frac * (M.length - 1))]);
}
dv.addEventListener('pointerdown', ev => { dragging = true; setActiveEndpoint(null); densSeek(ev); });
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
  if (typeof range !== 'undefined' && N.length > 0) {
    const startM = measureIndex(N[range.start]?.time || 0);
    const endM = measureIndex(N[range.end]?.time || 0);
    dctx.fillStyle = rangeOverLimit ? 'rgba(242, 63, 67, 0.16)' : 'rgba(255, 255, 255, 0.13)';
    dctx.fillRect(startM * bw, 0, (endM - startM + 1) * bw, h);
    // 區間過長時兩條端點線轉紅，取代原本的文字警告
    dctx.fillStyle = rangeOverLimit ? OVER_LIMIT_COLOR : css('--slide');
    dctx.fillRect(startM * bw, 0, 2, h);
    dctx.fillRect((endM + 1) * bw - 2, 0, 2, h);
  }

  // 播放頭
  dctx.fillStyle = '#ffffff';
  dctx.fillRect(playheadMi * bw, 0, Math.max(2, bw * 0.6), h);
}

// ---------- 範圍選取同步與預覽 ----------
function currentComboIndex() {
  if (!N || N.length === 0) return 0;
  const idx = N.findIndex(n => n.time >= realTime);
  return idx === -1 ? N.length - 1 : idx;
}

const MAX_RENDER_SEC = 30;
const OVER_LIMIT_COLOR = '#f23f43';

// 「切的乾淨」：把選取範圍從 simai 原始碼切出來成一段獨立譜面（補回開頭的 BPM／分音）
// 再送去渲染；關閉時沿用舊做法（送整份譜面＋起訖時間）。實際切割在後端做，
// 這裡只負責把選擇傳過去。預設開啟。
let cleanCut = true;
// 選取區間超過渲染秒數上限時為 true：只用顏色提示，不跳文字警告
let rangeOverLimit = false;

function getRangeDuration() {
  if (!N || N.length === 0) return 0;
  const startTime = N[range.start]?.time ?? 0;
  const endTime = (N[range.end]?.time ?? DATA?.meta.endTime ?? 0) + 0.8;
  return Math.max(0, endTime - startTime);
}

function syncRange() {
  range.start = Math.min(+rA.value, +rB.value);
  range.end = Math.max(+rA.value, +rB.value);

  const max = +rA.max || 1;
  const pctStart = (range.start / max) * 100;
  const pctEnd = (range.end / max) * 100;
  const fill = $('rangeFill');
  fill.style.left = `${pctStart}%`;
  fill.style.width = `${Math.max(0, pctEnd - pctStart)}%`;

  const dur = getRangeDuration();
  const noteCount = range.end - range.start + 1;

  // 區間過長不用文字警告，直接把選取範圍的兩條端點線與滑桿標成紅色
  rangeOverLimit = noteCount > 0 && dur > MAX_RENDER_SEC;
  $('rangeTrack').classList.toggle('over-limit', rangeOverLimit);

  let label = `Combo ${range.start} - ${range.end}`;
  if (noteCount <= 0) {
    label += '  ⚠️ 空區間';
    showMessage('⚠️ 選取範圍內沒有音符，無法渲染。', 'error');
  } else {
    label += `  (~${dur.toFixed(1)}s)`;
    showMessage('', '');
  }

  // 端點狀態標記：🔒 鎖定、◆ 作用中（導覽鍵會帶著它一起走）
  const mark = (which, name) =>
    rangeLocked[which] ? `🔒${name}` : (activeEndpoint === which ? `◆${name}` : '');
  const marks = [mark('a', '起'), mark('b', '終')].filter(Boolean).join(' ');
  if (marks) label += `  ${marks}`;

  $('rangeLabel').textContent = label;
  $('rangeLabel').classList.toggle('over-limit', rangeOverLimit);
  drawDensity(measureIndex(realTime));
}

// ---------- 端點拖曳：即時預覽該時間 + 雙擊鎖定 ----------
// 鎖定後該端點不吃指標事件（見 CSS 的 .locked），避免調好之後被誤觸
const rangeLocked = { a: false, b: false };

/**
 * 目前方向鍵/導覽鍵在控制哪個東西：
 *   'a' / 'b' —— 選取範圍的起點／終點（最後一次點過或拖過的那個）
 *   null      —— 播放進度（拖過進度條或密度圖之後就切回這個）
 */
let activeEndpoint = null;

function setActiveEndpoint(which) {
  activeEndpoint = which;
  rA.classList.toggle('active', which === 'a');
  rB.classList.toggle('active', which === 'b');
  slider.classList.toggle('active', which === null);
}

/** 導覽鍵移動播放頭後，把作用中的端點同步到新位置（鎖定的端點不動） */
function syncActiveEndpoint() {
  if (!activeEndpoint || rangeLocked[activeEndpoint]) return;
  const input = activeEndpoint === 'a' ? rA : rB;
  input.value = currentComboIndex();
  syncRange();
}

function applyRangeLocks() {
  rA.classList.toggle('locked', rangeLocked.a);
  rB.classList.toggle('locked', rangeLocked.b);
  syncRange();
}

/** 拖動端點時同步把播放頭移到該端點的時間，拖到哪就看到哪 */
function onRangeInput(which) {
  const input = which === 'a' ? rA : rB;
  if (rangeLocked[which]) {
    // 鎖定中：還原成鎖定前的值（防鍵盤等非指標操作繞過）
    input.value = which === 'a' ? range.start : range.end;
    return;
  }
  setActiveEndpoint(which);
  syncRange();
  const t = N[+input.value]?.time;
  if (t !== undefined) seek(t);
}

rA.addEventListener('input', () => onRangeInput('a'));
rB.addEventListener('input', () => onRangeInput('b'));

// 雙擊/雙點切換鎖定。用 pointerdown 自行判定，因為手機上的 dblclick 不可靠，
// 而且鎖定中的端點 pointer-events 是關的，事件要由整條軌道來收。
(() => {
  const track = $('rangeTrack');
  let last = { t: 0, which: null };

  const nearestThumb = (clientX) => {
    const r = track.getBoundingClientRect();
    const val = ((clientX - r.left) / r.width) * (+rA.max || 1);
    return Math.abs(val - +rA.value) <= Math.abs(val - +rB.value) ? 'a' : 'b';
  };

  track.addEventListener('pointerdown', (e) => {
    if (rA.disabled) return;
    const which = nearestThumb(e.clientX);
    const now = performance.now();
    if (last.which === which && now - last.t < 350) {
      rangeLocked[which] = !rangeLocked[which];
      applyRangeLocks();
      showMessage(
        rangeLocked[which]
          ? `🔒 已鎖定${which === 'a' ? '起點' : '終點'}（再雙擊解除）`
          : `🔓 已解除${which === 'a' ? '起點' : '終點'}鎖定`,
        'info'
      );
      last = { t: 0, which: null };
      return;
    }
    last = { t: now, which };

    // 單點也算「碰過」：之後按導覽鍵就是在調這一端
    if (!rangeLocked[which]) setActiveEndpoint(which);
  });
})();

// 方向鍵：控制「目前作用中的東西」——碰過端點就微調端點，碰過進度條就微調播放進度。
// 註：刻意掛在 document 上而不是依賴 input 的 DOM 焦點——點過畫面上其他東西
// （播放鍵、時間軸…）之後焦點就跑掉了，會變成按方向鍵沒反應。
// preventDefault 同時擋掉「input 還有焦點時瀏覽器又自己加一步」造成的雙重移動。
document.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  if (!DATA || playBtn.disabled) return; // 譜面還沒載入
  const dir = e.key === 'ArrowLeft' ? -1 : 1;

  // 沒有作用中的端點 → 控制播放進度（← → 微調 0.1s，Shift 為 1 小節，對齊 ＜ 與 ＜＜）
  if (!activeEndpoint) {
    e.preventDefault();
    if (e.shiftKey) jumpMeasure(dir);
    else seek(realTime + dir * 0.1);
    return;
  }

  if (rangeLocked[activeEndpoint]) return;
  const input = activeEndpoint === 'a' ? rA : rB;
  if (input.disabled) return;

  const step = e.shiftKey ? 10 : 1; // 按住 Shift 一次跳 10 combo
  const max = +input.max || 0;
  input.value = Math.max(0, Math.min(max, +input.value + dir * step));

  e.preventDefault();
  onRangeInput(activeEndpoint);
});

$('setStart').onclick = () => {
  if (rangeLocked.a) return showMessage('🔒 起點已鎖定，雙擊該端點可解除', 'info');
  const cIdx = currentComboIndex();
  rA.value = cIdx;
  if (!rangeLocked.b) rB.value = Math.max(range.end, cIdx);
  syncRange();
};
$('setEnd').onclick = () => {
  if (rangeLocked.b) return showMessage('🔒 終點已鎖定，雙擊該端點可解除', 'info');
  const cIdx = currentComboIndex();
  rB.value = cIdx;
  if (!rangeLocked.a) rA.value = Math.min(range.start, cIdx);
  syncRange();
};
$('goStart').onclick = () => {
  if (N[range.start]) seek(N[range.start].time);
};
$('previewRange').onclick = () => {
  if (N[range.start]) {
    seek(N[range.start].time);
    // 預覽的停點跟實際輸出一致（切的乾淨＝停在結束點，不多播）
    previewStop = (N[range.end]?.time || DATA.meta.endTime) + 0.8;
    if (!playing) playBtn.click();
  }
};

// ---------- 流速 (ハイスピ) 控制 ----------
$('hsSlider').addEventListener('input', e => {
  const newHs = +e.target.value;
  $('hsVal').textContent = newHs.toFixed(1);
  defaultSettings.speed = newHs;
  draw(realTime, 0);
});

// ---------- 音效音量控制 ----------
$('sfxSlider').addEventListener('input', e => {
  sfxVolume = +e.target.value;
  $('sfxVal').textContent = Math.round(sfxVolume * 100) + '%';
  audioManager.setSFXVolume(sfxVolume);
});

applySfxMode();

// ---------- 「切的乾淨」開關 ----------
$('cleanCutBtn').addEventListener('click', () => {
  cleanCut = !cleanCut;
  $('cleanCutBtn').textContent = `✂ 切的乾淨：${cleanCut ? '開' : '關'}`;
  syncRange(); // 預估長度會跟著變
});

// ---------- 左上角設定選單（倍速／流速／音量） ----------
(() => {
  const toggle = $('settingsToggle');
  const panel = $('settingsPanel');
  if (!toggle || !panel) return;

  const close = () => { panel.hidden = true; };

  // 浮層是 fixed 定位，開啟時對齊到按鈕正下方（超出右邊界就往左收）
  function position() {
    const r = toggle.getBoundingClientRect();
    panel.style.top = `${r.bottom + 6}px`;
    panel.style.left = '0px';
    const w = panel.offsetWidth;
    panel.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
  }

  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    panel.hidden = !panel.hidden;
    if (!panel.hidden) {
      position();
      // 使用者手勢，順便解鎖 AudioContext
      unlockAudio();
    }
  });

  window.addEventListener('resize', () => { if (!panel.hidden) position(); });

  // 點面板以外的地方就收起來；面板內部的操作不關閉
  panel.addEventListener('click', e => e.stopPropagation());
  document.addEventListener('click', close);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
})();

// ---------- GIF 渲染並傳送 ----------
$('exportGifBtn').onclick = async () => {
  // 前端防護：空區間檢查
  const noteCount = range.end - range.start + 1;
  if (noteCount <= 0) {
    showMessage('⚠️ 選取範圍內沒有音符，請重新選取。', 'error');
    return;
  }

  setInputsDisabled(true);
  showMessage('🎬 正在向 Bot 發送渲染請求，請稍候…', 'info');

  const startCombo = range.start;
  const endCombo = range.end;
  const dur = getRangeDuration();

  try {
    const res = await fetch('/.proxy/api/render', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channelId: discordSdk.channelId,
        userId: auth.user.id,
        username: auth.user.global_name ?? auth.user.username,
        simai: chartText,
        startCombo: startCombo,
        endCombo: endCombo,
        chartName: songTitleEl.textContent,
        cleanCut,
      }),
    });

    const data = await res.json().catch(() => ({}));

    if (res.ok) {
      const truncNote = dur > MAX_RENDER_SEC ? `（僅渲染前 ${MAX_RENDER_SEC} 秒）` : '';
      showMessage(`✅ 請求成功${truncNote}！正在關閉視窗並在頻道中開始渲染…`, 'success');
      // 送出成功後保持 disabled，等待視窗關閉，不重新啟用按鈕
      setTimeout(() => {
        Promise.resolve(discordSdk.close()).catch(err => console.error('Failed to close activity:', err));
      }, 800);
      return; // 不執行 finally 的 setInputsDisabled(false)
    } else {
      showMessage(`❌ 渲染失敗：${data.error || res.statusText}`, 'error');
    }
  } catch (e) {
    console.error('Export request failed:', e);
    showMessage(`❌ 網路錯誤，無法傳送請求：${e.message}`, 'error');
  }
  // 只有失敗的情況才重新啟用 UI
  setInputsDisabled(false);
};

// ---------- 繪製邏輯 ----------

function draw(t, dt = 0) {
  if (!renderer || !logic || !DATA) return;

  const {
    buckets, playCombo, playScore, noteQuantity,
    nowIndex: updatedNowIndex,
  } = logic.get({
    renderer,
    globalTime: t,
    realTime: t,
    musicDelay: 0,
    playing: playing,
    timeControlSliding: dragging,
    readyBeat: false,
    playedClock: [],
    settings: defaultSettings,
    visualHeight: 0,
    notes: N,
    decodedTags: DATA.tags || [],
    playScoreRes,
    nowIndex: nowIndexLocal,
    // 必須固定傳 false：logic 內部本來就有 `playing` 判斷，只有在播放中才會真的排入音效；
    // 而暫停/拖曳時要靠它的 else 分支把每顆 note 的 _startEffectPlayed / _endEffectPlayed
    // 重設回 false。先前這裡傳 !playing，導致暫停時整段邏輯被跳過、旗標一直留在 true，
    // 於是倒帶後重新播放時那些音符就再也不會發聲。
    skipAudioQueue: false,
  });
  nowIndexLocal = updatedNowIndex;

  // 1. 清理與繪製背景色
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = defaultSettings.backgroundColor;
  ctx.fillRect(0, 0, cv.width, cv.height);

  // 2. 套用 Maimai 縮放並置中
  const p = size * devicePixelRatio / scaleBase * renderer.scale;
  ctx.setTransform(p, 0, 0, p, cv.width / 2, cv.height / 2);

  // 3. 繪製框線圖
  if (outlineImage) {
    ctx.drawImage(outlineImage, scaleBase * -0.5 * 0.9, scaleBase * -0.5 * 0.9, scaleBase * 0.9, scaleBase * 0.9);
  }

  // 4. 繪製核心影格 (使用相同的變形矩陣)
  renderer.drawFrame({
    globalTime: t,
    buckets,
    dt: dt * speed,
    showSensor: defaultSettings.showSensor,
    showSensorText: false,
    playCombo,
    playScore,
    nowIndex: nowIndexLocal,
    skipClear: true,
    noteQuantity,
    playScoreRes,
  });
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
  draw(realTime, dt);
  // 音效更新：處理佇列中等待播放的音效
  audioManager.update(realTime);
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
  $('speedSlider').disabled = disabled;
  $('hsSlider').disabled = disabled;
  $('settingsToggle').disabled = disabled;
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

// ---------- 連線失敗重試 ----------

const retryBtn = $('retryBtn');
let setupRunning = false;

function showSetupError(e) {
  const msg = e?.message || String(e);
  logRemote('setup:error', { msg });
  songTitleEl.textContent = '連線中斷';
  statusEl.textContent = `初始化失敗：${msg}`;
  statusEl.className = 'status status-error';
  retryBtn.style.display = '';
  setupRunning = false;
}

async function runSetup() {
  if (setupRunning) return;
  setupRunning = true;
  retryBtn.style.display = 'none';
  songTitleEl.textContent = '連線中…';
  try {
    await setup();
    setupRunning = false;
  } catch (e) {
    console.error(e);
    showSetupError(e);
  }
}

retryBtn.addEventListener('click', () => {
  showMessage('', '');
  runSetup();
});

runSetup();
