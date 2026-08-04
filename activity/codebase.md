# app/index.html

```html
<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Simai 譜面預覽播放器</title>
</head>
<body>
<div id="app"></div>
<script type="module" src="/src/main.js"></script>
</body>
</html>

```

# app/smoke-test.mjs

```mjs
// UI 煙霧測試（smoke test）：用 Playwright 開一個真的瀏覽器，把「本機預覽模式」
// 走一輪關鍵互動，確認畫面沒有明顯壞掉。不是正式的測試框架（沒有 assert 庫、沒有 CI 整合），
// 純粹是重構過程中拿來快速自我檢查、事後也能重跑確認沒有回歸的小工具。
//
// 用法：
//   終端機 1：npm run bot
//   終端機 2：npm run dev:activity
//   終端機 3：npm run test:activity            （Chrome）
//             npm run test:activity:webkit     （Safari 引擎——ResizeObserver 迴圈這類問題
//                                                Chrome 不會報、只有 WebKit 會炸，只測 Chrome 會漏掉）
import { chromium, webkit } from 'playwright-core';

const BASE_URL = process.env.ACTIVITY_DEV_URL ?? 'http://localhost:5173';
const ENGINE = process.env.BROWSER_ENGINE ?? 'chromium';
let failures = 0;

function check(label, condition, detail = '') {
  const ok = Boolean(condition);
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
  return ok;
}

async function launchBrowser() {
  if (ENGINE === 'webkit') {
    return webkit.launch({ headless: true });
  }
  for (const opt of [{ channel: 'chrome' }, { channel: 'msedge' }, {}]) {
    try {
      return await chromium.launch({ ...opt, headless: true });
    } catch {
      // 換下一個候選 channel 再試
    }
  }
  throw new Error('找不到可用的瀏覽器（試過 chrome / msedge / 內建 chromium）');
}

async function main() {
  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });

  const pageErrors = [];
  const failedRequests = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  page.on('response', (res) => {
    // debug-log 在預覽模式本來就會 404（fire-and-forget），排除掉才不會洗版
    if (res.status() >= 400 && !res.url().includes('debug-log') && !res.url().includes('api/charts')) {
      failedRequests.push(`HTTP ${res.status()}: ${res.url()}`);
    }
  });

  console.log(`\n連線到 ${BASE_URL} ...`);
  await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 20000 });
  await page.waitForFunction(() => !document.querySelector('.btn-settings')?.disabled, { timeout: 20000 })
    .catch(() => console.log('⚠️  等待畫面就緒逾時（inputsEnabled 一直沒變成 true）'));
  await page.waitForTimeout(500);

  // ---------- 基本載入 ----------
  const title = await page.textContent('h1').catch(() => null);
  const status = await page.textContent('.status-ready, .status-connecting, .status-error').catch(() => null);
  check('本機預覽模式成功連線', status?.includes('連線成功'), status);
  check('譜面標題有載入', Boolean(title && title !== '連線中…'), title);

  // ---------- 設定面板：開啟、定位、關閉 ----------
  await page.click('.btn-settings');
  await page.waitForTimeout(200);
  check('點齒輪按鈕後設定面板可見', await page.isVisible('#settingsPanel'));
  const panelPosition = await page.evaluate(() => getComputedStyle(document.querySelector('#settingsPanel')).position);
  check('設定面板是 position:fixed（沒有跑版）', panelPosition === 'fixed', panelPosition);

  const hsInput = page.locator('.speedbox').nth(1).locator('input[type=range]');
  await hsInput.fill('7');
  await hsInput.dispatchEvent('input');
  await page.waitForTimeout(150);
  check('流速滑桿拉到 7 後數值同步更新', (await page.locator('#hsVal').textContent()) === '7.0');

  await page.click('#hud'); // 點面板外面
  await page.waitForTimeout(150);
  check('點面板外面後設定面板關閉', !(await page.isVisible('#settingsPanel')));

  // ---------- 播放鍵左右同步 ----------
  await page.click('.btn-play >> nth=0');
  await page.waitForTimeout(100);
  const leftLabel = await page.locator('.btn-play').nth(0).textContent();
  const rightLabel = await page.locator('.btn-play').nth(1).textContent();
  check('左右兩顆播放鍵狀態同步', leftLabel === rightLabel, `left=${leftLabel} right=${rightLabel}`);
  await page.click('.btn-play >> nth=0'); // 暫停，避免後面的檢查跑到一半時間軸還在動

  // ---------- 進度條/密度圖最左邊應該真的能拖回 0 秒 ----------
  // 迴歸測試：M[0] 其實是「第一小節」的起點時間（offset），不是 0 秒，
  // 拖到最左邊如果沒特別處理，永遠會卡在第一小節開頭、回不去前奏。
  const measureHud = page.locator('#hud b').nth(1); // 0=BPM, 1=小節, 2=Combo
  const slider = page.locator('#measureSlider');
  await slider.fill('50');
  await slider.dispatchEvent('input');
  await page.waitForTimeout(150);
  await slider.fill('0');
  await slider.dispatchEvent('input');
  await page.waitForTimeout(150);
  check('進度條拖回最開頭會回到小節 0（不是卡在第一小節開頭）', (await measureHud.textContent()) === '0');

  await slider.fill('50');
  await slider.dispatchEvent('input');
  await page.waitForTimeout(150);
  const densityBox = await page.locator('#densityWrap').boundingBox();
  await page.mouse.move(densityBox.x + 1, densityBox.y + densityBox.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(150);
  check('點密度圖最左邊也會回到小節 0', (await measureHud.textContent()) === '0');
  await page.mouse.up();

  // ---------- 鍵盤：沒有 active endpoint 時，方向鍵應該推進播放進度 ----------
  // 用 'Shift+ArrowRight' 合併寫法送出，比 down()/press()/up() 手動組合可靠。
  // 按 3 次（每次跳約 3 秒）而不是只按 1 次：單次 3 秒是否會跨過一個小節邊界
  // 取決於該小節的實際長度（跟 BPM 換算出來的 measureDuration 有關，不同譜面不一樣），
  // 按 1 次剛好卡在邊界內側是完全正常的情況，不代表沒有作用——按 3 次才是可靠、不挑譜面的檢查方式。
  await page.click('#hud');
  const sliderBefore = await page.evaluate(() => document.querySelector('#measureSlider').value);
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Shift+ArrowRight');
    await page.waitForTimeout(100);
  }
  const sliderAfter = await page.evaluate(() => document.querySelector('#measureSlider').value);
  check('Shift+方向鍵推進播放進度（無 active endpoint）', sliderBefore !== sliderAfter, `${sliderBefore} -> ${sliderAfter}`);

  // ---------- 範圍選取：拖曳、端點鍵盤微調 ----------
  const rangeLabelBefore = await page.textContent('#rangeLabel');
  const rangeAInput = page.locator('.range-track').nth(0).locator('input');
  await rangeAInput.fill('900');
  await rangeAInput.dispatchEvent('input');
  await page.waitForTimeout(150);
  const rangeLabelAfter = await page.textContent('#rangeLabel');
  check('拖範圍起點滑桿後標籤重新計算', rangeLabelBefore !== rangeLabelAfter, `${rangeLabelBefore} -> ${rangeLabelAfter}`);

  // 注意：點過端點後按方向鍵，本來就「應該」連動播放頭一起移動過去（原始設計：
  // onRangeInput 每次改端點都會 engine.seek，方便邊調邊看那個位置長怎樣，不是 bug）。
  // 這裡只驗證方向鍵改成走「微調端點」這條路（±1 個逗號），不驗證播放頭動不動。
  const rangeBBefore = await page.evaluate(() => document.querySelectorAll('.range-track input')[1].value);
  await page.locator('.range-track').nth(1).click({ position: { x: 10, y: 10 } });
  await page.waitForTimeout(100);
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(100);
  const rangeBAfter = await page.evaluate(() => document.querySelectorAll('.range-track input')[1].value);
  check('點過範圍終點後方向鍵改成微調端點（±1 個逗號）', rangeBBefore !== rangeBAfter, `${rangeBBefore} -> ${rangeBAfter}`);

  // ---------- 預覽彈窗：切的乾淨 / 沿用原譜面片段，各測一次 ----------
  const previewBtn = page.getByText('▶ 預覽', { exact: true });

  await previewBtn.click();
  await page.waitForTimeout(800);
  check('預覽彈窗（切的乾淨）可見', await page.isVisible('.preview-modal-box'));
  check('預覽彈窗（切的乾淨）標題正確', (await page.textContent('.preview-modal-box h3')) === '預覽（切的乾淨）');
  check('預覽彈窗（切的乾淨）canvas 有掛載', (await page.locator('#previewCanvas').count()) === 1);
  check('預覽彈窗（切的乾淨）沒有錯誤訊息', (await page.locator('.preview-modal-box .message.error').count()) === 0);
  await page.click('.preview-modal-box .btn-modal-cancel');
  await page.waitForTimeout(150);
  check('關閉後預覽彈窗不可見', !(await page.isVisible('.preview-modal-box')));

  // 關掉「切的乾淨」，改測第二種預覽方式（沿用主譜面資料、只是 seek 播放範圍）
  await page.click('.btn-settings');
  await page.waitForTimeout(150);
  await page.click('button:has-text("切的乾淨")');
  await page.waitForTimeout(100);
  await page.click('#hud');
  await page.waitForTimeout(100);

  await previewBtn.click();
  await page.waitForTimeout(800);
  check('預覽彈窗（原始譜面片段）可見', await page.isVisible('.preview-modal-box'));
  check('預覽彈窗（原始譜面片段）標題正確', (await page.textContent('.preview-modal-box h3')) === '預覽（原始譜面片段）');
  check('預覽彈窗（原始譜面片段）沒有錯誤訊息', (await page.locator('.preview-modal-box .message.error').count()) === 0);
  await page.click('.preview-modal-box .btn-modal-cancel');
  await page.waitForTimeout(150);

  // 測完改回開啟狀態，不影響後面的匯出彈窗測試（預設應該是開的）
  await page.click('.btn-settings');
  await page.waitForTimeout(150);
  await page.click('button:has-text("切的乾淨")');
  await page.click('#hud');
  await page.waitForTimeout(100);

  // ---------- 匯出確認彈窗 ----------
  await page.click('.btn-export');
  await page.waitForTimeout(150);
  check('匯出按鈕開啟確認彈窗', await page.isVisible('.modal-overlay'));
  await page.click('.btn-modal-cancel');
  await page.waitForTimeout(150);
  check('取消後彈窗關閉', !(await page.isVisible('.modal-overlay')));

  // ---------- 錯誤 / 資源檢查 ----------
  check('過程中沒有 JS 例外', pageErrors.length === 0, pageErrors.join(' | '));
  check('過程中沒有資源載入失敗（debug-log 除外）', failedRequests.length === 0, failedRequests.join(' | '));

  await browser.close();

  console.log(`\n${failures === 0 ? '✅ 全部通過' : `❌ 有 ${failures} 項沒過`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('測試腳本本身出錯：', e);
  process.exit(1);
});

```

# app/src/App.vue

```vue
<script setup>
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue';
import HeaderStatus from './components/HeaderStatus.vue';
import SettingsPanel from './components/SettingsPanel.vue';
import PlayerControls from './components/PlayerControls.vue';
import ChartCanvas from './components/ChartCanvas.vue';
import Timeline from './components/Timeline.vue';
import ColorLegend from './components/ColorLegend.vue';
import FooterMessage from './components/FooterMessage.vue';
import ConfirmModal from './components/ConfirmModal.vue';
import PreviewModal from './components/PreviewModal.vue';
import { useChartData } from './composables/useChartData.js';
import { usePlayerEngine } from './composables/usePlayerEngine.js';
import { useSfx } from './composables/useSfx.js';
import { useRangeSelection, MAX_RENDER_SEC } from './composables/useRangeSelection.js';
import { useDiscordSession } from './composables/useDiscordSession.js';
import { fatalError, logRemote } from './composables/useDebugLogging.js';

// composable 之間互相依賴：chart 先載好資料，engine/rangeSel 再從 chart 讀資料出來用。
// 這不是什麼特殊機制，composable 就是一般函式，把前一個的回傳值當參數傳給下一個即可。
const chart = useChartData();
const engine = usePlayerEngine(chart);
const sfx = useSfx();
const rangeSel = useRangeSelection(chart, engine);
const session = useDiscordSession();

const songTitleDisplay = ref('連線中…');
const retryVisible = ref(false);
const inputsEnabled = ref(false);
const message = ref({ text: '', type: '' });
const settingsOpen = ref(false);
const settingsPositionStyle = ref({});
const confirmOpen = ref(false);
const confirmMeta = ref('');
const confirmText = ref('');
const previewOpen = ref(false);
const chartList = ref([]);
const currentChartId = ref('');

const headerRef = ref(null);
const settingsPanelRef = ref(null);

let setupRunning = false;

async function onSelectChart(chartId) {
  if (!chartId || chartId === currentChartId.value) return;
  inputsEnabled.value = false;
  engine.pause();
  showMessage('🔄 正在切換測試譜面…', 'info');
  try {
    const data = await session.fetchChartData(chartId);
    chart.loadFromText(data.text, data.name);
    songTitleDisplay.value = chart.chartName.value;
    currentChartId.value = data.filename || chartId;

    engine.resetPlaybackState();
    const maxComma = chart.C.value.length - 2;
    rangeSel.initBounds(maxComma, { start: 0, end: maxComma });
    engine.seek(0);
    rangeSel.setActiveEndpoint(null);
    inputsEnabled.value = true;
    showMessage(`✅ 已切換至譜面：${chart.chartName.value}`, 'success');
  } catch (e) {
    console.error('切換譜面失敗:', e);
    showMessage(`❌ 切換譜面失敗：${e.message}`, 'error');
    inputsEnabled.value = true;
  }
}

const hudBpm = computed(() => chart.DATA.value ? Math.round(chart.DATA.value.meta.bpm) : '-');
const hudMeasureMax = computed(() => chart.DATA.value ? chart.M.value.length - 1 : '-');
const hudComboMax = computed(() => chart.DATA.value ? chart.N.value.length : '-');
const metaLine = computed(() => {
  if (!chart.DATA.value) return '';
  const c = chart.DATA.value.meta.counts;
  return `TAP ${c.tap} · HOLD ${c.hold} · SLIDE ${c.slide} · TOUCH ${c.touch} · BREAK ${c.break} — ALL ${chart.DATA.value.meta.total}`;
});

function showMessage(text, type) {
  message.value = { text, type };
}

// 範圍選取變動時（空區間警告）自動反映到底部訊息列；匯出流程的訊息也是寫同一個 ref，後寫的蓋掉先寫的
watch(() => rangeSel.rangeMessage.value, (m) => showMessage(m.text, m.type));

// 任何地方丟出的全域錯誤都會反映到這個模組層級的 ref 上（見 useDebugLogging.js）
watch(fatalError, (msg) => {
  if (msg) session.setStatus(msg, 'status-error');
});

async function init() {
  if (setupRunning) return;
  setupRunning = true;
  retryVisible.value = false;
  songTitleDisplay.value = '連線中…';
  try {
    const { fetchChartPath } = await session.connect();

    // 取得所有 testChart 選項
    const list = await session.fetchChartList();
    chartList.value = list;

    session.setStatus('連線中：正在獲取譜面資料…', 'status-connecting');
    await chart.loadChart(fetchChartPath);
    songTitleDisplay.value = chart.chartName.value;
    const initialChart = list.find(c => c.name === chart.chartName.value);
    if (initialChart) currentChartId.value = initialChart.id;
    logRemote('setup:chart_fetched', { name: chart.chartName.value });

    session.setStatus('連線中：正在載入圖片素材…', 'status-connecting');
    await engine.loadAssets();
    logRemote('setup:assets_loaded');

    engine.initEngine();

    const maxComma = chart.C.value.length - 2;
    rangeSel.initBounds(maxComma, { start: 0, end: maxComma });

    inputsEnabled.value = true;
    session.setStatus(`連線成功：${session.auth.value.user.global_name ?? session.auth.value.user.username}`, 'status-ready');
    engine.resizeCanvas();
    rangeSel.setActiveEndpoint(null);

    // 若使用者是從訊息上的「繼續看譜」進來的，還原當初那一段的選取區間與播放位置
    const resumed = await session.fetchResumeSession(maxComma);
    if (resumed) {
      rangeSel.initBounds(maxComma, resumed);
      showMessage('↩️ 已回到訊息中那一段的位置', 'info');
    }
    engine.seek(resumed ? (chart.C.value[rangeSel.range.value.start] ?? 0) : 0);
    logRemote('setup:complete', resumed ? { resumed: [rangeSel.range.value.start, rangeSel.range.value.end] } : undefined);
    setupRunning = false;
  } catch (e) {
    console.error(e);
    const msg = e?.message || String(e);
    logRemote('setup:error', { msg });
    songTitleDisplay.value = '連線中斷';
    session.setStatus(`初始化失敗：${msg}`, 'status-error');
    retryVisible.value = true;
    setupRunning = false;
  }
}

function onRetry() {
  showMessage('', '');
  init();
}

// ---------- 播放控制列的導覽鍵：所有移動後都要把「目前作用中的端點」一起帶著走 ----------
function onJumpTime(seconds) {
  engine.jumpByTime(seconds);
  rangeSel.syncActiveEndpointToPlayhead();
}
function onStepNote(dir) {
  engine.jumpToAdjacentNote(dir);
  rangeSel.syncActiveEndpointToPlayhead();
}
function onStepComma(dir) {
  engine.seekComma(engine.currentCommaIndex() + dir);
  rangeSel.syncActiveEndpointToPlayhead();
}

// ---------- 設定浮層：fixed 定位，開啟時對齊到齒輪按鈕正下方 ----------
function positionSettingsPanel() {
  const btn = headerRef.value?.toggleButton;
  const panel = settingsPanelRef.value?.panelRoot;
  if (!btn || !panel) return;
  const r = btn.getBoundingClientRect();
  const w = panel.offsetWidth;
  settingsPositionStyle.value = {
    top: `${r.bottom + 6}px`,
    left: `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`,
  };
}
async function toggleSettings(event) {
  event?.stopPropagation();
  settingsOpen.value = !settingsOpen.value;
  if (settingsOpen.value) {
    await nextTick(); // 等 Vue 真的把 v-show 的 display 套用到 DOM 後才量得到寬度
    positionSettingsPanel();
    sfx.unlockAudio(); // 使用者手勢，順便解鎖 AudioContext
  }
}
function closeSettings() {
  settingsOpen.value = false;
}
function onSettingsResize() {
  if (settingsOpen.value) positionSettingsPanel();
}

function onSetHs(v) {
  engine.setHs(v);
}

// ---------- 匯出：先跳確認彈窗，看過實際會送出的內容再真的送出 ----------
function openConfirmModal() {
  const commaSpan = rangeSel.range.value.end - rangeSel.range.value.start + 1;
  if (commaSpan <= 0) {
    showMessage('⚠️ 選取範圍為空區間，請重新選取。', 'error');
    return;
  }
  const preview = rangeSel.buildExportPreview();
  confirmMeta.value = preview.meta;
  confirmText.value = preview.text;
  confirmOpen.value = true;
}
function closeConfirmModal() {
  confirmOpen.value = false;
}
function onConfirmSend() {
  closeConfirmModal();
  doExport();
}

async function doExport() {
  inputsEnabled.value = false;
  showMessage('🎬 正在向 Bot 發送渲染請求，請稍候…', 'info');
  const dur = rangeSel.rangeDuration.value;
  try {
    const res = await session.submitRender({
      simai: chart.chartText.value,
      startComma: rangeSel.range.value.start,
      endComma: rangeSel.range.value.end,
      chartName: songTitleDisplay.value,
      cleanCut: rangeSel.cleanCut.value,
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      const truncNote = dur > MAX_RENDER_SEC ? `（僅渲染前 ${MAX_RENDER_SEC} 秒）` : '';
      showMessage(`✅ 請求成功${truncNote}！正在關閉視窗並在頻道中開始渲染…`, 'success');
      setTimeout(() => session.closeActivity(), 800);
      return; // 送出成功後保持 disabled，等待視窗關閉，不重新啟用按鈕
    }
    showMessage(`❌ 渲染失敗：${data.error || res.statusText}`, 'error');
  } catch (e) {
    console.error('Export request failed:', e);
    showMessage(`❌ 網路錯誤，無法傳送請求：${e.message}`, 'error');
  }
  inputsEnabled.value = true; // 只有失敗的情況才重新啟用 UI
}

// ---------- 鍵盤方向鍵：碰過端點就微調端點，否則微調播放進度 ----------
function onKeyDown(e) {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  if (!chart.DATA.value || !inputsEnabled.value) return;
  const dir = e.key === 'ArrowLeft' ? -1 : 1;
  if (!rangeSel.activeEndpoint.value) {
    e.preventDefault();
    if (e.altKey) {
      // Alt + 方向鍵：微調 0.01s (10ms)
      const current = engine.realTime.value;
      engine.seek(Math.max(0, Math.round((current + dir * 0.01) * 1000) / 1000));
    } else if (e.ctrlKey || e.metaKey) {
      // Ctrl/Cmd + 方向鍵：微調 0.1s (100ms)
      const current = engine.realTime.value;
      engine.seek(Math.max(0, Math.round((current + dir * 0.1) * 1000) / 1000));
    } else if (e.shiftKey) {
      engine.jumpByTime(dir * 3);
    } else {
      engine.seekComma(engine.currentCommaIndex() + dir);
    }
    return;
  }
  e.preventDefault();
  rangeSel.moveActiveEndpoint(dir, e.shiftKey);
}

onMounted(() => {
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('click', closeSettings);
  window.addEventListener('resize', onSettingsResize);
  init();
});
onUnmounted(() => {
  document.removeEventListener('keydown', onKeyDown);
  document.removeEventListener('click', closeSettings);
  window.removeEventListener('resize', onSettingsResize);
});
</script>

<template>
  <div class="container">
    <HeaderStatus
      ref="headerRef"
      :song-title="songTitleDisplay"
      :status-text="session.statusText.value"
      :status-class="session.statusClass.value"
      :meta-line="metaLine"
      :show-retry="retryVisible"
      :settings-disabled="!inputsEnabled"
      :chart-list="chartList"
      :current-chart="currentChartId"
      @toggle-settings="toggleSettings"
      @retry="onRetry"
      @select-chart="onSelectChart"
    />

    <SettingsPanel
      ref="settingsPanelRef"
      :open="settingsOpen"
      :position-style="settingsPositionStyle"
      :speed="engine.speed.value"
      :hs="engine.hs.value"
      :sfx-volume="sfx.sfxVolume.value"
      :sfx-mode-label="sfx.sfxModeLabel.value"
      :sfx-off="sfx.sfxMode.value === 'off'"
      :clean-cut="rangeSel.cleanCut.value"
      :disabled="!inputsEnabled"
      @update:speed="engine.setSpeed"
      @update:hs="onSetHs"
      @update:sfx-volume="sfx.setSfxVolume"
      @cycle-sfx-mode="sfx.cycleSfxMode"
      @toggle-clean-cut="rangeSel.cleanCut.value = !rangeSel.cleanCut.value"
    />

    <div class="main-content">
      <div class="left-panel">
        <div id="hud">
          <span>BPM <b>{{ hudBpm }}</b></span>
          <span>小節 <b>{{ engine.hudMeasure.value }}</b> / <span>{{ hudMeasureMax }}</span></span>
          <span>Combo <b>{{ engine.hudCombo.value }}</b> / <span>{{ hudComboMax }}</span></span>
        </div>

        <div class="player-row">
          <PlayerControls
            side="left" :playing="engine.playing.value" :disabled="!inputsEnabled"
            @jump-time="onJumpTime" @step-note="onStepNote" @step-comma="onStepComma"
            @toggle-play="engine.togglePlay()"
          />
          <ChartCanvas :attach="engine.attachCanvas" :detach="engine.detachCanvas" />
          <PlayerControls
            side="right" :playing="engine.playing.value" :disabled="!inputsEnabled"
            @jump-time="onJumpTime" @step-note="onStepNote" @step-comma="onStepComma"
            @toggle-play="engine.togglePlay()"
          />
        </div>
      </div>

      <div class="right-panel">
        <Timeline :chart="chart" :engine="engine" :range-sel="rangeSel" :disabled="!inputsEnabled" @export="openConfirmModal" @preview="previewOpen = true" />
        <ColorLegend />
        <FooterMessage :text="message.text" :type="message.type" />
      </div>
    </div>
  </div>

  <ConfirmModal :open="confirmOpen" :meta="confirmMeta" :preview-text="confirmText" @confirm="onConfirmSend" @cancel="closeConfirmModal" />
  <PreviewModal :open="previewOpen" :chart="chart" :range-sel="rangeSel" @close="previewOpen = false" />
</template>

```

# app/src/components/ChartCanvas.vue

```vue
<script setup>
import { ref, onMounted, onUnmounted } from 'vue';

const props = defineProps({
  attach: { type: Function, required: true },
  detach: { type: Function, required: true },
  // 預覽彈窗會另外掛一份獨立的 canvas，不能沿用 id="stage"/"chartCanvas"
  // （同一頁面不能有兩個一樣的 id），所以開放自訂
  stageId: { type: String, default: 'stage' },
  canvasId: { type: String, default: 'chartCanvas' },
});

const canvasEl = ref(null);

// template ref 拿到真正的 <canvas> DOM 節點後直接交給命令式的引擎程式碼——
// 畫布繪製迴圈永遠不要被 Vue 的響應式系統碰到，onMounted 是唯一需要跟 DOM 打交道的地方
onMounted(() => props.attach(canvasEl.value));
onUnmounted(() => props.detach());
</script>

<template>
  <div :id="stageId">
    <canvas ref="canvasEl" :id="canvasId"></canvas>
  </div>
</template>

```

# app/src/components/ColorLegend.vue

```vue
<template>
  <div id="legend">
    <span><i style="background:var(--tap)"></i>TAP</span>
    <span><i style="background:var(--hold)"></i>HOLD</span>
    <span><i style="background:var(--slide)"></i>SLIDE</span>
    <span><i style="background:var(--touch)"></i>TOUCH</span>
    <span><i style="background:var(--brk)"></i>BREAK</span>
  </div>
</template>

```

# app/src/components/ConfirmModal.vue

```vue
<script setup>
defineProps({
  open: { type: Boolean, required: true },
  meta: { type: String, default: '' },
  previewText: { type: String, default: '' },
});
const emit = defineEmits(['confirm', 'cancel']);
</script>

<template>
  <div v-if="open" class="modal-overlay" @click="$event.target === $event.currentTarget && emit('cancel')">
    <div class="modal-box">
      <h3>確認送出內容</h3>
      <p class="modal-meta">{{ meta }}</p>
      <pre class="modal-simai-text">{{ previewText }}</pre>
      <div class="modal-actions">
        <button class="btn-modal-cancel" @click="emit('cancel')">取消</button>
        <button class="btn-export" @click="emit('confirm')">✅ 確認送出</button>
      </div>
    </div>
  </div>
</template>

```

# app/src/components/FooterMessage.vue

```vue
<script setup>
defineProps({
  text: { type: String, default: '' },
  type: { type: String, default: '' },
});
</script>

<template>
  <footer class="app-footer">
    <p class="message" :class="type">{{ text }}</p>
  </footer>
</template>

```

# app/src/components/HeaderStatus.vue

```vue
<script setup>
import { ref } from 'vue';

defineProps({
  songTitle: { type: String, required: true },
  statusText: { type: String, required: true },
  statusClass: { type: String, required: true },
  metaLine: { type: String, default: '' },
  showRetry: { type: Boolean, default: false },
  settingsDisabled: { type: Boolean, default: true },
  chartList: { type: Array, default: () => [] },
  currentChart: { type: String, default: '' },
});
defineEmits(['retry', 'toggle-settings', 'select-chart']);

const toggleButton = ref(null);
defineExpose({ toggleButton });
</script>

<template>
  <header>
    <div id="settingsMenu">
      <button
        ref="toggleButton"
        class="btn-settings"
        title="倍速／流速／音量"
        :disabled="settingsDisabled"
        @click="$emit('toggle-settings', $event)"
      >⚙</button>
    </div>
    <div class="header-title-row">
      <h1>{{ songTitle }}</h1>
      <select
        class="chart-select-dropdown"
        :value="currentChart"
        :disabled="settingsDisabled"
        title="切換 testChart 測試譜面"
        @change="$emit('select-chart', $event.target.value)"
      >
        <option v-for="c in (chartList && chartList.length ? chartList : [{ id: 'チューリングの跡_master.simai', name: 'チューリングの跡_master' }, { id: '渦状銀河のシンフォニエッタ.simai', name: '渦状銀河のシンフォニエッタ' }])" :key="c.id" :value="c.id">
          🎵 {{ c.name }}
        </option>
      </select>
    </div>
    <div :class="statusClass">{{ statusText }}</div>
    <button v-if="showRetry" class="btn-retry" @click="$emit('retry')">🔄 重新連線</button>
    <div class="sub">{{ metaLine }}</div>
  </header>
</template>

```

# app/src/components/PlayerControls.vue

```vue
<script setup>
defineProps({
  side: { type: String, required: true }, // 'left' | 'right'
  playing: { type: Boolean, required: true },
  disabled: { type: Boolean, default: true },
});
const emit = defineEmits(['jump-time', 'step-note', 'step-comma', 'toggle-play']);
</script>

<template>
  <div class="nav-col">
    <template v-if="side === 'left'">
      <button title="後退約3秒" :disabled="disabled" @click="emit('jump-time', -3)">＜＜＜</button>
      <button title="跳到上一顆音符" :disabled="disabled" @click="emit('step-note', -1)">＜＜</button>
      <button title="後退 1 個逗號" :disabled="disabled" @click="emit('step-comma', -1)">＜</button>
    </template>
    <template v-else>
      <button title="前進約3秒" :disabled="disabled" @click="emit('jump-time', 3)">＞＞＞</button>
      <button title="跳到下一顆音符" :disabled="disabled" @click="emit('step-note', 1)">＞＞</button>
      <button title="前進 1 個逗號" :disabled="disabled" @click="emit('step-comma', 1)">＞</button>
    </template>
    <button class="btn-play" :disabled="disabled" @click="emit('toggle-play')">{{ playing ? '⏸' : '▶' }}</button>
  </div>
</template>

```

# app/src/components/PreviewModal.vue

```vue
<script setup>
import { ref, watch, onUnmounted } from 'vue';
import ChartCanvas from './ChartCanvas.vue';
import { useChartData } from '../composables/useChartData.js';
import { usePlayerEngine } from '../composables/usePlayerEngine.js';

const props = defineProps({
  open: { type: Boolean, required: true },
  chart: { type: Object, required: true },
  rangeSel: { type: Object, required: true },
});
const emit = defineEmits(['close']);

// 獨立的譜面資料與播放引擎
const previewChart = useChartData();
const previewEngine = usePlayerEngine(previewChart);
const errorMsg = ref('');

// cleanCut: false 模式下的時間微調（預設提早開始 0.10s / 延後結束 0.10s，範圍 0s ~ 1.0s）
const startOffset = ref(0.10);
const endOffset = ref(0.10);
const autoLoop = ref(true); // 自動循環播放

let readyResolve;
const readyPromise = new Promise((resolve) => { readyResolve = resolve; });

async function attachAndInit(canvasEl) {
  previewEngine.attachCanvas(canvasEl);
  await previewEngine.loadAssets();
  previewEngine.initEngine();
  readyResolve();
}

function detach() {
  previewEngine.detachCanvas();
}

function start() {
  errorMsg.value = '';
  try {
    if (props.rangeSel.cleanCut.value) {
      // 方法一：切的乾淨——把實際會送出去的那段內容當成一份全新的獨立譜面，從頭播到尾
      const preview = props.rangeSel.buildExportPreview();
      if (!preview.text || preview.text.startsWith('（')) {
        throw new Error('這段沒有可預覽的內容');
      }
      previewChart.loadFromText(preview.text, '切的乾淨預覽');
      const endTime = previewChart.DATA.value?.meta.endTime ?? 0;
      previewEngine.resetPlaybackState();
      previewEngine.seek(0);
      previewEngine.setPreviewBounds(0, endTime, autoLoop.value);
    } else {
      // 方法二：原始譜面片段（秒數剪輯）——支援提早開始與延後結束 (0 ~ 1.0 秒)
      previewChart.adoptFrom(props.chart);
      const { start: rawS, end: rawE } = props.rangeSel.rangeTimeSpan();
      const s = Math.max(0, rawS - Number(startOffset.value));
      const e = Math.min(props.chart.DATA.value?.meta.endTime ?? rawE, rawE + Number(endOffset.value));
      previewEngine.resetPlaybackState();
      previewEngine.seek(s);
      previewEngine.setPreviewBounds(s, e, autoLoop.value);
    }
    previewEngine.play();
  } catch (e) {
    errorMsg.value = e?.message || String(e);
  }
}

watch([() => props.open, startOffset, endOffset, autoLoop], async ([isOpen]) => {
  if (!isOpen) {
    previewEngine.pause();
    return;
  }
  await readyPromise; // 第一次開啟要等 canvas 掛載＋素材載入完成
  start();
});

onUnmounted(detach);
</script>

<template>
  <div v-show="open" class="modal-overlay" @click="$event.target === $event.currentTarget && emit('close')">
    <div class="modal-box preview-modal-box">
      <h3>{{ rangeSel.cleanCut.value ? '預覽（切的乾淨）' : '預覽（原始譜面片段）' }}</h3>

      <div class="preview-stage">
        <ChartCanvas :attach="attachAndInit" :detach="detach" stage-id="previewStage" canvas-id="previewCanvas" />
      </div>

      <!-- cleanCut: false 時允許調整提早開始 / 延後結束 (最多 1 秒) -->
      <div v-if="!rangeSel.cleanCut.value" class="preview-offset-panel">
        <div class="offset-field">
          <label>⏱️ 提早開始 (0s~1s): <strong>-{{ startOffset.toFixed(2) }}s</strong></label>
          <input type="range" min="0" max="1" step="0.05" v-model.number="startOffset" />
        </div>
        <div class="offset-field">
          <label>⏱️ 延後結束 (0s~1s): <strong>+{{ endOffset.toFixed(2) }}s</strong></label>
          <input type="range" min="0" max="1" step="0.05" v-model.number="endOffset" />
        </div>
      </div>

      <div class="preview-footer-options">
        <label class="auto-loop-toggle">
          <input type="checkbox" v-model="autoLoop" />
          <span>🔁 自動循環播放</span>
        </label>
      </div>

      <p v-if="errorMsg" class="message error">{{ errorMsg }}</p>

      <div class="modal-actions">
        <button class="btn-modal-cancel" @click="emit('close')">關閉</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.preview-offset-panel {
  display: flex;
  gap: 12px;
  background: rgba(255, 255, 255, 0.05);
  border-radius: 8px;
  padding: 10px 14px;
  margin-top: 10px;
}
.offset-field {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.offset-field label {
  font-size: 0.78rem;
  color: #a0aec0;
}
.offset-field strong {
  color: #38bdf8;
}
.offset-field input[type="range"] {
  width: 100%;
  accent-color: #38bdf8;
}
.preview-footer-options {
  display: flex;
  justify-content: flex-end;
  margin-top: 8px;
}
.auto-loop-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 0.82rem;
  color: #e2e8f0;
  cursor: pointer;
  user-select: none;
}
.auto-loop-toggle input[type="checkbox"] {
  accent-color: #38bdf8;
  width: 16px;
  height: 16px;
  cursor: pointer;
}
</style>

```

# app/src/components/RangeSelector.vue

```vue
<script setup>
const props = defineProps({
  chart: { type: Object, required: true },
  engine: { type: Object, required: true },
  rangeSel: { type: Object, required: true },
  disabled: { type: Boolean, default: true },
});
const emit = defineEmits(['export', 'preview']);

let lastTapA = 0;
let lastTapB = 0;

// 雙點：播放頭直接定位到該端點目前的位置。手機上的 dblclick 不可靠，自己用 pointerdown 判定
function onTrackPointerDown(which) {
  if (props.disabled) return;
  props.rangeSel.setActiveEndpoint(which);
  const now = performance.now();
  const value = which === 'a' ? props.rangeSel.rangeAValue.value : props.rangeSel.rangeBValue.value;
  const last = which === 'a' ? lastTapA : lastTapB;
  if (now - last < 350) {
    props.engine.seek(props.chart.C.value[value] ?? 0);
    if (which === 'a') lastTapA = 0; else lastTapB = 0;
    return;
  }
  if (which === 'a') lastTapA = now; else lastTapB = now;
}
</script>

<template>
  <div id="rangePanel">
    <div id="rangeHeader">
      <span class="range-title">✂️ 選取並傳送</span>
      <span id="rangeLabel" :class="{ 'over-limit': rangeSel.rangeOverLimit.value }">{{ rangeSel.rangeLabel.value }}</span>
    </div>

    <div class="range-row">
      <span class="range-row-label">起</span>
      <div class="range-track" :class="{ 'over-limit': rangeSel.rangeOverLimit.value }" @pointerdown="onTrackPointerDown('a')">
        <div class="range-track-bg"></div>
        <input
          type="range" min="0" :max="rangeSel.maxComma.value" step="1"
          :value="rangeSel.rangeAValue.value" :disabled="disabled"
          :class="{ active: rangeSel.activeEndpoint.value === 'a' }"
          @input="rangeSel.onRangeInput('a', +$event.target.value)"
        >
        <div class="range-tip" :style="{ left: (rangeSel.rangeAValue.value / (rangeSel.maxComma.value || 1)) * 100 + '%' }">
          {{ rangeSel.commaLabel(rangeSel.rangeAValue.value) }}
        </div>
      </div>
    </div>

    <div class="range-row">
      <span class="range-row-label">終</span>
      <div class="range-track" :class="{ 'over-limit': rangeSel.rangeOverLimit.value }" @pointerdown="onTrackPointerDown('b')">
        <div class="range-track-bg"></div>
        <input
          type="range" min="0" :max="rangeSel.maxComma.value" step="1"
          :value="rangeSel.rangeBValue.value" :disabled="disabled"
          :class="{ active: rangeSel.activeEndpoint.value === 'b' }"
          @input="rangeSel.onRangeInput('b', +$event.target.value)"
        >
        <div class="range-tip" :style="{ left: (rangeSel.rangeBValue.value / (rangeSel.maxComma.value || 1)) * 100 + '%' }">
          {{ rangeSel.commaLabel(rangeSel.rangeBValue.value) }}
        </div>
      </div>
    </div>

    <div id="rangeEnds">
      <button :disabled="disabled" @click="rangeSel.setStart()">← 起點</button>
      <button :disabled="disabled" @click="rangeSel.setEnd()">終點 →</button>
    </div>

    <div id="rangeActions">
      <button :disabled="disabled" @click="rangeSel.goStart()">跳到起點</button>
      <button :disabled="disabled" @click="emit('preview')">▶ 預覽</button>
    </div>
    <button class="btn-export" :disabled="disabled" @click="emit('export')">✅ 傳送此區間</button>
  </div>
</template>

```

# app/src/components/SettingsPanel.vue

```vue
<script setup>
import { ref } from 'vue';

const props = defineProps({
  open: { type: Boolean, required: true },
  positionStyle: { type: Object, default: () => ({}) },
  speed: { type: Number, required: true },
  hs: { type: Number, required: true },
  sfxVolume: { type: Number, required: true },
  sfxModeLabel: { type: String, required: true },
  sfxOff: { type: Boolean, default: false },
  cleanCut: { type: Boolean, required: true },
  disabled: { type: Boolean, default: false },
});
const emit = defineEmits(['update:speed', 'update:hs', 'update:sfx-volume', 'cycle-sfx-mode', 'toggle-clean-cut']);

const panelRoot = ref(null);
defineExpose({ panelRoot });
</script>

<template>
  <div
    v-show="open"
    ref="panelRoot"
    id="settingsPanel"
    class="control-settings"
    :class="{ 'sfx-off': sfxOff }"
    :style="positionStyle"
    @click.stop
  >
    <span class="speedbox">倍速
      <input type="range" min="0.25" max="1" step="0.05" :value="speed" :disabled="disabled"
        @input="emit('update:speed', +$event.target.value)">
      <span id="speedVal">{{ speed.toFixed(2) }}×</span>
    </span>
    <span class="speedbox">流速
      <input type="range" min="1" max="10" step="0.5" :value="hs" :disabled="disabled"
        @input="emit('update:hs', +$event.target.value)">
      <span id="hsVal">{{ hs.toFixed(1) }}</span>
    </span>
    <span class="speedbox">
      <button class="btn-sfx-mode" title="切換音效模式" @click="emit('cycle-sfx-mode')">{{ sfxModeLabel }}</button>
      <input id="sfxSlider" type="range" min="0" max="1" step="0.05" :value="sfxVolume"
        @input="emit('update:sfx-volume', +$event.target.value)">
      <span id="sfxVal">{{ Math.round(sfxVolume * 100) }}%</span>
    </span>
    <span class="speedbox">
      <button class="btn-sfx-mode"
        title="開：精準切在選取的 combo 上，結尾不多留（就算切斷 hold／slide）。關：結尾多留一點讓判定特效收完。"
        @click="emit('toggle-clean-cut')"
      >✂ 切的乾淨：{{ cleanCut ? '開' : '關' }}</button>
    </span>
  </div>
</template>

```

# app/src/components/Timeline.vue

```vue
<script setup>
import { ref, watch, onMounted, onUnmounted } from 'vue';
import RangeSelector from './RangeSelector.vue';

const props = defineProps({
  chart: { type: Object, required: true },
  engine: { type: Object, required: true },
  rangeSel: { type: Object, required: true },
  disabled: { type: Boolean, default: true },
});
defineEmits(['export', 'preview']);

const densityWrapEl = ref(null);
const densityCanvasEl = ref(null);
const measureSliderEl = ref(null);
const measureSliderDisplay = ref(0);
let densityResizeObserver = null;

// 沒有在拖曳時，滑桿顯示值跟著播放頭走；拖曳中則交給使用者的手，
// 不然 rAF 每幀都把 realTime 寫回去會讓正在拖的滑塊跳來跳去
watch(props.engine.hudMeasureFloat, (mf) => {
  if (!props.engine.dragging.value) measureSliderDisplay.value = mf;
});

function onSliderPointerDown() {
  props.engine.setDragging(true);
  props.rangeSel.setActiveEndpoint(null);
}
function onSliderPointerUp() {
  props.engine.setDragging(false);
}
function onSliderInput(e) {
  const v = +e.target.value;
  measureSliderDisplay.value = v;
  props.rangeSel.setActiveEndpoint(null);
  props.engine.seek(props.engine.measureTime(v));
}

function seekDelta(delta) {
  const current = props.engine.realTime.value;
  const target = Math.max(0, Math.round((current + delta) * 1000) / 1000);
  props.engine.seek(target);
}

function onDebugInputChange(e) {
  const val = parseFloat(e.target.value);
  if (!isNaN(val)) {
    props.engine.seek(Math.max(0, val));
  }
}

function onDensityPointerDown(e) {
  props.engine.setDragging(true);
  props.rangeSel.setActiveEndpoint(null);
  props.rangeSel.densitySeek(e.clientX, densityWrapEl.value);
}
function onDensityPointerMove(e) {
  if (props.engine.dragging.value) props.rangeSel.densitySeek(e.clientX, densityWrapEl.value);
}

onMounted(() => {
  props.rangeSel.setDensityCanvas(densityCanvasEl.value);
  window.addEventListener('pointerup', onSliderPointerUp);
  if (window.ResizeObserver) {
    densityResizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(() => props.rangeSel.drawDensity(props.engine.hudMeasure.value));
    });
    densityResizeObserver.observe(densityWrapEl.value);
  } else {
    props.rangeSel.drawDensity(props.engine.hudMeasure.value);
  }
});
onUnmounted(() => {
  window.removeEventListener('pointerup', onSliderPointerUp);
  densityResizeObserver?.disconnect();
});
</script>

<template>
  <div id="timeline">
    <div id="densityWrap" ref="densityWrapEl" @pointerdown="onDensityPointerDown" @pointermove="onDensityPointerMove">
      <canvas ref="densityCanvasEl" id="densityCanvas"></canvas>
    </div>
    <div id="timeLabels"></div>
    <input
      ref="measureSliderEl"
      type="range"
      id="measureSlider"
      min="0"
      :max="chart.M.value.length - 1"
      step="0.005"
      :value="measureSliderDisplay"
      :disabled="disabled"
      :class="{ active: rangeSel.activeEndpoint.value === null }"
      @pointerdown="onSliderPointerDown"
      @input="onSliderInput"
    >
    <div id="measureTicks"></div>

    <RangeSelector :chart="chart" :engine="engine" :range-sel="rangeSel" :disabled="disabled" @export="$emit('export')" @preview="$emit('preview')" />
  </div>
</template>

```

# app/src/composables/useChartData.js

```js
import { ref, shallowRef } from 'vue';
import { simaiDecode } from '../../../../engine/Scripts/decode.js';
import { splitCommaParts } from '../../../../engine/Scripts/simaiCut.js';

function processChartData(decoded) {
  const bpm = decoded.bpm || 60;
  const firstBpm = decoded.tags.find(t => t.type === 'bpm')?.value || bpm;
  const measureDuration = 240 / firstBpm;
  const endTime = decoded.endTime || 0;

  const M_arr = [];
  const offset = measureDuration; // maimai 譜面第一小節為偏置 (1 measure)
  for (let t = offset; t <= endTime + measureDuration; t += measureDuration) {
    M_arr.push(t);
  }
  if (M_arr.length === 0) M_arr.push(offset);

  const D_arr = Array.from({ length: M_arr.length }, () => ({
    tap: 0, hold: 0, slide: 0, touch: 0, brk: 0,
  }));

  for (const n of decoded.notes) {
    let idx = 0;
    for (let i = 0; i < M_arr.length; i++) {
      if (n.time >= M_arr[i]) idx = i; else break;
    }
    if (n.isBreak) D_arr[idx].brk++;
    else if (n.type === 'tap') D_arr[idx].tap++;
    else if (n.type === 'hold') D_arr[idx].hold++;
    else if (n.type === 'slide') D_arr[idx].slide++;
    else if (n.type === 'touch') D_arr[idx].touch++;
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
      endTime,
    },
    measures: M_arr,
    density: D_arr,
    notes: decoded.notes,
    tags: decoded.tags,
    indexToTime: decoded.indexToTime || [],
  };
}

/** 譜面資料的家：載入、解碼、前處理，全部包在一個 composable 裡 */
export function useChartData() {
  const chartText = ref('');
  const chartName = ref('');
  // 這些是大型解析結果，整包替換而非逐欄位改動，用 shallowRef 避免 Vue 把內部每個元素都包成代理
  const DATA = shallowRef(null);
  const M = shallowRef([]);
  const N = shallowRef([]);
  const D = shallowRef([]);
  const C = shallowRef([]);
  const commaParts = shallowRef([]);

  function decodeAndPopulate(text, name) {
    chartText.value = text;
    chartName.value = name ?? '';

    const decoded = simaiDecode(text, true);
    if (decoded.failed) throw new Error('譜面解析失敗：請檢查語法');

    const processed = processChartData(decoded);
    DATA.value = processed;
    M.value = processed.measures;
    N.value = processed.notes;
    D.value = processed.density;
    C.value = processed.indexToTime;
    commaParts.value = splitCommaParts(text);

    return processed;
  }

  async function loadChart(fetchPath) {
    const res = await fetch(fetchPath);
    if (!res.ok) throw new Error(`譜面獲取失敗：${res.status}`);
    const json = await res.json();
    const chart = (json && json.ok !== undefined) ? (json.data || {}) : json;
    return decodeAndPopulate(chart.text, chart.name);
  }

  /** 不透過 fetch，直接把一段 simai 原文解碼成獨立的一份譜面資料（給預覽用的片段） */
  function loadFromText(text, name) {
    return decodeAndPopulate(text, name);
  }

  /** 直接借用另一份已經解碼好的資料（不重新解碼），給「沿用主譜面」的預覽情境用 */
  function adoptFrom(other) {
    chartText.value = other.chartText.value;
    chartName.value = other.chartName.value;
    DATA.value = other.DATA.value;
    M.value = other.M.value;
    N.value = other.N.value;
    D.value = other.D.value;
    C.value = other.C.value;
    commaParts.value = other.commaParts.value;
  }

  return { chartText, chartName, DATA, M, N, D, C, commaParts, loadChart, loadFromText, adoptFrom };
}

```

# app/src/composables/useDebugLogging.js

```js
import { ref } from 'vue';

// 模組層級的 ref：任何 import 這個模組的地方拿到的是同一份，
// 這是 Vue 裡最簡單的「全域狀態」寫法——不需要 Pinia，一個在函式外面宣告的 ref 就是單例。
export const fatalError = ref(null);

/**
 * 除錯用：手機上的 Discord App 內建 WebView 不開放 Safari 遠端除錯，看不到 console，
 * 所以改用 sendBeacon 把生命週期關鍵事件回報到後端（印在 bot 的終端機），
 * 用來排查 Activity 被關閉前最後執行到哪一步。sendBeacon 專門設計成連頁面正在被卸載時
 * 也能盡量送出，失敗也不影響主流程。
 */
export function logRemote(event, data) {
  try {
    const payload = JSON.stringify({ event, data, ts: new Date().toISOString(), ua: navigator.userAgent });
    navigator.sendBeacon('/.proxy/api/debug-log', new Blob([payload], { type: 'application/json' }));
  } catch (e) {
    // 忽略：僅為除錯用途
  }
}

/** 註冊一次即可；main.js 在 createApp().mount() 之前呼叫，不放進元件內部避免重複掛載時重複註冊 */
export function setupDebugLogging() {
  logRemote('script:loaded', { persisted: false });

  // 手機瀏覽器（尤其 iOS）常會用 bfcache 把「關閉」的分頁凍結保留，下次「重新打開」時
  // 直接復原舊分頁而非真正重新載入頁面 —— 這會讓 DiscordSDK 沿用第一次連線時的舊內部狀態，
  // 導致第二次進入時被 Discord 判定 session 已失效而直接踢出。偵測到復原就強制整頁重載，
  // 確保每次打開 Activity 都會建立全新的 DiscordSDK 連線。
  window.addEventListener('pageshow', (event) => {
    logRemote('pageshow', { persisted: event.persisted });
    if (event.persisted) window.location.reload();
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

  // 全域錯誤監聽：只顯示自己程式碼的錯誤（過濾第三方 SDK 內部錯誤），但不論來源都回報除錯 log
  window.onerror = function (message, source, lineno, colno) {
    logRemote('window.onerror', { message, source, lineno, colno });
    if (source && !source.includes('main.js') && !source.includes('localhost')) return true;
    fatalError.value = `JS 錯誤：${message} (L${lineno})`;
  };

  window.onunhandledrejection = function (event) {
    const msg = event.reason?.message || String(event.reason);
    logRemote('unhandledrejection', { msg });
    fatalError.value = `未處理的 Rejection：${msg}`;
  };
}

```

# app/src/composables/useDiscordSession.js

```js
import { ref } from 'vue';
import { DiscordSDK } from '@discord/embedded-app-sdk';
import { logRemote } from './useDebugLogging.js';
import { apiClient } from '../services/apiClient.js';

function isEmbeddedInDiscord() {
  return window.self !== window.top;
}

/**
 * Discord 連線與身分驗證。開發模式（`vite dev`）且不是真的嵌在 Discord 裡時，
 * 走「本機預覽模式」：跳過整套 authorize/authenticate，用假身分直接打不需要驗證的
 * /api/chart。import.meta.env.DEV 在 `vite build` 產出的正式版一律是 false，
 * 這條分支完全不會進到給 Discord 用的正式版本裡。
 */
export function useDiscordSession() {
  const standalone = import.meta.env.DEV && !isEmbeddedInDiscord();

  const statusText = ref('正在初始化 SDK…');
  const statusClass = ref('status-connecting');
  const auth = ref(null);
  const discordSdk = ref(null);

  const params = new URLSearchParams(window.location.search);
  const clientId = params.get('client_id') || '1527644569133649960';

  function setStatus(text, cls) {
    statusText.value = text;
    statusClass.value = cls;
  }

  async function connectStandalone() {
    setStatus('本機預覽模式（未連接 Discord）', 'status-ready');
    auth.value = { user: { id: 'dev', username: 'dev', global_name: 'Dev' } };
    return { fetchChartPath: '/api/chart' };
  }

  async function connectReal() {
    logRemote('setup:start');
    setStatus('連線中：正在初始化 SDK…', 'status-connecting');
    const sdk = new DiscordSDK(clientId, { disableConsoleLogOverride: true });
    discordSdk.value = sdk;

    if (sdk.platform === 'mobile') {
      document.documentElement.classList.add('platform-mobile');
    }

    await sdk.ready();
    logRemote('setup:sdk_ready');

    setStatus('連線中：正在向用戶端申請授權…', 'status-connecting');
    const { code } = await sdk.commands.authorize({
      client_id: clientId,
      response_type: 'code',
      state: '',
      prompt: 'none',
      scope: ['identify'],
    });
    logRemote('setup:authorized');

    setStatus('連線中：正在與本地後端交換 Token…', 'status-connecting');
    const res = await fetch('/.proxy/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    if (!res.ok) throw new Error(`token 交換失敗：${res.status}`);
    const { access_token } = await res.json();
    logRemote('setup:token_exchanged');

    setStatus('連線中：正在進行用戶身份驗證…', 'status-connecting');
    auth.value = await sdk.commands.authenticate({ access_token });
    logRemote('setup:authenticated', { username: auth.value.user.username });

    return { fetchChartPath: '/.proxy/api/chart' };
  }

  function connect() {
    return standalone ? connectStandalone() : connectReal();
  }

  /**
   * 從後端取回「繼續看譜」要還原的區間（由 bot 端在按鈕被按下時暫存）。
   * 取得後套用到兩個 range 滑桿；沒有就維持預設全選。
   */
  async function fetchResumeSession(maxComma) {
    if (standalone) return null;
    try {
      const s = await apiClient.getResumeSession(auth.value.user.id);
      if (typeof s.startComma !== 'number' || typeof s.endComma !== 'number') return null;
      const start = Math.max(0, Math.min(s.startComma, maxComma));
      const end = Math.max(start, Math.min(s.endComma, maxComma));
      return { start, end };
    } catch (e) {
      console.warn('[Resume] 還原續看位置失敗:', e);
      return null;
    }
  }

  async function submitRender(payload) {
    return apiClient.submitRender({
      channelId: discordSdk.value?.channelId ?? null,
      userId: auth.value.user.id,
      username: auth.value.user.global_name ?? auth.value.user.username,
      ...payload,
    });
  }

  async function fetchChartList(provider = 'local', query = '') {
    try {
      return await apiClient.getCharts(provider, query);
    } catch (e) {
      console.warn('Failed to fetch chart list:', e);
      return [];
    }
  }

  async function fetchChartData(filename, provider = 'local') {
    return await apiClient.getChartData(filename, provider);
  }

  async function closeActivity() {
    if (standalone || !discordSdk.value) return;
    await Promise.resolve(discordSdk.value.close()).catch(err => console.error('Failed to close activity:', err));
  }

  return {
    standalone, statusText, statusClass, auth,
    connect, fetchResumeSession, submitRender, closeActivity, setStatus,
    fetchChartList, fetchChartData,
  };
}

```

# app/src/composables/usePlayerEngine.js

```js
import { ref, computed } from 'vue';
import { SimaiRenderer } from '../../../../engine/Scripts/renderer.js';
import { loadAllImages, SimaiLogicControler, scaleBase, audioManager } from '../../../../engine/Scripts/helper.js';

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
  // 'hit'（預設）＝音符到判定線被擊打、出光環特效後消失
  // 'through'  ＝tap / hold 不判定，維持原速穿過判定線往外飛，再於 noteEndFadeTime 內淡出
  //              （star／touch／slide 不受影響，一律維持擊打行為）
  // noteEndBehavior: 'hit',
  noteEndBehavior: 'through',
  noteEndFadeTime: 0.3, // 0.3
  noteBaseSize: 11,
  maxSlideCount: 500,
  renderSurroundingAuxiliaryText: true,
  slideIllegalRed: false,
  showUI: false,
  notPlayHoldEnd: false,
  backgroundColor: '#0c0c1e', // 暗色系背景
  sfxVolumes: {},
};

/**
 * 播放引擎：canvas 繪製、rAF 播放迴圈、seek/導覽運算全部在這裡。
 * renderer/logic/images 這些「引擎物件」刻意用一般變數（let），不是 ref/reactive——
 * 它們只被命令式讀寫、從來不直接綁在 template 上，包成響應式只會拖累效能、
 * 甚至可能干擾這些 class 內部自己的狀態管理。真正要給畫面用的（playing/realTime/speed…）才是 ref。
 */
export function usePlayerEngine(chart) {
  const playing = ref(false);
  const realTime = ref(0);
  const speed = ref(1.0);
  const hs = ref(4.0);
  const dragging = ref(false);
  const timeOffset = ref(-0.001); // 預設時間 Offset：-0.001s (-1ms)

  function setTimeOffset(v) {
    timeOffset.value = Math.round(v * 1000) / 1000;
    draw(realTime.value, 0);
  }

  function adjustTimeOffset(delta) {
    timeOffset.value = Math.round((timeOffset.value + delta) * 1000) / 1000;
    draw(realTime.value, 0);
  }

  function resetTimeOffset() {
    timeOffset.value = -0.001;
    draw(realTime.value, 0);
  }

  let renderer = null;
  let logic = null;
  let images = null;
  let outlineImage = null;
  let nowIndexLocal = 0;
  let playScoreRes = { tap: 0, hold: 0, slide: 0, touch: 0, break: 0, score: 0, breakScore: 0, invScore: 0 };
  let previewStart = null;
  let previewStop = null;
  let previewLoop = false;
  let lastTs = 0;
  let size = 320;
  let cv = null;
  let ctx = null;
  let resizeObserver = null;



  function measureIndex(t) {
    const M = chart.M.value;
    if (!M || M.length === 0) return 0;
    let lo = 0, hi = M.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      M[mid] <= t + 1e-6 ? lo = mid : hi = mid - 1;
    }
    return lo;
  }

  function measureIndexFloat(t) {
    const M = chart.M.value;
    if (!M || M.length === 0) return 0;
    const idx = measureIndex(t);
    const t0 = idx === 0 ? 0 : M[idx];
    const t1 = M[idx + 1] ?? (chart.DATA.value?.meta.endTime ?? t0 + 2.0);
    const dt = t1 - t0;
    if (dt <= 0) return idx;
    const frac = Math.max(0, Math.min(1, (t - t0) / dt));
    return idx + frac;
  }

  // measureIndex(t) 的反函式（支援浮點數小節位置）
  function measureTime(idx) {
    if (idx <= 0) return 0;
    const M = chart.M.value;
    if (!M || M.length === 0) return 0;
    const i = Math.floor(idx);
    const frac = idx - i;
    if (i >= M.length - 1) {
      const last = M.length - 1;
      const tLast = M[last];
      const prevDur = last > 0 ? (M[last] - M[last - 1]) : 2.0;
      return tLast + prevDur * frac;
    }
    const t0 = i === 0 ? 0 : M[i];
    const t1 = M[i + 1];
    return t0 + (t1 - t0) * frac;
  }

  // C 最後一格是譜尾 sentinel，不是真正的逗號，搜尋範圍要排除它
  function commaIndexAt(t) {
    const C = chart.C.value;
    let lo = 0, hi = C.length - 2;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      C[mid] <= t + 1e-6 ? lo = mid : hi = mid - 1;
    }
    return lo;
  }

  function currentCommaIndex() {
    return commaIndexAt(realTime.value);
  }

  function currentComboIndex() {
    const N = chart.N.value;
    if (!N || N.length === 0) return 0;
    const idx = N.findIndex(n => n.time >= realTime.value);
    return idx === -1 ? N.length - 1 : idx;
  }

  const hudMeasure = computed(() => measureIndex(realTime.value));
  const hudMeasureFloat = computed(() => measureIndexFloat(realTime.value));
  const hudCombo = computed(() => currentComboIndex());

  function fastForwardNowIndex(targetTime) {
    const N = chart.N.value;
    if (!N || N.length === 0) {
      nowIndexLocal = 0;
      return;
    }
    const idx = N.findIndex(n => n.time >= Math.max(0, targetTime - 2.0));
    nowIndexLocal = idx === -1 ? N.length : idx;
  }

  function seek(t) {
    const endTime = chart.DATA.value?.meta.endTime ?? 0;
    realTime.value = Math.max(0, Math.min(endTime, t));
    // Seek 時清空音效佇列，避免舊音效在新時間點爆出
    audioManager.soundQueue = [];
    audioManager.stopAllScheduledSounds();
    if (realTime.value > 0) {
      fastForwardNowIndex(realTime.value);
    } else {
      nowIndexLocal = 0;
    }
    draw(realTime.value);
  }

  function seekComma(i) {
    const idx = Math.max(0, Math.min(chart.C.value.length - 2, i));
    seek(chart.C.value[idx]);
  }

  // 導覽鈕用：移動一個「大概」的秒數，最後精準吸附到最近的逗號
  function jumpByTime(targetSeconds) {
    const cur = currentCommaIndex();
    let j = commaIndexAt(realTime.value + targetSeconds);
    if (targetSeconds > 0 && j <= cur) j = cur + 1;
    if (targetSeconds < 0 && j >= cur) j = cur - 1;
    seekComma(j);
  }

  // 跳到上一顆／下一顆實際的 note（跳過中間沒有音符的逗號、休止拍）
  function jumpToAdjacentNote(dir) {
    const N = chart.N.value;
    if (!N || N.length === 0) return;
    if (dir > 0) {
      const n = N.find(n => n.time > realTime.value + 1e-6);
      seek(n ? n.time : chart.DATA.value.meta.endTime);
    } else {
      let found = null;
      for (let i = N.length - 1; i >= 0; i--) {
        if (N[i].time < realTime.value - 1e-6) { found = N[i]; break; }
      }
      seek(found ? found.time : 0);
    }
  }

  function resizeCanvas() {
    if (!cv) return;
    // 譜面必須是正方形：取畫布容器可用寬高的較小值
    const stage = cv.parentElement;
    const avail = stage ? Math.min(stage.clientWidth, stage.clientHeight) : 320;
    size = Math.max(100, Math.floor(avail));
    cv.style.width = cv.style.height = size + 'px';
    cv.width = cv.height = size * devicePixelRatio;
    draw(realTime.value, 0);
  }

  function attachCanvas(canvasEl) {
    cv = canvasEl;
    ctx = cv.getContext('2d');
    if (renderer) renderer.setContext(ctx);
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);
    if (window.ResizeObserver) {
      let lastSize = 0;
      resizeObserver = new ResizeObserver(() => {
        const rect = cv.getBoundingClientRect();
        const now = Math.round(Math.min(rect.width, rect.height));
        if (now > 0 && Math.abs(now - lastSize) >= 1) {
          lastSize = now;
          resizeCanvas();
        }
      });
      resizeObserver.observe(cv.parentElement);
    }
  }

  function detachCanvas() {
    window.removeEventListener('resize', resizeCanvas);
    resizeObserver?.disconnect();
  }

  async function loadAssets() {
    images = await loadAllImages();
    try {
      const blob = await (async () => {
        try { return await (await fetch('Skin/outline.png')).blob(); }
        catch { return null; }
      })();
      if (blob) outlineImage = await createImageBitmap(blob);
    } catch (e) {
      console.error('Failed to load outline image:', e);
    }
    await document.fonts.ready;
  }

  function initEngine() {
    if (!cv) throw new Error('canvas 尚未掛載');
    renderer = new SimaiRenderer(cv, defaultSettings);
    renderer.setImages(images);
    renderer.setContext(ctx);
    logic = new SimaiLogicControler();
    resizeCanvas();
  }

  function draw(t, dt = 0) {
    if (!renderer || !logic || !chart.DATA.value) return;
    const DATA = chart.DATA.value;
    const effectiveTime = Math.max(0, t + timeOffset.value);

    const {
      buckets, playCombo, playScore, noteQuantity,
      nowIndex: updatedNowIndex,
    } = logic.get({
      renderer,
      globalTime: effectiveTime,
      realTime: effectiveTime,
      musicDelay: 0,
      playing: playing.value,
      timeControlSliding: dragging.value,
      readyBeat: false,
      playedClock: [],
      settings: defaultSettings,
      visualHeight: 0,
      notes: chart.N.value,
      decodedTags: DATA.tags || [],
      playScoreRes,
      nowIndex: nowIndexLocal,
      // 必須固定傳 false：暫停/拖曳時要靠 logic 內部的 else 分支重設每顆 note 的音效旗標，
      // 傳 !playing 會導致暫停時整段邏輯被跳過、倒帶後重新播放時的音效就再也不會發聲
      skipAudioQueue: false,
    });
    nowIndexLocal = updatedNowIndex;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = defaultSettings.backgroundColor;
    ctx.fillRect(0, 0, cv.width, cv.height);

    const p = size * devicePixelRatio / scaleBase * renderer.scale;
    ctx.setTransform(p, 0, 0, p, cv.width / 2, cv.height / 2);

    if (outlineImage) {
      ctx.drawImage(outlineImage, scaleBase * -0.5 * 0.9, scaleBase * -0.5 * 0.9, scaleBase * 0.9, scaleBase * 0.9);
    }

    renderer.drawFrame({
      globalTime: effectiveTime,
      buckets,
      dt: dt * speed.value,
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

  function loop(ts) {
    if (!playing.value) return;
    const dt = Math.min(100, ts - lastTs) / 1000;
    lastTs = ts;
    realTime.value += dt * speed.value;
    const endTime = chart.DATA.value.meta.endTime;
    if (previewStop !== null && realTime.value >= previewStop) {
      if (previewLoop) {
        seek(previewStart !== null ? previewStart : 0);
      } else {
        realTime.value = previewStop;
        playing.value = false;
        previewStop = null;
      }
    }
    if (realTime.value >= endTime) {
      if (previewLoop) {
        seek(previewStart !== null ? previewStart : 0);
      } else {
        realTime.value = endTime;
        playing.value = false;
      }
    }
    draw(realTime.value, dt);
    audioManager.update(realTime.value);
    if (playing.value) requestAnimationFrame(loop);
  }

  function unlockAudio() {
    audioManager.ensureContextSync();
    if (audioManager.ctx?.state === 'suspended') {
      audioManager.ctx.resume().catch(() => { });
    }
  }

  function play() {
    if (playing.value) return;
    playing.value = true;
    unlockAudio();
    lastTs = performance.now();
    requestAnimationFrame(loop);
  }

  function pause() {
    playing.value = false;
    previewStop = null;
    previewStart = null;
    previewLoop = false;
  }

  function togglePlay() {
    if (playing.value) pause(); else play();
  }

  function setPreviewStop(t) {
    previewStop = t;
    previewStart = 0;
    previewLoop = false;
  }

  function setPreviewBounds(start, stop, isLoop = false) {
    previewStart = start;
    previewStop = stop;
    previewLoop = isLoop;
  }

  function setSpeed(v) {
    speed.value = v;
  }

  function setHs(v) {
    hs.value = v;
    defaultSettings.speed = v;
    draw(realTime.value, 0);
  }

  function setDragging(v) {
    dragging.value = v;
  }

  // 換一份全新的譜面資料重新播放前要呼叫（例如預覽彈窗每次開啟）：
  // nowIndexLocal／playScoreRes 是跨影格累積的內部狀態，不重設的話上一次播放的
  // combo／score 會殘留到這一次，尤其是「切的乾淨」預覽每次都是完全不同的一小段譜面。
  function resetPlaybackState() {
    nowIndexLocal = 0;
    playScoreRes = { tap: 0, hold: 0, slide: 0, touch: 0, break: 0, score: 0, breakScore: 0, invScore: 0 };
    logic = new SimaiLogicControler();
  }

  return {
    playing, realTime, speed, hs, dragging, timeOffset,
    hudMeasure, hudMeasureFloat, hudCombo,
    measureIndex, measureIndexFloat, measureTime, commaIndexAt, currentCommaIndex, currentComboIndex,
    seek, seekComma, jumpByTime, jumpToAdjacentNote,
    attachCanvas, detachCanvas, resizeCanvas,
    loadAssets, initEngine, resetPlaybackState,
    play, pause, togglePlay, setPreviewStop, setPreviewBounds,
    setSpeed, setHs, setTimeOffset, adjustTimeOffset, resetTimeOffset, setDragging, unlockAudio,
    defaultSettings,
  };
}

```

# app/src/composables/useRangeSelection.js

```js
import { ref, computed, watch } from 'vue';
import { buildCleanCutSimai } from '../../../../engine/Scripts/simaiCut.js';

export const MAX_RENDER_SEC = 30;
const OVER_LIMIT_COLOR = '#f23f43';

const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

/**
 * 選取範圍（起訖逗號）＋密度圖繪製。
 * rangeA／rangeB 是兩條各自獨立的滑桿，值可以互相超過對方——range.start/end
 * 只是「目前兩個滑桿裡比較小/比較大的那個」，不是滑桿本身，這樣才能重現原本
 * 「隨便拖哪一顆，兩顆都能滑到底、互相交換起訖角色」的手感。
 */
export function useRangeSelection(chart, engine) {
  const rangeAValue = ref(0);
  const rangeBValue = ref(0);
  const maxComma = ref(0);
  const activeEndpoint = ref(null); // 'a' | 'b' | null：導覽鍵目前在動哪個東西
  const cleanCut = ref(true); // 「切的乾淨」預設開啟
  let densityCanvas = null;
  let dctx = null;

  const range = computed(() => ({
    start: Math.min(rangeAValue.value, rangeBValue.value),
    end: Math.max(rangeAValue.value, rangeBValue.value),
  }));

  function getRangeDuration() {
    const C = chart.C.value;
    if (!C || C.length < 2) return 0;
    const startTime = C[range.value.start] ?? 0;
    const endTime = C[range.value.end + 1] ?? (chart.DATA.value?.meta.endTime ?? 0);
    return Math.max(0, endTime - startTime);
  }

  function comboRangeSpan() {
    const N = chart.N.value;
    const C = chart.C.value;
    if (!N || N.length === 0) return null;
    const t0 = C[range.value.start] ?? 0;
    const t1 = C[range.value.end + 1] ?? (chart.DATA.value?.meta.endTime ?? 0);
    const firstIdx = N.findIndex(n => n.time >= t0 - 1e-6);
    if (firstIdx === -1 || N[firstIdx].time >= t1 - 1e-6) return null;
    let lastIdx = firstIdx;
    for (let i = N.length - 1; i >= firstIdx; i--) {
      if (N[i].time < t1 - 1e-6) { lastIdx = i; break; }
    }
    return { first: firstIdx + 1, last: lastIdx + 1 };
  }

  const rangeDuration = computed(getRangeDuration);
  const rangeOverLimit = computed(() => {
    const commaSpan = range.value.end - range.value.start + 1;
    return commaSpan > 0 && rangeDuration.value > MAX_RENDER_SEC;
  });

  const rangeLabel = computed(() => {
    const commaSpan = range.value.end - range.value.start + 1;
    if (commaSpan <= 0) return '⚠️ 空區間';
    const combo = comboRangeSpan();
    const span = rangeTimeSpan();
    let label = combo ? `Combo ${combo.first} - ${combo.last}` : '（此區間沒有音符）';
    label += `  (${span.start.toFixed(3)}s ~ ${span.end.toFixed(3)}s, ~${rangeDuration.value.toFixed(3)}s)`;
    const mark = (which, name) => (activeEndpoint.value === which ? `◆${name}` : '');
    const marks = [mark('a', '起'), mark('b', '終')].filter(Boolean).join(' ');
    if (marks) label += `  ${marks}`;
    return label;
  });

  const rangeMessage = computed(() => {
    const commaSpan = range.value.end - range.value.start + 1;
    if (commaSpan <= 0) return { text: '⚠️ 選取範圍為空區間，無法渲染。', type: 'error' };
    return { text: '', type: '' };
  });

  function commaLabel(commaIdx) {
    const text = chart.commaParts.value[commaIdx];
    return text ? text : '（空拍）';
  }

  function setActiveEndpoint(which) {
    activeEndpoint.value = which;
  }

  function initBounds(maxCommaValue, initial) {
    maxComma.value = maxCommaValue;
    rangeAValue.value = initial?.start ?? 0;
    rangeBValue.value = initial?.end ?? maxCommaValue;
  }

  function onRangeInput(which, value) {
    if (which === 'a') rangeAValue.value = value;
    else rangeBValue.value = value;
    setActiveEndpoint(which);
    const t = chart.C.value[value];
    if (t !== undefined) engine.seek(t);
  }

  function moveActiveEndpoint(dir, big) {
    const which = activeEndpoint.value;
    if (!which) return;
    const step = big ? 10 : 1;
    const cur = which === 'a' ? rangeAValue.value : rangeBValue.value;
    const next = Math.max(0, Math.min(maxComma.value, cur + dir * step));
    onRangeInput(which, next);
  }

  /** 導覽鍵移動播放頭後，把作用中的端點同步到新位置 */
  function syncActiveEndpointToPlayhead() {
    if (!activeEndpoint.value) return;
    onRangeInput(activeEndpoint.value, engine.currentCommaIndex());
  }

  function setStart() {
    const cIdx = engine.currentCommaIndex();
    const oldEnd = range.value.end;
    rangeAValue.value = cIdx;
    rangeBValue.value = Math.max(oldEnd, cIdx);
  }

  function setEnd() {
    const cIdx = engine.currentCommaIndex();
    const oldStart = range.value.start;
    rangeBValue.value = cIdx;
    rangeAValue.value = Math.min(oldStart, cIdx);
  }

  function goStart() {
    engine.seek(chart.C.value[range.value.start] ?? 0);
  }

  function rangeTimeSpan() {
    const C = chart.C.value;
    if (!C || C.length < 2) return { start: 0, end: 0 };
    return {
      start: C[range.value.start] ?? 0,
      end: C[range.value.end + 1] ?? (chart.DATA.value?.meta.endTime ?? 0),
    };
  }

  function buildExportPreview() {
    const dur = rangeDuration.value;
    const span = rangeTimeSpan();
    let previewText = null;
    if (cleanCut.value) {
      try {
        const info = { indexToTime: chart.C.value, tags: chart.DATA.value.tags || [], bpm: chart.DATA.value.meta.bpm };
        previewText = buildCleanCutSimai(chart.chartText.value, info, chart.C.value[range.value.start] ?? 0, chart.C.value[range.value.end + 1] ?? chart.DATA.value.meta.endTime);
      } catch (e) {
        console.error('產生預覽片段失敗:', e);
      }
    }
    return {
      meta: cleanCut.value
        ? `切的乾淨・${span.start.toFixed(3)}s ~ ${span.end.toFixed(3)}s (約 ${dur.toFixed(3)} 秒)・以下是實際會送出的內容`
        : `未啟用切的乾淨・${span.start.toFixed(3)}s ~ ${span.end.toFixed(3)}s (約 ${dur.toFixed(3)} 秒)・會送出整份原始譜面＋指定時間範圍`,
      text: previewText ?? '（整份原始譜面，內容過長不在此顯示；後端會照時間範圍只播放這一段）',
    };
  }

  function setDensityCanvas(el) {
    densityCanvas = el;
    dctx = el ? el.getContext('2d') : null;
  }

  function drawDensity(playheadMi) {
    if (!dctx || !densityCanvas) return;
    const M = chart.M.value, D = chart.D.value, C = chart.C.value;
    if (M.length === 0) return;
    const clientWidth = densityCanvas.clientWidth;
    if (clientWidth === 0) {
      requestAnimationFrame(() => drawDensity(playheadMi));
      return;
    }
    const w = clientWidth * devicePixelRatio, h = 50 * devicePixelRatio;
    if (densityCanvas.width !== w) { densityCanvas.width = w; densityCanvas.height = h; }
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

    // 選取範圍高亮（地雷灰）
    if (C.length > 1) {
      const getM = engine.measureIndexFloat ? (t) => engine.measureIndexFloat(t) : (t) => engine.measureIndex(t);
      const startM = getM(C[range.value.start] ?? 0);
      const endBoundaryM = getM(C[range.value.end + 1] ?? C[C.length - 1]);
      dctx.fillStyle = rangeOverLimit.value ? 'rgba(242, 63, 67, 0.16)' : 'rgba(115, 115, 115, 0.25)';
      dctx.fillRect(startM * bw, 0, Math.max(bw, (endBoundaryM - startM) * bw), h);
      dctx.fillStyle = rangeOverLimit.value ? OVER_LIMIT_COLOR : css('--mine');
      dctx.fillRect(startM * bw, 0, 2, h);
      dctx.fillRect(endBoundaryM * bw - 2, 0, 2, h);
    }

    dctx.fillStyle = '#ffffff';
    dctx.fillRect(playheadMi * bw, 0, Math.max(2, bw * 0.6), h);
  }

  function densitySeek(clientX, wrapEl) {
    const M = chart.M.value;
    const r = wrapEl.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    engine.seek(engine.measureTime(Math.round(frac * (M.length - 1))));
  }

  // realTime／範圍任一邊變動都要重繪密度圖
  watch([engine.realTime, rangeAValue, rangeBValue], () => {
    drawDensity(engine.hudMeasureFloat ? engine.hudMeasureFloat.value : engine.hudMeasure.value);
  });

  return {
    range, rangeAValue, rangeBValue, maxComma, activeEndpoint, cleanCut,
    rangeDuration, rangeOverLimit, rangeLabel, rangeMessage,
    commaLabel, setActiveEndpoint, initBounds, onRangeInput, moveActiveEndpoint, syncActiveEndpointToPlayhead, setStart, setEnd, goStart, rangeTimeSpan,
    buildExportPreview, setDensityCanvas, drawDensity, densitySeek,
  };
}

```

# app/src/composables/useSfx.js

```js
import { ref, computed } from 'vue';
import { audioManager } from '../../../../engine/Scripts/helper.js';

// 音效模式：關 / 簡易（即時合成，免下載）/ 完整（wav 音效檔）。
// 完整模式的檔案只在使用者主動切到該模式時才下載；下載期間先用簡易合成音頂著，
// 載完之後 audioManager 找得到 buffer 就會自動改用真正的音效。
const SFX_MODES = ['off', 'simple', 'full'];
const SFX_MODE_LABEL = { off: '🔇 靜音', simple: '🔉 簡易', full: '🔊 完整' };

export function useSfx() {
  const sfxVolume = ref(0.5);
  const sfxMode = ref('simple');
  const sfxFullLoading = ref(false);
  const sfxFullLoaded = ref(false);
  const sfxLoadingMessage = ref('');

  const sfxModeLabel = computed(() => SFX_MODE_LABEL[sfxMode.value]);

  function applySfxMode() {
    audioManager.muted = sfxMode.value === 'off';
    audioManager.synthFallback = sfxMode.value !== 'off';
    if (sfxMode.value === 'off') {
      audioManager.soundQueue = [];
      audioManager.stopAllScheduledSounds();
    }
  }

  function loadFullSfx() {
    if (sfxFullLoaded.value || sfxFullLoading.value) return;
    sfxFullLoading.value = true;
    sfxLoadingMessage.value = '🔊 正在載入完整音效…（先以簡易音播放）';
    audioManager.init((pct) => {
      sfxLoadingMessage.value = `🔊 正在載入完整音效… ${Math.round(pct)}%（先以簡易音播放）`;
    }).catch(e => console.warn('[Audio] 音效載入部分失敗:', e)).then(() => {
      audioManager.setSFXVolume(sfxVolume.value);
      sfxFullLoaded.value = true;
      sfxFullLoading.value = false;
      sfxLoadingMessage.value = sfxMode.value === 'full' ? '✅ 完整音效已就緒' : '';
      if (sfxLoadingMessage.value) setTimeout(() => { sfxLoadingMessage.value = ''; }, 1500);
    });
  }

  /** 解鎖瀏覽器 AudioContext（必須在使用者手勢中同步呼叫） */
  function unlockAudio() {
    audioManager.ensureContextSync();
    if (audioManager.ctx?.state === 'suspended') {
      audioManager.ctx.resume().catch(() => {});
    }
  }

  function cycleSfxMode() {
    sfxMode.value = SFX_MODES[(SFX_MODES.indexOf(sfxMode.value) + 1) % SFX_MODES.length];
    applySfxMode();
    unlockAudio(); // 使用者手勢，順便解鎖 AudioContext
    if (sfxMode.value === 'full') loadFullSfx();
  }

  function setSfxVolume(v) {
    sfxVolume.value = v;
    audioManager.setSFXVolume(v);
  }

  applySfxMode();

  return {
    sfxVolume, sfxMode, sfxFullLoading, sfxFullLoaded, sfxLoadingMessage, sfxModeLabel,
    cycleSfxMode, unlockAudio, setSfxVolume,
  };
}

```

# app/src/main.js

```js
import { createApp } from 'vue';
import App from './App.vue';
import { setupDebugLogging } from './composables/useDebugLogging.js';
import './style.css';

// 頁面生命週期事件（bfcache/錯誤回報）跟頁面存活期間一樣長，
// 註冊在元件外面（模組層級），不會因為元件重新掛載而重複註冊
setupDebugLogging();

createApp(App).mount('#app');

```

# app/src/services/apiClient.js

```js
/**
 * 前端 API 客戶端服務 (API Client Service)
 * 統一封裝所有與後端的 HTTP 通訊，自動處理 Proxy 前綴與 RESTful JSON 響應。
 */

function isEmbeddedInDiscord() {
  return window.self !== window.top;
}

function getApiBase() {
  const standalone = import.meta.env.DEV && !isEmbeddedInDiscord();
  return standalone ? '/api' : '/.proxy/api';
}

async function request(endpoint, options = {}) {
  const url = `${getApiBase()}${endpoint}`;
  const res = await fetch(url, options);
  if (!res.ok) {
    let errorMsg = `HTTP ${res.status}`;
    try {
      const json = await res.json();
      if (json.error?.message) errorMsg = json.error.message;
    } catch {}
    throw new Error(errorMsg);
  }
  const json = await res.json();
  if (json.ok !== undefined) {
    if (!json.ok) throw new Error(json.error?.message || '未知伺服器錯誤');
    return json.data;
  }
  return json;
}

export const apiClient = {
  /** 獲取測試譜面列表 */
  async getCharts() {
    const res = await request('/charts');
    return Array.isArray(res) ? res : (res.charts || []);
  },

  /** 獲取特定測試譜面數據與 simai 原碼 */
  async getChartData(file) {
    const query = file ? `?file=${encodeURIComponent(file)}` : '';
    return await request(`/chart${query}`);
  },

  /** 獲取 Resume session */
  async getResumeSession(userId) {
    return await request(`/resume?userId=${encodeURIComponent(userId)}`);
  },

  /** 送出渲染請求 */
  async submitRender(payload) {
    return await request('/render', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  },
};

```

# app/src/style.css

```css
@font-face {
  font-family: 'combo';
  src: url('../../../engine/Fonts/Inter.ttf') format('truetype');
}

@font-face {
  font-family: 'mono';
  src: url('../../../engine/Fonts/ShareTechMono-Regular.ttf') format('truetype');
}

:root {
  --bg: #14142b;          /* 機台深藍紫 */
  --panel: #1d1d3d;
  --line: #34346a;
  --text: #e8e6f5;
  --dim: #8f8cb8;
  --tap: #ff4fa5;         /* maimai tap 粉 */
  --slide: #38c8ff;       /* slide 藍 */
  --hold: #ffd23e;        /* each 黃 → hold */
  --touch: #52e0a0;
  --brk: #ff8a1e;         /* break 橘 */
  --mine: #737373;        /* 地雷灰（選取範圍標記用） */
  --play: #ff4fa5;
}

* { margin:0; padding:0; box-sizing:border-box; }

html, body {
  background: var(--bg);
  color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans TC", sans-serif;
  height: 100vh;
  width: 100vw;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 10px;
  overflow: hidden;
}

.container {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  background: #191937;
  padding: 15px 20px;
  border-radius: 16px;
  border: 1px solid var(--line);
  box-shadow: 0 10px 30px rgba(0,0,0,0.4);
  width: 100%;
  max-width: 900px;
  max-height: calc(100vh - 20px);
  overflow: hidden;
}

.main-content {
  display: flex;
  flex-direction: row;
  gap: 20px;
  width: 100%;
  flex: 1;
  overflow: hidden;
  align-items: stretch;
}

.left-panel {
  /* 譜面 320 ＋ 左右各一排導覽鍵 */
  width: 440px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  align-items: center;
  justify-content: flex-start;
  flex-shrink: 0;
}

/* 桌機版譜面固定高度；手機版由 media query 改成隨螢幕縮放 */
.player-row {
  height: 320px;
}

.right-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 10px;
  justify-content: space-between;
  overflow: hidden;
  min-width: 0;
}

header {
  position: relative;
  text-align: center;
  width: 100%;
  border-bottom: 1px solid var(--line);
  padding-bottom: 10px;
}

header h1 {
  font-size: 18px;
  font-weight: 700;
  letter-spacing: .04em;
  color: #fff;
  margin: 0;
}

.header-title-row {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  flex-wrap: wrap;
}

.chart-select-dropdown {
  background: var(--bg);
  color: var(--slide);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 3px 8px;
  font-size: 11px;
  font-weight: 700;
  cursor: pointer;
  outline: none;
  transition: border-color .12s, background .12s;
}

.chart-select-dropdown:hover:not(:disabled) {
  border-color: var(--slide);
  background: #2a2a55;
}

.chart-select-dropdown:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.status-connecting {
  color: #f0b232;
  font-size: 12px;
  margin-top: 4px;
}

.status-ready {
  color: #23a55a;
  font-size: 12px;
  margin-top: 4px;
}

.status-error {
  color: #f23f43;
  font-size: 12px;
  margin-top: 4px;
}

.btn-retry {
  margin-top: 8px;
  background: #2a2a55;
  color: var(--text);
  border: 1px solid #5865f2;
  border-radius: 8px;
  padding: 6px 16px;
  font-size: 13px;
  cursor: pointer;
  transition: background .12s;
  display: block;
}
.btn-retry:hover {
  background: #5865f2;
}

/* TAP/HOLD/SLIDE… 各類數量不需要顯示（JS 仍會寫入，只是不呈現） */
header .sub {
  display: none;
}

#stage {
  position: relative;
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  justify-content: center;
  align-items: center;
}

/* 畫布維持正方形，高度吃滿 .player-row，寬度不夠時再自動縮 */
#chartCanvas {
  display: block;
  background: #0c0c1e;
  border-radius: 14px;
  border: 1px solid var(--line);
  height: 100%;
  width: auto;
  max-width: 100%;
  aspect-ratio: 1 / 1;
}

/* 播放資訊獨立一行，不覆蓋譜面 */
#hud {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  font-size: 12px;
  color: var(--dim);
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}

#hud b {
  color: var(--text);
  font-weight: 600;
}

/* 譜面與左右導覽鍵並排 */
.player-row {
  display: flex;
  align-items: stretch;
  justify-content: center;
  gap: 8px;
  width: 100%;
  min-height: 0;
}

.nav-col {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: 0 0 auto;
  width: 52px;
}

.nav-col button {
  flex: 1;
}

.control-buttons button, .nav-col button {
  background: var(--panel);
  color: var(--text);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 8px 2px;
  font-size: 12px;
  cursor: pointer;
  flex: 1;
  min-width: 0;
  text-align: center;
  white-space: nowrap;
  transition: background .12s;
  touch-action: manipulation;
}

.control-settings {
  display: flex;
  gap: 12px;
  justify-content: center;
  align-items: center;
  width: 100%;
  flex-wrap: wrap;
}

/* 設定區的 slider：跟選取範圍的滑桿共用一套視覺 */
.speedbox input[type="range"] {
  appearance: none;
  height: 22px;
  background: transparent;
  cursor: pointer;
  width: 78px;
  touch-action: none;
}

.speedbox input[type="range"]::-webkit-slider-runnable-track {
  height: 5px;
  border-radius: 3px;
  background: #26264c;
}

.speedbox input[type="range"]::-webkit-slider-thumb {
  appearance: none;
  width: 15px;
  height: 15px;
  margin-top: -5px;
  border-radius: 50%;
  background: #fff;
  border: 3px solid var(--slide);
  box-shadow: 0 1px 4px rgba(0, 0, 0, .5);
}

.speedbox input[type="range"]::-moz-range-track {
  height: 5px;
  border-radius: 3px;
  background: #26264c;
}

.speedbox input[type="range"]::-moz-range-thumb {
  width: 13px;
  height: 13px;
  border-radius: 50%;
  background: #fff;
  border: 3px solid var(--slide);
}

.speedbox input[type="range"]:disabled::-webkit-slider-thumb {
  background: var(--dim);
  border-color: var(--dim);
}

.speedbox b, .speedbox #speedVal, .speedbox #hsVal, .speedbox #sfxVal {
  color: var(--text);
  font-variant-numeric: tabular-nums;
  min-width: 38px;
}

.btn-sfx-mode {
  background: var(--panel);
  color: var(--text);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 6px 10px;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
  transition: background .12s, border-color .12s;
  touch-action: manipulation;
}

.btn-sfx-mode:hover {
  background: #2a2a55;
}

/* 音效關閉時把音量 slider 收起來，避免佔空間 */
.sfx-off #sfxSlider, .sfx-off #sfxVal {
  display: none;
}

.control-buttons button:hover:not(:disabled), .nav-col button:hover:not(:disabled) {
  background: #2a2a55;
}

.control-buttons button:disabled, .nav-col button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* 播放鍵拆兩顆分別嵌在左右導覽欄最下面（見 .nav-col），不用再獨立一整排。
   兩顆狀態永遠同步，純粹方便左右手都點得到。 */
.btn-play {
  background: var(--play);
  border-color: var(--play);
  color: #fff;
  font-weight: 700;
  font-size: 14px;
}

.nav-col button.btn-play:hover:not(:disabled) {
  background: var(--play);
  opacity: 0.85;
}

/* ---------- 設定選單（與歌名同一水平線，靠左） ---------- */
#settingsMenu {
  position: absolute;
  left: 0;
  top: 0;
  z-index: 30;
}

.btn-settings {
  background: var(--panel);
  color: var(--text);
  border: 1px solid var(--line);
  border-radius: 8px;
  width: 38px;
  height: 38px;
  font-size: 17px;
  line-height: 1;
  cursor: pointer;
  transition: background .12s, border-color .12s;
  touch-action: manipulation;
}

.btn-settings:hover:not(:disabled) {
  background: #2a2a55;
  border-color: var(--slide);
}

.btn-settings:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* 展開的設定浮層：fixed 定位，不推擠版面、不會撐出捲動，也不會被祖先切掉 */
#settingsPanel {
  position: fixed;
  z-index: 60;
  width: max-content;
  min-width: 210px;
  max-width: calc(100vw - 24px);
  flex-direction: column;
  align-items: stretch;
  gap: 8px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 10px 12px;
  box-shadow: 0 10px 28px rgba(0, 0, 0, .55);
}

#settingsPanel[hidden] {
  display: none;
}

.speedbox {
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--dim);
  font-size: 12px;
}

.speedbox select {
  background: var(--panel);
  color: var(--text);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 5px 6px;
  font-size: 12px;
}

#timeline {
  width: 100%;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 12px 14px 10px;
  min-width: 0;
}

#densityWrap {
  position: relative;
  cursor: pointer;
  overflow: hidden;
  border-radius: 6px;
}

/* 圓角不直接放在 canvas 上：Safari 對「canvas 內容用 JS 動態改尺寸 + 自己有
   border-radius」這個組合的圓角裁切遮罩常常沒跟著更新，會出現底部被裁掉一截、
   圓角顯示不正常的狀況（Chrome 沒這問題）。改交給外層 wrapper 的 overflow:hidden
   裁切，圓角裁切就是標準 box 合成，不會跟 canvas 內容重繪綁在一起 */
#densityCanvas {
  display: block;
  width: 100%;
  height: 50px;
  position: relative;
  z-index: 10;
}

#timeLabels {
  display: flex;
  justify-content: space-between;
  color: var(--dim);
  font-size: 10px;
  margin: 2px 2px 6px;
  font-variant-numeric: tabular-nums;
}

#measureSlider {
  width: 100%;
  appearance: none;
  height: 20px;
  background: transparent;
  cursor: pointer;
  display: block;
}

#measureSlider:disabled {
  cursor: not-allowed;
}

#measureSlider::-webkit-slider-runnable-track {
  height: 6px;
  border-radius: 3px;
  background-color: #26264c;
}

#measureSlider::-webkit-slider-thumb {
  appearance: none;
  width: 16px;
  height: 16px;
  margin-top: -5px;
  border-radius: 50%;
  background: var(--tap);
  border: 2px solid #fff;
  box-shadow: 0 0 6px var(--tap);
}

/* 方向鍵目前控制的是播放進度時，進度條的把手加一圈提示 */
#measureSlider.active::-webkit-slider-thumb {
  box-shadow: 0 0 0 3px rgba(255, 79, 165, .3), 0 0 6px var(--tap);
}

/* 🛠️ Debug 時間線微調列 */
.timeline-debug-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 8px 0 12px;
  padding: 6px 10px;
  background: rgba(0, 0, 0, 0.25);
  border: 1px solid var(--line);
  border-radius: 8px;
  font-size: 11px;
}

.debug-label {
  color: var(--dim);
  font-size: 11px;
  white-space: nowrap;
}

.offset-val-text {
  color: var(--slide);
  font-family: 'mono', monospace;
  font-size: 12px;
  font-weight: 700;
}

.debug-time-input {
  width: 68px;
  background: var(--bg);
  color: var(--slide);
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 3px 6px;
  font-family: 'mono', monospace;
  font-size: 12px;
  font-weight: 700;
  text-align: right;
}

.debug-unit {
  color: var(--dim);
  font-size: 11px;
  margin-right: 4px;
}

.debug-btn-group {
  display: flex;
  gap: 3px;
  margin-left: auto;
}

.debug-btn-group button {
  padding: 3px 6px;
  font-size: 10px;
  font-family: 'mono', monospace;
  background: var(--bg);
  color: var(--text);
  border: 1px solid var(--line);
  border-radius: 4px;
  cursor: pointer;
  transition: background .12s, border-color .12s;
}

.debug-btn-group button:hover:not(:disabled) {
  background: #2a2a55;
  border-color: var(--slide);
}

.debug-btn-group button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

#measureTicks {
  display: flex;
  justify-content: space-between;
  color: var(--dim);
  font-size: 9px;
  margin-top: 2px;
  font-variant-numeric: tabular-nums;
}

#legend {
  display: flex;
  gap: 10px;
  justify-content: center;
  font-size: 11px;
  color: var(--dim);
  flex-wrap: wrap;
}

#legend i {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 2px;
  margin-right: 4px;
}

#rangePanel {
  margin-top: 6px;
  padding: 8px 10px 10px;
  background: rgba(0, 0, 0, 0.18);
  border: 1px solid var(--line);
  border-radius: 10px;
}

#rangeHeader {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 11px;
  color: var(--dim);
  margin-bottom: 10px;
}

.range-title {
  color: var(--text);
  font-weight: 700;
  font-size: 12px;
}

#rangeLabel {
  font-variant-numeric: tabular-nums;
  color: var(--slide);
  font-weight: 600;
  margin-left: auto;
}

/* 起點／終點各自獨立一整條滑桿：離太近時不用再猜是要點哪一個 */
.range-row {
  display: flex;
  align-items: center;
  gap: 6px;
  /* 上面留出端點框的空間，才不會蓋到上一排（見 .range-tip） */
  margin-top: 24px;
}

.range-row-label {
  flex: 0 0 auto;
  width: 16px;
  font-size: 11px;
  color: var(--dim);
  text-align: center;
}

.range-track {
  position: relative;
  flex: 1;
  min-width: 0;
  height: 20px;
}

.range-track-bg {
  position: absolute;
  left: 7px;
  right: 7px;
  top: 50%;
  height: 5px;
  transform: translateY(-50%);
  border-radius: 3px;
  background: #26264c;
}

.range-track input {
  position: absolute;
  left: 0;
  top: 0;
  width: 100%;
  height: 20px;
  margin: 0;
  appearance: none;
  background: transparent;
  pointer-events: none;
  /* 自己處理拖曳，避免手機把拖動/雙點解讀成捲動或縮放 */
  touch-action: none;
}

.range-track input::-webkit-slider-runnable-track,
.range-track input::-moz-range-track {
  height: 5px;
  margin-top: 7.5px;
  background: transparent;
}

/* 端點框：絕對定位浮在滑塊正上方，隨滑塊移動。.range-row 的 margin-top 已經
   幫每一排都預留了空間，不會蓋到上一排。 */
.range-tip {
  position: absolute;
  bottom: 100%;
  margin-bottom: 6px;
  transform: translateX(-50%);
  max-width: 96px;
  padding: 2px 5px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 6px;
  color: var(--text);
  font-family: 'mono', monospace;
  font-size: 10px;
  line-height: 1.3;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: none;
  box-shadow: 0 2px 6px rgba(0, 0, 0, .4);
  z-index: 5;
}

.range-tip::after {
  content: '';
  position: absolute;
  top: 100%;
  left: 50%;
  transform: translateX(-50%);
  border: 4px solid transparent;
  border-top-color: var(--line);
}

.range-track input::-webkit-slider-thumb {
  appearance: none;
  pointer-events: auto;
  width: 15px;
  height: 15px;
  margin-top: -5px;
  border-radius: 50%;
  background: #fff;
  border: 3px solid var(--mine);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.5);
  cursor: ew-resize;
  transition: transform .12s ease;
}

.range-track input::-moz-range-thumb {
  appearance: none;
  pointer-events: auto;
  width: 13px;
  height: 13px;
  border-radius: 50%;
  background: #fff;
  border: 3px solid var(--mine);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.5);
  cursor: ew-resize;
  transition: transform .12s ease;
}

.range-track input:hover:not(:disabled)::-webkit-slider-thumb,
.range-track input:active:not(:disabled)::-webkit-slider-thumb {
  transform: scale(1.15);
}

.range-track input:disabled::-webkit-slider-thumb,
.range-track input:disabled::-moz-range-thumb {
  background: var(--dim);
  border-color: var(--dim);
  cursor: not-allowed;
}

/* 作用中的端點（最後一次點過/拖過的那個）：按導覽鍵時它會跟著播放頭走 */
.range-track input.active::-webkit-slider-thumb {
  border-color: var(--tap);
  box-shadow: 0 0 0 3px rgba(255, 79, 165, .3), 0 1px 4px rgba(0, 0, 0, .5);
}

.range-track input.active::-moz-range-thumb {
  border-color: var(--tap);
}

/* 區間超過渲染秒數上限：只用紅色提示，不再跳文字警告 */
.range-track.over-limit input:not(:disabled)::-webkit-slider-thumb {
  border-color: #f23f43;
}

.range-track.over-limit input:not(:disabled)::-moz-range-thumb {
  border-color: #f23f43;
}

#rangeLabel.over-limit {
  color: #f23f43;
}

/* 起點/終點按鈕貼在滑桿正下方的左右兩端，視覺上直接對應兩個端點 */
#rangeEnds {
  display: flex;
  justify-content: space-between;
  gap: 6px;
  margin-bottom: 8px;
}

#rangeActions {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
}

#rangeActions button {
  flex: 1;
}

#rangeEnds button, #rangeActions button {
  background: var(--bg);
  color: var(--text);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 5px 10px;
  font-size: 11px;
  cursor: pointer;
  transition: background .12s, border-color .12s;
}

#rangeEnds button:hover:not(:disabled), #rangeActions button:hover:not(:disabled) {
  background: #2a2a55;
  border-color: var(--slide);
}

#rangeEnds button:disabled, #rangeActions button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* ⏱️ 渲染時間 Offset 測試面板 */
.offset-test-panel {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 6px 0 10px;
  padding: 8px 10px;
  background: rgba(0, 0, 0, 0.25);
  border: 1px solid var(--line);
  border-radius: 8px;
}

.offset-test-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 2px;
}

.offset-test-title {
  color: var(--text);
  font-weight: 700;
  font-size: 11px;
}

.btn-offset-reset {
  padding: 2px 6px;
  font-size: 10px;
  background: var(--bg);
  color: var(--dim);
  border: 1px solid var(--line);
  border-radius: 4px;
  cursor: pointer;
}

.btn-offset-reset:hover:not(:disabled) {
  color: var(--text);
  border-color: var(--slide);
}

.offset-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  font-size: 11px;
}

.offset-label {
  color: var(--dim);
  font-size: 11px;
  white-space: nowrap;
}

.offset-label b {
  color: var(--slide);
  font-family: 'mono', monospace;
}

.offset-presets {
  display: flex;
  gap: 3px;
}

.offset-presets button {
  padding: 2px 6px;
  font-size: 10px;
  font-family: 'mono', monospace;
  background: var(--bg);
  color: var(--dim);
  border: 1px solid var(--line);
  border-radius: 4px;
  cursor: pointer;
  transition: all .12s ease;
}

.offset-presets button.active {
  background: var(--slide);
  color: #fff;
  border-color: var(--slide);
  font-weight: 700;
}

.offset-presets button:hover:not(:disabled) {
  background: #2a2a55;
  color: var(--text);
  border-color: var(--slide);
}

.offset-presets button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* 秒數精細微調面板 */
.offset-panel {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 6px 0 10px;
  padding: 6px 8px;
  background: rgba(0, 0, 0, 0.22);
  border: 1px dashed var(--line);
  border-radius: 8px;
}

.offset-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  font-size: 11px;
}

.offset-title {
  color: var(--dim);
  font-size: 11px;
  white-space: nowrap;
}

.offset-title b {
  color: var(--slide);
}

.offset-btn-group {
  display: flex;
  gap: 3px;
}

.offset-btn-group button {
  padding: 2px 6px;
  font-size: 10px;
  background: var(--bg);
  color: var(--text);
  border: 1px solid var(--line);
  border-radius: 4px;
  cursor: pointer;
  transition: background .12s, border-color .12s;
}

.offset-btn-group button:hover:not(:disabled) {
  background: #2a2a55;
  border-color: var(--slide);
}

.offset-btn-group button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* 主要動作：整條置底、明顯比其他按鈕大 */
.btn-export {
  display: block;
  width: 100%;
  background: #23a55a;
  border: 1px solid #23a55a;
  border-radius: 8px;
  color: #fff;
  font-weight: 700;
  font-size: 13px;
  padding: 10px;
  cursor: pointer;
  transition: opacity 0.2s;
}

.btn-export:hover:not(:disabled) {
  opacity: 0.9;
}

.btn-export:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.app-footer {
  min-height: 20px;
  width: 100%;
}

/* 送出前確認彈窗：蓋滿整個視窗，內容區塊自己捲動（頁面本身不能滾） */
.modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.6);
  padding: 16px;
}

.modal-overlay[hidden] {
  display: none;
}

.modal-box {
  width: 100%;
  max-width: 480px;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  gap: 10px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 16px;
  box-shadow: 0 10px 28px rgba(0, 0, 0, .55);
}

.modal-box h3 {
  font-size: 15px;
  color: var(--text);
}

.modal-meta {
  font-size: 12px;
  color: var(--dim);
}

.modal-simai-text {
  flex: 1;
  min-height: 0;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-all;
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 10px;
  font-family: 'mono', monospace;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text);
}

.modal-actions {
  display: flex;
  gap: 8px;
}

.modal-actions .btn-export {
  flex: 1;
}

.btn-modal-cancel {
  flex: 1;
  background: transparent;
  border: 1px solid var(--line);
  border-radius: 8px;
  color: var(--dim);
  font-size: 13px;
  padding: 10px;
  cursor: pointer;
}

.preview-modal-box {
  max-width: 600px;
  width: 94vw;
  max-height: 94vh;
  align-items: stretch;
}

.preview-stage {
  display: flex;
  justify-content: center;
  align-items: center;
  width: 100%;
  padding: 8px 0;
}

#previewStage {
  display: flex;
  justify-content: center;
  align-items: center;
  width: min(100%, 480px, 52vh);
  height: min(100%, 480px, 52vh);
  aspect-ratio: 1 / 1;
  margin: 0 auto;
}

#previewCanvas {
  display: block;
  background: #0c0c1e;
  border-radius: 14px;
  border: 1px solid var(--line);
  width: 100% !important;
  height: 100% !important;
  aspect-ratio: 1 / 1;
}

.btn-modal-cancel:hover {
  background: #2a2a55;
}

.message {
  margin: 0;
  font-size: 12px;
  text-align: center;
  font-weight: 500;
  line-height: 1.5;
}

.message.success {
  color: #23a55a;
}

.message.error {
  color: #f23f43;
}

.message.info {
  color: #38c8ff;
}

#timeLabels span, #measureTicks span {
  flex: 1;
  text-align: center;
}
#timeLabels span:first-child, #measureTicks span:first-child {
  text-align: left;
}
#timeLabels span:last-child, #measureTicks span:last-child {
  text-align: right;
}

@media (max-width: 768px) {
  /* 手機版目標：整頁不捲動，譜面全程看得到（畫布會自動縮小去配合剩餘空間）。
     同時最上方要空出 Discord 自己疊加的活動標題列（返回鈕／活動名稱／退出鈕）所佔的高度。 */
  html, body {
    overflow: hidden;
    height: 100%;
  }

  body {
    align-items: flex-start;
    /* 沒有裝置資訊時的保守值；確認是手機平台後由下面的規則改用實際安全區高度 */
    padding-top: 84px;
    padding-bottom: max(8px, env(safe-area-inset-bottom, 0px));
  }

  /* Discord 的活動列疊在裝置安全區（瀏海／狀態列）正下方，高度約 48px。
     用 safe-area-inset-top 自動適應各機型，不再固定寫死而浪費空間。 */
  .platform-mobile body {
    padding-top: calc(env(safe-area-inset-top, 24px) + 50px);
  }

  .container {
    max-width: 500px;
    /* 扣掉上下 padding 後填滿剩餘畫面，內部再自行分配 */
    height: 100%;
    max-height: 100%;
    overflow: hidden;
    padding: 10px 12px;
    gap: 6px;
  }

  .main-content {
    flex-direction: column;
    align-items: center;
    gap: 8px;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  .left-panel, .right-panel {
    width: 100%;
    max-width: 360px;
  }

  /* 譜面吸收所有剩餘空間：其他元件都是固定高度，這樣永遠剛好塞滿一屏、不需捲動 */
  .left-panel {
    flex: 1 1 auto;
    min-height: 0;
    gap: 8px;
  }

  .player-row {
    flex: 1 1 auto;
    height: auto;
    min-height: 132px;
    /* 其他元件的高度都省下來了，這裡把上限放寬，讓省下來的空間真的給譜面用 */
    max-height: 360px;
  }

  .nav-col {
    width: 46px;
  }

  /* 完全不捲動：右半固定高度、不給捲軸 */
  .right-panel {
    flex: 0 0 auto;
    min-height: 0;
    overflow: hidden;
    gap: 6px;
  }

  #timeline {
    flex-shrink: 0;
  }

  /* 為了讓譜面留下足夠高度，手機版收掉純裝飾／次要的資訊 */
  #legend,
  #timeLabels,
  #measureTicks {
    display: none;
  }

  .app-footer {
    min-height: 0;
  }

  #densityCanvas {
    height: 32px;
  }

  #timeline {
    padding: 6px 8px 8px;
  }

  header {
    padding-bottom: 4px;
  }

  header .sub {
    font-size: 10px;
  }
}

@media (max-width: 480px) {
  .container {
    padding: 12px;
    gap: 8px;
    border-radius: 12px;
  }
  header h1 {
    font-size: 16px;
  }
  #timeline {
    padding: 8px 10px;
  }
  #rangeEnds, #rangeActions {
    gap: 4px;
  }
}

/* ---------- 手機：加大點擊區 ---------- */
@media (max-width: 768px) {
  .nav-col button {
    font-size: 13px;
    padding: 6px 2px;
  }

  .btn-play {
    font-size: 15px;
  }

  .btn-settings {
    width: 42px;
    height: 42px;
    font-size: 18px;
  }


  .speedbox {
    gap: 6px;
  }

  .speedbox input[type="range"] {
    height: 34px;
    width: 100%;
    min-width: 0;
    flex: 1;
  }

  .speedbox input[type="range"]::-webkit-slider-thumb {
    width: 20px;
    height: 20px;
    margin-top: -8px;
  }

  .speedbox #speedVal, .speedbox #hsVal, .speedbox #sfxVal {
    min-width: 34px;
    font-size: 11px;
  }

  .btn-sfx-mode {
    min-height: 36px;
    font-size: 12px;
    padding: 6px 8px;
  }

  /* 選取範圍：滑桿加大到方便點的程度，但不像桌機版那麼寬鬆（見上面 steal-height 註解） */
  .range-track {
    height: 30px;
  }

  .range-track input {
    height: 30px;
  }

  .range-track input::-webkit-slider-runnable-track,
  .range-track input::-moz-range-track {
    margin-top: 12.5px;
  }

  .range-track input::-webkit-slider-thumb {
    width: 20px;
    height: 20px;
    margin-top: -7.5px;
  }

  .range-track input::-moz-range-thumb {
    width: 18px;
    height: 18px;
  }

  #measureSlider::-webkit-slider-thumb {
    width: 24px;
    height: 24px;
    margin-top: -9px;
  }

  #rangeEnds button, #rangeActions button {
    min-height: 36px;
    font-size: 12px;
  }

  /* 起點/終點維持貼齊左右兩端，不要撐滿 */
  #rangeEnds button {
    flex: 0 0 auto;
    min-width: 92px;
  }

  /* 「跳到起點／預覽」跟「傳送」分開兩行：擠在同一排太窄，手機上很難點準 */
  .btn-export {
    min-height: 40px;
    font-size: 13px;
    padding: 6px 4px;
  }

  #rangeEnds, #rangeActions {
    margin-bottom: 4px;
  }

  .range-row {
    margin-top: 20px;
  }

  #rangeHeader {
    margin-bottom: 4px;
  }

  #measureSlider {
    height: 32px;
  }
}

```

# app/UI-COMPONENTS.md

```md
# Activity UI 元件命名對照表

給人看的口語名稱、對應的 Vue 元件檔案、跟畫面上可以查的 id/class，三個一起對起來，之後討論「哪個滑桿」「哪顆按鈕」才不會混淆。

## 整體版面

\`\`\`
┌───────────────────────────────────────────────────────┐
│ ⚙            チューリングの跡_master                      │  ← HeaderStatus
│               連線成功：Dev                               │
├───────────────────────────────────────────────────────┤
│ BPM 180    小節 0/103    Combo 0/956                     │  ← HUD
│ ┌───┐   ┌─────────────┐   ┌───┐                          │
│ │<<<│   │             │   │>>>│                          │
│ │<< │   │ ChartCanvas │   │>> │  ← PlayerControls（左／右）│
│ │ < │   │  （音符盤）   │   │ > │                          │
│ │ ▶ │   │             │   │ ▶ │                          │
│ └───┘   └─────────────┘   └───┘                          │
├───────────────────────────────────────────────────────┤
│  ▂▄█▅▃▂▁▃▅█▄▂          ← 密度圖（Timeline 裡的 densityCanvas）│
│  ────────●──────────   ← 播放進度條（Timeline 裡的 measureSlider）│
│                                                          │
│  ✂️ 選取並傳送  Combo 1-956 (~136.2s)     ← RangeSelector  │
│  起 ────●───────────────                                  │
│  終 ───────────────────●                                  │
│  [← 起點]           [終點 →]                               │
│  [跳到起點]        [▶ 預覽]                                 │
│  [✅ 傳送此區間]                                            │
├───────────────────────────────────────────────────────┤
│ ● TAP ● HOLD ● SLIDE ● TOUCH ● BREAK    ← ColorLegend      │
│        （狀態/錯誤訊息文字）              ← FooterMessage    │
└───────────────────────────────────────────────────────┘

浮層（平常不顯示）：
  點左上角 ⚙ 才出現 → SettingsPanel（倍速／流速／音效模式／音量／切的乾淨）
  點「✅ 傳送此區間」才出現 → ConfirmModal（蓋滿全螢幕，送出前預覽）
\`\`\`

## 元件對照表

| 口語名稱 | 元件檔案 | 關鍵 id / class | 做什麼 |
|---|---|---|---|
| 標題列 / 連線狀態列 | `HeaderStatus.vue` | `h1`、`.status-connecting/-ready/-error`、`.btn-retry` | 顯示歌名、連線狀態文字、失敗時的重試鈕 |
| 齒輪按鈕 / 設定按鈕 | `HeaderStatus.vue` | `.btn-settings` | 開關設定面板 |
| **設定面板** | `SettingsPanel.vue` | `#settingsPanel`（浮層本體） | 倍速／流速／音效模式／音量／切的乾淨，全部集中在這 |
| ├ 倍速滑桿 | `SettingsPanel.vue` | 第 1 個 `.speedbox` | 播放速度倍率（0.25×〜1×），只影響播放快慢，不影響畫面內容 |
| ├ 流速滑桿（ハイスピ） | `SettingsPanel.vue` | 第 2 個 `.speedbox`、`#hsVal` | note 從外圈落下到判定圈的視覺速度 |
| ├ 音效模式按鈕 | `SettingsPanel.vue` | `.btn-sfx-mode` | 循環切換 靜音／簡易（即時合成）／完整（wav 音效） |
| ├ 音量滑桿 | `SettingsPanel.vue` | `#sfxSlider`、`#sfxVal` | 音效音量，靜音模式下會自動隱藏 |
| └ 切的乾淨開關 | `SettingsPanel.vue` | 按鈕文字「✂ 切的乾淨：開/關」 | 決定匯出時是否精準切在選取範圍、不多留尾巴 |
| HUD（播放資訊列） | `App.vue`（內聯，沒有獨立成元件） | `#hud` | 顯示目前 BPM／小節進度／combo 進度 |
| **左側導覽鍵組** | `PlayerControls.vue`（`side="left"`） | 第 1 個 `.nav-col` | ＜＜＜ 後退3秒／＜＜ 上一顆音符／＜ 後退1逗號／▶ 播放 |
| **右側導覽鍵組** | `PlayerControls.vue`（`side="right"`） | 第 2 個 `.nav-col` | ＞＞＞ 前進3秒／＞＞ 下一顆音符／＞ 前進1逗號／▶ 播放 |
| 播放鍵 | `PlayerControls.vue`（左右各一顆） | `.btn-play` | 播放／暫停，左右兩顆狀態永遠同步（同一份狀態） |
| 譜面畫布 / 音符盤 | `ChartCanvas.vue` | `#stage`、`#chartCanvas` | 實際畫 note／判定線的 canvas |
| **時間軸區塊** | `Timeline.vue` | `#timeline` | 包住密度圖＋播放進度條＋範圍選取面板的容器 |
| ├ 密度圖 | `Timeline.vue` | `#densityWrap`、`#densityCanvas` | 各小節 tap/hold/slide/touch/break 數量的堆疊長條圖，疊播放頭跟選取範圍高亮；點/拖可以跳轉 |
| └ 播放進度條 | `Timeline.vue` | `#measureSlider` | 拖曳快速跳到指定小節（吸附小節邊界，見下方「小節 vs 逗號」） |

> 密度圖的統計是按小節分桶（`useChartData.js` 的 `D_arr`，長度跟 `M_arr` 一樣）。**已知細節**：第一根長條（索引 0）目前會把「前奏/pickup」跟「第一小節」的音符混在一起統計，因為分桶迴圈找不到 `n.time < M[0]` 對應的小節時會直接落在索引 0——跟播放進度條那個 `M[0] ≠ 0 秒` 是同一個根源，但這裡只影響統計呈現、不影響拖不拖得到，評估過後決定不修（影響小、前奏通常沒什麼音符，修起來要動 `M_arr` 結構，投報率低）。
| **範圍選取面板** | `RangeSelector.vue` | `#rangePanel`、`#rangeLabel` | 選要匯出送給 bot 渲染的那一段 combo 區間 |
| ├ 起點滑桿 | `RangeSelector.vue` | `#rangeTrackA`（軌道）+ 內部 `input` | 選取範圍的起點，用逗號索引定位，不是秒數 |
| ├ 終點滑桿 | `RangeSelector.vue` | `#rangeTrackB`（軌道）+ 內部 `input` | 選取範圍的終點；跟起點滑桿是各自獨立的滑桿，可以互相滑過去 |
| ├ 端點提示框 | `RangeSelector.vue` | `.range-tip` | 浮在滑塊正上方，顯示那個逗號實際的 simai 原文 |
| ├ 設起點／終點按鈕 | `RangeSelector.vue` | `#rangeEnds` 內的兩顆按鈕 | 把「目前播放頭所在位置」設為起點或終點 |
| ├ 跳到起點按鈕 | `RangeSelector.vue` | `#rangeActions` 內第一顆 | 主畫布播放頭跳到選取範圍起點 |
| ├ 預覽按鈕 | `RangeSelector.vue` | `#rangeActions` 內第二顆（「▶ 預覽」） | 開啟**預覽彈窗**（獨立 canvas），自動播放選取範圍 |
| └ 傳送此區間按鈕 | `RangeSelector.vue` | `.btn-export` | 打開確認送出彈窗，準備送出渲染請求 |
| 顏色圖例 | `ColorLegend.vue` | `#legend` | TAP/HOLD/SLIDE/TOUCH/BREAK 對應色塊說明 |
| 訊息列 | `FooterMessage.vue` | `.message`（`.success`/`.error`/`.info`） | 顯示錯誤／成功／進度提示文字，跟匯出狀態共用同一條 |
| **確認送出彈窗** | `ConfirmModal.vue` | `.modal-overlay`、`.modal-box` | 送出前預覽「實際會送出去的 simai 內容」（文字），蓋滿全螢幕 |
| **預覽彈窗** | `PreviewModal.vue` | `.preview-modal-box`、`#previewCanvas` | 送出前預覽「實際會怎麼播放」（畫面），有自己獨立的一份譜面資料＋播放引擎，不影響主畫布。點「▶ 預覽」開啟，自動播放，只有一顆關閉鈕。依「切的乾淨」開關自動選其中一種：<br>①切的乾淨開：把要送出的片段當成全新獨立譜面重新解碼，從頭播到尾（跟實際送出去渲染的內容一模一樣）<br>②切的乾淨關：沿用主譜面資料，只是在自己的 canvas 上 seek 到選取範圍播放 |

## 小節 vs 逗號：兩種不同的「位置」單位

畫面上有兩套完全不同的定位系統，容易搞混：

- **小節（measure）**：播放進度條、密度圖用的單位，音樂上「第幾小節」的概念，長度隨 BPM 變化，用來做粗略的整首歌快速掃描。
- **逗號（comma）**：範圍選取起訖點、＜／＞ 導覽鍵用的單位，對應 simai 原始碼裡實際的逗號分段（每個逗號段可能只有幾個音符甚至是空拍），是精準定位、匯出裁切的真正基準。

`小節 0` 是歌曲最開頭（含前奏／pickup）；「拖進度條到最左邊」現在已經修正成真的能回到小節 0，不會卡在第一小節開頭（見前面那次修的 bug）。

## Composable 對照（邏輯層，不是畫面元件，但常會一起討論到）

| 名稱 | 檔案 | 管什麼 |
|---|---|---|
| 譜面資料 | `useChartData.js` | 載入、解碼、前處理譜面（`chartText`／`DATA`／`M`／`N`／`D`／`C`） |
| 播放引擎 | `usePlayerEngine.js` | canvas 繪製、rAF 播放迴圈、seek／導覽運算、`measureIndex`/`measureTime` |
| 範圍選取 | `useRangeSelection.js` | 起訖點狀態、密度圖繪製、範圍標籤/時長計算 |
| 音效 | `useSfx.js` | 音效模式、音量、`audioManager` 包裝 |
| Discord 連線 | `useDiscordSession.js` | 真實 Discord 分支／本機預覽模式分支 |
| 除錯記錄 | `useDebugLogging.js` | `sendBeacon` 回報、全域錯誤攔截 |

```

# app/vite.config.js

```js
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: __dirname,
  // 相對路徑：Discord 的 /.proxy/ 只重寫文件路徑前綴，
  // 若資源用根路徑 (/assets/x.js) 在真的 Discord 裡會 404
  base: './',
  plugins: [vue()],
  build: {
    outDir: path.resolve(__dirname, '../public'),
    emptyOutDir: true,
    assetsDir: 'assets',
  },
  server: {
    port: 5173,
    proxy: {
      // API 走 activity-server.js；Skin/Sounds 是 helper.js 用相對路徑 fetch 的共用素材，
      // 正式環境由 activity-server.js 的 engine/ fallback 提供，dev 模式下一併代理過去
      '/api': { target: `http://localhost:${process.env.ACTIVITY_PORT ?? 3000}`, changeOrigin: true },
      '/Skin': { target: `http://localhost:${process.env.ACTIVITY_PORT ?? 3000}`, changeOrigin: true },
      '/Sounds': { target: `http://localhost:${process.env.ACTIVITY_PORT ?? 3000}`, changeOrigin: true },
    },
  },
});

```

# public/assets/index-CbI9ubeI.js

```js
var e=Object.defineProperty,t=(t,n)=>{let r={};for(var i in t)e(r,i,{get:t[i],enumerable:!0});return n||e(r,Symbol.toStringTag,{value:`Module`}),r};(function(){let e=document.createElement(`link`).relList;if(e&&e.supports&&e.supports(`modulepreload`))return;for(let e of document.querySelectorAll(`link[rel="modulepreload"]`))n(e);new MutationObserver(e=>{for(let t of e)if(t.type===`childList`)for(let e of t.addedNodes)e.tagName===`LINK`&&e.rel===`modulepreload`&&n(e)}).observe(document,{childList:!0,subtree:!0});function t(e){let t={};return e.integrity&&(t.integrity=e.integrity),e.referrerPolicy&&(t.referrerPolicy=e.referrerPolicy),e.crossOrigin===`use-credentials`?t.credentials=`include`:e.crossOrigin===`anonymous`?t.credentials=`omit`:t.credentials=`same-origin`,t}function n(e){if(e.ep)return;e.ep=!0;let n=t(e);fetch(e.href,n)}})();function n(e){let t=Object.create(null);for(let n of e.split(`,`))t[n]=1;return e=>e in t}var r={},i=[],a=()=>{},o=()=>!1,s=e=>e.charCodeAt(0)===111&&e.charCodeAt(1)===110&&(e.charCodeAt(2)>122||e.charCodeAt(2)<97),c=e=>e.startsWith(`onUpdate:`),l=Object.assign,u=(e,t)=>{let n=e.indexOf(t);n>-1&&e.splice(n,1)},d=Object.prototype.hasOwnProperty,f=(e,t)=>d.call(e,t),p=Array.isArray,m=e=>C(e)===`[object Map]`,h=e=>C(e)===`[object Set]`,g=e=>C(e)===`[object Date]`,_=e=>typeof e==`function`,v=e=>typeof e==`string`,y=e=>typeof e==`symbol`,b=e=>typeof e==`object`&&!!e,x=e=>(b(e)||_(e))&&_(e.then)&&_(e.catch),S=Object.prototype.toString,C=e=>S.call(e),w=e=>C(e).slice(8,-1),ee=e=>C(e)===`[object Object]`,te=e=>v(e)&&e!==`NaN`&&e[0]!==`-`&&``+parseInt(e,10)===e,ne=n(`,key,ref,ref_for,ref_key,onVnodeBeforeMount,onVnodeMounted,onVnodeBeforeUpdate,onVnodeUpdated,onVnodeBeforeUnmount,onVnodeUnmounted`),T=e=>{let t=Object.create(null);return(n=>t[n]||(t[n]=e(n)))},re=/-\w/g,ie=T(e=>e.replace(re,e=>e.slice(1).toUpperCase())),ae=/\B([A-Z])/g,oe=T(e=>e.replace(ae,`-$1`).toLowerCase()),se=T(e=>e.charAt(0).toUpperCase()+e.slice(1)),ce=T(e=>e?`on${se(e)}`:``),E=(e,t)=>!Object.is(e,t),le=(e,...t)=>{for(let n=0;n<e.length;n++)e[n](...t)},ue=(e,t,n,r=!1)=>{Object.defineProperty(e,t,{configurable:!0,enumerable:!1,writable:r,value:n})},D=e=>{let t=parseFloat(e);return isNaN(t)?e:t},de,fe=()=>de||=typeof globalThis<`u`?globalThis:typeof self<`u`?self:typeof window<`u`?window:typeof global<`u`?global:{};function pe(e){if(p(e)){let t={};for(let n=0;n<e.length;n++){let r=e[n],i=v(r)?_e(r):pe(r);if(i)for(let e in i)t[e]=i[e]}return t}else if(v(e)||b(e))return e}var me=/;(?![^(]*\))/g,he=/:([^]+)/,ge=/\/\*[^]*?\*\//g;function _e(e){let t={};return e.replace(ge,``).split(me).forEach(e=>{if(e){let n=e.split(he);n.length>1&&(t[n[0].trim()]=n[1].trim())}}),t}function ve(e){let t=``;if(v(e))t=e;else if(p(e))for(let n=0;n<e.length;n++){let r=ve(e[n]);r&&(t+=r+` `)}else if(b(e))for(let n in e)e[n]&&(t+=n+` `);return t.trim()}var ye=`itemscope,allowfullscreen,formnovalidate,ismap,nomodule,novalidate,readonly`,be=n(ye);ye+``;function xe(e){return!!e||e===``}function Se(e,t){if(e.length!==t.length)return!1;let n=!0;for(let r=0;n&&r<e.length;r++)n=Ce(e[r],t[r]);return n}function Ce(e,t){if(e===t)return!0;let n=g(e),r=g(t);if(n||r)return n&&r?e.getTime()===t.getTime():!1;if(n=y(e),r=y(t),n||r)return e===t;if(n=p(e),r=p(t),n||r)return n&&r?Se(e,t):!1;if(n=b(e),r=b(t),n||r){if(!n||!r||Object.keys(e).length!==Object.keys(t).length)return!1;for(let n in e){let r=e.hasOwnProperty(n),i=t.hasOwnProperty(n);if(r&&!i||!r&&i||!Ce(e[n],t[n]))return!1}}return String(e)===String(t)}function we(e,t){return e.findIndex(e=>Ce(e,t))}var Te=e=>!!(e&&e.__v_isRef===!0),O=e=>v(e)?e:e==null?``:p(e)||b(e)&&(e.toString===S||!_(e.toString))?Te(e)?O(e.value):JSON.stringify(e,Ee,2):String(e),Ee=(e,t)=>Te(t)?Ee(e,t.value):m(t)?{[`Map(${t.size})`]:[...t.entries()].reduce((e,[t,n],r)=>(e[De(t,r)+` =>`]=n,e),{})}:h(t)?{[`Set(${t.size})`]:[...t.values()].map(e=>De(e))}:y(t)?De(t):b(t)&&!p(t)&&!ee(t)?String(t):t,De=(e,t=``)=>y(e)?`Symbol(${e.description??t})`:e,Oe,k=class{constructor(e=!1){this.detached=e,this._active=!0,this._on=0,this.effects=[],this.cleanups=[],this._isPaused=!1,this._warnOnRun=!0,this.__v_skip=!0,!e&&Oe&&(Oe.active?(this.parent=Oe,this.index=(Oe.scopes||=[]).push(this)-1):(this._active=!1,this._warnOnRun=!1))}get active(){return this._active}pause(){if(this._active){this._isPaused=!0;let e,t;if(this.scopes){let n=this.scopes.slice();for(e=0,t=n.length;e<t;e++)n[e].pause()}for(e=0,t=this.effects.length;e<t;e++)this.effects[e].pause()}}resume(){if(this._active&&this._isPaused){this._isPaused=!1;let e,t;if(this.scopes){let n=this.scopes.slice();for(e=0,t=n.length;e<t;e++)n[e].resume()}let n=this.effects.slice();for(e=0,t=n.length;e<t;e++)n[e].resume()}}run(e){if(this._active){let t=Oe;try{return Oe=this,e()}finally{Oe=t}}}on(){++this._on===1&&(this.prevScope=Oe,Oe=this)}off(){if(this._on>0&&--this._on===0){if(Oe===this)Oe=this.prevScope;else{let e=Oe;for(;e;){if(e.prevScope===this){e.prevScope=this.prevScope;break}e=e.prevScope}}this.prevScope=void 0}}stop(e){if(this._active){this._active=!1;let t,n;for(t=0,n=this.effects.length;t<n;t++)this.effects[t].stop();for(this.effects.length=0,t=0,n=this.cleanups.length;t<n;t++)this.cleanups[t]();if(this.cleanups.length=0,this.scopes){let e=this.scopes.slice();for(t=0,n=e.length;t<n;t++)e[t].stop(!0);this.scopes.length=0}if(!this.detached&&this.parent&&!e){let e=this.parent.scopes.pop();e&&e!==this&&(this.parent.scopes[this.index]=e,e.index=this.index)}this.parent=void 0}}};function ke(){return Oe}var Ae,je=new WeakSet,Me=class{constructor(e){this.fn=e,this.deps=void 0,this.depsTail=void 0,this.flags=5,this.next=void 0,this.cleanup=void 0,this.scheduler=void 0,Oe&&(Oe.active?Oe.effects.push(this):this.flags&=-2)}pause(){this.flags|=64}resume(){this.flags&64&&(this.flags&=-65,je.has(this)&&(je.delete(this),this.trigger()))}notify(){this.flags&2&&!(this.flags&32)||this.flags&8||Ie(this)}run(){if(!(this.flags&1))return this.fn();this.flags|=2,Ye(this),ze(this);let e=Ae,t=Ge;Ae=this,Ge=!0;try{return this.fn()}finally{Be(this),Ae=e,Ge=t,this.flags&=-3}}stop(){if(this.flags&1){for(let e=this.deps;e;e=e.nextDep)Ue(e);this.deps=this.depsTail=void 0,Ye(this),this.onStop&&this.onStop(),this.flags&=-2}}trigger(){this.flags&64?je.add(this):this.scheduler?this.scheduler():this.runIfDirty()}runIfDirty(){Ve(this)&&this.run()}get dirty(){return Ve(this)}},Ne=0,Pe,Fe;function Ie(e,t=!1){if(e.flags|=8,t){e.next=Fe,Fe=e;return}e.next=Pe,Pe=e}function Le(){Ne++}function Re(){if(--Ne>0)return;if(Fe){let e=Fe;for(Fe=void 0;e;){let t=e.next;e.next=void 0,e.flags&=-9,e=t}}let e;for(;Pe;){let t=Pe;for(Pe=void 0;t;){let n=t.next;if(t.next=void 0,t.flags&=-9,t.flags&1)try{t.trigger()}catch(t){e||=t}t=n}}if(e)throw e}function ze(e){for(let t=e.deps;t;t=t.nextDep)t.version=-1,t.prevActiveLink=t.dep.activeLink,t.dep.activeLink=t}function Be(e){let t,n=e.depsTail,r=n;for(;r;){let e=r.prevDep;r.version===-1?(r===n&&(n=e),Ue(r),We(r)):t=r,r.dep.activeLink=r.prevActiveLink,r.prevActiveLink=void 0,r=e}e.deps=t,e.depsTail=n}function Ve(e){for(let t=e.deps;t;t=t.nextDep)if(t.dep.version!==t.version||t.dep.computed&&(He(t.dep.computed)||t.dep.version!==t.version))return!0;return!!e._dirty}function He(e){if(e.flags&4&&!(e.flags&16)||(e.flags&=-17,e.globalVersion===Xe)||(e.globalVersion=Xe,!e.isSSR&&e.flags&128&&(!e.deps&&!e._dirty||!Ve(e))))return;e.flags|=2;let t=e.dep,n=Ae,r=Ge;Ae=e,Ge=!0;try{ze(e);let n=e.fn(e._value);(t.version===0||E(n,e._value))&&(e.flags|=128,e._value=n,t.version++)}catch(e){throw t.version++,e}finally{Ae=n,Ge=r,Be(e),e.flags&=-3}}function Ue(e,t=!1){let{dep:n,prevSub:r,nextSub:i}=e;if(r&&(r.nextSub=i,e.prevSub=void 0),i&&(i.prevSub=r,e.nextSub=void 0),n.subs===e&&(n.subs=r,!r&&n.computed)){n.computed.flags&=-5;for(let e=n.computed.deps;e;e=e.nextDep)Ue(e,!0)}!t&&!--n.sc&&n.map&&n.map.delete(n.key)}function We(e){let{prevDep:t,nextDep:n}=e;t&&(t.nextDep=n,e.prevDep=void 0),n&&(n.prevDep=t,e.nextDep=void 0)}var Ge=!0,Ke=[];function qe(){Ke.push(Ge),Ge=!1}function Je(){let e=Ke.pop();Ge=e===void 0||e}function Ye(e){let{cleanup:t}=e;if(e.cleanup=void 0,t){let e=Ae;Ae=void 0;try{t()}finally{Ae=e}}}var Xe=0,Ze=class{constructor(e,t){this.sub=e,this.dep=t,this.version=t.version,this.nextDep=this.prevDep=this.nextSub=this.prevSub=this.prevActiveLink=void 0}},Qe=class{constructor(e){this.computed=e,this.version=0,this.activeLink=void 0,this.subs=void 0,this.map=void 0,this.key=void 0,this.sc=0,this.__v_skip=!0}track(e){if(!Ae||!Ge||Ae===this.computed)return;let t=this.activeLink;if(t===void 0||t.sub!==Ae)t=this.activeLink=new Ze(Ae,this),Ae.deps?(t.prevDep=Ae.depsTail,Ae.depsTail.nextDep=t,Ae.depsTail=t):Ae.deps=Ae.depsTail=t,$e(t);else if(t.version===-1&&(t.version=this.version,t.nextDep)){let e=t.nextDep;e.prevDep=t.prevDep,t.prevDep&&(t.prevDep.nextDep=e),t.prevDep=Ae.depsTail,t.nextDep=void 0,Ae.depsTail.nextDep=t,Ae.depsTail=t,Ae.deps===t&&(Ae.deps=e)}return t}trigger(e){this.version++,Xe++,this.notify(e)}notify(e){Le();try{for(let e=this.subs;e;e=e.prevSub)e.sub.notify()&&e.sub.dep.notify()}finally{Re()}}};function $e(e){if(e.dep.sc++,e.sub.flags&4){let t=e.dep.computed;if(t&&!e.dep.subs){t.flags|=20;for(let e=t.deps;e;e=e.nextDep)$e(e)}let n=e.dep.subs;n!==e&&(e.prevSub=n,n&&(n.nextSub=e)),e.dep.subs=e}}var et=new WeakMap,tt=Symbol(``),nt=Symbol(``),rt=Symbol(``);function it(e,t,n){if(Ge&&Ae){let t=et.get(e);t||et.set(e,t=new Map);let r=t.get(n);r||(t.set(n,r=new Qe),r.map=t,r.key=n),r.track()}}function at(e,t,n,r,i,a){let o=et.get(e);if(!o){Xe++;return}let s=e=>{e&&e.trigger()};if(Le(),t===`clear`)o.forEach(s);else{let i=p(e),a=i&&te(n);if(i&&n===`length`){let e=Number(r);o.forEach((t,n)=>{(n===`length`||n===rt||!y(n)&&n>=e)&&s(t)})}else switch((n!==void 0||o.has(void 0))&&s(o.get(n)),a&&s(o.get(rt)),t){case`add`:i?a&&s(o.get(`length`)):(s(o.get(tt)),m(e)&&s(o.get(nt)));break;case`delete`:i||(s(o.get(tt)),m(e)&&s(o.get(nt)));break;case`set`:m(e)&&s(o.get(tt));break}}Re()}function ot(e){let t=qt(e);return t===e?t:(it(t,`iterate`,rt),Gt(e)?t:t.map(Yt))}function st(e){return it(e=qt(e),`iterate`,rt),e}function ct(e,t){return Wt(e)?Xt(Ut(e)?Yt(t):t):Yt(t)}var lt={__proto__:null,[Symbol.iterator](){return ut(this,Symbol.iterator,e=>ct(this,e))},concat(...e){return ot(this).concat(...e.map(e=>p(e)?ot(e):e))},entries(){return ut(this,`entries`,e=>(e[1]=ct(this,e[1]),e))},every(e,t){return ft(this,`every`,e,t,void 0,arguments)},filter(e,t){return ft(this,`filter`,e,t,e=>e.map(e=>ct(this,e)),arguments)},find(e,t){return ft(this,`find`,e,t,e=>ct(this,e),arguments)},findIndex(e,t){return ft(this,`findIndex`,e,t,void 0,arguments)},findLast(e,t){return ft(this,`findLast`,e,t,e=>ct(this,e),arguments)},findLastIndex(e,t){return ft(this,`findLastIndex`,e,t,void 0,arguments)},forEach(e,t){return ft(this,`forEach`,e,t,void 0,arguments)},includes(...e){return mt(this,`includes`,e)},indexOf(...e){return mt(this,`indexOf`,e)},join(e){return ot(this).join(e)},lastIndexOf(...e){return mt(this,`lastIndexOf`,e)},map(e,t){return ft(this,`map`,e,t,void 0,arguments)},pop(){return ht(this,`pop`)},push(...e){return ht(this,`push`,e)},reduce(e,...t){return pt(this,`reduce`,e,t)},reduceRight(e,...t){return pt(this,`reduceRight`,e,t)},shift(){return ht(this,`shift`)},some(e,t){return ft(this,`some`,e,t,void 0,arguments)},splice(...e){return ht(this,`splice`,e)},toReversed(){return ot(this).toReversed()},toSorted(e){return ot(this).toSorted(e)},toSpliced(...e){return ot(this).toSpliced(...e)},unshift(...e){return ht(this,`unshift`,e)},values(){return ut(this,`values`,e=>ct(this,e))}};function ut(e,t,n){let r=st(e),i=r[t]();return r!==e&&!Gt(e)&&(i._next=i.next,i.next=()=>{let e=i._next();return e.done||(e.value=n(e.value)),e}),i}var dt=Array.prototype;function ft(e,t,n,r,i,a){let o=st(e),s=o!==e&&!Gt(e),c=o[t];if(c!==dt[t]){let t=c.apply(e,a);return s?Yt(t):t}let l=n;o!==e&&(s?l=function(t,r){return n.call(this,ct(e,t),r,e)}:n.length>2&&(l=function(t,r){return n.call(this,t,r,e)}));let u=c.call(o,l,r);return s&&i?i(u):u}function pt(e,t,n,r){let i=st(e),a=i!==e&&!Gt(e),o=n,s=!1;i!==e&&(a?(s=r.length===0,o=function(t,r,i){return s&&(s=!1,t=ct(e,t)),n.call(this,t,ct(e,r),i,e)}):n.length>3&&(o=function(t,r,i){return n.call(this,t,r,i,e)}));let c=i[t](o,...r);return s?ct(e,c):c}function mt(e,t,n){let r=qt(e);it(r,`iterate`,rt);let i=r[t](...n);return(i===-1||i===!1)&&Kt(n[0])?(n[0]=qt(n[0]),r[t](...n)):i}function ht(e,t,n=[]){qe(),Le();let r=qt(e)[t].apply(e,n);return Re(),Je(),r}var gt=n(`__proto__,__v_isRef,__isVue`),_t=new Set(Object.getOwnPropertyNames(Symbol).filter(e=>e!==`arguments`&&e!==`caller`).map(e=>Symbol[e]).filter(y));function vt(e){y(e)||(e=String(e));let t=qt(this);return it(t,`has`,e),t.hasOwnProperty(e)}var yt=class{constructor(e=!1,t=!1){this._isReadonly=e,this._isShallow=t}get(e,t,n){if(t===`__v_skip`)return e.__v_skip;let r=this._isReadonly,i=this._isShallow;if(t===`__v_isReactive`)return!r;if(t===`__v_isReadonly`)return r;if(t===`__v_isShallow`)return i;if(t===`__v_raw`)return n===(r?i?Lt:It:i?Ft:Pt).get(e)||Object.getPrototypeOf(e)===Object.getPrototypeOf(n)?e:void 0;let a=p(e);if(!r){let e;if(a&&(e=lt[t]))return e;if(t===`hasOwnProperty`)return vt}let o=Reflect.get(e,t,Zt(e)?e:n);if((y(t)?_t.has(t):gt(t))||(r||it(e,`get`,t),i))return o;if(Zt(o)){let e=a&&te(t)?o:o.value;return r&&b(e)?Vt(e):e}return b(o)?r?Vt(o):zt(o):o}},bt=class extends yt{constructor(e=!1){super(!1,e)}set(e,t,n,r){let i=e[t],a=p(e)&&te(t);if(!this._isShallow){let e=Wt(i);if(!Gt(n)&&!Wt(n)&&(i=qt(i),n=qt(n)),!a&&Zt(i)&&!Zt(n))return e||(i.value=n),!0}let o=a?Number(t)<e.length:f(e,t),s=Reflect.set(e,t,n,Zt(e)?e:r);return e===qt(r)&&s&&(o?E(n,i)&&at(e,`set`,t,n,i):at(e,`add`,t,n)),s}deleteProperty(e,t){let n=f(e,t),r=e[t],i=Reflect.deleteProperty(e,t);return i&&n&&at(e,`delete`,t,void 0,r),i}has(e,t){let n=Reflect.has(e,t);return(!y(t)||!_t.has(t))&&it(e,`has`,t),n}ownKeys(e){return it(e,`iterate`,p(e)?`length`:tt),Reflect.ownKeys(e)}},xt=class extends yt{constructor(e=!1){super(!0,e)}set(e,t){return!0}deleteProperty(e,t){return!0}},St=new bt,Ct=new xt,wt=new bt(!0),Tt=e=>e,Et=e=>Reflect.getPrototypeOf(e);function Dt(e,t,n){return function(...r){let i=this.__v_raw,a=qt(i),o=m(a),s=e===`entries`||e===Symbol.iterator&&o,c=e===`keys`&&o,u=i[e](...r),d=n?Tt:t?Xt:Yt;return!t&&it(a,`iterate`,c?nt:tt),l(Object.create(u),{next(){let{value:e,done:t}=u.next();return t?{value:e,done:t}:{value:s?[d(e[0]),d(e[1])]:d(e),done:t}}})}}function Ot(e){return function(...t){return e===`delete`?!1:e===`clear`?void 0:this}}function kt(e,t){let n={get(n){let r=this.__v_raw,i=qt(r),a=qt(n);e||(E(n,a)&&it(i,`get`,n),it(i,`get`,a));let{has:o}=Et(i),s=t?Tt:e?Xt:Yt;if(o.call(i,n))return s(r.get(n));if(o.call(i,a))return s(r.get(a));r!==i&&r.get(n)},get size(){let t=this.__v_raw;return!e&&it(qt(t),`iterate`,tt),t.size},has(t){let n=this.__v_raw,r=qt(n),i=qt(t);return e||(E(t,i)&&it(r,`has`,t),it(r,`has`,i)),t===i?n.has(t):n.has(t)||n.has(i)},forEach(n,r){let i=this,a=i.__v_raw,o=qt(a),s=t?Tt:e?Xt:Yt;return!e&&it(o,`iterate`,tt),a.forEach((e,t)=>n.call(r,s(e),s(t),i))}};return l(n,e?{add:Ot(`add`),set:Ot(`set`),delete:Ot(`delete`),clear:Ot(`clear`)}:{add(e){let n=qt(this),r=Et(n),i=qt(e),a=!t&&!Gt(e)&&!Wt(e)?i:e;return r.has.call(n,a)||E(e,a)&&r.has.call(n,e)||E(i,a)&&r.has.call(n,i)||(n.add(a),at(n,`add`,a,a)),this},set(e,n){!t&&!Gt(n)&&!Wt(n)&&(n=qt(n));let r=qt(this),{has:i,get:a}=Et(r),o=i.call(r,e);o||=(e=qt(e),i.call(r,e));let s=a.call(r,e);return r.set(e,n),o?E(n,s)&&at(r,`set`,e,n,s):at(r,`add`,e,n),this},delete(e){let t=qt(this),{has:n,get:r}=Et(t),i=n.call(t,e);i||=(e=qt(e),n.call(t,e));let a=r?r.call(t,e):void 0,o=t.delete(e);return i&&at(t,`delete`,e,void 0,a),o},clear(){let e=qt(this),t=e.size!==0,n=e.clear();return t&&at(e,`clear`,void 0,void 0,void 0),n}}),[`keys`,`values`,`entries`,Symbol.iterator].forEach(r=>{n[r]=Dt(r,e,t)}),n}function At(e,t){let n=kt(e,t);return(t,r,i)=>r===`__v_isReactive`?!e:r===`__v_isReadonly`?e:r===`__v_raw`?t:Reflect.get(f(n,r)&&r in t?n:t,r,i)}var jt={get:At(!1,!1)},Mt={get:At(!1,!0)},Nt={get:At(!0,!1)},Pt=new WeakMap,Ft=new WeakMap,It=new WeakMap,Lt=new WeakMap;function Rt(e){switch(e){case`Object`:case`Array`:return 1;case`Map`:case`Set`:case`WeakMap`:case`WeakSet`:return 2;default:return 0}}function zt(e){return Wt(e)?e:Ht(e,!1,St,jt,Pt)}function Bt(e){return Ht(e,!1,wt,Mt,Ft)}function Vt(e){return Ht(e,!0,Ct,Nt,It)}function Ht(e,t,n,r,i){if(!b(e)||e.__v_raw&&!(t&&e.__v_isReactive)||e.__v_skip||!Object.isExtensible(e))return e;let a=i.get(e);if(a)return a;let o=Rt(w(e));if(o===0)return e;let s=new Proxy(e,o===2?r:n);return i.set(e,s),s}function Ut(e){return Wt(e)?Ut(e.__v_raw):!!(e&&e.__v_isReactive)}function Wt(e){return!!(e&&e.__v_isReadonly)}function Gt(e){return!!(e&&e.__v_isShallow)}function Kt(e){return e?!!e.__v_raw:!1}function qt(e){let t=e&&e.__v_raw;return t?qt(t):e}function Jt(e){return!f(e,`__v_skip`)&&Object.isExtensible(e)&&ue(e,`__v_skip`,!0),e}var Yt=e=>b(e)?zt(e):e,Xt=e=>b(e)?Vt(e):e;function Zt(e){return e?e.__v_isRef===!0:!1}function A(e){return $t(e,!1)}function Qt(e){return $t(e,!0)}function $t(e,t){return Zt(e)?e:new en(e,t)}var en=class{constructor(e,t){this.dep=new Qe,this.__v_isRef=!0,this.__v_isShallow=!1,this._rawValue=t?e:qt(e),this._value=t?e:Yt(e),this.__v_isShallow=t}get value(){return this.dep.track(),this._value}set value(e){let t=this._rawValue,n=this.__v_isShallow||Gt(e)||Wt(e);e=n?e:qt(e),E(e,t)&&(this._rawValue=e,this._value=n?e:Yt(e),this.dep.trigger())}};function j(e){return Zt(e)?e.value:e}var tn={get:(e,t,n)=>t===`__v_raw`?e:j(Reflect.get(e,t,n)),set:(e,t,n,r)=>{let i=e[t];return Zt(i)&&!Zt(n)?(i.value=n,!0):Reflect.set(e,t,n,r)}};function nn(e){return Ut(e)?e:new Proxy(e,tn)}var rn=class{constructor(e,t,n){this.fn=e,this.setter=t,this._value=void 0,this.dep=new Qe(this),this.__v_isRef=!0,this.deps=void 0,this.depsTail=void 0,this.flags=16,this.globalVersion=Xe-1,this.next=void 0,this.effect=this,this.__v_isReadonly=!t,this.isSSR=n}notify(){if(this.flags|=16,!(this.flags&8)&&Ae!==this)return Ie(this,!0),!0}get value(){let e=this.dep.track();return He(this),e&&(e.version=this.dep.version),this._value}set value(e){this.setter&&this.setter(e)}};function an(e,t,n=!1){let r,i;return _(e)?r=e:(r=e.get,i=e.set),new rn(r,i,n)}var on={},sn=new WeakMap,cn=void 0;function ln(e,t=!1,n=cn){if(n){let t=sn.get(n);t||sn.set(n,t=[]),t.push(e)}}function un(e,t,n=r){let{immediate:i,deep:o,once:s,scheduler:c,augmentJob:l,call:d}=n,f=e=>o?e:Gt(e)||o===!1||o===0?dn(e,1):dn(e),m,h,g,v,y=!1,b=!1;if(Zt(e)?(h=()=>e.value,y=Gt(e)):Ut(e)?(h=()=>f(e),y=!0):p(e)?(b=!0,y=e.some(e=>Ut(e)||Gt(e)),h=()=>e.map(e=>{if(Zt(e))return e.value;if(Ut(e))return f(e);if(_(e))return d?d(e,2):e()})):h=_(e)?t?d?()=>d(e,2):e:()=>{if(g){qe();try{g()}finally{Je()}}let t=cn;cn=m;try{return d?d(e,3,[v]):e(v)}finally{cn=t}}:a,t&&o){let e=h,t=o===!0?1/0:o;h=()=>dn(e(),t)}let x=ke(),S=()=>{m.stop(),x&&x.active&&u(x.effects,m)};if(s&&t){let e=t;t=(...t)=>{let n=e(...t);return S(),n}}let C=b?Array(e.length).fill(on):on,w=e=>{if(!(!(m.flags&1)||!m.dirty&&!e))if(t){let n=m.run();if(e||o||y||(b?n.some((e,t)=>E(e,C[t])):E(n,C))){g&&g();let e=cn;cn=m;try{let e=[n,C===on?void 0:b&&C[0]===on?[]:C,v];C=n,d?d(t,3,e):t(...e)}finally{cn=e}}}else m.run()};return l&&l(w),m=new Me(h),m.scheduler=c?()=>c(w,!1):w,v=e=>ln(e,!1,m),g=m.onStop=()=>{let e=sn.get(m);if(e){if(d)d(e,4);else for(let t of e)t();sn.delete(m)}},t?i?w(!0):C=m.run():c?c(w.bind(null,!0),!0):m.run(),S.pause=m.pause.bind(m),S.resume=m.resume.bind(m),S.stop=S,S}function dn(e,t=1/0,n){if(t<=0||!b(e)||e.__v_skip||(n||=new Map,(n.get(e)||0)>=t))return e;if(n.set(e,t),t--,Zt(e))dn(e.value,t,n);else if(p(e))for(let r=0;r<e.length;r++)dn(e[r],t,n);else if(h(e)||m(e))e.forEach(e=>{dn(e,t,n)});else if(ee(e)){for(let r in e)dn(e[r],t,n);for(let r of Object.getOwnPropertySymbols(e))Object.prototype.propertyIsEnumerable.call(e,r)&&dn(e[r],t,n)}return e}function fn(e,t,n,r){try{return r?e(...r):e()}catch(e){mn(e,t,n)}}function pn(e,t,n,r){if(_(e)){let i=fn(e,t,n,r);return i&&x(i)&&i.catch(e=>{mn(e,t,n)}),i}if(p(e)){let i=[];for(let a=0;a<e.length;a++)i.push(pn(e[a],t,n,r));return i}}function mn(e,t,n,i=!0){let a=t?t.vnode:null,{errorHandler:o,throwUnhandledErrorInProduction:s}=t&&t.appContext.config||r;if(t){let r=t.parent,i=t.proxy,a=`https://vuejs.org/error-reference/#runtime-${n}`;for(;r;){let t=r.ec;if(t){for(let n=0;n<t.length;n++)if(t[n](e,i,a)===!1)return}r=r.parent}if(o){qe(),fn(o,null,10,[e,i,a]),Je();return}}hn(e,n,a,i,s)}function hn(e,t,n,r=!0,i=!1){if(i)throw e;console.error(e)}var gn=[],_n=-1,vn=[],yn=null,bn=0,xn=Promise.resolve(),Sn=null;function Cn(e){let t=Sn||xn;return e?t.then(this?e.bind(this):e):t}function wn(e){let t=_n+1,n=gn.length;for(;t<n;){let r=t+n>>>1,i=gn[r],a=An(i);a<e||a===e&&i.flags&2?t=r+1:n=r}return t}function Tn(e){if(!(e.flags&1)){let t=An(e),n=gn[gn.length-1];!n||!(e.flags&2)&&t>=An(n)?gn.push(e):gn.splice(wn(t),0,e),e.flags|=1,En()}}function En(){Sn||=xn.then(jn)}function Dn(e){p(e)?vn.push(...e):yn&&e.id===-1?yn.splice(bn+1,0,e):e.flags&1||(vn.push(e),e.flags|=1),En()}function On(e,t,n=_n+1){for(;n<gn.length;n++){let t=gn[n];if(t&&t.flags&2){if(e&&t.id!==e.uid)continue;gn.splice(n,1),n--,t.flags&4&&(t.flags&=-2),t(),t.flags&4||(t.flags&=-2)}}}function kn(e){if(vn.length){let e=[...new Set(vn)].sort((e,t)=>An(e)-An(t));if(vn.length=0,yn){yn.push(...e);return}for(yn=e,bn=0;bn<yn.length;bn++){let e=yn[bn];e.flags&4&&(e.flags&=-2),e.flags&8||e(),e.flags&=-2}yn=null,bn=0}}var An=e=>e.id==null?e.flags&2?-1:1/0:e.id;function jn(e){try{for(_n=0;_n<gn.length;_n++){let e=gn[_n];e&&!(e.flags&8)&&(e.flags&4&&(e.flags&=-2),fn(e,e.i,e.i?15:14),e.flags&4||(e.flags&=-2))}}finally{for(;_n<gn.length;_n++){let e=gn[_n];e&&(e.flags&=-2)}_n=-1,gn.length=0,kn(e),Sn=null,(gn.length||vn.length)&&jn(e)}}var Mn=null,Nn=null;function Pn(e){let t=Mn;return Mn=e,Nn=e&&e.type.__scopeId||null,t}function Fn(e,t=Mn,n){if(!t||e._n)return e;let r=(...n)=>{r._d&&Ui(-1);let i=Pn(t),a=Ri.length,o;try{o=e(...n)}finally{for(let e=Ri.length;e>a;e--)Vi();Pn(i),r._d&&Ui(1)}return o};return r._n=!0,r._c=!0,r._d=!0,r}function In(e,t){if(Mn===null)return e;let n=Oa(Mn),i=e.dirs||=[];for(let e=0;e<t.length;e++){let[a,o,s,c=r]=t[e];a&&(_(a)&&(a={mounted:a,updated:a}),a.deep&&dn(o),i.push({dir:a,instance:n,value:o,oldValue:void 0,arg:s,modifiers:c}))}return e}function Ln(e,t,n,r){let i=e.dirs,a=t&&t.dirs;for(let o=0;o<i.length;o++){let s=i[o];a&&(s.oldValue=a[o].value);let c=s.dir[r];c&&(qe(),pn(c,n,8,[e.el,s,e,t]),Je())}}function Rn(e,t){if(fa){let n=fa.provides,r=fa.parent&&fa.parent.provides;r===n&&(n=fa.provides=Object.create(r)),n[e]=t}}function zn(e,t,n=!1){let r=pa();if(r||Wr){let i=Wr?Wr._context.provides:r?r.parent==null||r.ce?r.vnode.appContext&&r.vnode.appContext.provides:r.parent.provides:void 0;if(i&&e in i)return i[e];if(arguments.length>1)return n&&_(t)?t.call(r&&r.proxy):t}}var Bn=Symbol.for(`v-scx`),Vn=()=>zn(Bn);function Hn(e,t,n){return Un(e,t,n)}function Un(e,t,n=r){let{immediate:i,deep:o,flush:s,once:c}=n,u=l({},n),d=t&&i||!t&&s!==`post`,f;if(ya){if(s===`sync`){let e=Vn();f=e.__watcherHandles||=[]}else if(!d){let e=()=>{};return e.stop=a,e.resume=a,e.pause=a,e}}let p=fa;u.call=(e,t,n)=>pn(e,p,t,n);let m=!1;s===`post`?u.scheduler=e=>{xi(e,p&&p.suspense)}:s!==`sync`&&(m=!0,u.scheduler=(e,t)=>{t?e():Tn(e)}),u.augmentJob=e=>{t&&(e.flags|=4),m&&(e.flags|=2,p&&(e.id=p.uid,e.i=p))};let h=un(e,t,u);return ya&&(f?f.push(h):d&&h()),h}function Wn(e,t,n){let r=this.proxy,i=v(e)?e.includes(`.`)?Gn(r,e):()=>r[e]:e.bind(r,r),a;_(t)?a=t:(a=t.handler,n=t);let o=ga(this),s=Un(i,a.bind(r),n);return o(),s}function Gn(e,t){let n=t.split(`.`);return()=>{let t=e;for(let e=0;e<n.length&&t;e++)t=t[n[e]];return t}}var Kn=Symbol(`_vte`),qn=e=>e.__isTeleport,Jn=Symbol(`_leaveCb`);function Yn(e,t){e.shapeFlag&6&&e.component?(e.transition=t,Yn(e.component.subTree,t)):e.shapeFlag&128?(e.ssContent.transition=t.clone(e.ssContent),e.ssFallback.transition=t.clone(e.ssFallback)):e.transition=t}function Xn(e){e.ids=[e.ids[0]+e.ids[2]+++`-`,0,0]}function Zn(e,t){let n;return!!((n=Object.getOwnPropertyDescriptor(e,t))&&!n.configurable)}var Qn=new WeakMap;function $n(e,t,n,i,a=!1){if(p(e)){e.forEach((e,r)=>$n(e,t&&(p(t)?t[r]:t),n,i,a));return}if(tr(i)&&!a){i.shapeFlag&512&&i.type.__asyncResolved&&i.component.subTree.component&&$n(e,t,n,i.component.subTree);return}let s=i.shapeFlag&4?Oa(i.component):i.el,c=a?null:s,{i:l,r:d}=e,m=t&&t.r,h=l.refs===r?l.refs={}:l.refs,g=l.setupState,y=qt(g),b=g===r?o:e=>!Zn(h,e)&&f(y,e),x=(e,t)=>!(t&&Zn(h,t));if(m!=null&&m!==d){if(er(t),v(m))h[m]=null,b(m)&&(g[m]=null);else if(Zt(m)){let e=t;x(m,e.k)&&(m.value=null),e.k&&(h[e.k]=null)}}if(_(d))fn(d,l,12,[c,h]);else{let t=v(d),r=Zt(d);if(t||r){let i=()=>{if(e.f){let n=t?b(d)?g[d]:h[d]:x(d)||!e.k?d.value:h[e.k];if(a)p(n)&&u(n,s);else if(p(n))n.includes(s)||n.push(s);else if(t)h[d]=[s],b(d)&&(g[d]=h[d]);else{let t=[s];x(d,e.k)&&(d.value=t),e.k&&(h[e.k]=t)}}else t?(h[d]=c,b(d)&&(g[d]=c)):r&&(x(d,e.k)&&(d.value=c),e.k&&(h[e.k]=c))};if(c){let t=()=>{i(),Qn.delete(e)};t.id=-1,Qn.set(e,t),xi(t,n)}else er(e),i()}}}function er(e){let t=Qn.get(e);t&&(t.flags|=8,Qn.delete(e))}fe().requestIdleCallback,fe().cancelIdleCallback;var tr=e=>!!e.type.__asyncLoader,nr=e=>e.type.__isKeepAlive;function rr(e,t){ar(e,`a`,t)}function ir(e,t){ar(e,`da`,t)}function ar(e,t,n=fa){let r=e.__wdc||=()=>{let t=n;for(;t;){if(t.isDeactivated)return;t=t.parent}return e()};if(sr(t,r,n),n){let e=n.parent;for(;e&&e.parent;)nr(e.parent.vnode)&&or(r,t,n,e),e=e.parent}}function or(e,t,n,r){let i=sr(t,e,r,!0);mr(()=>{u(r[t],i)},n)}function sr(e,t,n=fa,r=!1){if(n){let i=n[e]||(n[e]=[]),a=t.__weh||=(...r)=>{qe();let i=ga(n),a=pn(t,n,e,r);return i(),Je(),a};return r?i.unshift(a):i.push(a),a}}var cr=e=>(t,n=fa)=>{(!ya||e===`sp`)&&sr(e,(...e)=>t(...e),n)},lr=cr(`bm`),ur=cr(`m`),dr=cr(`bu`),fr=cr(`u`),pr=cr(`bum`),mr=cr(`um`),hr=cr(`sp`),gr=cr(`rtg`),_r=cr(`rtc`);function vr(e,t=fa){sr(`ec`,e,t)}var yr=Symbol.for(`v-ndc`);function br(e,t,n,r){let i,a=n&&n[r],o=p(e);if(o||v(e)){let n=o&&Ut(e),r=!1,s=!1;n&&(r=!Gt(e),s=Wt(e),e=st(e)),i=Array(e.length);for(let n=0,o=e.length;n<o;n++)i[n]=t(r?s?Xt(Yt(e[n])):Yt(e[n]):e[n],n,void 0,a&&a[n])}else if(typeof e==`number`){i=Array(e);for(let n=0;n<e;n++)i[n]=t(n+1,n,void 0,a&&a[n])}else if(b(e))if(e[Symbol.iterator])i=Array.from(e,(e,n)=>t(e,n,void 0,a&&a[n]));else{let n=Object.keys(e);i=Array(n.length);for(let r=0,o=n.length;r<o;r++){let o=n[r];i[r]=t(e[o],o,r,a&&a[r])}}else i=[];return n&&(n[r]=i),i}var xr=e=>e?va(e)?Oa(e):xr(e.parent):null,Sr=l(Object.create(null),{$:e=>e,$el:e=>e.vnode.el,$data:e=>e.data,$props:e=>e.props,$attrs:e=>e.attrs,$slots:e=>e.slots,$refs:e=>e.refs,$parent:e=>xr(e.parent),$root:e=>xr(e.root),$host:e=>e.ce,$emit:e=>e.emit,$options:e=>jr(e),$forceUpdate:e=>e.f||=()=>{Tn(e.update)},$nextTick:e=>e.n||=Cn.bind(e.proxy),$watch:e=>Wn.bind(e)}),Cr=(e,t)=>e!==r&&!e.__isScriptSetup&&f(e,t),wr={get({_:e},t){if(t===`__v_skip`)return!0;let{ctx:n,setupState:i,data:a,props:o,accessCache:s,type:c,appContext:l}=e;if(t[0]!==`$`){let e=s[t];if(e!==void 0)switch(e){case 1:return i[t];case 2:return a[t];case 4:return n[t];case 3:return o[t]}else if(Cr(i,t))return s[t]=1,i[t];else if(a!==r&&f(a,t))return s[t]=2,a[t];else if(f(o,t))return s[t]=3,o[t];else if(n!==r&&f(n,t))return s[t]=4,n[t];else Er&&(s[t]=0)}let u=Sr[t],d,p;if(u)return t===`$attrs`&&it(e.attrs,`get`,``),u(e);if((d=c.__cssModules)&&(d=d[t]))return d;if(n!==r&&f(n,t))return s[t]=4,n[t];if(p=l.config.globalProperties,f(p,t))return p[t]},set({_:e},t,n){let{data:i,setupState:a,ctx:o}=e;return Cr(a,t)?(a[t]=n,!0):i!==r&&f(i,t)?(i[t]=n,!0):f(e.props,t)||t[0]===`$`&&t.slice(1)in e?!1:(o[t]=n,!0)},has({_:{data:e,setupState:t,accessCache:n,ctx:i,appContext:a,props:o,type:s}},c){let l;return!!(n[c]||e!==r&&c[0]!==`$`&&f(e,c)||Cr(t,c)||f(o,c)||f(i,c)||f(Sr,c)||f(a.config.globalProperties,c)||(l=s.__cssModules)&&l[c])},defineProperty(e,t,n){return n.get==null?f(n,`value`)&&this.set(e,t,n.value,null):e._.accessCache[t]=0,Reflect.defineProperty(e,t,n)}};function Tr(e){return p(e)?e.reduce((e,t)=>(e[t]=null,e),{}):e}var Er=!0;function Dr(e){let t=jr(e),n=e.proxy,r=e.ctx;Er=!1,t.beforeCreate&&kr(t.beforeCreate,e,`bc`);let{data:i,computed:o,methods:s,watch:c,provide:l,inject:u,created:d,beforeMount:f,mounted:m,beforeUpdate:h,updated:g,activated:v,deactivated:y,beforeDestroy:x,beforeUnmount:S,destroyed:C,unmounted:w,render:ee,renderTracked:te,renderTriggered:ne,errorCaptured:T,serverPrefetch:re,expose:ie,inheritAttrs:ae,components:oe,directives:se,filters:ce}=t;if(u&&Or(u,r,null),s)for(let e in s){let t=s[e];_(t)&&(r[e]=t.bind(n))}if(i){let t=i.call(n,n);b(t)&&(e.data=zt(t))}if(Er=!0,o)for(let e in o){let t=o[e],i=Aa({get:_(t)?t.bind(n,n):_(t.get)?t.get.bind(n,n):a,set:!_(t)&&_(t.set)?t.set.bind(n):a});Object.defineProperty(r,e,{enumerable:!0,configurable:!0,get:()=>i.value,set:e=>i.value=e})}if(c)for(let e in c)Ar(c[e],r,n,e);if(l){let e=_(l)?l.call(n):l;Reflect.ownKeys(e).forEach(t=>{Rn(t,e[t])})}d&&kr(d,e,`c`);function E(e,t){p(t)?t.forEach(t=>e(t.bind(n))):t&&e(t.bind(n))}if(E(lr,f),E(ur,m),E(dr,h),E(fr,g),E(rr,v),E(ir,y),E(vr,T),E(_r,te),E(gr,ne),E(pr,S),E(mr,w),E(hr,re),p(ie))if(ie.length){let t=e.exposed||={};ie.forEach(e=>{Object.defineProperty(t,e,{get:()=>n[e],set:t=>n[e]=t,enumerable:!0})})}else e.exposed||={};ee&&e.render===a&&(e.render=ee),ae!=null&&(e.inheritAttrs=ae),oe&&(e.components=oe),se&&(e.directives=se),re&&Xn(e)}function Or(e,t,n=a){p(e)&&(e=Ir(e));for(let n in e){let r=e[n],i;i=b(r)?`default`in r?zn(r.from||n,r.default,!0):zn(r.from||n):zn(r),Zt(i)?Object.defineProperty(t,n,{enumerable:!0,configurable:!0,get:()=>i.value,set:e=>i.value=e}):t[n]=i}}function kr(e,t,n){pn(p(e)?e.map(e=>e.bind(t.proxy)):e.bind(t.proxy),t,n)}function Ar(e,t,n,r){let i=r.includes(`.`)?Gn(n,r):()=>n[r];if(v(e)){let n=t[e];_(n)&&Hn(i,n)}else if(_(e))Hn(i,e.bind(n));else if(b(e))if(p(e))e.forEach(e=>Ar(e,t,n,r));else{let r=_(e.handler)?e.handler.bind(n):t[e.handler];_(r)&&Hn(i,r,e)}}function jr(e){let t=e.type,{mixins:n,extends:r}=t,{mixins:i,optionsCache:a,config:{optionMergeStrategies:o}}=e.appContext,s=a.get(t),c;return s?c=s:!i.length&&!n&&!r?c=t:(c={},i.length&&i.forEach(e=>Mr(c,e,o,!0)),Mr(c,t,o)),b(t)&&a.set(t,c),c}function Mr(e,t,n,r=!1){let{mixins:i,extends:a}=t;a&&Mr(e,a,n,!0),i&&i.forEach(t=>Mr(e,t,n,!0));for(let i in t)if(!(r&&i===`expose`)){let r=Nr[i]||n&&n[i];e[i]=r?r(e[i],t[i]):t[i]}return e}var Nr={data:Pr,props:zr,emits:zr,methods:Rr,computed:Rr,beforeCreate:Lr,created:Lr,beforeMount:Lr,mounted:Lr,beforeUpdate:Lr,updated:Lr,beforeDestroy:Lr,beforeUnmount:Lr,destroyed:Lr,unmounted:Lr,activated:Lr,deactivated:Lr,errorCaptured:Lr,serverPrefetch:Lr,components:Rr,directives:Rr,watch:Br,provide:Pr,inject:Fr};function Pr(e,t){return t?e?function(){return l(_(e)?e.call(this,this):e,_(t)?t.call(this,this):t)}:t:e}function Fr(e,t){return Rr(Ir(e),Ir(t))}function Ir(e){if(p(e)){let t={};for(let n=0;n<e.length;n++)t[e[n]]=e[n];return t}return e}function Lr(e,t){return e?[...new Set([].concat(e,t))]:t}function Rr(e,t){return e?l(Object.create(null),e,t):t}function zr(e,t){return e?p(e)&&p(t)?[...new Set([...e,...t])]:l(Object.create(null),Tr(e),Tr(t??{})):t}function Br(e,t){if(!e)return t;if(!t)return e;let n=l(Object.create(null),e);for(let r in t)n[r]=Lr(e[r],t[r]);return n}function Vr(){return{app:null,config:{isNativeTag:o,performance:!1,globalProperties:{},optionMergeStrategies:{},errorHandler:void 0,warnHandler:void 0,compilerOptions:{}},mixins:[],components:{},directives:{},provides:Object.create(null),optionsCache:new WeakMap,propsCache:new WeakMap,emitsCache:new WeakMap}}var Hr=0;function Ur(e,t){return function(n,r=null){_(n)||(n=l({},n)),r!=null&&!b(r)&&(r=null);let i=Vr(),a=new WeakSet,o=[],s=!1,c=i.app={_uid:Hr++,_component:n,_props:r,_container:null,_context:i,_instance:null,version:ja,get config(){return i.config},set config(e){},use(e,...t){return a.has(e)||(e&&_(e.install)?(a.add(e),e.install(c,...t)):_(e)&&(a.add(e),e(c,...t))),c},mixin(e){return i.mixins.includes(e)||i.mixins.push(e),c},component(e,t){return t?(i.components[e]=t,c):i.components[e]},directive(e,t){return t?(i.directives[e]=t,c):i.directives[e]},mount(a,o,l){if(!s){let u=c._ceVNode||Zi(n,r);return u.appContext=i,l===!0?l=`svg`:l===!1&&(l=void 0),o&&t?t(u,a):e(u,a,l),s=!0,c._container=a,a.__vue_app__=c,Oa(u.component)}},onUnmount(e){o.push(e)},unmount(){s&&(pn(o,c._instance,16),e(null,c._container),delete c._container.__vue_app__)},provide(e,t){return i.provides[e]=t,c},runWithContext(e){let t=Wr;Wr=c;try{return e()}finally{Wr=t}}};return c}}var Wr=null,Gr=(e,t)=>t===`modelValue`||t===`model-value`?e.modelModifiers:e[`${t}Modifiers`]||e[`${ie(t)}Modifiers`]||e[`${oe(t)}Modifiers`];function Kr(e,t,...n){if(e.isUnmounted)return;let i=e.vnode.props||r,a=n,o=t.startsWith(`update:`),s=o&&Gr(i,t.slice(7));s&&(s.trim&&(a=n.map(e=>v(e)?e.trim():e)),s.number&&(a=n.map(D)));let c,l=i[c=ce(t)]||i[c=ce(ie(t))];!l&&o&&(l=i[c=ce(oe(t))]),l&&pn(l,e,6,a);let u=i[c+`Once`];if(u){if(!e.emitted)e.emitted={};else if(e.emitted[c])return;e.emitted[c]=!0,pn(u,e,6,a)}}var qr=new WeakMap;function Jr(e,t,n=!1){let r=n?qr:t.emitsCache,i=r.get(e);if(i!==void 0)return i;let a=e.emits,o={},s=!1;if(!_(e)){let r=e=>{let n=Jr(e,t,!0);n&&(s=!0,l(o,n))};!n&&t.mixins.length&&t.mixins.forEach(r),e.extends&&r(e.extends),e.mixins&&e.mixins.forEach(r)}return!a&&!s?(b(e)&&r.set(e,null),null):(p(a)?a.forEach(e=>o[e]=null):l(o,a),b(e)&&r.set(e,o),o)}function Yr(e,t){return!e||!s(t)?!1:(t=t.slice(2),t=t===`Once`?t:t.replace(/Once$/,``),f(e,t[0].toLowerCase()+t.slice(1))||f(e,oe(t))||f(e,t))}function Xr(e){let{type:t,vnode:n,proxy:r,withProxy:i,propsOptions:[a],slots:o,attrs:s,emit:l,render:u,renderCache:d,props:f,data:p,setupState:m,ctx:h,inheritAttrs:g}=e,_=Pn(e),v,y;try{if(n.shapeFlag&4){let e=i||r,t=e;v=ia(u.call(t,e,d,f,m,p,h)),y=s}else{let e=t;v=ia(e.length>1?e(f,{attrs:s,slots:o,emit:l}):e(f,null)),y=t.props?s:Zr(s)}}catch(t){Ri.length=0,mn(t,e,1),v=Zi(Ii)}let b=v;if(y&&g!==!1){let e=Object.keys(y),{shapeFlag:t}=b;e.length&&t&7&&(a&&e.some(c)&&(y=Qr(y,a)),b=ea(b,y,!1,!0))}return n.dirs&&(b=ea(b,null,!1,!0),b.dirs=b.dirs?b.dirs.concat(n.dirs):n.dirs),n.transition&&Yn(b,n.transition),v=b,Pn(_),v}var Zr=e=>{let t;for(let n in e)(n===`class`||n===`style`||s(n))&&((t||={})[n]=e[n]);return t},Qr=(e,t)=>{let n={};for(let r in e)(!c(r)||!(r.slice(9)in t))&&(n[r]=e[r]);return n};function $r(e,t,n){let{props:r,children:i,component:a}=e,{props:o,children:s,patchFlag:c}=t,l=a.emitsOptions;if(t.dirs||t.transition)return!0;if(n&&c>=0){if(c&1024)return!0;if(c&16)return r?ei(r,o,l):!!o;if(c&8){let e=t.dynamicProps;for(let t=0;t<e.length;t++){let n=e[t];if(ti(o,r,n)&&!Yr(l,n))return!0}}}else return(i||s)&&(!s||!s.$stable)?!0:r===o?!1:r?!o||ei(r,o,l):!!o;return!1}function ei(e,t,n){let r=Object.keys(t);if(r.length!==Object.keys(e).length)return!0;for(let i=0;i<r.length;i++){let a=r[i];if(ti(t,e,a)&&!Yr(n,a))return!0}return!1}function ti(e,t,n){let r=e[n],i=t[n];return n===`style`&&b(r)&&b(i)?!Ce(r,i):r!==i}function ni({vnode:e,parent:t,suspense:n},r){for(;t;){let n=t.subTree;if(n.suspense&&n.suspense.activeBranch===e&&(n.suspense.vnode.el=n.el=r,e=n),n===e)(e=t.vnode).el=r,t=t.parent;else break}n&&n.activeBranch===e&&(n.vnode.el=r)}var ri={},ii=()=>Object.create(ri),ai=e=>Object.getPrototypeOf(e)===ri;function oi(e,t,n,r=!1){let i={},a=ii();e.propsDefaults=Object.create(null),ci(e,t,i,a);for(let t in e.propsOptions[0])t in i||(i[t]=void 0);n?e.props=r?i:Bt(i):e.type.props?e.props=i:e.props=a,e.attrs=a}function si(e,t,n,r){let{props:i,attrs:a,vnode:{patchFlag:o}}=e,s=qt(i),[c]=e.propsOptions,l=!1;if((r||o>0)&&!(o&16)){if(o&8){let n=e.vnode.dynamicProps;for(let r=0;r<n.length;r++){let o=n[r];if(Yr(e.emitsOptions,o))continue;let u=t[o];if(c)if(f(a,o))u!==a[o]&&(a[o]=u,l=!0);else{let t=ie(o);i[t]=li(c,s,t,u,e,!1)}else u!==a[o]&&(a[o]=u,l=!0)}}}else{ci(e,t,i,a)&&(l=!0);let r;for(let a in s)(!t||!f(t,a)&&((r=oe(a))===a||!f(t,r)))&&(c?n&&(n[a]!==void 0||n[r]!==void 0)&&(i[a]=li(c,s,a,void 0,e,!0)):delete i[a]);if(a!==s)for(let e in a)(!t||!f(t,e))&&(delete a[e],l=!0)}l&&at(e.attrs,`set`,``)}function ci(e,t,n,i){let[a,o]=e.propsOptions,s=!1,c;if(t)for(let r in t){if(ne(r))continue;let l=t[r],u;a&&f(a,u=ie(r))?!o||!o.includes(u)?n[u]=l:(c||={})[u]=l:Yr(e.emitsOptions,r)||(!(r in i)||l!==i[r])&&(i[r]=l,s=!0)}if(o){let t=qt(n),i=c||r;for(let r=0;r<o.length;r++){let s=o[r];n[s]=li(a,t,s,i[s],e,!f(i,s))}}return s}function li(e,t,n,r,i,a){let o=e[n];if(o!=null){let e=f(o,`default`);if(e&&r===void 0){let e=o.default;if(o.type!==Function&&!o.skipFactory&&_(e)){let{propsDefaults:a}=i;if(n in a)r=a[n];else{let o=ga(i);r=a[n]=e.call(null,t),o()}}else r=e;i.ce&&i.ce._setProp(n,r)}o[0]&&(a&&!e?r=!1:o[1]&&(r===``||r===oe(n))&&(r=!0))}return r}var ui=new WeakMap;function di(e,t,n=!1){let a=n?ui:t.propsCache,o=a.get(e);if(o)return o;let s=e.props,c={},u=[],d=!1;if(!_(e)){let r=e=>{d=!0;let[n,r]=di(e,t,!0);l(c,n),r&&u.push(...r)};!n&&t.mixins.length&&t.mixins.forEach(r),e.extends&&r(e.extends),e.mixins&&e.mixins.forEach(r)}if(!s&&!d)return b(e)&&a.set(e,i),i;if(p(s))for(let e=0;e<s.length;e++){let t=ie(s[e]);fi(t)&&(c[t]=r)}else if(s)for(let e in s){let t=ie(e);if(fi(t)){let n=s[e],r=c[t]=p(n)||_(n)?{type:n}:l({},n),i=r.type,a=!1,o=!0;if(p(i))for(let e=0;e<i.length;++e){let t=i[e],n=_(t)&&t.name;if(n===`Boolean`){a=!0;break}else n===`String`&&(o=!1)}else a=_(i)&&i.name===`Boolean`;r[0]=a,r[1]=o,(a||f(r,`default`))&&u.push(t)}}let m=[c,u];return b(e)&&a.set(e,m),m}function fi(e){return e[0]!==`$`&&!ne(e)}var pi=e=>e===`_`||e===`_ctx`||e===`$stable`,mi=e=>p(e)?e.map(ia):[ia(e)],hi=(e,t,n)=>{if(t._n)return t;let r=Fn((...e)=>mi(t(...e)),n);return r._c=!1,r},gi=(e,t,n)=>{let r=e._ctx;for(let n in e){if(pi(n))continue;let i=e[n];if(_(i))t[n]=hi(n,i,r);else if(i!=null){let e=mi(i);t[n]=()=>e}}},_i=(e,t)=>{let n=mi(t);e.slots.default=()=>n},vi=(e,t,n)=>{for(let r in t)(n||!pi(r))&&(e[r]=t[r])},yi=(e,t,n)=>{let r=e.slots=ii();if(e.vnode.shapeFlag&32){let e=t._;e?(vi(r,t,n),n&&ue(r,`_`,e,!0)):gi(t,r)}else t&&_i(e,t)},bi=(e,t,n)=>{let{vnode:i,slots:a}=e,o=!0,s=r;if(i.shapeFlag&32){let e=t._;e?n&&e===1?o=!1:vi(a,t,n):(o=!t.$stable,gi(t,a)),s=t}else t&&(_i(e,t),s={default:1});if(o)for(let e in a)!pi(e)&&s[e]==null&&delete a[e]},xi=Ni;function Si(e){return Ci(e)}function Ci(e,t){let n=fe();n.__VUE__=!0;let{insert:o,remove:s,patchProp:c,createElement:l,createText:u,createComment:d,setText:f,setElementText:p,parentNode:m,nextSibling:h,setScopeId:g=a,insertStaticContent:_}=e,v=(e,t,n,r=null,i=null,a=null,o=void 0,s=null,c=!!t.dynamicChildren)=>{if(e===t)return;e&&!Ji(e,t)&&(r=xe(e),ge(e,i,a,!0),e=null),t.patchFlag===-2&&(c=!1,t.dynamicChildren=null);let{type:l,ref:u,shapeFlag:d}=t;switch(l){case Fi:y(e,t,n,r);break;case Ii:b(e,t,n,r);break;case Li:e??x(t,n,r,o);break;case Pi:oe(e,t,n,r,i,a,o,s,c);break;default:d&1?w(e,t,n,r,i,a,o,s,c):d&6?se(e,t,n,r,i,a,o,s,c):(d&64||d&128)&&l.process(e,t,n,r,i,a,o,s,c,we)}u!=null&&i?$n(u,e&&e.ref,a,t||e,!t):u==null&&e&&e.ref!=null&&$n(e.ref,null,a,e,!0)},y=(e,t,n,r)=>{if(e==null)o(t.el=u(t.children),n,r);else{let n=t.el=e.el;t.children!==e.children&&f(n,t.children)}},b=(e,t,n,r)=>{e==null?o(t.el=d(t.children||``),n,r):t.el=e.el},x=(e,t,n,r)=>{[e.el,e.anchor]=_(e.children,t,n,r,e.el,e.anchor)},S=({el:e,anchor:t},n,r)=>{let i;for(;e&&e!==t;)i=h(e),o(e,n,r),e=i;o(t,n,r)},C=({el:e,anchor:t})=>{let n;for(;e&&e!==t;)n=h(e),s(e),e=n;s(t)},w=(e,t,n,r,i,a,o,s,c)=>{if(t.type===`svg`?o=`svg`:t.type===`math`&&(o=`mathml`),e==null)ee(t,n,r,i,a,o,s,c);else{let n=e.el&&e.el._isVueCE?e.el:null;try{n&&n._beginPatch(),re(e,t,i,a,o,s,c)}finally{n&&n._endPatch()}}},ee=(e,t,n,r,i,a,s,u)=>{let d,f,{props:m,shapeFlag:h,transition:g,dirs:_}=e;if(d=e.el=l(e.type,a,m&&m.is,m),h&8?p(d,e.children):h&16&&T(e.children,d,null,r,i,wi(e,a),s,u),_&&Ln(e,null,r,`created`),te(d,e,e.scopeId,s,r),m){for(let e in m)e!==`value`&&!ne(e)&&c(d,e,null,m[e],a,r);`value`in m&&c(d,`value`,null,m.value,a),(f=m.onVnodeBeforeMount)&&ca(f,r,e)}_&&Ln(e,null,r,`beforeMount`);let v=Ei(i,g);v&&g.beforeEnter(d),o(d,t,n),((f=m&&m.onVnodeMounted)||v||_)&&xi(()=>{try{f&&ca(f,r,e),v&&g.enter(d),_&&Ln(e,null,r,`mounted`)}finally{}},i)},te=(e,t,n,r,i)=>{if(n&&g(e,n),r)for(let t=0;t<r.length;t++)g(e,r[t]);if(i){let n=i.subTree;if(t===n||Mi(n.type)&&(n.ssContent===t||n.ssFallback===t)){let t=i.vnode;te(e,t,t.scopeId,t.slotScopeIds,i.parent)}}},T=(e,t,n,r,i,a,o,s,c=0)=>{for(let l=c;l<e.length;l++){let c=e[l]=s?aa(e[l]):ia(e[l]);v(null,c,t,n,r,i,a,o,s)}},re=(e,t,n,i,a,o,s)=>{let l=t.el=e.el,{patchFlag:u,dynamicChildren:d,dirs:f}=t;u|=e.patchFlag&16;let m=e.props||r,h=t.props||r,g;if(n&&Ti(n,!1),(g=h.onVnodeBeforeUpdate)&&ca(g,n,t,e),f&&Ln(t,e,n,`beforeUpdate`),n&&Ti(n,!0),d&&(!e.dynamicChildren||e.dynamicChildren.length!==d.length)&&(u=0,s=!1,d=null),(m.innerHTML&&h.innerHTML==null||m.textContent&&h.textContent==null)&&p(l,``),d?ie(e.dynamicChildren,d,l,n,i,wi(t,a),o):s||de(e,t,l,null,n,i,wi(t,a),o,!1),u>0){if(u&16)ae(l,m,h,n,a);else if(u&2&&m.class!==h.class&&c(l,`class`,null,h.class,a),u&4&&c(l,`style`,m.style,h.style,a),u&8){let e=t.dynamicProps;for(let t=0;t<e.length;t++){let r=e[t],i=m[r],o=h[r];(o!==i||r===`value`)&&c(l,r,i,o,a,n)}}u&1&&e.children!==t.children&&p(l,t.children)}else!s&&d==null&&ae(l,m,h,n,a);((g=h.onVnodeUpdated)||f)&&xi(()=>{g&&ca(g,n,t,e),f&&Ln(t,e,n,`updated`)},i)},ie=(e,t,n,r,i,a,o)=>{for(let s=0;s<t.length;s++){let c=e[s],l=t[s],u=c.el&&(c.type===Pi||!Ji(c,l)||c.shapeFlag&198)?m(c.el):n;v(c,l,u,null,r,i,a,o,!0)}},ae=(e,t,n,i,a)=>{if(t!==n){if(t!==r)for(let r in t)!ne(r)&&!(r in n)&&c(e,r,t[r],null,a,i);for(let r in n){if(ne(r))continue;let o=n[r],s=t[r];o!==s&&r!==`value`&&c(e,r,s,o,a,i)}`value`in n&&c(e,`value`,t.value,n.value,a)}},oe=(e,t,n,r,i,a,s,c,l)=>{let d=t.el=e?e.el:u(``),f=t.anchor=e?e.anchor:u(``),{patchFlag:p,dynamicChildren:m,slotScopeIds:h}=t;h&&(c=c?c.concat(h):h),e==null?(o(d,n,r),o(f,n,r),T(t.children||[],n,f,i,a,s,c,l)):p>0&&p&64&&m&&e.dynamicChildren&&e.dynamicChildren.length===m.length?(ie(e.dynamicChildren,m,n,i,a,s,c),(t.key!=null||i&&t===i.subTree)&&Di(e,t,!0)):de(e,t,n,f,i,a,s,c,l)},se=(e,t,n,r,i,a,o,s,c)=>{t.slotScopeIds=s,e==null?t.shapeFlag&512?i.ctx.activate(t,n,r,o,c):ce(t,n,r,i,a,o,c):E(e,t,c)},ce=(e,t,n,r,i,a,o)=>{let s=e.component=da(e,r,i);if(nr(e)&&(s.ctx.renderer=we),ba(s,!1,o),s.asyncDep){if(i&&i.registerDep(s,ue,o),!e.el){let r=s.subTree=Zi(Ii);b(null,r,t,n),e.placeholder=r.el}}else ue(s,e,t,n,i,a,o)},E=(e,t,n)=>{let r=t.component=e.component;if($r(e,t,n))if(r.asyncDep&&!r.asyncResolved){D(r,t,n);return}else r.next=t,r.update();else t.el=e.el,r.vnode=t},ue=(e,t,n,r,i,a,o)=>{let s=()=>{if(e.isMounted){let{next:t,bu:n,u:r,parent:s,vnode:c}=e;{let n=ki(e);if(n){t&&(t.el=c.el,D(e,t,o)),n.asyncDep.then(()=>{xi(()=>{e.isUnmounted||l()},i)});return}}let u=t,d;Ti(e,!1),t?(t.el=c.el,D(e,t,o)):t=c,n&&le(n),(d=t.props&&t.props.onVnodeBeforeUpdate)&&ca(d,s,t,c),Ti(e,!0);let f=Xr(e),p=e.subTree;e.subTree=f,v(p,f,m(p.el),xe(p),e,i,a),t.el=f.el,u===null&&ni(e,f.el),r&&xi(r,i),(d=t.props&&t.props.onVnodeUpdated)&&xi(()=>ca(d,s,t,c),i)}else{let o,{el:s,props:c}=t,{bm:l,m:u,parent:d,root:f,type:p}=e,m=tr(t);if(Ti(e,!1),l&&le(l),!m&&(o=c&&c.onVnodeBeforeMount)&&ca(o,d,t),Ti(e,!0),s&&O){let t=()=>{e.subTree=Xr(e),O(s,e.subTree,e,i,null)};m&&p.__asyncHydrate?p.__asyncHydrate(s,e,t):t()}else{f.ce&&f.ce._hasShadowRoot()&&f.ce._injectChildStyle(p,e.parent?e.parent.type:void 0);let o=e.subTree=Xr(e);v(null,o,n,r,e,i,a),t.el=o.el}if(u&&xi(u,i),!m&&(o=c&&c.onVnodeMounted)){let e=t;xi(()=>ca(o,d,e),i)}(t.shapeFlag&256||d&&tr(d.vnode)&&d.vnode.shapeFlag&256)&&e.a&&xi(e.a,i),e.isMounted=!0,t=n=r=null}};e.scope.on();let c=e.effect=new Me(s);e.scope.off();let l=e.update=c.run.bind(c),u=e.job=c.runIfDirty.bind(c);u.i=e,u.id=e.uid,c.scheduler=()=>Tn(u),Ti(e,!0),l()},D=(e,t,n)=>{t.component=e;let r=e.vnode.props;e.vnode=t,e.next=null,si(e,t.props,r,n),bi(e,t.children,n),qe(),On(e),Je()},de=(e,t,n,r,i,a,o,s,c=!1)=>{let l=e&&e.children,u=e?e.shapeFlag:0,d=t.children,{patchFlag:f,shapeFlag:m}=t;if(f>0){if(f&128){me(l,d,n,r,i,a,o,s,c);return}else if(f&256){pe(l,d,n,r,i,a,o,s,c);return}}m&8?(u&16&&be(l,i,a),d!==l&&p(n,d)):u&16?m&16?me(l,d,n,r,i,a,o,s,c):be(l,i,a,!0):(u&8&&p(n,``),m&16&&T(d,n,r,i,a,o,s,c))},pe=(e,t,n,r,a,o,s,c,l)=>{e||=i,t||=i;let u=e.length,d=t.length,f=Math.min(u,d),p;for(p=0;p<f;p++){let r=t[p]=l?aa(t[p]):ia(t[p]);v(e[p],r,n,null,a,o,s,c,l)}u>d?be(e,a,o,!0,!1,f):T(t,n,r,a,o,s,c,l,f)},me=(e,t,n,r,a,o,s,c,l)=>{let u=0,d=t.length,f=e.length-1,p=d-1;for(;u<=f&&u<=p;){let r=e[u],i=t[u]=l?aa(t[u]):ia(t[u]);if(Ji(r,i))v(r,i,n,null,a,o,s,c,l);else break;u++}for(;u<=f&&u<=p;){let r=e[f],i=t[p]=l?aa(t[p]):ia(t[p]);if(Ji(r,i))v(r,i,n,null,a,o,s,c,l);else break;f--,p--}if(u>f){if(u<=p){let e=p+1,i=e<d?t[e].el:r;for(;u<=p;)v(null,t[u]=l?aa(t[u]):ia(t[u]),n,i,a,o,s,c,l),u++}}else if(u>p)for(;u<=f;)ge(e[u],a,o,!0),u++;else{let m=u,h=u,g=new Map;for(u=h;u<=p;u++){let e=t[u]=l?aa(t[u]):ia(t[u]);e.key!=null&&g.set(e.key,u)}let _,y=0,b=p-h+1,x=!1,S=0,C=Array(b);for(u=0;u<b;u++)C[u]=0;for(u=m;u<=f;u++){let r=e[u];if(y>=b){ge(r,a,o,!0);continue}let i;if(r.key!=null)i=g.get(r.key);else for(_=h;_<=p;_++)if(C[_-h]===0&&Ji(r,t[_])){i=_;break}i===void 0?ge(r,a,o,!0):(C[i-h]=u+1,i>=S?S=i:x=!0,v(r,t[i],n,null,a,o,s,c,l),y++)}let w=x?Oi(C):i;for(_=w.length-1,u=b-1;u>=0;u--){let e=h+u,i=t[e],f=t[e+1],p=e+1<d?f.el||ji(f):r;C[u]===0?v(null,i,n,p,a,o,s,c,l):x&&(_<0||u!==w[_]?he(i,n,p,2):_--)}}},he=(e,t,n,r,i=null)=>{let{el:a,type:c,transition:l,children:u,shapeFlag:d}=e;if(d&6){he(e.component.subTree,t,n,r);return}if(d&128){e.suspense.move(t,n,r);return}if(d&64){c.move(e,t,n,we);return}if(c===Pi){o(a,t,n);for(let e=0;e<u.length;e++)he(u[e],t,n,r);o(e.anchor,t,n);return}if(c===Li){S(e,t,n);return}if(r!==2&&d&1&&l)if(r===0)l.persisted&&!a[Jn]?o(a,t,n):(l.beforeEnter(a),o(a,t,n),xi(()=>l.enter(a),i));else{let{leave:r,delayLeave:i,afterLeave:c}=l,u=()=>{e.ctx.isUnmounted?s(a):o(a,t,n)},d=()=>{let e=a._isLeaving||!!a[Jn];a._isLeaving&&a[Jn](!0),l.persisted&&!e?u():r(a,()=>{u(),c&&c()})};i?i(a,u,d):d()}else o(a,t,n)},ge=(e,t,n,r=!1,i=!1)=>{let{type:a,props:o,ref:s,children:c,dynamicChildren:l,shapeFlag:u,patchFlag:d,dirs:f,cacheIndex:p,memo:m}=e;if(d===-2&&(i=!1),s!=null&&(qe(),$n(s,null,n,e,!0),Je()),p!=null&&(t.renderCache[p]=void 0),u&256){t.ctx.deactivate(e);return}let h=u&1&&f,g=!tr(e),_;if(g&&(_=o&&o.onVnodeBeforeUnmount)&&ca(_,t,e),u&6)ye(e.component,n,r);else{if(u&128){e.suspense.unmount(n,r);return}h&&Ln(e,null,t,`beforeUnmount`),u&64?e.type.remove(e,t,n,we,r):l&&!l.hasOnce&&(a!==Pi||d>0&&d&64)?be(l,t,n,!1,!0):(a===Pi&&d&384||!i&&u&16)&&be(c,t,n),r&&_e(e)}let v=m!=null&&p==null;(g&&(_=o&&o.onVnodeUnmounted)||h||v)&&xi(()=>{_&&ca(_,t,e),h&&Ln(e,null,t,`unmounted`),v&&(e.el=null)},n)},_e=e=>{let{type:t,el:n,anchor:r,transition:i}=e;if(t===Pi){ve(n,r);return}if(t===Li){C(e);return}let a=()=>{s(n),i&&!i.persisted&&i.afterLeave&&i.afterLeave()};if(e.shapeFlag&1&&i&&!i.persisted){let{leave:t,delayLeave:r}=i,o=()=>t(n,a);r?r(e.el,a,o):o()}else a()},ve=(e,t)=>{let n;for(;e!==t;)n=h(e),s(e),e=n;s(t)},ye=(e,t,n)=>{let{bum:r,scope:i,job:a,subTree:o,um:s,m:c,a:l}=e;Ai(c),Ai(l),r&&le(r),i.stop(),a&&(a.flags|=8,ge(o,e,t,n)),s&&xi(s,t),xi(()=>{e.isUnmounted=!0},t)},be=(e,t,n,r=!1,i=!1,a=0)=>{for(let o=a;o<e.length;o++)ge(e[o],t,n,r,i)},xe=e=>{if(e.shapeFlag&6)return xe(e.component.subTree);if(e.shapeFlag&128)return e.suspense.next();let t=h(e.anchor||e.el),n=t&&t[Kn];return n?h(n):t},Se=!1,Ce=(e,t,n)=>{let r;e==null?t._vnode&&(ge(t._vnode,null,null,!0),r=t._vnode.component):v(t._vnode||null,e,t,null,null,null,n),t._vnode=e,Se||=(Se=!0,On(r),kn(),!1)},we={p:v,um:ge,m:he,r:_e,mt:ce,mc:T,pc:de,pbc:ie,n:xe,o:e},Te,O;return t&&([Te,O]=t(we)),{render:Ce,hydrate:Te,createApp:Ur(Ce,Te)}}function wi({type:e,props:t},n){return n===`svg`&&e===`foreignObject`||n===`mathml`&&e===`annotation-xml`&&t&&t.encoding&&t.encoding.includes(`html`)?void 0:n}function Ti({effect:e,job:t},n){n?(e.flags|=32,t.flags|=4):(e.flags&=-33,t.flags&=-5)}function Ei(e,t){return(!e||e&&!e.pendingBranch)&&t&&!t.persisted}function Di(e,t,n=!1){let r=e.children,i=t.children;if(p(r)&&p(i))for(let e=0;e<r.length;e++){let t=r[e],a=i[e];a.shapeFlag&1&&!a.dynamicChildren&&((a.patchFlag<=0||a.patchFlag===32)&&(a=i[e]=aa(i[e]),a.el=t.el),!n&&a.patchFlag!==-2&&Di(t,a)),a.type===Fi&&(a.patchFlag===-1&&(a=i[e]=aa(a)),a.el=t.el),a.type===Ii&&!a.el&&(a.el=t.el)}}function Oi(e){let t=e.slice(),n=[0],r,i,a,o,s,c=e.length;for(r=0;r<c;r++){let c=e[r];if(c!==0){if(i=n[n.length-1],e[i]<c){t[r]=i,n.push(r);continue}for(a=0,o=n.length-1;a<o;)s=a+o>>1,e[n[s]]<c?a=s+1:o=s;c<e[n[a]]&&(a>0&&(t[r]=n[a-1]),n[a]=r)}}for(a=n.length,o=n[a-1];a-->0;)n[a]=o,o=t[o];return n}function ki(e){let t=e.subTree.component;if(t)return t.asyncDep&&!t.asyncResolved?t:ki(t)}function Ai(e){if(e)for(let t=0;t<e.length;t++)e[t].flags|=8}function ji(e){if(e.placeholder)return e.placeholder;let t=e.component;return t?ji(t.subTree):null}var Mi=e=>e.__isSuspense;function Ni(e,t){t&&t.pendingBranch?p(e)?t.effects.push(...e):t.effects.push(e):Dn(e)}var Pi=Symbol.for(`v-fgt`),Fi=Symbol.for(`v-txt`),Ii=Symbol.for(`v-cmt`),Li=Symbol.for(`v-stc`),Ri=[],zi=null;function Bi(e=!1){Ri.push(zi=e?null:[])}function Vi(){Ri.pop(),zi=Ri[Ri.length-1]||null}var Hi=1;function Ui(e,t=!1){Hi+=e,e<0&&zi&&t&&(zi.hasOnce=!0)}function Wi(e){return e.dynamicChildren=Hi>0?zi||i:null,Vi(),Hi>0&&zi&&zi.push(e),e}function Gi(e,t,n,r,i,a){return Wi(M(e,t,n,r,i,a,!0))}function Ki(e,t,n,r,i){return Wi(Zi(e,t,n,r,i,!0))}function qi(e){return e?e.__v_isVNode===!0:!1}function Ji(e,t){return e.type===t.type&&e.key===t.key}var Yi=({key:e})=>e??null,Xi=({ref:e,ref_key:t,ref_for:n})=>(typeof e==`number`&&(e=``+e),e==null?null:v(e)||Zt(e)||_(e)?{i:Mn,r:e,k:t,f:!!n}:e);function M(e,t=null,n=null,r=0,i=null,a=e===Pi?0:1,o=!1,s=!1){let c={__v_isVNode:!0,__v_skip:!0,type:e,props:t,key:t&&Yi(t),ref:t&&Xi(t),scopeId:Nn,slotScopeIds:null,children:n,component:null,suspense:null,ssContent:null,ssFallback:null,dirs:null,transition:null,el:null,anchor:null,target:null,targetStart:null,targetAnchor:null,staticCount:0,shapeFlag:a,patchFlag:r,dynamicProps:i,dynamicChildren:null,appContext:null,ctx:Mn};return s?(oa(c,n),a&128&&e.normalize(c)):n&&(c.shapeFlag|=v(n)?8:16),Hi>0&&!o&&zi&&(c.patchFlag>0||a&6)&&c.patchFlag!==32&&zi.push(c),c}var Zi=Qi;function Qi(e,t=null,n=null,r=0,i=null,a=!1){if((!e||e===yr)&&(e=Ii),qi(e)){let r=ea(e,t,!0);return n&&oa(r,n),Hi>0&&!a&&zi&&(r.shapeFlag&6?zi[zi.indexOf(e)]=r:zi.push(r)),r.patchFlag=-2,r}if(ka(e)&&(e=e.__vccOpts),t){t=$i(t);let{class:e,style:n}=t;e&&!v(e)&&(t.class=ve(e)),b(n)&&(Kt(n)&&!p(n)&&(n=l({},n)),t.style=pe(n))}let o=v(e)?1:Mi(e)?128:qn(e)?64:b(e)?4:_(e)?2:0;return M(e,t,n,r,i,o,a,!0)}function $i(e){return e?Kt(e)||ai(e)?l({},e):e:null}function ea(e,t,n=!1,r=!1){let{props:i,ref:a,patchFlag:o,children:s,transition:c}=e,l=t?sa(i||{},t):i,u={__v_isVNode:!0,__v_skip:!0,type:e.type,props:l,key:l&&Yi(l),ref:t&&t.ref?n&&a?p(a)?a.concat(Xi(t)):[a,Xi(t)]:Xi(t):a,scopeId:e.scopeId,slotScopeIds:e.slotScopeIds,children:s,target:e.target,targetStart:e.targetStart,targetAnchor:e.targetAnchor,staticCount:e.staticCount,shapeFlag:e.shapeFlag,patchFlag:t&&e.type!==Pi?o===-1?16:o|16:o,dynamicProps:e.dynamicProps,dynamicChildren:e.dynamicChildren,appContext:e.appContext,dirs:e.dirs,transition:c,component:e.component,suspense:e.suspense,ssContent:e.ssContent&&ea(e.ssContent),ssFallback:e.ssFallback&&ea(e.ssFallback),placeholder:e.placeholder,el:e.el,anchor:e.anchor,ctx:e.ctx,ce:e.ce};return c&&r&&Yn(u,c.clone(u)),u}function ta(e=` `,t=0){return Zi(Fi,null,e,t)}function na(e,t){let n=Zi(Li,null,e);return n.staticCount=t,n}function ra(e=``,t=!1){return t?(Bi(),Ki(Ii,null,e)):Zi(Ii,null,e)}function ia(e){return e==null||typeof e==`boolean`?Zi(Ii):p(e)?Zi(Pi,null,e.slice()):qi(e)?aa(e):Zi(Fi,null,String(e))}function aa(e){return e.el===null&&e.patchFlag!==-1||e.memo?e:ea(e)}function oa(e,t){let n=0,{shapeFlag:r}=e;if(t==null)t=null;else if(p(t))n=16;else if(typeof t==`object`)if(r&65){let n=t.default;n&&(n._c&&(n._d=!1),oa(e,n()),n._c&&(n._d=!0));return}else{n=32;let r=t._;!r&&!ai(t)?t._ctx=Mn:r===3&&Mn&&(Mn.slots._===1?t._=1:(t._=2,e.patchFlag|=1024))}else if(_(t)){if(r&65){oa(e,{default:t});return}t={default:t,_ctx:Mn},n=32}else t=String(t),r&64?(n=16,t=[ta(t)]):n=8;e.children=t,e.shapeFlag|=n}function sa(...e){let t={};for(let n=0;n<e.length;n++){let r=e[n];for(let e in r)if(e===`class`)t.class!==r.class&&(t.class=ve([t.class,r.class]));else if(e===`style`)t.style=pe([t.style,r.style]);else if(s(e)){let n=t[e],i=r[e];i&&n!==i&&!(p(n)&&n.includes(i))?t[e]=n?[].concat(n,i):i:i==null&&n==null&&!c(e)&&(t[e]=i)}else e!==``&&(t[e]=r[e])}return t}function ca(e,t,n,r=null){pn(e,t,7,[n,r])}var la=Vr(),ua=0;function da(e,t,n){let i=e.type,a=(t?t.appContext:e.appContext)||la,o={uid:ua++,vnode:e,type:i,parent:t,appContext:a,root:null,next:null,subTree:null,effect:null,update:null,job:null,scope:new k(!0),render:null,proxy:null,exposed:null,exposeProxy:null,withProxy:null,provides:t?t.provides:Object.create(a.provides),ids:t?t.ids:[``,0,0],accessCache:null,renderCache:[],components:null,directives:null,propsOptions:di(i,a),emitsOptions:Jr(i,a),emit:null,emitted:null,propsDefaults:r,inheritAttrs:i.inheritAttrs,ctx:r,data:r,props:r,attrs:r,slots:r,refs:r,setupState:r,setupContext:null,suspense:n,suspenseId:n?n.pendingId:0,asyncDep:null,asyncResolved:!1,isMounted:!1,isUnmounted:!1,isDeactivated:!1,bc:null,c:null,bm:null,m:null,bu:null,u:null,um:null,bum:null,da:null,a:null,rtg:null,rtc:null,ec:null,sp:null};return o.ctx={_:o},o.root=t?t.root:o,o.emit=Kr.bind(null,o),e.ce&&e.ce(o),o}var fa=null,pa=()=>fa||Mn,ma,ha;{let e=fe(),t=(t,n)=>{let r;return(r=e[t])||(r=e[t]=[]),r.push(n),e=>{r.length>1?r.forEach(t=>t(e)):r[0](e)}};ma=t(`__VUE_INSTANCE_SETTERS__`,e=>fa=e),ha=t(`__VUE_SSR_SETTERS__`,e=>ya=e)}var ga=e=>{let t=fa;return ma(e),e.scope.on(),()=>{e.scope.off(),ma(t)}},_a=()=>{fa&&fa.scope.off(),ma(null)};function va(e){return e.vnode.shapeFlag&4}var ya=!1;function ba(e,t=!1,n=!1){t&&ha(t);let{props:r,children:i}=e.vnode,a=va(e);oi(e,r,a,t),yi(e,i,n||t);let o=a?xa(e,t):void 0;return t&&ha(!1),o}function xa(e,t){let n=e.type;e.accessCache=Object.create(null),e.proxy=new Proxy(e.ctx,wr);let{setup:r}=n;if(r){qe();let n=e.setupContext=r.length>1?Da(e):null,i=ga(e),a=fn(r,e,0,[e.props,n]),o=x(a);if(Je(),i(),(o||e.sp)&&!tr(e)&&Xn(e),o){if(a.then(_a,_a),t)return a.then(n=>{Sa(e,n,t)}).catch(t=>{mn(t,e,0)});e.asyncDep=a}else Sa(e,a,t)}else Ta(e,t)}function Sa(e,t,n){_(t)?e.type.__ssrInlineRender?e.ssrRender=t:e.render=t:b(t)&&(e.setupState=nn(t)),Ta(e,n)}var Ca,wa;function Ta(e,t,n){let r=e.type;if(!e.render){if(!t&&Ca&&!r.render){let t=r.template||jr(e).template;if(t){let{isCustomElement:n,compilerOptions:i}=e.appContext.config,{delimiters:a,compilerOptions:o}=r;r.render=Ca(t,l(l({isCustomElement:n,delimiters:a},i),o))}}e.render=r.render||a,wa&&wa(e)}{let t=ga(e);qe();try{Dr(e)}finally{Je(),t()}}}var Ea={get(e,t){return it(e,`get`,``),e[t]}};function Da(e){return{attrs:new Proxy(e.attrs,Ea),slots:e.slots,emit:e.emit,expose:t=>{e.exposed=t||{}}}}function Oa(e){return e.exposed?e.exposeProxy||=new Proxy(nn(Jt(e.exposed)),{get(t,n){if(n in t)return t[n];if(n in Sr)return Sr[n](e)},has(e,t){return t in e||t in Sr}}):e.proxy}function ka(e){return _(e)&&`__vccOpts`in e}var Aa=(e,t)=>an(e,t,ya),ja=`3.5.40`,Ma=void 0,Na=typeof window<`u`&&window.trustedTypes;if(Na)try{Ma=Na.createPolicy(`vue`,{createHTML:e=>e})}catch{}var Pa=Ma?e=>Ma.createHTML(e):e=>e,Fa=`http://www.w3.org/2000/svg`,Ia=`http://www.w3.org/1998/Math/MathML`,La=typeof document<`u`?document:null,Ra=La&&La.createElement(`template`),za={insert:(e,t,n)=>{t.insertBefore(e,n||null)},remove:e=>{let t=e.parentNode;t&&t.removeChild(e)},createElement:(e,t,n,r)=>{let i=t===`svg`?La.createElementNS(Fa,e):t===`mathml`?La.createElementNS(Ia,e):n?La.createElement(e,{is:n}):La.createElement(e);return e===`select`&&r&&r.multiple!=null&&i.setAttribute(`multiple`,r.multiple),i},createText:e=>La.createTextNode(e),createComment:e=>La.createComment(e),setText:(e,t)=>{e.nodeValue=t},setElementText:(e,t)=>{e.textContent=t},parentNode:e=>e.parentNode,nextSibling:e=>e.nextSibling,querySelector:e=>La.querySelector(e),setScopeId(e,t){e.setAttribute(t,``)},insertStaticContent(e,t,n,r,i,a){let o=n?n.previousSibling:t.lastChild;if(i&&(i===a||i.nextSibling))for(;t.insertBefore(i.cloneNode(!0),n),!(i===a||!(i=i.nextSibling)););else{Ra.innerHTML=Pa(r===`svg`?`<svg>${e}</svg>`:r===`mathml`?`<math>${e}</math>`:e);let i=Ra.content;if(r===`svg`||r===`mathml`){let e=i.firstChild;for(;e.firstChild;)i.appendChild(e.firstChild);i.removeChild(e)}t.insertBefore(i,n)}return[o?o.nextSibling:t.firstChild,n?n.previousSibling:t.lastChild]}},Ba=Symbol(`_vtc`);function Va(e,t,n){let r=e[Ba];r&&(t=(t?[t,...r]:[...r]).join(` `)),t==null?e.removeAttribute(`class`):n?e.setAttribute(`class`,t):e.className=t}var Ha=Symbol(`_vod`),Ua=Symbol(`_vsh`),Wa={name:`show`,beforeMount(e,{value:t},{transition:n}){e[Ha]=e.style.display===`none`?``:e.style.display,n&&t?n.beforeEnter(e):Ga(e,t)},mounted(e,{value:t},{transition:n}){n&&t&&n.enter(e)},updated(e,{value:t,oldValue:n},{transition:r}){!t!=!n&&(r?t?(r.beforeEnter(e),Ga(e,!0),r.enter(e)):r.leave(e,()=>{Ga(e,!1)}):Ga(e,t))},beforeUnmount(e,{value:t}){Ga(e,t)}};function Ga(e,t){e.style.display=t?e[Ha]:`none`,e[Ua]=!t}var Ka=Symbol(``),qa=/(?:^|;)\s*display\s*:/;function Ja(e,t,n){let r=e.style,i=v(n),a=!1;if(n&&!i){if(t)if(v(t))for(let e of t.split(`;`)){let t=e.slice(0,e.indexOf(`:`)).trim();n[t]??Xa(r,t,``)}else for(let e in t)n[e]??Xa(r,e,``);for(let i in n){i===`display`&&(a=!0);let o=n[i];o==null?Xa(r,i,``):eo(e,i,!v(t)&&t?t[i]:void 0,o)||Xa(r,i,o)}}else if(i){if(t!==n){let e=r[Ka];e&&(n+=`;`+e),r.cssText=n,a=qa.test(n)}}else t&&e.removeAttribute(`style`);Ha in e&&(e[Ha]=a?r.display:``,e[Ua]&&(r.display=`none`))}var Ya=/\s*!important$/;function Xa(e,t,n){if(p(n))n.forEach(n=>Xa(e,t,n));else if(n??=``,t.startsWith(`--`))e.setProperty(t,n);else{let r=$a(e,t);Ya.test(n)?e.setProperty(oe(r),n.replace(Ya,``),`important`):e[r]=n}}var Za=[`Webkit`,`Moz`,`ms`],Qa={};function $a(e,t){let n=Qa[t];if(n)return n;let r=ie(t);if(r!==`filter`&&r in e)return Qa[t]=r;r=se(r);for(let n=0;n<Za.length;n++){let i=Za[n]+r;if(i in e)return Qa[t]=i}return t}function eo(e,t,n,r){return e.tagName===`TEXTAREA`&&(t===`width`||t===`height`)&&v(r)&&n===r}var to=`http://www.w3.org/1999/xlink`;function no(e,t,n,r,i,a=be(t)){r&&t.startsWith(`xlink:`)?n==null?e.removeAttributeNS(to,t.slice(6,t.length)):e.setAttributeNS(to,t,n):n==null||a&&!xe(n)?e.removeAttribute(t):e.setAttribute(t,a?``:y(n)?String(n):n)}function ro(e,t,n,r,i){if(t===`innerHTML`||t===`textContent`){n!=null&&(e[t]=t===`innerHTML`?Pa(n):n);return}let a=e.tagName;if(t===`value`&&a!==`PROGRESS`&&!a.includes(`-`)){let r=a===`OPTION`?e.getAttribute(`value`)||``:e.value,i=n==null?e.type===`checkbox`?`on`:``:String(n);(r!==i||!(`_value`in e))&&(e.value=i),n??e.removeAttribute(t),e._value=n;return}let o=!1;if(n===``||n==null){let r=typeof e[t];r===`boolean`?n=xe(n):n==null&&r===`string`?(n=``,o=!0):r===`number`&&(n=0,o=!0)}try{e[t]=n}catch{}o&&e.removeAttribute(i||t)}function io(e,t,n,r){e.addEventListener(t,n,r)}function ao(e,t,n,r){e.removeEventListener(t,n,r)}var oo=Symbol(`_vei`);function so(e,t,n,r,i=null){let a=e[oo]||(e[oo]={}),o=a[t];if(r&&o)o.value=r;else{let[n,s]=uo(t);r?io(e,n,a[t]=ho(r,i),s):o&&(ao(e,n,o,s),a[t]=void 0)}}var co=/(Once|Passive|Capture)$/,lo=/^on:?(?:Once|Passive|Capture)$/;function uo(e){let t,n;for(;(n=e.match(co))&&!lo.test(e);)t||={},e=e.slice(0,e.length-n[1].length),t[n[1].toLowerCase()]=!0;return[e[2]===`:`?e.slice(3):oe(e.slice(2)),t]}var fo=0,po=Promise.resolve(),mo=()=>fo||=(po.then(()=>fo=0),Date.now());function ho(e,t){let n=e=>{if(!e._vts)e._vts=Date.now();else if(e._vts<=n.attached)return;let r=n.value;if(p(r)){let n=e.stopImmediatePropagation;e.stopImmediatePropagation=()=>{n.call(e),e._stopped=!0};let i=r.slice(),a=[e];for(let n=0;n<i.length&&!e._stopped;n++){let e=i[n];e&&pn(e,t,5,a)}}else pn(r,t,5,[e])};return n.value=e,n.attached=mo(),n}var go=e=>e.charCodeAt(0)===111&&e.charCodeAt(1)===110&&e.charCodeAt(2)>96&&e.charCodeAt(2)<123,_o=(e,t,n,r,i,a)=>{let o=i===`svg`;t===`class`?Va(e,r,o):t===`style`?Ja(e,n,r):s(t)?c(t)||so(e,t,n,r,a):(t[0]===`.`?(t=t.slice(1),!0):t[0]===`^`?(t=t.slice(1),!1):vo(e,t,r,o))?(ro(e,t,r),!e.tagName.includes(`-`)&&(t===`value`||t===`checked`||t===`selected`)&&no(e,t,r,o,a,t!==`value`)):e._isVueCE&&(yo(e,t)||e._def.__asyncLoader&&(/[A-Z]/.test(t)||!v(r)))?ro(e,ie(t),r,a,t):(t===`true-value`?e._trueValue=r:t===`false-value`&&(e._falseValue=r),no(e,t,r,o))};function vo(e,t,n,r){if(r)return!!(t===`innerHTML`||t===`textContent`||t in e&&go(t)&&_(n));if(t===`spellcheck`||t===`draggable`||t===`translate`||t===`autocorrect`||t===`sandbox`&&e.tagName===`IFRAME`||t===`form`||t===`list`&&e.tagName===`INPUT`||t===`type`&&e.tagName===`TEXTAREA`)return!1;if(t===`width`||t===`height`){let t=e.tagName;if(t===`IMG`||t===`VIDEO`||t===`CANVAS`||t===`SOURCE`)return!1}return go(t)&&v(n)?!1:t in e}function yo(e,t){let n=e._def.props;if(!n)return!1;let r=ie(t);return Array.isArray(n)?n.some(e=>ie(e)===r):Object.keys(n).some(e=>ie(e)===r)}var bo=e=>{let t=e.props[`onUpdate:modelValue`]||!1;return p(t)?e=>le(t,e):t};function xo(e){e.target.composing=!0}function So(e){let t=e.target;t.composing&&(t.composing=!1,t.dispatchEvent(new Event(`input`)))}var Co=Symbol(`_assign`);function wo(e,t,n){return t&&(e=e.trim()),n&&(e=D(e)),e}var To={created(e,{modifiers:{lazy:t,trim:n,number:r}},i){e[Co]=bo(i);let a=r||i.props&&i.props.type===`number`;io(e,t?`change`:`input`,t=>{t.target.composing||e[Co](wo(e.value,n,a))}),(n||a)&&io(e,`change`,()=>{e.value=wo(e.value,n,a)}),t||(io(e,`compositionstart`,xo),io(e,`compositionend`,So),io(e,`change`,So))},mounted(e,{value:t}){e.value=t??``},beforeUpdate(e,{value:t,oldValue:n,modifiers:{lazy:r,trim:i,number:a}},o){if(e[Co]=bo(o),e.composing)return;let s=(a||e.type===`number`)&&!/^0\d/.test(e.value)?D(e.value):e.value,c=t??``;if(s===c)return;let l=e.getRootNode();(l instanceof Document||l instanceof ShadowRoot)&&l.activeElement===e&&e.type!==`range`&&(r&&t===n||i&&e.value.trim()===c)||(e.value=c)}},Eo={deep:!0,created(e,t,n){e[Co]=bo(n),io(e,`change`,()=>{let t=e._modelValue,n=Oo(e),r=e.checked,i=e[Co];if(p(t)){let e=we(t,n),a=e!==-1;if(r&&!a)i(t.concat(n));else if(!r&&a){let n=[...t];n.splice(e,1),i(n)}}else if(h(t)){let e=new Set(t);r?e.add(n):e.delete(n),i(e)}else i(ko(e,r))})},mounted:Do,beforeUpdate(e,t,n){e[Co]=bo(n),Do(e,t,n)}};function Do(e,{value:t,oldValue:n},r){e._modelValue=t;let i;if(p(t))i=we(t,r.props.value)>-1;else if(h(t))i=t.has(r.props.value);else{if(t===n)return;i=Ce(t,ko(e,!0))}e.checked!==i&&(e.checked=i)}function Oo(e){return`_value`in e?e._value:e.value}function ko(e,t){let n=t?`_trueValue`:`_falseValue`;return n in e?e[n]:t}var Ao=[`ctrl`,`shift`,`alt`,`meta`],jo={stop:e=>e.stopPropagation(),prevent:e=>e.preventDefault(),self:e=>e.target!==e.currentTarget,ctrl:e=>!e.ctrlKey,shift:e=>!e.shiftKey,alt:e=>!e.altKey,meta:e=>!e.metaKey,left:e=>`button`in e&&e.button!==0,middle:e=>`button`in e&&e.button!==1,right:e=>`button`in e&&e.button!==2,exact:(e,t)=>Ao.some(n=>e[`${n}Key`]&&!t.includes(n))},Mo=(e,t)=>{if(!e)return e;let n=e._withMods||={},r=t.join(`.`);return n[r]||(n[r]=((n,...r)=>{for(let e=0;e<t.length;e++){let r=jo[t[e]];if(r&&r(n,t))return}return e(n,...r)}))},No=l({patchProp:_o},za),Po;function Fo(){return Po||=Si(No)}var Io=((...e)=>{let t=Fo().createApp(...e),{mount:n}=t;return t.mount=e=>{let r=Ro(e);if(!r)return;let i=t._component;!_(i)&&!i.render&&!i.template&&(i.template=r.innerHTML),r.nodeType===1&&(r.textContent=``);let a=n(r,!1,Lo(r));return r instanceof Element&&(r.removeAttribute(`v-cloak`),r.setAttribute(`data-v-app`,``)),a},t});function Lo(e){if(e instanceof SVGElement)return`svg`;if(typeof MathMLElement==`function`&&e instanceof MathMLElement)return`mathml`}function Ro(e){return v(e)?document.querySelector(e):e}var zo={id:`settingsMenu`},Bo=[`disabled`],Vo={class:`header-title-row`},Ho=[`value`,`disabled`],Uo=[`value`],Wo={class:`sub`},Go={__name:`HeaderStatus`,props:{songTitle:{type:String,required:!0},statusText:{type:String,required:!0},statusClass:{type:String,required:!0},metaLine:{type:String,default:``},showRetry:{type:Boolean,default:!1},settingsDisabled:{type:Boolean,default:!0},chartList:{type:Array,default:()=>[]},currentChart:{type:String,default:``}},emits:[`retry`,`toggle-settings`,`select-chart`],setup(e,{expose:t}){let n=A(null);return t({toggleButton:n}),(t,r)=>(Bi(),Gi(`header`,null,[M(`div`,zo,[M(`button`,{ref_key:`toggleButton`,ref:n,class:`btn-settings`,title:`倍速／流速／音量`,disabled:e.settingsDisabled,onClick:r[0]||=e=>t.$emit(`toggle-settings`,e)},`⚙`,8,Bo)]),M(`div`,Vo,[M(`h1`,null,O(e.songTitle),1),M(`select`,{class:`chart-select-dropdown`,value:e.currentChart,disabled:e.settingsDisabled,title:`切換 testChart 測試譜面`,onChange:r[1]||=e=>t.$emit(`select-chart`,e.target.value)},[(Bi(!0),Gi(Pi,null,br(e.chartList&&e.chartList.length?e.chartList:[{id:`チューリングの跡_master.simai`,name:`チューリングの跡_master`},{id:`渦状銀河のシンフォニエッタ.simai`,name:`渦状銀河のシンフォニエッタ`}],e=>(Bi(),Gi(`option`,{key:e.id,value:e.id},` 🎵 `+O(e.name),9,Uo))),128))],40,Ho)]),M(`div`,{class:ve(e.statusClass)},O(e.statusText),3),e.showRetry?(Bi(),Gi(`button`,{key:0,class:`btn-retry`,onClick:r[2]||=e=>t.$emit(`retry`)},`🔄 重新連線`)):ra(``,!0),M(`div`,Wo,O(e.metaLine),1)]))}},Ko={class:`speedbox`},qo=[`value`,`disabled`],Jo={id:`speedVal`},Yo={class:`speedbox`},Xo=[`value`,`disabled`],Zo={id:`hsVal`},Qo={class:`speedbox`},$o=[`value`],es={id:`sfxVal`},ts={class:`speedbox`},ns={__name:`SettingsPanel`,props:{open:{type:Boolean,required:!0},positionStyle:{type:Object,default:()=>({})},speed:{type:Number,required:!0},hs:{type:Number,required:!0},sfxVolume:{type:Number,required:!0},sfxModeLabel:{type:String,required:!0},sfxOff:{type:Boolean,default:!1},cleanCut:{type:Boolean,required:!0},disabled:{type:Boolean,default:!1}},emits:[`update:speed`,`update:hs`,`update:sfx-volume`,`cycle-sfx-mode`,`toggle-clean-cut`],setup(e,{expose:t,emit:n}){let r=n,i=A(null);return t({panelRoot:i}),(t,n)=>In((Bi(),Gi(`div`,{ref_key:`panelRoot`,ref:i,id:`settingsPanel`,class:ve([`control-settings`,{"sfx-off":e.sfxOff}]),style:pe(e.positionStyle),onClick:n[5]||=Mo(()=>{},[`stop`])},[M(`span`,Ko,[n[6]||=ta(`倍速 `,-1),M(`input`,{type:`range`,min:`0.25`,max:`1`,step:`0.05`,value:e.speed,disabled:e.disabled,onInput:n[0]||=e=>r(`update:speed`,+e.target.value)},null,40,qo),M(`span`,Jo,O(e.speed.toFixed(2))+`×`,1)]),M(`span`,Yo,[n[7]||=ta(`流速 `,-1),M(`input`,{type:`range`,min:`1`,max:`10`,step:`0.5`,value:e.hs,disabled:e.disabled,onInput:n[1]||=e=>r(`update:hs`,+e.target.value)},null,40,Xo),M(`span`,Zo,O(e.hs.toFixed(1)),1)]),M(`span`,Qo,[M(`button`,{class:`btn-sfx-mode`,title:`切換音效模式`,onClick:n[2]||=e=>r(`cycle-sfx-mode`)},O(e.sfxModeLabel),1),M(`input`,{id:`sfxSlider`,type:`range`,min:`0`,max:`1`,step:`0.05`,value:e.sfxVolume,onInput:n[3]||=e=>r(`update:sfx-volume`,+e.target.value)},null,40,$o),M(`span`,es,O(Math.round(e.sfxVolume*100))+`%`,1)]),M(`span`,ts,[M(`button`,{class:`btn-sfx-mode`,title:`開：精準切在選取的 combo 上，結尾不多留（就算切斷 hold／slide）。關：結尾多留一點讓判定特效收完。`,onClick:n[4]||=e=>r(`toggle-clean-cut`)},`✂ 切的乾淨：`+O(e.cleanCut?`開`:`關`),1)])],6)),[[Wa,e.open]])}},rs={class:`nav-col`},is=[`disabled`],as=[`disabled`],os=[`disabled`],ss=[`disabled`],cs=[`disabled`],ls=[`disabled`],us=[`disabled`],ds={__name:`PlayerControls`,props:{side:{type:String,required:!0},playing:{type:Boolean,required:!0},disabled:{type:Boolean,default:!0}},emits:[`jump-time`,`step-note`,`step-comma`,`toggle-play`],setup(e,{emit:t}){let n=t;return(t,r)=>(Bi(),Gi(`div`,rs,[e.side===`left`?(Bi(),Gi(Pi,{key:0},[M(`button`,{title:`後退約3秒`,disabled:e.disabled,onClick:r[0]||=e=>n(`jump-time`,-3)},`＜＜＜`,8,is),M(`button`,{title:`跳到上一顆音符`,disabled:e.disabled,onClick:r[1]||=e=>n(`step-note`,-1)},`＜＜`,8,as),M(`button`,{title:`後退 1 個逗號`,disabled:e.disabled,onClick:r[2]||=e=>n(`step-comma`,-1)},`＜`,8,os)],64)):(Bi(),Gi(Pi,{key:1},[M(`button`,{title:`前進約3秒`,disabled:e.disabled,onClick:r[3]||=e=>n(`jump-time`,3)},`＞＞＞`,8,ss),M(`button`,{title:`跳到下一顆音符`,disabled:e.disabled,onClick:r[4]||=e=>n(`step-note`,1)},`＞＞`,8,cs),M(`button`,{title:`前進 1 個逗號`,disabled:e.disabled,onClick:r[5]||=e=>n(`step-comma`,1)},`＞`,8,ls)],64)),M(`button`,{class:`btn-play`,disabled:e.disabled,onClick:r[6]||=e=>n(`toggle-play`)},O(e.playing?`⏸`:`▶`),9,us)]))}},fs=[`id`],ps=[`id`],ms={__name:`ChartCanvas`,props:{attach:{type:Function,required:!0},detach:{type:Function,required:!0},stageId:{type:String,default:`stage`},canvasId:{type:String,default:`chartCanvas`}},setup(e){let t=e,n=A(null);return ur(()=>t.attach(n.value)),mr(()=>t.detach()),(t,r)=>(Bi(),Gi(`div`,{id:e.stageId},[M(`canvas`,{ref_key:`canvasEl`,ref:n,id:e.canvasId},null,8,ps)],8,fs))}},hs={id:`rangePanel`},gs={id:`rangeHeader`},_s={class:`range-row`},vs=[`max`,`value`,`disabled`],ys={class:`range-row`},bs=[`max`,`value`,`disabled`],xs={id:`rangeEnds`},Ss=[`disabled`],Cs=[`disabled`],ws={id:`rangeActions`},Ts=[`disabled`],Es=[`disabled`],Ds=[`disabled`],Os={__name:`RangeSelector`,props:{chart:{type:Object,required:!0},engine:{type:Object,required:!0},rangeSel:{type:Object,required:!0},disabled:{type:Boolean,default:!0}},emits:[`export`,`preview`],setup(e,{emit:t}){let n=e,r=t,i=0,a=0;function o(e){if(n.disabled)return;n.rangeSel.setActiveEndpoint(e);let t=performance.now(),r=e===`a`?n.rangeSel.rangeAValue.value:n.rangeSel.rangeBValue.value;if(t-(e===`a`?i:a)<350){n.engine.seek(n.chart.C.value[r]??0),e===`a`?i=0:a=0;return}e===`a`?i=t:a=t}return(t,n)=>(Bi(),Gi(`div`,hs,[M(`div`,gs,[n[9]||=M(`span`,{class:`range-title`},`✂️ 選取並傳送`,-1),M(`span`,{id:`rangeLabel`,class:ve({"over-limit":e.rangeSel.rangeOverLimit.value})},O(e.rangeSel.rangeLabel.value),3)]),M(`div`,_s,[n[11]||=M(`span`,{class:`range-row-label`},`起`,-1),M(`div`,{class:ve([`range-track`,{"over-limit":e.rangeSel.rangeOverLimit.value}]),onPointerdown:n[1]||=e=>o(`a`)},[n[10]||=M(`div`,{class:`range-track-bg`},null,-1),M(`input`,{type:`range`,min:`0`,max:e.rangeSel.maxComma.value,step:`1`,value:e.rangeSel.rangeAValue.value,disabled:e.disabled,class:ve({active:e.rangeSel.activeEndpoint.value===`a`}),onInput:n[0]||=t=>e.rangeSel.onRangeInput(`a`,+t.target.value)},null,42,vs),M(`div`,{class:`range-tip`,style:pe({left:e.rangeSel.rangeAValue.value/(e.rangeSel.maxComma.value||1)*100+`%`})},O(e.rangeSel.commaLabel(e.rangeSel.rangeAValue.value)),5)],34)]),M(`div`,ys,[n[13]||=M(`span`,{class:`range-row-label`},`終`,-1),M(`div`,{class:ve([`range-track`,{"over-limit":e.rangeSel.rangeOverLimit.value}]),onPointerdown:n[3]||=e=>o(`b`)},[n[12]||=M(`div`,{class:`range-track-bg`},null,-1),M(`input`,{type:`range`,min:`0`,max:e.rangeSel.maxComma.value,step:`1`,value:e.rangeSel.rangeBValue.value,disabled:e.disabled,class:ve({active:e.rangeSel.activeEndpoint.value===`b`}),onInput:n[2]||=t=>e.rangeSel.onRangeInput(`b`,+t.target.value)},null,42,bs),M(`div`,{class:`range-tip`,style:pe({left:e.rangeSel.rangeBValue.value/(e.rangeSel.maxComma.value||1)*100+`%`})},O(e.rangeSel.commaLabel(e.rangeSel.rangeBValue.value)),5)],34)]),M(`div`,xs,[M(`button`,{disabled:e.disabled,onClick:n[4]||=t=>e.rangeSel.setStart()},`← 起點`,8,Ss),M(`button`,{disabled:e.disabled,onClick:n[5]||=t=>e.rangeSel.setEnd()},`終點 →`,8,Cs)]),M(`div`,ws,[M(`button`,{disabled:e.disabled,onClick:n[6]||=t=>e.rangeSel.goStart()},`跳到起點`,8,Ts),M(`button`,{disabled:e.disabled,onClick:n[7]||=e=>r(`preview`)},`▶ 預覽`,8,Es)]),M(`button`,{class:`btn-export`,disabled:e.disabled,onClick:n[8]||=e=>r(`export`)},`✅ 傳送此區間`,8,Ds)]))}},ks={id:`timeline`},As=[`max`,`value`,`disabled`],js={__name:`Timeline`,props:{chart:{type:Object,required:!0},engine:{type:Object,required:!0},rangeSel:{type:Object,required:!0},disabled:{type:Boolean,default:!0}},emits:[`export`,`preview`],setup(e){let t=e,n=A(null),r=A(null),i=A(null),a=A(0),o=null;Hn(t.engine.hudMeasureFloat,e=>{t.engine.dragging.value||(a.value=e)});function s(){t.engine.setDragging(!0),t.rangeSel.setActiveEndpoint(null)}function c(){t.engine.setDragging(!1)}function l(e){let n=+e.target.value;a.value=n,t.rangeSel.setActiveEndpoint(null),t.engine.seek(t.engine.measureTime(n))}function u(e){t.engine.setDragging(!0),t.rangeSel.setActiveEndpoint(null),t.rangeSel.densitySeek(e.clientX,n.value)}function d(e){t.engine.dragging.value&&t.rangeSel.densitySeek(e.clientX,n.value)}return ur(()=>{t.rangeSel.setDensityCanvas(r.value),window.addEventListener(`pointerup`,c),window.ResizeObserver?(o=new ResizeObserver(()=>{requestAnimationFrame(()=>t.rangeSel.drawDensity(t.engine.hudMeasure.value))}),o.observe(n.value)):t.rangeSel.drawDensity(t.engine.hudMeasure.value)}),mr(()=>{window.removeEventListener(`pointerup`,c),o?.disconnect()}),(t,o)=>(Bi(),Gi(`div`,ks,[M(`div`,{id:`densityWrap`,ref_key:`densityWrapEl`,ref:n,onPointerdown:u,onPointermove:d},[M(`canvas`,{ref_key:`densityCanvasEl`,ref:r,id:`densityCanvas`},null,512)],544),o[2]||=M(`div`,{id:`timeLabels`},null,-1),M(`input`,{ref_key:`measureSliderEl`,ref:i,type:`range`,id:`measureSlider`,min:`0`,max:e.chart.M.value.length-1,step:`0.005`,value:a.value,disabled:e.disabled,class:ve({active:e.rangeSel.activeEndpoint.value===null}),onPointerdown:s,onInput:l},null,42,As),o[3]||=M(`div`,{id:`measureTicks`},null,-1),Zi(Os,{chart:e.chart,engine:e.engine,"range-sel":e.rangeSel,disabled:e.disabled,onExport:o[0]||=e=>t.$emit(`export`),onPreview:o[1]||=e=>t.$emit(`preview`)},null,8,[`chart`,`engine`,`range-sel`,`disabled`])]))}},Ms=(e,t)=>{let n=e.__vccOpts||e;for(let[e,r]of t)n[e]=r;return n},Ns={},Ps={id:`legend`};function Fs(e,t){return Bi(),Gi(`div`,Ps,[...t[0]||=[na(`<span><i style="background:var(--tap);"></i>TAP</span><span><i style="background:var(--hold);"></i>HOLD</span><span><i style="background:var(--slide);"></i>SLIDE</span><span><i style="background:var(--touch);"></i>TOUCH</span><span><i style="background:var(--brk);"></i>BREAK</span>`,5)]])}var Is=Ms(Ns,[[`render`,Fs]]),Ls={class:`app-footer`},Rs={__name:`FooterMessage`,props:{text:{type:String,default:``},type:{type:String,default:``}},setup(e){return(t,n)=>(Bi(),Gi(`footer`,Ls,[M(`p`,{class:ve([`message`,e.type])},O(e.text),3)]))}},zs={class:`modal-box`},Bs={class:`modal-meta`},Vs={class:`modal-simai-text`},Hs={class:`modal-actions`},Us={__name:`ConfirmModal`,props:{open:{type:Boolean,required:!0},meta:{type:String,default:``},previewText:{type:String,default:``}},emits:[`confirm`,`cancel`],setup(e,{emit:t}){let n=t;return(t,r)=>e.open?(Bi(),Gi(`div`,{key:0,class:`modal-overlay`,onClick:r[2]||=e=>e.target===e.currentTarget&&n(`cancel`)},[M(`div`,zs,[r[3]||=M(`h3`,null,`確認送出內容`,-1),M(`p`,Bs,O(e.meta),1),M(`pre`,Vs,O(e.previewText),1),M(`div`,Hs,[M(`button`,{class:`btn-modal-cancel`,onClick:r[0]||=e=>n(`cancel`)},`取消`),M(`button`,{class:`btn-export`,onClick:r[1]||=e=>n(`confirm`)},`✅ 確認送出`)])])])):ra(``,!0)}},N=100*.889/2,Ws=`./Skin/`,Gs=`no_image.tap.tap_break.tap_each.tap_ex.tap_mine.NormalArc.BreakArc.EachArc.SlideArc.MineArc.hold.hold_break.hold_each.hold_ex.hold_mine.hold_break_on.hold_each_on.hold_on.Hold_End.Hold_Break_End.Hold_Each_End.Hold_Mine_End.touch.touch_each.touch_mine.touch_point.touch_point_each.touch_point_mine.touch_border_2.touch_border_3.touch_border_2_each.touch_border_3_each.touch_border_2_mine.touch_border_3_mine.star.star_pink.star_break.star_each.star_ex.star_mine.star_double.star_pink_double.star_break_double.star_each_double.star_ex_double.star_mine_double.slide.slide_each.slide_break.slide_mine.touchhold_0.touchhold_1.touchhold_2.touchhold_3.touchhold_border.touchhold_0_mine.touchhold_1_mine.touchhold_2_mine.touchhold_3_mine.touchhold_border_mine`.split(`.`),Ks=[`wifi_`,`wifi_break_`,`wifi_each_`,`wifi_mine_`],qs={tap:`#D8A2C9`,star:`#00DBF4`,double:`#DCDA6B`,break:`#EBBA63`};function Js(e,t,n,r=0,i=0,a=1,o=1){e.drawImage(t,-n/2*a+r,-n/2*o+i,n*a,n*o)}function Ys(e,t,n,r=!1){let i=RegExp(`\\${t}([^\\${t}\\${n}]*)\\${n}`,`g`),a=[...e.matchAll(i)],o=e.replace(i,``);if(o.includes(t)||o.includes(n))return{error:`Invalid format: nested or unmatched ${t}${n}`};let s=null;for(let e of a){let i=e[1].trim();if(i.startsWith(`#`)&&r){let e=parseFloat(i.substring(1));return isNaN(e)||e<0?{error:`Invalid duration value in direct assign ${t}${n}: must be a non-negative number`}:{residue:o.trim(),value:e,override:!0}}if(i===``||isNaN(i)||parseFloat(i)<=0)return{error:`Invalid value in ${t}${n}: must be a positive number`};s=parseFloat(i)}return{residue:o.trim(),value:s}}function Xs(e,t,n=!1){if(n){if(e.includes(`##`)){let n=e.split(`##`);if(n.length===3){let t=parseFloat(n[0]),r=parseFloat(n[1]);if(isNaN(t)||t<0||isNaN(r)||r<=0)return console.warn(`Invalid delay or bpm value in slide note:`,e),{time:-1,delay:-1};let[i,a]=n[2].split(`:`);return isNaN(a)||parseFloat(i)<0||parseFloat(a)<0?(console.warn(`Invalid time or beat value in slide note:`,e),{time:-1,delay:-1}):{time:240/r*(parseFloat(a)/parseFloat(i)),delay:t}}else if(n.length===2){let r=parseFloat(n[0]);if(isNaN(r)||r<0)return console.warn(`Invalid delay value in slide note:`,e),{time:-1,delay:-1};if(n[1].includes(`:`)){let[i,a]=n[1].split(`:`);return isNaN(a)||parseFloat(i)<0||parseFloat(a)<0?(console.warn(`Invalid time or beat value in slide note:`,e),{time:-1,delay:-1}):{time:240/t*(parseFloat(a)/parseFloat(i)),delay:r}}let i=parseFloat(n[1]);return isNaN(i)||i<0?(console.warn(`Invalid time value in slide note:`,e),{time:-1,delay:-1}):{time:i,delay:r}}}else if(e.includes(`#`)&&!e.includes(`:`)){let[t,n]=e.split(`#`).map(e=>e.trim()),r=parseFloat(t),i=parseFloat(n);return isNaN(r)||r<=0||isNaN(i)||i<0?(console.warn(`Invalid bpm or time value in slide note:`,e),{time:-1,delay:-1}):{time:i,delay:60/r}}}else if(e.startsWith(`#`)){let t=parseFloat(e.substring(1));return isNaN(t)||t<0?(console.warn(`Invalid duration value in direct assign note:`,e),{time:-1,delay:-1}):{time:t,delay:0}}if(e.includes(`:`)){let[n,r]=e.split(`:`);if(isNaN(r)||parseFloat(n)<0||parseFloat(r)<0)return console.warn(`Invalid time or beat value in hold note:`,e),{time:-1,delay:-1};if(n.includes(`#`)){let[e,t]=n.split(`#`),i=parseFloat(e);return{time:240/i*(parseFloat(r)/parseFloat(t)),delay:60/i}}else return{time:240/t*(parseFloat(r)/parseFloat(n)),delay:60/t}}return console.warn(`Invalid hold duration format or empty:`,e),{time:-1,delay:-1}}var Zs=class{constructor(){this.segments=[],this.totalLength=0,this.currentPoint={x:0,y:0}}moveTo(e,t){this.currentPoint={x:e,y:t}}lineTo(e,t){let n=this.currentPoint.x,r=this.currentPoint.y,i=Math.sqrt((e-n)**2+(t-r)**2);this.segments.push({type:`line`,start:{x:n,y:r},end:{x:e,y:t},length:i,cumLength:this.totalLength}),this.totalLength+=i,this.currentPoint={x:e,y:t}}arc(e,t,n,r,i,a=!1,o=0){let s=i-r;!a&&s<=0&&(s+=Math.PI*2),a&&s>=0&&(s-=Math.PI*2);let c=Math.PI*2*o;a?s-=c:s+=c;let l=Math.abs(s*n);this.segments.push({type:`arc`,cx:e,cy:t,r:n,startAngle:r,endAngle:i,diff:s,length:l,cumLength:this.totalLength}),this.totalLength+=l,this.currentPoint={x:e+n*Math.cos(i),y:t+n*Math.sin(i)}}getPointAt(e){if(this.segments.length===0)return{...this.currentPoint,rot:0};e<=0&&(e=0),e>=1&&(e=1);let t=e*this.totalLength,n=this.segments.find(e=>t>=e.cumLength&&t<=e.cumLength+e.length)||this.segments[this.segments.length-1],r=n.length===0?1:(t-n.cumLength)/n.length;if(n.type===`line`){let e=Math.atan2(n.end.y-n.start.y,n.end.x-n.start.x);return{x:n.start.x+(n.end.x-n.start.x)*r,y:n.start.y+(n.end.y-n.start.y)*r,rot:e}}else if(n.type===`arc`){let e=n.startAngle+n.diff*r,t=e+(n.diff>0?Math.PI/2:-Math.PI/2);return{x:n.cx+n.r*Math.cos(e),y:n.cy+n.r*Math.sin(e),rot:t}}}lineToArc(e,t,n,r){let i=e+n*Math.cos(r),a=t+n*Math.sin(r);this.lineTo(i,a)}},Qs={A:Array.from({length:8},(e,t)=>{let n=(t-1.5)*Math.PI/4;return{x:Math.cos(n)*N*.833,y:Math.sin(n)*N*.833,rot:n+Math.PI/2}}),B:Array.from({length:8},(e,t)=>{let n=(t-1.5)*Math.PI/4;return{x:Math.cos(n)*N*.458,y:Math.sin(n)*N*.458,rot:n+Math.PI/2}}),C:[{x:0,y:0}],D:Array.from({length:8},(e,t)=>{let n=(t-2)*Math.PI/4;return{x:Math.cos(n)*N*.854,y:Math.sin(n)*N*.854,rot:n+Math.PI/2}}),E:Array.from({length:8},(e,t)=>{let n=(t-2)*Math.PI/4;return{x:Math.cos(n)*N*.645,y:Math.sin(n)*N*.645,rot:n+Math.PI/2}})},$s=Array.from({length:8},(e,t)=>{let n=(t-1.5)*Math.PI/4;return{x:Math.cos(n)*N,y:Math.sin(n)*N,rot:n+Math.PI/2}});Array.from({length:8},(e,t)=>({x:(3.5-t)*N/4}));var ec=new class{constructor(){this.globalGain=.65,this.bgmVolume=.8,this.sfxMasterVolume=.5,this.reinitContext(),this.bufferMap=new Map,this.playingSources=new Map,this.soundQueue=[],this.lastQueuedTimes=new Map,this.MIN_INTERVAL=15,this.bgmBuffer=null,this.bgmSource=null,this.bgmStartTime=0,this.bgmOffset=0,this.playbackRate=1,this.soundFiles={clock:`./Sounds/clock.wav`,judge:`./Sounds/judge.wav`,judge_ex:`./Sounds/judge_ex.wav`,judge_break:`./Sounds/judge_break.wav`,answer:`./Sounds/answer.wav`,break:`./Sounds/break.wav`,slide:`./Sounds/slide.wav`,break_slide_start:`./Sounds/break_slide_start.wav`,judge_break_slide:`./Sounds/judge_break_slide.wav`,touch:`./Sounds/touch.wav`,hanabi:`./Sounds/hanabi.wav`,touchHold_riser:`./Sounds/touchHold_riser.wav`},this.sfxVolumes={clock:.8,answer:1,judge:.4,judge_ex:.4,judge_break:.4,judge_break_slide:.4,break:.4,slide:.4,break_slide_start:.4,touch:.4,hanabi:.6},this.activeLongSounds=new Map,this.loopPoints={touchHold_riser:{start:10,end:11.8}},this.scheduledSources=[],this.muted=!1,this.synthFallback=!1,this.lastResumeAttemptTime=0,this.lastReinitTime=0}reinitContext(){let e=Date.now();if(typeof window<`u`){if(window.__lastAudioReinitTime=window.__lastAudioReinitTime||0,e-window.__lastAudioReinitTime<5e3)return;window.__lastAudioReinitTime=e}try{if(this.ctx)try{this.ctx.close()}catch{}let e=window.AudioContext||window.webkitAudioContext;this.ctx=new e,this.masterGain=this.ctx.createGain(),this.masterGain.gain.value=this.globalGain,this.masterGain.connect(this.ctx.destination),this.bgmGainNode=this.ctx.createGain(),this.bgmGainNode.connect(this.masterGain),this.bgmGainNode.gain.value=this.bgmVolume,this.sfxGainNode=this.ctx.createGain(),this.sfxGainNode.connect(this.masterGain),this.sfxGainNode.gain.value=this.sfxMasterVolume,this.longSoundGainNode=this.ctx.createGain(),this.longSoundGainNode.gain.value=.25,this.longSoundCompressor=this.ctx.createDynamicsCompressor();let t=this.ctx.currentTime;this.longSoundCompressor.threshold.setValueAtTime(-16,t),this.longSoundCompressor.knee.setValueAtTime(8,t),this.longSoundCompressor.ratio.setValueAtTime(4,t),this.longSoundCompressor.attack.setValueAtTime(.005,t),this.longSoundCompressor.release.setValueAtTime(.25,t),this.longSoundGainNode.connect(this.longSoundCompressor),this.longSoundCompressor.connect(this.sfxGainNode),this.ctx.addEventListener(`statechange`,()=>{console.log(`[Audio] AudioContext state changed to: ${this.ctx.state}`)})}catch(e){console.error(`[Audio] Failed to initialize AudioContext:`,e)}}ensureContextSync(){if(!this.ctx||this.ctx.state===`closed`){console.warn(`[Audio] AudioContext is null or closed. Re-initializing...`),this.reinitContext();return}if(this.ctx&&this.ctx.state===`suspended`){let e=Date.now();typeof window<`u`?(window.__lastAudioResumeAttemptTime=window.__lastAudioResumeAttemptTime||0,e-window.__lastAudioResumeAttemptTime>3e3&&(window.__lastAudioResumeAttemptTime=e,console.log(`[Audio] AudioContext is suspended. Attempting to resume...`),this.ctx.resume().catch(e=>{console.warn(`[Audio] Failed to resume AudioContext:`,e)}))):(!this.lastResumeAttemptTime||e-this.lastResumeAttemptTime>3e3)&&(this.lastResumeAttemptTime=e,this.ctx.resume().catch(e=>{console.warn(`[Audio] Failed to resume AudioContext:`,e)}))}}async setBackgroundMusic(e,t=null){this.ensureContextSync();try{this.bgmFile=t||e;let n;if(e instanceof Blob)n=await e.arrayBuffer();else{let t=await fetch(e);if(!t.ok)throw Error(`Failed to fetch BGM: HTTP ${t.status}`);n=await t.arrayBuffer()}this.bgmBuffer=await this.ctx.decodeAudioData(n),console.log(`[Audio] BGM 載入完成，長度: ${this.bgmBuffer.duration.toFixed(2)}s`)}catch(e){console.error(`[Audio] BGM 載入失敗`,e)}}async removeBackgroundMusic(){this.stopBGM(),this.bgmBuffer=null,this.bgmFile=null}haveBGM(){return!!this.bgmBuffer}getBGMFile(){return this.bgmFile instanceof Blob||typeof this.bgmFile==`string`?this.bgmFile:null}setBGMVolume(e){this.ensureContextSync(),this.bgmVolume=Math.max(0,Math.min(1,e)),this.bgmGainNode.gain.setTargetAtTime(this.bgmVolume,this.ctx.currentTime,.05)}setPlaybackRate(e){this.ensureContextSync(),this.playbackRate=Math.max(.1,Math.min(4,Number(e)||1)),this.bgmSource&&this.bgmSource.playbackRate.setTargetAtTime(this.playbackRate,this.ctx.currentTime,.05)}playBGM(e=0,t=1){if(!this.bgmBuffer)return;this.ensureContextSync(),this.stopBGM(),this.bgmSource=this.ctx.createBufferSource(),this.bgmSource.buffer=this.bgmBuffer,this.bgmSource.playbackRate.value=this.playbackRate;let n=this.ctx.createGain();n.gain.value=typeof t==`number`?Math.max(0,Math.min(1,t)):this.bgmVolume,this.bgmSource.connect(n),n.connect(this.bgmGainNode),this.ctx.state===`suspended`&&this.ctx.resume(),this.bgmStartTime=this.ctx.currentTime,this.bgmOffset=Math.max(0,e),this.bgmSource.start(0,this.bgmOffset)}stopBGM(){if(this.stopAllScheduledSounds(),this.bgmSource){try{this.bgmSource.stop()}catch{}this.bgmSource=null}}_synthSpec(e){switch(e){case`judge`:return{freq:2e3,dur:.03,type:`square`,gain:.5};case`judge_ex`:return{freq:2200,dur:.03,type:`square`,gain:.5};case`judge_break`:return{freq:2600,dur:.05,type:`square`,gain:.8};case`judge_break_slide`:return{freq:2400,dur:.05,type:`square`,gain:.7};case`break`:return{freq:1200,dur:.06,type:`sawtooth`,gain:.6};case`break_slide_start`:return{freq:1800,dur:.05,type:`sawtooth`,gain:.6};case`slide`:return{freq:900,dur:.05,type:`triangle`,gain:.7};case`touch`:return{freq:1500,dur:.03,type:`sine`,gain:.8};case`hanabi`:return{freq:2800,dur:.08,type:`triangle`,gain:.7};case`clock`:return{freq:1e3,dur:.02,type:`square`,gain:.8};default:return null}}_playSynth(e,t=1,n=null){let r=this._synthSpec(e);if(!r||!this.ctx)return;let i=Math.max(this.ctx.currentTime,n??this.ctx.currentTime),a=i+r.dur;try{let e=this.ctx.createOscillator();e.type=r.type,e.frequency.setValueAtTime(r.freq,i);let n=this.ctx.createGain(),o=Math.max(1e-4,t*r.gain*.25);n.gain.setValueAtTime(1e-4,i),n.gain.exponentialRampToValueAtTime(o,i+.001),n.gain.exponentialRampToValueAtTime(1e-4,a),e.connect(n),n.connect(this.sfxGainNode),e.start(i),e.stop(a),this.scheduledSources.push(e),e.onended=()=>{let t=this.scheduledSources.indexOf(e);t!==-1&&this.scheduledSources.splice(t,1);try{n.disconnect()}catch{}}}catch(e){console.warn(`[Audio] 合成音播放失敗:`,e)}}stopAllScheduledSounds(){for(let e of this.scheduledSources)try{e.stop()}catch{}this.scheduledSources=[]}getBGMTime(){return!this.bgmSource||this.ctx.state===`suspended`?null:(this.ctx.currentTime-this.bgmStartTime)*this.playbackRate+this.bgmOffset}getBGMDuration(){return this.bgmBuffer?this.bgmBuffer.duration:0}setGlobalVolume(e){this.ensureContextSync(),this.globalGain=Math.max(0,Math.min(1,e)),this.masterGain.gain.setTargetAtTime(this.globalGain,this.ctx.currentTime,.05)}setSFXVolume(e){this.ensureContextSync(),this.sfxMasterVolume=Math.max(0,Math.min(1,e)),this.sfxGainNode.gain.setTargetAtTime(this.sfxMasterVolume,this.ctx.currentTime,.05)}setSFXVolumes(e){for(let[t,n]of Object.entries(e))this.sfxVolumes[t]!==void 0&&(this.sfxVolumes[t]=Math.max(0,Math.min(1,n)))}async init(e){this.ensureContextSync();let t=Object.keys(this.soundFiles).length,n=0,r=Object.entries(this.soundFiles).map(async([r,i])=>{try{let e=await fetch(i);if(!e.ok)throw Error(`HTTP ${e.status}`);let t=await e.arrayBuffer(),n=await this.ctx.decodeAudioData(t.slice(0));this.bufferMap.set(r,n)}catch(e){console.error(`[Audio] ${r} 載入失敗:`,e)}finally{n++,e&&e(n/t*100,r)}});await Promise.all(r)}queueSoundSingle(e,t){this._checkAndPush(e,t,!0,this.sfxVolumes[e])}queueSound(e,t){let n=performance.now();if(e._lastQueued&&n-e._lastQueued<this.MIN_INTERVAL)return;e._lastQueued=n;let r=this.getSfxEventsForNote(e,t);for(let e of r)this._checkAndPush(e.key,e.time,e.isMono,e.volume)}getSfxEventsForNote(e,t){let n=[],r=`judge`,i=!0;switch(e.type){case`tap`:e.isEx&&(r=`judge_ex`),e.isBreak&&(r=`judge_break`,n.push({key:`break`,time:t,isMono:!0,volume:this.sfxVolumes.break})),n.push({key:`answer`,time:t,isMono:!1,volume:this.sfxVolumes.answer});break;case`hold`:if(n.push({key:`answer`,time:t,isMono:!1,volume:this.sfxVolumes.answer}),!e._startEffectPlayed)e.isBreak?(r=`judge_break`,n.push({key:`break`,time:t,isMono:!0,volume:this.sfxVolumes.break})):r=e.isEx?`judge_ex`:`judge`,i=!1;else return n;break;case`touch`:if(r=`touch`,i=!1,n.push({key:`answer`,time:t,isMono:!1,volume:this.sfxVolumes.answer}),e.isHanabi)if(e.holdDuration>=0)if(e._startEffectPlayed)r=`hanabi`,i=!0;else return n;else r=`hanabi`,i=!0;if(e._startEffectPlayed&&!e.isHanabi)return n;break;case`slide`:!e._startEffectPlayed&&e.isBreak?(n.push({key:`break_slide`,time:t,isMono:!0,volume:this.sfxVolumes.break_slide}),r=`break_slide_start`,i=!1):e.isBreak?(r=`judge_break_slide`,i=!1):(r=`slide`,i=!1);break;default:return n}return n.push({key:r,time:t,isMono:i,volume:this.sfxVolumes[r]}),n}_checkAndPush(e,t,n,r=1){let i=performance.now();i-(this.lastQueuedTimes.get(e)||0)<this.MIN_INTERVAL||(this.lastQueuedTimes.set(e,i),this.soundQueue.push({key:e,targetTime:t,isMono:n,volume:r}),this.soundQueue.sort((e,t)=>e.targetTime-t.targetTime))}update(e){for(;this.soundQueue.length>0&&e+.1>=this.soundQueue[0].targetTime;){let{key:t,isMono:n,volume:r,targetTime:i}=this.soundQueue.shift(),a=this.ctx.currentTime+(i-e)/this.playbackRate;this.play(t,n,r,a)}}play(e,t=!1,n=1,r=null){if(this.muted)return;this.ensureContextSync();let i=this.bufferMap.get(e);if(!i){this.synthFallback&&this._playSynth(e,n,r);return}if(t&&this.playingSources.has(e))try{let t=this.playingSources.get(e),n=r===null?this.ctx.currentTime:Math.max(this.ctx.currentTime,r);t.stop(n)}catch{}let a=this.ctx.createBufferSource();a.buffer=i;let o=this.ctx.createGain();if(o.gain.value=n,a.connect(o),o.connect(this.sfxGainNode),t&&this.playingSources.set(e,a),r!==null){let e=Math.max(this.ctx.currentTime,r);a.start(e),this.scheduledSources.push(a),a.onended=()=>{let e=this.scheduledSources.indexOf(a);e!==-1&&this.scheduledSources.splice(e,1)}}else a.start(0)}startLongSound(e,t,n=0){let r=this.bufferMap.get(t),i=this.loopPoints[t];if(!r||this.activeLongSounds.has(e))return;let a=this.ctx.createBufferSource();a.buffer=r;let o=n;if(i){if(a.loop=!0,a.loopStart=i.start,a.loopEnd=i.end,n>=i.end){let e=i.end-i.start,t=(n-i.end)%e;o=i.start+t}}else if(n>=r.duration)return;let s=this.ctx.createGain();a.connect(s),s.connect(this.longSoundGainNode),a.start(0,Math.max(0,o)),this.activeLongSounds.set(e,{source:a,gainNode:s})}stopLongSound(e){if(this.activeLongSounds.has(e)){let{source:t,gainNode:n}=this.activeLongSounds.get(e);n.gain.exponentialRampToValueAtTime(.001,this.ctx.currentTime+.05),t.stop(this.ctx.currentTime+.05),this.activeLongSounds.delete(e)}}stopAllLongSounds(){for(let e of this.activeLongSounds.keys())this.stopLongSound(e)}clearSoundQueue(){this.soundQueue=[]}},tc={A:{points:[[.31,1],[.31,.65],[.15,.6]]},B:{points:[[.22,.53],[.46,.415],[.45,.35],[0,.275]]},D:{points:[[.167,1],[.155,.66],[0,.732]]},E:{points:[[0,.7],[.29,.585],[0,.437]]}},nc=[];for(let e=1;e<=8;e++){let t={A:e-2.5,B:e-2.5,D:e-2,E:e-2};[`A`,`B`,`D`,`E`].forEach(n=>{let r=new Path2D,i=tc[n],a=i.points.length,o=t[n];for(let e=0;e<a*2;e++){let[t,n]=e<a?i.points[e]:i.points[a-1-(e-a)];e>=a&&(t=-t);let s=(o-t)*(Math.PI/4),c=N*n*1.135,l=Math.cos(s)*c,u=Math.sin(s)*c;e===0?r.moveTo(l,u):r.lineTo(l,u)}r.closePath(),nc.push({id:`${n}${e}`,type:n,path:r})})}var rc=new Path2D;rc.moveTo(Math.cos(Math.PI*-.375)*N*.205*1.135-3,Math.sin(Math.PI*-.375)*N*.205*1.135),rc.lineTo(Math.cos(Math.PI*-.375)*N*.205*1.135,Math.sin(Math.PI*-.375)*N*.205*1.135),rc.lineTo(Math.cos(Math.PI*-.125)*N*.205*1.135,Math.sin(Math.PI*-.125)*N*.205*1.135),rc.lineTo(Math.cos(Math.PI*.125)*N*.205*1.135,Math.sin(Math.PI*.125)*N*.205*1.135),rc.lineTo(Math.cos(Math.PI*.375)*N*.205*1.135,Math.sin(Math.PI*.375)*N*.205*1.135),rc.lineTo(Math.cos(Math.PI*.375)*N*.205*1.135-3,Math.sin(Math.PI*.375)*N*.205*1.135),rc.closePath(),nc.push({id:`C1`,type:`C1`,path:rc});var ic=new Path2D;ic.moveTo(-(Math.cos(Math.PI*-.375)*N*.205*1.135-3),Math.sin(Math.PI*-.375)*N*.205*1.135),ic.lineTo(-Math.cos(Math.PI*-.375)*N*.205*1.135,Math.sin(Math.PI*-.375)*N*.205*1.135),ic.lineTo(-Math.cos(Math.PI*-.125)*N*.205*1.135,Math.sin(Math.PI*-.125)*N*.205*1.135),ic.lineTo(-Math.cos(Math.PI*.125)*N*.205*1.135,Math.sin(Math.PI*.125)*N*.205*1.135),ic.lineTo(-Math.cos(Math.PI*.375)*N*.205*1.135,Math.sin(Math.PI*.375)*N*.205*1.135),ic.lineTo(-(Math.cos(Math.PI*.375)*N*.205*1.135-3),Math.sin(Math.PI*.375)*N*.205*1.135),ic.closePath(),nc.push({id:`C2`,type:`C2`,path:ic});async function ac(e){let t={},n=[...Gs];Ks.forEach(e=>{for(let t=0;t<11;t++)n.push(e+t)});let r=n.length,i=0,a=t=>{i++,e&&e(i/r*100,t)},o=n.map(async e=>{let n=`${Ws}${e}.png`;try{try{let r=await oc(n,e);r&&(t[e]=r)}catch(t){console.warn(`[資源缺失] 無法載入 ${e}:`,t)}}finally{return a(e)}});return await Promise.all(o),t}async function oc(e,t){let n;try{let t=await fetch(e);if(!t.ok)throw Error(`HTTP status ${t.status}`);n=await t.blob()}catch(t){throw console.error(`圖片載入失敗: ${e}`,t),t}if(!n)throw Error(`Blob is null for key: ${t}`);return new Promise((e,r)=>{let i=new Image;i.onload=()=>e(i),i.onerror=e=>r(Error(`Failed to decode image blob for key: ${t}`)),i.src=URL.createObjectURL(n)})}function sc(e,t){console.warn(`path missing, using straight line as fallback`);let n=new Zs,r=$s[e-1],i=$s[t-1];return n.moveTo(r.x,r.y),n.lineTo(i.x,i.y),n}function cc(e,t,n,r,i=.5){let a=e.width||e.naturalWidth||0,o=e.height||e.naturalHeight||0;if(a===0||o===0)return null;let s;typeof OffscreenCanvas<`u`?s=new OffscreenCanvas(a,o):(s=document.createElement(`canvas`),s.width=a,s.height=o);let c=s.getContext(`2d`);if(c.drawImage(e,0,0,a,o),i<=0)return s;try{let s;typeof OffscreenCanvas<`u`?s=new OffscreenCanvas(a,o):(s=document.createElement(`canvas`),s.width=a,s.height=o);let l=s.getContext(`2d`);l.drawImage(e,0,0,a,o),l.save(),l.globalCompositeOperation=`source-in`,l.fillStyle=`rgb(${Math.round(t)}, ${Math.round(n)}, ${Math.round(r)})`,l.fillRect(0,0,a,o),l.restore(),l.save(),l.globalCompositeOperation=`multiply`,l.drawImage(e,0,0,a,o),l.restore(),l.save(),l.globalCompositeOperation=`destination-in`,l.drawImage(e,0,0,a,o),l.restore(),c.save(),c.globalAlpha=i,c.drawImage(s,0,0),c.restore()}catch(s){console.warn(`GPU tint failed: falling back to source-atop method.`,s),c.clearRect(0,0,a,o),c.drawImage(e,0,0,a,o),c.save(),c.globalCompositeOperation=`source-atop`,c.fillStyle=`rgb(${Math.round(t)}, ${Math.round(n)}, ${Math.round(r)})`,c.globalAlpha=Math.max(0,Math.min(1,i)),c.fillRect(0,0,a,o),c.restore()}return s}var lc=new WeakMap;function uc(e,t=.5,{r:n=255,g:r=255,b:i=255,colorCode:a=null}={}){if(!e)return null;if(t<=0)return e;let o=lc.get(e);if(o||(o=new Map,lc.set(e,o)),a!==null){let e=a.replace(`#`,``);e.length===3&&(e=e.split(``).map(e=>e+e).join(``)),/^[0-9A-Fa-f]{6}$/.test(e)?(n=parseInt(e.slice(0,2),16),r=parseInt(e.slice(2,4),16),i=parseInt(e.slice(4,6),16)):console.warn(`Invalid tint color code:`,a)}let s=e=>Math.max(0,Math.min(255,Math.round(e)));n=s(n),r=s(r),i=s(i);let c=Math.round(t*20)/20,l=`${n}|${r}|${i}|${c}`;if(o.has(l))return o.get(l);let u=cc(e,n,r,i,c);return o.set(l,u),u}var dc=[111,68,-3,0,160,90,-3.5,-.004,204,110,-4.6,-.0035,253,136,-5.5,-.004,298,154,-6.5,-.003,353,179,-6.2,-.003,410,205,-5.75,-.003,464,226,-5.45,-.003,519,251,-5.4,-.004,571,271,-5.2,-.003,653,313,-3.9,-.003];function fc(e){return e instanceof Object}function pc(e,t,n){return Math.min(Math.max(e,t),n)}function mc(e){if(!e)return;let t=e.querySelector(`.backgroundContainer`);if(!t)return;let n=e.getBoundingClientRect(),r=Math.max(0,Math.min(n.width,n.height));t.style.width=r+`px`,t.style.height=r+`px`,t.style.left=`50%`,t.style.top=`50%`,t.style.transform=`translate(-50%, -50%)`}var hc=document.getElementById(`canvasContainer`);try{window.ResizeObserver&&new ResizeObserver(()=>mc(hc)).observe(hc)}catch{}window.addEventListener(`resize`,()=>mc(hc)),setTimeout(()=>mc(hc),0),window.activeDebug=()=>{let e=document.createElement(`div`);e.style.position=`fixed`,e.style.minWidth=`50px`,e.style.minHeight=`50px`,e.style.top=`10px`,e.style.right=`10px`,e.style.padding=`5px 10px`,e.style.backgroundColor=`rgba(24, 171, 122, 0.58)`,e.style.color=`#fff`,e.style.fontSize=`12px`,e.style.zIndex=`10000`,e.style.cursor=`move`,e.style.userSelect=`none`;let t=!1,n,r;e.addEventListener(`mousedown`,i=>{t=!0;let a=e.getBoundingClientRect();n=i.clientX-a.left,r=i.clientY-a.top}),window.addEventListener(`mousemove`,i=>{if(!t)return;let a=i.clientX-n,o=i.clientY-r,s=window.innerWidth-e.offsetWidth,c=window.innerHeight-e.offsetHeight;a=Math.max(0,Math.min(a,s)),o=Math.max(0,Math.min(o,c)),e.style.right=`auto`,e.style.left=`${a}px`,e.style.top=`${o}px`}),window.addEventListener(`mouseup`,()=>{t=!1}),document.body.appendChild(e),window.debugInfoEl=e};var gc=class{constructor(){this._buckets={slide:[],tapnhold:[],touch:[]},this._visualBuckets={slide:[],tapnhold:[],touch:[],tags:[]},this._noteQuantity={slide:0,tap:0,hold:0,touch:0,break:0},this._result={buckets:this._buckets,playCombo:0,playScore:0,visualBuckets:this._visualBuckets,noteQuantity:this._noteQuantity,nowIndex:0}}get({renderer:e,globalTime:t,realTime:n,musicDelay:r,playing:i,timeControlSliding:a,readyBeat:o,playedClock:s,settings:c={},visualHeight:l,notes:u=[],decodedTags:d,playScoreRes:f,nowIndex:p,skipAudioQueue:m=!1}){let h=l/c.visualZoom,g=c.effectDecayTime,_=c.hanabiEffectDecayTime,v=c.noteEndBehavior===`through`?Math.max(g,c.noteEndFadeTime??.3):g,y=c.maxSlideCount,b=c.middleDistance,x=u.length;if(x>0&&u[0]&&n<u[0].time&&(p=0),i&&o){let e=240/clockBpm;for(let n=0;n<4;n++){let r=n/4*e-t;r>0?s[n]=!1:s[n]||(ec.queueSoundSingle(`clock`,r),s[n]=!0)}}this._buckets.slide.length=0,this._buckets.tapnhold.length=0,this._buckets.touch.length=0,this._visualBuckets.slide.length=0,this._visualBuckets.tapnhold.length=0,this._visualBuckets.touch.length=0,this._visualBuckets.tags.length=0,this._noteQuantity.slide=0,this._noteQuantity.tap=0,this._noteQuantity.hold=0,this._noteQuantity.touch=0,this._noteQuantity.break=0;let S=this._buckets,C=this._visualBuckets,w=this._noteQuantity,ee=0,te=0,ne=0,T=!1;for(let o=x-1;o>=0;o--){let s=u[o],l=s.time-t,d=s.type,x=(s.holdDuration??0)+(s.slideDuration??0)+(s.slideDelay??0)+(s.isMine?s.cullSkipExtend??0:0),re=e=>e>=1?e*.8833+.8167:e<=-1?e*.8833-.8167:e*1.7,ie=s.hispeed??1,ae=re(c.speed*ie),oe=re(c.touchSpeed*ie);if(!T&&n>=s.time+r&&d!==`slide`&&(p=s.index??p,T=!0),l<0&&(d===`slide`?s.lastSlide&&x+l<0:d===`hold`||d===`touch`&&s.holdDuration!==void 0?x+l<0:d!==`slide`)&&(s.isBreak?w.break++:s.isHold?w.hold++:w[d]++,ee++,te+=(s.isBreak?5:d===`slide`?3:s.holdDuration===void 0?1:2)*f.invScore*100+(s.isBreak?f.breakScore:0)),!m)if(i&&!a){if(d===`touch`&&s.holdDuration>0){let e=l<=0&&-l<s.holdDuration,t=`riser_${s.pos}_${s.time}`;e&&!s._riserActive?(ec.startLongSound(t,`touchHold_riser`,-l),s._riserActive=!0):!e&&s._riserActive&&(ec.stopLongSound(t),s._riserActive=!1)}let e=.1,n=s.time+(s.slideDelay??0);n-t<=e&&!s._startEffectPlayed&&(d===`slide`&&!s.firstSlide||ec.queueSound(s,n),s._startEffectPlayed=!0);let r=s.time+x;r-t<=e&&!s._endEffectPlayed&&((d===`slide`&&s.lastSlide&&s.isBreak||s.isHanabi||s.holdDuration!==void 0&&d!==`tap`&&!c.notPlayHoldEnd)&&ec.queueSound(s,r),s._endEffectPlayed=!0)}else{let e=.1,n=s.time+(s.slideDelay??0),r=s.time+x;n-t>e&&(s._startEffectPlayed=!1),r-t>e&&(s._endEffectPlayed=!1),s.time-t>0&&(s._riserActive&&=(ec.stopLongSound(`riser_${s.pos}_${s.time}`),!1))}let se=1-e.timeFunction(l*Math.abs(ae)),ce=1-e.timeFunction(l*Math.abs(oe)),E=(d===`slide`?se>=b:d===`touch`?ce>=-1:se>=-1)&&-l<=x+(s.isHanabi?_:d===`slide`?0:d===`tap`&&!s.isStar||d===`hold`?v:g),le=l>=0?Math.abs(l)<=h:-l<=h+x;E&&(d===`slide`?ne<y&&(S.slide.push(s),ne++):d===`hold`||d===`tap`?S.tapnhold.push(s):d===`touch`&&S.touch.push(s)),le&&(d===`slide`?C.slide.push(s):d===`hold`||d===`tap`?C.tapnhold.push(s):d===`touch`&&C.touch.push(s))}let re=d.length;for(let e=0;e<re;e++){let n=d[e];C.tags.push(n),Math.abs(n.time-t)}return this._result.playCombo=ee,this._result.playScore=te,this._result.nowIndex=p,this._result}},_c=[],vc=[],P=(...e)=>{_c.push(e.map(yc).join(` `))},yc=e=>{if(typeof e==`string`)return e;try{if(fc(e))return e.errpos===void 0?JSON.stringify(e):(vc.push(e.errpos),`${bc[e.errpos]}, at comma position: ${e.errpos}`)}catch{return String(e)}},bc=[];function xc(e=``,t=!0){_c=[],vc=[];let n=e.replace(/\|\|.*$/gm,``).replace(/\s+/g,``);if(n===``)return{notes:[],endTime:0};let r=n.split(`,`);(n.endsWith(`,`)||n.endsWith(`E`))&&r.pop(),bc=r;let i=[],a=[],o=[],s=null,c=0,l=0,u=60,d=4,f=1,p=null,m=0,h=[],g=0,_=0,v=0,y=0,b=0,x=!1,S=-1,C=-1,w=-1;for(let e of r){if(e.includes(`(`)){let n=Ys(e,`(`,`)`);if(n.error){P(n.error),x=!0;break}if(n.value!==null&&(u=n.value),l==0&&t&&(l=60/u*4),s===null&&u!==null&&(s=u),e=n.residue,a.push({type:`bpm`,value:u,time:l}),S!==-1){let e=a[S];e.nextTime=l}S=a.length-1}if(e.includes(`{`)){p=null;let t=Ys(e,`{`,`}`,!0);if(t.error){P(t.error),x=!0;break}t.value!==null&&t.override?p=t.value:t.value!==null&&(d=t.value),e=t.residue,a.push({type:`split`,value:d,bpm:u,time:l}),C=a.length-1,w=m}C!==-1&&(a[C].renderTimes=m-w+1),p&&(u=240/p);let n,r=e.match(/^<([^>]*)>$/);if(r&&(n=r[1].trim(),e=e.replace(/^<([^>]*)>$/,``),n.startsWith(`HS*`))){let e=parseFloat(n.slice(3));isNaN(e)?P(`Invalid hispeed value in property:`,{errpos:m}):f=e}if(h[m]=l,!e||e===``){m++,l+=p??60/u*(4/d);continue}{let t=[];e.includes("`")?(e.split("`").map(e=>e.trim()).some(e=>e===``)&&P(`Empty note detected in backticks, `,{errpos:m}),t=e.split("`").filter(e=>e.trim()!==``).map((e,t)=>({raw:e,time:l+t*.001}))):t=[{raw:e,time:l}],t.forEach(({raw:e,time:t})=>{let n=[];for(;e.startsWith(`<`);){let t=e.match(/^<([^<>]*)>/);if(!t||t[1].length===1&&!isNaN(t[1]))break;n.push(t[1].trim()),e=e.slice(t[0].length)}for(;e.endsWith(`>`);){let t=e.match(/<([^<>]*)>$/);if(!t)break;n.push(t[1].trim()),e=e.slice(0,-t[0].length)}if(n.length===0&&(n=null),n){let e=n[n.length-1];if(e.startsWith(`HS*`)){let t=parseFloat(e.slice(3));isNaN(t)?P(`Invalid hispeed value in property:`,{errpos:m}):f=t}}let r=e.includes(`/`)?e.split(`/`).map(e=>e.trim()):[e.trim()];if(r.some(e=>e===``)&&P(`Empty note detected in split, `,{errpos:m}),r.length===1&&!isNaN(r[0])&&r[0].length===2){if(r[0].charAt(0)===r[0].charAt(1)){P(`Overlapping note position:`,{errpos:m});return}for(let e=0;e<2;e++){let i=r[0].charAt(e);if(i<1||i>8){P(`Invalid note position:`,{errpos:m});return}let a={pos:i,props:n||null,isDouble:!0,time:t,type:`tap`,hispeed:f,index:m};o.push(a)}g+=2;return}let i=r.filter(e=>e!==``),a=0;i.length>1&&i.forEach((e,t)=>{if(a!==!0&&e.match(/((?:pp)|(?:qq)|[-<>^vpqszVw])/g)&&(a++,a>1)){a=!0;return}}),a=a>1||a===!0,i.forEach(e=>{let r=e,s=e.match(/^\d+/),l=e.match(/^([ABCDE])(\d+)|C/);if(!(s||l)){P(`Invalid note format:`,{errpos:m});return}let d=e.match(/((?:pp)|(?:qq)|[-<>^vpqszVw])/g);if(r=r.replace(/^([ABCDE]\d+|C|\d+)/,``),r=r.replace(/((?:pp)|(?:qq)|[-<>^vpqszVw\*])\d*/g,``),r=r.replace(/\[[^\]]*\]/g,``),r=r.replace(/[bx\$fh@?!m]/g,``),r.length>0){P(`Invalid character(s) "${r}" detected in note "${e}", `,{errpos:m});return}let p=(()=>{let e,r,a=`tap`;if(l){if(l[0]===`C`)r=`C`,e=1;else if(r=l[1],e=parseInt(l[2]),e<1||e>8){P(`Invalid touch position:`,{errpos:m});return}a=`touch`,y++}else{if(e=parseInt(s[0]),e<1||e>8){P(`Invalid note position:`,{errpos:m});return}g++}return{pos:e,props:n||null,touchPos:r||null,isDouble:i.length>1,time:t,type:a,hispeed:f,index:m}})();if(!p)return;if(e.includes(`b`)&&!d){if(l)return P(`Break flag 'b' is not allowed in touch notes, `,{errpos:m});p.isBreak=!0,b++,g--,e=e.replace(/b/g,``)}if(e.includes(`m`)&&!d&&(p.isMine=!0,e=e.replace(/m/g,``)),e.includes(`$`)){if(d&&P(`Slide already have a star! This is unnecessary,`,{errpos:m}),l)return P(`Star flag '$' is not allowed in touch notes, `,{errpos:m});if(e.includes(`h`))return P(`Star flag '$' is not allowed in hold notes, `,{errpos:m});p.isStar=!0,e=e.replace(/\$/g,``)}if(e.includes(`x`)&&(p.isEx=!0,e=e.replace(/x/g,``)),e.includes(`f`))if(!d&&l){if(p.isHanabi=!0,e.replace(/f/,``).includes(`f`)){P(`Multiple Hanabi flags 'f' detected, `,{errpos:m});return}}else{P(`Hanabi flag 'f' is not allowed in other notes!, `,{errpos:m});return}if(e.includes(`h`)){if(d){P(`Hold flag 'h' is not allowed in slide notes, `,{errpos:m});return}p.isHold=!0,p.type!==`touch`&&(p.type=`hold`);let t=e.match(/\[([^\[\]]*)\]/),n=e.replace(/\[([^\[\]]*)\]/,``).replace(/h/,``);if(n.includes(`h`)||n.includes(`[`)||n.includes(`]`)||!(n.match(/^\d$/)||l)){P(`Invalid format in hold note, `,{errpos:m});return}if(p.holdDuration=1e-4,t){let{time:e,_:n}=Xs(t[1].trim(),u);if(e<0||isNaN(e)||e===1/0){P(`Invalid hold syntax in note, `,{errpos:m});return}p.holdDuration=e,e+p.time>c&&(c=e+p.time)}p.isBreak||(_++,p.type===`touch`?y--:g--)}if(e.includes(`@`)&&!d)return P(`Star flag '@' is not allowed in other notes, `,{errpos:m});if(e.includes(`!`)&&!d)return P(`Star flag '!' is not allowed in other notes, `,{errpos:m});if(e.includes(`?`)&&!d)return P(`Star flag '?' is not allowed in other notes, `,{errpos:m});let h=!1,x=!1;if(d&&!e.includes(`h`)){let t=!1,r=(()=>{if(e.includes(`*`)){let t=e.split(`*`).map(e=>e.trim());for(let e=1;e<t.length;e++)t[e]=p.pos+t[e];return t}return[e]})();r.length>1&&(t=!0,p.isMultiple=!0);for(let e=0;e<r.length;e++){let i=r[e].match(/((?:pp)|(?:qq)|[-<>^vpqszVw])/g);if(!i)return P(`Missing slide type in slide note, `,{errpos:m});let s=r[e].match(/\[([^\[\]]*)\]/g);if(!s)return P(`Missing time format:`,{errpos:m});let l=s.map(e=>e.slice(1,-1)),d=r[e].replace(/\[([^\[\]]*)\]/g,``);if(d.includes(`[`)||d.includes(`]`)){P(`Invalid time format or empty in slide note, `,{errpos:m});return}p.isStar=!0;let _=d.split(/((?:pp)|(?:qq)|[-<>^vpqszVw])/g).filter((e,t)=>t%2==0);if(_[0].includes(`b`)&&(p.isBreak=!0,_[0]=_[0].replace(/b/g,``),b++,g--),_[0].includes(`m`)&&(p.isMine=!0,_[0]=_[0].replace(/m/g,``)),_[0].includes(`@`)&&(p.isStar=!1,_[0]=_[0].replace(/@/g,``)),_[0].includes(`?`)){if(!p.isStar)return P(`Star flag '@' at here is not allowed, `,{errpos:m});h=!0,_[0]=_[0].replace(/\?/g,``),g--}if(_[0].includes(`!`)){if(!p.isStar)return P(`Star flag '@' at here is not allowed, `,{errpos:m});h&&P(`Using '!' and '?' at the same time is contradictory, `,{errpos:m}),x=!0,_[0]=_[0].replace(/!/g,``)}let y=_.some(e=>e.includes(`b`)),S=_.some(e=>e.includes(`m`));y&&_.forEach((e,t)=>{e.startsWith(`b`)&&P(`Not recommand write break flag like this since it may cause confusion, please put break flag at the end of the slide part!! :`,{errpos:m}),_[t]=_[t].replace(/b/g,``)}),S&&_.forEach((e,t)=>{e.startsWith(`m`)&&P(`Not recommand write mine flag like this since it may cause confusion, please put mine flag at the end of the slide part!! :`,{errpos:m}),_[t]=_[t].replace(/m/g,``)});let C=0,w=0;{let e=!1;if(l.forEach((t,n)=>{let{time:r,delay:i}=Xs(t,u,!0);if(r<0||isNaN(r)){P(`Invalid time format in slide note, `,{errpos:m}),e=!0;return}n===0&&(w=i),C+=r}),e)return}let ee=i.map((e,t)=>{let n=t===0?p.pos:parseInt(_[t].slice(-1)),r=_[t+1],i=parseInt(r.slice(-1)),a=r.length>1?parseInt(r.slice(-2,-1)):void 0;if([n,i].some(e=>isNaN(e)||e<1||e>8)||e===`V`&&a===void 0||a!==void 0&&(isNaN(a)||a<1||a>8))return null;let o=Sc(n,i,e,a),s=o.path;return o.illegal&&P(`Illegal slide ${n}${e}${a??``}${i}, `,{errpos:m}),{head:n,end:i,mid:a,type:e,path:s,len:s.totalLength,illegal:o.illegal,additional:o.additional}});if(ee.includes(null)||ee.some(e=>e.mid&&e.type!==`V`||e.type===`V`&&!e.mid))return P(`Invalid slide positions:`,{errpos:m});let te=ee.reduce((e,t)=>e+t.len,0),ne=w,T=0;ee.forEach((e,r)=>{let i=te>0?C*(e.len/te):C/ee.length;r===0&&(p.slideDuration=i),T+=i,o.push({type:`slide`,props:n,pos:e.head,firstSlide:r===0,lastSlide:r===ee.length-1,hideHead:x?!0:r!==0,isDouble:t||a,isBreak:y,isMine:S,slideEnd:e.end,slideMid:e.mid,slideType:e.type,path:e.path,wPaths:e.additional,time:p.time,slideDelay:ne,slideDuration:i,isIllegal:e.illegal,hispeed:f,cullSkipExtend:C-T}),r===ee.length-1&&(y?b++:v++),p.time+ne+i>c&&(c=p.time+ne+i),ne+=i})}}h||x||o.push(p)})})}m++,l+=p??60/u*(4/d)}h[m]=l,l>c&&(c=l);for(let e of o)i.push({...e,isBreak:e.isBreak||!1,isHold:e.isHold||!1,isMine:e.isMine||!1,isEx:e.isEx||!1});return _c.length>0&&console.warn(`Decoding finished with warnings:`,_c),console.group(`Decoded Notes:`),console.log(`notes: `,i),console.log(`endTime: `,c),console.log(`tap: ${g},
hold: ${_},
slide: ${v},
touch: ${y},
break: ${b}`),console.log(vc),console.groupEnd(),{notes:i,endTime:c,tags:a,bpm:s,baseOffset:t,notesConts:{tap:g,hold:_,slide:v,touch:y,break:b},score:g+y+_*2+v*3+b*5||0,failed:x,warnings:_c,errpositions:vc,indexToTime:h}}function Sc(e,t,n,r=null){let i=new Zs,a=$s[e-1],o=$s[t-1],s=!1,c=(t-e+8)%8,l=e===t,u={};switch(n){case`-`:(c===1||c===7||l)&&(s=!0),i.moveTo(a.x,a.y),i.lineTo(o.x,o.y);break;case`^`:if((c===4||l)&&(s=!0),l){i.moveTo(a.x,a.y);break}i.arc(0,0,N,a.rot-Math.PI/2,o.rot-Math.PI/2,(t-e+8)%8>4);break;case`>`:i.arc(0,0,N,a.rot-Math.PI/2,o.rot-Math.PI/2,e>=3&&e<=6);break;case`<`:i.arc(0,0,N,a.rot-Math.PI/2,o.rot-Math.PI/2,!(e>=3&&e<=6));break;case`v`:(c===4||l)&&(s=!0),i.moveTo(a.x,a.y),i.lineTo(0,0),i.lineTo(o.x,o.y);break;case`V`:{let n=(e-r+8)%8,c=(r-t+8)%8;(n!==2&&n!==6||l||r===t||e===r||r===e||n===2&&!(c>=2&&c<=5)||n===6&&!(c>=3&&c<=6))&&(s=!0);let u=$s[r-1];i.moveTo(a.x,a.y),i.lineTo(u.x,u.y),i.lineToArc(0,0,N*.974,u.rot-Math.PI*.5),i.lineTo(u.x,u.y),i.lineTo(o.x,o.y);break}case`q`:{let n=N*.38,r=N*.42,s=a.rot-Math.PI*.12,c=o.rot+Math.PI*1.09,l=o.rot+Math.PI*1.265;i.moveTo(a.x,a.y),i.lineToArc(0,0,n,s),i.arc(0,0,n*1.001,s,c,e<t&&(t-e+8)%8>=4),i.lineToArc(0,0,r,l),i.lineTo(o.x,o.y);break}case`p`:{let n=N*.38,r=N*.42,s=a.rot+Math.PI*1.09,c=o.rot-Math.PI*.12,l=o.rot-Math.PI*.26;i.moveTo(a.x,a.y),i.lineToArc(0,0,n,s),i.arc(0,0,n*1.001,s,c,!(t<e&&(t-e+8)%8<=4)),i.lineToArc(0,0,r,l),i.lineTo(o.x,o.y);break}case`pp`:{let n={x:Math.cos((e-.971)*Math.PI/4)*N*.456,y:Math.sin((e-.971)*Math.PI/4)*N*.456};i.moveTo(a.x,a.y),i.lineToArc(n.x,n.y,N*.472,a.rot-Math.PI),i.arc(n.x,n.y,N*.466,a.rot-Math.PI,o.rot+Math.PI*((c==0)*-.3+(c==1)*-.35+(c==2)*-.2+(c==4)*.02+(c==6)*-.15+(c==7)*-.2),!0,t>e&&(t-e+8)%8>=3||e>t&&(t-e+8)%8==3),i.lineTo(o.x,o.y);break}case`qq`:{let n=(e-t+8)%8,r={x:Math.cos((e-4.028)*Math.PI/4)*N*.456,y:Math.sin((e-4.028)*Math.PI/4)*N*.456};i.moveTo(a.x,a.y),i.lineToArc(r.x,r.y,N*.472,a.rot),i.arc(r.x,r.y,N*.466,a.rot,o.rot+Math.PI*(-1+(n==0)*.3+(n==1)*.35+(n==2)*.2+(n==4)*-.02+(n==6)*.15+(n==7)*.2),!1,e>t&&(e-t+8)%8>=3||t>e&&(e-t+8)%8==3),i.lineTo(o.x,o.y);break}case`s`:(c!==4||l)&&(s=!0),i.moveTo(a.x,a.y),i.lineToArc(0,0,N*.414,a.rot-Math.PI*1),i.lineToArc(0,0,N*.414,a.rot-Math.PI*2),i.lineTo(o.x,o.y);break;case`z`:(c!==4||l)&&(s=!0),i.moveTo(a.x,a.y),i.lineToArc(0,0,N*.414,a.rot-Math.PI*2),i.lineToArc(0,0,N*.414,a.rot-Math.PI*1),i.lineTo(o.x,o.y);break;case`w`:{(c!==4||l)&&(s=!0),i.moveTo(a.x,a.y),i.lineTo(o.x,o.y);let e=$s[(t-2+8)%8],n=$s[t%8];u.w1=new Zs,u.w2=new Zs,u.w1.moveTo(a.x,a.y),u.w1.lineTo(e.x,e.y),u.w2.moveTo(a.x,a.y),u.w2.lineTo(n.x,n.y);break}default:l&&(s=!0),i.moveTo(a.x,a.y),i.lineTo(o.x,o.y),P(`Not implemented slide type, defaulting to straight line:`,n),s=!0;break}return{path:i,additional:u,illegal:s}}function Cc(e){return e.replace(/\|\|.*$/gm,``).replace(/\s+/g,``).split(`,`)}function wc(e,t,n,r){let i=Cc(e),a=0,o=i.length-1;for(let e=0;e<i.length;e++){let s=t[e]??0;(t[e+1]??s)<=n&&(a=Math.min(e+1,i.length-1)),s<r&&(o=e)}return i.slice(a,o+1).join(`,`)}function Tc(e){let t=(e??``).replace(/\|\|.*$/gm,``).replace(/\s+/g,``),n=!1,r=!1,i;for(;(i=t.match(/^\([^()]*\)/))||(i=t.match(/^\{[^{}]*\}/));)i[0][0]===`(`?n=!0:r=!0,t=t.slice(i[0].length);return{hasBpm:n,hasSplit:r}}function Ec(e,t,n,r){let i=wc(e,t.indexToTime??[],n,r),a=e=>{let r=null;for(let i of t.tags??[])i.type===e&&i.time<=n+1e-6&&(r=i.value);return r},{hasBpm:o,hasSplit:s}=Tc(i),c=``;if(!o){let e=a(`bpm`)??t.bpm;e&&(c+=`(${e})`)}if(!s){let e=a(`split`);e&&(c+=`{${e}}`)}return c+i}function Dc(e){let t=e.bpm||60,n=e.tags.find(e=>e.type===`bpm`)?.value||t,r=240/n,i=e.endTime||0,a=[],o=r;for(let e=o;e<=i+r;e+=r)a.push(e);a.length===0&&a.push(o);let s=Array.from({length:a.length},()=>({tap:0,hold:0,slide:0,touch:0,brk:0}));for(let t of e.notes){let e=0;for(let n=0;n<a.length&&t.time>=a[n];n++)e=n;t.isBreak?s[e].brk++:t.type===`tap`?s[e].tap++:t.type===`hold`?s[e].hold++:t.type===`slide`?s[e].slide++:t.type===`touch`&&s[e].touch++}return{meta:{bpm:n,total:e.notes.length,counts:e.notesConts||{tap:e.notes.filter(e=>e.type===`tap`&&!e.isBreak).length,hold:e.notes.filter(e=>e.type===`hold`&&!e.isBreak).length,slide:e.notes.filter(e=>e.type===`slide`&&!e.isBreak).length,touch:e.notes.filter(e=>e.type===`touch`&&!e.isBreak).length,break:e.notes.filter(e=>e.isBreak).length},endTime:i},measures:a,density:s,notes:e.notes,tags:e.tags,indexToTime:e.indexToTime||[]}}function Oc(){let e=A(``),t=A(``),n=Qt(null),r=Qt([]),i=Qt([]),a=Qt([]),o=Qt([]),s=Qt([]);function c(c,l){e.value=c,t.value=l??``;let u=xc(c,!0);if(u.failed)throw Error(`譜面解析失敗：請檢查語法`);let d=Dc(u);return n.value=d,r.value=d.measures,i.value=d.notes,a.value=d.density,o.value=d.indexToTime,s.value=Cc(c),d}async function l(e){let t=await fetch(e);if(!t.ok)throw Error(`譜面獲取失敗：${t.status}`);let n=await t.json(),r=n&&n.ok!==void 0?n.data||{}:n;return c(r.text,r.name)}function u(e,t){return c(e,t)}function d(c){e.value=c.chartText.value,t.value=c.chartName.value,n.value=c.DATA.value,r.value=c.M.value,i.value=c.N.value,a.value=c.D.value,o.value=c.C.value,s.value=c.commaParts.value}return{chartText:e,chartName:t,DATA:n,M:r,N:i,D:a,C:o,commaParts:s,loadChart:l,loadFromText:u,adoptFrom:d}}var kc={};function Ac(e,t,n,r,i,a=`stroke`){e.textAlign=`left`;let o=e.font;kc[o]||(kc[o]={});let s=kc[o];for(let o=0;o<t.length;o++){let c=t[o],l=s[c];l===void 0&&(l=e.measureText(c).width,s[c]=l);let u=(i-l)/2;a===`stroke`?e.strokeText(c,n+o*i+u,r):e.fillText(c,n+o*i+u,r)}}function jc(e,t,n,r,i,a=2,{fillStyle:o=`#FFFFFF`,strokeStyle:s=`#000000`,strokeWidth:c=a,fontWeight:l=`bold`,fontFamily:u=`combo`,textAlign:d=`center`,textBaseline:f=`middle`,letterSpacing:p=`0px`,shadowHeight:m=.3,cellWidth:h=i*.8}={}){h+=p?i*parseFloat(p):0,h=Math.max(h,0);let g=n;d===`center`&&(g=n-t.length*h/2),d===`right`&&(g=n-t.length*h),e.save(),e.font=`${l} ${i}px ${u}`,e.textBaseline=f,e.fillStyle=o,e.lineWidth=c,c>0&&(e.strokeStyle=`#000`,Ac(e,t,g,r+m,h),e.strokeStyle=s,Ac(e,t,g,r,h)),Ac(e,t,g,r,h,`fill`),e.restore()}var Mc=class{constructor(e,t){this.canvas=e,this.ctx=e.getContext(`2d`),this.settings=t,this.images=null,this.globalTime=0,this.scale=.98,this._tintCache=new Map,this.exColor=qs,this._sensorShapeCache=null,this._sensorTextCache=null,this._sensorCacheParams={w:0,h:0,scale:this.scale},this._staticBackgroundCache=null,this._staticBackgroundCacheParams={w:0,h:0,scale:this.scale},this._middleDisplayCache=null,this._middleDisplayCacheParams={w:0,h:0,scale:this.scale,middleDisplay:null,play_combo:null,play_score:null,backgroundDarkness:null},this._zoneCounts={},this.drawnBorders=new Set,this.hanabiEffect={},this._tempColorConfig={colorCode:``},this._auxTextList=Array(12),this._middleDisplayConfig1={fillStyle:`#ff4fa5`,strokeStyle:`#A6ABAE`},this._middleDisplayConfig2={fillStyle:`#ff4fa5`,strokeStyle:`#A6ABAE`,letterSpacing:-.1},this._middleDisplayConfigScore={fillStyle:`#4061A8`,strokeStyle:`#A6ABAE`,letterSpacing:-.1,textAlign:`right`},this._middleDisplayConfigDot={fillStyle:`#4061A8`,strokeStyle:`#A6ABAE`,letterSpacing:-.12,textAlign:`left`},this._middleDisplayConfigFrac={fillStyle:`#4061A8`,strokeStyle:`#A6ABAE`,letterSpacing:-.12,textAlign:`left`},this._middleDisplayConfigPercent={fillStyle:`#4061A8`,strokeStyle:`#A6ABAE`,letterSpacing:-.12,textAlign:`left`}}getCanvasWH(){let e=this.canvas.width,t=this.canvas.height,n=100/(Math.min(e,t)*this.scale);return this._canvasWH||={width:0,height:0,halfWidth:0,halfHeight:0},this._canvasWH.width=e*n,this._canvasWH.height=t*n,this._canvasWH.halfWidth=e*n*.5,this._canvasWH.halfHeight=t*n*.5,this._canvasWH}updateCanvasMetrics(){let{width:e,height:t}=this.canvas;this._p=Math.min(e,t)/100*this.scale,this._invP=100/(Math.min(e,t)*this.scale),this._hw=e*this._invP*.5,this._hh=t*this._invP*.5}setImages(e){this.images=e}getMemoizedTintedImage(e,t,n){if(!this.images[e])return null;let r=`${e}_${t.toFixed(2)}_${n.colorCode}`;if(this._tintCache.has(r))return this._tintCache.get(r);let i=uc(this.images[e],t,n);return this._tintCache.size>200&&this._tintCache.clear(),this._tintCache.set(r,i),i}setContext(e){this.canvas=e.canvas,this.ctx=e}drawImgAtcenter(e,t,n=0,r=0,i=1,a=1){return Js(this.ctx,e,t,n,r,i,a)}timeFunction(e){return .02160482279616*e*e*e-.07553691072*e*e+.43509924*e+250029e-9}touchTimeFunction(e){return e>10.24938?1.62102:753454e-9*e*e*e-.0298793*e*e+.375038*e+.104685}simpleHitEffect(e){let t=e/this.settings.effectDecayTime;if(t<-1)return;this.ctx.save();let n=1-Math.max(0,-t),r=.8*this.settings.noteBaseSize*(1-n);this.ctx.strokeStyle=`rgba(255, 200, 0, ${.8*n})`,this.ctx.lineWidth=.5*this.settings.noteBaseSize*n,this.ctx.globalCompositeOperation=`lighter`,this.ctx.beginPath(),this.ctx.arc(0,0,r,0,Math.PI*2),this.ctx.stroke(),this.ctx.restore()}simpleHanabi(e,t){let n=e/this.settings.hanabiEffectDecayTime;if(n<-1)return;this.ctx.save();let r=e=>1-(1-e)**2,i=1-Math.max(0,-n),a=(3+t*1)*this.settings.noteBaseSize*r(1-i),o=this.ctx.createLinearGradient(-a,-a,a,a);o.addColorStop(0,`#00D5FF`),o.addColorStop(.4,`#FF00FF`),o.addColorStop(.8,`#FFD823`),o.addColorStop(1,`#FFD823`);let s=this.ctx.createRadialGradient(0,0,0,0,0,a*1.3);s.addColorStop(0,`#ffffff00`),s.addColorStop(.4,`#ffffff00`),s.addColorStop(.8,`#ffffff8b`),s.addColorStop(1,`#ffffff00`),this.ctx.globalAlpha=i,this.ctx.globalCompositeOperation=`lighter`,this.ctx.fillStyle=s,this.ctx.globalAlpha=i*.8,this.ctx.beginPath(),this.ctx.arc(0,0,a*1.3,0,Math.PI*2),this.ctx.fill(),this.ctx.beginPath(),this.ctx.lineWidth=1.4*i*this.settings.noteBaseSize*(1-r(Math.max(0,-n))),this.ctx.strokeStyle=o,this.ctx.arc(0,0,a,0,Math.PI*2),this.ctx.stroke(),this.ctx.fillStyle=o,this.ctx.globalAlpha=i*.5,this.ctx.fill(),this.ctx.restore()}simpleHoldEffect(e){this.ctx.save();let t=e*-2,n=1-Math.max(0,t%1),r=1-Math.max(0,(t+.5)%1),i=.6*this.settings.noteBaseSize*(1-n),a=.6*this.settings.noteBaseSize*(1-r);this.ctx.strokeStyle=`rgba(255, 200, 0, ${.6*n})`,this.ctx.lineWidth=.5*this.settings.noteBaseSize*n,this.ctx.globalCompositeOperation=`lighter`,this.ctx.beginPath(),this.ctx.arc(0,0,i,0,Math.PI*2),this.ctx.stroke(),this.ctx.strokeStyle=`rgba(255, 200, 0, ${.6*r})`,this.ctx.lineWidth=.5*this.settings.noteBaseSize*r,this.ctx.beginPath(),this.ctx.arc(0,0,a,0,Math.PI*2),this.ctx.stroke(),this.ctx.restore()}get isPassThrough(){return this.settings.noteEndBehavior===`through`}passThroughAlpha(e){let t=this.settings.noteEndFadeTime??.3;return t<=0?0:pc(1+e/t,0,1)}getNoteTransform(e,t=1){let n=e*(e=>e>=1?e*.8833+.8167:e<=-1?e*.8833-.8167:e*1.7)(this.settings.speed*t),r=1-this.timeFunction(n),i=Math.max(this.settings.middleDistance,r),a=r<this.settings.middleDistance?Math.max(0,(r+.9)/(.9+this.settings.middleDistance)):1;return this._tempTransform||={t:0,displayT:0,currentScale:0},this._tempTransform.t=r,this._tempTransform.displayT=i,this._tempTransform.currentScale=a,this._tempTransform}drawFrame(e){let{ctx:t}=this,{globalTime:n,buckets:r,dt:i,showSensor:a,showSensorText:o,playCombo:s,playScore:c,noteQuantity:l={tap:0,hold:0,slide:0,touch:0,break:0},playScoreRes:u={tap:0,hold:0,slide:0,touch:0,break:0,score:0,breakScore:0,invScore:0},nowIndex:d}=e;if(this.globalTime=n,this.playCombo=s,this.playScore=c,!this.images)return;this.currentTouchNotes=r.touch||[];for(let e in this._zoneCounts)this._zoneCounts[e]=0;for(let e=0;e<this.currentTouchNotes.length;e++){let t=this.currentTouchNotes[e],n=t.time-this.globalTime;if(t.holdDuration?-n<=t.holdDuration:n>0){let e=t.touchPos+t.pos;this._zoneCounts[e]=(this._zoneCounts[e]||0)+1}}this.drawnBorders.clear();for(let e in this.hanabiEffect)this.hanabiEffect[e].cleared=!0,this.hanabiEffect[e].time=-99999;this.updateCanvasMetrics();let{_hw:f,_hh:p,canvas:{width:m,height:h}}=this;e.skipClear||t.clearRect(-f,-p,m,h),(a||o)&&this.drawSensors(a,o),this.drawMiddleDisplay();for(let e of r.touch)this.getTouchHanabi(e);this.drawHanabiEffects();for(let e of r.slide)this.drawSlide(e);for(let e of r.tapnhold)e.type===`hold`?this.drawHold(e):e.isStar?this.drawStar(e):this.drawTap(e);for(let e of r.touch)this.drawTouch(e);this.drawStaticBackground(),this.settings.renderSurroundingAuxiliaryText&&this.drawAuxiliaryText(i,n,l,u,s,c),this.settings.showUI&&this.drawUI(i,n)}drawUI(e,t){let{ctx:n}=this,{width:r,height:i}=this.getCanvasWH(),a=`FPS: ${e===0?`PAUSE`:(1/e).toFixed(2)}`,o=`Time: ${t<0?`-`+Math.abs(Math.ceil(t/60)):Math.floor(t/60)}:${Math.abs(t%60).toFixed(2).padStart(5,`0`)}`;n.save(),n.font=`3px Google Sans`,n.fillStyle=`rgba(255, 255, 255, 0.8)`,n.textAlign=`left`,n.textBaseline=`top`,n.fillText(a,-r/2+2,-i/2+2),n.fillText(o,-r/2+2,-i/2+2+4),n.restore()}drawAuxiliaryText(e,t,n,r,i,a){let{width:o,height:s}=this.getCanvasWH();if(s>=o)return;let{ctx:c}=this,l=r.tap+r.hold+r.slide+r.touch+r.break;c.save(),c.fillStyle=`white`,c.textAlign=`right`,c.textBaseline=`bottom`,c.font=`9px mono`,c.letterSpacing=`-1px`,c.fillText(`${t<0?`-`+Math.abs(Math.ceil(t/60)):Math.floor(t/60)}:${Math.abs(t%60).toFixed(2).padStart(5,`0`)}`,100/-2-5,-1),c.letterSpacing=`0px`,c.font=`4px Google Sans`,c.fillText(`Powered by`,100/-2-3,s/2-5),c.font=`2.5px Google Sans`,c.fillText(`susuy0725/web-mai-chart-x`,100/-2-3,s/2-2),c.textAlign=`left`,this._auxTextList[0]=`${i}/${l}`,this._auxTextList[1]=`ALL:`,this._auxTextList[2]=`${n.break}/${r.break}`,this._auxTextList[3]=`BRK:`,this._auxTextList[4]=`${n.touch}/${r.touch}`,this._auxTextList[5]=`TOH:`,this._auxTextList[6]=`${n.slide}/${r.slide}`,this._auxTextList[7]=`SLD:`,this._auxTextList[8]=`${n.hold}/${r.hold}`,this._auxTextList[9]=`HOD:`,this._auxTextList[10]=`${n.tap}/${r.tap}`,this._auxTextList[11]=`TAP:`;let u=(this._auxTextList.length*6-Math.floor(this._auxTextList.length/2))/2+6;for(let e=0;e<this._auxTextList.length;e++){let t=this._auxTextList[e];c.font=`${e%2==0?`4`:`bold 5`}px mono`,c.fillText(t,53,u-e*6-(e%2==0))}c.textBaseline=`top`,c.textAlign=`right`,c.font=`bold 5px mono`,c.fillText(`DELUXE Rate:`,100/-2-3,1),c.font=`7px mono`,c.fillText(a.toFixed(4)+`%`,100/-2-3,8),c.restore()}ensureStaticBackgroundCache(){let e=this.canvas.width,t=this.canvas.height,n=this.scale;if(!e||!t)return;let r=this._staticBackgroundCacheParams;if(this._staticBackgroundCache&&r.w===e&&r.h===t&&r.scale===n)return;let i=document.createElement(`canvas`);i.width=e,i.height=t;let a=i.getContext(`2d`),o=Math.min(e,t)/100*n;a.setTransform(o,0,0,o,e/2,t/2),a.save(),a.beginPath(),a.rect(-e,-t,e*2,t*2),a.arc(0,0,100/2,0,Math.PI*2),a.fill(`evenodd`),a.restore(),this._staticBackgroundCache=i,this._staticBackgroundCacheParams={w:e,h:t,scale:n}}drawStaticBackground(){if(this.ensureStaticBackgroundCache(),!this._staticBackgroundCache)return;let{ctx:e}=this;e.save(),e.setTransform(1,0,0,1,0,0),e.drawImage(this._staticBackgroundCache,0,0),e.restore()}drawMiddleDisplay(){this.renderMiddleDisplayToContext(this.ctx)}renderMiddleDisplayToContext(e){switch(e.save(),this.settings.middleDisplay){case 1:this.playCombo!=0&&(jc(e,`COMBO`,0,-7,4.4,.5,this._middleDisplayConfig1),jc(e,`${this.playCombo}`,0,0,7.4,.5,this._middleDisplayConfig2));break;case 2:let t=Math.max(this.playScore,0).toFixed(4),n=t.indexOf(`.`),r=n===-1?t:t.substring(0,n),i=n===-1?``:t.substring(n+1),a=`#4061A8`;t>80&&(a=`#9E3D2E`),t>100&&(a=`#99853A`),this._middleDisplayConfigScore.fillStyle=a,this._middleDisplayConfigDot.fillStyle=a,this._middleDisplayConfigFrac.fillStyle=a,this._middleDisplayConfigPercent.fillStyle=a,jc(e,r,-1.8,0,7.4,.5,this._middleDisplayConfigScore),jc(e,`.`,-2.3,.6,5,.5,this._middleDisplayConfigDot),jc(e,i,0,.5,5,.5,this._middleDisplayConfigFrac),jc(e,`%`,14.4,1.2,3,.5,this._middleDisplayConfigPercent);break;default:break}e.restore()}ensureSensorCaches(){let e=this.canvas.width,t=this.canvas.height,n=this.scale;if(!e||!t)return;let r=Math.min(e,t)/100*n,i=this._sensorCacheParams||{};if(!(this._sensorShapeCache&&i.w===e&&i.h===t&&i.scale===n))try{let i=document.createElement(`canvas`);i.width=e,i.height=t;let a=i.getContext(`2d`);a.setTransform(r,0,0,r,e/2,t/2),a.save(),a.beginPath(),a.arc(0,0,N,0,Math.PI*2),a.closePath(),a.clip(),a.fillStyle=`#80808025`,a.strokeStyle=`#ffffff80`,nc.forEach(e=>{e.type===`D`||e.type===`C1`||e.type===`C2`||(a.lineWidth=.3,e.type===`A`?(a.lineWidth=.3,a.setLineDash([.2,.6]),a.stroke(e.path)):(a.setLineDash([]),a.fill(e.path),a.stroke(e.path)))}),a.restore();let o=document.createElement(`canvas`);o.width=e,o.height=t;let s=o.getContext(`2d`);s.setTransform(r,0,0,r,e/2,t/2),s.save(),s.fillStyle=`#ffffff30`,s.textAlign=`center`,s.textBaseline=`middle`,[`A`,`B`,`D`,`E`].forEach(e=>{let t=Qs[e];e===`A`?s.font=`bold 5px combo`:s.font=`4px combo`;for(let n=0;n<t.length;n++){let r=t[n];s.fillText(`${e}${n+1}`,r.x,r.y)}}),s.fillText(`C`,0,0),s.restore(),this._sensorShapeCache=i,this._sensorTextCache=o,this._sensorCacheParams={w:e,h:t,scale:n}}catch(e){console.error(`建立傳感器靜態快取失敗:`,e),this._sensorShapeCache=null,this._sensorTextCache=null,this._sensorCacheParams={w:0,h:0,scale:n}}}drawSensors(e,t){if(this.ensureSensorCaches(),!this._sensorShapeCache&&!this._sensorTextCache)return;let{ctx:n}=this;n.save(),n.setTransform(1,0,0,1,0,0);try{e&&this._sensorShapeCache&&n.drawImage(this._sensorShapeCache,0,0),t&&this._sensorTextCache&&n.drawImage(this._sensorTextCache,0,0)}finally{n.restore()}}drawTap(e){let{time:t,pos:n,isBreak:r,isDouble:i,isMine:a,hispeed:o}=e,s=t-this.globalTime,{t:c,displayT:l,currentScale:u}=this.getNoteTransform(s,o),d=$s[n-1],f=this.ctx,p=1;if(s<=0){if(!this.isPassThrough){f.save(),f.translate(d.x,d.y),this.simpleHitEffect(s),f.restore();return}if(p=this.passThroughAlpha(s),p<=0)return}let m=r&&!a?Math.sin(this.globalTime*-6)**2*.5:0,h=a?`tap_mine`:r?`tap_break`:i?`tap_each`:`tap`,g;r?(this._tempColorConfig.colorCode=`#fff8a6`,g=this.getMemoizedTintedImage(h,m,this._tempColorConfig)):g=this.images[h];let _=this.settings.noteBaseSize*u;f.save(),f.globalAlpha=p;let v=this.images[a?`MineArc`:r?`BreakArc`:i?`EachArc`:`NormalArc`];if(f.save(),f.rotate(d.rot),f.globalAlpha=u*p,this.drawImgAtcenter(v,l*N*2.25),f.restore(),f.translate(d.x*l,d.y*l),f.rotate(d.rot),this.drawImgAtcenter(g,_),e.isEx){this._tempColorConfig.colorCode=this.exColor[r?`break`:i?`double`:`tap`];let e=this.getMemoizedTintedImage(`tap_ex`,.6,this._tempColorConfig);this.drawImgAtcenter(e,_)}f.restore()}drawStar(e){let{time:t,pos:n,isBreak:r,isDouble:i,isMultiple:a,isMine:o,hispeed:s}=e,c=t-this.globalTime,{t:l,displayT:u,currentScale:d}=this.getNoteTransform(c,s),f=$s[n-1],p=this.ctx;if(c<=0){p.save(),p.translate(f.x,f.y),this.simpleHitEffect(c),p.restore();return}let m=r&&!o?Math.sin(this.globalTime*-6)**2*.5:0,h=a?o?`star_mine_double`:r?`star_break_double`:i?`star_each_double`:this.settings.pinkStars?`star_pink_double`:`star_double`:o?`star_mine`:r?`star_break`:i?`star_each`:this.settings.pinkStars?`star_pink`:`star`,g;r?(this._tempColorConfig.colorCode=`#fff8a6`,g=this.getMemoizedTintedImage(h,m,this._tempColorConfig)):g=this.images[h];let _=this.settings.noteBaseSize*d;p.save();let v=this.images[o?`MineArc`:r?`BreakArc`:i?`EachArc`:`SlideArc`];p.save(),p.rotate(f.rot),p.globalAlpha=d,this.drawImgAtcenter(v,u*N*2.25),p.restore(),p.translate(f.x*u,f.y*u);let y=f.rot;if(this.settings.rotateStars){let t=0;e.slideDuration&&e.slideDuration>0&&(t=pc(1.5/e.slideDuration,.5,6)),y+=this.globalTime*2*Math.PI*t}if(p.rotate(y),this.drawImgAtcenter(g,_),e.isEx){this._tempColorConfig.colorCode=this.exColor[r?`break`:i?`double`:`star`];let e=this.getMemoizedTintedImage(a?`star_ex_double`:`star_ex`,.6,this._tempColorConfig);this.drawImgAtcenter(e,_)}p.restore()}drawHold(e){let{time:t,pos:n,isBreak:r,isDouble:i,isMine:a,holdDuration:o,hispeed:s}=e,c=t-this.globalTime,l=1-this.timeFunction(c*(this.settings.speed*.8833+.8167)*s),u=$s[n-1],d=o+c;if(d<0&&!this.isPassThrough)this.ctx.save(),this.ctx.translate(u.x,u.y),this.simpleHitEffect(d),this.ctx.restore();else{let n=1;if(d<0&&(n=this.passThroughAlpha(d),n<=0))return;let s=!this.isPassThrough&&t-this.globalTime<=-.1&&!a,f=e.isBreak&&!a?Math.sin(this.globalTime*-6)**2*.5:0,p=s?a?`hold_mine`:r?`hold_break_on`:i?`hold_each_on`:`hold_on`:a?`hold_mine`:r?`hold_break`:i?`hold_each`:`hold`,m;r?(this._tempColorConfig.colorCode=`#fff8a6`,m=this.getMemoizedTintedImage(p,f,this._tempColorConfig)):m=this.images[p];let h=this.settings.speed*.8833+.8167,g=1-this.timeFunction((t-this.globalTime+o)*h),_=this.isPassThrough?Math.max(this.settings.middleDistance,l):Math.min(1,Math.max(this.settings.middleDistance,l)),v=l<this.settings.middleDistance?Math.max(0,(l+.9)/(.9+this.settings.middleDistance)):1,y=this.settings.noteBaseSize*v,b=l<this.settings.middleDistance?0:this.isPassThrough?Math.max(0,(l-Math.max(this.settings.middleDistance,g))*2.45):Math.min(d*.9*h,Math.min((1-this.settings.middleDistance)*2.45,Math.min((l-this.settings.middleDistance)*2.45,o*.9*h)));this.ctx.save();let x=this.images[a?`MineArc`:r?`BreakArc`:i?`EachArc`:`NormalArc`];if(this.ctx.rotate(u.rot),this.ctx.globalAlpha=v*n,this.drawImgAtcenter(x,_*N*2.25),this.ctx.restore(),g>this.settings.middleDistance){this.ctx.save(),this.ctx.globalAlpha=n;let e=this.images[a?`Hold_Mine_End`:r?`Hold_Break_End`:i?`Hold_Each_End`:`Hold_End`];this.ctx.translate(u.x*g,u.y*g),this.drawImgAtcenter(e,y*.65),this.ctx.restore()}if(this.ctx.save(),this.ctx.globalAlpha=n,this.ctx.translate(u.x*_,u.y*_),this.ctx.rotate(u.rot),this.ctx.drawImage(m,0,0,122,55,-y/2,-y*1.64*.35,y,y*1.64*.275),this.ctx.drawImage(m,0,55,122,90,-y/2,-y*1.64*.0785,y,y*1.64*(.17+b)),this.ctx.drawImage(m,0,145,122,55,-y/2,y*1.64*(.09+b),y,y*1.64*.275),e.isEx){this._tempColorConfig.colorCode=r?this.exColor.break:i?this.exColor.double:this.exColor.tap;let e=this.getMemoizedTintedImage(`hold_ex`,.6,this._tempColorConfig);this.ctx.drawImage(e,0,0,122,55,-y/2,-y*1.64*.35,y,y*1.64*.275),this.ctx.drawImage(e,0,55,122,90,-y/2,-y*1.64*.0785,y,y*1.64*(.17+b)),this.ctx.drawImage(e,0,145,122,55,-y/2,y*1.64*(.09+b),y,y*1.64*.275)}this.ctx.restore(),this.isPassThrough||(this.ctx.save(),this.ctx.translate(u.x*_,u.y*_),this.simpleHitEffect(c),s&&this.simpleHoldEffect(c),this.ctx.restore())}}getTouchHanabi(e){let{time:t,pos:n,touchPos:r,holdDuration:i}=e,a=t-this.globalTime;if(a>0)return;let o=r+n,s=this.hanabiEffect[o];if(s||(s={time:-99999,x:0,y:0,noteT:0,isCenter:!1,cleared:!0},this.hanabiEffect[o]=s),s.cleared===!1&&s.time>t)return;let c=Qs[r][r===`C`?0:n-1];if(i){if(e.isHanabi){let e=i+a;s.time=t,s.x=c.x,s.y=c.y,s.noteT=s.cleared===!1?Math.max(s.noteT,e):e,s.isCenter=r===`C`,s.cleared=!1}else s.time=t,s.cleared=!0;return}e.isHanabi?(s.time=t,s.x=c.x,s.y=c.y,s.noteT=s.cleared===!1?Math.max(s.noteT,a):a,s.isCenter=r===`C`,s.cleared=!1):(s.time=t,s.cleared=!0)}drawTouch(e){let{time:t,pos:n,touchPos:r,isDouble:i,isMine:a,holdDuration:o,hispeed:s}=e,c=r+n,l=this._zoneCounts[c]||0,u=t-this.globalTime,d=1-this.timeFunction(u*(this.settings.touchSpeed*.8833+.8167)*s),f=Qs[r][r===`C`?0:n-1],p=this.images[a?`touch_border_2_mine`:i?`touch_border_2_each`:`touch_border_2`],m=this.images[a?`touch_border_3_mine`:i?`touch_border_3_each`:`touch_border_3`],h=this.images[a?`touch_point_mine`:i?`touch_point_each`:`touch_point`];if(o){let e=t-this.globalTime<=-.1,n=[];for(let e=0;e<4;e++){let t=this.images[`touchhold_`+e+(a?`_mine`:``)];n.push(t)}let r=this.images[`touchhold_border`+(a?`_mine`:``)];if(this.ctx.save(),-u>o)this.ctx.translate(f.x,f.y),this.simpleHitEffect(o+u);else{let t=this.settings.noteBaseSize*.7,i=Math.max(0,Math.min(1,-u/o)),a=this.touchTimeFunction(18*(1-Math.min(1,d))/1.5)*1.6;this.ctx.translate(f.x,f.y),this.ctx.save(),this.ctx.beginPath(),this.ctx.moveTo(0,0),this.ctx.arc(0,0,t*1.3,-Math.PI*.5,Math.PI*i*2-Math.PI*.5),this.ctx.closePath(),this.ctx.clip(),this.drawImgAtcenter(r,t*2.6),this.ctx.restore(),this.ctx.globalAlpha=1,this.ctx.rotate(Math.PI*-.75),this.ctx.globalAlpha=Math.max(0,1-(1-Math.min(1,d))*.5);for(let e=0;e<4;e++)this.ctx.drawImage(n[e],-t*1.365*.5,t*.15*(a-1.5),t*1.365,t),this.ctx.rotate(Math.PI/2);this.ctx.globalAlpha=1,this.drawImgAtcenter(h,t*.4),this.simpleHitEffect(u),e&&this.simpleHoldEffect(u)}this.ctx.restore();return}let g=this.images[a?`touch_mine`:i?`touch_each`:`touch`];if(this.ctx.save(),u<=0)this.ctx.translate(f.x,f.y),this.simpleHitEffect(u);else{let e=this.settings.noteBaseSize*.7,t=this.touchTimeFunction(18*(1-d)/1.5)*1.6;this.ctx.translate(f.x,f.y),this.ctx.globalAlpha=1,l>=2&&!this.drawnBorders.has(c)&&(this.drawnBorders.add(c),this.drawImgAtcenter(p,e*2.65),l>2&&this.drawImgAtcenter(m,e*2.65)),this.ctx.globalAlpha=Math.max(0,1-(1-d)*.5);for(let n=0;n<4;n++)this.ctx.drawImage(g,-e*1.365*.5,e*.15*(t-1.5),e*1.365,e),this.ctx.rotate(Math.PI/2);this.ctx.globalAlpha=1,this.drawImgAtcenter(h,e*.4)}this.ctx.restore()}drawSlide(e){let t=e.isIllegal&&this.settings.slideIllegalRed?`wifi_`:e.isMine?`wifi_mine_`:e.isBreak?`wifi_break_`:e.isDouble?`wifi_each_`:`wifi_`,n=e.isIllegal&&this.settings.slideIllegalRed?`slide`:e.isMine?`slide_mine`:e.isBreak?`slide_break`:e.isDouble?`slide_each`:`slide`,{time:r,pos:i,slideEnd:a,slideDelay:o,slideDuration:s,path:c,wPaths:l,hispeed:u}=e,d=r-this.globalTime,f=1-this.timeFunction(d*(this.settings.speed*.8833+.8167)*u),p=c||sc(i,a);if(p.totalLength<1e-4)return;this.ctx.save();let m=-d>0;this.ctx.globalAlpha=m?1:.75*pc((f-this.settings.middleDistance)/(1-this.settings.middleDistance)+this.settings.slideSpeed,0,1);let h=0;-d>o&&(h=Math.min(1,(-d-o)/s));let g=e.isBreak&&!e.isMine&&!(e.isIllegal&&this.settings.slideIllegalRed)?Math.sin(this.globalTime*-6)**2*.5:0,_=e.slideType===`w`?t:n;this.drawPathWithArrows(p,e.isMine?0:h,_,e.slideType===`w`,g,e.isIllegal&&this.settings.slideIllegalRed);let v=Math.min(1,1-(d+o)/o);if(d<=0&&h<1&&(!e.hideHead||v>=1)){let{x:t,y:n,rot:r}=p.getPointAt(h);this.ctx.save(),this.ctx.globalAlpha=o<1e-4?1:v;let i=this.images[e.isMine?`star_mine`:e.isBreak?`star_break`:e.isDouble?`star_each`:`star`],a=this.ctx.getTransform();if(e.slideType===`w`){let e=l.w1.getPointAt(h);this.ctx.translate(e.x,e.y),this.ctx.rotate(e.rot+Math.PI*.5),this.drawImgAtcenter(i,this.settings.noteBaseSize*v*1.45),this.ctx.setTransform(a);let t=l.w2.getPointAt(h);this.ctx.translate(t.x,t.y),this.ctx.rotate(t.rot+Math.PI*.5),this.drawImgAtcenter(i,this.settings.noteBaseSize*v*1.45),this.ctx.setTransform(a)}this.ctx.translate(t,n),this.ctx.rotate(r+Math.PI*.5),this.drawImgAtcenter(i,this.settings.noteBaseSize*v*1.45),this.ctx.restore()}this.ctx.restore()}drawPathWithArrows(e,t,n,r,i,a,o=4.36){let s=r?11:Math.floor((e.totalLength-2)/o);o=r?7:o,this.ctx.save();for(let c=s;c>Math.floor(t*s);c--){let t=Math.min(c-1,r?10:0),s=r?n+t:n,l=a?1:i,u=a?`#ff3838`:`#fff8a6`,d;if(a||i>0?(this._tempColorConfig.colorCode=u,d=this.getMemoizedTintedImage(s,l,this._tempColorConfig)):d=this.images[s],!d)continue;let f=c*o+(r?dc[t*4+2]:0),{x:p,y:m,rot:h}=e.getPointAt(f/e.totalLength);this.ctx.save(),this.ctx.translate(p,m),this.ctx.rotate(h+(r?Math.PI*-.3745:Math.PI));let g=r?dc[t*4]*(.096+dc[t*4+3]):7*.9,_=r?dc[t*4+1]*(.096+dc[t*4+3]):9.4*.9;this.drawImgAtcenter(d,1,0,0,g,_),this.ctx.restore()}this.ctx.restore()}drawHanabiEffects(){for(let e in this.hanabiEffect){let t=this.hanabiEffect[e];t.cleared||(this.ctx.save(),this.ctx.translate(t.x,t.y),this.simpleHanabi(t.noteT,t.isCenter),this.ctx.restore())}}},Nc={speed:6.5,touchSpeed:7,slideSpeed:0,middleDisplay:1,moviebrightness:-4,showSensor:!0,rotateStars:!0,pinkStars:!1,middleDistance:.25,effectDecayTime:.4,hanabiEffectDecayTime:.8,noteEndBehavior:`through`,noteEndFadeTime:.3,noteBaseSize:11,maxSlideCount:500,renderSurroundingAuxiliaryText:!0,slideIllegalRed:!1,showUI:!1,notPlayHoldEnd:!1,backgroundColor:`#0c0c1e`,sfxVolumes:{}};function Pc(e){let t=A(!1),n=A(0),r=A(1),i=A(4),a=A(!1),o=A(-.001);function s(e){o.value=Math.round(e*1e3)/1e3,he(n.value,0)}function c(e){o.value=Math.round((o.value+e)*1e3)/1e3,he(n.value,0)}function l(){o.value=-.001,he(n.value,0)}let u=null,d=null,f=null,p=null,m=0,h={tap:0,hold:0,slide:0,touch:0,break:0,score:0,breakScore:0,invScore:0},g=null,_=null,v=!1,y=0,b=320,x=null,S=null,C=null;function w(t){let n=e.M.value;if(!n||n.length===0)return 0;let r=0,i=n.length-1;for(;r<i;){let e=r+i+1>>1;n[e]<=t+1e-6?r=e:i=e-1}return r}function ee(t){let n=e.M.value;if(!n||n.length===0)return 0;let r=w(t),i=r===0?0:n[r],a=(n[r+1]??e.DATA.value?.meta.endTime??i+2)-i;return a<=0?r:r+Math.max(0,Math.min(1,(t-i)/a))}function te(t){if(t<=0)return 0;let n=e.M.value;if(!n||n.length===0)return 0;let r=Math.floor(t),i=t-r;if(r>=n.length-1){let e=n.length-1;return n[e]+(e>0?n[e]-n[e-1]:2)*i}let a=r===0?0:n[r];return a+(n[r+1]-a)*i}function ne(t){let n=e.C.value,r=0,i=n.length-2;for(;r<i;){let e=r+i+1>>1;n[e]<=t+1e-6?r=e:i=e-1}return r}function T(){return ne(n.value)}function re(){let t=e.N.value;if(!t||t.length===0)return 0;let r=t.findIndex(e=>e.time>=n.value);return r===-1?t.length-1:r}let ie=Aa(()=>w(n.value)),ae=Aa(()=>ee(n.value)),oe=Aa(()=>re());function se(t){let n=e.N.value;if(!n||n.length===0){m=0;return}let r=n.findIndex(e=>e.time>=Math.max(0,t-2));m=r===-1?n.length:r}function ce(t){let r=e.DATA.value?.meta.endTime??0;n.value=Math.max(0,Math.min(r,t)),ec.soundQueue=[],ec.stopAllScheduledSounds(),n.value>0?se(n.value):m=0,he(n.value)}function E(t){let n=Math.max(0,Math.min(e.C.value.length-2,t));ce(e.C.value[n])}function le(e){let t=T(),r=ne(n.value+e);e>0&&r<=t&&(r=t+1),e<0&&r>=t&&(r=t-1),E(r)}function ue(t){let r=e.N.value;if(!(!r||r.length===0))if(t>0){let t=r.find(e=>e.time>n.value+1e-6);ce(t?t.time:e.DATA.value.meta.endTime)}else{let e=null;for(let t=r.length-1;t>=0;t--)if(r[t].time<n.value-1e-6){e=r[t];break}ce(e?e.time:0)}}function D(){if(!x)return;let e=x.parentElement,t=e?Math.min(e.clientWidth,e.clientHeight):320;b=Math.max(100,Math.floor(t)),x.style.width=x.style.height=b+`px`,x.width=x.height=b*devicePixelRatio,he(n.value,0)}function de(e){if(x=e,S=x.getContext(`2d`),u&&u.setContext(S),D(),window.addEventListener(`resize`,D),window.ResizeObserver){let e=0;C=new ResizeObserver(()=>{let t=x.getBoundingClientRect(),n=Math.round(Math.min(t.width,t.height));n>0&&Math.abs(n-e)>=1&&(e=n,D())}),C.observe(x.parentElement)}}function fe(){window.removeEventListener(`resize`,D),C?.disconnect()}async function pe(){f=await ac();try{let e=await(async()=>{try{return await(await fetch(`Skin/outline.png`)).blob()}catch{return null}})();e&&(p=await createImageBitmap(e))}catch(e){console.error(`Failed to load outline image:`,e)}await document.fonts.ready}function me(){if(!x)throw Error(`canvas 尚未掛載`);u=new Mc(x,Nc),u.setImages(f),u.setContext(S),d=new gc,D()}function he(n,i=0){if(!u||!d||!e.DATA.value)return;let s=e.DATA.value,c=Math.max(0,n+o.value),{buckets:l,playCombo:f,playScore:g,noteQuantity:_,nowIndex:v}=d.get({renderer:u,globalTime:c,realTime:c,musicDelay:0,playing:t.value,timeControlSliding:a.value,readyBeat:!1,playedClock:[],settings:Nc,visualHeight:0,notes:e.N.value,decodedTags:s.tags||[],playScoreRes:h,nowIndex:m,skipAudioQueue:!1});m=v,S.setTransform(1,0,0,1,0,0),S.fillStyle=Nc.backgroundColor,S.fillRect(0,0,x.width,x.height);let y=b*devicePixelRatio/100*u.scale;S.setTransform(y,0,0,y,x.width/2,x.height/2),p&&S.drawImage(p,100*-.5*.9,100*-.5*.9,100*.9,100*.9),u.drawFrame({globalTime:c,buckets:l,dt:i*r.value,showSensor:Nc.showSensor,showSensorText:!1,playCombo:f,playScore:g,nowIndex:m,skipClear:!0,noteQuantity:_,playScoreRes:h})}function ge(i){if(!t.value)return;let a=Math.min(100,i-y)/1e3;y=i,n.value+=a*r.value;let o=e.DATA.value.meta.endTime;_!==null&&n.value>=_&&(v?ce(g===null?0:g):(n.value=_,t.value=!1,_=null)),n.value>=o&&(v?ce(g===null?0:g):(n.value=o,t.value=!1)),he(n.value,a),ec.update(n.value),t.value&&requestAnimationFrame(ge)}function _e(){ec.ensureContextSync(),ec.ctx?.state===`suspended`&&ec.ctx.resume().catch(()=>{})}function ve(){t.value||(t.value=!0,_e(),y=performance.now(),requestAnimationFrame(ge))}function ye(){t.value=!1,_=null,g=null,v=!1}function be(){t.value?ye():ve()}function xe(e){_=e,g=0,v=!1}function Se(e,t,n=!1){g=e,_=t,v=n}function Ce(e){r.value=e}function we(e){i.value=e,Nc.speed=e,he(n.value,0)}function Te(e){a.value=e}function O(){m=0,h={tap:0,hold:0,slide:0,touch:0,break:0,score:0,breakScore:0,invScore:0},d=new gc}return{playing:t,realTime:n,speed:r,hs:i,dragging:a,timeOffset:o,hudMeasure:ie,hudMeasureFloat:ae,hudCombo:oe,measureIndex:w,measureIndexFloat:ee,measureTime:te,commaIndexAt:ne,currentCommaIndex:T,currentComboIndex:re,seek:ce,seekComma:E,jumpByTime:le,jumpToAdjacentNote:ue,attachCanvas:de,detachCanvas:fe,resizeCanvas:D,loadAssets:pe,initEngine:me,resetPlaybackState:O,play:ve,pause:ye,togglePlay:be,setPreviewStop:xe,setPreviewBounds:Se,setSpeed:Ce,setHs:we,setTimeOffset:s,adjustTimeOffset:c,resetTimeOffset:l,setDragging:Te,unlockAudio:_e,defaultSettings:Nc}}var Fc={class:`modal-box preview-modal-box`},Ic={class:`preview-stage`},Lc={key:0,class:`preview-offset-panel`},Rc={class:`offset-field`},zc={class:`offset-field`},Bc={class:`preview-footer-options`},Vc={class:`auto-loop-toggle`},Hc={key:1,class:`message error`},Uc={class:`modal-actions`},Wc=Ms({__name:`PreviewModal`,props:{open:{type:Boolean,required:!0},chart:{type:Object,required:!0},rangeSel:{type:Object,required:!0}},emits:[`close`],setup(e,{emit:t}){let n=e,r=t,i=Oc(),a=Pc(i),o=A(``),s=A(.1),c=A(.1),l=A(!0),u,d=new Promise(e=>{u=e});async function f(e){a.attachCanvas(e),await a.loadAssets(),a.initEngine(),u()}function p(){a.detachCanvas()}function m(){o.value=``;try{if(n.rangeSel.cleanCut.value){let e=n.rangeSel.buildExportPreview();if(!e.text||e.text.startsWith(`（`))throw Error(`這段沒有可預覽的內容`);i.loadFromText(e.text,`切的乾淨預覽`);let t=i.DATA.value?.meta.endTime??0;a.resetPlaybackState(),a.seek(0),a.setPreviewBounds(0,t,l.value)}else{i.adoptFrom(n.chart);let{start:e,end:t}=n.rangeSel.rangeTimeSpan(),r=Math.max(0,e-Number(s.value)),o=Math.min(n.chart.DATA.value?.meta.endTime??t,t+Number(c.value));a.resetPlaybackState(),a.seek(r),a.setPreviewBounds(r,o,l.value)}a.play()}catch(e){o.value=e?.message||String(e)}}return Hn([()=>n.open,s,c,l],async([e])=>{if(!e){a.pause();return}await d,m()}),mr(p),(t,n)=>In((Bi(),Gi(`div`,{class:`modal-overlay`,onClick:n[4]||=e=>e.target===e.currentTarget&&r(`close`)},[M(`div`,Fc,[M(`h3`,null,O(e.rangeSel.cleanCut.value?`預覽（切的乾淨）`:`預覽（原始譜面片段）`),1),M(`div`,Ic,[Zi(ms,{attach:f,detach:p,"stage-id":`previewStage`,"canvas-id":`previewCanvas`})]),e.rangeSel.cleanCut.value?ra(``,!0):(Bi(),Gi(`div`,Lc,[M(`div`,Rc,[M(`label`,null,[n[5]||=ta(`⏱️ 提早開始 (0s~1s): `,-1),M(`strong`,null,`-`+O(s.value.toFixed(2))+`s`,1)]),In(M(`input`,{type:`range`,min:`0`,max:`1`,step:`0.05`,"onUpdate:modelValue":n[0]||=e=>s.value=e},null,512),[[To,s.value,void 0,{number:!0}]])]),M(`div`,zc,[M(`label`,null,[n[6]||=ta(`⏱️ 延後結束 (0s~1s): `,-1),M(`strong`,null,`+`+O(c.value.toFixed(2))+`s`,1)]),In(M(`input`,{type:`range`,min:`0`,max:`1`,step:`0.05`,"onUpdate:modelValue":n[1]||=e=>c.value=e},null,512),[[To,c.value,void 0,{number:!0}]])])])),M(`div`,Bc,[M(`label`,Vc,[In(M(`input`,{type:`checkbox`,"onUpdate:modelValue":n[2]||=e=>l.value=e},null,512),[[Eo,l.value]]),n[7]||=M(`span`,null,`🔁 自動循環播放`,-1)])]),o.value?(Bi(),Gi(`p`,Hc,O(o.value),1)):ra(``,!0),M(`div`,Uc,[M(`button`,{class:`btn-modal-cancel`,onClick:n[3]||=e=>r(`close`)},`關閉`)])])],512)),[[Wa,e.open]])}},[[`__scopeId`,`data-v-69ac6d7c`]]),Gc=[`off`,`simple`,`full`],Kc={off:`🔇 靜音`,simple:`🔉 簡易`,full:`🔊 完整`};function qc(){let e=A(.5),t=A(`simple`),n=A(!1),r=A(!1),i=A(``),a=Aa(()=>Kc[t.value]);function o(){ec.muted=t.value===`off`,ec.synthFallback=t.value!==`off`,t.value===`off`&&(ec.soundQueue=[],ec.stopAllScheduledSounds())}function s(){r.value||n.value||(n.value=!0,i.value=`🔊 正在載入完整音效…（先以簡易音播放）`,ec.init(e=>{i.value=`🔊 正在載入完整音效… ${Math.round(e)}%（先以簡易音播放）`}).catch(e=>console.warn(`[Audio] 音效載入部分失敗:`,e)).then(()=>{ec.setSFXVolume(e.value),r.value=!0,n.value=!1,i.value=t.value===`full`?`✅ 完整音效已就緒`:``,i.value&&setTimeout(()=>{i.value=``},1500)}))}function c(){ec.ensureContextSync(),ec.ctx?.state===`suspended`&&ec.ctx.resume().catch(()=>{})}function l(){t.value=Gc[(Gc.indexOf(t.value)+1)%Gc.length],o(),c(),t.value===`full`&&s()}function u(t){e.value=t,ec.setSFXVolume(t)}return o(),{sfxVolume:e,sfxMode:t,sfxFullLoading:n,sfxFullLoaded:r,sfxLoadingMessage:i,sfxModeLabel:a,cycleSfxMode:l,unlockAudio:c,setSfxVolume:u}}var Jc=`#f23f43`,Yc=e=>getComputedStyle(document.documentElement).getPropertyValue(e).trim();function Xc(e,t){let n=A(0),r=A(0),i=A(0),a=A(null),o=A(!0),s=null,c=null,l=Aa(()=>({start:Math.min(n.value,r.value),end:Math.max(n.value,r.value)}));function u(){let t=e.C.value;if(!t||t.length<2)return 0;let n=t[l.value.start]??0,r=t[l.value.end+1]??e.DATA.value?.meta.endTime??0;return Math.max(0,r-n)}function d(){let t=e.N.value,n=e.C.value;if(!t||t.length===0)return null;let r=n[l.value.start]??0,i=n[l.value.end+1]??e.DATA.value?.meta.endTime??0,a=t.findIndex(e=>e.time>=r-1e-6);if(a===-1||t[a].time>=i-1e-6)return null;let o=a;for(let e=t.length-1;e>=a;e--)if(t[e].time<i-1e-6){o=e;break}return{first:a+1,last:o+1}}let f=Aa(u),p=Aa(()=>l.value.end-l.value.start+1>0&&f.value>30),m=Aa(()=>{if(l.value.end-l.value.start+1<=0)return`⚠️ 空區間`;let e=d(),t=ee(),n=e?`Combo ${e.first} - ${e.last}`:`（此區間沒有音符）`;n+=`  (${t.start.toFixed(3)}s ~ ${t.end.toFixed(3)}s, ~${f.value.toFixed(3)}s)`;let r=(e,t)=>a.value===e?`◆${t}`:``,i=[r(`a`,`起`),r(`b`,`終`)].filter(Boolean).join(` `);return i&&(n+=`  ${i}`),n}),h=Aa(()=>l.value.end-l.value.start+1<=0?{text:`⚠️ 選取範圍為空區間，無法渲染。`,type:`error`}:{text:``,type:``});function g(t){return e.commaParts.value[t]||`（空拍）`}function _(e){a.value=e}function v(e,t){i.value=e,n.value=t?.start??0,r.value=t?.end??e}function y(i,a){i===`a`?n.value=a:r.value=a,_(i);let o=e.C.value[a];o!==void 0&&t.seek(o)}function b(e,t){let o=a.value;if(!o)return;let s=t?10:1,c=o===`a`?n.value:r.value;y(o,Math.max(0,Math.min(i.value,c+e*s)))}function x(){a.value&&y(a.value,t.currentCommaIndex())}function S(){let e=t.currentCommaIndex(),i=l.value.end;n.value=e,r.value=Math.max(i,e)}function C(){let e=t.currentCommaIndex(),i=l.value.start;r.value=e,n.value=Math.min(i,e)}function w(){t.seek(e.C.value[l.value.start]??0)}function ee(){let t=e.C.value;return!t||t.length<2?{start:0,end:0}:{start:t[l.value.start]??0,end:t[l.value.end+1]??e.DATA.value?.meta.endTime??0}}function te(){let t=f.value,n=ee(),r=null;if(o.value)try{let t={indexToTime:e.C.value,tags:e.DATA.value.tags||[],bpm:e.DATA.value.meta.bpm};r=Ec(e.chartText.value,t,e.C.value[l.value.start]??0,e.C.value[l.value.end+1]??e.DATA.value.meta.endTime)}catch(e){console.error(`產生預覽片段失敗:`,e)}return{meta:o.value?`切的乾淨・${n.start.toFixed(3)}s ~ ${n.end.toFixed(3)}s (約 ${t.toFixed(3)} 秒)・以下是實際會送出的內容`:`未啟用切的乾淨・${n.start.toFixed(3)}s ~ ${n.end.toFixed(3)}s (約 ${t.toFixed(3)} 秒)・會送出整份原始譜面＋指定時間範圍`,text:r??`（整份原始譜面，內容過長不在此顯示；後端會照時間範圍只播放這一段）`}}function ne(e){s=e,c=e?e.getContext(`2d`):null}function T(n){if(!c||!s)return;let r=e.M.value,i=e.D.value,a=e.C.value;if(r.length===0)return;let o=s.clientWidth;if(o===0){requestAnimationFrame(()=>T(n));return}let u=o*devicePixelRatio,d=50*devicePixelRatio;s.width!==u&&(s.width=u,s.height=d),c.clearRect(0,0,u,d);let f=u/r.length,m=Math.max(1,...i.map(e=>e.tap+e.hold+e.slide+e.touch+e.brk)),h=[[`tap`,`--tap`],[`hold`,`--hold`],[`slide`,`--slide`],[`touch`,`--touch`],[`brk`,`--brk`]];if(i.forEach((e,t)=>{let n=d;h.forEach(([r,i])=>{if(!e[r])return;let a=e[r]/m*(d-6);n-=a,c.fillStyle=Yc(i),c.fillRect(t*f+.5,n,Math.max(1,f-1),a)})}),a.length>1){let e=t.measureIndexFloat?e=>t.measureIndexFloat(e):e=>t.measureIndex(e),n=e(a[l.value.start]??0),r=e(a[l.value.end+1]??a[a.length-1]);c.fillStyle=p.value?`rgba(242, 63, 67, 0.16)`:`rgba(115, 115, 115, 0.25)`,c.fillRect(n*f,0,Math.max(f,(r-n)*f),d),c.fillStyle=p.value?Jc:Yc(`--mine`),c.fillRect(n*f,0,2,d),c.fillRect(r*f-2,0,2,d)}c.fillStyle=`#ffffff`,c.fillRect(n*f,0,Math.max(2,f*.6),d)}function re(n,r){let i=e.M.value,a=r.getBoundingClientRect(),o=Math.max(0,Math.min(1,(n-a.left)/a.width));t.seek(t.measureTime(Math.round(o*(i.length-1))))}return Hn([t.realTime,n,r],()=>{T(t.hudMeasureFloat?t.hudMeasureFloat.value:t.hudMeasure.value)}),{range:l,rangeAValue:n,rangeBValue:r,maxComma:i,activeEndpoint:a,cleanCut:o,rangeDuration:f,rangeOverLimit:p,rangeLabel:m,rangeMessage:h,commaLabel:g,setActiveEndpoint:_,initBounds:v,onRangeInput:y,moveActiveEndpoint:b,syncActiveEndpointToPlayhead:x,setStart:S,setEnd:C,goStart:w,rangeTimeSpan:ee,buildExportPreview:te,setDensityCanvas:ne,drawDensity:T,densitySeek:re}}var Zc=typeof globalThis<`u`?globalThis:typeof window<`u`?window:typeof global<`u`?global:typeof self<`u`?self:{};function Qc(e){return e&&e.__esModule&&Object.prototype.hasOwnProperty.call(e,`default`)?e.default:e}var $c={exports:{}},el;function tl(){return el?$c.exports:(el=1,(function(e){var t=Object.prototype.hasOwnProperty,n=`~`;function r(){}Object.create&&(r.prototype=Object.create(null),new r().__proto__||(n=!1));function i(e,t,n){this.fn=e,this.context=t,this.once=n||!1}function a(e,t,r,a,o){if(typeof r!=`function`)throw TypeError(`The listener must be a function`);var s=new i(r,a||e,o),c=n?n+t:t;return e._events[c]?e._events[c].fn?e._events[c]=[e._events[c],s]:e._events[c].push(s):(e._events[c]=s,e._eventsCount++),e}function o(e,t){--e._eventsCount===0?e._events=new r:delete e._events[t]}function s(){this._events=new r,this._eventsCount=0}s.prototype.eventNames=function(){var e=[],r,i;if(this._eventsCount===0)return e;for(i in r=this._events)t.call(r,i)&&e.push(n?i.slice(1):i);return Object.getOwnPropertySymbols?e.concat(Object.getOwnPropertySymbols(r)):e},s.prototype.listeners=function(e){var t=n?n+e:e,r=this._events[t];if(!r)return[];if(r.fn)return[r.fn];for(var i=0,a=r.length,o=Array(a);i<a;i++)o[i]=r[i].fn;return o},s.prototype.listenerCount=function(e){var t=n?n+e:e,r=this._events[t];return r?r.fn?1:r.length:0},s.prototype.emit=function(e,t,r,i,a,o){var s=n?n+e:e;if(!this._events[s])return!1;var c=this._events[s],l=arguments.length,u,d;if(c.fn){switch(c.once&&this.removeListener(e,c.fn,void 0,!0),l){case 1:return c.fn.call(c.context),!0;case 2:return c.fn.call(c.context,t),!0;case 3:return c.fn.call(c.context,t,r),!0;case 4:return c.fn.call(c.context,t,r,i),!0;case 5:return c.fn.call(c.context,t,r,i,a),!0;case 6:return c.fn.call(c.context,t,r,i,a,o),!0}for(d=1,u=Array(l-1);d<l;d++)u[d-1]=arguments[d];c.fn.apply(c.context,u)}else{var f=c.length,p;for(d=0;d<f;d++)switch(c[d].once&&this.removeListener(e,c[d].fn,void 0,!0),l){case 1:c[d].fn.call(c[d].context);break;case 2:c[d].fn.call(c[d].context,t);break;case 3:c[d].fn.call(c[d].context,t,r);break;case 4:c[d].fn.call(c[d].context,t,r,i);break;default:if(!u)for(p=1,u=Array(l-1);p<l;p++)u[p-1]=arguments[p];c[d].fn.apply(c[d].context,u)}}return!0},s.prototype.on=function(e,t,n){return a(this,e,t,n,!1)},s.prototype.once=function(e,t,n){return a(this,e,t,n,!0)},s.prototype.removeListener=function(e,t,r,i){var a=n?n+e:e;if(!this._events[a])return this;if(!t)return o(this,a),this;var s=this._events[a];if(s.fn)s.fn===t&&(!i||s.once)&&(!r||s.context===r)&&o(this,a);else{for(var c=0,l=[],u=s.length;c<u;c++)(s[c].fn!==t||i&&!s[c].once||r&&s[c].context!==r)&&l.push(s[c]);l.length?this._events[a]=l.length===1?l[0]:l:o(this,a)}return this},s.prototype.removeAllListeners=function(e){var t;return e?(t=n?n+e:e,this._events[t]&&o(this,t)):(this._events=new r,this._eventsCount=0),this},s.prototype.off=s.prototype.removeListener,s.prototype.addListener=s.prototype.on,s.prefixed=n,s.EventEmitter=s,e.exports=s})($c),$c.exports)}var nl=Qc(tl()),F;(function(e){e.assertEqual=e=>e;function t(e){}e.assertIs=t;function n(e){throw Error()}e.assertNever=n,e.arrayToEnum=e=>{let t={};for(let n of e)t[n]=n;return t},e.getValidEnumValues=t=>{let n=e.objectKeys(t).filter(e=>typeof t[t[e]]!=`number`),r={};for(let e of n)r[e]=t[e];return e.objectValues(r)},e.objectValues=t=>e.objectKeys(t).map(function(e){return t[e]}),e.objectKeys=typeof Object.keys==`function`?e=>Object.keys(e):e=>{let t=[];for(let n in e)Object.prototype.hasOwnProperty.call(e,n)&&t.push(n);return t},e.find=(e,t)=>{for(let n of e)if(t(n))return n},e.isInteger=typeof Number.isInteger==`function`?e=>Number.isInteger(e):e=>typeof e==`number`&&isFinite(e)&&Math.floor(e)===e;function r(e,t=` | `){return e.map(e=>typeof e==`string`?`'${e}'`:e).join(t)}e.joinValues=r,e.jsonStringifyReplacer=(e,t)=>typeof t==`bigint`?t.toString():t})(F||={});var rl;(function(e){e.mergeShapes=(e,t)=>({...e,...t})})(rl||={});var I=F.arrayToEnum([`string`,`nan`,`number`,`integer`,`float`,`boolean`,`date`,`bigint`,`symbol`,`function`,`undefined`,`null`,`array`,`object`,`unknown`,`promise`,`void`,`never`,`map`,`set`]),il=e=>{switch(typeof e){case`undefined`:return I.undefined;case`string`:return I.string;case`number`:return isNaN(e)?I.nan:I.number;case`boolean`:return I.boolean;case`function`:return I.function;case`bigint`:return I.bigint;case`symbol`:return I.symbol;case`object`:return Array.isArray(e)?I.array:e===null?I.null:e.then&&typeof e.then==`function`&&e.catch&&typeof e.catch==`function`?I.promise:typeof Map<`u`&&e instanceof Map?I.map:typeof Set<`u`&&e instanceof Set?I.set:typeof Date<`u`&&e instanceof Date?I.date:I.object;default:return I.unknown}},L=F.arrayToEnum([`invalid_type`,`invalid_literal`,`custom`,`invalid_union`,`invalid_union_discriminator`,`invalid_enum_value`,`unrecognized_keys`,`invalid_arguments`,`invalid_return_type`,`invalid_date`,`invalid_string`,`too_small`,`too_big`,`invalid_intersection_types`,`not_multiple_of`,`not_finite`]),al=e=>JSON.stringify(e,null,2).replace(/"([^"]+)":/g,`$1:`),ol=class e extends Error{constructor(e){super(),this.issues=[],this.addIssue=e=>{this.issues=[...this.issues,e]},this.addIssues=(e=[])=>{this.issues=[...this.issues,...e]};let t=new.target.prototype;Object.setPrototypeOf?Object.setPrototypeOf(this,t):this.__proto__=t,this.name=`ZodError`,this.issues=e}get errors(){return this.issues}format(e){let t=e||function(e){return e.message},n={_errors:[]},r=e=>{for(let i of e.issues)if(i.code===`invalid_union`)i.unionErrors.map(r);else if(i.code===`invalid_return_type`)r(i.returnTypeError);else if(i.code===`invalid_arguments`)r(i.argumentsError);else if(i.path.length===0)n._errors.push(t(i));else{let e=n,r=0;for(;r<i.path.length;){let n=i.path[r];r===i.path.length-1?(e[n]=e[n]||{_errors:[]},e[n]._errors.push(t(i))):e[n]=e[n]||{_errors:[]},e=e[n],r++}}};return r(this),n}static assert(t){if(!(t instanceof e))throw Error(`Not a ZodError: ${t}`)}toString(){return this.message}get message(){return JSON.stringify(this.issues,F.jsonStringifyReplacer,2)}get isEmpty(){return this.issues.length===0}flatten(e=e=>e.message){let t={},n=[];for(let r of this.issues)r.path.length>0?(t[r.path[0]]=t[r.path[0]]||[],t[r.path[0]].push(e(r))):n.push(e(r));return{formErrors:n,fieldErrors:t}}get formErrors(){return this.flatten()}};ol.create=e=>new ol(e);var sl=(e,t)=>{let n;switch(e.code){case L.invalid_type:n=e.received===I.undefined?`Required`:`Expected ${e.expected}, received ${e.received}`;break;case L.invalid_literal:n=`Invalid literal value, expected ${JSON.stringify(e.expected,F.jsonStringifyReplacer)}`;break;case L.unrecognized_keys:n=`Unrecognized key(s) in object: ${F.joinValues(e.keys,`, `)}`;break;case L.invalid_union:n=`Invalid input`;break;case L.invalid_union_discriminator:n=`Invalid discriminator value. Expected ${F.joinValues(e.options)}`;break;case L.invalid_enum_value:n=`Invalid enum value. Expected ${F.joinValues(e.options)}, received '${e.received}'`;break;case L.invalid_arguments:n=`Invalid function arguments`;break;case L.invalid_return_type:n=`Invalid function return type`;break;case L.invalid_date:n=`Invalid date`;break;case L.invalid_string:typeof e.validation==`object`?`includes`in e.validation?(n=`Invalid input: must include "${e.validation.includes}"`,typeof e.validation.position==`number`&&(n=`${n} at one or more positions greater than or equal to ${e.validation.position}`)):`startsWith`in e.validation?n=`Invalid input: must start with "${e.validation.startsWith}"`:`endsWith`in e.validation?n=`Invalid input: must end with "${e.validation.endsWith}"`:F.assertNever(e.validation):n=e.validation===`regex`?`Invalid`:`Invalid ${e.validation}`;break;case L.too_small:n=e.type===`array`?`Array must contain ${e.exact?`exactly`:e.inclusive?`at least`:`more than`} ${e.minimum} element(s)`:e.type===`string`?`String must contain ${e.exact?`exactly`:e.inclusive?`at least`:`over`} ${e.minimum} character(s)`:e.type===`number`?`Number must be ${e.exact?`exactly equal to `:e.inclusive?`greater than or equal to `:`greater than `}${e.minimum}`:e.type===`date`?`Date must be ${e.exact?`exactly equal to `:e.inclusive?`greater than or equal to `:`greater than `}${new Date(Number(e.minimum))}`:`Invalid input`;break;case L.too_big:n=e.type===`array`?`Array must contain ${e.exact?`exactly`:e.inclusive?`at most`:`less than`} ${e.maximum} element(s)`:e.type===`string`?`String must contain ${e.exact?`exactly`:e.inclusive?`at most`:`under`} ${e.maximum} character(s)`:e.type===`number`?`Number must be ${e.exact?`exactly`:e.inclusive?`less than or equal to`:`less than`} ${e.maximum}`:e.type===`bigint`?`BigInt must be ${e.exact?`exactly`:e.inclusive?`less than or equal to`:`less than`} ${e.maximum}`:e.type===`date`?`Date must be ${e.exact?`exactly`:e.inclusive?`smaller than or equal to`:`smaller than`} ${new Date(Number(e.maximum))}`:`Invalid input`;break;case L.custom:n=`Invalid input`;break;case L.invalid_intersection_types:n=`Intersection results could not be merged`;break;case L.not_multiple_of:n=`Number must be a multiple of ${e.multipleOf}`;break;case L.not_finite:n=`Number must be finite`;break;default:n=t.defaultError,F.assertNever(e)}return{message:n}},cl=sl;function ll(e){cl=e}function ul(){return cl}var dl=e=>{let{data:t,path:n,errorMaps:r,issueData:i}=e,a=[...n,...i.path||[]],o={...i,path:a};if(i.message!==void 0)return{...i,path:a,message:i.message};let s=``,c=r.filter(e=>!!e).slice().reverse();for(let e of c)s=e(o,{data:t,defaultError:s}).message;return{...i,path:a,message:s}},fl=[];function R(e,t){let n=ul(),r=dl({issueData:t,data:e.data,path:e.path,errorMaps:[e.common.contextualErrorMap,e.schemaErrorMap,n,n===sl?void 0:sl].filter(e=>!!e)});e.common.issues.push(r)}var pl=class e{constructor(){this.value=`valid`}dirty(){this.value===`valid`&&(this.value=`dirty`)}abort(){this.value!==`aborted`&&(this.value=`aborted`)}static mergeArray(e,t){let n=[];for(let r of t){if(r.status===`aborted`)return z;r.status===`dirty`&&e.dirty(),n.push(r.value)}return{status:e.value,value:n}}static async mergeObjectAsync(t,n){let r=[];for(let e of n){let t=await e.key,n=await e.value;r.push({key:t,value:n})}return e.mergeObjectSync(t,r)}static mergeObjectSync(e,t){let n={};for(let r of t){let{key:t,value:i}=r;if(t.status===`aborted`||i.status===`aborted`)return z;t.status===`dirty`&&e.dirty(),i.status===`dirty`&&e.dirty(),t.value!==`__proto__`&&(i.value!==void 0||r.alwaysSet)&&(n[t.value]=i.value)}return{status:e.value,value:n}}},z=Object.freeze({status:`aborted`}),ml=e=>({status:`dirty`,value:e}),hl=e=>({status:`valid`,value:e}),gl=e=>e.status===`aborted`,_l=e=>e.status===`dirty`,vl=e=>e.status===`valid`,yl=e=>typeof Promise<`u`&&e instanceof Promise;function bl(e,t,n,r){if(typeof t==`function`?e!==t||!r:!t.has(e))throw TypeError(`Cannot read private member from an object whose class did not declare it`);return t.get(e)}function xl(e,t,n,r,i){if(typeof t==`function`?e!==t||!i:!t.has(e))throw TypeError(`Cannot write private member to an object whose class did not declare it`);return t.set(e,n),n}var B;(function(e){e.errToObj=e=>typeof e==`string`?{message:e}:e||{},e.toString=e=>typeof e==`string`?e:e?.message})(B||={});var Sl,Cl,wl=class{constructor(e,t,n,r){this._cachedPath=[],this.parent=e,this.data=t,this._path=n,this._key=r}get path(){return this._cachedPath.length||(this._key instanceof Array?this._cachedPath.push(...this._path,...this._key):this._cachedPath.push(...this._path,this._key)),this._cachedPath}},Tl=(e,t)=>{if(vl(t))return{success:!0,data:t.value};if(!e.common.issues.length)throw Error(`Validation failed but no issues detected.`);return{success:!1,get error(){if(this._error)return this._error;let t=new ol(e.common.issues);return this._error=t,this._error}}};function V(e){if(!e)return{};let{errorMap:t,invalid_type_error:n,required_error:r,description:i}=e;if(t&&(n||r))throw Error(`Can't use "invalid_type_error" or "required_error" in conjunction with custom error map.`);return t?{errorMap:t,description:i}:{errorMap:(t,i)=>{let{message:a}=e;return t.code===`invalid_enum_value`?{message:a??i.defaultError}:i.data===void 0?{message:a??r??i.defaultError}:t.code===`invalid_type`?{message:a??n??i.defaultError}:{message:i.defaultError}},description:i}}var H=class{constructor(e){this.spa=this.safeParseAsync,this._def=e,this.parse=this.parse.bind(this),this.safeParse=this.safeParse.bind(this),this.parseAsync=this.parseAsync.bind(this),this.safeParseAsync=this.safeParseAsync.bind(this),this.spa=this.spa.bind(this),this.refine=this.refine.bind(this),this.refinement=this.refinement.bind(this),this.superRefine=this.superRefine.bind(this),this.optional=this.optional.bind(this),this.nullable=this.nullable.bind(this),this.nullish=this.nullish.bind(this),this.array=this.array.bind(this),this.promise=this.promise.bind(this),this.or=this.or.bind(this),this.and=this.and.bind(this),this.transform=this.transform.bind(this),this.brand=this.brand.bind(this),this.default=this.default.bind(this),this.catch=this.catch.bind(this),this.describe=this.describe.bind(this),this.pipe=this.pipe.bind(this),this.readonly=this.readonly.bind(this),this.isNullable=this.isNullable.bind(this),this.isOptional=this.isOptional.bind(this)}get description(){return this._def.description}_getType(e){return il(e.data)}_getOrReturnCtx(e,t){return t||{common:e.parent.common,data:e.data,parsedType:il(e.data),schemaErrorMap:this._def.errorMap,path:e.path,parent:e.parent}}_processInputParams(e){return{status:new pl,ctx:{common:e.parent.common,data:e.data,parsedType:il(e.data),schemaErrorMap:this._def.errorMap,path:e.path,parent:e.parent}}}_parseSync(e){let t=this._parse(e);if(yl(t))throw Error(`Synchronous parse encountered promise.`);return t}_parseAsync(e){let t=this._parse(e);return Promise.resolve(t)}parse(e,t){let n=this.safeParse(e,t);if(n.success)return n.data;throw n.error}safeParse(e,t){let n={common:{issues:[],async:t?.async??!1,contextualErrorMap:t?.errorMap},path:t?.path||[],schemaErrorMap:this._def.errorMap,parent:null,data:e,parsedType:il(e)};return Tl(n,this._parseSync({data:e,path:n.path,parent:n}))}async parseAsync(e,t){let n=await this.safeParseAsync(e,t);if(n.success)return n.data;throw n.error}async safeParseAsync(e,t){let n={common:{issues:[],contextualErrorMap:t?.errorMap,async:!0},path:t?.path||[],schemaErrorMap:this._def.errorMap,parent:null,data:e,parsedType:il(e)},r=this._parse({data:e,path:n.path,parent:n});return Tl(n,await(yl(r)?r:Promise.resolve(r)))}refine(e,t){let n=e=>typeof t==`string`||t===void 0?{message:t}:typeof t==`function`?t(e):t;return this._refinement((t,r)=>{let i=e(t),a=()=>r.addIssue({code:L.custom,...n(t)});return typeof Promise<`u`&&i instanceof Promise?i.then(e=>e?!0:(a(),!1)):i?!0:(a(),!1)})}refinement(e,t){return this._refinement((n,r)=>e(n)?!0:(r.addIssue(typeof t==`function`?t(n,r):t),!1))}_refinement(e){return new Su({schema:this,typeName:U.ZodEffects,effect:{type:`refinement`,refinement:e}})}superRefine(e){return this._refinement(e)}optional(){return Cu.create(this,this._def)}nullable(){return wu.create(this,this._def)}nullish(){return this.nullable().optional()}array(){return ru.create(this,this._def)}promise(){return xu.create(this,this._def)}or(e){return ou.create([this,e],this._def)}and(e){return uu.create(this,e,this._def)}transform(e){return new Su({...V(this._def),schema:this,typeName:U.ZodEffects,effect:{type:`transform`,transform:e}})}default(e){let t=typeof e==`function`?e:()=>e;return new Tu({...V(this._def),innerType:this,defaultValue:t,typeName:U.ZodDefault})}brand(){return new ku({typeName:U.ZodBranded,type:this,...V(this._def)})}catch(e){let t=typeof e==`function`?e:()=>e;return new Eu({...V(this._def),innerType:this,catchValue:t,typeName:U.ZodCatch})}describe(e){let t=this.constructor;return new t({...this._def,description:e})}pipe(e){return Au.create(this,e)}readonly(){return ju.create(this)}isOptional(){return this.safeParse(void 0).success}isNullable(){return this.safeParse(null).success}},El=/^c[^\s-]{8,}$/i,Dl=/^[0-9a-z]+$/,Ol=/^[0-9A-HJKMNP-TV-Z]{26}$/,kl=/^[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}$/i,Al=/^[a-z0-9_-]{21}$/i,jl=/^[-+]?P(?!$)(?:(?:[-+]?\d+Y)|(?:[-+]?\d+[.,]\d+Y$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:(?:[-+]?\d+W)|(?:[-+]?\d+[.,]\d+W$))?(?:(?:[-+]?\d+D)|(?:[-+]?\d+[.,]\d+D$))?(?:T(?=[\d+-])(?:(?:[-+]?\d+H)|(?:[-+]?\d+[.,]\d+H$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:[-+]?\d+(?:[.,]\d+)?S)?)??$/,Ml=/^(?!\.)(?!.*\.\.)([A-Z0-9_'+\-\.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9\-]*\.)+[A-Z]{2,}$/i,Nl=`^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$`,Pl,Fl=/^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/,Il=/^(([a-f0-9]{1,4}:){7}|::([a-f0-9]{1,4}:){0,6}|([a-f0-9]{1,4}:){1}:([a-f0-9]{1,4}:){0,5}|([a-f0-9]{1,4}:){2}:([a-f0-9]{1,4}:){0,4}|([a-f0-9]{1,4}:){3}:([a-f0-9]{1,4}:){0,3}|([a-f0-9]{1,4}:){4}:([a-f0-9]{1,4}:){0,2}|([a-f0-9]{1,4}:){5}:([a-f0-9]{1,4}:){0,1})([a-f0-9]{1,4}|(((25[0-5])|(2[0-4][0-9])|(1[0-9]{2})|([0-9]{1,2}))\.){3}((25[0-5])|(2[0-4][0-9])|(1[0-9]{2})|([0-9]{1,2})))$/,Ll=/^([0-9a-zA-Z+/]{4})*(([0-9a-zA-Z+/]{2}==)|([0-9a-zA-Z+/]{3}=))?$/,Rl=`((\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\\d|3[01])|(0[469]|11)-(0[1-9]|[12]\\d|30)|(02)-(0[1-9]|1\\d|2[0-8])))`,zl=RegExp(`^${Rl}$`);function Bl(e){let t=`([01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d`;return e.precision?t=`${t}\\.\\d{${e.precision}}`:e.precision??(t=`${t}(\\.\\d+)?`),t}function Vl(e){return RegExp(`^${Bl(e)}$`)}function Hl(e){let t=`${Rl}T${Bl(e)}`,n=[];return n.push(e.local?`Z?`:`Z`),e.offset&&n.push(`([+-]\\d{2}:?\\d{2})`),t=`${t}(${n.join(`|`)})`,RegExp(`^${t}$`)}function Ul(e,t){return!!((t===`v4`||!t)&&Fl.test(e)||(t===`v6`||!t)&&Il.test(e))}var Wl=class e extends H{_parse(e){if(this._def.coerce&&(e.data=String(e.data)),this._getType(e)!==I.string){let t=this._getOrReturnCtx(e);return R(t,{code:L.invalid_type,expected:I.string,received:t.parsedType}),z}let t=new pl,n;for(let r of this._def.checks)if(r.kind===`min`)e.data.length<r.value&&(n=this._getOrReturnCtx(e,n),R(n,{code:L.too_small,minimum:r.value,type:`string`,inclusive:!0,exact:!1,message:r.message}),t.dirty());else if(r.kind===`max`)e.data.length>r.value&&(n=this._getOrReturnCtx(e,n),R(n,{code:L.too_big,maximum:r.value,type:`string`,inclusive:!0,exact:!1,message:r.message}),t.dirty());else if(r.kind===`length`){let i=e.data.length>r.value,a=e.data.length<r.value;(i||a)&&(n=this._getOrReturnCtx(e,n),i?R(n,{code:L.too_big,maximum:r.value,type:`string`,inclusive:!0,exact:!0,message:r.message}):a&&R(n,{code:L.too_small,minimum:r.value,type:`string`,inclusive:!0,exact:!0,message:r.message}),t.dirty())}else if(r.kind===`email`)Ml.test(e.data)||(n=this._getOrReturnCtx(e,n),R(n,{validation:`email`,code:L.invalid_string,message:r.message}),t.dirty());else if(r.kind===`emoji`)Pl||=new RegExp(Nl,`u`),Pl.test(e.data)||(n=this._getOrReturnCtx(e,n),R(n,{validation:`emoji`,code:L.invalid_string,message:r.message}),t.dirty());else if(r.kind===`uuid`)kl.test(e.data)||(n=this._getOrReturnCtx(e,n),R(n,{validation:`uuid`,code:L.invalid_string,message:r.message}),t.dirty());else if(r.kind===`nanoid`)Al.test(e.data)||(n=this._getOrReturnCtx(e,n),R(n,{validation:`nanoid`,code:L.invalid_string,message:r.message}),t.dirty());else if(r.kind===`cuid`)El.test(e.data)||(n=this._getOrReturnCtx(e,n),R(n,{validation:`cuid`,code:L.invalid_string,message:r.message}),t.dirty());else if(r.kind===`cuid2`)Dl.test(e.data)||(n=this._getOrReturnCtx(e,n),R(n,{validation:`cuid2`,code:L.invalid_string,message:r.message}),t.dirty());else if(r.kind===`ulid`)Ol.test(e.data)||(n=this._getOrReturnCtx(e,n),R(n,{validation:`ulid`,code:L.invalid_string,message:r.message}),t.dirty());else if(r.kind===`url`)try{new URL(e.data)}catch{n=this._getOrReturnCtx(e,n),R(n,{validation:`url`,code:L.invalid_string,message:r.message}),t.dirty()}else r.kind===`regex`?(r.regex.lastIndex=0,r.regex.test(e.data)||(n=this._getOrReturnCtx(e,n),R(n,{validation:`regex`,code:L.invalid_string,message:r.message}),t.dirty())):r.kind===`trim`?e.data=e.data.trim():r.kind===`includes`?e.data.includes(r.value,r.position)||(n=this._getOrReturnCtx(e,n),R(n,{code:L.invalid_string,validation:{includes:r.value,position:r.position},message:r.message}),t.dirty()):r.kind===`toLowerCase`?e.data=e.data.toLowerCase():r.kind===`toUpperCase`?e.data=e.data.toUpperCase():r.kind===`startsWith`?e.data.startsWith(r.value)||(n=this._getOrReturnCtx(e,n),R(n,{code:L.invalid_string,validation:{startsWith:r.value},message:r.message}),t.dirty()):r.kind===`endsWith`?e.data.endsWith(r.value)||(n=this._getOrReturnCtx(e,n),R(n,{code:L.invalid_string,validation:{endsWith:r.value},message:r.message}),t.dirty()):r.kind===`datetime`?Hl(r).test(e.data)||(n=this._getOrReturnCtx(e,n),R(n,{code:L.invalid_string,validation:`datetime`,message:r.message}),t.dirty()):r.kind===`date`?zl.test(e.data)||(n=this._getOrReturnCtx(e,n),R(n,{code:L.invalid_string,validation:`date`,message:r.message}),t.dirty()):r.kind===`time`?Vl(r).test(e.data)||(n=this._getOrReturnCtx(e,n),R(n,{code:L.invalid_string,validation:`time`,message:r.message}),t.dirty()):r.kind===`duration`?jl.test(e.data)||(n=this._getOrReturnCtx(e,n),R(n,{validation:`duration`,code:L.invalid_string,message:r.message}),t.dirty()):r.kind===`ip`?Ul(e.data,r.version)||(n=this._getOrReturnCtx(e,n),R(n,{validation:`ip`,code:L.invalid_string,message:r.message}),t.dirty()):r.kind===`base64`?Ll.test(e.data)||(n=this._getOrReturnCtx(e,n),R(n,{validation:`base64`,code:L.invalid_string,message:r.message}),t.dirty()):F.assertNever(r);return{status:t.value,value:e.data}}_regex(e,t,n){return this.refinement(t=>e.test(t),{validation:t,code:L.invalid_string,...B.errToObj(n)})}_addCheck(t){return new e({...this._def,checks:[...this._def.checks,t]})}email(e){return this._addCheck({kind:`email`,...B.errToObj(e)})}url(e){return this._addCheck({kind:`url`,...B.errToObj(e)})}emoji(e){return this._addCheck({kind:`emoji`,...B.errToObj(e)})}uuid(e){return this._addCheck({kind:`uuid`,...B.errToObj(e)})}nanoid(e){return this._addCheck({kind:`nanoid`,...B.errToObj(e)})}cuid(e){return this._addCheck({kind:`cuid`,...B.errToObj(e)})}cuid2(e){return this._addCheck({kind:`cuid2`,...B.errToObj(e)})}ulid(e){return this._addCheck({kind:`ulid`,...B.errToObj(e)})}base64(e){return this._addCheck({kind:`base64`,...B.errToObj(e)})}ip(e){return this._addCheck({kind:`ip`,...B.errToObj(e)})}datetime(e){return typeof e==`string`?this._addCheck({kind:`datetime`,precision:null,offset:!1,local:!1,message:e}):this._addCheck({kind:`datetime`,precision:e?.precision===void 0?null:e?.precision,offset:e?.offset??!1,local:e?.local??!1,...B.errToObj(e?.message)})}date(e){return this._addCheck({kind:`date`,message:e})}time(e){return typeof e==`string`?this._addCheck({kind:`time`,precision:null,message:e}):this._addCheck({kind:`time`,precision:e?.precision===void 0?null:e?.precision,...B.errToObj(e?.message)})}duration(e){return this._addCheck({kind:`duration`,...B.errToObj(e)})}regex(e,t){return this._addCheck({kind:`regex`,regex:e,...B.errToObj(t)})}includes(e,t){return this._addCheck({kind:`includes`,value:e,position:t?.position,...B.errToObj(t?.message)})}startsWith(e,t){return this._addCheck({kind:`startsWith`,value:e,...B.errToObj(t)})}endsWith(e,t){return this._addCheck({kind:`endsWith`,value:e,...B.errToObj(t)})}min(e,t){return this._addCheck({kind:`min`,value:e,...B.errToObj(t)})}max(e,t){return this._addCheck({kind:`max`,value:e,...B.errToObj(t)})}length(e,t){return this._addCheck({kind:`length`,value:e,...B.errToObj(t)})}nonempty(e){return this.min(1,B.errToObj(e))}trim(){return new e({...this._def,checks:[...this._def.checks,{kind:`trim`}]})}toLowerCase(){return new e({...this._def,checks:[...this._def.checks,{kind:`toLowerCase`}]})}toUpperCase(){return new e({...this._def,checks:[...this._def.checks,{kind:`toUpperCase`}]})}get isDatetime(){return!!this._def.checks.find(e=>e.kind===`datetime`)}get isDate(){return!!this._def.checks.find(e=>e.kind===`date`)}get isTime(){return!!this._def.checks.find(e=>e.kind===`time`)}get isDuration(){return!!this._def.checks.find(e=>e.kind===`duration`)}get isEmail(){return!!this._def.checks.find(e=>e.kind===`email`)}get isURL(){return!!this._def.checks.find(e=>e.kind===`url`)}get isEmoji(){return!!this._def.checks.find(e=>e.kind===`emoji`)}get isUUID(){return!!this._def.checks.find(e=>e.kind===`uuid`)}get isNANOID(){return!!this._def.checks.find(e=>e.kind===`nanoid`)}get isCUID(){return!!this._def.checks.find(e=>e.kind===`cuid`)}get isCUID2(){return!!this._def.checks.find(e=>e.kind===`cuid2`)}get isULID(){return!!this._def.checks.find(e=>e.kind===`ulid`)}get isIP(){return!!this._def.checks.find(e=>e.kind===`ip`)}get isBase64(){return!!this._def.checks.find(e=>e.kind===`base64`)}get minLength(){let e=null;for(let t of this._def.checks)t.kind===`min`&&(e===null||t.value>e)&&(e=t.value);return e}get maxLength(){let e=null;for(let t of this._def.checks)t.kind===`max`&&(e===null||t.value<e)&&(e=t.value);return e}};Wl.create=e=>new Wl({checks:[],typeName:U.ZodString,coerce:e?.coerce??!1,...V(e)});function Gl(e,t){let n=(e.toString().split(`.`)[1]||``).length,r=(t.toString().split(`.`)[1]||``).length,i=n>r?n:r;return parseInt(e.toFixed(i).replace(`.`,``))%parseInt(t.toFixed(i).replace(`.`,``))/10**i}var Kl=class e extends H{constructor(){super(...arguments),this.min=this.gte,this.max=this.lte,this.step=this.multipleOf}_parse(e){if(this._def.coerce&&(e.data=Number(e.data)),this._getType(e)!==I.number){let t=this._getOrReturnCtx(e);return R(t,{code:L.invalid_type,expected:I.number,received:t.parsedType}),z}let t,n=new pl;for(let r of this._def.checks)r.kind===`int`?F.isInteger(e.data)||(t=this._getOrReturnCtx(e,t),R(t,{code:L.invalid_type,expected:`integer`,received:`float`,message:r.message}),n.dirty()):r.kind===`min`?(r.inclusive?e.data<r.value:e.data<=r.value)&&(t=this._getOrReturnCtx(e,t),R(t,{code:L.too_small,minimum:r.value,type:`number`,inclusive:r.inclusive,exact:!1,message:r.message}),n.dirty()):r.kind===`max`?(r.inclusive?e.data>r.value:e.data>=r.value)&&(t=this._getOrReturnCtx(e,t),R(t,{code:L.too_big,maximum:r.value,type:`number`,inclusive:r.inclusive,exact:!1,message:r.message}),n.dirty()):r.kind===`multipleOf`?Gl(e.data,r.value)!==0&&(t=this._getOrReturnCtx(e,t),R(t,{code:L.not_multiple_of,multipleOf:r.value,message:r.message}),n.dirty()):r.kind===`finite`?Number.isFinite(e.data)||(t=this._getOrReturnCtx(e,t),R(t,{code:L.not_finite,message:r.message}),n.dirty()):F.assertNever(r);return{status:n.value,value:e.data}}gte(e,t){return this.setLimit(`min`,e,!0,B.toString(t))}gt(e,t){return this.setLimit(`min`,e,!1,B.toString(t))}lte(e,t){return this.setLimit(`max`,e,!0,B.toString(t))}lt(e,t){return this.setLimit(`max`,e,!1,B.toString(t))}setLimit(t,n,r,i){return new e({...this._def,checks:[...this._def.checks,{kind:t,value:n,inclusive:r,message:B.toString(i)}]})}_addCheck(t){return new e({...this._def,checks:[...this._def.checks,t]})}int(e){return this._addCheck({kind:`int`,message:B.toString(e)})}positive(e){return this._addCheck({kind:`min`,value:0,inclusive:!1,message:B.toString(e)})}negative(e){return this._addCheck({kind:`max`,value:0,inclusive:!1,message:B.toString(e)})}nonpositive(e){return this._addCheck({kind:`max`,value:0,inclusive:!0,message:B.toString(e)})}nonnegative(e){return this._addCheck({kind:`min`,value:0,inclusive:!0,message:B.toString(e)})}multipleOf(e,t){return this._addCheck({kind:`multipleOf`,value:e,message:B.toString(t)})}finite(e){return this._addCheck({kind:`finite`,message:B.toString(e)})}safe(e){return this._addCheck({kind:`min`,inclusive:!0,value:-(2**53-1),message:B.toString(e)})._addCheck({kind:`max`,inclusive:!0,value:2**53-1,message:B.toString(e)})}get minValue(){let e=null;for(let t of this._def.checks)t.kind===`min`&&(e===null||t.value>e)&&(e=t.value);return e}get maxValue(){let e=null;for(let t of this._def.checks)t.kind===`max`&&(e===null||t.value<e)&&(e=t.value);return e}get isInt(){return!!this._def.checks.find(e=>e.kind===`int`||e.kind===`multipleOf`&&F.isInteger(e.value))}get isFinite(){let e=null,t=null;for(let n of this._def.checks)if(n.kind===`finite`||n.kind===`int`||n.kind===`multipleOf`)return!0;else n.kind===`min`?(t===null||n.value>t)&&(t=n.value):n.kind===`max`&&(e===null||n.value<e)&&(e=n.value);return Number.isFinite(t)&&Number.isFinite(e)}};Kl.create=e=>new Kl({checks:[],typeName:U.ZodNumber,coerce:e?.coerce||!1,...V(e)});var ql=class e extends H{constructor(){super(...arguments),this.min=this.gte,this.max=this.lte}_parse(e){if(this._def.coerce&&(e.data=BigInt(e.data)),this._getType(e)!==I.bigint){let t=this._getOrReturnCtx(e);return R(t,{code:L.invalid_type,expected:I.bigint,received:t.parsedType}),z}let t,n=new pl;for(let r of this._def.checks)r.kind===`min`?(r.inclusive?e.data<r.value:e.data<=r.value)&&(t=this._getOrReturnCtx(e,t),R(t,{code:L.too_small,type:`bigint`,minimum:r.value,inclusive:r.inclusive,message:r.message}),n.dirty()):r.kind===`max`?(r.inclusive?e.data>r.value:e.data>=r.value)&&(t=this._getOrReturnCtx(e,t),R(t,{code:L.too_big,type:`bigint`,maximum:r.value,inclusive:r.inclusive,message:r.message}),n.dirty()):r.kind===`multipleOf`?e.data%r.value!==BigInt(0)&&(t=this._getOrReturnCtx(e,t),R(t,{code:L.not_multiple_of,multipleOf:r.value,message:r.message}),n.dirty()):F.assertNever(r);return{status:n.value,value:e.data}}gte(e,t){return this.setLimit(`min`,e,!0,B.toString(t))}gt(e,t){return this.setLimit(`min`,e,!1,B.toString(t))}lte(e,t){return this.setLimit(`max`,e,!0,B.toString(t))}lt(e,t){return this.setLimit(`max`,e,!1,B.toString(t))}setLimit(t,n,r,i){return new e({...this._def,checks:[...this._def.checks,{kind:t,value:n,inclusive:r,message:B.toString(i)}]})}_addCheck(t){return new e({...this._def,checks:[...this._def.checks,t]})}positive(e){return this._addCheck({kind:`min`,value:BigInt(0),inclusive:!1,message:B.toString(e)})}negative(e){return this._addCheck({kind:`max`,value:BigInt(0),inclusive:!1,message:B.toString(e)})}nonpositive(e){return this._addCheck({kind:`max`,value:BigInt(0),inclusive:!0,message:B.toString(e)})}nonnegative(e){return this._addCheck({kind:`min`,value:BigInt(0),inclusive:!0,message:B.toString(e)})}multipleOf(e,t){return this._addCheck({kind:`multipleOf`,value:e,message:B.toString(t)})}get minValue(){let e=null;for(let t of this._def.checks)t.kind===`min`&&(e===null||t.value>e)&&(e=t.value);return e}get maxValue(){let e=null;for(let t of this._def.checks)t.kind===`max`&&(e===null||t.value<e)&&(e=t.value);return e}};ql.create=e=>new ql({checks:[],typeName:U.ZodBigInt,coerce:e?.coerce??!1,...V(e)});var Jl=class extends H{_parse(e){if(this._def.coerce&&(e.data=!!e.data),this._getType(e)!==I.boolean){let t=this._getOrReturnCtx(e);return R(t,{code:L.invalid_type,expected:I.boolean,received:t.parsedType}),z}return hl(e.data)}};Jl.create=e=>new Jl({typeName:U.ZodBoolean,coerce:e?.coerce||!1,...V(e)});var Yl=class e extends H{_parse(e){if(this._def.coerce&&(e.data=new Date(e.data)),this._getType(e)!==I.date){let t=this._getOrReturnCtx(e);return R(t,{code:L.invalid_type,expected:I.date,received:t.parsedType}),z}if(isNaN(e.data.getTime()))return R(this._getOrReturnCtx(e),{code:L.invalid_date}),z;let t=new pl,n;for(let r of this._def.checks)r.kind===`min`?e.data.getTime()<r.value&&(n=this._getOrReturnCtx(e,n),R(n,{code:L.too_small,message:r.message,inclusive:!0,exact:!1,minimum:r.value,type:`date`}),t.dirty()):r.kind===`max`?e.data.getTime()>r.value&&(n=this._getOrReturnCtx(e,n),R(n,{code:L.too_big,message:r.message,inclusive:!0,exact:!1,maximum:r.value,type:`date`}),t.dirty()):F.assertNever(r);return{status:t.value,value:new Date(e.data.getTime())}}_addCheck(t){return new e({...this._def,checks:[...this._def.checks,t]})}min(e,t){return this._addCheck({kind:`min`,value:e.getTime(),message:B.toString(t)})}max(e,t){return this._addCheck({kind:`max`,value:e.getTime(),message:B.toString(t)})}get minDate(){let e=null;for(let t of this._def.checks)t.kind===`min`&&(e===null||t.value>e)&&(e=t.value);return e==null?null:new Date(e)}get maxDate(){let e=null;for(let t of this._def.checks)t.kind===`max`&&(e===null||t.value<e)&&(e=t.value);return e==null?null:new Date(e)}};Yl.create=e=>new Yl({checks:[],coerce:e?.coerce||!1,typeName:U.ZodDate,...V(e)});var Xl=class extends H{_parse(e){if(this._getType(e)!==I.symbol){let t=this._getOrReturnCtx(e);return R(t,{code:L.invalid_type,expected:I.symbol,received:t.parsedType}),z}return hl(e.data)}};Xl.create=e=>new Xl({typeName:U.ZodSymbol,...V(e)});var Zl=class extends H{_parse(e){if(this._getType(e)!==I.undefined){let t=this._getOrReturnCtx(e);return R(t,{code:L.invalid_type,expected:I.undefined,received:t.parsedType}),z}return hl(e.data)}};Zl.create=e=>new Zl({typeName:U.ZodUndefined,...V(e)});var Ql=class extends H{_parse(e){if(this._getType(e)!==I.null){let t=this._getOrReturnCtx(e);return R(t,{code:L.invalid_type,expected:I.null,received:t.parsedType}),z}return hl(e.data)}};Ql.create=e=>new Ql({typeName:U.ZodNull,...V(e)});var $l=class extends H{constructor(){super(...arguments),this._any=!0}_parse(e){return hl(e.data)}};$l.create=e=>new $l({typeName:U.ZodAny,...V(e)});var eu=class extends H{constructor(){super(...arguments),this._unknown=!0}_parse(e){return hl(e.data)}};eu.create=e=>new eu({typeName:U.ZodUnknown,...V(e)});var tu=class extends H{_parse(e){let t=this._getOrReturnCtx(e);return R(t,{code:L.invalid_type,expected:I.never,received:t.parsedType}),z}};tu.create=e=>new tu({typeName:U.ZodNever,...V(e)});var nu=class extends H{_parse(e){if(this._getType(e)!==I.undefined){let t=this._getOrReturnCtx(e);return R(t,{code:L.invalid_type,expected:I.void,received:t.parsedType}),z}return hl(e.data)}};nu.create=e=>new nu({typeName:U.ZodVoid,...V(e)});var ru=class e extends H{_parse(e){let{ctx:t,status:n}=this._processInputParams(e),r=this._def;if(t.parsedType!==I.array)return R(t,{code:L.invalid_type,expected:I.array,received:t.parsedType}),z;if(r.exactLength!==null){let e=t.data.length>r.exactLength.value,i=t.data.length<r.exactLength.value;(e||i)&&(R(t,{code:e?L.too_big:L.too_small,minimum:i?r.exactLength.value:void 0,maximum:e?r.exactLength.value:void 0,type:`array`,inclusive:!0,exact:!0,message:r.exactLength.message}),n.dirty())}if(r.minLength!==null&&t.data.length<r.minLength.value&&(R(t,{code:L.too_small,minimum:r.minLength.value,type:`array`,inclusive:!0,exact:!1,message:r.minLength.message}),n.dirty()),r.maxLength!==null&&t.data.length>r.maxLength.value&&(R(t,{code:L.too_big,maximum:r.maxLength.value,type:`array`,inclusive:!0,exact:!1,message:r.maxLength.message}),n.dirty()),t.common.async)return Promise.all([...t.data].map((e,n)=>r.type._parseAsync(new wl(t,e,t.path,n)))).then(e=>pl.mergeArray(n,e));let i=[...t.data].map((e,n)=>r.type._parseSync(new wl(t,e,t.path,n)));return pl.mergeArray(n,i)}get element(){return this._def.type}min(t,n){return new e({...this._def,minLength:{value:t,message:B.toString(n)}})}max(t,n){return new e({...this._def,maxLength:{value:t,message:B.toString(n)}})}length(t,n){return new e({...this._def,exactLength:{value:t,message:B.toString(n)}})}nonempty(e){return this.min(1,e)}};ru.create=(e,t)=>new ru({type:e,minLength:null,maxLength:null,exactLength:null,typeName:U.ZodArray,...V(t)});function iu(e){if(e instanceof au){let t={};for(let n in e.shape){let r=e.shape[n];t[n]=Cu.create(iu(r))}return new au({...e._def,shape:()=>t})}else if(e instanceof ru)return new ru({...e._def,type:iu(e.element)});else if(e instanceof Cu)return Cu.create(iu(e.unwrap()));else if(e instanceof wu)return wu.create(iu(e.unwrap()));else if(e instanceof du)return du.create(e.items.map(e=>iu(e)));else return e}var au=class e extends H{constructor(){super(...arguments),this._cached=null,this.nonstrict=this.passthrough,this.augment=this.extend}_getCached(){if(this._cached!==null)return this._cached;let e=this._def.shape(),t=F.objectKeys(e);return this._cached={shape:e,keys:t}}_parse(e){if(this._getType(e)!==I.object){let t=this._getOrReturnCtx(e);return R(t,{code:L.invalid_type,expected:I.object,received:t.parsedType}),z}let{status:t,ctx:n}=this._processInputParams(e),{shape:r,keys:i}=this._getCached(),a=[];if(!(this._def.catchall instanceof tu&&this._def.unknownKeys===`strip`))for(let e in n.data)i.includes(e)||a.push(e);let o=[];for(let e of i){let t=r[e],i=n.data[e];o.push({key:{status:`valid`,value:e},value:t._parse(new wl(n,i,n.path,e)),alwaysSet:e in n.data})}if(this._def.catchall instanceof tu){let e=this._def.unknownKeys;if(e===`passthrough`)for(let e of a)o.push({key:{status:`valid`,value:e},value:{status:`valid`,value:n.data[e]}});else if(e===`strict`)a.length>0&&(R(n,{code:L.unrecognized_keys,keys:a}),t.dirty());else if(e!==`strip`)throw Error(`Internal ZodObject error: invalid unknownKeys value.`)}else{let e=this._def.catchall;for(let t of a){let r=n.data[t];o.push({key:{status:`valid`,value:t},value:e._parse(new wl(n,r,n.path,t)),alwaysSet:t in n.data})}}return n.common.async?Promise.resolve().then(async()=>{let e=[];for(let t of o){let n=await t.key,r=await t.value;e.push({key:n,value:r,alwaysSet:t.alwaysSet})}return e}).then(e=>pl.mergeObjectSync(t,e)):pl.mergeObjectSync(t,o)}get shape(){return this._def.shape()}strict(t){return B.errToObj,new e({...this._def,unknownKeys:`strict`,...t===void 0?{}:{errorMap:(e,n)=>{var r;let i=(r=this._def).errorMap?.call(r,e,n).message??n.defaultError;return e.code===`unrecognized_keys`?{message:B.errToObj(t).message??i}:{message:i}}}})}strip(){return new e({...this._def,unknownKeys:`strip`})}passthrough(){return new e({...this._def,unknownKeys:`passthrough`})}extend(t){return new e({...this._def,shape:()=>({...this._def.shape(),...t})})}merge(t){return new e({unknownKeys:t._def.unknownKeys,catchall:t._def.catchall,shape:()=>({...this._def.shape(),...t._def.shape()}),typeName:U.ZodObject})}setKey(e,t){return this.augment({[e]:t})}catchall(t){return new e({...this._def,catchall:t})}pick(t){let n={};return F.objectKeys(t).forEach(e=>{t[e]&&this.shape[e]&&(n[e]=this.shape[e])}),new e({...this._def,shape:()=>n})}omit(t){let n={};return F.objectKeys(this.shape).forEach(e=>{t[e]||(n[e]=this.shape[e])}),new e({...this._def,shape:()=>n})}deepPartial(){return iu(this)}partial(t){let n={};return F.objectKeys(this.shape).forEach(e=>{let r=this.shape[e];t&&!t[e]?n[e]=r:n[e]=r.optional()}),new e({...this._def,shape:()=>n})}required(t){let n={};return F.objectKeys(this.shape).forEach(e=>{if(t&&!t[e])n[e]=this.shape[e];else{let t=this.shape[e];for(;t instanceof Cu;)t=t._def.innerType;n[e]=t}}),new e({...this._def,shape:()=>n})}keyof(){return vu(F.objectKeys(this.shape))}};au.create=(e,t)=>new au({shape:()=>e,unknownKeys:`strip`,catchall:tu.create(),typeName:U.ZodObject,...V(t)}),au.strictCreate=(e,t)=>new au({shape:()=>e,unknownKeys:`strict`,catchall:tu.create(),typeName:U.ZodObject,...V(t)}),au.lazycreate=(e,t)=>new au({shape:e,unknownKeys:`strip`,catchall:tu.create(),typeName:U.ZodObject,...V(t)});var ou=class extends H{_parse(e){let{ctx:t}=this._processInputParams(e),n=this._def.options;function r(e){for(let t of e)if(t.result.status===`valid`)return t.result;for(let n of e)if(n.result.status===`dirty`)return t.common.issues.push(...n.ctx.common.issues),n.result;let n=e.map(e=>new ol(e.ctx.common.issues));return R(t,{code:L.invalid_union,unionErrors:n}),z}if(t.common.async)return Promise.all(n.map(async e=>{let n={...t,common:{...t.common,issues:[]},parent:null};return{result:await e._parseAsync({data:t.data,path:t.path,parent:n}),ctx:n}})).then(r);{let e,r=[];for(let i of n){let n={...t,common:{...t.common,issues:[]},parent:null},a=i._parseSync({data:t.data,path:t.path,parent:n});if(a.status===`valid`)return a;a.status===`dirty`&&!e&&(e={result:a,ctx:n}),n.common.issues.length&&r.push(n.common.issues)}if(e)return t.common.issues.push(...e.ctx.common.issues),e.result;let i=r.map(e=>new ol(e));return R(t,{code:L.invalid_union,unionErrors:i}),z}}get options(){return this._def.options}};ou.create=(e,t)=>new ou({options:e,typeName:U.ZodUnion,...V(t)});var su=e=>e instanceof gu?su(e.schema):e instanceof Su?su(e.innerType()):e instanceof _u?[e.value]:e instanceof yu?e.options:e instanceof bu?F.objectValues(e.enum):e instanceof Tu?su(e._def.innerType):e instanceof Zl?[void 0]:e instanceof Ql?[null]:e instanceof Cu?[void 0,...su(e.unwrap())]:e instanceof wu?[null,...su(e.unwrap())]:e instanceof ku||e instanceof ju?su(e.unwrap()):e instanceof Eu?su(e._def.innerType):[],cu=class e extends H{_parse(e){let{ctx:t}=this._processInputParams(e);if(t.parsedType!==I.object)return R(t,{code:L.invalid_type,expected:I.object,received:t.parsedType}),z;let n=this.discriminator,r=t.data[n],i=this.optionsMap.get(r);return i?t.common.async?i._parseAsync({data:t.data,path:t.path,parent:t}):i._parseSync({data:t.data,path:t.path,parent:t}):(R(t,{code:L.invalid_union_discriminator,options:Array.from(this.optionsMap.keys()),path:[n]}),z)}get discriminator(){return this._def.discriminator}get options(){return this._def.options}get optionsMap(){return this._def.optionsMap}static create(t,n,r){let i=new Map;for(let e of n){let n=su(e.shape[t]);if(!n.length)throw Error(`A discriminator value for key \`${t}\` could not be extracted from all schema options`);for(let r of n){if(i.has(r))throw Error(`Discriminator property ${String(t)} has duplicate value ${String(r)}`);i.set(r,e)}}return new e({typeName:U.ZodDiscriminatedUnion,discriminator:t,options:n,optionsMap:i,...V(r)})}};function lu(e,t){let n=il(e),r=il(t);if(e===t)return{valid:!0,data:e};if(n===I.object&&r===I.object){let n=F.objectKeys(t),r=F.objectKeys(e).filter(e=>n.indexOf(e)!==-1),i={...e,...t};for(let n of r){let r=lu(e[n],t[n]);if(!r.valid)return{valid:!1};i[n]=r.data}return{valid:!0,data:i}}else if(n===I.array&&r===I.array){if(e.length!==t.length)return{valid:!1};let n=[];for(let r=0;r<e.length;r++){let i=e[r],a=t[r],o=lu(i,a);if(!o.valid)return{valid:!1};n.push(o.data)}return{valid:!0,data:n}}else if(n===I.date&&r===I.date&&+e==+t)return{valid:!0,data:e};else return{valid:!1}}var uu=class extends H{_parse(e){let{status:t,ctx:n}=this._processInputParams(e),r=(e,r)=>{if(gl(e)||gl(r))return z;let i=lu(e.value,r.value);return i.valid?((_l(e)||_l(r))&&t.dirty(),{status:t.value,value:i.data}):(R(n,{code:L.invalid_intersection_types}),z)};return n.common.async?Promise.all([this._def.left._parseAsync({data:n.data,path:n.path,parent:n}),this._def.right._parseAsync({data:n.data,path:n.path,parent:n})]).then(([e,t])=>r(e,t)):r(this._def.left._parseSync({data:n.data,path:n.path,parent:n}),this._def.right._parseSync({data:n.data,path:n.path,parent:n}))}};uu.create=(e,t,n)=>new uu({left:e,right:t,typeName:U.ZodIntersection,...V(n)});var du=class e extends H{_parse(e){let{status:t,ctx:n}=this._processInputParams(e);if(n.parsedType!==I.array)return R(n,{code:L.invalid_type,expected:I.array,received:n.parsedType}),z;if(n.data.length<this._def.items.length)return R(n,{code:L.too_small,minimum:this._def.items.length,inclusive:!0,exact:!1,type:`array`}),z;!this._def.rest&&n.data.length>this._def.items.length&&(R(n,{code:L.too_big,maximum:this._def.items.length,inclusive:!0,exact:!1,type:`array`}),t.dirty());let r=[...n.data].map((e,t)=>{let r=this._def.items[t]||this._def.rest;return r?r._parse(new wl(n,e,n.path,t)):null}).filter(e=>!!e);return n.common.async?Promise.all(r).then(e=>pl.mergeArray(t,e)):pl.mergeArray(t,r)}get items(){return this._def.items}rest(t){return new e({...this._def,rest:t})}};du.create=(e,t)=>{if(!Array.isArray(e))throw Error(`You must pass an array of schemas to z.tuple([ ... ])`);return new du({items:e,typeName:U.ZodTuple,rest:null,...V(t)})};var fu=class e extends H{get keySchema(){return this._def.keyType}get valueSchema(){return this._def.valueType}_parse(e){let{status:t,ctx:n}=this._processInputParams(e);if(n.parsedType!==I.object)return R(n,{code:L.invalid_type,expected:I.object,received:n.parsedType}),z;let r=[],i=this._def.keyType,a=this._def.valueType;for(let e in n.data)r.push({key:i._parse(new wl(n,e,n.path,e)),value:a._parse(new wl(n,n.data[e],n.path,e)),alwaysSet:e in n.data});return n.common.async?pl.mergeObjectAsync(t,r):pl.mergeObjectSync(t,r)}get element(){return this._def.valueType}static create(t,n,r){return n instanceof H?new e({keyType:t,valueType:n,typeName:U.ZodRecord,...V(r)}):new e({keyType:Wl.create(),valueType:t,typeName:U.ZodRecord,...V(n)})}},pu=class extends H{get keySchema(){return this._def.keyType}get valueSchema(){return this._def.valueType}_parse(e){let{status:t,ctx:n}=this._processInputParams(e);if(n.parsedType!==I.map)return R(n,{code:L.invalid_type,expected:I.map,received:n.parsedType}),z;let r=this._def.keyType,i=this._def.valueType,a=[...n.data.entries()].map(([e,t],a)=>({key:r._parse(new wl(n,e,n.path,[a,`key`])),value:i._parse(new wl(n,t,n.path,[a,`value`]))}));if(n.common.async){let e=new Map;return Promise.resolve().then(async()=>{for(let n of a){let r=await n.key,i=await n.value;if(r.status===`aborted`||i.status===`aborted`)return z;(r.status===`dirty`||i.status===`dirty`)&&t.dirty(),e.set(r.value,i.value)}return{status:t.value,value:e}})}else{let e=new Map;for(let n of a){let r=n.key,i=n.value;if(r.status===`aborted`||i.status===`aborted`)return z;(r.status===`dirty`||i.status===`dirty`)&&t.dirty(),e.set(r.value,i.value)}return{status:t.value,value:e}}}};pu.create=(e,t,n)=>new pu({valueType:t,keyType:e,typeName:U.ZodMap,...V(n)});var mu=class e extends H{_parse(e){let{status:t,ctx:n}=this._processInputParams(e);if(n.parsedType!==I.set)return R(n,{code:L.invalid_type,expected:I.set,received:n.parsedType}),z;let r=this._def;r.minSize!==null&&n.data.size<r.minSize.value&&(R(n,{code:L.too_small,minimum:r.minSize.value,type:`set`,inclusive:!0,exact:!1,message:r.minSize.message}),t.dirty()),r.maxSize!==null&&n.data.size>r.maxSize.value&&(R(n,{code:L.too_big,maximum:r.maxSize.value,type:`set`,inclusive:!0,exact:!1,message:r.maxSize.message}),t.dirty());let i=this._def.valueType;function a(e){let n=new Set;for(let r of e){if(r.status===`aborted`)return z;r.status===`dirty`&&t.dirty(),n.add(r.value)}return{status:t.value,value:n}}let o=[...n.data.values()].map((e,t)=>i._parse(new wl(n,e,n.path,t)));return n.common.async?Promise.all(o).then(e=>a(e)):a(o)}min(t,n){return new e({...this._def,minSize:{value:t,message:B.toString(n)}})}max(t,n){return new e({...this._def,maxSize:{value:t,message:B.toString(n)}})}size(e,t){return this.min(e,t).max(e,t)}nonempty(e){return this.min(1,e)}};mu.create=(e,t)=>new mu({valueType:e,minSize:null,maxSize:null,typeName:U.ZodSet,...V(t)});var hu=class e extends H{constructor(){super(...arguments),this.validate=this.implement}_parse(e){let{ctx:t}=this._processInputParams(e);if(t.parsedType!==I.function)return R(t,{code:L.invalid_type,expected:I.function,received:t.parsedType}),z;function n(e,n){return dl({data:e,path:t.path,errorMaps:[t.common.contextualErrorMap,t.schemaErrorMap,ul(),sl].filter(e=>!!e),issueData:{code:L.invalid_arguments,argumentsError:n}})}function r(e,n){return dl({data:e,path:t.path,errorMaps:[t.common.contextualErrorMap,t.schemaErrorMap,ul(),sl].filter(e=>!!e),issueData:{code:L.invalid_return_type,returnTypeError:n}})}let i={errorMap:t.common.contextualErrorMap},a=t.data;if(this._def.returns instanceof xu){let e=this;return hl(async function(...t){let o=new ol([]),s=await e._def.args.parseAsync(t,i).catch(e=>{throw o.addIssue(n(t,e)),o}),c=await Reflect.apply(a,this,s);return await e._def.returns._def.type.parseAsync(c,i).catch(e=>{throw o.addIssue(r(c,e)),o})})}else{let e=this;return hl(function(...t){let o=e._def.args.safeParse(t,i);if(!o.success)throw new ol([n(t,o.error)]);let s=Reflect.apply(a,this,o.data),c=e._def.returns.safeParse(s,i);if(!c.success)throw new ol([r(s,c.error)]);return c.data})}}parameters(){return this._def.args}returnType(){return this._def.returns}args(...t){return new e({...this._def,args:du.create(t).rest(eu.create())})}returns(t){return new e({...this._def,returns:t})}implement(e){return this.parse(e)}strictImplement(e){return this.parse(e)}static create(t,n,r){return new e({args:t||du.create([]).rest(eu.create()),returns:n||eu.create(),typeName:U.ZodFunction,...V(r)})}},gu=class extends H{get schema(){return this._def.getter()}_parse(e){let{ctx:t}=this._processInputParams(e);return this._def.getter()._parse({data:t.data,path:t.path,parent:t})}};gu.create=(e,t)=>new gu({getter:e,typeName:U.ZodLazy,...V(t)});var _u=class extends H{_parse(e){if(e.data!==this._def.value){let t=this._getOrReturnCtx(e);return R(t,{received:t.data,code:L.invalid_literal,expected:this._def.value}),z}return{status:`valid`,value:e.data}}get value(){return this._def.value}};_u.create=(e,t)=>new _u({value:e,typeName:U.ZodLiteral,...V(t)});function vu(e,t){return new yu({values:e,typeName:U.ZodEnum,...V(t)})}var yu=class e extends H{constructor(){super(...arguments),Sl.set(this,void 0)}_parse(e){if(typeof e.data!=`string`){let t=this._getOrReturnCtx(e),n=this._def.values;return R(t,{expected:F.joinValues(n),received:t.parsedType,code:L.invalid_type}),z}if(bl(this,Sl)||xl(this,Sl,new Set(this._def.values)),!bl(this,Sl).has(e.data)){let t=this._getOrReturnCtx(e),n=this._def.values;return R(t,{received:t.data,code:L.invalid_enum_value,options:n}),z}return hl(e.data)}get options(){return this._def.values}get enum(){let e={};for(let t of this._def.values)e[t]=t;return e}get Values(){let e={};for(let t of this._def.values)e[t]=t;return e}get Enum(){let e={};for(let t of this._def.values)e[t]=t;return e}extract(t,n=this._def){return e.create(t,{...this._def,...n})}exclude(t,n=this._def){return e.create(this.options.filter(e=>!t.includes(e)),{...this._def,...n})}};Sl=new WeakMap,yu.create=vu;var bu=class extends H{constructor(){super(...arguments),Cl.set(this,void 0)}_parse(e){let t=F.getValidEnumValues(this._def.values),n=this._getOrReturnCtx(e);if(n.parsedType!==I.string&&n.parsedType!==I.number){let e=F.objectValues(t);return R(n,{expected:F.joinValues(e),received:n.parsedType,code:L.invalid_type}),z}if(bl(this,Cl)||xl(this,Cl,new Set(F.getValidEnumValues(this._def.values))),!bl(this,Cl).has(e.data)){let e=F.objectValues(t);return R(n,{received:n.data,code:L.invalid_enum_value,options:e}),z}return hl(e.data)}get enum(){return this._def.values}};Cl=new WeakMap,bu.create=(e,t)=>new bu({values:e,typeName:U.ZodNativeEnum,...V(t)});var xu=class extends H{unwrap(){return this._def.type}_parse(e){let{ctx:t}=this._processInputParams(e);return t.parsedType!==I.promise&&t.common.async===!1?(R(t,{code:L.invalid_type,expected:I.promise,received:t.parsedType}),z):hl((t.parsedType===I.promise?t.data:Promise.resolve(t.data)).then(e=>this._def.type.parseAsync(e,{path:t.path,errorMap:t.common.contextualErrorMap})))}};xu.create=(e,t)=>new xu({type:e,typeName:U.ZodPromise,...V(t)});var Su=class extends H{innerType(){return this._def.schema}sourceType(){return this._def.schema._def.typeName===U.ZodEffects?this._def.schema.sourceType():this._def.schema}_parse(e){let{status:t,ctx:n}=this._processInputParams(e),r=this._def.effect||null,i={addIssue:e=>{R(n,e),e.fatal?t.abort():t.dirty()},get path(){return n.path}};if(i.addIssue=i.addIssue.bind(i),r.type===`preprocess`){let e=r.transform(n.data,i);if(n.common.async)return Promise.resolve(e).then(async e=>{if(t.value===`aborted`)return z;let r=await this._def.schema._parseAsync({data:e,path:n.path,parent:n});return r.status===`aborted`?z:r.status===`dirty`||t.value===`dirty`?ml(r.value):r});{if(t.value===`aborted`)return z;let r=this._def.schema._parseSync({data:e,path:n.path,parent:n});return r.status===`aborted`?z:r.status===`dirty`||t.value===`dirty`?ml(r.value):r}}if(r.type===`refinement`){let e=e=>{let t=r.refinement(e,i);if(n.common.async)return Promise.resolve(t);if(t instanceof Promise)throw Error(`Async refinement encountered during synchronous parse operation. Use .parseAsync instead.`);return e};if(n.common.async===!1){let r=this._def.schema._parseSync({data:n.data,path:n.path,parent:n});return r.status===`aborted`?z:(r.status===`dirty`&&t.dirty(),e(r.value),{status:t.value,value:r.value})}else return this._def.schema._parseAsync({data:n.data,path:n.path,parent:n}).then(n=>n.status===`aborted`?z:(n.status===`dirty`&&t.dirty(),e(n.value).then(()=>({status:t.value,value:n.value}))))}if(r.type===`transform`)if(n.common.async===!1){let e=this._def.schema._parseSync({data:n.data,path:n.path,parent:n});if(!vl(e))return e;let a=r.transform(e.value,i);if(a instanceof Promise)throw Error(`Asynchronous transform encountered during synchronous parse operation. Use .parseAsync instead.`);return{status:t.value,value:a}}else return this._def.schema._parseAsync({data:n.data,path:n.path,parent:n}).then(e=>vl(e)?Promise.resolve(r.transform(e.value,i)).then(e=>({status:t.value,value:e})):e);F.assertNever(r)}};Su.create=(e,t,n)=>new Su({schema:e,typeName:U.ZodEffects,effect:t,...V(n)}),Su.createWithPreprocess=(e,t,n)=>new Su({schema:t,effect:{type:`preprocess`,transform:e},typeName:U.ZodEffects,...V(n)});var Cu=class extends H{_parse(e){return this._getType(e)===I.undefined?hl(void 0):this._def.innerType._parse(e)}unwrap(){return this._def.innerType}};Cu.create=(e,t)=>new Cu({innerType:e,typeName:U.ZodOptional,...V(t)});var wu=class extends H{_parse(e){return this._getType(e)===I.null?hl(null):this._def.innerType._parse(e)}unwrap(){return this._def.innerType}};wu.create=(e,t)=>new wu({innerType:e,typeName:U.ZodNullable,...V(t)});var Tu=class extends H{_parse(e){let{ctx:t}=this._processInputParams(e),n=t.data;return t.parsedType===I.undefined&&(n=this._def.defaultValue()),this._def.innerType._parse({data:n,path:t.path,parent:t})}removeDefault(){return this._def.innerType}};Tu.create=(e,t)=>new Tu({innerType:e,typeName:U.ZodDefault,defaultValue:typeof t.default==`function`?t.default:()=>t.default,...V(t)});var Eu=class extends H{_parse(e){let{ctx:t}=this._processInputParams(e),n={...t,common:{...t.common,issues:[]}},r=this._def.innerType._parse({data:n.data,path:n.path,parent:{...n}});return yl(r)?r.then(e=>({status:`valid`,value:e.status===`valid`?e.value:this._def.catchValue({get error(){return new ol(n.common.issues)},input:n.data})})):{status:`valid`,value:r.status===`valid`?r.value:this._def.catchValue({get error(){return new ol(n.common.issues)},input:n.data})}}removeCatch(){return this._def.innerType}};Eu.create=(e,t)=>new Eu({innerType:e,typeName:U.ZodCatch,catchValue:typeof t.catch==`function`?t.catch:()=>t.catch,...V(t)});var Du=class extends H{_parse(e){if(this._getType(e)!==I.nan){let t=this._getOrReturnCtx(e);return R(t,{code:L.invalid_type,expected:I.nan,received:t.parsedType}),z}return{status:`valid`,value:e.data}}};Du.create=e=>new Du({typeName:U.ZodNaN,...V(e)});var Ou=Symbol(`zod_brand`),ku=class extends H{_parse(e){let{ctx:t}=this._processInputParams(e),n=t.data;return this._def.type._parse({data:n,path:t.path,parent:t})}unwrap(){return this._def.type}},Au=class e extends H{_parse(e){let{status:t,ctx:n}=this._processInputParams(e);if(n.common.async)return(async()=>{let e=await this._def.in._parseAsync({data:n.data,path:n.path,parent:n});return e.status===`aborted`?z:e.status===`dirty`?(t.dirty(),ml(e.value)):this._def.out._parseAsync({data:e.value,path:n.path,parent:n})})();{let e=this._def.in._parseSync({data:n.data,path:n.path,parent:n});return e.status===`aborted`?z:e.status===`dirty`?(t.dirty(),{status:`dirty`,value:e.value}):this._def.out._parseSync({data:e.value,path:n.path,parent:n})}}static create(t,n){return new e({in:t,out:n,typeName:U.ZodPipeline})}},ju=class extends H{_parse(e){let t=this._def.innerType._parse(e),n=e=>(vl(e)&&(e.value=Object.freeze(e.value)),e);return yl(t)?t.then(e=>n(e)):n(t)}unwrap(){return this._def.innerType}};ju.create=(e,t)=>new ju({innerType:e,typeName:U.ZodReadonly,...V(t)});function Mu(e,t={},n){return e?$l.create().superRefine((r,i)=>{if(!e(r)){let e=typeof t==`function`?t(r):typeof t==`string`?{message:t}:t,a=e.fatal??n??!0,o=typeof e==`string`?{message:e}:e;i.addIssue({code:`custom`,...o,fatal:a})}}):$l.create()}var Nu={object:au.lazycreate},U;(function(e){e.ZodString=`ZodString`,e.ZodNumber=`ZodNumber`,e.ZodNaN=`ZodNaN`,e.ZodBigInt=`ZodBigInt`,e.ZodBoolean=`ZodBoolean`,e.ZodDate=`ZodDate`,e.ZodSymbol=`ZodSymbol`,e.ZodUndefined=`ZodUndefined`,e.ZodNull=`ZodNull`,e.ZodAny=`ZodAny`,e.ZodUnknown=`ZodUnknown`,e.ZodNever=`ZodNever`,e.ZodVoid=`ZodVoid`,e.ZodArray=`ZodArray`,e.ZodObject=`ZodObject`,e.ZodUnion=`ZodUnion`,e.ZodDiscriminatedUnion=`ZodDiscriminatedUnion`,e.ZodIntersection=`ZodIntersection`,e.ZodTuple=`ZodTuple`,e.ZodRecord=`ZodRecord`,e.ZodMap=`ZodMap`,e.ZodSet=`ZodSet`,e.ZodFunction=`ZodFunction`,e.ZodLazy=`ZodLazy`,e.ZodLiteral=`ZodLiteral`,e.ZodEnum=`ZodEnum`,e.ZodEffects=`ZodEffects`,e.ZodNativeEnum=`ZodNativeEnum`,e.ZodOptional=`ZodOptional`,e.ZodNullable=`ZodNullable`,e.ZodDefault=`ZodDefault`,e.ZodCatch=`ZodCatch`,e.ZodPromise=`ZodPromise`,e.ZodBranded=`ZodBranded`,e.ZodPipeline=`ZodPipeline`,e.ZodReadonly=`ZodReadonly`})(U||={});var Pu=(e,t={message:`Input not instance of ${e.name}`})=>Mu(t=>t instanceof e,t),W=Wl.create,G=Kl.create,Fu=Du.create,Iu=ql.create,K=Jl.create,Lu=Yl.create,Ru=Xl.create,zu=Zl.create,Bu=Ql.create,Vu=$l.create,Hu=eu.create,Uu=tu.create,Wu=nu.create,q=ru.create,J=au.create,Gu=au.strictCreate,Ku=ou.create,qu=cu.create,Ju=uu.create,Yu=du.create,Xu=fu.create,Zu=pu.create,Qu=mu.create,$u=hu.create,ed=gu.create,td=_u.create,nd=yu.create,rd=bu.create,id=xu.create,ad=Su.create,od=Cu.create,sd=wu.create,cd=Su.createWithPreprocess,ld=Au.create,Y=Object.freeze({__proto__:null,defaultErrorMap:sl,setErrorMap:ll,getErrorMap:ul,makeIssue:dl,EMPTY_PATH:fl,addIssueToContext:R,ParseStatus:pl,INVALID:z,DIRTY:ml,OK:hl,isAborted:gl,isDirty:_l,isValid:vl,isAsync:yl,get util(){return F},get objectUtil(){return rl},ZodParsedType:I,getParsedType:il,ZodType:H,datetimeRegex:Hl,ZodString:Wl,ZodNumber:Kl,ZodBigInt:ql,ZodBoolean:Jl,ZodDate:Yl,ZodSymbol:Xl,ZodUndefined:Zl,ZodNull:Ql,ZodAny:$l,ZodUnknown:eu,ZodNever:tu,ZodVoid:nu,ZodArray:ru,ZodObject:au,ZodUnion:ou,ZodDiscriminatedUnion:cu,ZodIntersection:uu,ZodTuple:du,ZodRecord:fu,ZodMap:pu,ZodSet:mu,ZodFunction:hu,ZodLazy:gu,ZodLiteral:_u,ZodEnum:yu,ZodNativeEnum:bu,ZodPromise:xu,ZodEffects:Su,ZodTransformer:Su,ZodOptional:Cu,ZodNullable:wu,ZodDefault:Tu,ZodCatch:Eu,ZodNaN:Du,BRAND:Ou,ZodBranded:ku,ZodPipeline:Au,ZodReadonly:ju,custom:Mu,Schema:H,ZodSchema:H,late:Nu,get ZodFirstPartyTypeKind(){return U},coerce:{string:(e=>Wl.create({...e,coerce:!0})),number:(e=>Kl.create({...e,coerce:!0})),boolean:(e=>Jl.create({...e,coerce:!0})),bigint:(e=>ql.create({...e,coerce:!0})),date:(e=>Yl.create({...e,coerce:!0}))},any:Vu,array:q,bigint:Iu,boolean:K,date:Lu,discriminatedUnion:qu,effect:ad,enum:nd,function:$u,instanceof:Pu,intersection:Ju,lazy:ed,literal:td,map:Zu,nan:Fu,nativeEnum:rd,never:Uu,null:Bu,nullable:sd,number:G,object:J,oboolean:()=>K().optional(),onumber:()=>G().optional(),optional:od,ostring:()=>W().optional(),pipeline:ld,preprocess:cd,promise:id,record:Xu,set:Qu,strictObject:Gu,string:W,symbol:Ru,transformer:ad,tuple:Yu,undefined:zu,union:Ku,unknown:Hu,void:Wu,NEVER:z,ZodIssueCode:L,quotelessJson:al,ZodError:ol}),ud={exports:{}},dd;function fd(){return dd?ud.exports:(dd=1,(function(e){var t=(function(e){var n=1e7,r=9007199254740992,i=f(r),a=`0123456789abcdefghijklmnopqrstuvwxyz`,o=typeof BigInt==`function`;function s(e,t,n,r){return e===void 0?s[0]:t===void 0||+t==10&&!n?k(e):Ce(e,t,n,r)}function c(e,t){this.value=e,this.sign=t,this.isSmall=!1}c.prototype=Object.create(s.prototype);function l(e){this.value=e,this.sign=e<0,this.isSmall=!0}l.prototype=Object.create(s.prototype);function u(e){this.value=e}u.prototype=Object.create(s.prototype);function d(e){return-r<e&&e<r}function f(e){return e<1e7?[e]:e<0x5af3107a4000?[e%1e7,Math.floor(e/1e7)]:[e%1e7,Math.floor(e/1e7)%1e7,Math.floor(e/0x5af3107a4000)]}function p(e){m(e);var t=e.length;if(t<4&&ce(e,i)<0)switch(t){case 0:return 0;case 1:return e[0];case 2:return e[0]+e[1]*n;default:return e[0]+(e[1]+e[2]*n)*n}return e}function m(e){for(var t=e.length;e[--t]===0;);e.length=t+1}function h(e){for(var t=Array(e),n=-1;++n<e;)t[n]=0;return t}function g(e){return e>0?Math.floor(e):Math.ceil(e)}function _(e,t){var r=e.length,i=t.length,a=Array(r),o=0,s=n,c,l;for(l=0;l<i;l++)c=e[l]+t[l]+o,o=+(c>=s),a[l]=c-o*s;for(;l<r;)c=e[l]+o,o=+(c===s),a[l++]=c-o*s;return o>0&&a.push(o),a}function v(e,t){return e.length>=t.length?_(e,t):_(t,e)}function y(e,t){var r=e.length,i=Array(r),a=n,o,s;for(s=0;s<r;s++)o=e[s]-a+t,t=Math.floor(o/a),i[s]=o-t*a,t+=1;for(;t>0;)i[s++]=t%a,t=Math.floor(t/a);return i}c.prototype.add=function(e){var t=k(e);if(this.sign!==t.sign)return this.subtract(t.negate());var n=this.value,r=t.value;return t.isSmall?new c(y(n,Math.abs(r)),this.sign):new c(v(n,r),this.sign)},c.prototype.plus=c.prototype.add,l.prototype.add=function(e){var t=k(e),n=this.value;if(n<0!==t.sign)return this.subtract(t.negate());var r=t.value;if(t.isSmall){if(d(n+r))return new l(n+r);r=f(Math.abs(r))}return new c(y(r,Math.abs(n)),n<0)},l.prototype.plus=l.prototype.add,u.prototype.add=function(e){return new u(this.value+k(e).value)},u.prototype.plus=u.prototype.add;function b(e,t){var r=e.length,i=t.length,a=Array(r),o=0,s=n,c,l;for(c=0;c<i;c++)l=e[c]-o-t[c],l<0?(l+=s,o=1):o=0,a[c]=l;for(c=i;c<r;c++){if(l=e[c]-o,l<0)l+=s;else{a[c++]=l;break}a[c]=l}for(;c<r;c++)a[c]=e[c];return m(a),a}function x(e,t,n){var r;return ce(e,t)>=0?r=b(e,t):(r=b(t,e),n=!n),r=p(r),typeof r==`number`?(n&&(r=-r),new l(r)):new c(r,n)}function S(e,t,r){var i=e.length,a=Array(i),o=-t,s=n,u,d;for(u=0;u<i;u++)d=e[u]+o,o=Math.floor(d/s),d%=s,a[u]=d<0?d+s:d;return a=p(a),typeof a==`number`?(r&&(a=-a),new l(a)):new c(a,r)}c.prototype.subtract=function(e){var t=k(e);if(this.sign!==t.sign)return this.add(t.negate());var n=this.value,r=t.value;return t.isSmall?S(n,Math.abs(r),this.sign):x(n,r,this.sign)},c.prototype.minus=c.prototype.subtract,l.prototype.subtract=function(e){var t=k(e),n=this.value;if(n<0!==t.sign)return this.add(t.negate());var r=t.value;return t.isSmall?new l(n-r):S(r,Math.abs(n),n>=0)},l.prototype.minus=l.prototype.subtract,u.prototype.subtract=function(e){return new u(this.value-k(e).value)},u.prototype.minus=u.prototype.subtract,c.prototype.negate=function(){return new c(this.value,!this.sign)},l.prototype.negate=function(){var e=this.sign,t=new l(-this.value);return t.sign=!e,t},u.prototype.negate=function(){return new u(-this.value)},c.prototype.abs=function(){return new c(this.value,!1)},l.prototype.abs=function(){return new l(Math.abs(this.value))},u.prototype.abs=function(){return new u(this.value>=0?this.value:-this.value)};function C(e,t){var r=e.length,i=t.length,a=h(r+i),o=n,s,c,l,u,d;for(l=0;l<r;++l){u=e[l];for(var f=0;f<i;++f)d=t[f],s=u*d+a[l+f],c=Math.floor(s/o),a[l+f]=s-c*o,a[l+f+1]+=c}return m(a),a}function w(e,t){var r=e.length,i=Array(r),a=n,o=0,s,c;for(c=0;c<r;c++)s=e[c]*t+o,o=Math.floor(s/a),i[c]=s-o*a;for(;o>0;)i[c++]=o%a,o=Math.floor(o/a);return i}function ee(e,t){for(var n=[];t-->0;)n.push(0);return n.concat(e)}function te(e,t){var n=Math.max(e.length,t.length);if(n<=30)return C(e,t);n=Math.ceil(n/2);var r=e.slice(n),i=e.slice(0,n),a=t.slice(n),o=t.slice(0,n),s=te(i,o),c=te(r,a),l=v(v(s,ee(b(b(te(v(i,r),v(o,a)),s),c),n)),ee(c,2*n));return m(l),l}function ne(e,t){return-.012*e-.012*t+15e-6*e*t>0}c.prototype.multiply=function(e){var t=k(e),r=this.value,i=t.value,a=this.sign!==t.sign,o;if(t.isSmall){if(i===0)return s[0];if(i===1)return this;if(i===-1)return this.negate();if(o=Math.abs(i),o<n)return new c(w(r,o),a);i=f(o)}return ne(r.length,i.length)?new c(te(r,i),a):new c(C(r,i),a)},c.prototype.times=c.prototype.multiply;function T(e,t,r){return e<n?new c(w(t,e),r):new c(C(t,f(e)),r)}l.prototype._multiplyBySmall=function(e){return d(e.value*this.value)?new l(e.value*this.value):T(Math.abs(e.value),f(Math.abs(this.value)),this.sign!==e.sign)},c.prototype._multiplyBySmall=function(e){return e.value===0?s[0]:e.value===1?this:e.value===-1?this.negate():T(Math.abs(e.value),this.value,this.sign!==e.sign)},l.prototype.multiply=function(e){return k(e)._multiplyBySmall(this)},l.prototype.times=l.prototype.multiply,u.prototype.multiply=function(e){return new u(this.value*k(e).value)},u.prototype.times=u.prototype.multiply;function re(e){var t=e.length,r=h(t+t),i=n,a,o,s,c,l;for(s=0;s<t;s++){c=e[s],o=0-c*c;for(var u=s;u<t;u++)l=e[u],a=c*l*2+r[s+u]+o,o=Math.floor(a/i),r[s+u]=a-o*i;r[s+t]=o}return m(r),r}c.prototype.square=function(){return new c(re(this.value),!1)},l.prototype.square=function(){var e=this.value*this.value;return d(e)?new l(e):new c(re(f(Math.abs(this.value))),!1)},u.prototype.square=function(e){return new u(this.value*this.value)};function ie(e,t){var r=e.length,i=t.length,a=n,o=h(t.length),s=t[i-1],c=Math.ceil(a/(2*s)),l=w(e,c),u=w(t,c),d,f,m,g,_,v,y;for(l.length<=r&&l.push(0),u.push(0),s=u[i-1],f=r-i;f>=0;f--){for(d=a-1,l[f+i]!==s&&(d=Math.floor((l[f+i]*a+l[f+i-1])/s)),m=0,g=0,v=u.length,_=0;_<v;_++)m+=d*u[_],y=Math.floor(m/a),g+=l[f+_]-(m-y*a),m=y,g<0?(l[f+_]=g+a,g=-1):(l[f+_]=g,g=0);for(;g!==0;){for(--d,m=0,_=0;_<v;_++)m+=l[f+_]-a+u[_],m<0?(l[f+_]=m+a,m=0):(l[f+_]=m,m=1);g+=m}o[f]=d}return l=oe(l,c)[0],[p(o),p(l)]}function ae(e,t){for(var r=e.length,i=t.length,a=[],o=[],s=n,c,l,u,d,f;r;){if(o.unshift(e[--r]),m(o),ce(o,t)<0){a.push(0);continue}l=o.length,u=o[l-1]*s+o[l-2],d=t[i-1]*s+t[i-2],l>i&&(u=(u+1)*s),c=Math.ceil(u/d);do{if(f=w(t,c),ce(f,o)<=0)break;c--}while(c);a.push(c),o=b(o,f)}return a.reverse(),[p(a),p(o)]}function oe(e,t){var r=e.length,i=h(r),a=n,o,s,c=0,l;for(o=r-1;o>=0;--o)l=c*a+e[o],s=g(l/t),c=l-s*t,i[o]=s|0;return[i,c|0]}function se(e,t){var r,i=k(t);if(o)return[new u(e.value/i.value),new u(e.value%i.value)];var a=e.value,d=i.value,m;if(d===0)throw Error(`Cannot divide by zero`);if(e.isSmall)return i.isSmall?[new l(g(a/d)),new l(a%d)]:[s[0],e];if(i.isSmall){if(d===1)return[e,s[0]];if(d==-1)return[e.negate(),s[0]];var h=Math.abs(d);if(h<n){r=oe(a,h),m=p(r[0]);var _=r[1];return e.sign&&(_=-_),typeof m==`number`?(e.sign!==i.sign&&(m=-m),[new l(m),new l(_)]):[new c(m,e.sign!==i.sign),new l(_)]}d=f(h)}var v=ce(a,d);if(v===-1)return[s[0],e];if(v===0)return[s[e.sign===i.sign?1:-1],s[0]];r=a.length+d.length<=200?ie(a,d):ae(a,d),m=r[0];var y=e.sign!==i.sign,b=r[1],x=e.sign;return typeof m==`number`?(y&&(m=-m),m=new l(m)):m=new c(m,y),typeof b==`number`?(x&&(b=-b),b=new l(b)):b=new c(b,x),[m,b]}c.prototype.divmod=function(e){var t=se(this,e);return{quotient:t[0],remainder:t[1]}},u.prototype.divmod=l.prototype.divmod=c.prototype.divmod,c.prototype.divide=function(e){return se(this,e)[0]},u.prototype.over=u.prototype.divide=function(e){return new u(this.value/k(e).value)},l.prototype.over=l.prototype.divide=c.prototype.over=c.prototype.divide,c.prototype.mod=function(e){return se(this,e)[1]},u.prototype.mod=u.prototype.remainder=function(e){return new u(this.value%k(e).value)},l.prototype.remainder=l.prototype.mod=c.prototype.remainder=c.prototype.mod,c.prototype.pow=function(e){var t=k(e),n=this.value,r=t.value,i,a,o;if(r===0)return s[1];if(n===0)return s[0];if(n===1)return s[1];if(n===-1)return t.isEven()?s[1]:s[-1];if(t.sign)return s[0];if(!t.isSmall)throw Error(`The exponent `+t.toString()+` is too large.`);if(this.isSmall&&d(i=n**+r))return new l(g(i));for(a=this,o=s[1];r&!0&&(o=o.times(a),--r),r!==0;)r/=2,a=a.square();return o},l.prototype.pow=c.prototype.pow,u.prototype.pow=function(e){var t=k(e),n=this.value,r=t.value,i=BigInt(0),a=BigInt(1),o=BigInt(2);if(r===i)return s[1];if(n===i)return s[0];if(n===a)return s[1];if(n===BigInt(-1))return t.isEven()?s[1]:s[-1];if(t.isNegative())return new u(i);for(var c=this,l=s[1];(r&a)===a&&(l=l.times(c),--r),r!==i;)r/=o,c=c.square();return l},c.prototype.modPow=function(e,t){if(e=k(e),t=k(t),t.isZero())throw Error(`Cannot take modPow with modulus 0`);var n=s[1],r=this.mod(t);for(e.isNegative()&&(e=e.multiply(s[-1]),r=r.modInv(t));e.isPositive();){if(r.isZero())return s[0];e.isOdd()&&(n=n.multiply(r).mod(t)),e=e.divide(2),r=r.square().mod(t)}return n},u.prototype.modPow=l.prototype.modPow=c.prototype.modPow;function ce(e,t){if(e.length!==t.length)return e.length>t.length?1:-1;for(var n=e.length-1;n>=0;n--)if(e[n]!==t[n])return e[n]>t[n]?1:-1;return 0}c.prototype.compareAbs=function(e){var t=k(e),n=this.value,r=t.value;return t.isSmall?1:ce(n,r)},l.prototype.compareAbs=function(e){var t=k(e),n=Math.abs(this.value),r=t.value;return t.isSmall?(r=Math.abs(r),n===r?0:n>r?1:-1):-1},u.prototype.compareAbs=function(e){var t=this.value,n=k(e).value;return t=t>=0?t:-t,n=n>=0?n:-n,t===n?0:t>n?1:-1},c.prototype.compare=function(e){if(e===1/0)return-1;if(e===-1/0)return 1;var t=k(e),n=this.value,r=t.value;return this.sign===t.sign?t.isSmall?this.sign?-1:1:ce(n,r)*(this.sign?-1:1):t.sign?1:-1},c.prototype.compareTo=c.prototype.compare,l.prototype.compare=function(e){if(e===1/0)return-1;if(e===-1/0)return 1;var t=k(e),n=this.value,r=t.value;return t.isSmall?n==r?0:n>r?1:-1:n<0===t.sign?n<0?1:-1:n<0?-1:1},l.prototype.compareTo=l.prototype.compare,u.prototype.compare=function(e){if(e===1/0)return-1;if(e===-1/0)return 1;var t=this.value,n=k(e).value;return t===n?0:t>n?1:-1},u.prototype.compareTo=u.prototype.compare,c.prototype.equals=function(e){return this.compare(e)===0},u.prototype.eq=u.prototype.equals=l.prototype.eq=l.prototype.equals=c.prototype.eq=c.prototype.equals,c.prototype.notEquals=function(e){return this.compare(e)!==0},u.prototype.neq=u.prototype.notEquals=l.prototype.neq=l.prototype.notEquals=c.prototype.neq=c.prototype.notEquals,c.prototype.greater=function(e){return this.compare(e)>0},u.prototype.gt=u.prototype.greater=l.prototype.gt=l.prototype.greater=c.prototype.gt=c.prototype.greater,c.prototype.lesser=function(e){return this.compare(e)<0},u.prototype.lt=u.prototype.lesser=l.prototype.lt=l.prototype.lesser=c.prototype.lt=c.prototype.lesser,c.prototype.greaterOrEquals=function(e){return this.compare(e)>=0},u.prototype.geq=u.prototype.greaterOrEquals=l.prototype.geq=l.prototype.greaterOrEquals=c.prototype.geq=c.prototype.greaterOrEquals,c.prototype.lesserOrEquals=function(e){return this.compare(e)<=0},u.prototype.leq=u.prototype.lesserOrEquals=l.prototype.leq=l.prototype.lesserOrEquals=c.prototype.leq=c.prototype.lesserOrEquals,c.prototype.isEven=function(){return(this.value[0]&1)==0},l.prototype.isEven=function(){return(this.value&1)==0},u.prototype.isEven=function(){return(this.value&BigInt(1))===BigInt(0)},c.prototype.isOdd=function(){return(this.value[0]&1)==1},l.prototype.isOdd=function(){return(this.value&1)==1},u.prototype.isOdd=function(){return(this.value&BigInt(1))===BigInt(1)},c.prototype.isPositive=function(){return!this.sign},l.prototype.isPositive=function(){return this.value>0},u.prototype.isPositive=l.prototype.isPositive,c.prototype.isNegative=function(){return this.sign},l.prototype.isNegative=function(){return this.value<0},u.prototype.isNegative=l.prototype.isNegative,c.prototype.isUnit=function(){return!1},l.prototype.isUnit=function(){return Math.abs(this.value)===1},u.prototype.isUnit=function(){return this.abs().value===BigInt(1)},c.prototype.isZero=function(){return!1},l.prototype.isZero=function(){return this.value===0},u.prototype.isZero=function(){return this.value===BigInt(0)},c.prototype.isDivisibleBy=function(e){var t=k(e);return t.isZero()?!1:t.isUnit()?!0:t.compareAbs(2)===0?this.isEven():this.mod(t).isZero()},u.prototype.isDivisibleBy=l.prototype.isDivisibleBy=c.prototype.isDivisibleBy;function E(e){var t=e.abs();if(t.isUnit())return!1;if(t.equals(2)||t.equals(3)||t.equals(5))return!0;if(t.isEven()||t.isDivisibleBy(3)||t.isDivisibleBy(5))return!1;if(t.lesser(49))return!0}function le(e,n){for(var r=e.prev(),i=r,a=0,o,s,c;i.isEven();)i=i.divide(2),a++;next:for(s=0;s<n.length;s++)if(!e.lesser(n[s])&&(c=t(n[s]).modPow(i,e),!(c.isUnit()||c.equals(r)))){for(o=a-1;o!=0;o--){if(c=c.square().mod(e),c.isUnit())return!1;if(c.equals(r))continue next}return!1}return!0}c.prototype.isPrime=function(n){var r=E(this);if(r!==e)return r;var i=this.abs(),a=i.bitLength();if(a<=64)return le(i,[2,3,5,7,11,13,17,19,23,29,31,37]);for(var o=Math.log(2)*a.toJSNumber(),s=Math.ceil(n===!0?2*o**2:o),c=[],l=0;l<s;l++)c.push(t(l+2));return le(i,c)},u.prototype.isPrime=l.prototype.isPrime=c.prototype.isPrime,c.prototype.isProbablePrime=function(n,r){var i=E(this);if(i!==e)return i;for(var a=this.abs(),o=n===e?5:n,s=[],c=0;c<o;c++)s.push(t.randBetween(2,a.minus(2),r));return le(a,s)},u.prototype.isProbablePrime=l.prototype.isProbablePrime=c.prototype.isProbablePrime,c.prototype.modInv=function(e){for(var n=t.zero,r=t.one,i=k(e),a=this.abs(),o,s,c;!a.isZero();)o=i.divide(a),s=n,c=i,n=r,i=a,r=s.subtract(o.multiply(r)),a=c.subtract(o.multiply(a));if(!i.isUnit())throw Error(this.toString()+` and `+e.toString()+` are not co-prime`);return n.compare(0)===-1&&(n=n.add(e)),this.isNegative()?n.negate():n},u.prototype.modInv=l.prototype.modInv=c.prototype.modInv,c.prototype.next=function(){var e=this.value;return this.sign?S(e,1,this.sign):new c(y(e,1),this.sign)},l.prototype.next=function(){var e=this.value;return e+1<r?new l(e+1):new c(i,!1)},u.prototype.next=function(){return new u(this.value+BigInt(1))},c.prototype.prev=function(){var e=this.value;return this.sign?new c(y(e,1),!0):S(e,1,this.sign)},l.prototype.prev=function(){var e=this.value;return e-1>-r?new l(e-1):new c(i,!0)},u.prototype.prev=function(){return new u(this.value-BigInt(1))};for(var ue=[1];2*ue[ue.length-1]<=n;)ue.push(2*ue[ue.length-1]);var D=ue.length,de=ue[D-1];function fe(e){return Math.abs(e)<=n}c.prototype.shiftLeft=function(e){var t=k(e).toJSNumber();if(!fe(t))throw Error(String(t)+` is too large for shifting.`);if(t<0)return this.shiftRight(-t);var n=this;if(n.isZero())return n;for(;t>=D;)n=n.multiply(de),t-=D-1;return n.multiply(ue[t])},u.prototype.shiftLeft=l.prototype.shiftLeft=c.prototype.shiftLeft,c.prototype.shiftRight=function(e){var t,n=k(e).toJSNumber();if(!fe(n))throw Error(String(n)+` is too large for shifting.`);if(n<0)return this.shiftLeft(-n);for(var r=this;n>=D;){if(r.isZero()||r.isNegative()&&r.isUnit())return r;t=se(r,de),r=t[1].isNegative()?t[0].prev():t[0],n-=D-1}return t=se(r,ue[n]),t[1].isNegative()?t[0].prev():t[0]},u.prototype.shiftRight=l.prototype.shiftRight=c.prototype.shiftRight;function pe(e,n,r){n=k(n);for(var i=e.isNegative(),a=n.isNegative(),o=i?e.not():e,s=a?n.not():n,c=0,l=0,u=null,d=null,f=[];!o.isZero()||!s.isZero();)u=se(o,de),c=u[1].toJSNumber(),i&&(c=de-1-c),d=se(s,de),l=d[1].toJSNumber(),a&&(l=de-1-l),o=u[0],s=d[0],f.push(r(c,l));for(var p=r(+!!i,+!!a)===0?t(0):t(-1),m=f.length-1;m>=0;--m)p=p.multiply(de).add(t(f[m]));return p}c.prototype.not=function(){return this.negate().prev()},u.prototype.not=l.prototype.not=c.prototype.not,c.prototype.and=function(e){return pe(this,e,function(e,t){return e&t})},u.prototype.and=l.prototype.and=c.prototype.and,c.prototype.or=function(e){return pe(this,e,function(e,t){return e|t})},u.prototype.or=l.prototype.or=c.prototype.or,c.prototype.xor=function(e){return pe(this,e,function(e,t){return e^t})},u.prototype.xor=l.prototype.xor=c.prototype.xor;var me=1<<30,he=(n&-n)*(n&-n)|me;function ge(e){var t=e.value,r=typeof t==`number`?t|me:typeof t==`bigint`?t|BigInt(me):t[0]+t[1]*n|he;return r&-r}function _e(e,n){if(n.compareTo(e)<=0){var r=_e(e,n.square(n)),i=r.p,a=r.e,o=i.multiply(n);return o.compareTo(e)<=0?{p:o,e:a*2+1}:{p:i,e:a*2}}return{p:t(1),e:0}}c.prototype.bitLength=function(){var e=this;return e.compareTo(t(0))<0&&(e=e.negate().subtract(t(1))),e.compareTo(t(0))===0?t(0):t(_e(e,t(2)).e).add(t(1))},u.prototype.bitLength=l.prototype.bitLength=c.prototype.bitLength;function ve(e,t){return e=k(e),t=k(t),e.greater(t)?e:t}function ye(e,t){return e=k(e),t=k(t),e.lesser(t)?e:t}function be(e,t){if(e=k(e).abs(),t=k(t).abs(),e.equals(t))return e;if(e.isZero())return t;if(t.isZero())return e;for(var n=s[1],r,i;e.isEven()&&t.isEven();)r=ye(ge(e),ge(t)),e=e.divide(r),t=t.divide(r),n=n.multiply(r);for(;e.isEven();)e=e.divide(ge(e));do{for(;t.isEven();)t=t.divide(ge(t));e.greater(t)&&(i=t,t=e,e=i),t=t.subtract(e)}while(!t.isZero());return n.isUnit()?e:e.multiply(n)}function xe(e,t){return e=k(e).abs(),t=k(t).abs(),e.divide(be(e,t)).multiply(t)}function Se(e,t,r){e=k(e),t=k(t);var i=r||Math.random,a=ye(e,t),o=ve(e,t).subtract(a).add(1);if(o.isSmall)return a.add(Math.floor(i()*o));for(var c=O(o,n).value,l=[],u=!0,d=0;d<c.length;d++){var f=u?c[d]+(d+1<c.length?c[d+1]/n:0):n,p=g(i()*f);l.push(p),p<c[d]&&(u=!1)}return a.add(s.fromArray(l,n,!1))}var Ce=function(e,t,n,r){n||=a,e=String(e),r||(e=e.toLowerCase(),n=n.toLowerCase());var i=e.length,o,s=Math.abs(t),c={};for(o=0;o<n.length;o++)c[n[o]]=o;for(o=0;o<i;o++){var l=e[o];if(l!==`-`&&l in c&&c[l]>=s){if(l===`1`&&s===1)continue;throw Error(l+` is not a valid digit in base `+t+`.`)}}t=k(t);var u=[],d=e[0]===`-`;for(o=+!!d;o<e.length;o++){var l=e[o];if(l in c)u.push(k(c[l]));else if(l===`<`){var f=o;do o++;while(e[o]!==`>`&&o<e.length);u.push(k(e.slice(f+1,o)))}else throw Error(l+` is not a valid character`)}return we(u,t,d)};function we(e,t,n){var r=s[0],i=s[1],a;for(a=e.length-1;a>=0;a--)r=r.add(e[a].times(i)),i=i.times(t);return n?r.negate():r}function Te(e,t){return t||=a,e<t.length?t[e]:`<`+e+`>`}function O(e,n){if(n=t(n),n.isZero()){if(e.isZero())return{value:[0],isNegative:!1};throw Error(`Cannot convert nonzero numbers to base 0.`)}if(n.equals(-1)){if(e.isZero())return{value:[0],isNegative:!1};if(e.isNegative())return{value:[].concat.apply([],Array.apply(null,Array(-e.toJSNumber())).map(Array.prototype.valueOf,[1,0])),isNegative:!1};var r=Array.apply(null,Array(e.toJSNumber()-1)).map(Array.prototype.valueOf,[0,1]);return r.unshift([1]),{value:[].concat.apply([],r),isNegative:!1}}var i=!1;if(e.isNegative()&&n.isPositive()&&(i=!0,e=e.abs()),n.isUnit())return e.isZero()?{value:[0],isNegative:!1}:{value:Array.apply(null,Array(e.toJSNumber())).map(Number.prototype.valueOf,1),isNegative:i};for(var a=[],o=e,s;o.isNegative()||o.compareAbs(n)>=0;){s=o.divmod(n),o=s.quotient;var c=s.remainder;c.isNegative()&&(c=n.minus(c).abs(),o=o.next()),a.push(c.toJSNumber())}return a.push(o.toJSNumber()),{value:a.reverse(),isNegative:i}}function Ee(e,t,n){var r=O(e,t);return(r.isNegative?`-`:``)+r.value.map(function(e){return Te(e,n)}).join(``)}c.prototype.toArray=function(e){return O(this,e)},l.prototype.toArray=function(e){return O(this,e)},u.prototype.toArray=function(e){return O(this,e)},c.prototype.toString=function(t,n){if(t===e&&(t=10),t!==10||n)return Ee(this,t,n);for(var r=this.value,i=r.length,a=String(r[--i]),o=`0000000`,s;--i>=0;)s=String(r[i]),a+=o.slice(s.length)+s;return(this.sign?`-`:``)+a},l.prototype.toString=function(t,n){return t===e&&(t=10),t!=10||n?Ee(this,t,n):String(this.value)},u.prototype.toString=l.prototype.toString,u.prototype.toJSON=c.prototype.toJSON=l.prototype.toJSON=function(){return this.toString()},c.prototype.valueOf=function(){return parseInt(this.toString(),10)},c.prototype.toJSNumber=c.prototype.valueOf,l.prototype.valueOf=function(){return this.value},l.prototype.toJSNumber=l.prototype.valueOf,u.prototype.valueOf=u.prototype.toJSNumber=function(){return parseInt(this.toString(),10)};function De(e){if(d(+e)){var t=+e;if(t===g(t))return o?new u(BigInt(t)):new l(t);throw Error(`Invalid integer: `+e)}var n=e[0]===`-`;n&&(e=e.slice(1));var r=e.split(/e/i);if(r.length>2)throw Error(`Invalid integer: `+r.join(`e`));if(r.length===2){var i=r[1];if(i[0]===`+`&&(i=i.slice(1)),i=+i,i!==g(i)||!d(i))throw Error(`Invalid integer: `+i+` is not a valid exponent.`);var a=r[0],s=a.indexOf(`.`);if(s>=0&&(i-=a.length-s-1,a=a.slice(0,s)+a.slice(s+1)),i<0)throw Error(`Cannot include negative exponent part for integers`);a+=Array(i+1).join(`0`),e=a}if(!/^([0-9][0-9]*)$/.test(e))throw Error(`Invalid integer: `+e);if(o)return new u(BigInt(n?`-`+e:e));for(var f=[],p=e.length,h=7,_=p-h;p>0;)f.push(+e.slice(_,p)),_-=h,_<0&&(_=0),p-=h;return m(f),new c(f,n)}function Oe(e){if(o)return new u(BigInt(e));if(d(e)){if(e!==g(e))throw Error(e+` is not an integer.`);return new l(e)}return De(e.toString())}function k(e){return typeof e==`number`?Oe(e):typeof e==`string`?De(e):typeof e==`bigint`?new u(e):e}for(var ke=0;ke<1e3;ke++)s[ke]=k(ke),ke>0&&(s[-ke]=k(-ke));return s.one=s[1],s.zero=s[0],s.minusOne=s[-1],s.max=ve,s.min=ye,s.gcd=be,s.lcm=xe,s.isInstance=function(e){return e instanceof c||e instanceof l||e instanceof u},s.randBetween=Se,s.fromArray=function(e,t,n){return we(e.map(k),k(t||10),n)},s})();e.hasOwnProperty(`exports`)&&(e.exports=t)})(ud),ud.exports)}var pd=Qc(fd()),md=64,hd=16,gd=md/hd;function _d(){try{return!0}catch{return!1}}function vd(e,t,n){let r=0;for(let i=0;i<n;i++){let n=e[t+i];if(n===void 0)break;r+=n*16**i}return r}function yd(e){let t=[];for(let n=0;n<e.length;n++){let r=Number(e[n]);for(let e=0;r||e<t.length;e++)r+=(t[e]||0)*10,t[e]=r%16,r=(r-t[e])/16}return t}function bd(e){let t=yd(e),n=Array(gd);for(let e=0;e<gd;e++)n[gd-1-e]=vd(t,e*gd,gd);return n}var xd=class e{static fromString(t){return new e(bd(t),t)}static fromBit(t){let n=Array(gd),r=Math.floor(t/hd);for(let e=0;e<gd;e++)n[gd-1-e]=e===r?1<<t-r*hd:0;return new e(n)}constructor(e,t){this.parts=e,this.str=t}and({parts:t}){return new e(this.parts.map((e,n)=>e&t[n]))}or({parts:t}){return new e(this.parts.map((e,n)=>e|t[n]))}xor({parts:t}){return new e(this.parts.map((e,n)=>e^t[n]))}not(){return new e(this.parts.map(e=>~e))}equals({parts:e}){return this.parts.every((t,n)=>t===e[n])}toString(){if(this.str!=null)return this.str;let e=Array(md/4);return this.parts.forEach((t,n)=>{let r=yd(t.toString());for(let t=0;t<4;t++)e[t+n*4]=r[3-t]||0}),this.str=pd.fromArray(e,16).toString()}toJSON(){return this.toString()}},Sd=_d();Sd&&BigInt.prototype.toJSON==null&&(BigInt.prototype.toJSON=function(){return this.toString()});var Cd={},wd=Sd?function(e){return BigInt(e)}:function(e){return e instanceof xd?e:(typeof e==`number`&&(e=e.toString()),Cd[e]??(Cd[e]=xd.fromString(e)),Cd[e])},Td=wd(0),Ed=Sd?function(e=Td,t=Td){return e&t}:function(e=Td,t=Td){return e.and(t)},Dd=Sd?function(e=Td,t=Td){return e|t}:function(e=Td,t=Td){return e.or(t)},Od=Sd?function(e=Td,t=Td){return e^t}:function(e=Td,t=Td){return e.xor(t)},kd=Sd?function(e=Td){return~e}:function(e=Td){return e.not()},Ad=Sd?function(e,t){return e===t}:function(e,t){return e==null||t==null?e==t:e.equals(t)};function jd(...e){let t=e[0];for(let n=1;n<e.length;n++)t=Dd(t,e[n]);return t}function Md(e,t){return Ad(Ed(e,t),t)}function Nd(e,t){return!Ad(Ed(e,t),Td)}function Pd(e,t){return t===Td?e:Dd(e,t)}function Fd(e,t){return t===Td?e:Od(e,Ed(e,t))}var X={combine:jd,add:Pd,remove:Fd,filter:Ed,invert:kd,has:Md,hasAny:Nd,equals:Ad,deserialize:wd,getFlag:Sd?function(e){return BigInt(1)<<BigInt(e)}:function(e){return xd.fromBit(e)}},Id;(function(e){e[e.CLOSE_NORMAL=1e3]=`CLOSE_NORMAL`,e[e.CLOSE_UNSUPPORTED=1003]=`CLOSE_UNSUPPORTED`,e[e.CLOSE_ABNORMAL=1006]=`CLOSE_ABNORMAL`,e[e.INVALID_CLIENTID=4e3]=`INVALID_CLIENTID`,e[e.INVALID_ORIGIN=4001]=`INVALID_ORIGIN`,e[e.RATELIMITED=4002]=`RATELIMITED`,e[e.TOKEN_REVOKED=4003]=`TOKEN_REVOKED`,e[e.INVALID_VERSION=4004]=`INVALID_VERSION`,e[e.INVALID_ENCODING=4005]=`INVALID_ENCODING`})(Id||={});var Ld;(function(e){e[e.INVALID_PAYLOAD=4e3]=`INVALID_PAYLOAD`,e[e.INVALID_COMMAND=4002]=`INVALID_COMMAND`,e[e.INVALID_EVENT=4004]=`INVALID_EVENT`,e[e.INVALID_PERMISSIONS=4006]=`INVALID_PERMISSIONS`})(Ld||={});var Rd;(function(e){e.LANDSCAPE=`landscape`,e.PORTRAIT=`portrait`})(Rd||={});var zd;(function(e){e.MOBILE=`mobile`,e.DESKTOP=`desktop`})(zd||={}),Object.freeze({CREATE_INSTANT_INVITE:X.getFlag(0),KICK_MEMBERS:X.getFlag(1),BAN_MEMBERS:X.getFlag(2),ADMINISTRATOR:X.getFlag(3),MANAGE_CHANNELS:X.getFlag(4),MANAGE_GUILD:X.getFlag(5),ADD_REACTIONS:X.getFlag(6),VIEW_AUDIT_LOG:X.getFlag(7),PRIORITY_SPEAKER:X.getFlag(8),STREAM:X.getFlag(9),VIEW_CHANNEL:X.getFlag(10),SEND_MESSAGES:X.getFlag(11),SEND_TTS_MESSAGES:X.getFlag(12),MANAGE_MESSAGES:X.getFlag(13),EMBED_LINKS:X.getFlag(14),ATTACH_FILES:X.getFlag(15),READ_MESSAGE_HISTORY:X.getFlag(16),MENTION_EVERYONE:X.getFlag(17),USE_EXTERNAL_EMOJIS:X.getFlag(18),VIEW_GUILD_INSIGHTS:X.getFlag(19),CONNECT:X.getFlag(20),SPEAK:X.getFlag(21),MUTE_MEMBERS:X.getFlag(22),DEAFEN_MEMBERS:X.getFlag(23),MOVE_MEMBERS:X.getFlag(24),USE_VAD:X.getFlag(25),CHANGE_NICKNAME:X.getFlag(26),MANAGE_NICKNAMES:X.getFlag(27),MANAGE_ROLES:X.getFlag(28),MANAGE_WEBHOOKS:X.getFlag(29),MANAGE_GUILD_EXPRESSIONS:X.getFlag(30),USE_APPLICATION_COMMANDS:X.getFlag(31),REQUEST_TO_SPEAK:X.getFlag(32),MANAGE_EVENTS:X.getFlag(33),MANAGE_THREADS:X.getFlag(34),CREATE_PUBLIC_THREADS:X.getFlag(35),CREATE_PRIVATE_THREADS:X.getFlag(36),USE_EXTERNAL_STICKERS:X.getFlag(37),SEND_MESSAGES_IN_THREADS:X.getFlag(38),USE_EMBEDDED_ACTIVITIES:X.getFlag(39),MODERATE_MEMBERS:X.getFlag(40),VIEW_CREATOR_MONETIZATION_ANALYTICS:X.getFlag(41),USE_SOUNDBOARD:X.getFlag(42),CREATE_GUILD_EXPRESSIONS:X.getFlag(43),CREATE_EVENTS:X.getFlag(44),USE_EXTERNAL_SOUNDS:X.getFlag(45),SEND_VOICE_MESSAGES:X.getFlag(46),SEND_POLLS:X.getFlag(49),USE_EXTERNAL_APPS:X.getFlag(50)});function Bd(e){return cd(t=>{let[n]=Object.entries(e).find(([,e])=>e===t)??[];return t!=null&&n===void 0?e.UNHANDLED:t},W().or(G()))}function Vd(e){let t=Mu().transform(t=>{let n=e.safeParse(t);return n.success?n.data:e._def.defaultValue()});return t.overlayType=e,t}var Hd=Y.object({image_url:Y.string()}),Ud=Y.object({mediaUrl:Y.string().max(1024)}),Wd=Y.object({access_token:Y.union([Y.string(),Y.null()]).optional()}),Gd=Y.object({access_token:Y.string(),user:Y.object({username:Y.string(),discriminator:Y.string(),id:Y.string(),avatar:Y.union([Y.string(),Y.null()]).optional(),public_flags:Y.number(),global_name:Y.union([Y.string(),Y.null()]).optional()}),scopes:Y.array(Vd(Y.enum(`identify,email,connections,guilds,guilds.join,guilds.members.read,guilds.channels.read,gdm.join,bot,rpc,rpc.notifications.read,rpc.voice.read,rpc.voice.write,rpc.video.read,rpc.video.write,rpc.screenshare.read,rpc.screenshare.write,rpc.activities.write,webhook.incoming,messages.read,applications.builds.upload,applications.builds.read,applications.commands,applications.commands.permissions.update,applications.commands.update,applications.store.update,applications.entitlements,activities.read,activities.write,relationships.read,relationships.write,voice,dm_channels.read,role_connections.write,presences.read,presences.write,openid,dm_channels.messages.read,dm_channels.messages.write,gateway.connect,account.global_name.update,payment_sources.country_code,sdk.social_layer`.split(`,`)).or(Y.literal(-1)).default(-1))),expires:Y.string(),application:Y.object({description:Y.string(),icon:Y.union([Y.string(),Y.null()]).optional(),id:Y.string(),rpc_origins:Y.array(Y.string()).optional(),name:Y.string()})}),Kd=Y.object({participants:Y.array(Y.object({id:Y.string(),username:Y.string(),global_name:Y.union([Y.string(),Y.null()]).optional(),discriminator:Y.string(),avatar:Y.union([Y.string(),Y.null()]).optional(),flags:Y.number(),bot:Y.boolean(),avatar_decoration_data:Y.union([Y.object({asset:Y.string(),skuId:Y.string().optional()}),Y.null()]).optional(),premium_type:Y.union([Y.number(),Y.null()]).optional(),nickname:Y.string().optional()}))}),qd=Y.object({command:Y.string(),content:Y.string().max(2e3).optional(),preview_image:Y.object({height:Y.number(),url:Y.string(),width:Y.number()}).optional(),components:Y.array(Y.object({type:Y.literal(1),components:Y.array(Y.object({type:Y.literal(2),style:Y.number().gte(1).lte(5),label:Y.string().max(80).optional(),custom_id:Y.string().max(100).describe(`Developer-defined identifier for the button; max 100 characters`).optional()})).max(5).optional()})).optional()}),Jd=Y.object({referrer_id:Y.string().max(64).optional(),custom_id:Y.string().max(64).optional(),message:Y.string().max(1e3)}),Yd=Y.object({success:Y.boolean()}),Xd;(function(e){e.INITIATE_IMAGE_UPLOAD=`INITIATE_IMAGE_UPLOAD`,e.OPEN_SHARE_MOMENT_DIALOG=`OPEN_SHARE_MOMENT_DIALOG`,e.AUTHENTICATE=`AUTHENTICATE`,e.GET_ACTIVITY_INSTANCE_CONNECTED_PARTICIPANTS=`GET_ACTIVITY_INSTANCE_CONNECTED_PARTICIPANTS`,e.SHARE_INTERACTION=`SHARE_INTERACTION`,e.SHARE_LINK=`SHARE_LINK`})(Xd||={});var Zd=Y.object({}).optional().nullable(),Qd=Y.void(),$d={[Xd.INITIATE_IMAGE_UPLOAD]:{request:Qd,response:Hd},[Xd.OPEN_SHARE_MOMENT_DIALOG]:{request:Ud,response:Zd},[Xd.AUTHENTICATE]:{request:Wd,response:Gd},[Xd.GET_ACTIVITY_INSTANCE_CONNECTED_PARTICIPANTS]:{request:Qd,response:Kd},[Xd.SHARE_INTERACTION]:{request:qd,response:Zd},[Xd.SHARE_LINK]:{request:Jd,response:Yd}},ef=t({Activity:()=>mf,Attachment:()=>Cf,CertifiedDevice:()=>Uf,CertifiedDeviceTypeObject:()=>Hf,Channel:()=>vf,ChannelMention:()=>Sf,ChannelTypesObject:()=>_f,Commands:()=>Z,DISPATCH:()=>tf,Embed:()=>Af,EmbedAuthor:()=>Of,EmbedField:()=>kf,EmbedFooter:()=>wf,EmbedProvider:()=>Df,Emoji:()=>lf,Entitlement:()=>qf,EntitlementTypesObject:()=>Kf,Guild:()=>xf,GuildMember:()=>sf,GuildMemberRPC:()=>cf,Image:()=>Tf,KeyTypesObject:()=>Lf,LayoutMode:()=>tp,LayoutModeTypeObject:()=>ep,Message:()=>Ff,MessageActivity:()=>Mf,MessageApplication:()=>Nf,MessageReference:()=>Pf,Orientation:()=>$f,OrientationLockState:()=>Yf,OrientationLockStateTypeObject:()=>Jf,OrientationTypeObject:()=>Qf,PermissionOverwrite:()=>gf,PermissionOverwriteTypeObject:()=>hf,PresenceUpdate:()=>yf,Reaction:()=>jf,ReceiveFramePayload:()=>nf,Role:()=>bf,Scopes:()=>af,ScopesObject:()=>rf,ShortcutKey:()=>Rf,Sku:()=>Gf,SkuTypeObject:()=>Wf,Status:()=>pf,StatusObject:()=>ff,ThermalState:()=>Zf,ThermalStateTypeObject:()=>Xf,User:()=>of,UserVoiceState:()=>df,Video:()=>Ef,VoiceDevice:()=>If,VoiceSettingModeTypeObject:()=>zf,VoiceSettingsIO:()=>Vf,VoiceSettingsMode:()=>Bf,VoiceState:()=>uf}),tf=`DISPATCH`,Z;(function(e){e.AUTHORIZE=`AUTHORIZE`,e.AUTHENTICATE=`AUTHENTICATE`,e.GET_GUILDS=`GET_GUILDS`,e.GET_GUILD=`GET_GUILD`,e.GET_CHANNEL=`GET_CHANNEL`,e.GET_CHANNELS=`GET_CHANNELS`,e.SELECT_VOICE_CHANNEL=`SELECT_VOICE_CHANNEL`,e.SELECT_TEXT_CHANNEL=`SELECT_TEXT_CHANNEL`,e.SUBSCRIBE=`SUBSCRIBE`,e.UNSUBSCRIBE=`UNSUBSCRIBE`,e.CAPTURE_SHORTCUT=`CAPTURE_SHORTCUT`,e.SET_CERTIFIED_DEVICES=`SET_CERTIFIED_DEVICES`,e.SET_ACTIVITY=`SET_ACTIVITY`,e.GET_SKUS=`GET_SKUS`,e.GET_ENTITLEMENTS=`GET_ENTITLEMENTS`,e.GET_SKUS_EMBEDDED=`GET_SKUS_EMBEDDED`,e.GET_ENTITLEMENTS_EMBEDDED=`GET_ENTITLEMENTS_EMBEDDED`,e.START_PURCHASE=`START_PURCHASE`,e.SET_CONFIG=`SET_CONFIG`,e.SEND_ANALYTICS_EVENT=`SEND_ANALYTICS_EVENT`,e.USER_SETTINGS_GET_LOCALE=`USER_SETTINGS_GET_LOCALE`,e.OPEN_EXTERNAL_LINK=`OPEN_EXTERNAL_LINK`,e.ENCOURAGE_HW_ACCELERATION=`ENCOURAGE_HW_ACCELERATION`,e.CAPTURE_LOG=`CAPTURE_LOG`,e.SET_ORIENTATION_LOCK_STATE=`SET_ORIENTATION_LOCK_STATE`,e.OPEN_INVITE_DIALOG=`OPEN_INVITE_DIALOG`,e.GET_PLATFORM_BEHAVIORS=`GET_PLATFORM_BEHAVIORS`,e.GET_CHANNEL_PERMISSIONS=`GET_CHANNEL_PERMISSIONS`,e.OPEN_SHARE_MOMENT_DIALOG=`OPEN_SHARE_MOMENT_DIALOG`,e.INITIATE_IMAGE_UPLOAD=`INITIATE_IMAGE_UPLOAD`,e.GET_ACTIVITY_INSTANCE_CONNECTED_PARTICIPANTS=`GET_ACTIVITY_INSTANCE_CONNECTED_PARTICIPANTS`,e.SHARE_LINK=`SHARE_LINK`})(Z||={});var nf=J({cmd:W(),data:Hu(),evt:Bu(),nonce:W()}).passthrough(),rf=Object.assign(Object.assign({},Gd.shape.scopes.element.overlayType._def.innerType.options[0].Values),{UNHANDLED:-1}),af=Bd(rf),of=J({id:W(),username:W(),discriminator:W(),global_name:W().optional().nullable(),avatar:W().optional().nullable(),avatar_decoration_data:J({asset:W(),sku_id:W().optional()}).nullable(),bot:K(),flags:G().optional().nullable(),premium_type:G().optional().nullable()}),sf=J({user:of,nick:W().optional().nullable(),roles:q(W()),joined_at:W(),deaf:K(),mute:K()}),cf=J({user_id:W(),nick:W().optional().nullable(),guild_id:W(),avatar:W().optional().nullable(),avatar_decoration_data:J({asset:W(),sku_id:W().optional().nullable()}).optional().nullable(),color_string:W().optional().nullable()}),lf=J({id:W(),name:W().optional().nullable(),roles:q(W()).optional().nullable(),user:of.optional().nullable(),require_colons:K().optional().nullable(),managed:K().optional().nullable(),animated:K().optional().nullable(),available:K().optional().nullable()}),uf=J({mute:K(),deaf:K(),self_mute:K(),self_deaf:K(),suppress:K()}),df=J({mute:K(),nick:W(),user:of,voice_state:uf,volume:G()}),ff={UNHANDLED:-1,IDLE:`idle`,DND:`dnd`,ONLINE:`online`,OFFLINE:`offline`},pf=Bd(ff),mf=J({name:W(),type:G(),url:W().optional().nullable(),created_at:G().optional().nullable(),timestamps:J({start:G(),end:G()}).partial().optional().nullable(),application_id:W().optional().nullable(),details:W().optional().nullable(),state:W().optional().nullable(),emoji:lf.optional().nullable(),party:J({id:W().optional().nullable(),size:q(G()).optional().nullable()}).optional().nullable(),assets:J({large_image:W().nullable(),large_text:W().nullable(),small_image:W().nullable(),small_text:W().nullable()}).partial().optional().nullable(),secrets:J({join:W(),match:W()}).partial().optional().nullable(),instance:K().optional().nullable(),flags:G().optional().nullable()}),hf={UNHANDLED:-1,ROLE:0,MEMBER:1},gf=J({id:W(),type:Bd(hf),allow:W(),deny:W()}),_f={UNHANDLED:-1,DM:1,GROUP_DM:3,GUILD_TEXT:0,GUILD_VOICE:2,GUILD_CATEGORY:4,GUILD_ANNOUNCEMENT:5,GUILD_STORE:6,ANNOUNCEMENT_THREAD:10,PUBLIC_THREAD:11,PRIVATE_THREAD:12,GUILD_STAGE_VOICE:13,GUILD_DIRECTORY:14,GUILD_FORUM:15},vf=J({id:W(),type:Bd(_f),guild_id:W().optional().nullable(),position:G().optional().nullable(),permission_overwrites:q(gf).optional().nullable(),name:W().optional().nullable(),topic:W().optional().nullable(),nsfw:K().optional().nullable(),last_message_id:W().optional().nullable(),bitrate:G().optional().nullable(),user_limit:G().optional().nullable(),rate_limit_per_user:G().optional().nullable(),recipients:q(of).optional().nullable(),icon:W().optional().nullable(),owner_id:W().optional().nullable(),application_id:W().optional().nullable(),parent_id:W().optional().nullable(),last_pin_timestamp:W().optional().nullable()}),yf=J({user:of,guild_id:W(),status:pf,activities:q(mf),client_status:J({desktop:pf,mobile:pf,web:pf}).partial()}),bf=J({id:W(),name:W(),color:G(),hoist:K(),position:G(),permissions:W(),managed:K(),mentionable:K()}),xf=J({id:W(),name:W(),owner_id:W(),icon:W().nullable(),icon_hash:W().optional().nullable(),splash:W().nullable(),discovery_splash:W().nullable(),owner:K().optional().nullable(),permissions:W().optional().nullable(),region:W(),afk_channel_id:W().nullable(),afk_timeout:G(),widget_enabled:K().optional().nullable(),widget_channel_id:W().optional().nullable(),verification_level:G(),default_message_notifications:G(),explicit_content_filter:G(),roles:q(bf),emojis:q(lf),features:q(W()),mfa_level:G(),application_id:W().nullable(),system_channel_id:W().nullable(),system_channel_flags:G(),rules_channel_id:W().nullable(),joined_at:W().optional().nullable(),large:K().optional().nullable(),unavailable:K().optional().nullable(),member_count:G().optional().nullable(),voice_states:q(uf).optional().nullable(),members:q(sf).optional().nullable(),channels:q(vf).optional().nullable(),presences:q(yf).optional().nullable(),max_presences:G().optional().nullable(),max_members:G().optional().nullable(),vanity_url_code:W().nullable(),description:W().nullable(),banner:W().nullable(),premium_tier:G(),premium_subscription_count:G().optional().nullable(),preferred_locale:W(),public_updates_channel_id:W().nullable(),max_video_channel_users:G().optional().nullable(),approximate_member_count:G().optional().nullable(),approximate_presence_count:G().optional().nullable()}),Sf=J({id:W(),guild_id:W(),type:G(),name:W()}),Cf=J({id:W(),filename:W(),size:G(),url:W(),proxy_url:W(),height:G().optional().nullable(),width:G().optional().nullable()}),wf=J({text:W(),icon_url:W().optional().nullable(),proxy_icon_url:W().optional().nullable()}),Tf=J({url:W().optional().nullable(),proxy_url:W().optional().nullable(),height:G().optional().nullable(),width:G().optional().nullable()}),Ef=Tf.omit({proxy_url:!0}),Df=J({name:W().optional().nullable(),url:W().optional().nullable()}),Of=J({name:W().optional().nullable(),url:W().optional().nullable(),icon_url:W().optional().nullable(),proxy_icon_url:W().optional().nullable()}),kf=J({name:W(),value:W(),inline:K()}),Af=J({title:W().optional().nullable(),type:W().optional().nullable(),description:W().optional().nullable(),url:W().optional().nullable(),timestamp:W().optional().nullable(),color:G().optional().nullable(),footer:wf.optional().nullable(),image:Tf.optional().nullable(),thumbnail:Tf.optional().nullable(),video:Ef.optional().nullable(),provider:Df.optional().nullable(),author:Of.optional().nullable(),fields:q(kf).optional().nullable()}),jf=J({count:G(),me:K(),emoji:lf}),Mf=J({type:G(),party_id:W().optional().nullable()}),Nf=J({id:W(),cover_image:W().optional().nullable(),description:W(),icon:W().optional().nullable(),name:W()}),Pf=J({message_id:W().optional().nullable(),channel_id:W().optional().nullable(),guild_id:W().optional().nullable()}),Ff=J({id:W(),channel_id:W(),guild_id:W().optional().nullable(),author:of.optional().nullable(),member:sf.optional().nullable(),content:W(),timestamp:W(),edited_timestamp:W().optional().nullable(),tts:K(),mention_everyone:K(),mentions:q(of),mention_roles:q(W()),mention_channels:q(Sf),attachments:q(Cf),embeds:q(Af),reactions:q(jf).optional().nullable(),nonce:Ku([W(),G()]).optional().nullable(),pinned:K(),webhook_id:W().optional().nullable(),type:G(),activity:Mf.optional().nullable(),application:Nf.optional().nullable(),message_reference:Pf.optional().nullable(),flags:G().optional().nullable(),stickers:q(Hu()).optional().nullable(),referenced_message:Hu().optional().nullable()}),If=J({id:W(),name:W()}),Lf={UNHANDLED:-1,KEYBOARD_KEY:0,MOUSE_BUTTON:1,KEYBOARD_MODIFIER_KEY:2,GAMEPAD_BUTTON:3},Rf=J({type:Bd(Lf),code:G(),name:W()}),zf={UNHANDLED:-1,PUSH_TO_TALK:`PUSH_TO_TALK`,VOICE_ACTIVITY:`VOICE_ACTIVITY`},Bf=J({type:Bd(zf),auto_threshold:K(),threshold:G(),shortcut:q(Rf),delay:G()}),Vf=J({device_id:W(),volume:G(),available_devices:q(If)}),Hf={UNHANDLED:-1,AUDIO_INPUT:`AUDIO_INPUT`,AUDIO_OUTPUT:`AUDIO_OUTPUT`,VIDEO_INPUT:`VIDEO_INPUT`},Uf=J({type:Bd(Hf),id:W(),vendor:J({name:W(),url:W()}),model:J({name:W(),url:W()}),related:q(W()),echo_cancellation:K().optional().nullable(),noise_suppression:K().optional().nullable(),automatic_gain_control:K().optional().nullable(),hardware_mute:K().optional().nullable()}),Wf={UNHANDLED:-1,APPLICATION:1,DLC:2,CONSUMABLE:3,BUNDLE:4,SUBSCRIPTION:5},Gf=J({id:W(),name:W(),type:Bd(Wf),price:J({amount:G(),currency:W()}),application_id:W(),flags:G(),release_date:W().nullable()}),Kf={UNHANDLED:-1,PURCHASE:1,PREMIUM_SUBSCRIPTION:2,DEVELOPER_GIFT:3,TEST_MODE_PURCHASE:4,FREE_PURCHASE:5,USER_GIFT:6,PREMIUM_PURCHASE:7},qf=J({id:W(),sku_id:W(),application_id:W(),user_id:W(),gift_code_flags:G(),type:Bd(Kf),gifter_user_id:W().optional().nullable(),branches:q(W()).optional().nullable(),starts_at:W().optional().nullable(),ends_at:W().optional().nullable(),parent_id:W().optional().nullable(),consumed:K().optional().nullable(),deleted:K().optional().nullable(),gift_code_batch_id:W().optional().nullable()}),Jf={UNHANDLED:-1,UNLOCKED:1,PORTRAIT:2,LANDSCAPE:3},Yf=Bd(Jf),Xf={UNHANDLED:-1,NOMINAL:0,FAIR:1,SERIOUS:2,CRITICAL:3},Zf=Bd(Xf),Qf={UNHANDLED:-1,PORTRAIT:0,LANDSCAPE:1},$f=Bd(Qf),ep={UNHANDLED:-1,FOCUSED:0,PIP:1,GRID:2},tp=Bd(ep),np=`ERROR`,rp;(function(e){e.READY=`READY`,e.VOICE_STATE_UPDATE=`VOICE_STATE_UPDATE`,e.SPEAKING_START=`SPEAKING_START`,e.SPEAKING_STOP=`SPEAKING_STOP`,e.ACTIVITY_LAYOUT_MODE_UPDATE=`ACTIVITY_LAYOUT_MODE_UPDATE`,e.ORIENTATION_UPDATE=`ORIENTATION_UPDATE`,e.CURRENT_USER_UPDATE=`CURRENT_USER_UPDATE`,e.CURRENT_GUILD_MEMBER_UPDATE=`CURRENT_GUILD_MEMBER_UPDATE`,e.ENTITLEMENT_CREATE=`ENTITLEMENT_CREATE`,e.THERMAL_STATE_UPDATE=`THERMAL_STATE_UPDATE`,e.ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE=`ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE`})(rp||={});var ip=nf.extend({evt:rd(rp),nonce:W().nullable(),cmd:td(tf),data:J({}).passthrough()}),ap=nf.extend({evt:td(np),data:J({code:G(),message:W().optional()}).passthrough(),cmd:rd(Z),nonce:W().nullable()}),op=Ku([ip,ip.extend({evt:W()}),ap]);function sp(e){let t=e.evt;if(!(t in rp))throw Error(`Unrecognized event type ${e.evt}`);return cp[t].payload.parse(e)}var cp={[rp.READY]:{payload:ip.extend({evt:td(rp.READY),data:J({v:G(),config:J({cdn_host:W().optional(),api_endpoint:W(),environment:W()}),user:J({id:W(),username:W(),discriminator:W(),avatar:W().optional()}).optional()})})},[rp.VOICE_STATE_UPDATE]:{payload:ip.extend({evt:td(rp.VOICE_STATE_UPDATE),data:df}),subscribeArgs:J({channel_id:W()})},[rp.SPEAKING_START]:{payload:ip.extend({evt:td(rp.SPEAKING_START),data:J({lobby_id:W().optional(),channel_id:W().optional(),user_id:W()})}),subscribeArgs:J({lobby_id:W().nullable().optional(),channel_id:W().nullable().optional()})},[rp.SPEAKING_STOP]:{payload:ip.extend({evt:td(rp.SPEAKING_STOP),data:J({lobby_id:W().optional(),channel_id:W().optional(),user_id:W()})}),subscribeArgs:J({lobby_id:W().nullable().optional(),channel_id:W().nullable().optional()})},[rp.ACTIVITY_LAYOUT_MODE_UPDATE]:{payload:ip.extend({evt:td(rp.ACTIVITY_LAYOUT_MODE_UPDATE),data:J({layout_mode:Bd(ep)})})},[rp.ORIENTATION_UPDATE]:{payload:ip.extend({evt:td(rp.ORIENTATION_UPDATE),data:J({screen_orientation:Bd(Qf),orientation:rd(Rd)})})},[rp.CURRENT_USER_UPDATE]:{payload:ip.extend({evt:td(rp.CURRENT_USER_UPDATE),data:of})},[rp.CURRENT_GUILD_MEMBER_UPDATE]:{payload:ip.extend({evt:td(rp.CURRENT_GUILD_MEMBER_UPDATE),data:cf}),subscribeArgs:J({guild_id:W()})},[rp.ENTITLEMENT_CREATE]:{payload:ip.extend({evt:td(rp.ENTITLEMENT_CREATE),data:J({entitlement:qf})})},[rp.THERMAL_STATE_UPDATE]:{payload:ip.extend({evt:td(rp.THERMAL_STATE_UPDATE),data:J({thermal_state:Zf})})},[rp.ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE]:{payload:ip.extend({evt:td(rp.ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE),data:J({participants:Kd.shape.participants})})}};function lp(e,t){throw t}var up=J({}).nullable(),dp=J({code:W()}),fp=J({guilds:q(J({id:W(),name:W()}))}),pp=J({id:W(),name:W(),icon_url:W().optional(),members:q(sf)}),mp=J({id:W(),type:Bd(_f),guild_id:W().optional().nullable(),name:W().optional().nullable(),topic:W().optional().nullable(),bitrate:G().optional().nullable(),user_limit:G().optional().nullable(),position:G().optional().nullable(),voice_states:q(df),messages:q(Ff)}),hp=J({channels:q(vf)});mp.nullable();var gp=mp.nullable(),_p=mp.nullable();J({input:Vf,output:Vf,mode:Bf,automatic_gain_control:K(),echo_cancellation:K(),noise_suppression:K(),qos:K(),silence_warning:K(),deaf:K(),mute:K()});var vp=J({evt:W()}),yp=J({shortcut:Rf}),bp=mf,xp=J({skus:q(Gf)}),Sp=J({entitlements:q(qf)}),Cp=q(qf).nullable(),wp=J({use_interactive_pip:K()}),Tp=J({locale:W()}),Ep=J({enabled:K()}),Dp=J({permissions:Iu().or(W())}),Op=Vd(J({opened:K().or(Bu())}).default({opened:null})),kp=J({iosKeyboardResizesView:od(K())}),Ap=nf.extend({cmd:rd(Z),evt:Bu()});function jp({cmd:e,data:t}){switch(e){case Z.AUTHORIZE:return dp.parse(t);case Z.CAPTURE_SHORTCUT:return yp.parse(t);case Z.ENCOURAGE_HW_ACCELERATION:return Ep.parse(t);case Z.GET_CHANNEL:return mp.parse(t);case Z.GET_CHANNELS:return hp.parse(t);case Z.GET_CHANNEL_PERMISSIONS:return Dp.parse(t);case Z.GET_GUILD:return pp.parse(t);case Z.GET_GUILDS:return fp.parse(t);case Z.GET_PLATFORM_BEHAVIORS:return kp.parse(t);case Z.GET_CHANNEL:return mp.parse(t);case Z.SELECT_TEXT_CHANNEL:return _p.parse(t);case Z.SELECT_VOICE_CHANNEL:return gp.parse(t);case Z.SET_ACTIVITY:return bp.parse(t);case Z.GET_SKUS_EMBEDDED:return xp.parse(t);case Z.GET_ENTITLEMENTS_EMBEDDED:return Sp.parse(t);case Z.SET_CONFIG:return wp.parse(t);case Z.START_PURCHASE:return Cp.parse(t);case Z.SUBSCRIBE:case Z.UNSUBSCRIBE:return vp.parse(t);case Z.USER_SETTINGS_GET_LOCALE:return Tp.parse(t);case Z.OPEN_EXTERNAL_LINK:return Op.parse(t);case Z.SET_ORIENTATION_LOCK_STATE:case Z.SET_CERTIFIED_DEVICES:case Z.SEND_ANALYTICS_EVENT:case Z.OPEN_INVITE_DIALOG:case Z.CAPTURE_LOG:case Z.GET_SKUS:case Z.GET_ENTITLEMENTS:return up.parse(t);case Z.AUTHENTICATE:case Z.INITIATE_IMAGE_UPLOAD:case Z.OPEN_SHARE_MOMENT_DIALOG:case Z.GET_ACTIVITY_INSTANCE_CONNECTED_PARTICIPANTS:case Z.SHARE_LINK:let{response:n}=$d[e];return n.parse(t);default:lp(e,Error(`Unrecognized command ${e}`))}}function Mp(e){return Object.assign(Object.assign({},e),{data:jp(e)})}J({frame_id:W(),platform:rd(zd).optional().nullable()}),J({v:td(1),encoding:td(`json`).optional(),client_id:W(),frame_id:W()});var Np=J({code:G(),message:W().optional()}),Pp=J({evt:W().nullable(),nonce:W().nullable(),data:Hu().nullable(),cmd:W()}).passthrough();function Fp(e){let t=Pp.parse(e);return t.evt==null?Mp(Ap.passthrough().parse(t)):t.evt===`ERROR`?ap.parse(t):sp(op.parse(t))}function Ip(e,t,n,r=()=>void 0){let i=nf.extend({cmd:td(t),data:n});return async n=>{let a=await e({cmd:t,args:n,transfer:r(n)});return i.parse(a).data}}function Lp(e,t=()=>void 0){let n=$d[e].response,r=nf.extend({cmd:td(e),data:n});return n=>async i=>{let a=await n({cmd:e,args:i,transfer:t(i)});return r.parse(a).data}}var Rp=Lp(Xd.AUTHENTICATE),zp=e=>Ip(e,Z.AUTHORIZE,dp),Bp=e=>Ip(e,Z.CAPTURE_LOG,up),Vp=e=>Ip(e,Z.ENCOURAGE_HW_ACCELERATION,Ep),Hp=e=>Ip(e,Z.GET_ENTITLEMENTS_EMBEDDED,Sp),Up=e=>Ip(e,Z.GET_SKUS_EMBEDDED,xp),Wp=e=>Ip(e,Z.GET_CHANNEL_PERMISSIONS,Dp),Gp=e=>Ip(e,Z.GET_PLATFORM_BEHAVIORS,kp),Kp=e=>Ip(e,Z.OPEN_EXTERNAL_LINK,Op),qp=e=>Ip(e,Z.OPEN_INVITE_DIALOG,up),Jp=Lp(Xd.OPEN_SHARE_MOMENT_DIALOG);mf.pick({state:!0,details:!0,timestamps:!0,assets:!0,party:!0,secrets:!0,instance:!0,type:!0}).extend({type:mf.shape.type.optional(),instance:mf.shape.instance.optional()}).nullable();var Yp=e=>Ip(e,Z.SET_ACTIVITY,bp),Xp=e=>Ip(e,Z.SET_CONFIG,wp);function Zp({sendCommand:e,cmd:t,response:n,fallbackTransform:r,transferTransform:i=()=>void 0}){let a=nf.extend({cmd:td(t),data:n});return async n=>{try{let r=await e({cmd:t,args:n,transfer:i(n)});return a.parse(r).data}catch(o){if(o.code===Ld.INVALID_PAYLOAD){let o=r(n),s=await e({cmd:t,args:o,transfer:i(o)});return a.parse(s).data}else throw o}}}var Qp=e=>({lock_state:e.lock_state,picture_in_picture_lock_state:e.picture_in_picture_lock_state}),$p=e=>Zp({sendCommand:e,cmd:Z.SET_ORIENTATION_LOCK_STATE,response:up,fallbackTransform:Qp}),em=Lp(Xd.SHARE_LINK),tm=e=>Ip(e,Z.START_PURCHASE,Cp),nm=e=>Ip(e,Z.USER_SETTINGS_GET_LOCALE,Tp),rm=Lp(Xd.INITIATE_IMAGE_UPLOAD),im=e=>Ip(e,Z.GET_CHANNEL,mp),am=Lp(Xd.GET_ACTIVITY_INSTANCE_CONNECTED_PARTICIPANTS);function om(e){return{authenticate:Rp(e),authorize:zp(e),captureLog:Bp(e),encourageHardwareAcceleration:Vp(e),getChannel:im(e),getChannelPermissions:Wp(e),getEntitlements:Hp(e),getPlatformBehaviors:Gp(e),getSkus:Up(e),openExternalLink:Kp(e),openInviteDialog:qp(e),openShareMomentDialog:Jp(e),setActivity:Yp(e),setConfig:Xp(e),setOrientationLockState:$p(e),shareLink:em(e),startPurchase:tm(e),userSettingsGetLocale:nm(e),initiateImageUpload:rm(e),getInstanceConnectedParticipants:am(e)}}var sm=class extends Error{constructor(e,t=``){super(t),this.code=e,this.message=t,this.name=`Discord SDK Error`}};function cm(){return{disableConsoleLogOverride:!1}}var lm=[`log`,`warn`,`debug`,`info`,`error`];function um(e,t,n){let r=e[t],i=e;r&&(e[t]=function(){let e=[].slice.call(arguments);n(t,``+e.join(` `)),r.apply(i,e)})}var dm=`1.9.0`,fm={randomUUID:typeof crypto<`u`&&crypto.randomUUID&&crypto.randomUUID.bind(crypto)},pm,mm=new Uint8Array(16);function hm(){if(!pm&&(pm=typeof crypto<`u`&&crypto.getRandomValues&&crypto.getRandomValues.bind(crypto),!pm))throw Error(`crypto.getRandomValues() not supported. See https://github.com/uuidjs/uuid#getrandomvalues-not-supported`);return pm(mm)}for(var gm=[],_m=0;_m<256;++_m)gm.push((_m+256).toString(16).slice(1));function vm(e,t=0){return(gm[e[t+0]]+gm[e[t+1]]+gm[e[t+2]]+gm[e[t+3]]+`-`+gm[e[t+4]]+gm[e[t+5]]+`-`+gm[e[t+6]]+gm[e[t+7]]+`-`+gm[e[t+8]]+gm[e[t+9]]+`-`+gm[e[t+10]]+gm[e[t+11]]+gm[e[t+12]]+gm[e[t+13]]+gm[e[t+14]]+gm[e[t+15]]).toLowerCase()}function ym(e,t,n){if(fm.randomUUID&&!t&&!e)return fm.randomUUID();e||={};var r=e.random||(e.rng||hm)();return r[6]=r[6]&15|64,r[8]=r[8]&63|128,vm(r)}var bm;(function(e){e[e.HANDSHAKE=0]=`HANDSHAKE`,e[e.FRAME=1]=`FRAME`,e[e.CLOSE=2]=`CLOSE`,e[e.HELLO=3]=`HELLO`})(bm||={});var xm=new Set(Sm());function Sm(){return typeof window>`u`?[]:[window.location.origin,`https://discord.com`,`https://discordapp.com`,`https://ptb.discord.com`,`https://ptb.discordapp.com`,`https://canary.discord.com`,`https://canary.discordapp.com`,`https://staging.discord.co`,`http://localhost:3333`,`https://pax.discord.com`,`null`]}function Cm(){return[window.parent.opener??window.parent,document.referrer?document.referrer:`*`]}var wm=class{getTransfer(e){switch(e.cmd){case Z.SUBSCRIBE:case Z.UNSUBSCRIBE:return;default:return e.transfer??void 0}}constructor(e,t){if(this.sdkVersion=dm,this.mobileAppVersion=null,this.source=null,this.sourceOrigin=``,this.eventBus=new nl,this.pendingCommands=new Map,this.sendCommand=e=>{var t;if(this.source==null)throw Error(`Attempting to send message before initialization`);let n=ym();return(t=this.source)==null||t.postMessage([bm.FRAME,Object.assign(Object.assign({},e),{nonce:n})],this.sourceOrigin,this.getTransfer(e)),new Promise((e,t)=>{this.pendingCommands.set(n,{resolve:e,reject:t})})},this.commands=om(this.sendCommand),this.handleMessage=e=>{if(!xm.has(e.origin))return;let t=e.data;if(!Array.isArray(t))return;let[n,r]=t;switch(n){case bm.HELLO:return;case bm.CLOSE:return this.handleClose(r);case bm.HANDSHAKE:return this.handleHandshake();case bm.FRAME:return this.handleFrame(r);default:throw Error(`Invalid message format`)}},this.isReady=!1,this.clientId=e,this.configuration=t??cm(),typeof window<`u`&&window.addEventListener(`message`,this.handleMessage),typeof window>`u`){this.frameId=``,this.instanceId=``,this.customId=null,this.referrerId=null,this.platform=zd.DESKTOP,this.guildId=null,this.channelId=null,this.locationId=null;return}let n=new URLSearchParams(this._getSearch()),r=n.get(`frame_id`);if(!r)throw Error(`frame_id query param is not defined`);this.frameId=r;let i=n.get(`instance_id`);if(!i)throw Error(`instance_id query param is not defined`);this.instanceId=i;let a=n.get(`platform`);if(!a)throw Error(`platform query param is not defined`);if(a!==zd.DESKTOP&&a!==zd.MOBILE)throw Error(`Invalid query param "platform" of "${a}". Valid values are "${zd.DESKTOP}" or "${zd.MOBILE}"`);this.platform=a,this.customId=n.get(`custom_id`),this.referrerId=n.get(`referrer_id`),this.guildId=n.get(`guild_id`),this.channelId=n.get(`channel_id`),this.locationId=n.get(`location_id`),this.mobileAppVersion=n.get(`mobile_app_version`),[this.source,this.sourceOrigin]=Cm(),this.addOnReadyListener(),this.handshake()}close(e,t){var n;window.removeEventListener(`message`,this.handleMessage);let r=ym();(n=this.source)==null||n.postMessage([bm.CLOSE,{code:e,message:t,nonce:r}],this.sourceOrigin)}async subscribe(e,t,...n){let[r]=n,i=this.eventBus.listenerCount(e),a=this.eventBus.on(e,t);return Object.values(rp).includes(e)&&e!==rp.READY&&i===0&&await this.sendCommand({cmd:Z.SUBSCRIBE,args:r,evt:e}),a}async unsubscribe(e,t,...n){let[r]=n;return e!==rp.READY&&this.eventBus.listenerCount(e)===1&&await this.sendCommand({cmd:Z.UNSUBSCRIBE,evt:e,args:r}),this.eventBus.off(e,t)}async ready(){this.isReady||await new Promise(e=>{this.eventBus.once(rp.READY,e)})}parseMajorMobileVersion(){if(this.mobileAppVersion&&this.mobileAppVersion.includes(`.`))try{return parseInt(this.mobileAppVersion.split(`.`)[0])}catch{return-1}return-1}handshake(){var e;let t={v:1,encoding:`json`,client_id:this.clientId,frame_id:this.frameId},n=this.parseMajorMobileVersion();(this.platform===zd.DESKTOP||n>=250)&&(t.sdk_version=this.sdkVersion),(e=this.source)==null||e.postMessage([bm.HANDSHAKE,t],this.sourceOrigin)}addOnReadyListener(){this.eventBus.once(rp.READY,()=>{this.overrideConsoleLogging(),this.isReady=!0})}overrideConsoleLogging(){if(this.configuration.disableConsoleLogOverride)return;let e=(e,t)=>{this.commands.captureLog({level:e,message:t})};lm.forEach(t=>{um(console,t,e)})}handleClose(e){Np.parse(e)}handleHandshake(){}handleFrame(e){var t,n;let r;try{r=Fp(e)}catch(t){console.error(`Failed to parse`,e),console.error(t);return}if(r.cmd===`DISPATCH`)this.eventBus.emit(r.evt,r.data);else{if(r.evt===`ERROR`){if(r.nonce!=null){(t=this.pendingCommands.get(r.nonce))==null||t.reject(r.data),this.pendingCommands.delete(r.nonce);return}this.eventBus.emit(`error`,new sm(r.data.code,r.data.message))}if(r.nonce==null){console.error(`Missing nonce`,e);return}(n=this.pendingCommands.get(r.nonce))==null||n.resolve(r),this.pendingCommands.delete(r.nonce)}}_getSearch(){return typeof window>`u`?``:window.location.search}},Tm=1e9,Em={precision:20,rounding:4,toExpNeg:-7,toExpPos:21,LN10:`2.302585092994045684017991454684364207601101488628772976033327900967572609677352480235997205089598298341967784042286`},Dm=!0,Om=`[DecimalError] `,km=Om+`Invalid argument: `,Am=Om+`Exponent out of range: `,jm=Math.floor,Mm=Math.pow,Nm=/^(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?$/i,Pm,Fm=1e7,Im=7,Lm=9007199254740991,Rm=jm(Lm/Im),Q={};Q.absoluteValue=Q.abs=function(){var e=new this.constructor(this);return e.s&&=1,e},Q.comparedTo=Q.cmp=function(e){var t,n,r,i,a=this;if(e=new a.constructor(e),a.s!==e.s)return a.s||-e.s;if(a.e!==e.e)return a.e>e.e^a.s<0?1:-1;for(r=a.d.length,i=e.d.length,t=0,n=r<i?r:i;t<n;++t)if(a.d[t]!==e.d[t])return a.d[t]>e.d[t]^a.s<0?1:-1;return r===i?0:r>i^a.s<0?1:-1},Q.decimalPlaces=Q.dp=function(){var e=this,t=e.d.length-1,n=(t-e.e)*Im;if(t=e.d[t],t)for(;t%10==0;t/=10)n--;return n<0?0:n},Q.dividedBy=Q.div=function(e){return Hm(this,new this.constructor(e))},Q.dividedToIntegerBy=Q.idiv=function(e){var t=this,n=t.constructor;return Ym(Hm(t,new n(e),0,1),n.precision)},Q.equals=Q.eq=function(e){return!this.cmp(e)},Q.exponent=function(){return Wm(this)},Q.greaterThan=Q.gt=function(e){return this.cmp(e)>0},Q.greaterThanOrEqualTo=Q.gte=function(e){return this.cmp(e)>=0},Q.isInteger=Q.isint=function(){return this.e>this.d.length-2},Q.isNegative=Q.isneg=function(){return this.s<0},Q.isPositive=Q.ispos=function(){return this.s>0},Q.isZero=function(){return this.s===0},Q.lessThan=Q.lt=function(e){return this.cmp(e)<0},Q.lessThanOrEqualTo=Q.lte=function(e){return this.cmp(e)<1},Q.logarithm=Q.log=function(e){var t,n=this,r=n.constructor,i=r.precision,a=i+5;if(e===void 0)e=new r(10);else if(e=new r(e),e.s<1||e.eq(Pm))throw Error(Om+`NaN`);if(n.s<1)throw Error(Om+(n.s?`NaN`:`-Infinity`));return n.eq(Pm)?new r(0):(Dm=!1,t=Hm(qm(n,a),qm(e,a),a),Dm=!0,Ym(t,i))},Q.minus=Q.sub=function(e){var t=this;return e=new t.constructor(e),t.s==e.s?Xm(t,e):zm(t,(e.s=-e.s,e))},Q.modulo=Q.mod=function(e){var t,n=this,r=n.constructor,i=r.precision;if(e=new r(e),!e.s)throw Error(Om+`NaN`);return n.s?(Dm=!1,t=Hm(n,e,0,1).times(e),Dm=!0,n.minus(t)):Ym(new r(n),i)},Q.naturalExponential=Q.exp=function(){return Um(this)},Q.naturalLogarithm=Q.ln=function(){return qm(this)},Q.negated=Q.neg=function(){var e=new this.constructor(this);return e.s=-e.s||0,e},Q.plus=Q.add=function(e){var t=this;return e=new t.constructor(e),t.s==e.s?zm(t,e):Xm(t,(e.s=-e.s,e))},Q.precision=Q.sd=function(e){var t,n,r,i=this;if(e!==void 0&&e!==!!e&&e!==1&&e!==0)throw Error(km+e);if(t=Wm(i)+1,r=i.d.length-1,n=r*Im+1,r=i.d[r],r){for(;r%10==0;r/=10)n--;for(r=i.d[0];r>=10;r/=10)n++}return e&&t>n?t:n},Q.squareRoot=Q.sqrt=function(){var e,t,n,r,i,a,o,s=this,c=s.constructor;if(s.s<1){if(!s.s)return new c(0);throw Error(Om+`NaN`)}for(e=Wm(s),Dm=!1,i=Math.sqrt(+s),i==0||i==1/0?(t=Vm(s.d),(t.length+e)%2==0&&(t+=`0`),i=Math.sqrt(t),e=jm((e+1)/2)-(e<0||e%2),i==1/0?t=`5e`+e:(t=i.toExponential(),t=t.slice(0,t.indexOf(`e`)+1)+e),r=new c(t)):r=new c(i.toString()),n=c.precision,i=o=n+3;;)if(a=r,r=a.plus(Hm(s,a,o+2)).times(.5),Vm(a.d).slice(0,o)===(t=Vm(r.d)).slice(0,o)){if(t=t.slice(o-3,o+1),i==o&&t==`4999`){if(Ym(a,n+1,0),a.times(a).eq(s)){r=a;break}}else if(t!=`9999`)break;o+=4}return Dm=!0,Ym(r,n)},Q.times=Q.mul=function(e){var t,n,r,i,a,o,s,c,l,u=this,d=u.constructor,f=u.d,p=(e=new d(e)).d;if(!u.s||!e.s)return new d(0);for(e.s*=u.s,n=u.e+e.e,c=f.length,l=p.length,c<l&&(a=f,f=p,p=a,o=c,c=l,l=o),a=[],o=c+l,r=o;r--;)a.push(0);for(r=l;--r>=0;){for(t=0,i=c+r;i>r;)s=a[i]+p[r]*f[i-r-1]+t,a[i--]=s%Fm|0,t=s/Fm|0;a[i]=(a[i]+t)%Fm|0}for(;!a[--o];)a.pop();return t?++n:a.shift(),e.d=a,e.e=n,Dm?Ym(e,d.precision):e},Q.toDecimalPlaces=Q.todp=function(e,t){var n=this,r=n.constructor;return n=new r(n),e===void 0?n:(Bm(e,0,Tm),t===void 0?t=r.rounding:Bm(t,0,8),Ym(n,e+Wm(n)+1,t))},Q.toExponential=function(e,t){var n,r=this,i=r.constructor;return e===void 0?n=Zm(r,!0):(Bm(e,0,Tm),t===void 0?t=i.rounding:Bm(t,0,8),r=Ym(new i(r),e+1,t),n=Zm(r,!0,e+1)),n},Q.toFixed=function(e,t){var n,r,i=this,a=i.constructor;return e===void 0?Zm(i):(Bm(e,0,Tm),t===void 0?t=a.rounding:Bm(t,0,8),r=Ym(new a(i),e+Wm(i)+1,t),n=Zm(r.abs(),!1,e+Wm(r)+1),i.isneg()&&!i.isZero()?`-`+n:n)},Q.toInteger=Q.toint=function(){var e=this,t=e.constructor;return Ym(new t(e),Wm(e)+1,t.rounding)},Q.toNumber=function(){return+this},Q.toPower=Q.pow=function(e){var t,n,r,i,a,o,s=this,c=s.constructor,l=12,u=+(e=new c(e));if(!e.s)return new c(Pm);if(s=new c(s),!s.s){if(e.s<1)throw Error(Om+`Infinity`);return s}if(s.eq(Pm))return s;if(r=c.precision,e.eq(Pm))return Ym(s,r);if(t=e.e,n=e.d.length-1,o=t>=n,a=s.s,!o){if(a<0)throw Error(Om+`NaN`)}else if((n=u<0?-u:u)<=Lm){for(i=new c(Pm),t=Math.ceil(r/Im+4),Dm=!1;n%2&&(i=i.times(s),Qm(i.d,t)),n=jm(n/2),n!==0;)s=s.times(s),Qm(s.d,t);return Dm=!0,e.s<0?new c(Pm).div(i):Ym(i,r)}return a=a<0&&e.d[Math.max(t,n)]&1?-1:1,s.s=1,Dm=!1,i=e.times(qm(s,r+l)),Dm=!0,i=Um(i),i.s=a,i},Q.toPrecision=function(e,t){var n,r,i=this,a=i.constructor;return e===void 0?(n=Wm(i),r=Zm(i,n<=a.toExpNeg||n>=a.toExpPos)):(Bm(e,1,Tm),t===void 0?t=a.rounding:Bm(t,0,8),i=Ym(new a(i),e,t),n=Wm(i),r=Zm(i,e<=n||n<=a.toExpNeg,e)),r},Q.toSignificantDigits=Q.tosd=function(e,t){var n=this,r=n.constructor;return e===void 0?(e=r.precision,t=r.rounding):(Bm(e,1,Tm),t===void 0?t=r.rounding:Bm(t,0,8)),Ym(new r(n),e,t)},Q.toString=Q.valueOf=Q.val=Q.toJSON=Q[Symbol.for(`nodejs.util.inspect.custom`)]=function(){var e=this,t=Wm(e),n=e.constructor;return Zm(e,t<=n.toExpNeg||t>=n.toExpPos)};function zm(e,t){var n,r,i,a,o,s,c,l,u=e.constructor,d=u.precision;if(!e.s||!t.s)return t.s||(t=new u(e)),Dm?Ym(t,d):t;if(c=e.d,l=t.d,o=e.e,i=t.e,c=c.slice(),a=o-i,a){for(a<0?(r=c,a=-a,s=l.length):(r=l,i=o,s=c.length),o=Math.ceil(d/Im),s=o>s?o+1:s+1,a>s&&(a=s,r.length=1),r.reverse();a--;)r.push(0);r.reverse()}for(s=c.length,a=l.length,s-a<0&&(a=s,r=l,l=c,c=r),n=0;a;)n=(c[--a]=c[a]+l[a]+n)/Fm|0,c[a]%=Fm;for(n&&(c.unshift(n),++i),s=c.length;c[--s]==0;)c.pop();return t.d=c,t.e=i,Dm?Ym(t,d):t}function Bm(e,t,n){if(e!==~~e||e<t||e>n)throw Error(km+e)}function Vm(e){var t,n,r,i=e.length-1,a=``,o=e[0];if(i>0){for(a+=o,t=1;t<i;t++)r=e[t]+``,n=Im-r.length,n&&(a+=Km(n)),a+=r;o=e[t],r=o+``,n=Im-r.length,n&&(a+=Km(n))}else if(o===0)return`0`;for(;o%10==0;)o/=10;return a+o}var Hm=(function(){function e(e,t){var n,r=0,i=e.length;for(e=e.slice();i--;)n=e[i]*t+r,e[i]=n%Fm|0,r=n/Fm|0;return r&&e.unshift(r),e}function t(e,t,n,r){var i,a;if(n!=r)a=n>r?1:-1;else for(i=a=0;i<n;i++)if(e[i]!=t[i]){a=e[i]>t[i]?1:-1;break}return a}function n(e,t,n){for(var r=0;n--;)e[n]-=r,r=+(e[n]<t[n]),e[n]=r*Fm+e[n]-t[n];for(;!e[0]&&e.length>1;)e.shift()}return function(r,i,a,o){var s,c,l,u,d,f,p,m,h,g,_,v,y,b,x,S,C,w,ee=r.constructor,te=r.s==i.s?1:-1,ne=r.d,T=i.d;if(!r.s)return new ee(r);if(!i.s)throw Error(Om+`Division by zero`);for(c=r.e-i.e,C=T.length,x=ne.length,p=new ee(te),m=p.d=[],l=0;T[l]==(ne[l]||0);)++l;if(T[l]>(ne[l]||0)&&--c,v=a==null?a=ee.precision:o?a+(Wm(r)-Wm(i))+1:a,v<0)return new ee(0);if(v=v/Im+2|0,l=0,C==1)for(u=0,T=T[0],v++;(l<x||u)&&v--;l++)y=u*Fm+(ne[l]||0),m[l]=y/T|0,u=y%T|0;else{for(u=Fm/(T[0]+1)|0,u>1&&(T=e(T,u),ne=e(ne,u),C=T.length,x=ne.length),b=C,h=ne.slice(0,C),g=h.length;g<C;)h[g++]=0;w=T.slice(),w.unshift(0),S=T[0],T[1]>=Fm/2&&++S;do u=0,s=t(T,h,C,g),s<0?(_=h[0],C!=g&&(_=_*Fm+(h[1]||0)),u=_/S|0,u>1?(u>=Fm&&(u=Fm-1),d=e(T,u),f=d.length,g=h.length,s=t(d,h,f,g),s==1&&(u--,n(d,C<f?w:T,f))):(u==0&&(s=u=1),d=T.slice()),f=d.length,f<g&&d.unshift(0),n(h,d,g),s==-1&&(g=h.length,s=t(T,h,C,g),s<1&&(u++,n(h,C<g?w:T,g))),g=h.length):s===0&&(u++,h=[0]),m[l++]=u,s&&h[0]?h[g++]=ne[b]||0:(h=[ne[b]],g=1);while((b++<x||h[0]!==void 0)&&v--)}return m[0]||m.shift(),p.e=c,Ym(p,o?a+Wm(p)+1:a)}})();function Um(e,t){var n,r,i,a,o,s,c=0,l=0,u=e.constructor,d=u.precision;if(Wm(e)>16)throw Error(Am+Wm(e));if(!e.s)return new u(Pm);for(t==null?(Dm=!1,s=d):s=t,o=new u(.03125);e.abs().gte(.1);)e=e.times(o),l+=5;for(r=Math.log(Mm(2,l))/Math.LN10*2+5|0,s+=r,n=i=a=new u(Pm),u.precision=s;;){if(i=Ym(i.times(e),s),n=n.times(++c),o=a.plus(Hm(i,n,s)),Vm(o.d).slice(0,s)===Vm(a.d).slice(0,s)){for(;l--;)a=Ym(a.times(a),s);return u.precision=d,t==null?(Dm=!0,Ym(a,d)):a}a=o}}function Wm(e){for(var t=e.e*Im,n=e.d[0];n>=10;n/=10)t++;return t}function Gm(e,t,n){if(t>e.LN10.sd())throw Dm=!0,n&&(e.precision=n),Error(Om+`LN10 precision limit exceeded`);return Ym(new e(e.LN10),t)}function Km(e){for(var t=``;e--;)t+=`0`;return t}function qm(e,t){var n,r,i,a,o,s,c,l,u,d=1,f=10,p=e,m=p.d,h=p.constructor,g=h.precision;if(p.s<1)throw Error(Om+(p.s?`NaN`:`-Infinity`));if(p.eq(Pm))return new h(0);if(t==null?(Dm=!1,l=g):l=t,p.eq(10))return t??(Dm=!0),Gm(h,l);if(l+=f,h.precision=l,n=Vm(m),r=n.charAt(0),a=Wm(p),Math.abs(a)<0x5543df729c000){for(;r<7&&r!=1||r==1&&n.charAt(1)>3;)p=p.times(e),n=Vm(p.d),r=n.charAt(0),d++;a=Wm(p),r>1?(p=new h(`0.`+n),a++):p=new h(r+`.`+n.slice(1))}else return c=Gm(h,l+2,g).times(a+``),p=qm(new h(r+`.`+n.slice(1)),l-f).plus(c),h.precision=g,t==null?(Dm=!0,Ym(p,g)):p;for(s=o=p=Hm(p.minus(Pm),p.plus(Pm),l),u=Ym(p.times(p),l),i=3;;){if(o=Ym(o.times(u),l),c=s.plus(Hm(o,new h(i),l)),Vm(c.d).slice(0,l)===Vm(s.d).slice(0,l))return s=s.times(2),a!==0&&(s=s.plus(Gm(h,l+2,g).times(a+``))),s=Hm(s,new h(d),l),h.precision=g,t==null?(Dm=!0,Ym(s,g)):s;s=c,i+=2}}function Jm(e,t){var n,r,i;for((n=t.indexOf(`.`))>-1&&(t=t.replace(`.`,``)),(r=t.search(/e/i))>0?(n<0&&(n=r),n+=+t.slice(r+1),t=t.substring(0,r)):n<0&&(n=t.length),r=0;t.charCodeAt(r)===48;)++r;for(i=t.length;t.charCodeAt(i-1)===48;)--i;if(t=t.slice(r,i),t){if(i-=r,n=n-r-1,e.e=jm(n/Im),e.d=[],r=(n+1)%Im,n<0&&(r+=Im),r<i){for(r&&e.d.push(+t.slice(0,r)),i-=Im;r<i;)e.d.push(+t.slice(r,r+=Im));t=t.slice(r),r=Im-t.length}else r-=i;for(;r--;)t+=`0`;if(e.d.push(+t),Dm&&(e.e>Rm||e.e<-Rm))throw Error(Am+n)}else e.s=0,e.e=0,e.d=[0];return e}function Ym(e,t,n){var r,i,a,o,s,c,l,u,d=e.d;for(o=1,a=d[0];a>=10;a/=10)o++;if(r=t-o,r<0)r+=Im,i=t,l=d[u=0];else{if(u=Math.ceil((r+1)/Im),a=d.length,u>=a)return e;for(l=a=d[u],o=1;a>=10;a/=10)o++;r%=Im,i=r-Im+o}if(n!==void 0&&(a=Mm(10,o-i-1),s=l/a%10|0,c=t<0||d[u+1]!==void 0||l%a,c=n<4?(s||c)&&(n==0||n==(e.s<0?3:2)):s>5||s==5&&(n==4||c||n==6&&(r>0?i>0?l/Mm(10,o-i):0:d[u-1])%10&1||n==(e.s<0?8:7))),t<1||!d[0])return c?(a=Wm(e),d.length=1,t=t-a-1,d[0]=Mm(10,(Im-t%Im)%Im),e.e=jm(-t/Im)||0):(d.length=1,d[0]=e.e=e.s=0),e;if(r==0?(d.length=u,a=1,u--):(d.length=u+1,a=Mm(10,Im-r),d[u]=i>0?(l/Mm(10,o-i)%Mm(10,i)|0)*a:0),c)for(;;)if(u==0){(d[0]+=a)==Fm&&(d[0]=1,++e.e);break}else{if(d[u]+=a,d[u]!=Fm)break;d[u--]=0,a=1}for(r=d.length;d[--r]===0;)d.pop();if(Dm&&(e.e>Rm||e.e<-Rm))throw Error(Am+Wm(e));return e}function Xm(e,t){var n,r,i,a,o,s,c,l,u,d,f=e.constructor,p=f.precision;if(!e.s||!t.s)return t.s?t.s=-t.s:t=new f(e),Dm?Ym(t,p):t;if(c=e.d,d=t.d,r=t.e,l=e.e,c=c.slice(),o=l-r,o){for(u=o<0,u?(n=c,o=-o,s=d.length):(n=d,r=l,s=c.length),i=Math.max(Math.ceil(p/Im),s)+2,o>i&&(o=i,n.length=1),n.reverse(),i=o;i--;)n.push(0);n.reverse()}else{for(i=c.length,s=d.length,u=i<s,u&&(s=i),i=0;i<s;i++)if(c[i]!=d[i]){u=c[i]<d[i];break}o=0}for(u&&(n=c,c=d,d=n,t.s=-t.s),s=c.length,i=d.length-s;i>0;--i)c[s++]=0;for(i=d.length;i>o;){if(c[--i]<d[i]){for(a=i;a&&c[--a]===0;)c[a]=Fm-1;--c[a],c[i]+=Fm}c[i]-=d[i]}for(;c[--s]===0;)c.pop();for(;c[0]===0;c.shift())--r;return c[0]?(t.d=c,t.e=r,Dm?Ym(t,p):t):new f(0)}function Zm(e,t,n){var r,i=Wm(e),a=Vm(e.d),o=a.length;return t?(n&&(r=n-o)>0?a=a.charAt(0)+`.`+a.slice(1)+Km(r):o>1&&(a=a.charAt(0)+`.`+a.slice(1)),a=a+(i<0?`e`:`e+`)+i):i<0?(a=`0.`+Km(-i-1)+a,n&&(r=n-o)>0&&(a+=Km(r))):i>=o?(a+=Km(i+1-o),n&&(r=n-i-1)>0&&(a=a+`.`+Km(r))):((r=i+1)<o&&(a=a.slice(0,r)+`.`+a.slice(r)),n&&(r=n-o)>0&&(i+1===o&&(a+=`.`),a+=Km(r))),e.s<0?`-`+a:a}function Qm(e,t){if(e.length>t)return e.length=t,!0}function $m(e){var t,n,r;function i(e){var t=this;if(!(t instanceof i))return new i(e);if(t.constructor=i,e instanceof i){t.s=e.s,t.e=e.e,t.d=(e=e.d)?e.slice():e;return}if(typeof e==`number`){if(e*0!=0)throw Error(km+e);if(e>0)t.s=1;else if(e<0)e=-e,t.s=-1;else{t.s=0,t.e=0,t.d=[0];return}if(e===~~e&&e<1e7){t.e=0,t.d=[e];return}return Jm(t,e.toString())}else if(typeof e!=`string`)throw Error(km+e);if(e.charCodeAt(0)===45?(e=e.slice(1),t.s=-1):t.s=1,Nm.test(e))Jm(t,e);else throw Error(km+e)}if(i.prototype=Q,i.ROUND_UP=0,i.ROUND_DOWN=1,i.ROUND_CEIL=2,i.ROUND_FLOOR=3,i.ROUND_HALF_UP=4,i.ROUND_HALF_DOWN=5,i.ROUND_HALF_EVEN=6,i.ROUND_HALF_CEIL=7,i.ROUND_HALF_FLOOR=8,i.clone=$m,i.config=i.set=eh,e===void 0&&(e={}),e)for(r=[`precision`,`rounding`,`toExpNeg`,`toExpPos`,`LN10`],t=0;t<r.length;)e.hasOwnProperty(n=r[t++])||(e[n]=this[n]);return i.config(e),i}function eh(e){if(!e||typeof e!=`object`)throw Error(Om+`Object expected`);var t,n,r,i=[`precision`,1,Tm,`rounding`,0,8,`toExpNeg`,-1/0,0,`toExpPos`,0,1/0];for(t=0;t<i.length;t+=3)if((r=e[n=i[t]])!==void 0)if(jm(r)===r&&r>=i[t+1]&&r<=i[t+2])this[n]=r;else throw Error(km+n+`: `+r);if((r=e[n=`LN10`])!==void 0)if(r==Math.LN10)this[n]=new this(r);else throw Error(km+n+`: `+r);return this}Pm=new($m(Em))(1);var $;(function(e){e.AED=`aed`,e.AFN=`afn`,e.ALL=`all`,e.AMD=`amd`,e.ANG=`ang`,e.AOA=`aoa`,e.ARS=`ars`,e.AUD=`aud`,e.AWG=`awg`,e.AZN=`azn`,e.BAM=`bam`,e.BBD=`bbd`,e.BDT=`bdt`,e.BGN=`bgn`,e.BHD=`bhd`,e.BIF=`bif`,e.BMD=`bmd`,e.BND=`bnd`,e.BOB=`bob`,e.BOV=`bov`,e.BRL=`brl`,e.BSD=`bsd`,e.BTN=`btn`,e.BWP=`bwp`,e.BYN=`byn`,e.BYR=`byr`,e.BZD=`bzd`,e.CAD=`cad`,e.CDF=`cdf`,e.CHE=`che`,e.CHF=`chf`,e.CHW=`chw`,e.CLF=`clf`,e.CLP=`clp`,e.CNY=`cny`,e.COP=`cop`,e.COU=`cou`,e.CRC=`crc`,e.CUC=`cuc`,e.CUP=`cup`,e.CVE=`cve`,e.CZK=`czk`,e.DJF=`djf`,e.DKK=`dkk`,e.DOP=`dop`,e.DZD=`dzd`,e.EGP=`egp`,e.ERN=`ern`,e.ETB=`etb`,e.EUR=`eur`,e.FJD=`fjd`,e.FKP=`fkp`,e.GBP=`gbp`,e.GEL=`gel`,e.GHS=`ghs`,e.GIP=`gip`,e.GMD=`gmd`,e.GNF=`gnf`,e.GTQ=`gtq`,e.GYD=`gyd`,e.HKD=`hkd`,e.HNL=`hnl`,e.HRK=`hrk`,e.HTG=`htg`,e.HUF=`huf`,e.IDR=`idr`,e.ILS=`ils`,e.INR=`inr`,e.IQD=`iqd`,e.IRR=`irr`,e.ISK=`isk`,e.JMD=`jmd`,e.JOD=`jod`,e.JPY=`jpy`,e.KES=`kes`,e.KGS=`kgs`,e.KHR=`khr`,e.KMF=`kmf`,e.KPW=`kpw`,e.KRW=`krw`,e.KWD=`kwd`,e.KYD=`kyd`,e.KZT=`kzt`,e.LAK=`lak`,e.LBP=`lbp`,e.LKR=`lkr`,e.LRD=`lrd`,e.LSL=`lsl`,e.LTL=`ltl`,e.LVL=`lvl`,e.LYD=`lyd`,e.MAD=`mad`,e.MDL=`mdl`,e.MGA=`mga`,e.MKD=`mkd`,e.MMK=`mmk`,e.MNT=`mnt`,e.MOP=`mop`,e.MRO=`mro`,e.MUR=`mur`,e.MVR=`mvr`,e.MWK=`mwk`,e.MXN=`mxn`,e.MXV=`mxv`,e.MYR=`myr`,e.MZN=`mzn`,e.NAD=`nad`,e.NGN=`ngn`,e.NIO=`nio`,e.NOK=`nok`,e.NPR=`npr`,e.NZD=`nzd`,e.OMR=`omr`,e.PAB=`pab`,e.PEN=`pen`,e.PGK=`pgk`,e.PHP=`php`,e.PKR=`pkr`,e.PLN=`pln`,e.PYG=`pyg`,e.QAR=`qar`,e.RON=`ron`,e.RSD=`rsd`,e.RUB=`rub`,e.RWF=`rwf`,e.SAR=`sar`,e.SBD=`sbd`,e.SCR=`scr`,e.SDG=`sdg`,e.SEK=`sek`,e.SGD=`sgd`,e.SHP=`shp`,e.SLL=`sll`,e.SOS=`sos`,e.SRD=`srd`,e.SSP=`ssp`,e.STD=`std`,e.SVC=`svc`,e.SYP=`syp`,e.SZL=`szl`,e.THB=`thb`,e.TJS=`tjs`,e.TMT=`tmt`,e.TND=`tnd`,e.TOP=`top`,e.TRY=`try`,e.TTD=`ttd`,e.TWD=`twd`,e.TZS=`tzs`,e.UAH=`uah`,e.UGX=`ugx`,e.USD=`usd`,e.USN=`usn`,e.USS=`uss`,e.UYI=`uyi`,e.UYU=`uyu`,e.UZS=`uzs`,e.VEF=`vef`,e.VND=`vnd`,e.VUV=`vuv`,e.WST=`wst`,e.XAF=`xaf`,e.XAG=`xag`,e.XAU=`xau`,e.XBA=`xba`,e.XBB=`xbb`,e.XBC=`xbc`,e.XBD=`xbd`,e.XCD=`xcd`,e.XDR=`xdr`,e.XFU=`xfu`,e.XOF=`xof`,e.XPD=`xpd`,e.XPF=`xpf`,e.XPT=`xpt`,e.XSU=`xsu`,e.XTS=`xts`,e.XUA=`xua`,e.YER=`yer`,e.ZAR=`zar`,e.ZMW=`zmw`,e.ZWL=`zwl`})($||={}),$.AED,$.AFN,$.ALL,$.AMD,$.ANG,$.AOA,$.ARS,$.AUD,$.AWG,$.AZN,$.BAM,$.BBD,$.BDT,$.BGN,$.BHD,$.BIF,$.BMD,$.BND,$.BOB,$.BOV,$.BRL,$.BSD,$.BTN,$.BWP,$.BYR,$.BYN,$.BZD,$.CAD,$.CDF,$.CHE,$.CHF,$.CHW,$.CLF,$.CLP,$.CNY,$.COP,$.COU,$.CRC,$.CUC,$.CUP,$.CVE,$.CZK,$.DJF,$.DKK,$.DOP,$.DZD,$.EGP,$.ERN,$.ETB,$.EUR,$.FJD,$.FKP,$.GBP,$.GEL,$.GHS,$.GIP,$.GMD,$.GNF,$.GTQ,$.GYD,$.HKD,$.HNL,$.HRK,$.HTG,$.HUF,$.IDR,$.ILS,$.INR,$.IQD,$.IRR,$.ISK,$.JMD,$.JOD,$.JPY,$.KES,$.KGS,$.KHR,$.KMF,$.KPW,$.KRW,$.KWD,$.KYD,$.KZT,$.LAK,$.LBP,$.LKR,$.LRD,$.LSL,$.LTL,$.LVL,$.LYD,$.MAD,$.MDL,$.MGA,$.MKD,$.MMK,$.MNT,$.MOP,$.MRO,$.MUR,$.MVR,$.MWK,$.MXN,$.MXV,$.MYR,$.MZN,$.NAD,$.NGN,$.NIO,$.NOK,$.NPR,$.NZD,$.OMR,$.PAB,$.PEN,$.PGK,$.PHP,$.PKR,$.PLN,$.PYG,$.QAR,$.RON,$.RSD,$.RUB,$.RWF,$.SAR,$.SBD,$.SCR,$.SDG,$.SEK,$.SGD,$.SHP,$.SLL,$.SOS,$.SRD,$.SSP,$.STD,$.SVC,$.SYP,$.SZL,$.THB,$.TJS,$.TMT,$.TND,$.TOP,$.TRY,$.TTD,$.TWD,$.TZS,$.UAH,$.UGX,$.USD,$.USN,$.USS,$.UYI,$.UYU,$.UZS,$.VEF,$.VND,$.VUV,$.WST,$.XAF,$.XAG,$.XAU,$.XBA,$.XBB,$.XBC,$.XBD,$.XCD,$.XDR,$.XFU,$.XOF,$.XPD,$.XPF,$.XPT,$.XSU,$.XTS,$.XUA,$.YER,$.ZAR,$.ZMW,$.ZWL;var th={exports:{}};th.exports;var nh;function rh(){return nh?th.exports:(nh=1,(function(e,t){var n=`__lodash_hash_undefined__`,r=9007199254740991,i=`[object Arguments]`,a=`[object Array]`,o=`[object Boolean]`,s=`[object Date]`,c=`[object Error]`,l=`[object Function]`,u=`[object Map]`,d=`[object Number]`,f=`[object Object]`,p=`[object Promise]`,m=`[object RegExp]`,h=`[object Set]`,g=`[object String]`,_=`[object Symbol]`,v=`[object WeakMap]`,y=`[object ArrayBuffer]`,b=`[object DataView]`,x=`[object Float32Array]`,S=`[object Float64Array]`,C=`[object Int8Array]`,w=`[object Int16Array]`,ee=`[object Int32Array]`,te=`[object Uint8Array]`,ne=`[object Uint8ClampedArray]`,T=`[object Uint16Array]`,re=`[object Uint32Array]`,ie=/\.|\[(?:[^[\]]*|(["'])(?:(?!\1)[^\\]|\\.)*?\1)\]/,ae=/^\w*$/,oe=/^\./,se=/[^.[\]]+|\[(?:(-?\d+(?:\.\d+)?)|(["'])((?:(?!\2)[^\\]|\\.)*?)\2)\]|(?=(?:\.|\[\])(?:\.|\[\]|$))/g,ce=/[\\^$.*+?()[\]{}|]/g,E=/\\(\\)?/g,le=/^\[object .+?Constructor\]$/,ue=/^(?:0|[1-9]\d*)$/,D={};D[x]=D[S]=D[C]=D[w]=D[ee]=D[te]=D[ne]=D[T]=D[re]=!0,D[i]=D[a]=D[y]=D[o]=D[b]=D[s]=D[c]=D[l]=D[u]=D[d]=D[f]=D[m]=D[h]=D[g]=D[v]=!1;var de=typeof Zc==`object`&&Zc&&Zc.Object===Object&&Zc,fe=typeof self==`object`&&self&&self.Object===Object&&self,pe=de||fe||Function(`return this`)(),me=t&&!t.nodeType&&t,he=me&&e&&!e.nodeType&&e,ge=he&&he.exports===me&&de.process,_e=function(){try{return ge&&ge.binding(`util`)}catch{}}(),ve=_e&&_e.isTypedArray;function ye(e,t){for(var n=-1,r=e?e.length:0;++n<r&&t(e[n],n,e)!==!1;);return e}function be(e,t){for(var n=-1,r=e?e.length:0;++n<r;)if(t(e[n],n,e))return!0;return!1}function xe(e){return function(t){return t?.[e]}}function Se(e,t){for(var n=-1,r=Array(e);++n<e;)r[n]=t(n);return r}function Ce(e){return function(t){return e(t)}}function we(e,t){return e?.[t]}function Te(e){var t=!1;if(e!=null&&typeof e.toString!=`function`)try{t=!!(e+``)}catch{}return t}function O(e){var t=-1,n=Array(e.size);return e.forEach(function(e,r){n[++t]=[r,e]}),n}function Ee(e,t){return function(n){return e(t(n))}}function De(e){var t=-1,n=Array(e.size);return e.forEach(function(e){n[++t]=e}),n}var Oe=Array.prototype,k=Function.prototype,ke=Object.prototype,Ae=pe[`__core-js_shared__`],je=function(){var e=/[^.]+$/.exec(Ae&&Ae.keys&&Ae.keys.IE_PROTO||``);return e?`Symbol(src)_1.`+e:``}(),Me=k.toString,Ne=ke.hasOwnProperty,Pe=ke.toString,Fe=RegExp(`^`+Me.call(Ne).replace(ce,`\\$&`).replace(/hasOwnProperty|(function).*?(?=\\\()| for .+?(?=\\\])/g,`$1.*?`)+`$`),Ie=pe.Symbol,Le=pe.Uint8Array,Re=Ee(Object.getPrototypeOf,Object),ze=Object.create,Be=ke.propertyIsEnumerable,Ve=Oe.splice,He=Ee(Object.keys,Object),Ue=j(pe,`DataView`),We=j(pe,`Map`),Ge=j(pe,`Promise`),Ke=j(pe,`Set`),qe=j(pe,`WeakMap`),Je=j(Object,`create`),Ye=pn(Ue),Xe=pn(We),Ze=pn(Ge),Qe=pn(Ke),$e=pn(qe),et=Ie?Ie.prototype:void 0,tt=et?et.valueOf:void 0,nt=et?et.toString:void 0;function rt(e){var t=-1,n=e?e.length:0;for(this.clear();++t<n;){var r=e[t];this.set(r[0],r[1])}}function it(){this.__data__=Je?Je(null):{}}function at(e){return this.has(e)&&delete this.__data__[e]}function ot(e){var t=this.__data__;if(Je){var r=t[e];return r===n?void 0:r}return Ne.call(t,e)?t[e]:void 0}function st(e){var t=this.__data__;return Je?t[e]!==void 0:Ne.call(t,e)}function ct(e,t){var r=this.__data__;return r[e]=Je&&t===void 0?n:t,this}rt.prototype.clear=it,rt.prototype.delete=at,rt.prototype.get=ot,rt.prototype.has=st,rt.prototype.set=ct;function lt(e){var t=-1,n=e?e.length:0;for(this.clear();++t<n;){var r=e[t];this.set(r[0],r[1])}}function ut(){this.__data__=[]}function dt(e){var t=this.__data__,n=jt(t,e);return n<0?!1:(n==t.length-1?t.pop():Ve.call(t,n,1),!0)}function ft(e){var t=this.__data__,n=jt(t,e);return n<0?void 0:t[n][1]}function pt(e){return jt(this.__data__,e)>-1}function mt(e,t){var n=this.__data__,r=jt(n,e);return r<0?n.push([e,t]):n[r][1]=t,this}lt.prototype.clear=ut,lt.prototype.delete=dt,lt.prototype.get=ft,lt.prototype.has=pt,lt.prototype.set=mt;function ht(e){var t=-1,n=e?e.length:0;for(this.clear();++t<n;){var r=e[t];this.set(r[0],r[1])}}function gt(){this.__data__={hash:new rt,map:new(We||lt),string:new rt}}function _t(e){return $t(this,e).delete(e)}function vt(e){return $t(this,e).get(e)}function yt(e){return $t(this,e).has(e)}function bt(e,t){return $t(this,e).set(e,t),this}ht.prototype.clear=gt,ht.prototype.delete=_t,ht.prototype.get=vt,ht.prototype.has=yt,ht.prototype.set=bt;function xt(e){var t=-1,n=e?e.length:0;for(this.__data__=new ht;++t<n;)this.add(e[t])}function St(e){return this.__data__.set(e,n),this}function Ct(e){return this.__data__.has(e)}xt.prototype.add=xt.prototype.push=St,xt.prototype.has=Ct;function wt(e){this.__data__=new lt(e)}function Tt(){this.__data__=new lt}function Et(e){return this.__data__.delete(e)}function Dt(e){return this.__data__.get(e)}function Ot(e){return this.__data__.has(e)}function kt(e,t){var n=this.__data__;if(n instanceof lt){var r=n.__data__;if(!We||r.length<199)return r.push([e,t]),this;n=this.__data__=new ht(r)}return n.set(e,t),this}wt.prototype.clear=Tt,wt.prototype.delete=Et,wt.prototype.get=Dt,wt.prototype.has=Ot,wt.prototype.set=kt;function At(e,t){var n=_n(e)||gn(e)?Se(e.length,String):[],r=n.length,i=!!r;for(var a in e)Ne.call(e,a)&&!(i&&(a==`length`||rn(a,r)))&&n.push(a);return n}function jt(e,t){for(var n=e.length;n--;)if(hn(e[n][0],t))return n;return-1}function Mt(e){return Sn(e)?ze(e):{}}var Nt=Xt();function Pt(e,t){return e&&Nt(e,t,kn)}function Ft(e,t){t=an(t,e)?[t]:Yt(t);for(var n=0,r=t.length;e!=null&&n<r;)e=e[fn(t[n++])];return n&&n==r?e:void 0}function It(e){return Pe.call(e)}function Lt(e,t){return e!=null&&t in Object(e)}function Rt(e,t,n,r,i){return e===t?!0:e==null||t==null||!Sn(e)&&!Cn(t)?e!==e&&t!==t:zt(e,t,Rt,n,r,i)}function zt(e,t,n,r,o,s){var c=_n(e),l=_n(t),u=a,d=a;c||(u=tn(e),u=u==i?f:u),l||(d=tn(t),d=d==i?f:d);var p=u==f&&!Te(e),m=d==f&&!Te(t),h=u==d;if(h&&!p)return s||=new wt,c||Tn(e)?Zt(e,t,n,r,o,s):A(e,t,u,n,r,o,s);if(!(o&2)){var g=p&&Ne.call(e,`__wrapped__`),_=m&&Ne.call(t,`__wrapped__`);if(g||_){var v=g?e.value():e,y=_?t.value():t;return s||=new wt,n(v,y,r,o,s)}}return h?(s||=new wt,Qt(e,t,n,r,o,s)):!1}function Bt(e,t,n,r){var i=n.length,a=i;if(e==null)return!a;for(e=Object(e);i--;){var o=n[i];if(o[2]?o[1]!==e[o[0]]:!(o[0]in e))return!1}for(;++i<a;){o=n[i];var s=o[0],c=e[s],l=o[1];if(o[2]){if(c===void 0&&!(s in e))return!1}else{var u=new wt,d;if(!(d===void 0?Rt(l,c,r,3,u):d))return!1}}return!0}function Vt(e){return!Sn(e)||sn(e)?!1:(bn(e)||Te(e)?Fe:le).test(pn(e))}function Ht(e){return Cn(e)&&xn(e.length)&&!!D[Pe.call(e)]}function Ut(e){return typeof e==`function`?e:e==null?jn:typeof e==`object`?_n(e)?Kt(e[0],e[1]):Gt(e):Mn(e)}function Wt(e){if(!cn(e))return He(e);var t=[];for(var n in Object(e))Ne.call(e,n)&&n!=`constructor`&&t.push(n);return t}function Gt(e){var t=en(e);return t.length==1&&t[0][2]?un(t[0][0],t[0][1]):function(n){return n===e||Bt(n,e,t)}}function Kt(e,t){return an(e)&&ln(t)?un(fn(e),t):function(n){var r=Dn(n,e);return r===void 0&&r===t?On(n,e):Rt(t,r,void 0,3)}}function qt(e){return function(t){return Ft(t,e)}}function Jt(e){if(typeof e==`string`)return e;if(wn(e))return nt?nt.call(e):``;var t=e+``;return t==`0`&&1/e==-1/0?`-0`:t}function Yt(e){return _n(e)?e:dn(e)}function Xt(e){return function(e,t,n){for(var r=-1,i=Object(e),a=n(e),o=a.length;o--;){var s=a[++r];if(t(i[s],s,i)===!1)break}return e}}function Zt(e,t,n,r,i,a){var o=i&2,s=e.length,c=t.length;if(s!=c&&!(o&&c>s))return!1;var l=a.get(e);if(l&&a.get(t))return l==t;var u=-1,d=!0,f=i&1?new xt:void 0;for(a.set(e,t),a.set(t,e);++u<s;){var p=e[u],m=t[u];if(r)var h=o?r(m,p,u,t,e,a):r(p,m,u,e,t,a);if(h!==void 0){if(h)continue;d=!1;break}if(f){if(!be(t,function(e,t){if(!f.has(t)&&(p===e||n(p,e,r,i,a)))return f.add(t)})){d=!1;break}}else if(!(p===m||n(p,m,r,i,a))){d=!1;break}}return a.delete(e),a.delete(t),d}function A(e,t,n,r,i,a,l){switch(n){case b:if(e.byteLength!=t.byteLength||e.byteOffset!=t.byteOffset)return!1;e=e.buffer,t=t.buffer;case y:return!(e.byteLength!=t.byteLength||!r(new Le(e),new Le(t)));case o:case s:case d:return hn(+e,+t);case c:return e.name==t.name&&e.message==t.message;case m:case g:return e==t+``;case u:var f=O;case h:var p=a&2;if(f||=De,e.size!=t.size&&!p)return!1;var v=l.get(e);if(v)return v==t;a|=1,l.set(e,t);var x=Zt(f(e),f(t),r,i,a,l);return l.delete(e),x;case _:if(tt)return tt.call(e)==tt.call(t)}return!1}function Qt(e,t,n,r,i,a){var o=i&2,s=kn(e),c=s.length;if(c!=kn(t).length&&!o)return!1;for(var l=c;l--;){var u=s[l];if(!(o?u in t:Ne.call(t,u)))return!1}var d=a.get(e);if(d&&a.get(t))return d==t;var f=!0;a.set(e,t),a.set(t,e);for(var p=o;++l<c;){u=s[l];var m=e[u],h=t[u];if(r)var g=o?r(h,m,u,t,e,a):r(m,h,u,e,t,a);if(!(g===void 0?m===h||n(m,h,r,i,a):g)){f=!1;break}p||=u==`constructor`}if(f&&!p){var _=e.constructor,v=t.constructor;_!=v&&`constructor`in e&&`constructor`in t&&!(typeof _==`function`&&_ instanceof _&&typeof v==`function`&&v instanceof v)&&(f=!1)}return a.delete(e),a.delete(t),f}function $t(e,t){var n=e.__data__;return on(t)?n[typeof t==`string`?`string`:`hash`]:n.map}function en(e){for(var t=kn(e),n=t.length;n--;){var r=t[n],i=e[r];t[n]=[r,i,ln(i)]}return t}function j(e,t){var n=we(e,t);return Vt(n)?n:void 0}var tn=It;(Ue&&tn(new Ue(new ArrayBuffer(1)))!=b||We&&tn(new We)!=u||Ge&&tn(Ge.resolve())!=p||Ke&&tn(new Ke)!=h||qe&&tn(new qe)!=v)&&(tn=function(e){var t=Pe.call(e),n=t==f?e.constructor:void 0,r=n?pn(n):void 0;if(r)switch(r){case Ye:return b;case Xe:return u;case Ze:return p;case Qe:return h;case $e:return v}return t});function nn(e,t,n){t=an(t,e)?[t]:Yt(t);for(var r,i=-1,a=t.length;++i<a;){var o=fn(t[i]);if(!(r=e!=null&&n(e,o)))break;e=e[o]}if(r)return r;var a=e?e.length:0;return!!a&&xn(a)&&rn(o,a)&&(_n(e)||gn(e))}function rn(e,t){return t??=r,!!t&&(typeof e==`number`||ue.test(e))&&e>-1&&e%1==0&&e<t}function an(e,t){if(_n(e))return!1;var n=typeof e;return n==`number`||n==`symbol`||n==`boolean`||e==null||wn(e)?!0:ae.test(e)||!ie.test(e)||t!=null&&e in Object(t)}function on(e){var t=typeof e;return t==`string`||t==`number`||t==`symbol`||t==`boolean`?e!==`__proto__`:e===null}function sn(e){return!!je&&je in e}function cn(e){var t=e&&e.constructor;return e===(typeof t==`function`&&t.prototype||ke)}function ln(e){return e===e&&!Sn(e)}function un(e,t){return function(n){return n!=null&&n[e]===t&&(t!==void 0||e in Object(n))}}var dn=mn(function(e){e=En(e);var t=[];return oe.test(e)&&t.push(``),e.replace(se,function(e,n,r,i){t.push(r?i.replace(E,`$1`):n||e)}),t});function fn(e){if(typeof e==`string`||wn(e))return e;var t=e+``;return t==`0`&&1/e==-1/0?`-0`:t}function pn(e){if(e!=null){try{return Me.call(e)}catch{}try{return e+``}catch{}}return``}function mn(e,t){if(typeof e!=`function`||t&&typeof t!=`function`)throw TypeError(`Expected a function`);var n=function(){var r=arguments,i=t?t.apply(this,r):r[0],a=n.cache;if(a.has(i))return a.get(i);var o=e.apply(this,r);return n.cache=a.set(i,o),o};return n.cache=new(mn.Cache||ht),n}mn.Cache=ht;function hn(e,t){return e===t||e!==e&&t!==t}function gn(e){return yn(e)&&Ne.call(e,`callee`)&&(!Be.call(e,`callee`)||Pe.call(e)==i)}var _n=Array.isArray;function vn(e){return e!=null&&xn(e.length)&&!bn(e)}function yn(e){return Cn(e)&&vn(e)}function bn(e){var t=Sn(e)?Pe.call(e):``;return t==l||t==`[object GeneratorFunction]`}function xn(e){return typeof e==`number`&&e>-1&&e%1==0&&e<=r}function Sn(e){var t=typeof e;return!!e&&(t==`object`||t==`function`)}function Cn(e){return!!e&&typeof e==`object`}function wn(e){return typeof e==`symbol`||Cn(e)&&Pe.call(e)==_}var Tn=ve?Ce(ve):Ht;function En(e){return e==null?``:Jt(e)}function Dn(e,t,n){var r=e==null?void 0:Ft(e,t);return r===void 0?n:r}function On(e,t){return e!=null&&nn(e,t,Lt)}function kn(e){return vn(e)?At(e):Wt(e)}function An(e,t,n){var r=_n(e)||Tn(e);if(t=Ut(t),n==null)if(r||Sn(e)){var i=e.constructor;n=r?_n(e)?new i:[]:bn(i)?Mt(Re(e)):{}}else n={};return(r?ye:Pt)(e,function(e,r,i){return t(n,e,r,i)}),n}function jn(e){return e}function Mn(e){return an(e)?xe(fn(e)):qt(e)}e.exports=An})(th,th.exports),th.exports)}rh();var{Commands:ih}=ef,ah=A(null);function oh(e,t){try{let n=JSON.stringify({event:e,data:t,ts:new Date().toISOString(),ua:navigator.userAgent});navigator.sendBeacon(`/.proxy/api/debug-log`,new Blob([n],{type:`application/json`}))}catch{}}function sh(){oh(`script:loaded`,{persisted:!1}),window.addEventListener(`pageshow`,e=>{oh(`pageshow`,{persisted:e.persisted}),e.persisted&&window.location.reload()}),window.addEventListener(`pagehide`,e=>{oh(`pagehide`,{persisted:e.persisted})}),document.addEventListener(`visibilitychange`,()=>{oh(`visibilitychange`,{state:document.visibilityState})}),window.onerror=function(e,t,n,r){if(oh(`window.onerror`,{message:e,source:t,lineno:n,colno:r}),t&&!t.includes(`main.js`)&&!t.includes(`localhost`))return!0;ah.value=`JS 錯誤：${e} (L${n})`},window.onunhandledrejection=function(e){let t=e.reason?.message||String(e.reason);oh(`unhandledrejection`,{msg:t}),ah.value=`未處理的 Rejection：${t}`}}function ch(){return`/.proxy/api`}async function lh(e,t={}){let n=`${ch()}${e}`,r=await fetch(n,t);if(!r.ok){let e=`HTTP ${r.status}`;try{let t=await r.json();t.error?.message&&(e=t.error.message)}catch{}throw Error(e)}let i=await r.json();if(i.ok!==void 0){if(!i.ok)throw Error(i.error?.message||`未知伺服器錯誤`);return i.data}return i}var uh={async getCharts(){let e=await lh(`/charts`);return Array.isArray(e)?e:e.charts||[]},async getChartData(e){return await lh(`/chart${e?`?file=${encodeURIComponent(e)}`:``}`)},async getResumeSession(e){return await lh(`/resume?userId=${encodeURIComponent(e)}`)},async submitRender(e){return await lh(`/render`,{method:`POST`,headers:{"Content-Type":`application/json`},body:JSON.stringify(e)})}};function dh(){let e=A(`正在初始化 SDK…`),t=A(`status-connecting`),n=A(null),r=A(null),i=new URLSearchParams(window.location.search).get(`client_id`)||`1527644569133649960`;function a(n,r){e.value=n,t.value=r}async function o(){oh(`setup:start`),a(`連線中：正在初始化 SDK…`,`status-connecting`);let e=new wm(i,{disableConsoleLogOverride:!0});r.value=e,e.platform===`mobile`&&document.documentElement.classList.add(`platform-mobile`),await e.ready(),oh(`setup:sdk_ready`),a(`連線中：正在向用戶端申請授權…`,`status-connecting`);let{code:t}=await e.commands.authorize({client_id:i,response_type:`code`,state:``,prompt:`none`,scope:[`identify`]});oh(`setup:authorized`),a(`連線中：正在與本地後端交換 Token…`,`status-connecting`);let o=await fetch(`/.proxy/api/token`,{method:`POST`,headers:{"Content-Type":`application/json`},body:JSON.stringify({code:t})});if(!o.ok)throw Error(`token 交換失敗：${o.status}`);let{access_token:s}=await o.json();return oh(`setup:token_exchanged`),a(`連線中：正在進行用戶身份驗證…`,`status-connecting`),n.value=await e.commands.authenticate({access_token:s}),oh(`setup:authenticated`,{username:n.value.user.username}),{fetchChartPath:`/.proxy/api/chart`}}function s(){return o()}async function c(e){try{let t=await uh.getResumeSession(n.value.user.id);if(typeof t.startComma!=`number`||typeof t.endComma!=`number`)return null;let r=Math.max(0,Math.min(t.startComma,e));return{start:r,end:Math.max(r,Math.min(t.endComma,e))}}catch(e){return console.warn(`[Resume] 還原續看位置失敗:`,e),null}}async function l(e){return uh.submitRender({channelId:r.value?.channelId??null,userId:n.value.user.id,username:n.value.user.global_name??n.value.user.username,...e})}async function u(e=`local`,t=``){try{return await uh.getCharts(e,t)}catch(e){return console.warn(`Failed to fetch chart list:`,e),[]}}async function d(e,t=`local`){return await uh.getChartData(e,t)}async function f(){r.value&&await Promise.resolve(r.value.close()).catch(e=>console.error(`Failed to close activity:`,e))}return{standalone:!1,statusText:e,statusClass:t,auth:n,connect:s,fetchResumeSession:c,submitRender:l,closeActivity:f,setStatus:a,fetchChartList:u,fetchChartData:d}}var fh={class:`container`},ph={class:`main-content`},mh={class:`left-panel`},hh={id:`hud`},gh={class:`player-row`},_h={class:`right-panel`};sh(),Io({__name:`App`,setup(e){let t=Oc(),n=Pc(t),r=qc(),i=Xc(t,n),a=dh(),o=A(`連線中…`),s=A(!1),c=A(!1),l=A({text:``,type:``}),u=A(!1),d=A({}),f=A(!1),p=A(``),m=A(``),h=A(!1),g=A([]),_=A(``),v=A(null),y=A(null),b=!1;async function x(e){if(!(!e||e===_.value)){c.value=!1,n.pause(),te(`🔄 正在切換測試譜面…`,`info`);try{let r=await a.fetchChartData(e);t.loadFromText(r.text,r.name),o.value=t.chartName.value,_.value=r.filename||e,n.resetPlaybackState();let s=t.C.value.length-2;i.initBounds(s,{start:0,end:s}),n.seek(0),i.setActiveEndpoint(null),c.value=!0,te(`✅ 已切換至譜面：${t.chartName.value}`,`success`)}catch(e){console.error(`切換譜面失敗:`,e),te(`❌ 切換譜面失敗：${e.message}`,`error`),c.value=!0}}}let S=Aa(()=>t.DATA.value?Math.round(t.DATA.value.meta.bpm):`-`),C=Aa(()=>t.DATA.value?t.M.value.length-1:`-`),w=Aa(()=>t.DATA.value?t.N.value.length:`-`),ee=Aa(()=>{if(!t.DATA.value)return``;let e=t.DATA.value.meta.counts;return`TAP ${e.tap} · HOLD ${e.hold} · SLIDE ${e.slide} · TOUCH ${e.touch} · BREAK ${e.break} — ALL ${t.DATA.value.meta.total}`});function te(e,t){l.value={text:e,type:t}}Hn(()=>i.rangeMessage.value,e=>te(e.text,e.type)),Hn(ah,e=>{e&&a.setStatus(e,`status-error`)});async function ne(){if(!b){b=!0,s.value=!1,o.value=`連線中…`;try{let{fetchChartPath:e}=await a.connect(),r=await a.fetchChartList();g.value=r,a.setStatus(`連線中：正在獲取譜面資料…`,`status-connecting`),await t.loadChart(e),o.value=t.chartName.value;let s=r.find(e=>e.name===t.chartName.value);s&&(_.value=s.id),oh(`setup:chart_fetched`,{name:t.chartName.value}),a.setStatus(`連線中：正在載入圖片素材…`,`status-connecting`),await n.loadAssets(),oh(`setup:assets_loaded`),n.initEngine();let l=t.C.value.length-2;i.initBounds(l,{start:0,end:l}),c.value=!0,a.setStatus(`連線成功：${a.auth.value.user.global_name??a.auth.value.user.username}`,`status-ready`),n.resizeCanvas(),i.setActiveEndpoint(null);let u=await a.fetchResumeSession(l);u&&(i.initBounds(l,u),te(`↩️ 已回到訊息中那一段的位置`,`info`)),n.seek(u?t.C.value[i.range.value.start]??0:0),oh(`setup:complete`,u?{resumed:[i.range.value.start,i.range.value.end]}:void 0),b=!1}catch(e){console.error(e);let t=e?.message||String(e);oh(`setup:error`,{msg:t}),o.value=`連線中斷`,a.setStatus(`初始化失敗：${t}`,`status-error`),s.value=!0,b=!1}}}function T(){te(``,``),ne()}function re(e){n.jumpByTime(e),i.syncActiveEndpointToPlayhead()}function ie(e){n.jumpToAdjacentNote(e),i.syncActiveEndpointToPlayhead()}function ae(e){n.seekComma(n.currentCommaIndex()+e),i.syncActiveEndpointToPlayhead()}function oe(){let e=v.value?.toggleButton,t=y.value?.panelRoot;if(!e||!t)return;let n=e.getBoundingClientRect(),r=t.offsetWidth;d.value={top:`${n.bottom+6}px`,left:`${Math.max(8,Math.min(n.left,window.innerWidth-r-8))}px`}}async function se(e){e?.stopPropagation(),u.value=!u.value,u.value&&(await Cn(),oe(),r.unlockAudio())}function ce(){u.value=!1}function E(){u.value&&oe()}function le(e){n.setHs(e)}function ue(){if(i.range.value.end-i.range.value.start+1<=0){te(`⚠️ 選取範圍為空區間，請重新選取。`,`error`);return}let e=i.buildExportPreview();p.value=e.meta,m.value=e.text,f.value=!0}function D(){f.value=!1}function de(){D(),fe()}async function fe(){c.value=!1,te(`🎬 正在向 Bot 發送渲染請求，請稍候…`,`info`);let e=i.rangeDuration.value;try{let n=await a.submitRender({simai:t.chartText.value,startComma:i.range.value.start,endComma:i.range.value.end,chartName:o.value,cleanCut:i.cleanCut.value}),r=await n.json().catch(()=>({}));if(n.ok){te(`✅ 請求成功${e>30?`（僅渲染前 30 秒）`:``}！正在關閉視窗並在頻道中開始渲染…`,`success`),setTimeout(()=>a.closeActivity(),800);return}te(`❌ 渲染失敗：${r.error||n.statusText}`,`error`)}catch(e){console.error(`Export request failed:`,e),te(`❌ 網路錯誤，無法傳送請求：${e.message}`,`error`)}c.value=!0}function pe(e){if(e.key!==`ArrowLeft`&&e.key!==`ArrowRight`||!t.DATA.value||!c.value)return;let r=e.key===`ArrowLeft`?-1:1;if(!i.activeEndpoint.value){if(e.preventDefault(),e.altKey){let e=n.realTime.value;n.seek(Math.max(0,Math.round((e+r*.01)*1e3)/1e3))}else if(e.ctrlKey||e.metaKey){let e=n.realTime.value;n.seek(Math.max(0,Math.round((e+r*.1)*1e3)/1e3))}else e.shiftKey?n.jumpByTime(r*3):n.seekComma(n.currentCommaIndex()+r);return}e.preventDefault(),i.moveActiveEndpoint(r,e.shiftKey)}return ur(()=>{document.addEventListener(`keydown`,pe),document.addEventListener(`click`,ce),window.addEventListener(`resize`,E),ne()}),mr(()=>{document.removeEventListener(`keydown`,pe),document.removeEventListener(`click`,ce),window.removeEventListener(`resize`,E)}),(e,b)=>(Bi(),Gi(Pi,null,[M(`div`,fh,[Zi(Go,{ref_key:`headerRef`,ref:v,"song-title":o.value,"status-text":j(a).statusText.value,"status-class":j(a).statusClass.value,"meta-line":ee.value,"show-retry":s.value,"settings-disabled":!c.value,"chart-list":g.value,"current-chart":_.value,onToggleSettings:se,onRetry:T,onSelectChart:x},null,8,[`song-title`,`status-text`,`status-class`,`meta-line`,`show-retry`,`settings-disabled`,`chart-list`,`current-chart`]),Zi(ns,{ref_key:`settingsPanelRef`,ref:y,open:u.value,"position-style":d.value,speed:j(n).speed.value,hs:j(n).hs.value,"sfx-volume":j(r).sfxVolume.value,"sfx-mode-label":j(r).sfxModeLabel.value,"sfx-off":j(r).sfxMode.value===`off`,"clean-cut":j(i).cleanCut.value,disabled:!c.value,"onUpdate:speed":j(n).setSpeed,"onUpdate:hs":le,"onUpdate:sfxVolume":j(r).setSfxVolume,onCycleSfxMode:j(r).cycleSfxMode,onToggleCleanCut:b[0]||=e=>j(i).cleanCut.value=!j(i).cleanCut.value},null,8,[`open`,`position-style`,`speed`,`hs`,`sfx-volume`,`sfx-mode-label`,`sfx-off`,`clean-cut`,`disabled`,`onUpdate:speed`,`onUpdate:sfxVolume`,`onCycleSfxMode`]),M(`div`,ph,[M(`div`,mh,[M(`div`,hh,[M(`span`,null,[b[5]||=ta(`BPM `,-1),M(`b`,null,O(S.value),1)]),M(`span`,null,[b[6]||=ta(`小節 `,-1),M(`b`,null,O(j(n).hudMeasure.value),1),b[7]||=ta(` / `,-1),M(`span`,null,O(C.value),1)]),M(`span`,null,[b[8]||=ta(`Combo `,-1),M(`b`,null,O(j(n).hudCombo.value),1),b[9]||=ta(` / `,-1),M(`span`,null,O(w.value),1)])]),M(`div`,gh,[Zi(ds,{side:`left`,playing:j(n).playing.value,disabled:!c.value,onJumpTime:re,onStepNote:ie,onStepComma:ae,onTogglePlay:b[1]||=e=>j(n).togglePlay()},null,8,[`playing`,`disabled`]),Zi(ms,{attach:j(n).attachCanvas,detach:j(n).detachCanvas},null,8,[`attach`,`detach`]),Zi(ds,{side:`right`,playing:j(n).playing.value,disabled:!c.value,onJumpTime:re,onStepNote:ie,onStepComma:ae,onTogglePlay:b[2]||=e=>j(n).togglePlay()},null,8,[`playing`,`disabled`])])]),M(`div`,_h,[Zi(js,{chart:j(t),engine:j(n),"range-sel":j(i),disabled:!c.value,onExport:ue,onPreview:b[3]||=e=>h.value=!0},null,8,[`chart`,`engine`,`range-sel`,`disabled`]),Zi(Is),Zi(Rs,{text:l.value.text,type:l.value.type},null,8,[`text`,`type`])])])]),Zi(Us,{open:f.value,meta:p.value,"preview-text":m.value,onConfirm:de,onCancel:D},null,8,[`open`,`meta`,`preview-text`]),Zi(Wc,{open:h.value,chart:j(t),"range-sel":j(i),onClose:b[4]||=e=>h.value=!1},null,8,[`open`,`chart`,`range-sel`])],64))}}).mount(`#app`);
```

# public/assets/index-DSmu9VIY.css

```css
.preview-offset-panel[data-v-69ac6d7c]{background:#ffffff0d;border-radius:8px;gap:12px;margin-top:10px;padding:10px 14px;display:flex}.offset-field[data-v-69ac6d7c]{flex-direction:column;flex:1;gap:4px;display:flex}.offset-field label[data-v-69ac6d7c]{color:#a0aec0;font-size:.78rem}.offset-field strong[data-v-69ac6d7c]{color:#38bdf8}.offset-field input[type=range][data-v-69ac6d7c]{accent-color:#38bdf8;width:100%}.preview-footer-options[data-v-69ac6d7c]{justify-content:flex-end;margin-top:8px;display:flex}.auto-loop-toggle[data-v-69ac6d7c]{color:#e2e8f0;cursor:pointer;-webkit-user-select:none;user-select:none;align-items:center;gap:6px;font-size:.82rem;display:inline-flex}.auto-loop-toggle input[type=checkbox][data-v-69ac6d7c]{accent-color:#38bdf8;cursor:pointer;width:16px;height:16px}@font-face{font-family:combo;src:url(./Inter-c8O0ljhh.ttf)format("truetype")}@font-face{font-family:mono;src:url(./ShareTechMono-Regular-B9ZeNMwq.ttf)format("truetype")}:root{--bg:#14142b;--panel:#1d1d3d;--line:#34346a;--text:#e8e6f5;--dim:#8f8cb8;--tap:#ff4fa5;--slide:#38c8ff;--hold:#ffd23e;--touch:#52e0a0;--brk:#ff8a1e;--mine:#737373;--play:#ff4fa5}*{box-sizing:border-box;margin:0;padding:0}html,body{background:var(--bg);color:var(--text);justify-content:center;align-items:center;width:100vw;height:100vh;padding:10px;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Noto Sans TC,sans-serif;display:flex;overflow:hidden}.container{border:1px solid var(--line);background:#191937;border-radius:16px;flex-direction:column;align-items:center;gap:10px;width:100%;max-width:900px;max-height:calc(100vh - 20px);padding:15px 20px;display:flex;overflow:hidden;box-shadow:0 10px 30px #0006}.main-content{flex-direction:row;flex:1;align-items:stretch;gap:20px;width:100%;display:flex;overflow:hidden}.left-panel{flex-direction:column;flex-shrink:0;justify-content:flex-start;align-items:center;gap:12px;width:440px;display:flex}.player-row{height:320px}.right-panel{flex-direction:column;flex:1;justify-content:space-between;gap:10px;min-width:0;display:flex;overflow:hidden}header{text-align:center;border-bottom:1px solid var(--line);width:100%;padding-bottom:10px;position:relative}header h1{letter-spacing:.04em;color:#fff;margin:0;font-size:18px;font-weight:700}.header-title-row{flex-wrap:wrap;justify-content:center;align-items:center;gap:8px;display:flex}.chart-select-dropdown{background:var(--bg);color:var(--slide);border:1px solid var(--line);cursor:pointer;border-radius:6px;outline:none;padding:3px 8px;font-size:11px;font-weight:700;transition:border-color .12s,background .12s}.chart-select-dropdown:hover:not(:disabled){border-color:var(--slide);background:#2a2a55}.chart-select-dropdown:disabled{opacity:.5;cursor:not-allowed}.status-connecting{color:#f0b232;margin-top:4px;font-size:12px}.status-ready{color:#23a55a;margin-top:4px;font-size:12px}.status-error{color:#f23f43;margin-top:4px;font-size:12px}.btn-retry{color:var(--text);cursor:pointer;background:#2a2a55;border:1px solid #5865f2;border-radius:8px;margin-top:8px;padding:6px 16px;font-size:13px;transition:background .12s;display:block}.btn-retry:hover{background:#5865f2}header .sub{display:none}#stage{flex:auto;justify-content:center;align-items:center;min-width:0;display:flex;position:relative}#chartCanvas{border:1px solid var(--line);aspect-ratio:1;background:#0c0c1e;border-radius:14px;width:auto;max-width:100%;height:100%;display:block}#hud{width:100%;color:var(--dim);font-variant-numeric:tabular-nums;flex-shrink:0;justify-content:space-between;gap:8px;font-size:12px;display:flex}#hud b{color:var(--text);font-weight:600}.player-row{justify-content:center;align-items:stretch;gap:8px;width:100%;min-height:0;display:flex}.nav-col{flex-direction:column;flex:none;gap:6px;width:52px;display:flex}.nav-col button{flex:1}.control-buttons button,.nav-col button{background:var(--panel);color:var(--text);border:1px solid var(--line);cursor:pointer;text-align:center;white-space:nowrap;touch-action:manipulation;border-radius:8px;flex:1;min-width:0;padding:8px 2px;font-size:12px;transition:background .12s}.control-settings{flex-wrap:wrap;justify-content:center;align-items:center;gap:12px;width:100%;display:flex}.speedbox input[type=range]{appearance:none;cursor:pointer;touch-action:none;background:0 0;width:78px;height:22px}.speedbox input[type=range]::-webkit-slider-runnable-track{background:#26264c;border-radius:3px;height:5px}.speedbox input[type=range]::-webkit-slider-thumb{appearance:none;border:3px solid var(--slide);background:#fff;border-radius:50%;width:15px;height:15px;margin-top:-5px;box-shadow:0 1px 4px #00000080}.speedbox input[type=range]::-moz-range-track{background:#26264c;border-radius:3px;height:5px}.speedbox input[type=range]::-moz-range-thumb{border:3px solid var(--slide);background:#fff;border-radius:50%;width:13px;height:13px}.speedbox input[type=range]:disabled::-webkit-slider-thumb{background:var(--dim);border-color:var(--dim)}.speedbox b,.speedbox #speedVal,.speedbox #hsVal,.speedbox #sfxVal{color:var(--text);font-variant-numeric:tabular-nums;min-width:38px}.btn-sfx-mode{background:var(--panel);color:var(--text);border:1px solid var(--line);cursor:pointer;white-space:nowrap;touch-action:manipulation;border-radius:8px;padding:6px 10px;font-size:12px;transition:background .12s,border-color .12s}.btn-sfx-mode:hover{background:#2a2a55}.sfx-off #sfxSlider,.sfx-off #sfxVal{display:none}.control-buttons button:hover:not(:disabled),.nav-col button:hover:not(:disabled){background:#2a2a55}.control-buttons button:disabled,.nav-col button:disabled{opacity:.4;cursor:not-allowed}.btn-play{background:var(--play);border-color:var(--play);color:#fff;font-size:14px;font-weight:700}.nav-col button.btn-play:hover:not(:disabled){background:var(--play);opacity:.85}#settingsMenu{z-index:30;position:absolute;top:0;left:0}.btn-settings{background:var(--panel);color:var(--text);border:1px solid var(--line);cursor:pointer;touch-action:manipulation;border-radius:8px;width:38px;height:38px;font-size:17px;line-height:1;transition:background .12s,border-color .12s}.btn-settings:hover:not(:disabled){border-color:var(--slide);background:#2a2a55}.btn-settings:disabled{opacity:.4;cursor:not-allowed}#settingsPanel{z-index:60;background:var(--panel);border:1px solid var(--line);border-radius:10px;flex-direction:column;align-items:stretch;gap:8px;width:max-content;min-width:210px;max-width:calc(100vw - 24px);padding:10px 12px;position:fixed;box-shadow:0 10px 28px #0000008c}#settingsPanel[hidden]{display:none}.speedbox{color:var(--dim);align-items:center;gap:4px;font-size:12px;display:flex}.speedbox select{background:var(--panel);color:var(--text);border:1px solid var(--line);border-radius:6px;padding:5px 6px;font-size:12px}#timeline{background:var(--panel);border:1px solid var(--line);border-radius:12px;width:100%;min-width:0;padding:12px 14px 10px}#densityWrap{cursor:pointer;border-radius:6px;position:relative;overflow:hidden}#densityCanvas{z-index:10;width:100%;height:50px;display:block;position:relative}#timeLabels{color:var(--dim);font-variant-numeric:tabular-nums;justify-content:space-between;margin:2px 2px 6px;font-size:10px;display:flex}#measureSlider{appearance:none;cursor:pointer;background:0 0;width:100%;height:20px;display:block}#measureSlider:disabled{cursor:not-allowed}#measureSlider::-webkit-slider-runnable-track{background-color:#26264c;border-radius:3px;height:6px}#measureSlider::-webkit-slider-thumb{appearance:none;background:var(--tap);width:16px;height:16px;box-shadow:0 0 6px var(--tap);border:2px solid #fff;border-radius:50%;margin-top:-5px}#measureSlider.active::-webkit-slider-thumb{box-shadow:0 0 0 3px #ff4fa54d, 0 0 6px var(--tap)}.timeline-debug-bar{border:1px solid var(--line);background:#00000040;border-radius:8px;align-items:center;gap:6px;margin:8px 0 12px;padding:6px 10px;font-size:11px;display:flex}.debug-label{color:var(--dim);white-space:nowrap;font-size:11px}.offset-val-text{color:var(--slide);font-family:mono,monospace;font-size:12px;font-weight:700}.debug-time-input{background:var(--bg);width:68px;color:var(--slide);border:1px solid var(--line);text-align:right;border-radius:4px;padding:3px 6px;font-family:mono,monospace;font-size:12px;font-weight:700}.debug-unit{color:var(--dim);margin-right:4px;font-size:11px}.debug-btn-group{gap:3px;margin-left:auto;display:flex}.debug-btn-group button{background:var(--bg);color:var(--text);border:1px solid var(--line);cursor:pointer;border-radius:4px;padding:3px 6px;font-family:mono,monospace;font-size:10px;transition:background .12s,border-color .12s}.debug-btn-group button:hover:not(:disabled){border-color:var(--slide);background:#2a2a55}.debug-btn-group button:disabled{opacity:.4;cursor:not-allowed}#measureTicks{color:var(--dim);font-variant-numeric:tabular-nums;justify-content:space-between;margin-top:2px;font-size:9px;display:flex}#legend{color:var(--dim);flex-wrap:wrap;justify-content:center;gap:10px;font-size:11px;display:flex}#legend i{border-radius:2px;width:8px;height:8px;margin-right:4px;display:inline-block}#rangePanel{border:1px solid var(--line);background:#0000002e;border-radius:10px;margin-top:6px;padding:8px 10px 10px}#rangeHeader{color:var(--dim);align-items:baseline;gap:8px;margin-bottom:10px;font-size:11px;display:flex}.range-title{color:var(--text);font-size:12px;font-weight:700}#rangeLabel{font-variant-numeric:tabular-nums;color:var(--slide);margin-left:auto;font-weight:600}.range-row{align-items:center;gap:6px;margin-top:24px;display:flex}.range-row-label{width:16px;color:var(--dim);text-align:center;flex:none;font-size:11px}.range-track{flex:1;min-width:0;height:20px;position:relative}.range-track-bg{background:#26264c;border-radius:3px;height:5px;position:absolute;top:50%;left:7px;right:7px;transform:translateY(-50%)}.range-track input{appearance:none;pointer-events:none;touch-action:none;background:0 0;width:100%;height:20px;margin:0;position:absolute;top:0;left:0}.range-track input::-webkit-slider-runnable-track{background:0 0;height:5px;margin-top:7.5px}.range-track input::-moz-range-track{background:0 0;height:5px;margin-top:7.5px}.range-tip{background:var(--panel);border:1px solid var(--line);max-width:96px;color:var(--text);white-space:nowrap;text-overflow:ellipsis;pointer-events:none;z-index:5;border-radius:6px;margin-bottom:6px;padding:2px 5px;font-family:mono,monospace;font-size:10px;line-height:1.3;position:absolute;bottom:100%;overflow:hidden;transform:translate(-50%);box-shadow:0 2px 6px #0006}.range-tip:after{content:"";border:4px solid #0000;border-top-color:var(--line);position:absolute;top:100%;left:50%;transform:translate(-50%)}.range-track input::-webkit-slider-thumb{appearance:none;pointer-events:auto;border:3px solid var(--mine);cursor:ew-resize;background:#fff;border-radius:50%;width:15px;height:15px;margin-top:-5px;transition:transform .12s;box-shadow:0 1px 4px #00000080}.range-track input::-moz-range-thumb{appearance:none;pointer-events:auto;border:3px solid var(--mine);cursor:ew-resize;background:#fff;border-radius:50%;width:13px;height:13px;transition:transform .12s;box-shadow:0 1px 4px #00000080}.range-track input:hover:not(:disabled)::-webkit-slider-thumb{transform:scale(1.15)}.range-track input:active:not(:disabled)::-webkit-slider-thumb{transform:scale(1.15)}.range-track input:disabled::-webkit-slider-thumb{background:var(--dim);border-color:var(--dim);cursor:not-allowed}.range-track input:disabled::-moz-range-thumb{background:var(--dim);border-color:var(--dim);cursor:not-allowed}.range-track input.active::-webkit-slider-thumb{border-color:var(--tap);box-shadow:0 0 0 3px #ff4fa54d,0 1px 4px #00000080}.range-track input.active::-moz-range-thumb{border-color:var(--tap)}.range-track.over-limit input:not(:disabled)::-webkit-slider-thumb{border-color:#f23f43}.range-track.over-limit input:not(:disabled)::-moz-range-thumb{border-color:#f23f43}#rangeLabel.over-limit{color:#f23f43}#rangeEnds{justify-content:space-between;gap:6px;margin-bottom:8px;display:flex}#rangeActions{align-items:center;gap:6px;margin-bottom:8px;display:flex}#rangeActions button{flex:1}#rangeEnds button,#rangeActions button{background:var(--bg);color:var(--text);border:1px solid var(--line);cursor:pointer;border-radius:6px;padding:5px 10px;font-size:11px;transition:background .12s,border-color .12s}#rangeEnds button:hover:not(:disabled),#rangeActions button:hover:not(:disabled){border-color:var(--slide);background:#2a2a55}#rangeEnds button:disabled,#rangeActions button:disabled{opacity:.4;cursor:not-allowed}.offset-test-panel{border:1px solid var(--line);background:#00000040;border-radius:8px;flex-direction:column;gap:6px;margin:6px 0 10px;padding:8px 10px;display:flex}.offset-test-header{justify-content:space-between;align-items:center;margin-bottom:2px;display:flex}.offset-test-title{color:var(--text);font-size:11px;font-weight:700}.btn-offset-reset{background:var(--bg);color:var(--dim);border:1px solid var(--line);cursor:pointer;border-radius:4px;padding:2px 6px;font-size:10px}.btn-offset-reset:hover:not(:disabled){color:var(--text);border-color:var(--slide)}.offset-label{color:var(--dim);white-space:nowrap;font-size:11px}.offset-label b{color:var(--slide);font-family:mono,monospace}.offset-presets{gap:3px;display:flex}.offset-presets button{background:var(--bg);color:var(--dim);border:1px solid var(--line);cursor:pointer;border-radius:4px;padding:2px 6px;font-family:mono,monospace;font-size:10px;transition:all .12s}.offset-presets button.active{background:var(--slide);color:#fff;border-color:var(--slide);font-weight:700}.offset-presets button:hover:not(:disabled){color:var(--text);border-color:var(--slide);background:#2a2a55}.offset-presets button:disabled{opacity:.4;cursor:not-allowed}.offset-panel{border:1px dashed var(--line);background:#00000038;border-radius:8px;flex-direction:column;gap:6px;margin:6px 0 10px;padding:6px 8px;display:flex}.offset-row{justify-content:space-between;align-items:center;gap:6px;font-size:11px;display:flex}.offset-title{color:var(--dim);white-space:nowrap;font-size:11px}.offset-title b{color:var(--slide)}.offset-btn-group{gap:3px;display:flex}.offset-btn-group button{background:var(--bg);color:var(--text);border:1px solid var(--line);cursor:pointer;border-radius:4px;padding:2px 6px;font-size:10px;transition:background .12s,border-color .12s}.offset-btn-group button:hover:not(:disabled){border-color:var(--slide);background:#2a2a55}.offset-btn-group button:disabled{opacity:.4;cursor:not-allowed}.btn-export{color:#fff;cursor:pointer;background:#23a55a;border:1px solid #23a55a;border-radius:8px;width:100%;padding:10px;font-size:13px;font-weight:700;transition:opacity .2s;display:block}.btn-export:hover:not(:disabled){opacity:.9}.btn-export:disabled{opacity:.4;cursor:not-allowed}.app-footer{width:100%;min-height:20px}.modal-overlay{z-index:100;background:#0009;justify-content:center;align-items:center;padding:16px;display:flex;position:fixed;inset:0}.modal-overlay[hidden]{display:none}.modal-box{background:var(--panel);border:1px solid var(--line);border-radius:12px;flex-direction:column;gap:10px;width:100%;max-width:480px;max-height:80vh;padding:16px;display:flex;box-shadow:0 10px 28px #0000008c}.modal-box h3{color:var(--text);font-size:15px}.modal-meta{color:var(--dim);font-size:12px}.modal-simai-text{white-space:pre-wrap;word-break:break-all;background:var(--bg);border:1px solid var(--line);min-height:0;color:var(--text);border-radius:8px;flex:1;padding:10px;font-family:mono,monospace;font-size:12px;line-height:1.5;overflow:auto}.modal-actions{gap:8px;display:flex}.modal-actions .btn-export{flex:1}.btn-modal-cancel{border:1px solid var(--line);color:var(--dim);cursor:pointer;background:0 0;border-radius:8px;flex:1;padding:10px;font-size:13px}.preview-modal-box{align-items:stretch;width:94vw;max-width:600px;max-height:94vh}.preview-stage{justify-content:center;align-items:center;width:100%;padding:8px 0;display:flex}#previewStage{aspect-ratio:1;justify-content:center;align-items:center;width:min(100%,480px,52vh);height:min(100%,480px,52vh);margin:0 auto;display:flex}#previewCanvas{border:1px solid var(--line);aspect-ratio:1;background:#0c0c1e;border-radius:14px;display:block;width:100%!important;height:100%!important}.btn-modal-cancel:hover{background:#2a2a55}.message{text-align:center;margin:0;font-size:12px;font-weight:500;line-height:1.5}.message.success{color:#23a55a}.message.error{color:#f23f43}.message.info{color:#38c8ff}#timeLabels span,#measureTicks span{text-align:center;flex:1}#timeLabels span:first-child,#measureTicks span:first-child{text-align:left}#timeLabels span:last-child,#measureTicks span:last-child{text-align:right}@media (width<=768px){html,body{height:100%;overflow:hidden}body{padding-top:84px;padding-bottom:max(8px, env(safe-area-inset-bottom,0px));align-items:flex-start}.platform-mobile body{padding-top:calc(env(safe-area-inset-top,24px) + 50px)}.container{gap:6px;max-width:500px;height:100%;max-height:100%;padding:10px 12px;overflow:hidden}.main-content{flex-direction:column;flex:1;align-items:center;gap:8px;min-height:0;overflow:hidden}.left-panel,.right-panel{width:100%;max-width:360px}.left-panel{flex:auto;gap:8px;min-height:0}.player-row{flex:auto;height:auto;min-height:132px;max-height:360px}.nav-col{width:46px}.right-panel{flex:none;gap:6px;min-height:0;overflow:hidden}#timeline{flex-shrink:0}#legend,#timeLabels,#measureTicks{display:none}.app-footer{min-height:0}#densityCanvas{height:32px}#timeline{padding:6px 8px 8px}header{padding-bottom:4px}header .sub{font-size:10px}}@media (width<=480px){.container{border-radius:12px;gap:8px;padding:12px}header h1{font-size:16px}#timeline{padding:8px 10px}#rangeEnds,#rangeActions{gap:4px}}@media (width<=768px){.nav-col button{padding:6px 2px;font-size:13px}.btn-play{font-size:15px}.btn-settings{width:42px;height:42px;font-size:18px}.speedbox{gap:6px}.speedbox input[type=range]{flex:1;width:100%;min-width:0;height:34px}.speedbox input[type=range]::-webkit-slider-thumb{width:20px;height:20px;margin-top:-8px}.speedbox #speedVal,.speedbox #hsVal,.speedbox #sfxVal{min-width:34px;font-size:11px}.btn-sfx-mode{min-height:36px;padding:6px 8px;font-size:12px}.range-track,.range-track input{height:30px}.range-track input::-webkit-slider-runnable-track{margin-top:12.5px}.range-track input::-moz-range-track{margin-top:12.5px}.range-track input::-webkit-slider-thumb{width:20px;height:20px;margin-top:-7.5px}.range-track input::-moz-range-thumb{width:18px;height:18px}#measureSlider::-webkit-slider-thumb{width:24px;height:24px;margin-top:-9px}#rangeEnds button,#rangeActions button{min-height:36px;font-size:12px}#rangeEnds button{flex:none;min-width:92px}.btn-export{min-height:40px;padding:6px 4px;font-size:13px}#rangeEnds,#rangeActions{margin-bottom:4px}.range-row{margin-top:20px}#rangeHeader{margin-bottom:4px}#measureSlider{height:32px}}

```

# public/assets/Inter-c8O0ljhh.ttf

This is a binary file of the type: Binary

# public/assets/ShareTechMono-Regular-B9ZeNMwq.ttf

This is a binary file of the type: Binary

# public/index.html

```html
<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Simai 譜面預覽播放器</title>
  <script type="module" crossorigin src="./assets/index-CbI9ubeI.js"></script>
  <link rel="stylesheet" crossorigin href="./assets/index-DSmu9VIY.css">
</head>
<body>
<div id="app"></div>
</body>
</html>

```

