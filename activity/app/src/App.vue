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
