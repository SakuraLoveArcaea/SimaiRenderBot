import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 逗號切割／裁切用的純函式跟前端（activity/main.js，送出前產生預覽文字用）共用一份，
// 放在 web/Scripts 底下，確保前後端切法保證一致。
export { sliceSource, analyzeHeader, buildCleanCutSimai } from '../web/Scripts/simaiCut.js';

const CHART_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'testChart');

/** 完整譜面來源：之後改成上網抓取，現在先讀 testChart 裡第一份 .simai 檔模擬 */
export async function loadChart() {
    const files = (await fs.readdir(CHART_DIR)).filter((f) => f.endsWith('.simai')).sort();
    if (!files.length) throw new Error('NO_CHART');
    const file = files[0];
    const text = (await fs.readFile(path.join(CHART_DIR, file), 'utf8')).trim();
    return { name: path.basename(file, '.simai'), text };
}
