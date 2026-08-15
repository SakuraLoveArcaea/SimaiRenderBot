<script setup>
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue';
import { useChartData } from './composables/useChartData.js';
import { usePlayerEngine } from './composables/usePlayerEngine.js';
import { useSfx } from './composables/useSfx.js';
import { useRangeSelection } from './composables/useRangeSelection.js';
import { useDiscordSession } from './composables/useDiscordSession.js';
import { fatalError, logRemote } from './composables/useDebugLogging.js';
import { buildCleanCutSimai } from '../../../engine/Scripts/simaiCut.js';

import HeaderStatus from './components/HeaderStatus.vue';
import SettingsPanel from './components/SettingsPanel.vue';
import ChartCanvas from './components/ChartCanvas.vue';
import PlayerControls from './components/PlayerControls.vue';
import Timeline from './components/Timeline.vue';
import ColorLegend from './components/ColorLegend.vue';
import FooterMessage from './components/FooterMessage.vue';
import ConfirmModal from './components/ConfirmModal.vue';
import PreviewModal from './components/PreviewModal.vue';

// 譜面與引擎實例（支援雙譜面 L/R 同步）
const chart = useChartData();
const chartR = useChartData();
const engine = usePlayerEngine(chart, chartR);
const sfx = useSfx();
const rangeSel = useRangeSelection(chart, engine);
const session = useDiscordSession();

const isDualMode = ref(false);
const songTitleDisplay = ref('連線中…');
const retryVisible = ref(false);
const inputsEnabled = ref(false);
const message = ref({ text: '', type: '' });
const settingsOpen = ref(false);
const settingsPositionStyle = ref({});
const confirmOpen = ref(false);
const confirmMeta = ref('');
const confirmText = ref('');
const confirmTextL = ref('');
const confirmTextR = ref('');
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
    const hasDual = !!(data.isDual && data.textL && data.textR);
    if (hasDual) {
      chart.loadFromText(data.textL, data.nameL || `${data.title} [1P (L)]`);
      chartR.loadFromText(data.textR, data.nameR || `${data.title} [2P (R)]`);
      isDualMode.value = true;
      songTitleDisplay.value = `${data.title} [宴 雙人協同]`;
    } else {
      chart.loadFromText(data.text, data.name);
      chartR.clear();
      isDualMode.value = false;
      songTitleDisplay.value = chart.chartName.value;
    }
    currentChartId.value = data.filename || chartId;

    engine.resetPlaybackState();
    const maxComma = chart.C.value.length - 2;
    rangeSel.initBounds(maxComma);
    engine.seek(0);
    rangeSel.setActiveEndpoint(null);
    inputsEnabled.value = true; 
    showMessage(`✅ 已切換至譜面：${songTitleDisplay.value}`, 'success');
  } catch (e) {
    console.error('切換譜面失敗:', e);
    showMessage(`❌ 切換譜面失敗：${e.message}`, 'error');
    inputsEnabled.value = true;
  }
}

const hudBpm = computed(() => chart.DATA.value ? Math.round(chart.DATA.value.meta.bpm) : '-');
const hudMeasureMax = computed(() => chart.DATA.value ? chart.M.value.length - 1 : '-');
const hudComboMax = computed(() => chart.DATA.value ? (chart.comboTimes?.value?.length ?? 0) : '-');
const hudComboMaxR = computed(() => chartR.DATA.value ? (chartR.comboTimes?.value?.length ?? 0) : '-');
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

    // 檢查是否有透過 /play 指定譜面或「繼續看譜」按鈕傳遞的暫存 Session
    const resumed = await session.fetchResumeSession(999999);
    const targetChartId = resumed?.chartId || null;

    session.setStatus('連線中：正在獲取譜面資料…', 'status-connecting');
    if (targetChartId) {
      const data = await session.fetchChartData(targetChartId);
      const hasDual = !!(data.isDual && data.textL && data.textR);
      if (hasDual) {
        chart.loadFromText(data.textL, data.nameL || `${data.title} [1P (L)]`);
        chartR.loadFromText(data.textR, data.nameR || `${data.title} [2P (R)]`);
        isDualMode.value = true;
        songTitleDisplay.value = `${data.title} [宴 雙人協同]`;
      } else {
        chart.loadFromText(data.text, data.name);
        chartR.clear();
        isDualMode.value = false;
        songTitleDisplay.value = chart.chartName.value;
      }
      currentChartId.value = data.filename || targetChartId;
    } else {
      await chart.loadChart(fetchChartPath);
      const initialChart = list.find(c => c.name === chart.chartName.value);
      if (initialChart) currentChartId.value = initialChart.id;
      songTitleDisplay.value = chart.chartName.value;
    }
    logRemote('setup:chart_fetched', { name: songTitleDisplay.value });

    session.setStatus('連線中：正在載入圖片素材…', 'status-connecting');
    await engine.loadAssets();
    logRemote('setup:assets_loaded');

    engine.initEngine();

    const maxComma = chart.C.value.length - 2;
    if (resumed && typeof resumed.start === 'number' && typeof resumed.end === 'number') {
      const safeRange = {
        start: Math.max(0, Math.min(resumed.start, maxComma)),
        end: Math.max(0, Math.min(resumed.end, maxComma)),
      };
      rangeSel.initBounds(maxComma, safeRange);
      showMessage('↩️ 已回到訊息中那一段的位置', 'info');
      engine.seek(chart.C.value[safeRange.start] ?? 0);
    } else {
      rangeSel.initBounds(maxComma);
      engine.seek(0);
    }

    inputsEnabled.value = true;
    session.setStatus(`連線成功：${session.auth.value.user.global_name ?? session.auth.value.user.username}`, 'status-ready');
    engine.resizeCanvas();
    rangeSel.setActiveEndpoint(null);

    logRemote('setup:complete', (resumed && typeof resumed.start === 'number') ? { resumed: [resumed.start, resumed.end] } : undefined);
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

