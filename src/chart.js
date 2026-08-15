import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collection, getDocs, doc, getDoc } from 'firebase/firestore';
import { db } from './firebase.js';

// 逗號切割／裁切純函式與前端共用
export { sliceSource, analyzeHeader, buildCleanCutSimai } from '../engine/Scripts/simaiCut.js';

const CHART_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'testChart');

let firestoreCache = null;
let lastCacheTime = 0;
const CACHE_TTL_MS = 60_000; // 1 分鐘快取

/** 列出所有可用譜面（優先從 Firebase Firestore，並合併本機 testChart） */
export async function listCharts() {
    const now = Date.now();
    if (firestoreCache && now - lastCacheTime < CACHE_TTL_MS) {
        return firestoreCache;
    }

    const chartMap = new Map();

    // 1. 讀取 Firebase Firestore
    try {
        const snap = await getDocs(collection(db, 'charts'));
        snap.forEach((d) => {
            const data = d.data();
            chartMap.set(d.id, {
                id: d.id,
                name: data.name || data.title || d.id,
                title: data.title || data.name || d.id,
                difficulty: data.difficulty || '',
                bpm: data.bpm ?? null,
                source: 'firebase',
            });
        });
    } catch (e) {
        console.warn('[chart.js] 從 Firebase 讀取譜面列表失敗，使用本機譜面作為備援:', e.message);
    }

    // 2. 讀取本機 testChart/ 目錄補強
    try {
        const files = (await fs.readdir(CHART_DIR)).filter((f) => f.endsWith('.simai') || f.endsWith('.txt')).sort();
        for (const f of files) {
            const base = path.basename(f).replace(/\.(simai|txt)$/i, '');
            if (!chartMap.has(base) && !chartMap.has(f)) {
                chartMap.set(base, {
                    id: base,
                    name: base,
                    title: base,
                    difficulty: '',
                    source: 'local',
                });
            }
        }
    } catch {}

    const result = Array.from(chartMap.values()).sort((a, b) => a.name.localeCompare(b.name));
    if (result.length > 0) {
        firestoreCache = result;
        lastCacheTime = now;
    }
    return result;
}

/** 讀取指定譜面資料（依 id 或檔名，優先從 Firestore 讀取，再備援本機檔案） */
export async function loadChart(chartId) {
    // 1. 若有指定 ID，優先向 Firestore 查詢
    if (chartId) {
        try {
            const docRef = doc(db, 'charts', chartId);
            const snap = await getDoc(docRef);
            if (snap.exists()) {
                const data = snap.data();
                return {
                    name: data.name || data.title || chartId,
                    text: data.text,
                    filename: `${chartId}.simai`,
                    bpm: data.bpm,
                };
            }
        } catch (e) {
            console.warn(`[chart.js] 從 Firebase 讀取譜面 ${chartId} 失敗，嘗試本機檔案:`, e.message);
        }
    }

    // 2. 本機檔案比對（支援 id 或檔名）
    try {
        const files = (await fs.readdir(CHART_DIR)).filter((f) => f.endsWith('.simai') || f.endsWith('.txt')).sort();
        if (files.length) {
            let targetFile = files[0];
            if (chartId) {
                const matched = files.find(f => f === chartId || path.basename(f, path.extname(f)) === chartId || f.startsWith(chartId));
                if (matched) targetFile = matched;
            }
            const text = (await fs.readFile(path.join(CHART_DIR, targetFile), 'utf8')).trim();
            return {
                name: path.basename(targetFile, path.extname(targetFile)),
                text,
                filename: targetFile,
            };
        }
    } catch {}

    // 3. 若都找不到且沒傳 chartId，從 Firestore 取第一筆
    try {
        const list = await listCharts();
        if (list.length > 0) {
            const first = list[0];
            const docRef = doc(db, 'charts', first.id);
            const snap = await getDoc(docRef);
            if (snap.exists()) {
                const data = snap.data();
                return {
                    name: data.name || data.title || first.id,
                    text: data.text,
                    filename: `${first.id}.simai`,
                    bpm: data.bpm,
                };
            }
        }
    } catch {}

    throw new Error(`找不到指定的譜面：${chartId || '(未指定)'}`);
}
