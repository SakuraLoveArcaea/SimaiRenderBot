import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CHART_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'testChart');

/** 完整譜面來源：之後改成上網抓取，現在先讀 testChart 裡第一份 .simai 檔模擬 */
export async function loadChart() {
    const files = (await fs.readdir(CHART_DIR)).filter((f) => f.endsWith('.simai')).sort();
    if (!files.length) throw new Error('NO_CHART');
    const file = files[0];
    const text = (await fs.readFile(path.join(CHART_DIR, file), 'utf8')).trim();
    return { name: path.basename(file, '.simai'), text };
}

/**
 * 取 [start, end) 秒範圍對應的 simai 原文片段（依逗號段切）。
 * 前處理與 decode.js 相同，逗號索引才對得上 indexToTime；
 * indexToTime[i] = 第 i 個逗號段的起始時間，最後多一格是譜面結尾。
 */
export function sliceSource(simaiText, indexToTime, start, end) {
    const parts = simaiText.replace(/\|\|.*$/gm, '').replace(/\s+/g, '').split(',');
    let i0 = 0;
    let i1 = parts.length - 1;
    for (let i = 0; i < parts.length; i++) {
        const segStart = indexToTime[i] ?? 0;
        const segEnd = indexToTime[i + 1] ?? segStart;
        if (segEnd <= start) i0 = Math.min(i + 1, parts.length - 1);
        if (segStart < end) i1 = i;
    }
    return parts.slice(i0, i1 + 1).join(',');
}
