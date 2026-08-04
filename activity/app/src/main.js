import { createApp } from 'vue';
import App from './App.vue';
import { setupDebugLogging } from './composables/useDebugLogging.js';
import './style.css';

// 頁面生命週期事件（bfcache/錯誤回報）跟頁面存活期間一樣長，
// 註冊在元件外面（模組層級），不會因為元件重新掛載而重複註冊
setupDebugLogging();

createApp(App).mount('#app');
