import { DiscordSDK } from '@discord/embedded-app-sdk';
import { simaiDecode } from '../web/Scripts/decode.js';
import { SimaiRenderer } from '../web/Scripts/renderer.js';
import { loadAllImages, SimaiLogicControler, scaleBase, audioManager } from '../web/Scripts/helper.js';

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

// 常見的多裝置 / Session 衝突錯誤訊息鍵字
const SESSION_CONFLICT_HINTS = [
  '4006',    // Session resumption invalid
  '4009',    // Session timeout
  'invalidated',
  'closed',
  'terminated',
  'destroyed',
];

function isSessionConflict(msg) {
  const s = String(msg).toLowerCase();
  return SESSION_CONFLICT_HINTS.some(k => s.includes(k));
}

// 全域錯誤監聽：只發展自己程式碼的錯誤（過濾揚 SDK 內部錯誤）
window.onerror = function (message, source, lineno, colno, error) {
  // 忽略來自第三方 SDK bundle 的錯誤
  if (source && !source.includes('main.js') && !source.includes('localhost')) return true;
  statusEl.textContent = `JS 錯誤：${message} (L${lineno})`;
  statusEl.className = 'status status-error';
};

window.onunhandledrejection = function (event) {
  // 忽略接受來自 SDK 內部的 rejection
  const msg = event.reason?.message || String(event.reason);
  if (isSessionConflict(msg)) {
    showSessionConflictError();
    event.preventDefault();
    return;
  }
  statusEl.textContent = `未處理的 Rejection：${msg}`;
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
  const leftPanel = document.querySelector('.left-panel');
  const containerWidth = leftPanel
    ? leftPanel.clientWidth
    : (document.querySelector('.container').clientWidth - (window.innerWidth <= 480 ? 24 : 40));
  const maxCanvasSize = 320;
  size = Math.min(maxCanvasSize, containerWidth);
  cv.width = cv.height = size * devicePixelRatio;
  cv.style.width = cv.style.height = size + 'px';

  draw(realTime, 0);
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
    notes: decoded.notes,
    tags: decoded.tags
  };
}

