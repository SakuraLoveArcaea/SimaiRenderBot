import { ref, computed, watch } from 'vue';
import { buildCleanCutSimai } from '../../../../engine/Scripts/simaiCut.js';

export const MAX_RENDER_SEC = 30;
const OVER_LIMIT_COLOR = '#f23f43';

const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

/**
 * 選取範圍（起訖逗號）＋密度圖繪製。
 * rangeA／rangeB 是兩條各自獨立的滑桿，值可以互相超過對方——range.start/end
 * 只是「目前兩個滑桿裡比較小/比較大的那個」，不是滑桿本身，這樣才能重現原本
 * 「隨便拖哪一顆，兩顆都能滑到底、互相交換起訖角色」的手感。
 */
export function useRangeSelection(chart, engine) {
  const rangeAValue = ref(0);
  const rangeBValue = ref(0);
  const maxComma = ref(0);
  const activeEndpoint = ref(null); // 'a' | 'b' | null：導覽鍵目前在動哪個東西
  const cleanCut = ref(true); // 「切的乾淨」預設開啟
  let densityCanvas = null;
  let dctx = null;

  const range = computed(() => ({
    start: Math.min(rangeAValue.value, rangeBValue.value),
    end: Math.max(rangeAValue.value, rangeBValue.value),
  }));

  function getRangeDuration() {
    const C = chart.C.value;
    if (!C || C.length < 2) return 0;
    const startTime = C[range.value.start] ?? 0;
    const endTime = C[range.value.end + 1] ?? (chart.DATA.value?.meta.endTime ?? 0);
    return Math.max(0, endTime - startTime);
  }

  function comboRangeSpan() {
    const N = chart.N.value;
    const C = chart.C.value;
    if (!N || N.length === 0) return null;
    const t0 = C[range.value.start] ?? 0;
    const t1 = C[range.value.end + 1] ?? (chart.DATA.value?.meta.endTime ?? 0);
    const firstIdx = N.findIndex(n => n.time >= t0 - 1e-6);
    if (firstIdx === -1 || N[firstIdx].time >= t1 - 1e-6) return null;
    let lastIdx = firstIdx;
    for (let i = N.length - 1; i >= firstIdx; i--) {
      if (N[i].time < t1 - 1e-6) { lastIdx = i; break; }
    }
    return { first: firstIdx + 1, last: lastIdx + 1 };
  }

  const rangeDuration = computed(getRangeDuration);
  const rangeOverLimit = computed(() => {
    const commaSpan = range.value.end - range.value.start + 1;
    return commaSpan > 0 && rangeDuration.value > MAX_RENDER_SEC;
  });

  const rangeLabel = computed(() => {
    const commaSpan = range.value.end - range.value.start + 1;
    if (commaSpan <= 0) return '⚠️ 空區間';
    const combo = comboRangeSpan();
    const span = rangeTimeSpan();
    let label = combo ? `Combo ${combo.first} - ${combo.last}` : '（此區間沒有音符）';
    label += `  (${span.start.toFixed(3)}s ~ ${span.end.toFixed(3)}s, ~${rangeDuration.value.toFixed(3)}s)`;
    const mark = (which, name) => (activeEndpoint.value === which ? `◆${name}` : '');
    const marks = [mark('a', '起'), mark('b', '終')].filter(Boolean).join(' ');
    if (marks) label += `  ${marks}`;
    return label;
  });

  const rangeMessage = computed(() => {
    const commaSpan = range.value.end - range.value.start + 1;
    if (commaSpan <= 0) return { text: '⚠️ 選取範圍為空區間，無法渲染。', type: 'error' };
    return { text: '', type: '' };
  });

  function commaLabel(commaIdx) {
    const text = chart.commaParts.value[commaIdx];
    return text ? text : '（空拍）';
  }

  function setActiveEndpoint(which) {
    activeEndpoint.value = which;
  }

  function initBounds(maxCommaValue, initial) {
    maxComma.value = maxCommaValue;
    rangeAValue.value = initial?.start ?? 0;
    rangeBValue.value = initial?.end ?? maxCommaValue;
  }

  function onRangeInput(which, value) {
    if (which === 'a') rangeAValue.value = value;
    else rangeBValue.value = value;
    setActiveEndpoint(which);
    const t = chart.C.value[value];
    if (t !== undefined) engine.seek(t);
  }

  function moveActiveEndpoint(dir, big) {
    const which = activeEndpoint.value;
    if (!which) return;
    const step = big ? 10 : 1;
    const cur = which === 'a' ? rangeAValue.value : rangeBValue.value;
    const next = Math.max(0, Math.min(maxComma.value, cur + dir * step));
    onRangeInput(which, next);
  }

  /** 導覽鍵移動播放頭後，把作用中的端點同步到新位置 */
  function syncActiveEndpointToPlayhead() {
    if (!activeEndpoint.value) return;
    onRangeInput(activeEndpoint.value, engine.currentCommaIndex());
  }

  function setStart() {
    const cIdx = engine.currentCommaIndex();
    const oldEnd = range.value.end;
    rangeAValue.value = cIdx;
    rangeBValue.value = Math.max(oldEnd, cIdx);
  }

  function setEnd() {
    const cIdx = engine.currentCommaIndex();
    const oldStart = range.value.start;
    rangeBValue.value = cIdx;
    rangeAValue.value = Math.min(oldStart, cIdx);
  }

  function goStart() {
    engine.seek(chart.C.value[range.value.start] ?? 0);
  }

  function rangeTimeSpan() {
    const C = chart.C.value;
    if (!C || C.length < 2) return { start: 0, end: 0 };
    return {
      start: C[range.value.start] ?? 0,
      end: C[range.value.end + 1] ?? (chart.DATA.value?.meta.endTime ?? 0),
    };
  }

  function buildExportPreview() {
    const dur = rangeDuration.value;
    const span = rangeTimeSpan();
    let previewText = null;
    if (cleanCut.value) {
      try {
        const info = { indexToTime: chart.C.value, tags: chart.DATA.value.tags || [], bpm: chart.DATA.value.meta.bpm };
        previewText = buildCleanCutSimai(chart.chartText.value, info, chart.C.value[range.value.start] ?? 0, chart.C.value[range.value.end + 1] ?? chart.DATA.value.meta.endTime);
      } catch (e) {
        console.error('產生預覽片段失敗:', e);
      }
    }
    return {
      meta: cleanCut.value
        ? `切的乾淨・${span.start.toFixed(3)}s ~ ${span.end.toFixed(3)}s (約 ${dur.toFixed(3)} 秒)・以下是實際會送出的內容`
        : `未啟用切的乾淨・${span.start.toFixed(3)}s ~ ${span.end.toFixed(3)}s (約 ${dur.toFixed(3)} 秒)・會送出整份原始譜面＋指定時間範圍`,
      text: previewText ?? '（整份原始譜面，內容過長不在此顯示；後端會照時間範圍只播放這一段）',
    };
  }

  function setDensityCanvas(el) {
    densityCanvas = el;
    dctx = el ? el.getContext('2d') : null;
  }

  function drawDensity(playheadMi) {
    if (!dctx || !densityCanvas) return;
    const M = chart.M.value, D = chart.D.value, C = chart.C.value;
    if (M.length === 0) return;
    const clientWidth = densityCanvas.clientWidth;
    if (clientWidth === 0) {
      requestAnimationFrame(() => drawDensity(playheadMi));
      return;
    }
    const w = clientWidth * devicePixelRatio, h = 50 * devicePixelRatio;
    if (densityCanvas.width !== w) { densityCanvas.width = w; densityCanvas.height = h; }
    dctx.clearRect(0, 0, w, h);
    const bw = w / M.length;
    const maxD = Math.max(1, ...D.map(d => d.tap + d.hold + d.slide + d.touch + d.brk));
    const order = [['tap', '--tap'], ['hold', '--hold'], ['slide', '--slide'], ['touch', '--touch'], ['brk', '--brk']];

    D.forEach((d, i) => {
      let y = h;
      order.forEach(([k, varName]) => {
        if (!d[k]) return;
        const bh = (d[k] / maxD) * (h - 6);
        y -= bh;
        dctx.fillStyle = css(varName);
        dctx.fillRect(i * bw + 0.5, y, Math.max(1, bw - 1), bh);
      });
    });

    // 選取範圍高亮（地雷灰）
    if (C.length > 1) {
      const getM = engine.measureIndexFloat ? (t) => engine.measureIndexFloat(t) : (t) => engine.measureIndex(t);
      const startM = getM(C[range.value.start] ?? 0);
      const endBoundaryM = getM(C[range.value.end + 1] ?? C[C.length - 1]);
      dctx.fillStyle = rangeOverLimit.value ? 'rgba(242, 63, 67, 0.16)' : 'rgba(115, 115, 115, 0.25)';
      dctx.fillRect(startM * bw, 0, Math.max(bw, (endBoundaryM - startM) * bw), h);
      dctx.fillStyle = rangeOverLimit.value ? OVER_LIMIT_COLOR : css('--mine');
      dctx.fillRect(startM * bw, 0, 2, h);
      dctx.fillRect(endBoundaryM * bw - 2, 0, 2, h);
    }

    dctx.fillStyle = '#ffffff';
    dctx.fillRect(playheadMi * bw, 0, Math.max(2, bw * 0.6), h);
  }

  function densitySeek(clientX, wrapEl) {
    const M = chart.M.value;
    const r = wrapEl.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    engine.seek(engine.measureTime(Math.round(frac * (M.length - 1))));
  }

  // realTime／範圍任一邊變動都要重繪密度圖
  watch([engine.realTime, rangeAValue, rangeBValue], () => {
    drawDensity(engine.hudMeasureFloat ? engine.hudMeasureFloat.value : engine.hudMeasure.value);
  });

  return {
    range, rangeAValue, rangeBValue, maxComma, activeEndpoint, cleanCut,
    rangeDuration, rangeOverLimit, rangeLabel, rangeMessage,
    commaLabel, setActiveEndpoint, initBounds, onRangeInput, moveActiveEndpoint, syncActiveEndpointToPlayhead, setStart, setEnd, goStart, rangeTimeSpan,
    buildExportPreview, setDensityCanvas, drawDensity, densitySeek,
  };
}
