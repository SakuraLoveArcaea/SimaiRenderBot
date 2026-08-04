# Activity UI 元件命名對照表

給人看的口語名稱、對應的 Vue 元件檔案、跟畫面上可以查的 id/class，三個一起對起來，之後討論「哪個滑桿」「哪顆按鈕」才不會混淆。

## 整體版面

```
┌───────────────────────────────────────────────────────┐
│ ⚙            チューリングの跡_master                      │  ← HeaderStatus
│               連線成功：Dev                               │
├───────────────────────────────────────────────────────┤
│ BPM 180    小節 0/103    Combo 0/956                     │  ← HUD
│ ┌───┐   ┌─────────────┐   ┌───┐                          │
│ │<<<│   │             │   │>>>│                          │
│ │<< │   │ ChartCanvas │   │>> │  ← PlayerControls（左／右）│
│ │ < │   │  （音符盤）   │   │ > │                          │
│ │ ▶ │   │             │   │ ▶ │                          │
│ └───┘   └─────────────┘   └───┘                          │
├───────────────────────────────────────────────────────┤
│  ▂▄█▅▃▂▁▃▅█▄▂          ← 密度圖（Timeline 裡的 densityCanvas）│
│  ────────●──────────   ← 播放進度條（Timeline 裡的 measureSlider）│
│                                                          │
│  ✂️ 選取並傳送  Combo 1-956 (~136.2s)     ← RangeSelector  │
│  起 ────●───────────────                                  │
│  終 ───────────────────●                                  │
│  [← 起點]           [終點 →]                               │
│  [跳到起點]        [▶ 預覽]                                 │
│  [✅ 傳送此區間]                                            │
├───────────────────────────────────────────────────────┤
│ ● TAP ● HOLD ● SLIDE ● TOUCH ● BREAK    ← ColorLegend      │
│        （狀態/錯誤訊息文字）              ← FooterMessage    │
└───────────────────────────────────────────────────────┘

浮層（平常不顯示）：
  點左上角 ⚙ 才出現 → SettingsPanel（倍速／流速／音效模式／音量／切的乾淨）
  點「✅ 傳送此區間」才出現 → ConfirmModal（蓋滿全螢幕，送出前預覽）
```

## 元件對照表

| 口語名稱 | 元件檔案 | 關鍵 id / class | 做什麼 |
|---|---|---|---|
| 標題列 / 連線狀態列 | `HeaderStatus.vue` | `h1`、`.status-connecting/-ready/-error`、`.btn-retry` | 顯示歌名、連線狀態文字、失敗時的重試鈕 |
| 齒輪按鈕 / 設定按鈕 | `HeaderStatus.vue` | `.btn-settings` | 開關設定面板 |
| **設定面板** | `SettingsPanel.vue` | `#settingsPanel`（浮層本體） | 倍速／流速／音效模式／音量／切的乾淨，全部集中在這 |
| ├ 倍速滑桿 | `SettingsPanel.vue` | 第 1 個 `.speedbox` | 播放速度倍率（0.25×〜1×），只影響播放快慢，不影響畫面內容 |
| ├ 流速滑桿（ハイスピ） | `SettingsPanel.vue` | 第 2 個 `.speedbox`、`#hsVal` | note 從外圈落下到判定圈的視覺速度 |
| ├ 音效模式按鈕 | `SettingsPanel.vue` | `.btn-sfx-mode` | 循環切換 靜音／簡易（即時合成）／完整（wav 音效） |
| ├ 音量滑桿 | `SettingsPanel.vue` | `#sfxSlider`、`#sfxVal` | 音效音量，靜音模式下會自動隱藏 |
| └ 切的乾淨開關 | `SettingsPanel.vue` | 按鈕文字「✂ 切的乾淨：開/關」 | 決定匯出時是否精準切在選取範圍、不多留尾巴 |
| HUD（播放資訊列） | `App.vue`（內聯，沒有獨立成元件） | `#hud` | 顯示目前 BPM／小節進度／combo 進度 |
| **左側導覽鍵組** | `PlayerControls.vue`（`side="left"`） | 第 1 個 `.nav-col` | ＜＜＜ 後退3秒／＜＜ 上一顆音符／＜ 後退1逗號／▶ 播放 |
| **右側導覽鍵組** | `PlayerControls.vue`（`side="right"`） | 第 2 個 `.nav-col` | ＞＞＞ 前進3秒／＞＞ 下一顆音符／＞ 前進1逗號／▶ 播放 |
| 播放鍵 | `PlayerControls.vue`（左右各一顆） | `.btn-play` | 播放／暫停，左右兩顆狀態永遠同步（同一份狀態） |
| 譜面畫布 / 音符盤 | `ChartCanvas.vue` | `#stage`、`#chartCanvas` | 實際畫 note／判定線的 canvas |
| **時間軸區塊** | `Timeline.vue` | `#timeline` | 包住密度圖＋播放進度條＋範圍選取面板的容器 |
| ├ 密度圖 | `Timeline.vue` | `#densityWrap`、`#densityCanvas` | 各小節 tap/hold/slide/touch/break 數量的堆疊長條圖，疊播放頭跟選取範圍高亮；點/拖可以跳轉 |
| └ 播放進度條 | `Timeline.vue` | `#measureSlider` | 拖曳快速跳到指定小節（吸附小節邊界，見下方「小節 vs 逗號」） |

