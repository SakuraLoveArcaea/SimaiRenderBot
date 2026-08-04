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
