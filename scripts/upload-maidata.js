import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collection, doc, setDoc, getDocs, deleteDoc } from 'firebase/firestore';
import { db } from '../src/firebase.js';
import { parseMaidata } from '../src/maidata-parser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MDCP_ROOT = '/Users/lvjiayao/Downloads/mdcp';
const TEST_CHART_DIR = path.resolve(__dirname, '../testChart');

/** 遞迴搜尋指定目錄下所有 maidata.txt */
async function findMaidataFiles(dir) {
  const results = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...(await findMaidataFiles(fullPath)));
      } else if (entry.name === 'maidata.txt') {
        results.push(fullPath);
      }
    }
  } catch (e) {
    console.warn(`讀取目錄失敗 ${dir}:`, e.message);
  }
  return results;
}

function sanitizeFilename(name) {
  return name.replace(/[/\\?%*:|"<>]/g, '_').replace(/\s+/g, ' ').trim();
}

async function cleanOldFirestoreDocs() {
  console.log('🧹 正在清理 Firestore 舊的分割譜面資料...');
  try {
    const snap = await getDocs(collection(db, 'charts'));
    let deletedCount = 0;
    const batch = [];
    snap.forEach((d) => {
      batch.push(deleteDoc(doc(db, 'charts', d.id)));
    });
    await Promise.all(batch);
    console.log(`  ✅ 已清理 ${batch.length} 篇舊資料`);
  } catch (e) {
    console.warn('  ⚠️ 清理舊資料失敗:', e.message);
  }
}

async function main() {
  console.log('🚀 開始以 maimai DX CiRCLE (maidata) 格式建立譜面庫並上傳 Firestore...\n');

  // 1. 先清空舊資料以換成新架構
  await cleanOldFirestoreDocs();

  // 2. 清理 testChart/ 資料夾中舊的分割 .simai 檔案
  console.log('\n🧹 正在整理 testChart/ 目錄...');
  try {
    const existing = await fs.readdir(TEST_CHART_DIR);
    for (const f of existing) {
      if (f.endsWith('.simai') || f.endsWith('.maidata') || f.endsWith('.txt')) {
        await fs.unlink(path.join(TEST_CHART_DIR, f)).catch(() => {});
      }
    }
  } catch {}

  // 3. 掃描 mdcp 目錄
  console.log(`\n🔍 正在掃描 ${MDCP_ROOT} ...`);
  const files = await findMaidataFiles(MDCP_ROOT);
  console.log(`📂 找到 ${files.length} 首歌曲 maidata.txt`);

  let uploadedCount = 0;
  const BATCH_SIZE = 20;

  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    const chunk = files.slice(i, i + BATCH_SIZE);
    await Promise.all(chunk.map(async (filePath) => {
      try {
        const raw = await fs.readFile(filePath, 'utf8');
        const folderName = path.basename(path.dirname(filePath));
        const song = parseMaidata(raw, folderName);

        // 以 song.id 或 安全檔名 作為 doc ID
        const docId = song.id && song.id !== 'Unknown Title' ? song.id : sanitizeFilename(song.title);

        // 寫入本地 testChart/ 作為本機備份 (1 首歌 1 個 .maidata 檔)
        const localFileName = `${sanitizeFilename(song.title)}.maidata`;
        await fs.writeFile(path.join(TEST_CHART_DIR, localFileName), raw, 'utf8');

        // 上傳到 Firestore
        const docRef = doc(db, 'charts', docId);
        await setDoc(docRef, {
          ...song,
          docId,
          localFile: localFileName,
        }, { merge: true });

        uploadedCount++;
      } catch (err) {
        console.error(`  ❌ 處理失敗 (${filePath}):`, err.message);
      }
    }));
    process.stdout.write(`\r  ⚡ 上傳進度: ${Math.min(i + BATCH_SIZE, files.length)} / ${files.length} 首歌曲`);
  }

  console.log(`\n\n🎉 轉換與上傳完成！共儲存 ${uploadedCount} 首完整歌曲（包含所有難度）至 Firestore 與 testChart/。`);
}

main().catch(err => {
  console.error('💥 腳本執行異常:', err);
  process.exit(1);
});