> 密度圖的統計是按小節分桶（`useChartData.js` 的 `D_arr`，長度跟 `M_arr` 一樣）。**已知細節**：第一根長條（索引 0）目前會把「前奏/pickup」跟「第一小節」的音符混在一起統計，因為分桶迴圈找不到 `n.time < M[0]` 對應的小節時會直接落在索引 0——跟播放進度條那個 `M[0] ≠ 0 秒` 是同一個根源，但這裡只影響統計呈現、不影響拖不拖得到，評估過後決定不修（影響小、前奏通常沒什麼音符，修起來要動 `M_arr` 結構，投報率低）。
| **範圍選取面板** | `RangeSelector.vue` | `#rangePanel`、`#rangeLabel` | 選要匯出送給 bot 渲染的那一段 combo 區間 |
| ├ 起點滑桿 | `RangeSelector.vue` | `#rangeTrackA`（軌道）+ 內部 `input` | 選取範圍的起點，用逗號索引定位，不是秒數 |
| ├ 終點滑桿 | `RangeSelector.vue` | `#rangeTrackB`（軌道）+ 內部 `input` | 選取範圍的終點；跟起點滑桿是各自獨立的滑桿，可以互相滑過去 |
| ├ 端點提示框 | `RangeSelector.vue` | `.range-tip` | 浮在滑塊正上方，顯示那個逗號實際的 simai 原文 |
| ├ 設起點／終點按鈕 | `RangeSelector.vue` | `#rangeEnds` 內的兩顆按鈕 | 把「目前播放頭所在位置」設為起點或終點 |
| ├ 跳到起點按鈕 | `RangeSelector.vue` | `#rangeActions` 內第一顆 | 主畫布播放頭跳到選取範圍起點 |
| ├ 預覽按鈕 | `RangeSelector.vue` | `#rangeActions` 內第二顆（「▶ 預覽」） | 開啟**預覽彈窗**（獨立 canvas），自動播放選取範圍 |
| └ 傳送此區間按鈕 | `RangeSelector.vue` | `.btn-export` | 打開確認送出彈窗，準備送出渲染請求 |
| 顏色圖例 | `ColorLegend.vue` | `#legend` | TAP/HOLD/SLIDE/TOUCH/BREAK 對應色塊說明 |
| 訊息列 | `FooterMessage.vue` | `.message`（`.success`/`.error`/`.info`） | 顯示錯誤／成功／進度提示文字，跟匯出狀態共用同一條 |
| **確認送出彈窗** | `ConfirmModal.vue` | `.modal-overlay`、`.modal-box` | 送出前預覽「實際會送出去的 simai 內容」（文字），蓋滿全螢幕 |
| **預覽彈窗** | `PreviewModal.vue` | `.preview-modal-box`、`#previewCanvas` | 送出前預覽「實際會怎麼播放」（畫面），有自己獨立的一份譜面資料＋播放引擎，不影響主畫布。點「▶ 預覽」開啟，自動播放，只有一顆關閉鈕。依「切的乾淨」開關自動選其中一種：<br>①切的乾淨開：把要送出的片段當成全新獨立譜面重新解碼，從頭播到尾（跟實際送出去渲染的內容一模一樣）<br>②切的乾淨關：沿用主譜面資料，只是在自己的 canvas 上 seek 到選取範圍播放 |

## 小節 vs 逗號：兩種不同的「位置」單位

畫面上有兩套完全不同的定位系統，容易搞混：

- **小節（measure）**：播放進度條、密度圖用的單位，音樂上「第幾小節」的概念，長度隨 BPM 變化，用來做粗略的整首歌快速掃描。
- **逗號（comma）**：範圍選取起訖點、＜／＞ 導覽鍵用的單位，對應 simai 原始碼裡實際的逗號分段（每個逗號段可能只有幾個音符甚至是空拍），是精準定位、匯出裁切的真正基準。

`小節 0` 是歌曲最開頭（含前奏／pickup）；「拖進度條到最左邊」現在已經修正成真的能回到小節 0，不會卡在第一小節開頭（見前面那次修的 bug）。

## Composable 對照（邏輯層，不是畫面元件，但常會一起討論到）

| 名稱 | 檔案 | 管什麼 |
|---|---|---|
| 譜面資料 | `useChartData.js` | 載入、解碼、前處理譜面（`chartText`／`DATA`／`M`／`N`／`D`／`C`） |
| 播放引擎 | `usePlayerEngine.js` | canvas 繪製、rAF 播放迴圈、seek／導覽運算、`measureIndex`/`measureTime` |
| 範圍選取 | `useRangeSelection.js` | 起訖點狀態、密度圖繪製、範圍標籤/時長計算 |
| 音效 | `useSfx.js` | 音效模式、音量、`audioManager` 包裝 |
| Discord 連線 | `useDiscordSession.js` | 真實 Discord 分支／本機預覽模式分支 |
| 除錯記錄 | `useDebugLogging.js` | `sendBeacon` 回報、全域錯誤攔截 |