function onCycleMirror() {
  engine.pause();
  chart.cycleMirror();
  if (isDualMode.value) chartR.cycleMirror();
  engine.resetPlaybackState();
  const maxComma = chart.C.value.length - 2;
  rangeSel.initBounds(maxComma);
  engine.seek(0);
  rangeSel.setActiveEndpoint(null);
  showMessage(`🔄 鏡像模式：${chart.mirrorLabel.value}`, 'info');
}

function onCycleMirrorL() {
  engine.pause();
  chart.cycleMirror();
  engine.resetPlaybackState();
  const maxComma = chart.C.value.length - 2;
  rangeSel.initBounds(maxComma);
  engine.seek(0);
  rangeSel.setActiveEndpoint(null);
  showMessage(`🔄 1P (L) 鏡像：${chart.mirrorLabel.value}`, 'info');
}

function onCycleMirrorR() {
  engine.pause();
  chartR.cycleMirror();
  engine.resetPlaybackState();
  engine.seek(0);
  rangeSel.setActiveEndpoint(null);
  showMessage(`🔄 2P (R) 鏡像：${chartR.mirrorLabel.value}`, 'info');
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

  if (isDualMode.value && chartR.chartText.value) {
    try {
      const startComma = rangeSel.range.value.start;
      const endComma = rangeSel.range.value.end;
      const infoL = { indexToTime: chart.C.value, tags: chart.DATA.value?.tags || [], bpm: chart.DATA.value?.meta?.bpm };
      const infoR = { indexToTime: chartR.C.value, tags: chartR.DATA.value?.tags || [], bpm: chartR.DATA.value?.meta?.bpm };
      const startT = chart.C.value[startComma] ?? 0;
      const endT = chart.C.value[endComma + 1] ?? chart.DATA.value?.meta?.endTime;
      confirmTextL.value = buildCleanCutSimai(chart.chartText.value, infoL, startT, endT);
      confirmTextR.value = buildCleanCutSimai(chartR.chartText.value, infoR, startT, endT);
    } catch (e) {
      confirmTextL.value = preview.text;
      confirmTextR.value = '';
    }
  } else {
    confirmTextL.value = preview.text;
    confirmTextR.value = '';
  }

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
      chartId: currentChartId.value,
      simai: chart.chartText.value,
      isDual: isDualMode.value,
      simaiL: isDualMode.value ? chart.chartText.value : null,
      simaiR: isDualMode.value ? chartR.chartText.value : null,
      startComma: rangeSel.range.value.start,
      endComma: rangeSel.range.value.end,
      chartName: songTitleDisplay.value,
      cleanCut: rangeSel.cleanCut.value,
      durationSec: dur.duration,
    });
    if (res?.alreadyDone) {
      showMessage('🎉 這段範圍先前已渲染完成，已直接傳送！', 'success');
    } else {
      const waitText = (typeof res?.position === 'number' && res.position > 0)
        ? `（排隊中：前方還有 ${res.position} 個任務）`
        : '（正在產生 GIF…）';
      showMessage(`🚀 渲染請求已送出 ${waitText}，完成後會自動通知您！`, 'success');
    }
  } catch (e) {
    console.error(e);
    showMessage(`❌ 送出失敗：${e.message || String(e)}`, 'error');
  } finally {
    inputsEnabled.value = true;
  }
}

