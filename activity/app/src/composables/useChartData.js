import { ref, shallowRef, computed } from 'vue';
import { simaiDecode } from '../../../../engine/Scripts/decode.js';
import { splitCommaParts } from '../../../../engine/Scripts/simaiCut.js';
import { contantRotate, flipSelectedText } from '../../../../engine/Scripts/helper.js';

const MIRROR_MODES = ['原譜', '左右', '上下', '全'];

/**
 * 根據鏡像模式轉換 simai 原始文字。
 * 0 = 原譜（不動），1 = 左右翻轉，2 = 上下翻轉，3 = 全（旋轉 180°）
 */
function applyMirror(text, mode) {
  if (!text || mode === 0) return text;
  if (mode === 3) {
    // 全 = 旋轉 180°
    return contantRotate(text, 4);
  }
  if (mode === 1) {
    // 左右翻轉
    const deMap = { 1: 1, 2: 8, 3: 7, 4: 6, 5: 5, 6: 4, 7: 3, 8: 2 };
    return flipSelectedText(text, deMap, (ch) => {
      const n = parseInt(ch, 10);
      return ((8 - n) % 8 + 1).toString();
    }, {
      p: 'q', q: 'p',
      s: 'z', z: 's',
      '<': '>', '>': '<'
    });
  }
  if (mode === 2) {
    // 上下翻轉
    const deMap = { 1: 5, 2: 4, 3: 3, 4: 2, 5: 1, 6: 8, 7: 7, 8: 6 };
    return flipSelectedText(text, deMap, (ch) => {
      const n = parseInt(ch, 10);
      return ((12 - n) % 8 + 1).toString();
    }, {
      p: 'q', q: 'p'
    });
  }
  return text;
}

function extractComboTimes(decodedNotes) {
  const times = [];
  for (const n of (decodedNotes || [])) {
    if (n.isMine) continue;
    if (n.type === 'slide' || n.slideType) {
      if (n.lastSlide) {
        times.push(n.time + (n.slideDelay ?? 0) + (n.slideDuration ?? 0));
      }
    } else {
      times.push(n.time);
    }
  }
  times.sort((a, b) => a - b);
  return times;
}

function processChartData(decoded) {
  const bpm = decoded.bpm || 60;
  const firstBpm = decoded.tags.find(t => t.type === 'bpm')?.value || bpm;
  const measureDuration = 240 / firstBpm;
  const endTime = decoded.endTime || 0;
  const comboTimes = extractComboTimes(decoded.notes);

  const M_arr = [];
  const offset = measureDuration; // maimai 譜面第一小節為偏置 (1 measure)
  for (let t = offset; t <= endTime + measureDuration; t += measureDuration) {
    M_arr.push(t);
  }
  if (M_arr.length === 0) M_arr.push(offset);

  const D_arr = Array.from({ length: M_arr.length }, () => ({
    tap: 0, hold: 0, slide: 0, touch: 0, brk: 0,
  }));

  for (const n of decoded.notes) {
    let idx = 0;
    for (let i = 0; i < M_arr.length; i++) {
      if (n.time >= M_arr[i]) idx = i; else break;
    }
    if (n.isBreak) D_arr[idx].brk++;
    else if (n.type === 'tap') D_arr[idx].tap++;
    else if (n.type === 'hold') D_arr[idx].hold++;
    else if (n.type === 'slide') D_arr[idx].slide++;
    else if (n.type === 'touch') D_arr[idx].touch++;
  }

  return {
    meta: {
      bpm: firstBpm,
      total: comboTimes.length,
      counts: decoded.notesConts || {
        tap: decoded.notes.filter(n => n.type === 'tap' && !n.isBreak).length,
        hold: decoded.notes.filter(n => n.type === 'hold' && !n.isBreak).length,
        slide: decoded.notes.filter(n => n.type === 'slide' && !n.isBreak).length,
        touch: decoded.notes.filter(n => n.type === 'touch' && !n.isBreak).length,
        break: decoded.notes.filter(n => n.isBreak).length,
      },
      endTime,
    },
    measures: M_arr,
    density: D_arr,
    notes: decoded.notes,
    tags: decoded.tags,
    indexToTime: decoded.indexToTime || [],
    comboTimes,
  };
}

