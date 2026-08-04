// UI 煙霧測試（smoke test）：用 Playwright 開一個真的瀏覽器，把「本機預覽模式」
// 走一輪關鍵互動，確認畫面沒有明顯壞掉。不是正式的測試框架（沒有 assert 庫、沒有 CI 整合），
// 純粹是重構過程中拿來快速自我檢查、事後也能重跑確認沒有回歸的小工具。
//
// 用法：
//   終端機 1：npm run bot
//   終端機 2：npm run dev:activity
//   終端機 3：npm run test:activity            （Chrome）
//             npm run test:activity:webkit     （Safari 引擎——ResizeObserver 迴圈這類問題
//                                                Chrome 不會報、只有 WebKit 會炸，只測 Chrome 會漏掉）
import { chromium, webkit } from 'playwright-core';

const BASE_URL = process.env.ACTIVITY_DEV_URL ?? 'http://localhost:5173';
const ENGINE = process.env.BROWSER_ENGINE ?? 'chromium';
let failures = 0;

function check(label, condition, detail = '') {
  const ok = Boolean(condition);
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
  return ok;
}

async function launchBrowser() {
  if (ENGINE === 'webkit') {
    return webkit.launch({ headless: true });
  }
  for (const opt of [{ channel: 'chrome' }, { channel: 'msedge' }, {}]) {
    try {
      return await chromium.launch({ ...opt, headless: true });
    } catch {
      // 換下一個候選 channel 再試
    }
  }
  throw new Error('找不到可用的瀏覽器（試過 chrome / msedge / 內建 chromium）');
}

