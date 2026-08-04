import { ref } from 'vue';

// 模組層級的 ref：任何 import 這個模組的地方拿到的是同一份，
// 這是 Vue 裡最簡單的「全域狀態」寫法——不需要 Pinia，一個在函式外面宣告的 ref 就是單例。
export const fatalError = ref(null);

/**
 * 除錯用：手機上的 Discord App 內建 WebView 不開放 Safari 遠端除錯，看不到 console，
 * 所以改用 sendBeacon 把生命週期關鍵事件回報到後端（印在 bot 的終端機），
 * 用來排查 Activity 被關閉前最後執行到哪一步。sendBeacon 專門設計成連頁面正在被卸載時
 * 也能盡量送出，失敗也不影響主流程。
 */
export function logRemote(event, data) {
  try {
    const payload = JSON.stringify({ event, data, ts: new Date().toISOString(), ua: navigator.userAgent });
    navigator.sendBeacon('/.proxy/api/debug-log', new Blob([payload], { type: 'application/json' }));
  } catch (e) {
    // 忽略：僅為除錯用途
  }
}

/** 註冊一次即可；main.js 在 createApp().mount() 之前呼叫，不放進元件內部避免重複掛載時重複註冊 */
export function setupDebugLogging() {
  logRemote('script:loaded', { persisted: false });

  // 手機瀏覽器（尤其 iOS）常會用 bfcache 把「關閉」的分頁凍結保留，下次「重新打開」時
  // 直接復原舊分頁而非真正重新載入頁面 —— 這會讓 DiscordSDK 沿用第一次連線時的舊內部狀態，
  // 導致第二次進入時被 Discord 判定 session 已失效而直接踢出。偵測到復原就強制整頁重載，
  // 確保每次打開 Activity 都會建立全新的 DiscordSDK 連線。
  window.addEventListener('pageshow', (event) => {
    logRemote('pageshow', { persisted: event.persisted });
    if (event.persisted) window.location.reload();
  });

  // 除錯用：如果閃退時有機會看到這則 log，代表是「正常的頁面卸載/導覽」；
  // 如果完全沒收到，代表 WebView 是被更底層（原生 App 層級）直接砍掉，
  // 連 JS 卸載事件都沒機會觸發。
  window.addEventListener('pagehide', (event) => {
    logRemote('pagehide', { persisted: event.persisted });
  });

  document.addEventListener('visibilitychange', () => {
    logRemote('visibilitychange', { state: document.visibilityState });
  });

  // 全域錯誤監聽：只顯示自己程式碼的錯誤（過濾第三方 SDK 內部錯誤），但不論來源都回報除錯 log
  window.onerror = function (message, source, lineno, colno) {
    logRemote('window.onerror', { message, source, lineno, colno });
    if (source && !source.includes('main.js') && !source.includes('localhost')) return true;
    fatalError.value = `JS 錯誤：${message} (L${lineno})`;
  };

  window.onunhandledrejection = function (event) {
    const msg = event.reason?.message || String(event.reason);
    logRemote('unhandledrejection', { msg });
    fatalError.value = `未處理的 Rejection：${msg}`;
  };
}