/** 譜面資料的家：載入、解碼、前處理，全部包在一個 composable 裡 */
export function useChartData() {
  const chartText = ref('');     // 經鏡像轉換後的文字（實際用於渲染與匯出）
  const originalText = ref(''); // 原始未轉換的文字
  const chartName = ref('');
  const mirrorMode = ref(0);    // 0=原譜, 1=左右, 2=上下, 3=全(180°)
  const mirrorLabel = computed(() => MIRROR_MODES[mirrorMode.value] || '原譜');

  // 這些是大型解析結果，整包替換而非逐欄位改動，用 shallowRef 避免 Vue 把內部每個元素都包成代理
  const DATA = shallowRef(null);
  const M = shallowRef([]);
  const N = shallowRef([]);
  const D = shallowRef([]);
  const C = shallowRef([]);
  const comboTimes = shallowRef([]);
  const commaParts = shallowRef([]);

  function decodeAndPopulate(text, name) {
    chartText.value = text;
    chartName.value = name ?? '';

    const decoded = simaiDecode(text, true);
    if (decoded.failed) throw new Error('譜面解析失敗：請檢查語法');

    const processed = processChartData(decoded);
    DATA.value = processed;
    M.value = processed.measures;
    N.value = processed.notes;
    D.value = processed.density;
    C.value = processed.indexToTime;
    comboTimes.value = processed.comboTimes;
    commaParts.value = splitCommaParts(text);

    return processed;
  }

  async function loadChart(fetchPath) {
    const res = await fetch(fetchPath);
    if (!res.ok) throw new Error(`譜面獲取失敗：${res.status}`);
    const json = await res.json();
    const chart = (json && json.ok !== undefined) ? (json.data || {}) : json;
    originalText.value = chart.text;
    const transformed = applyMirror(chart.text, mirrorMode.value);
    return decodeAndPopulate(transformed, chart.name);
  }

  /** 不透過 fetch，直接把一段 simai 原文解碼成獨立的一份譜面資料（給預覽用的片段） */
  function loadFromText(text, name) {
    originalText.value = text;
    const transformed = applyMirror(text, mirrorMode.value);
    return decodeAndPopulate(transformed, name);
  }

  /** 直接借用另一份已經解碼好的資料（不重新解碼），給「沿用主譜面」的預覽情境用 */
  function adoptFrom(other) {
    chartText.value = other.chartText.value;
    chartName.value = other.chartName.value;
    originalText.value = other.originalText.value;
    DATA.value = other.DATA.value;
    M.value = other.M.value;
    N.value = other.N.value;
    D.value = other.D.value;
    C.value = other.C.value;
    comboTimes.value = other.comboTimes.value;
    commaParts.value = other.commaParts.value;
  }

  /**
   * 循環切換鏡像模式（原譜 → 左右 → 上下 → 全 → 原譜…）
   * 並以新模式重新解碼譜面資料。回傳新模式的索引。
   */
  function cycleMirror() {
    mirrorMode.value = (mirrorMode.value + 1) % MIRROR_MODES.length;
    if (originalText.value) {
      const transformed = applyMirror(originalText.value, mirrorMode.value);
      decodeAndPopulate(transformed, chartName.value);
    }
    return mirrorMode.value;
  }

  function clear() {
    chartText.value = '';
    originalText.value = '';
    chartName.value = '';
    DATA.value = null;
    M.value = [];
    N.value = [];
    D.value = [];
    C.value = [];
    comboTimes.value = [];
    commaParts.value = [];
  }

  return {
    chartText, originalText, chartName, DATA, M, N, D, C, comboTimes, commaParts,
    mirrorMode, mirrorLabel, cycleMirror,
    loadChart, loadFromText, adoptFrom, clear,
  };
}
