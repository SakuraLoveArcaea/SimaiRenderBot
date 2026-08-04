import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 逗號切割／裁切純函式與前端共用
export { sliceSource, analyzeHeader, buildCleanCutSimai } from '../engine/Scripts/simaiCut.js';

const CHART_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'testChart');

/** 列出所有 testChart 目錄下的測試 .simai 檔案 */
export async function listCharts() {
    try {
        const files = (await fs.readdir(CHART_DIR)).filter((f) => f.endsWith('.simai')).sort();
        return files.map((f) => ({
            id: f,
            name: path.basename(f, '.simai'),
        }));
    } catch {
        return [];
    }
}

/** 讀取 testChart 裡的指定 .simai 檔案（未指定時讀取第一份） */
export async function loadChart(filename) {
    const files = (await fs.readdir(CHART_DIR)).filter((f) => f.endsWith('.simai')).sort();
    if (!files.length) throw new Error('NO_CHART');
    const targetFile = filename && files.includes(filename) ? filename : files[0];
    const text = (await fs.readFile(path.join(CHART_DIR, targetFile), 'utf8')).trim();
    return { name: path.basename(targetFile, '.simai'), text, filename: targetFile };
}
