<script setup>
import { ref } from 'vue';

defineProps({
  songTitle: { type: String, required: true },
  statusText: { type: String, required: true },
  statusClass: { type: String, required: true },
  metaLine: { type: String, default: '' },
  showRetry: { type: Boolean, default: false },
  settingsDisabled: { type: Boolean, default: true },
  chartList: { type: Array, default: () => [] },
  currentChart: { type: String, default: '' },
});
defineEmits(['retry', 'toggle-settings', 'select-chart']);

const toggleButton = ref(null);
defineExpose({ toggleButton });
</script>

<template>
  <header>
    <div id="settingsMenu">
      <button
        ref="toggleButton"
        class="btn-settings"
        title="倍速／流速／音量"
        :disabled="settingsDisabled"
        @click="$emit('toggle-settings', $event)"
      >⚙</button>
    </div>
    <div class="header-title-row">
      <h1>{{ songTitle }}</h1>
      <select
        class="chart-select-dropdown"
        :value="currentChart"
        :disabled="settingsDisabled"
        title="切換 testChart 測試譜面"
        @change="$emit('select-chart', $event.target.value)"
      >
        <option v-for="c in (chartList && chartList.length ? chartList : [{ id: 'チューリングの跡_master.simai', name: 'チューリングの跡_master' }, { id: '渦状銀河のシンフォニエッタ.simai', name: '渦状銀河のシンフォニエッタ' }])" :key="c.id" :value="c.id">
          🎵 {{ c.name }}
        </option>
      </select>
    </div>
    <div :class="statusClass">{{ statusText }}</div>
    <button v-if="showRetry" class="btn-retry" @click="$emit('retry')">🔄 重新連線</button>
    <div class="sub">{{ metaLine }}</div>
  </header>
</template>
