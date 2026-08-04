<script setup>
defineProps({
  open: { type: Boolean, required: true },
  meta: { type: String, default: '' },
  previewText: { type: String, default: '' },
});
const emit = defineEmits(['confirm', 'cancel']);
</script>

<template>
  <div v-if="open" class="modal-overlay" @click="$event.target === $event.currentTarget && emit('cancel')">
    <div class="modal-box">
      <h3>確認送出內容</h3>
      <p class="modal-meta">{{ meta }}</p>
      <pre class="modal-simai-text">{{ previewText }}</pre>
      <div class="modal-actions">
        <button class="btn-modal-cancel" @click="emit('cancel')">取消</button>
        <button class="btn-export" @click="emit('confirm')">✅ 確認送出</button>
      </div>
    </div>
  </div>
</template>
