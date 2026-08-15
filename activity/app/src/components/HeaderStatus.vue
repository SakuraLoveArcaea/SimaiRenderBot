<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';

const props = defineProps({
  songTitle: { type: String, required: true },
  statusText: { type: String, required: true },
  statusClass: { type: String, required: true },
  metaLine: { type: String, default: '' },
  showRetry: { type: Boolean, default: false },
  settingsDisabled: { type: Boolean, default: true },
  chartList: { type: Array, default: () => [] },
  currentChart: { type: String, default: '' },
});
const emit = defineEmits(['retry', 'toggle-settings', 'select-chart']);

const toggleButton = ref(null);
const titleDropdownOpen = ref(false);
const searchQuery = ref('');
const dropdownRef = ref(null);

defineExpose({ toggleButton });

function toggleTitleDropdown() {
  if (props.settingsDisabled) return;
  titleDropdownOpen.value = !titleDropdownOpen.value;
  if (titleDropdownOpen.value) {
    searchQuery.value = '';
  }
}

function closeDropdown() {
  titleDropdownOpen.value = false;
}

function handleSelect(chartId) {
  emit('select-chart', chartId);
  closeDropdown();
}

function handleClickOutside(e) {
  if (dropdownRef.value && !dropdownRef.value.contains(e.target)) {
    closeDropdown();
  }
}

onMounted(() => {
  document.addEventListener('click', handleClickOutside, true);
});

onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside, true);
});

const filteredCharts = computed(() => {
  const list = props.chartList && props.chartList.length ? props.chartList : [
    { id: 'チューリングの跡_master.simai', name: 'チューリングの跡_master' },
    { id: '渦状銀河のシンフォニエッタ.simai', name: '渦状銀河のシンフォニエッタ' }
  ];
  const q = searchQuery.value.trim().toLowerCase();
  if (!q) return list;
  return list.filter(c => 
    (c.name && c.name.toLowerCase().includes(q)) || 
    (c.title && c.title.toLowerCase().includes(q)) ||
    (c.id && c.id.toLowerCase().includes(q))
  );
});
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
    
    <div ref="dropdownRef" class="header-title-container">
      <button
        class="title-dropdown-trigger"
        :disabled="settingsDisabled"
        :title="settingsDisabled ? '連線中…' : '點擊切換譜面'"
        @click="toggleTitleDropdown"
      >
        <h1>{{ songTitle }}</h1>
        <span class="dropdown-chevron" :class="{ open: titleDropdownOpen }">▾</span>
      </button>

      <!-- 下拉選單彈窗 -->
      <div v-if="titleDropdownOpen" class="chart-dropdown-menu">
        <div class="dropdown-search-box">
          <input
            v-model="searchQuery"
            type="text"
            placeholder="🔍 搜尋譜面..."
            class="dropdown-search-input"
            autofocus
            @click.stop
          />
        </div>
        <div class="chart-list-scroll">
          <div
            v-for="c in filteredCharts"
            :key="c.id"
            class="chart-item"
            :class="{ active: currentChart === c.id || songTitle === c.name }"
            @click="handleSelect(c.id)"
          >
            <span v-if="c.difficulty" class="chart-diff-badge" :class="c.difficulty.toLowerCase().replace(':', '')">
              {{ c.difficulty }}
            </span>
            <span class="chart-item-name">{{ c.name || c.title }}</span>
            <span v-if="c.bpm" class="chart-item-bpm">{{ c.bpm }} BPM</span>
          </div>
          <div v-if="filteredCharts.length === 0" class="chart-item-empty">
            查無相關譜面
          </div>
        </div>
      </div>
    </div>

    <div :class="statusClass">{{ statusText }}</div>
    <button v-if="showRetry" class="btn-retry" @click="$emit('retry')">🔄 重新連線</button>
    <div class="sub">{{ metaLine }}</div>
  </header>
</template>
