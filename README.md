# SimaiRenderBot — 前端介面與渲染參數設計

> 🎮 maimai (simai) 譜面互動預覽播放器、小節區間選擇器與渲染參數控制前端。

本專案主要專注於 **Discord Activity 前端 UI/UX 設計**、**互動式譜面播放器 (Canvas Player)** 以及 **小節/音符區間選擇與渲染參數定義**。後端伺服器提供基本的測試介面與渲染驗證。

---

## 🌟 專案核心 (Project Core)

1. **🎨 前端介面與互動設計 (`activity/app/src/`)**：
   * **60fps 軌道動畫與 Note 渲染**：基於 HTML5 Canvas 的高流暢度譜面預覽。
   * **雙滑桿小節/音符區間選取器**：獨立控制起點與終點，支援滑塊即時 simai 語法浮出提示與雙擊定位。
   * **音符密度分布圖 (Measure Density Graph)**：動態計算全曲各小節 note 密度並繪製為直方圖與高亮選擇區塊。
   * **高精度時間軸**：全域 `-0.001s` 偏置校準與 3 位小數 (1ms) 精度控制。
   * **多模式音效系統**：提供靜音、Web Audio 振盪器簡易合成音、完整音效包三段模式。
   * **響應式版面與 Discord 避讓**：適應桌面與手機版 Discord Activity，手機版自動識別 safe-area-inset-top 留白。

2. **⚙️ 渲染參數介面規範 (Render Parameters Payload)**：
   * 統一前端操作後傳遞給渲染引擎的標準 JSON 參數格式。

3. **🛠️ 測試 Server 與驗證腳本 (`src/`)**：
   * 提供基本的 `testChart/` 譜面讀取端點與 Playwright 自動化 UI 煙霧測試。

---

## 📡 渲染參數規格 (Render Parameters API Specification)

當使用者在前端介面上完成設定並點擊送出時，前端會產生以下標準化 JSON 參數傳遞給渲染器：

```json
{
  "simaiText": "(238)\n{4}24,5,46,...",  // 所選片段的 simai 譜面原文
  "speed": 7.0,                          // 綠數 (音符移動速度)
  "hs": 1.0,                             // 視認倍速
  "startComma": 0,                       // 起始逗號位置 (小節切割點)
  "endComma": 150,                       // 結束逗號位置
  "cleanCut": true,                      // 是否自動補全檔頭 (BPM/分音)
  "channelId": "123456789",              // (選用) Discord 頻道 ID
  "userId": "987654321"                  // (選用) Discord 使用者 ID
}
```

---

## 🚀 快速開始 (Quick Start)

### 環境需求
* Node.js 22+
* ffmpeg (用於測試 GIF 生成驗證)

### 指令集

```bash
npm install

# 1. 啟動前端開發模式 (Vite Dev, 支援熱重載與獨立本機預覽)
npm run dev:activity

# 2. 啟動基本測試伺服器 (提供 testChart API)
npm run server:activity

# 3. 編譯打包前端 (輸出至 activity/public/)
npm run build:activity

# 4. 執行自動化 UI 煙霧測試 (24 項 Playwright 測試)
npm run test:activity
```

---

## 📁 專案目錄結構

```
activity/app/src/       # 前端 UI 與播放器原始碼 (Vue 3 + Canvas)
  ├── components/       # UI 組件 (HeaderStatus, RangeSelector, Timeline, SettingsPanel...)
  ├── composables/      # 業務與播放邏輯 (usePlayerEngine, useRangeSelection, useChartData...)
  └── services/         # API 客戶端 (apiClient.js)
testChart/              # 測試譜面檔 (.simai)
engine/                 # 渲染引擎核心 (Scripts, Skin, Fonts, Sounds)
src/                    # 測試伺服器與驗證腳本 (activity-server.js, bot.js, render.js)
```