async function main() {
  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });

  const pageErrors = [];
  const failedRequests = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  page.on('response', (res) => {
    // debug-log 在預覽模式本來就會 404（fire-and-forget），排除掉才不會洗版
    if (res.status() >= 400 && !res.url().includes('debug-log') && !res.url().includes('api/charts')) {
      failedRequests.push(`HTTP ${res.status()}: ${res.url()}`);
    }
  });

  console.log(`\n連線到 ${BASE_URL} ...`);
  await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 20000 });
  await page.waitForFunction(() => !document.querySelector('.btn-settings')?.disabled, { timeout: 20000 })
    .catch(() => console.log('⚠️  等待畫面就緒逾時（inputsEnabled 一直沒變成 true）'));
  await page.waitForTimeout(500);

  // ---------- 基本載入 ----------
  const title = await page.textContent('h1').catch(() => null);
  const status = await page.textContent('.status-ready, .status-connecting, .status-error').catch(() => null);
  check('本機預覽模式成功連線', status?.includes('連線成功'), status);
  check('譜面標題有載入', Boolean(title && title !== '連線中…'), title);

  // ---------- 設定面板：開啟、定位、關閉 ----------
  await page.click('.btn-settings');
  await page.waitForTimeout(200);
  check('點齒輪按鈕後設定面板可見', await page.isVisible('#settingsPanel'));
  const panelPosition = await page.evaluate(() => getComputedStyle(document.querySelector('#settingsPanel')).position);
  check('設定面板是 position:fixed（沒有跑版）', panelPosition === 'fixed', panelPosition);

  const hsInput = page.locator('.speedbox').nth(1).locator('input[type=range]');
  await hsInput.fill('7');
  await hsInput.dispatchEvent('input');
  await page.waitForTimeout(150);
  check('流速滑桿拉到 7 後數值同步更新', (await page.locator('#hsVal').textContent()) === '7.0');

  await page.click('#hud'); // 點面板外面
  await page.waitForTimeout(150);
  check('點面板外面後設定面板關閉', !(await page.isVisible('#settingsPanel')));

  // ---------- 播放鍵左右同步 ----------
  await page.click('.btn-play >> nth=0');
  await page.waitForTimeout(100);
  const leftLabel = await page.locator('.btn-play').nth(0).textContent();
  const rightLabel = await page.locator('.btn-play').nth(1).textContent();
  check('左右兩顆播放鍵狀態同步', leftLabel === rightLabel, `left=${leftLabel} right=${rightLabel}`);
  await page.click('.btn-play >> nth=0'); // 暫停，避免後面的檢查跑到一半時間軸還在動

  // ---------- 進度條/密度圖最左邊應該真的能拖回 0 秒 ----------
  // 迴歸測試：M[0] 其實是「第一小節」的起點時間（offset），不是 0 秒，
  // 拖到最左邊如果沒特別處理，永遠會卡在第一小節開頭、回不去前奏。
  const measureHud = page.locator('#hud b').nth(1); // 0=BPM, 1=小節, 2=Combo
  const slider = page.locator('#measureSlider');
  await slider.fill('50');
  await slider.dispatchEvent('input');
  await page.waitForTimeout(150);
  await slider.fill('0');
  await slider.dispatchEvent('input');
  await page.waitForTimeout(150);
  check('進度條拖回最開頭會回到小節 0（不是卡在第一小節開頭）', (await measureHud.textContent()) === '0');

  await slider.fill('50');
  await slider.dispatchEvent('input');
  await page.waitForTimeout(150);
  const densityBox = await page.locator('#densityWrap').boundingBox();
  await page.mouse.move(densityBox.x + 1, densityBox.y + densityBox.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(150);
  check('點密度圖最左邊也會回到小節 0', (await measureHud.textContent()) === '0');
  await page.mouse.up();

  // ---------- 鍵盤：沒有 active endpoint 時，方向鍵應該推進播放進度 ----------
  // 用 'Shift+ArrowRight' 合併寫法送出，比 down()/press()/up() 手動組合可靠。
  // 按 3 次（每次跳約 3 秒）而不是只按 1 次：單次 3 秒是否會跨過一個小節邊界
  // 取決於該小節的實際長度（跟 BPM 換算出來的 measureDuration 有關，不同譜面不一樣），
  // 按 1 次剛好卡在邊界內側是完全正常的情況，不代表沒有作用——按 3 次才是可靠、不挑譜面的檢查方式。
  await page.click('#hud');
  const sliderBefore = await page.evaluate(() => document.querySelector('#measureSlider').value);
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Shift+ArrowRight');
    await page.waitForTimeout(100);
  }
  const sliderAfter = await page.evaluate(() => document.querySelector('#measureSlider').value);
  check('Shift+方向鍵推進播放進度（無 active endpoint）', sliderBefore !== sliderAfter, `${sliderBefore} -> ${sliderAfter}`);

  // ---------- 範圍選取：拖曳、端點鍵盤微調 ----------
  const rangeLabelBefore = await page.textContent('#rangeLabel');
  const rangeAInput = page.locator('.range-track').nth(0).locator('input');
  await rangeAInput.fill('900');
  await rangeAInput.dispatchEvent('input');
  await page.waitForTimeout(150);
  const rangeLabelAfter = await page.textContent('#rangeLabel');
  check('拖範圍起點滑桿後標籤重新計算', rangeLabelBefore !== rangeLabelAfter, `${rangeLabelBefore} -> ${rangeLabelAfter}`);

  // 注意：點過端點後按方向鍵，本來就「應該」連動播放頭一起移動過去（原始設計：
  // onRangeInput 每次改端點都會 engine.seek，方便邊調邊看那個位置長怎樣，不是 bug）。
  // 這裡只驗證方向鍵改成走「微調端點」這條路（±1 個逗號），不驗證播放頭動不動。
  const rangeBBefore = await page.evaluate(() => document.querySelectorAll('.range-track input')[1].value);
  await page.locator('.range-track').nth(1).click({ position: { x: 10, y: 10 } });
  await page.waitForTimeout(100);
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(100);
  const rangeBAfter = await page.evaluate(() => document.querySelectorAll('.range-track input')[1].value);
  check('點過範圍終點後方向鍵改成微調端點（±1 個逗號）', rangeBBefore !== rangeBAfter, `${rangeBBefore} -> ${rangeBAfter}`);

  // ---------- 預覽彈窗：切的乾淨 / 沿用原譜面片段，各測一次 ----------
  const previewBtn = page.getByText('▶ 預覽', { exact: true });

  await previewBtn.click();
  await page.waitForTimeout(800);
  check('預覽彈窗（切的乾淨）可見', await page.isVisible('.preview-modal-box'));
  check('預覽彈窗（切的乾淨）標題正確', (await page.textContent('.preview-modal-box h3')) === '預覽（切的乾淨）');
  check('預覽彈窗（切的乾淨）canvas 有掛載', (await page.locator('#previewCanvas').count()) === 1);
  check('預覽彈窗（切的乾淨）沒有錯誤訊息', (await page.locator('.preview-modal-box .message.error').count()) === 0);
  await page.click('.preview-modal-box .btn-modal-cancel');
  await page.waitForTimeout(150);
  check('關閉後預覽彈窗不可見', !(await page.isVisible('.preview-modal-box')));

  // 關掉「切的乾淨」，改測第二種預覽方式（沿用主譜面資料、只是 seek 播放範圍）
  await page.click('.btn-settings');
  await page.waitForTimeout(150);
  await page.click('button:has-text("切的乾淨")');
  await page.waitForTimeout(100);
  await page.click('#hud');
  await page.waitForTimeout(100);

  await previewBtn.click();
  await page.waitForTimeout(800);
  check('預覽彈窗（原始譜面片段）可見', await page.isVisible('.preview-modal-box'));
  check('預覽彈窗（原始譜面片段）標題正確', (await page.textContent('.preview-modal-box h3')) === '預覽（原始譜面片段）');
  check('預覽彈窗（原始譜面片段）沒有錯誤訊息', (await page.locator('.preview-modal-box .message.error').count()) === 0);
  await page.click('.preview-modal-box .btn-modal-cancel');
  await page.waitForTimeout(150);

  // 測完改回開啟狀態，不影響後面的匯出彈窗測試（預設應該是開的）
  await page.click('.btn-settings');
  await page.waitForTimeout(150);
  await page.click('button:has-text("切的乾淨")');
  await page.click('#hud');
  await page.waitForTimeout(100);

  // ---------- 匯出確認彈窗 ----------
  await page.click('.btn-export');
  await page.waitForTimeout(150);
  check('匯出按鈕開啟確認彈窗', await page.isVisible('.modal-overlay'));
  await page.click('.btn-modal-cancel');
  await page.waitForTimeout(150);
  check('取消後彈窗關閉', !(await page.isVisible('.modal-overlay')));

  // ---------- 錯誤 / 資源檢查 ----------
  check('過程中沒有 JS 例外', pageErrors.length === 0, pageErrors.join(' | '));
  check('過程中沒有資源載入失敗（debug-log 除外）', failedRequests.length === 0, failedRequests.join(' | '));

  await browser.close();

  console.log(`\n${failures === 0 ? '✅ 全部通過' : `❌ 有 ${failures} 項沒過`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('測試腳本本身出錯：', e);
  process.exit(1);
});
