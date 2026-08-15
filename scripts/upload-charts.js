import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { doc, setDoc } from 'firebase/firestore';
import { db } from '../src/firebase.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 預設來源目錄
const TARGET_DIRS = [
  '/Users/lvjiayao/Projects/simai_to_lilipond_v3/chart',
  path.resolve(__dirname, '../testChart'),
];

/**
 * 從檔名推測曲名與難度
 */
function parseFilenameMeta(filename) {
  const base = filename.replace(/\.(txt|simai)$/i, '');
  
  const diffMap = {
    're_master': 'Re:MASTER',
    'remaster': 'Re:MASTER',
    'master': 'MASTER',
    'expert': 'EXPERT',
    'advanced': 'ADVANCED',
    'basic': 'BASIC',
  };

  let title = base;
  let difficulty = 'MASTER';

  for (const [key, val] of Object.entries(diffMap)) {
    const regex = new RegExp(`[._-]${key}$`, 'i');
    if (regex.test(base)) {
      title = base.replace(regex, '');
      difficulty = val;
      break;
    }
  }

  return { id: base, title, difficulty, displayName: base };
}

/**
 * 純 Node 解析 simai 基本元數據（BPM、逗號段落數）
 */
function extractSimaiMeta(text) {
  let bpm = 120;
  const bpmMatch = text.match(/\(([0-9]+(?:\.[0-9]+)?)\)/);
  if (bpmMatch) {
    bpm = parseFloat(bpmMatch[1]);
  }
  const clean = text.replace(/\|\|.*$/gm, '').replace(/\s+/g, '');
  const commaCount = (clean.match(/,/g) || []).length;
  return { bpm, commaCount };
}

async function uploadFromDirectory(dirPath) {
  try {
    const files = await fs.readdir(dirPath);
    const validFiles = files.filter(f => !f.startsWith('.') && (f.endsWith('.txt') || f.endsWith('.simai')));
    
    console.log(`\n📂 正在處理目錄: ${dirPath} (共 ${validFiles.length} 個譜面)`);

    let successCount = 0;
    let failCount = 0;

    for (const filename of validFiles) {
      const fullPath = path.join(dirPath, filename);
      try {
        const text = await fs.readFile(fullPath, 'utf8');
        if (!text.trim()) {
          console.warn(`  ⚠️ 跳過空白檔案: ${filename}`);
          continue;
        }

        const { id, title, difficulty, displayName } = parseFilenameMeta(filename);
        const { bpm, commaCount } = extractSimaiMeta(text);

        const chartDoc = {
          id,
          name: displayName,
          title,
          difficulty,
          bpm,
          commaCount,
          text,
          filename,
          sourceDir: path.basename(dirPath),
          updatedAt: new Date().toISOString(),
        };

        // 寫入 Firestore 集合 'charts'
        const docRef = doc(db, 'charts', id);
        await setDoc(docRef, chartDoc, { merge: true });

        console.log(`  ✅ [${difficulty}] ${title} (BPM: ${bpm}, 段落數: ${commaCount}) -> ${id}`);
        successCount++;
      } catch (err) {
        console.error(`  ❌ 上傳失敗 (${filename}):`, err.message);
        failCount++;
      }
    }

    return { successCount, failCount };
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.warn(`⚠️ 目錄不存在: ${dirPath}`);
      return { successCount: 0, failCount: 0 };
    }
    throw err;
  }
}

async function main() {
  console.log('🚀 開始上傳譜面至 Firebase (simaidb.firebaseapp.com)...');
  const startTime = Date.now();

  let totalSuccess = 0;
  let totalFail = 0;

  for (const dir of TARGET_DIRS) {
    const { successCount, failCount } = await uploadFromDirectory(dir);
    totalSuccess += successCount;
    totalFail += failCount;
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`\n🎉 上傳完成！成功: ${totalSuccess} 篇，失敗: ${totalFail} 篇 (耗時 ${elapsed} 秒)`);
  process.exit(totalFail > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('💥 腳本執行異常:', err);
  process.exit(1);
});
