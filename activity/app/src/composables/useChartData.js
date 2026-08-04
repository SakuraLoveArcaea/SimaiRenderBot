import { ref, shallowRef } from 'vue';
import { simaiDecode } from '../../../../engine/Scripts/decode.js';
import { splitCommaParts } from '../../../../engine/Scripts/simaiCut.js';

function processChartData(decoded) {
  const bpm = decoded.bpm || 60;
  const firstBpm = decoded.tags.find(t => t.type === 'bpm')?.value || bpm;
  const measureDuration = 240 / firstBpm;
  const endTime = decoded.endTime || 0;

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
      total: decoded.notes.length,
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
  };
}

/** 譜面資料的家：載入、解碼、前處理，全部包在一個 composable 裡 */
export function useChartData() {
  const chartText = ref('');
  const chartName = ref('');
  // 這些是大型解析結果，整包替換而非逐欄位改動，用 shallowRef 避免 Vue 把內部每個元素都包成代理
  const DATA = shallowRef(null);
  const M = shallowRef([]);
  const N = shallowRef([]);
  const D = shallowRef([]);
  const C = shallowRef([]);
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
    commaParts.value = splitCommaParts(text);

    return processed;
  }

  async function loadChart(fetchPath) {
    const res = await fetch(fetchPath);
    if (!res.ok) throw new Error(`譜面獲取失敗：${res.status}`);
    const json = await res.json();
    const chart = (json && json.ok !== undefined) ? (json.data || {}) : json;
    return decodeAndPopulate(chart.text, chart.name);
  }

  /** 不透過 fetch，直接把一段 simai 原文解碼成獨立的一份譜面資料（給預覽用的片段） */
  function loadFromText(text, name) {
    return decodeAndPopulate(text, name);
  }

  /** 直接借用另一份已經解碼好的資料（不重新解碼），給「沿用主譜面」的預覽情境用 */
  function adoptFrom(other) {
    chartText.value = other.chartText.value;
    chartName.value = other.chartName.value;
    DATA.value = other.DATA.value;
    M.value = other.M.value;
    N.value = other.N.value;
    D.value = other.D.value;
    C.value = other.C.value;
    commaParts.value = other.commaParts.value;
  }

  return { chartText, chartName, DATA, M, N, D, C, commaParts, loadChart, loadFromText, adoptFrom };
}