async function setup() {
  console.log('[Activity] 開始初始化...');
  statusEl.textContent = '連線中：正在初始化 SDK…';
  statusEl.className = 'status status-connecting';
  await discordSdk.ready();
  console.log('[Activity] SDK 初始化完成，正在申請授權...');

  statusEl.textContent = '連線中：正在向用戶端申請授權…';
  const { code } = await discordSdk.commands.authorize({
    client_id: clientId,
    response_type: 'code',
    state: '',
    prompt: 'none',
    scope: ['identify'],
  });
  console.log('[Activity] 授權成功，code:', code);

  statusEl.textContent = '連線中：正在與本地後端交換 Token…';
  const res = await fetch('/.proxy/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  if (!res.ok) throw new Error(`token 交換失敗：${res.status}`);
  const { access_token } = await res.json();
  console.log('[Activity] Token 交換成功，正在驗證身分...');

  statusEl.textContent = '連線中：正在進行用戶身份驗證…';
  auth = await discordSdk.commands.authenticate({ access_token });
  console.log('[Activity] 身分驗證成功，使用者:', auth.user.username);

  statusEl.textContent = '連線中：正在獲取譜面資料…';
  const chartRes = await fetch('/.proxy/api/chart');
  if (!chartRes.ok) throw new Error(`譜面獲取失敗：${chartRes.status}`);
  const chartData = await chartRes.json();
  console.log('[Activity] 譜面獲取成功:', chartData.name);

  chartText = chartData.text;
  songTitleEl.textContent = chartData.name;

  statusEl.textContent = '連線中：正在解析譜面…';
  const decoded = simaiDecode(chartText, true);
  if (decoded.failed) {
    throw new Error('譜面解析失敗：請檢查語法');
  }
  console.log('[Activity] 譜面解析成功');

  statusEl.textContent = '連線中：正在載入圖片與音效素材…';
  images = await loadAllImages();

  // 同步載入音效（與圖片並行）
  await audioManager.init((pct) => {
    statusEl.textContent = `連線中：正在載入音效… ${Math.round(pct)}%`;
  }).catch(e => console.warn('[Audio] 音效載入部分失敗:', e));
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
  await document.fonts.ready;

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
    // 解鎖瀏覽器 AudioContext（需要使用者互動才能啟動）
    audioManager.ensureContextSync();
    if (audioManager.ctx?.state === 'suspended') {
      audioManager.ctx.resume().catch(() => {});
    }
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
  if (typeof range !== 'undefined' && N.length > 0) {
    const startM = measureIndex(N[range.start]?.time || 0);
    const endM = measureIndex(N[range.end]?.time || 0);
    dctx.fillStyle = 'rgba(255, 255, 255, 0.13)';
    dctx.fillRect(startM * bw, 0, (endM - startM + 1) * bw, h);
    dctx.fillStyle = css('--slide');
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

function getRangeDuration() {
  if (!N || N.length === 0) return 0;
  const startTime = N[range.start]?.time ?? 0;
  const endTime = (N[range.end]?.time ?? DATA?.meta.endTime ?? 0) + 0.8;
  return Math.max(0, endTime - startTime);
}

function syncRange() {
  range.start = Math.min(+rA.value, +rB.value);
  range.end = Math.max(+rA.value, +rB.value);

  const dur = getRangeDuration();
  const noteCount = range.end - range.start + 1;

  let label = `Combo ${range.start} - ${range.end}`;
  if (noteCount <= 0) {
    label += '  ⚠️ 空區間';
    showMessage('⚠️ 選取範圍內沒有音符，無法渲染。', 'error');
  } else if (dur > MAX_RENDER_SEC) {
    label += `  ⚠️ ~${dur.toFixed(1)}s（超過 ${MAX_RENDER_SEC}s 上限，將被截斷）`;
    showMessage(`⚠️ 所選區間約 ${dur.toFixed(1)} 秒，超過 ${MAX_RENDER_SEC} 秒上限，GIF 將只渲染前 ${MAX_RENDER_SEC} 秒。`, 'error');
  } else {
    label += `  (~${dur.toFixed(1)}s)`;
    showMessage('', '');
  }

  $('rangeLabel').textContent = label;
  drawDensity(measureIndex(realTime));
}
rA.addEventListener('input', syncRange);
rB.addEventListener('input', syncRange);

$('setStart').onclick = () => {
  const cIdx = currentComboIndex();
  rA.value = cIdx;
  rB.value = Math.max(range.end, cIdx);
  syncRange();
};
$('setEnd').onclick = () => {
  const cIdx = currentComboIndex();
  rB.value = cIdx;
  rA.value = Math.min(range.start, cIdx);
  syncRange();
};
$('goStart').onclick = () => {
  if (N[range.start]) seek(N[range.start].time);
};
$('previewRange').onclick = () => {
  if (N[range.start]) {
    seek(N[range.start].time);
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
    skipAudioQueue: !playing, // 播放中才觸發音效佇列
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

// ---------- 多裝置 Session 衝突處理 ----------

const retryBtn = $('retryBtn');
let setupRunning = false;

function showSessionConflictError() {
  songTitleEl.textContent = '連線中斷';
  statusEl.textContent = '⚠️ 此 Activity 已在另一裝置開啟，請關閉其他裝置後點擊「重新連線」。';
  statusEl.className = 'status status-error';
  retryBtn.style.display = '';
}

function showSetupError(e) {
  const msg = e?.message || String(e);
  if (isSessionConflict(msg)) {
    showSessionConflictError();
  } else {
    songTitleEl.textContent = '連線中斷';
    statusEl.textContent = `初始化失敗：${msg}`;
    statusEl.className = 'status status-error';
    retryBtn.style.display = '';
  }
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

    // 初始化成功後，監聽頁面隱藏 / 顯示：
    // 如果 Activity 在最低化後再次顯示，提示用戶可能需要重連
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && !playing) {
        showMessage('💡 若登入或切換了裝置，建議點擊「重新連線」以確認連線狀態。', 'info');
        retryBtn.style.display = '';
      }
    }, { once: true });
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
