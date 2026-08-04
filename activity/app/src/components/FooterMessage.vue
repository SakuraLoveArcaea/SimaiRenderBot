<script setup>
defineProps({
  text: { type: String, default: '' },
  type: { type: String, default: '' },
});
</script>

<template>
  <footer class="app-footer">
    <p class="message" :class="type">{{ text }}</p>
  </footer>
</template>
