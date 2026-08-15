<script setup>
import { ref } from 'vue';

const props = defineProps({
  open: { type: Boolean, required: true },
  meta: { type: String, default: '' },
  previewText: { type: String, default: '' },
  isDual: { type: Boolean, default: false },
  previewTextL: { type: String, default: '' },
  previewTextR: { type: String, default: '' },
});
const emit = defineEmits(['confirm', 'cancel']);

const dualTab = ref('both'); // 'both' | 'l' | 'r'
</script>

<template>
  <div v-if="open" class="modal-overlay" @click="$event.target === $event.currentTarget && emit('cancel')">
    <div class="modal-box confirm-modal-box" :class="{ 'is-dual-confirm': isDual && dualTab === 'both' }">
      <div class="confirm-modal-header">
        <h3>確認送出內容</h3>

        <!-- 雙人譜面切換標籤 -->
        <div v-if="isDual" class="confirm-code-tabs">
          <button class="btn-tab" :class="{ active: dualTab === 'both' }" @click="dualTab = 'both'">並排檢視</button>
          <button class="btn-tab" :class="{ active: dualTab === 'l' }" @click="dualTab = 'l'">🔷 1P (L)</button>
          <button class="btn-tab" :class="{ active: dualTab === 'r' }" @click="dualTab = 'r'">🌸 2P (R)</button>
        </div>
      </div>

      <p class="modal-meta">{{ meta }}</p>

      <!-- 雙譜面代碼檢視區 -->
      <div v-if="isDual" class="dual-code-container" :class="`view-${dualTab}`">
        <div v-if="dualTab === 'both' || dualTab === 'l'" class="code-box-card">
          <div class="code-box-header l">🔷 1P (L) 譜面片段代碼</div>
          <pre class="modal-simai-text">{{ previewTextL || previewText }}</pre>
        </div>

        <div v-if="dualTab === 'both' || dualTab === 'r'" class="code-box-card">
          <div class="code-box-header r">🌸 2P (R) 譜面片段代碼</div>
          <pre class="modal-simai-text">{{ previewTextR }}</pre>
        </div>
      </div>

      <!-- 單譜面代碼檢視 -->
      <pre v-else class="modal-simai-text">{{ previewText }}</pre>

      <div class="modal-actions">
        <button class="btn-modal-cancel" @click="emit('cancel')">取消</button>
        <button class="btn-export" @click="emit('confirm')">✅ 確認送出並渲染</button>
      </div>
    </div>
  </div>
</template>
