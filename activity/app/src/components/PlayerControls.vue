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
