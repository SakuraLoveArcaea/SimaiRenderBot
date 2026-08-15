# SimaiRenderBot 🎮

> **maimai (simai) 譜面預覽播放器、剪輯渲染引擎與 Discord Activity 互動機器人**

[![Node.js](https://img.shields.io/badge/Node.js-22%2B-brightgreen.svg)](https://nodejs.org/)
[![Discord.js](https://img.shields.io/badge/Discord.js-v14-blue.svg)](https://discord.js.org/)
[![Vue 3](https://img.shields.io/badge/Vue-3.x-emerald.svg)](https://vuejs.org/)
[![Vite](https://img.shields.io/badge/Vite-6.x-purple.svg)](https://vitejs.dev/)

---

## 🌟 核心特性 (Features)

### 1. 🕹️ Discord Activity 互動播放器 (`activity/app/`)
* **60fps Canvas 高流暢度渲染**：基於 HTML5 Canvas 的 maimai 框體與音符播放引擎，流暢預覽 Tap, Hold, Slide, Touch, Break 與 EX Note。
* **曲目搜尋與難度切換**：內建曲庫即時模糊搜尋，支援一鍵切換 `Easy`、`Basic`、`Advanced`、`Expert`、`Master`、`Re:Master` 與 `宴 (Utage)` 譜面。
* **滿版自適應與響應式排版**：專為 Discord WebView（桌面端與行動端）最佳化，支援安全區域避讓、長曲名自適應省略與窄螢幕縮放。
* **多模式音效系統 (SFX)**：支援完整音效包、Web Audio 簡易合成音與靜音三段式切換。

### 2. 👥 Utage 雙人譜面 (L/R) 協同模式
* **雙機台同步播放**：自動偵測雙人宴譜（`&inote_1` 1P 左側 / `&inote_2` 2P 右側），雙播放器並排即時同步播放與 Combo 計數。
* **1P / 2P 獨立鏡像翻轉**：支援 1P (L) 與 2P (R) 各自獨立設定鏡像模式（`原譜` ➔ `左右翻轉` ➔ `上下翻轉` ➔ `全 (180°)`）。
* **16:9 雙機台並排渲染**：後端採用獨立離屏 Canvas 進行無重疊合成，產出精美 960×540 雙人並排 GIF。

### 3. ✂️ 精確區間剪輯與「切的乾淨」模式
* **雙端點滑桿與音符密度直方圖**：可視覺化拖曳或微調逗號/小節區間，音符密度圖即時高亮標記選取範圍。
* **合理預設區間**：載入曲目時自動選取起點後約 8~10 秒，避免一開始整首選取過長。
* **「切的乾淨」補頭技術**：自動解析選取範圍前的 BPM 與分音設定（`{4}`、`(140)` 等），產生可獨立執行的乾淨 simai 片段。

### 4. 🔁 短 Token 續看機制 (Resume Session)
* **一鍵回到 Activity**：渲染出的 GIF 附帶「▶ 繼續看譜」按鈕。
* **短 Token 突破限制**：採用 8 碼短 Token 暫存池，完美克服 Discord `customId ≤ 100` 字元上限，支援超長曲名與日文譜面。
* **自動精確跳轉**：點擊後自動開啟 Activity、載入該首曲目並還原剪輯端點與播放頭。

---

## 🏗️ 系統架構 (Architecture)

```
Discord Client (Desktop / Mobile)
  │
  ├── 🎮 Discord Activity (Vue 3 + Canvas Player)
  │     ├── useChartData (譜面解析與 Combo 計算)
  │     ├── usePlayerEngine (60fps Canvas 繪圖與時間軸)
  │     ├── useRangeSelection (小節與時間區間選取)
  │     └── useDiscordSession (SDK 授權與 API 橋接)
  │
  └── 🤖 Discord Bot (Node.js + Discord.js v14)
        ├── /simai, /keyboard (Slash Commands)
        ├── SimaiRenderService (Playwright Headless Canvas 渲染)
        ├── ActivityServer (Token 交換 / 譜面 API / 續看暫存)
        └── ResumeTokenStore (短 Token 狀態池)
```

---

## 📡 渲染參數規格 (Render Payload Specification)

當使用者在前端確認送出後，前端會向後端傳遞以下標準化 JSON 請求：

```json
{
  "chartId": "False_Amber_[DX]_master.simai", // 曲目識別碼
  "chartName": "False Amber[DX] [MASTER 14.9]", // 顯示曲名與難度
  "simai": "(140){4}1,2,3,4...",                // 1P 或主要 simai 內容
  "isDual": false,                              // 是否為雙人宴譜
  "simaiL": null,                               // 雙人模式 1P 內容
  "simaiR": null,                               // 雙人模式 2P 內容
  "startComma": 32,                             // 起始逗號索引
  "endComma": 64,                               // 結束逗號索引
  "cleanCut": true,                             // 是否啟用補頭切乾淨
  "durationSec": 8.57,                          // 選取區段秒數
  "channelId": "123456789012345678",            // Discord 頻道 ID
  "userId": "987654321098765432"                // Discord 使用者 ID
}
```

---

## 🚀 快速開始 (Quick Start)

### 📦 環境需求
* **Node.js**: `22.0.0` 或以上
* **npm**: `10.0.0` 或以上
* **ffmpeg**: 用於 GIF 串接與影像轉換

### ⚙️ 安裝與設定

1. **複製專案並安裝依賴**：
   ```bash
   git clone https://github.com/SakuraLoveArcaea/SimaiRenderBot.git
   cd SimaiRenderBot
   npm install
   ```

2. **設定環境變數 (`.env`)**：
   ```env
   DISCORD_TOKEN=your_discord_bot_token
   CLIENT_ID=your_discord_application_client_id
   CLIENT_SECRET=your_discord_application_client_secret
   PORT=3000
   ```

3. **安裝 Playwright 瀏覽器核心**：
   ```bash
   npx playwright install chromium
   ```

### 💻 開發與運行指令

```bash
# 1. 啟動 Discord Bot 與 Activity 後端伺服器
npm run bot

# 2. 啟動 Cloudflare Tunnel / ngrok (供 Discord Activity 存取)
npm run tunnel

# 3. 啟動前端開發模式 (Vite Dev, 本機熱重載預覽)
npm run dev:activity

# 4. 編譯前端生產環境 Bundle (輸出至 activity/public/)
npm run build:activity

# 5. 執行自動化測試
npm test
```

---

## 📁 專案目錄結構 (Project Structure)

```
SimaiRenderBot/
├── activity/                  # Discord Activity 前端
│   ├── app/                   # Vue 3 應用原始碼
│   │   ├── src/
│   │   │   ├── components/    # Header, Timeline, SettingsPanel, ChartCanvas...
│   │   │   ├── composables/   # usePlayerEngine, useChartData, useRangeSelection...
│   │   │   ├── services/      # apiClient.js
│   │   │   └── style.css      # 全域樣式與響應式排版
│   │   └── vite.config.js     # Vite 設定
│   └── public/                # 前端編譯產物 (HTML, JS, CSS, 音訊素材)
├── engine/                    # 離屏渲染核心與素材
│   ├── headless-render.html   # Headless 渲染頁面 (支援單人與雙人 Canvas)
│   ├── Scripts/               # 渲染器、解碼器與音效邏輯
│   ├── Skin/                  # 音符、框體與特效貼圖
│   └── Sounds/                # 打擊音效素材
├── src/                       # 後端與 Bot 核心
│   ├── bot.js                 # Discord Bot 主程式
│   ├── activity-server.js     # Activity API 與 Token 伺服器
│   ├── render.js              # Playwright 渲染服務
│   ├── resume.js              # 短 Token 續看狀態管理
│   └── chart.js               # 譜面管理與讀取模組
└── testChart/                 # 測試譜面庫 (.simai / .maidata)
```

---

## 📄 授權條款 (License)

本專案採用 **MIT License** 授權開源。
