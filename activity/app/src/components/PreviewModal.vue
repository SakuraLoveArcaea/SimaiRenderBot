<script setup>
import { ref, watch, onUnmounted, nextTick } from 'vue';
import ChartCanvas from './ChartCanvas.vue';
import { useChartData } from '../composables/useChartData.js';
import { usePlayerEngine } from '../composables/usePlayerEngine.js';
import { buildCleanCutSimai } from '../../../../engine/Scripts/simaiCut.js';

const props = defineProps({
  open: { type: Boolean, required: true },
  chart: { type: Object, required: true },
  chartR: { type: Object, default: null },
  isDual: { type: Boolean, default: false },
  rangeSel: { type: Object, required: true },
});
const emit = defineEmits(['close']);

// 獨立的譜面資料與播放引擎（支援 1P 與 2P 同步）
const previewChart = useChartData();
const previewChartR = useChartData();
const previewEngine = usePlayerEngine(previewChart, previewChartR);
const errorMsg = ref('');

// 視角切換：'dual' (雙人並排) | 'l' (僅 1P) | 'r' (僅 2P)
const viewMode = ref('dual');

// cleanCut: false 模式下的時間微調（預設提早開始 0.10s / 延後結束 0.10s，範圍 0s ~ 1.0s）
const startOffset = ref(0.10);
const endOffset = ref(0.10);
const autoLoop = ref(true); // 自動循環播放

let isAssetsLoaded = false;

async function attachAndInit(canvasEl) {
  previewEngine.attachCanvas(canvasEl);
  if (!isAssetsLoaded) {
    await previewEngine.loadAssets();
    isAssetsLoaded = true;
  }
  previewEngine.initEngine();
}

function attachR(canvasEl) {
  previewEngine.attachCanvasR(canvasEl);
}

function detach() {
  previewEngine.detachCanvas();
  previewEngine.detachCanvasR();
}

async function start() {
  errorMsg.value = '';
  try {
    const isDualActive = props.isDual && props.chartR;
    const startComma = props.rangeSel.range.value.start;
    const endComma = props.rangeSel.range.value.end;

    if (props.rangeSel.cleanCut.value) {
      // 方法一：切的乾淨——把實際會送出去的那段內容當成獨立譜面，從頭播到尾
      const infoL = {
        indexToTime: props.chart.C.value,
        tags: props.chart.DATA.value?.tags || [],
        bpm: props.chart.DATA.value?.meta?.bpm
      };
      const startT = props.chart.C.value[startComma] ?? 0;
      const endT = props.chart.C.value[endComma + 1] ?? props.chart.DATA.value?.meta?.endTime;

      const cutTextL = buildCleanCutSimai(props.chart.chartText.value, infoL, startT, endT);
      if (!cutTextL) throw new Error('這段沒有可預覽的內容');
      previewChart.loadFromText(cutTextL, '1P (L) 預覽');

      if (isDualActive && props.chartR.chartText.value) {
        const infoR = {
          indexToTime: props.chartR.C.value,
          tags: props.chartR.DATA.value?.tags || [],
          bpm: props.chartR.DATA.value?.meta?.bpm
        };
        const cutTextR = buildCleanCutSimai(props.chartR.chartText.value, infoR, startT, endT);
        previewChartR.loadFromText(cutTextR, '2P (R) 預覽');
      } else {
        previewChartR.clear();
      }

      const endTime = Math.max(
        previewChart.DATA.value?.meta?.endTime ?? 0,
        isDualActive ? (previewChartR.DATA.value?.meta?.endTime ?? 0) : 0
      );
      previewEngine.resetPlaybackState();
      previewEngine.seek(0);
      previewEngine.setPreviewBounds(0, endTime, autoLoop.value);
    } else {
      // 方法二：原始譜面片段（秒數剪輯）
      previewChart.adoptFrom(props.chart);
      if (isDualActive) {
        previewChartR.adoptFrom(props.chartR);
      } else {
        previewChartR.clear();
      }

      const { start: rawS, end: rawE } = props.rangeSel.rangeTimeSpan();
      const s = Math.max(0, rawS - Number(startOffset.value));
      const e = Math.min(props.chart.DATA.value?.meta?.endTime ?? rawE, rawE + Number(endOffset.value));
      previewEngine.resetPlaybackState();
      previewEngine.seek(s);
      previewEngine.setPreviewBounds(s, e, autoLoop.value);
    }

    await nextTick();
    previewEngine.resizeCanvas();
    previewEngine.play();
  } catch (e) {
    console.error('預覽播放失敗:', e);
    errorMsg.value = e?.message || String(e);
  }
}

watch([() => props.open, startOffset, endOffset, autoLoop, viewMode], async ([isOpen]) => {
  if (!isOpen) {
    previewEngine.pause();
    return;
  }
  await nextTick();
  start();
});

onUnmounted(detach);
</script>

<template>
  <div v-show="open" class="modal-overlay" @click="$event.target === $event.currentTarget && emit('close')">
    <div class="modal-box preview-modal-box" :class="{ 'is-dual-preview': isDual && viewMode === 'dual' }">
      <div class="preview-modal-header">
        <h3>{{ rangeSel.cleanCut.value ? '片段預覽（切的乾淨）' : '片段預覽（秒數剪輯）' }}</h3>
        
        <!-- 雙人譜面視角切換器 -->
        <div v-if="isDual" class="preview-view-tabs">
          <button class="btn-tab" :class="{ active: viewMode === 'dual' }" @click="viewMode = 'dual'">👥 雙人並排</button>
          <button class="btn-tab" :class="{ active: viewMode === 'l' }" @click="viewMode = 'l'">🔷 僅 1P (L)</button>
          <button class="btn-tab" :class="{ active: viewMode === 'r' }" @click="viewMode = 'r'">🌸 僅 2P (R)</button>
        </div>
      </div>

      <!-- 雙人並排預覽舞台 -->
      <div v-if="isDual && viewMode === 'dual'" class="preview-stage-dual">
        <div class="preview-dual-card">
          <span class="badge-player l">🔷 1P (L)</span>
          <div class="preview-stage-wrapper">
            <ChartCanvas :attach="attachAndInit" :detach="detach" stage-id="previewStageL" canvas-id="previewCanvasL" />
          </div>
        </div>
        <div class="preview-dual-card">
          <span class="badge-player r">🌸 2P (R)</span>
          <div class="preview-stage-wrapper">
            <ChartCanvas :attach="attachR" :detach="previewEngine.detachCanvasR" stage-id="previewStageR" canvas-id="previewCanvasR" />
          </div>
        </div>
      </div>

      <!-- 單一播放器預覽舞台 -->
      <div v-else class="preview-stage">
        <ChartCanvas
          v-if="!isDual || viewMode === 'l'"
          :attach="attachAndInit" :detach="detach" stage-id="previewStage" canvas-id="previewCanvas"
        />
        <ChartCanvas
          v-else-if="isDual && viewMode === 'r'"
          :attach="attachAndInit" :detach="detach" stage-id="previewStage" canvas-id="previewCanvas"
        />
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

      <!-- 錯誤提示 -->
      <div v-if="errorMsg" class="preview-error-box">
        ⚠️ {{ errorMsg }}
      </div>

      <div class="preview-controls-row">
        <label class="preview-loop-toggle">
          <input type="checkbox" v-model="autoLoop" />
          <span>🔄 自動循環播放</span>
        </label>
        <button class="btn-preview-replay" @click="start">🔁 重新播放</button>
      </div>

      <div class="modal-actions">
        <button class="btn-modal-cancel" @click="emit('close')">關閉預覽</button>
      </div>
    </div>
  </div>
</template>
