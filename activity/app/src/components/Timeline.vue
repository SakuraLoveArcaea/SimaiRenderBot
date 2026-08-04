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
