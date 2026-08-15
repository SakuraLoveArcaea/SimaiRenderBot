/**
 * maidata.txt 格式解析器
 * 將 maimai DX maidata.txt 完整解析為結構化歌曲與多難度譜面物件
 */

export const DIFFICULTY_KEYS = {
  1: 'basic',
  2: 'advanced',
  3: 'expert',
  4: 'master',
  5: 're_master',
  6: 'utage',
  7: 'utage',
};

export const DIFFICULTY_LABELS = {
  basic: 'BASIC',
  advanced: 'ADVANCED',
  expert: 'EXPERT',
  master: 'MASTER',
  re_master: 'Re:MASTER',
  utage: '宴',
};

/**
 * 解析 maidata.txt 文字內容
 * @param {string} content - maidata.txt 原始文字
 * @param {string} fallbackId - 若無 shortid 時的替代 ID（如資料夾名或曲名）
 * @returns {object} 結構化歌曲物件
 */
export function parseMaidata(content, fallbackId = '') {
  const meta = {};
  const inotes = {};
  const levels = {};
  const designers = {};

  let currentKey = null;
  let currentBuffer = [];

  for (const line of content.split('\n')) {
    const match = line.match(/^&([^=]+)=(.*)$/);
    if (match) {
      if (currentKey) {
        saveField(currentKey, currentBuffer.join('\n').trim(), { meta, inotes, levels, designers });
      }
      currentKey = match[1];
      currentBuffer = [match[2]];
    } else {
      currentBuffer.push(line);
    }
  }
  if (currentKey) {
    saveField(currentKey, currentBuffer.join('\n').trim(), { meta, inotes, levels, designers });
  }

  const title = meta.title || fallbackId || 'Unknown Title';
  const id = meta.shortid || fallbackId || sanitizeId(title);
  const bpm = parseFloat(meta.wholebpm) || 120;
  const first = meta.first ? parseFloat(meta.first) : null;
  const artist = meta.artist || '';
  const genre = meta.genre || '';
  const version = meta.version || 'maimai DX CiRCLE';

  // 整理所有有譜面內容的難度
  const availableDifficulties = Object.keys(inotes).filter(k => inotes[k] && inotes[k].length > 10);

  // 排序難度順序 (basic -> advanced -> expert -> master -> re_master -> utage)
  const diffOrder = ['basic', 'advanced', 'expert', 'master', 're_master', 'utage'];
  availableDifficulties.sort((a, b) => diffOrder.indexOf(a) - diffOrder.indexOf(b));

  return {
    id: String(id),
    title,
    artist,
    genre,
    bpm,
    first,
    version,
    levels,
    designers,
    inotes,
    availableDifficulties,
    rawMaidata: content,
    updatedAt: new Date().toISOString(),
  };
}

function saveField(key, value, { meta, inotes, levels, designers }) {
  if (key.startsWith('inote_')) {
    const num = parseInt(key.slice(6), 10);
    const diffName = DIFFICULTY_KEYS[num] || key;
    inotes[diffName] = value;
  } else if (key.startsWith('lv_')) {
    const num = parseInt(key.slice(3), 10);
    const diffName = DIFFICULTY_KEYS[num] || key;
    levels[diffName] = value;
  } else if (key.startsWith('des_')) {
    const num = parseInt(key.slice(4), 10);
    const diffName = DIFFICULTY_KEYS[num] || key;
    designers[diffName] = value;
  } else {
    meta[key] = value;
  }
}

/**
 * 依據指定難度組裝出可以直接給渲染器或引擎使用的標準 simai 譜面本文
 */
export function buildSimaiFromSong(song, requestedDiff = null) {
  if (!song || !song.inotes) throw new Error('無效的歌曲物件');

  // 若未指定難度，優先選 master -> re_master -> expert -> 第一個可用難度
  let diff = requestedDiff;
  if (!diff || !song.inotes[diff]) {
    if (song.inotes['master']) diff = 'master';
    else if (song.inotes['re_master']) diff = 're_master';
    else if (song.inotes['expert']) diff = 'expert';
    else diff = song.availableDifficulties[0];
  }

  const rawInote = song.inotes[diff];
  if (!rawInote) {
    throw new Error(`歌曲「${song.title}」沒有難度 [${diff}] 的譜面`);
  }

  // 確保開頭有 BPM
  let simaiText = rawInote;
  if (!simaiText.startsWith('(') && !simaiText.match(/^\([0-9.]+\)/)) {
    simaiText = `(${song.bpm || 120})\n${simaiText}`;
  }

  const level = song.levels?.[diff] ? ` ${song.levels[diff]}` : '';
  const diffLabel = DIFFICULTY_LABELS[diff] || diff.toUpperCase();
  const displayName = `${song.title} [${diffLabel}${level}]`;

  return {
    name: displayName,
    title: song.title,
    difficulty: diff,
    level: song.levels?.[diff] || '',
    bpm: song.bpm,
    text: simaiText,
    filename: `${sanitizeId(song.title)}_${diff}.simai`,
  };
}

function sanitizeId(name) {
  return name.replace(/[/\\?%*:|"<>]/g, '_').replace(/\s+/g, '_').trim();
}
