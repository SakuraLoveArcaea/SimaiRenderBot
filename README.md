# SimaiRenderBot 🎮

> **maimai (simai) 譜面預覽播放器、剪輯渲染引擎與 Discord Activity 互動機器人**

[![Node.js](https://img.shields.io/badge/Node.js-22%2B-brightgreen.svg)](https://nodejs.org/)
[![Discord.js](https://img.shields.io/badge/Discord.js-v14-blue.svg)](https://discord.js.org/)
[![Vue 3](https://img.shields.io/badge/Vue-3.x-emerald.svg)](https://vuejs.org/)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)

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

### 4. 🔁 「繼續看譜」無縫還原 (Resume Session)
* **一鍵回到 Activity**：渲染出的 GIF 附帶「▶ 繼續看譜」按鈕。
* **自動精確跳轉**：點擊後自動開啟 Activity、載入該首曲目並還原剪輯端點與播放頭。
* **多使用者獨立工作階段**：不同使用者點擊同一個訊息按鈕皆能各自取得正確的曲目與剪輯位置。

## 📖 使用者操作指南 (User Guide)

想用 Bot 研究譜面配置、截取難點動圖或與好友一起看譜？以下是主要功能的使用方法：

### 1. 🔍 尋找曲目與切換難度
* **切換曲目**：點擊頂部標題（如 `7 Wonders[DX]`），會彈出曲庫選單。
* **即時搜尋**：在搜尋框輸入**曲名**、**演出者**或**難度**關鍵字即可快速過濾。
* **選擇難度**：每首歌曲右側提供難度標籤（`BAS` / `ADV` / `EXP` / `MAS` / `Re` / `宴`），點擊即可直接載入對應譜面。

### 2. 🎮 播放器操作與速度設定
* **播放 / 暫停**：點擊兩側或底部的 `▶` / `⏸` 按鈕。
* **精準導覽**：
  * `＜＜＜` / `＞＞＞`：快退 / 快進約 3 秒。
  * `＜＜` / `＞＞`：跳至上一個 / 下一個音符。
  * `＜` / `＞`：後退 / 前進 1 個逗號（細分拍）。
* **音效、倍速與流速 (⚙️ 設定)**：
  * 點擊右上角 **⚙️ 齒輪按鈕**，可自訂：
    * **播放倍速**（0.25× ~ 1.0×，適合慢速慢放拆解配置）
    * **音符流速 (HiSpeed)**（1.0 ~ 10.0）
    * **打擊音效**（真實打擊音 / 簡易嗶聲 / 靜音）
    * **鏡像模式**（原譜 / 左右翻轉 / 上下翻轉 / 全旋轉 180°）

### 3. ✂️ 譜面片段剪輯與生成 GIF 動圖
* **選取剪輯範圍**：
  * **滑桿調整**：拖曳底部的雙端點滑桿，上方「音符密度圖」會即時高亮選取區域。
  * **一鍵設定**：播放到想要的位置時，點擊 `[⏮ 設為起點]` 或 `[⏭ 設為終點]`。
  * **合理預設長度**：切換新歌時，系統會自動選取約 **8~10 秒** 的黃金區段，避免一開始選取過長。
* **✂️ 切的乾淨模式**：
  * 開啟時，會自動推算選取區間之前的 BPM 與拍子（例如 `{4}`、`(160)`），產出一份開頭拍點完全正確的獨立小譜面。
* **🎬 送出渲染**：
  * 點擊右下角 **`[🎬 渲染為 GIF]`** ➔ 確認預覽 ➔ Bot 將在 Discord 頻道中發送高畫質流暢動圖！

### 4. 👥 宴會雙人譜面 (Utage 雙人協同)
* 載入雙人宴譜時，畫面會自動轉為**雙機台並排模式**：
  * 左側為 **1P (L)**，右側為 **2P (R)**，兩台同步播放並分別顯示各自的 Combo。
  * **各自獨立鏡像**：在 ⚙️ 設定中，可以分別將 1P 或 2P 獨立翻轉（例如 1P 鏡像、2P 原譜）。
  * **雙人渲染**：點擊渲染會自動輸出 16:9 雙機台並排的 GIF 動圖！

### 5. 🔁 「繼續看譜」一鍵還原
* 在 Discord 頻道中看到渲染出來的 GIF 時，點擊訊息下方的 **`[▶ 繼續看譜]`** 按鈕，Bot 會自動開啟 Activity 並精確還原到該首歌曲與對應的剪輯區間，方便立刻接續研究！

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
        └── ResumeSession (續看工作階段狀態管理)
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
│   ├── resume.js              # 續看工作階段狀態管理
│   └── chart.js               # 譜面管理與讀取模組
└── testChart/                 # 測試譜面庫 (.simai / .maidata)
```

---

## 💖 致謝與鳴謝 (Credits & Acknowledgments)

* **上游開源專案**：本專案的 maimai 網頁渲染核心源自於 [Susuy0725/web-mai-chart-x](https://github.com/Susuy0725/web-mai-chart-x)，在此基礎上進行架構重構與功能擴展（包含 Utage 雙人協同播放、16:9 雙機台並排渲染、滿版響應式介面、Discord Activity / Bot 深度整合、小節剪輯與訊息「繼續看譜」一鍵還原等）。特別感謝原作者 **Susuy0725** 開發並貢獻的網頁版播放核心！

---

## ⚖️ 免責與版權聲明 (Disclaimer & Copyright)

* 本專案為社群開源之非官方愛好者作品，僅供 maimai 玩家與音遊社群作為**譜面配置研究、慢速練習與技術交流**使用，**嚴禁用於任何商業或營利目的**。
* **maimai (でらっくす)** 遊戲相關之所有商標、美術素材、音效、譜面資料及相關智慧財產權均屬 **SEGA Corporation** 所有。
* 若相關版權方有任何疑慮，請透過 Issue 或 Pull Request 與我們聯繫，我們將會儘速配合調整。

---

## 📖 授權條款 (License)

本專案依據 **GNU General Public License v3.0 (GPL-3.0)** 條款開源。詳細內容請參閱專案根目錄下的 [LICENSE](LICENSE) 檔案。
