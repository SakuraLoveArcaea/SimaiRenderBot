import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MDCP_ROOT = '/Users/lvjiayao/Downloads/mdcp';
const OUTPUT_DIR = path.resolve(__dirname, '../testChart');

const DIFF_NAMES = {
  inote_1: 'basic',
  inote_2: 'advanced',
  inote_3: 'expert',
  inote_4: 'master',
  inote_5: 're_master',
  inote_6: 'utage',
  inote_7: 'utage',
};

// 檔名過濾：移除檔案系統不允許的特殊字元
function sanitizeFilename(name) {
  return name
    .replace(/[/\\?%*:|"<>]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 遞迴找出所有 maidata.txt */
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

/** 解析 maidata.txt 中的標籤與各難度 inote */
function parseMaidata(content) {
  const meta = {};
  const inotes = {};
  let currentKey = null;
  let currentBuffer = [];

  for (const line of content.split('\n')) {
    const match = line.match(/^&([^=]+)=(.*)$/);
    if (match) {
      if (currentKey) {
        if (currentKey.startsWith('inote_')) {
          inotes[currentKey] = currentBuffer.join('\n').trim();
        } else {
          meta[currentKey] = currentBuffer.join('\n').trim();
        }
      }
      currentKey = match[1];
      currentBuffer = [match[2]];
    } else {
      currentBuffer.push(line);
    }
  }
  if (currentKey) {
    if (currentKey.startsWith('inote_')) {
      inotes[currentKey] = currentBuffer.join('\n').trim();
    } else {
      meta[currentKey] = currentBuffer.join('\n').trim();
    }
  }
  return { meta, inotes };
}

async function main() {
  console.log(`🔍 正在掃描 ${MDCP_ROOT} ...`);
  const files = await findMaidataFiles(MDCP_ROOT);
  console.log(`📂 找到 ${files.length} 首歌曲 maidata.txt\n`);

  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  let totalChartsCreated = 0;

  for (const filePath of files) {
    try {
      const rawContent = await fs.readFile(filePath, 'utf8');
      const { meta, inotes } = parseMaidata(rawContent);

      const title = meta.title || path.basename(path.dirname(filePath));
      const safeTitle = sanitizeFilename(title);
      const bpm = meta.wholebpm || '120';

      for (const [inoteKey, chartText] of Object.entries(inotes)) {
        if (!chartText || chartText.length < 10) continue;

        const diffSuffix = DIFF_NAMES[inoteKey] || inoteKey;
        
        // 確保譜面開頭有 (BPM) 標記
        let finalSimai = chartText;
        if (!finalSimai.startsWith('(') && !finalSimai.match(/^\([0-9.]+\)/)) {
          finalSimai = `(${bpm})\n${finalSimai}`;
        }

        const outFilename = `${safeTitle}_${diffSuffix}.simai`;
        const outPath = path.join(OUTPUT_DIR, outFilename);

        await fs.writeFile(outPath, finalSimai, 'utf8');
        console.log(`  ✨ 已產出: ${outFilename}`);
        totalChartsCreated++;
      }
    } catch (err) {
      console.error(`  ❌ 處理失敗 (${filePath}):`, err.message);
    }
  }

  console.log(`\n🎉 轉換完成！共在 testChart/ 產出 ${totalChartsCreated} 個 .simai 譜面檔案。`);
}

main().catch(err => {
  console.error('執行錯誤:', err);
  process.exit(1);
});
