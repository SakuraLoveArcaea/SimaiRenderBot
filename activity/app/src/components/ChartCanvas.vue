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
