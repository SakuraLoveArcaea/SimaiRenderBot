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

// 這個彈窗有自己獨立的一份譜面資料跟播放引擎，不共用主畫布那一份——
// 兩種預覽方式（切的乾淨 / 沿用原譜面片段）需要餵給它不同的資料來源
const previewChart = useChartData();
const previewEngine = usePlayerEngine(previewChart);
const errorMsg = ref('');

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
      previewEngine.resetPlaybackState();
      previewEngine.seek(0);
      previewEngine.setPreviewStop(previewChart.DATA.value.meta.endTime);
    } else {
      // 方法二：沿用原譜面——直接借用主譜面已經解碼好的資料，只是 seek 到選取範圍播放
      previewChart.adoptFrom(props.chart);
      const { start: s, end: e } = props.rangeSel.rangeTimeSpan();
      previewEngine.resetPlaybackState();
      previewEngine.seek(s);
      previewEngine.setPreviewStop(e);
    }
    previewEngine.play();
  } catch (e) {
    errorMsg.value = e?.message || String(e);
  }
}

watch(() => props.open, async (isOpen) => {
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
      <p v-if="errorMsg" class="message error">{{ errorMsg }}</p>
      <div class="modal-actions">
        <button class="btn-modal-cancel" @click="emit('close')">關閉</button>
      </div>
    </div>
  </div>
</template>
