# SimaiRenderBot

Discord bot：輸入 simai 語法片段 → 產出譜面預覽 GIF。

渲染核心提取自 [web-mai-chart-x](https://github.com/susuy0725/web-mai-chart-x)（decode / renderer / helper / mediabunny），
以無頭 Chromium 逐幀渲染成影片，再用 ffmpeg 轉成壓縮 GIF。

## 架構

```
simai 文字
  → Playwright 無頭 Chromium 開 web/render.html
      → simaiDecode() 解析 → SimaiLogicControler 逐幀算狀態 → SimaiRenderer 畫 canvas
      → Mediabunny (WebCodecs) 編碼成 MP4/WebM
  → ffmpeg palettegen 兩段式轉 GIF + gifsicle lossy 二次壓縮（自動降畫質直到 < 10MB）
  → Discord 附件回覆
```

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
| 右鍵訊息 → Apps → 渲染譜面 | 抓訊息裡的 code block 渲染，多行譜面用這個 |
| 貼出 ` ```simai ` code block | bot 自動加 🎬 反應，有人點了才渲染（避免洗版） |

渲染結果（GIF）本身不附 simai 文字，只有 Embed + 圖片；需要可複製的 simai 文字請用 `/compose`。
每個渲染入口都會依序更新狀態：`✅ 已收到，準備渲染…` → `🎬 正在渲染中，請稍候…` → 最終結果。

多行譜面建議直接在頻道貼：

````
```simai
(150){4}
1,2,3,4,
E
```
````

- 語法警告會用 code block + `^^^` 指出出錯的逗號段
- 🎬 自動偵測需要在 Developer Portal → Bot 開啟 **Message Content Intent**
- 單次渲染上限預設 30 秒（`MAX_DURATION`），太長請用 `start`/`end` 選段
- GIF 會自動走壓縮階梯直到低於 Discord 10MB 上限：**fps 固定 15**（優先保留流暢度），逐級妥協的是色數與寬度（360px/64色 → 320px/48色 → 280px/32色），最後一級才不得已降到 12fps/240px；每級都會過 gifsicle `--lossy=100` 二次壓縮
- 每人預設 10 秒冷卻（`COOLDOWN_MS`）

## 檔案結構

```
web/render.html        無 UI 渲染頁：window.renderChart(simai, opts) → 影片 base64
web/Scripts/           自 web-mai-chart-x 提取的核心（未修改）
web/Skin/  web/Fonts/  素材
src/server.js          服務 web/ 的極簡靜態伺服器
src/render.js          SimaiRenderService：常駐瀏覽器 + ffmpeg GIF 壓縮階梯
src/cli.js             本機測試 CLI
src/register-commands.js  Slash command 註冊
src/bot.js             Discord bot 本體
```

## 致謝

`web/Scripts/`（decode.js / renderer.js / helper.js / indexDB.js / mediabunny.cjs）與 `web/Skin/`、`web/Fonts/`
均直接提取自 [susuy0725/web-mai-chart-x](https://github.com/susuy0725/web-mai-chart-x)，未修改渲染邏輯本身。
該專案的 Skin 與音訊素材則源自 [LingFeng-bbben/MajdataView](https://github.com/LingFeng-bbben/MajdataView) 與
[re-poem/MajdataViewX](https://github.com/re-poem/MajdataViewX)。

> ⚠️ web-mai-chart-x 本身未附 LICENSE 檔案。發佈本專案前，建議先向原作者確認授權方式，
> 或至少在你的 repo 說明中保留以上出處與致謝。
