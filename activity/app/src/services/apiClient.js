/**
 * 前端 API 客戶端服務 (API Client Service)
 * 統一封裝所有與後端的 HTTP 通訊，自動處理 Proxy 前綴與 RESTful JSON 響應。
 */

function isEmbeddedInDiscord() {
  return window.self !== window.top;
}

function getApiBase() {
  const standalone = import.meta.env.DEV && !isEmbeddedInDiscord();
  return standalone ? '/api' : '/.proxy/api';
}

async function request(endpoint, options = {}) {
  const url = `${getApiBase()}${endpoint}`;
  const res = await fetch(url, options);
  if (!res.ok) {
    let errorMsg = `HTTP ${res.status}`;
    try {
      const json = await res.json();
      if (json.error?.message) errorMsg = json.error.message;
    } catch {}
    throw new Error(errorMsg);
  }
  const json = await res.json();
  if (json.ok !== undefined) {
    if (!json.ok) throw new Error(json.error?.message || '未知伺服器錯誤');
    return json.data;
  }
  return json;
}

export const apiClient = {
  /** 獲取測試譜面列表 */
  async getCharts() {
    const res = await request('/charts');
    return Array.isArray(res) ? res : (res.charts || []);
  },

  /** 獲取特定測試譜面數據與 simai 原碼 */
  async getChartData(file) {
    const query = file ? `?file=${encodeURIComponent(file)}` : '';
    return await request(`/chart${query}`);
  },

  /** 獲取 Resume session */
  async getResumeSession(userId) {
    return await request(`/resume?userId=${encodeURIComponent(userId)}`);
  },

  /** 送出渲染請求 */
  async submitRender(payload) {
    return await request('/render', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  },
};
