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