// ---------- 鍵盤快捷鍵 ----------
function onKeyDown(e) {
  if (e.target.matches('input, select, textarea, button')) return;

  if (e.code === 'Space') {
    e.preventDefault();
    if (inputsEnabled.value) engine.togglePlay();
    return;
  }
  if (e.key === 'Home') {
    e.preventDefault();
    if (inputsEnabled.value) rangeSel.goStart();
    return;
  }
  if (e.key === '[' || e.key === '{') {
    e.preventDefault();
    if (inputsEnabled.value) rangeSel.setStart();
    return;
  }
  if (e.key === ']' || e.key === '}') {
    e.preventDefault();
    if (inputsEnabled.value) rangeSel.setEnd();
    return;
  }

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
  <div class="container" :class="{ 'is-dual': isDualMode }">
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
      :mirror-label="chart.mirrorLabel.value"
      :mirror-label-l="chart.mirrorLabel.value"
      :mirror-label-r="chartR.mirrorLabel.value"
      :is-dual="isDualMode"
      :disabled="!inputsEnabled"
      @update:speed="engine.setSpeed"
      @update:hs="onSetHs"
      @update:sfx-volume="sfx.setSfxVolume"
      @cycle-sfx-mode="sfx.cycleSfxMode"
      @toggle-clean-cut="rangeSel.cleanCut.value = !rangeSel.cleanCut.value"
      @cycle-mirror="onCycleMirror"
      @cycle-mirror-l="onCycleMirrorL"
      @cycle-mirror-r="onCycleMirrorR"
    />

    <div class="main-content" :class="{ 'is-dual-layout': isDualMode }">
      <!-- 左/主區域 -->
      <div class="left-panel" :class="{ 'dual-panel': isDualMode }">
        <div id="hud">
          <span>BPM <b>{{ hudBpm }}</b></span>
          <span>小節 <b>{{ engine.hudMeasure.value }}</b> / <span>{{ hudMeasureMax }}</span></span>
          <span v-if="!isDualMode">Combo <b>{{ engine.hudCombo.value }}</b> / <span>{{ hudComboMax }}</span></span>
          <span v-else>協同模式 <b>雙人譜面</b></span>
        </div>

        <!-- 雙人/協同模式：並排顯示 1P 與 2P 兩個播放器，下方統一控制列 -->
        <template v-if="isDualMode">
          <div class="dual-player-row">
            <div class="player-stage-card">
              <div class="player-stage-badge l">
                <span>🔷 1P (L)</span>
                <span class="player-combo-val">Combo <b>{{ engine.hudCombo.value }}</b> / {{ hudComboMax }}</span>
              </div>
              <div class="stage-container">
                <ChartCanvas :attach="engine.attachCanvas" :detach="engine.detachCanvas" stage-id="stageL" canvas-id="chartCanvasL" />
              </div>
            </div>

            <div class="player-stage-card">
              <div class="player-stage-badge r">
                <span>🌸 2P (R)</span>
                <span class="player-combo-val">Combo <b>{{ engine.hudComboR.value }}</b> / {{ hudComboMaxR }}</span>
              </div>
              <div class="stage-container">
                <ChartCanvas :attach="engine.attachCanvasR" :detach="engine.detachCanvasR" stage-id="stageR" canvas-id="chartCanvasR" />
              </div>
            </div>
          </div>

          <!-- 雙播放器正下方的統一控制列 -->
          <div class="dual-player-controls-bottom">
            <button title="後退約3秒" :disabled="!inputsEnabled" @click="onJumpTime(-3)">＜＜＜</button>
            <button title="跳到上一顆音符" :disabled="!inputsEnabled" @click="onStepNote(-1)">＜＜</button>
            <button title="後退 1 個逗號" :disabled="!inputsEnabled" @click="onStepComma(-1)">＜</button>
            <button class="btn-play-large" :disabled="!inputsEnabled" @click="engine.togglePlay()">
              {{ engine.playing.value ? '⏸ 暫停' : '▶ 播放' }}
            </button>
            <button title="前進 1 個逗號" :disabled="!inputsEnabled" @click="onStepComma(1)">＞</button>
            <button title="跳到下一顆音符" :disabled="!inputsEnabled" @click="onStepNote(1)">＞＞</button>
            <button title="前進約3秒" :disabled="!inputsEnabled" @click="onJumpTime(3)">＞＞＞</button>
          </div>
        </template>

        <!-- 單人模式：單一播放器 -->
        <template v-else>
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
        </template>
      </div>

      <div class="right-panel">
        <Timeline :chart="chart" :engine="engine" :range-sel="rangeSel" :disabled="!inputsEnabled" @export="openConfirmModal" @preview="previewOpen = true" />
        <ColorLegend />
        <FooterMessage :text="message.text" :type="message.type" />
      </div>
    </div>
  </div>

  <ConfirmModal
    :open="confirmOpen"
    :meta="confirmMeta"
    :preview-text="confirmText"
    :is-dual="isDualMode"
    :preview-text-l="confirmTextL"
    :preview-text-r="confirmTextR"
    @confirm="onConfirmSend"
    @cancel="closeConfirmModal"
  />
  <PreviewModal :open="previewOpen" :chart="chart" :chart-r="chartR" :is-dual="isDualMode" :range-sel="rangeSel" @close="previewOpen = false" />
</template>
