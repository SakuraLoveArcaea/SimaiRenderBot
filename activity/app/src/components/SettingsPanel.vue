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
  mirrorLabel: { type: String, required: true },
  disabled: { type: Boolean, default: false },
});
const emit = defineEmits(['update:speed', 'update:hs', 'update:sfx-volume', 'cycle-sfx-mode', 'toggle-clean-cut', 'cycle-mirror']);

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
    <span class="speedbox">
      <button class="btn-sfx-mode"
        title="循環切換：原譜 → 左右翻轉 → 上下翻轉 → 全（180°旋轉）"
        @click="emit('cycle-mirror')"
      >🔄 鏡像：{{ mirrorLabel }}</button>
    </span>
  </div>
</template>
