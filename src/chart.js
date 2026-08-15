import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collection, getDocs, doc, getDoc } from 'firebase/firestore';
import { db } from './firebase.js';
import { parseMaidata, buildSimaiFromSong, DIFFICULTY_LABELS } from './maidata-parser.js';

// 逗號切割／裁切純函式與前端共用
export { sliceSource, analyzeHeader, buildCleanCutSimai } from '../engine/Scripts/simaiCut.js';

const CHART_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'testChart');

let firestoreCache = null;
let lastCacheTime = 0;
const CACHE_TTL_MS = 60_000; // 1 分鐘快取

/** 列出所有可用歌曲（包含各可用難度與等級資訊） */
export async function listCharts() {
    const now = Date.now();
    if (firestoreCache && now - lastCacheTime < CACHE_TTL_MS) {
        return firestoreCache;
    }

    const songMap = new Map();

    // 1. 讀取 Firebase Firestore
    try {
        const snap = await getDocs(collection(db, 'charts'));
        snap.forEach((d) => {
            const data = d.data();
            songMap.set(d.id, {
                id: d.id,
                title: data.title || d.id,
                name: data.title || d.id,
                artist: data.artist || '',
                bpm: data.bpm,
                levels: data.levels || {},
                availableDifficulties: data.availableDifficulties || Object.keys(data.inotes || {}),
                source: 'firebase',
            });
        });
    } catch (e) {
        console.warn('[chart.js] 從 Firebase 讀取歌曲失敗:', e.message);
    }

    // 2. 讀取本機 testChart/ 目錄
    try {
        const files = (await fs.readdir(CHART_DIR)).filter(f => f.endsWith('.maidata') || f.endsWith('.simai') || f.endsWith('.txt')).sort();
        for (const f of files) {
            const base = path.basename(f).replace(/\.(maidata|simai|txt)$/i, '');
            if (!songMap.has(base) && !songMap.has(f)) {
                try {
                    const raw = await fs.readFile(path.join(CHART_DIR, f), 'utf8');
                    const parsed = parseMaidata(raw, base);
                    songMap.set(parsed.id || base, {
                        id: parsed.id || base,
                        title: parsed.title || base,
                        name: parsed.title || base,
                        artist: parsed.artist || '',
                        bpm: parsed.bpm,
                        levels: parsed.levels || {},
                        availableDifficulties: parsed.availableDifficulties,
                        source: 'local',
                    });
                } catch {
                    songMap.set(base, {
                        id: base,
                        title: base,
                        name: base,
                        availableDifficulties: ['master'],
                        source: 'local',
                    });
                }
            }
        }
    } catch {}

    const result = Array.from(songMap.values()).sort((a, b) => a.title.localeCompare(b.title));
    if (result.length > 0) {
        firestoreCache = result;
        lastCacheTime = now;
    }
    return result;
}

/** 讀取指定歌曲與難度（例如 "11943:master" 或 "11943" 帶 diff="master"） */
export async function loadChart(songIdWithDiff, requestedDiff = null) {
    let songId = songIdWithDiff;
    let diff = requestedDiff;

    if (songIdWithDiff && songIdWithDiff.includes(':')) {
        const parts = songIdWithDiff.split(':');
        songId = parts[0];
        diff = parts[1];
    }

    // 1. 優先向 Firestore 查詢
    if (songId) {
        try {
            const docRef = doc(db, 'charts', songId);
            const snap = await getDoc(docRef);
            if (snap.exists()) {
                const song = snap.data();
                return buildSimaiFromSong(song, diff);
            }
        } catch (e) {
            console.warn(`[chart.js] Firestore 讀取 ${songId} 失敗:`, e.message);
        }
    }

    // 2. 本機 testChart/ 查詢
    try {
        const files = (await fs.readdir(CHART_DIR)).filter(f => f.endsWith('.maidata') || f.endsWith('.simai') || f.endsWith('.txt'));
        if (files.length) {
            let targetFile = files[0];
            if (songId) {
                const matched = files.find(f => f === songId || path.basename(f, path.extname(f)) === songId || f.startsWith(songId));
                if (matched) targetFile = matched;
            }
            const raw = await fs.readFile(path.join(CHART_DIR, targetFile), 'utf8');
            const song = parseMaidata(raw, path.basename(targetFile, path.extname(targetFile)));
            return buildSimaiFromSong(song, diff);
        }
    } catch {}

    // 3. 預設取第一首
    try {
        const list = await listCharts();
        if (list.length > 0) {
            const first = list[0];
            const docRef = doc(db, 'charts', first.id);
            const snap = await getDoc(docRef);
            if (snap.exists()) {
                return buildSimaiFromSong(snap.data(), diff);
            }
        }
    } catch {}

    throw new Error(`找不到指定的歌曲或譜面：${songId || '(未指定)'}`);
}
