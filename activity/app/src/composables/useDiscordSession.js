import { ref } from 'vue';
import { DiscordSDK } from '@discord/embedded-app-sdk';
import { logRemote } from './useDebugLogging.js';
import { apiClient } from '../services/apiClient.js';

function isEmbeddedInDiscord() {
  return window.self !== window.top;
}

/**
 * Discord 連線與身分驗證。開發模式（`vite dev`）且不是真的嵌在 Discord 裡時，
 * 走「本機預覽模式」：跳過整套 authorize/authenticate，用假身分直接打不需要驗證的
 * /api/chart。import.meta.env.DEV 在 `vite build` 產出的正式版一律是 false，
 * 這條分支完全不會進到給 Discord 用的正式版本裡。
 */
export function useDiscordSession() {
  const standalone = import.meta.env.DEV && !isEmbeddedInDiscord();

  const statusText = ref('正在初始化 SDK…');
  const statusClass = ref('status-connecting');
  const auth = ref(null);
  const discordSdk = ref(null);

  const params = new URLSearchParams(window.location.search);
  const clientId = params.get('client_id') || '1527644569133649960';

  function setStatus(text, cls) {
    statusText.value = text;
    statusClass.value = cls;
  }

  async function connectStandalone() {
    setStatus('本機預覽模式（未連接 Discord）', 'status-ready');
    auth.value = { user: { id: 'dev', username: 'dev', global_name: 'Dev' } };
    return { fetchChartPath: '/api/chart' };
  }

  async function connectReal() {
    logRemote('setup:start');
    setStatus('連線中：正在初始化 SDK…', 'status-connecting');
    const sdk = new DiscordSDK(clientId, { disableConsoleLogOverride: true });
    discordSdk.value = sdk;

    if (sdk.platform === 'mobile') {
      document.documentElement.classList.add('platform-mobile');
    }

    await sdk.ready();
    logRemote('setup:sdk_ready');

    setStatus('連線中：正在向用戶端申請授權…', 'status-connecting');
    const { code } = await sdk.commands.authorize({
      client_id: clientId,
      response_type: 'code',
      state: '',
      prompt: 'none',
      scope: ['identify'],
    });
    logRemote('setup:authorized');

    setStatus('連線中：正在與本地後端交換 Token…', 'status-connecting');
    const res = await fetch('/.proxy/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    if (!res.ok) throw new Error(`token 交換失敗：${res.status}`);
    const { access_token } = await res.json();
    logRemote('setup:token_exchanged');

    setStatus('連線中：正在進行用戶身份驗證…', 'status-connecting');
    auth.value = await sdk.commands.authenticate({ access_token });
    logRemote('setup:authenticated', { username: auth.value.user.username });

    return { fetchChartPath: '/.proxy/api/chart' };
  }

  function connect() {
    return standalone ? connectStandalone() : connectReal();
  }

  /**
   * 從後端取回「繼續看譜」要還原的區間（由 bot 端在按鈕被按下時暫存）。
   * 取得後套用到兩個 range 滑桿；沒有就維持預設全選。
   */
  async function fetchResumeSession(maxComma = 999999) {
    if (standalone) return null;
    try {
      const s = await apiClient.getResumeSession(auth.value.user.id);
      if (!s || (!s.chartId && typeof s.startComma !== 'number')) return null;
      let start = null;
      let end = null;
      if (typeof s.startComma === 'number' && typeof s.endComma === 'number') {
        start = Math.max(0, Math.min(s.startComma, maxComma));
        end = Math.max(start, Math.min(s.endComma, maxComma));
      }
      return {
        chartId: s.chartId || null,
        start,
        end,
      };
    } catch (e) {
      console.warn('[Resume] 還原續看位置失敗:', e);
      return null;
    }
  }

  async function submitRender(payload) {
    return apiClient.submitRender({
      channelId: discordSdk.value?.channelId ?? null,
      userId: auth.value.user.id,
      username: auth.value.user.global_name ?? auth.value.user.username,
      ...payload,
    });
  }

  async function fetchChartList(provider = 'local', query = '') {
    try {
      return await apiClient.getCharts(provider, query);
    } catch (e) {
      console.warn('Failed to fetch chart list:', e);
      return [];
    }
  }

  async function fetchChartData(filename, provider = 'local') {
    return await apiClient.getChartData(filename, provider);
  }

  async function closeActivity() {
    if (standalone || !discordSdk.value) return;
    await Promise.resolve(discordSdk.value.close()).catch(err => console.error('Failed to close activity:', err));
  }

  return {
    standalone, statusText, statusClass, auth,
    connect, fetchResumeSession, submitRender, closeActivity, setStatus,
    fetchChartList, fetchChartData,
  };
}
