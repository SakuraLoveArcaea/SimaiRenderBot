# SimaiRenderBot

Discord bot：輸入 simai 語法片段 → 產出譜面預覽 GIF。

渲染核心提取自 [web-mai-chart-x](https://github.com/susuy0725/web-mai-chart-x)（decode / renderer / helper），
以無頭 Chromium 逐幀畫 canvas，PNG 幀直接串給 ffmpeg 轉成壓縮 GIF。

## 架構

```
simai 文字
  → Playwright 無頭 Chromium 開 web/render.html
      → simaiDecode() 解析 → SimaiLogicControler 逐幀算狀態 → SimaiRenderer 畫 canvas
      → 每幀 toDataURL 成 PNG，透過 __emitFrame binding 串回 Node
  → ffmpeg 從 stdin 讀 PNG 序列，palettegen 兩段式轉 GIF + gifsicle lossy 二次壓縮（自動降畫質直到 < 10MB）
  → Discord 附件回覆
```

以 PNG 幀直接串給 ffmpeg，跳過了 WebCodecs 的 H.264 中間層（那趟編碼/解碼對最終 GIF 畫質毫無幫助，畫質由調色盤量化決定）；
且瀏覽器直接以 GIF 輸出的 15fps 渲染（而非畫 30fps 再丟一半）。兩者合計讓固定開銷約砍半、稀疏長譜面渲染再快 15~25%。
副帶好處：不再需要瀏覽器支援 H.264 編碼，vanilla Playwright Chromium 也能跑。

## 需求

- Node.js 22+
- ffmpeg（`brew install ffmpeg`）
- gifsicle（`brew install gifsicle`，選用但強烈建議：GIF 可再省 30~50% 體積；沒裝也能跑，只是檔案較大）
- Google Chrome（或執行 `npx playwright install chromium`）

## 安裝與測試

```bash
npm install

# CLI 測試（不需要 Discord）
node src/cli.js "(150){4}1,2,3,4,E" out/test.gif
node src/cli.js --file chart.txt out/test.gif
```

## 啟動 Discord bot

1. 到 [Discord Developer Portal](https://discord.com/developers/applications) 建立 Application → Bot，拿 Token
2. `cp .env.example .env`，填入 `DISCORD_TOKEN`、`DISCORD_APP_ID`（測試時建議也填 `DISCORD_GUILD_ID`）
3. 註冊指令並啟動：

```bash
npm run register
npm run bot
```

邀請連結權限：`applications.commands` + `bot`（Send Messages、Attach Files）。

## 指令

| 入口 | 說明 |
|---|---|
| `/render simai:<語法> [start] [end] [fps]` | 渲染成 GIF 回覆（公開）。單行輸入用 |
| `/check simai:<語法>` | 只解析：長度 / BPM / note 統計 / 語法警告（僅自己可見） |
| `/keyboard`（隱藏中） | 互動鍵盤：圓形按鈕點出譜面。預設不註冊，`.env` 設 `ENABLE_KEYBOARD=1` 後 `npm run register` 開啟 |
| `/compose` | 跳出多行輸入視窗（Modal），貼入 simai 後回覆整理好的 ` ```simai``` ` 區塊 + 🎬 渲染按鈕，10 分鐘內有效 |
| 右鍵訊息 → Apps → 渲染譜面 | 渲染整則訊息（有 code block 就抓 code block，否則吃整段文字），多行譜面用這個 |
| 貼出 ` ```simai ` code block | bot 自動加 🎬 反應，有人點了才渲染（避免洗版） |

渲染結果（GIF）本身不附 simai 文字，只有 Embed + 圖片；需要可複製的 simai 文字請用 `/compose`。
每個渲染入口都會依序更新狀態：`✅ 已收到，準備渲染…` → `🎬 正在渲染中，預估約 N 秒，請稍候…` → 最終結果。
預估秒數來自 `estimateRenderMs()`（[src/render.js](src/render.js)）：對 9 組長度×密度組合實測擬合的迴歸公式
`ms ≈ (523 + 143.6×秒數 + 65×總音符數) × 1.15`（PNG 串流管線下重新擬合，誤差多在 ±3%）。

多行譜面建議直接在頻道貼：

````
```simai
(150){4}
1,2,3,4,
E
```
````

- 開頭沒寫 `(BPM){分拍}` 會直接被擋下，不會讓 decode.js 靜默套用 60bpm/{4} 預設值渲染出錯誤結果；
  拒絕訊息會附一顆「✏️ 補上開頭」按鈕，點下去跳出表單——**智能判斷缺哪一半**，只顯示缺的欄位（BPM 或分拍或兩者），
  並帶出原本的譜面內容，填完自動接上缺的設定
- 語法警告會用 code block + `^^^` 指出出錯的逗號段
- 🎬 自動偵測需要在 Developer Portal → Bot 開啟 **Message Content Intent**
- 單次渲染的譜面長度上限預設 30 秒（`MAX_DURATION`），超過的部分不畫，太長請用 `start`/`end` 選段
- 渲染前先估算耗時，**預估超過 30 秒（`MAX_RENDER_SEC`）就直接拒絕**，不讓使用者空等；主要會擋到極端密集的譜面
- GIF 會自動走壓縮階梯直到低於 Discord 10MB 上限：**fps 固定 15**（優先保留流暢度），逐級妥協的是色數與寬度（360px/64色 → 320px/48色 → 280px/32色），最後一級才不得已降到 12fps/240px；每級都會過 gifsicle `--lossy=100` 二次壓縮
- 每人預設 10 秒冷卻（`COOLDOWN_MS`）

## 復讀機頻道（額外功能）

指定頻道（`src/bot.js` 的 `ECHO_CHANNEL_ID`）內任何人發言，bot 會原樣重複一次，不做 simai 偵測；其他頻道不受影響。

## 檔案結構

```
web/render.html        無 UI 渲染頁：window.renderChartToFrames(simai, opts) 逐幀 PNG 串回 Node
web/Scripts/           自 web-mai-chart-x 提取的核心（未修改）
web/Skin/  web/Fonts/  素材
src/server.js          服務 web/ 的極簡靜態伺服器
src/render.js          SimaiRenderService：常駐瀏覽器 + ffmpeg GIF 壓縮階梯
src/cli.js             本機測試 CLI
src/register-commands.js  Slash command 註冊
src/bot.js             Discord bot 本體
```

## 致謝

`web/Scripts/`（decode.js / renderer.js / helper.js / indexDB.js）與 `web/Skin/`、`web/Fonts/`
均直接提取自 [susuy0725/web-mai-chart-x](https://github.com/susuy0725/web-mai-chart-x)，未修改渲染邏輯本身。
該專案的 Skin 與音訊素材則源自 [LingFeng-bbben/MajdataView](https://github.com/LingFeng-bbben/MajdataView) 與
[re-poem/MajdataViewX](https://github.com/re-poem/MajdataViewX)。

> ⚠️ web-mai-chart-x 本身未附 LICENSE 檔案。發佈本專案前，建議先向原作者確認授權方式，
> 或至少在你的 repo 說明中保留以上出處與致謝。
