import { ref, computed } from 'vue';
import { SimaiRenderer } from '../../../../engine/Scripts/renderer.js';
import { loadAllImages, SimaiLogicControler, scaleBase, audioManager } from '../../../../engine/Scripts/helper.js';

const defaultSettings = {
  speed: 6.5,
  touchSpeed: 7,
  slideSpeed: 0,
  middleDisplay: 1,
  moviebrightness: -4,
  showSensor: true,
  rotateStars: true,
  pinkStars: false,
  middleDistance: 0.25,
  effectDecayTime: 0.4,
  hanabiEffectDecayTime: 0.8,
  // 'hit'（預設）＝音符到判定線被擊打、出光環特效後消失
  // 'through'  ＝tap 不判定，維持原速穿過判定線往外飛，再於 noteEndFadeTime 內淡出
  //              （hold／star／touch／slide 不受影響，一律維持擊打行為）
  // noteEndBehavior: 'hit',
  noteEndBehavior: 'through',
  noteEndFadeTime: 0.3, // 0.3
  noteBaseSize: 11,
  maxSlideCount: 500,
  renderSurroundingAuxiliaryText: true,
  slideIllegalRed: false,
  showUI: false,
  notPlayHoldEnd: false,
  backgroundColor: '#0c0c1e', // 暗色系背景
  sfxVolumes: {},
};

/**
 * 播放引擎：canvas 繪製、rAF 播放迴圈、seek/導覽運算全部在這裡。
 * renderer/logic/images 這些「引擎物件」刻意用一般變數（let），不是 ref/reactive——
 * 它們只被命令式讀寫、從來不直接綁在 template 上，包成響應式只會拖累效能、
 * 甚至可能干擾這些 class 內部自己的狀態管理。真正要給畫面用的（playing/realTime/speed…）才是 ref。
 */
export function usePlayerEngine(chart) {
  const playing = ref(false);
  const realTime = ref(0);
  const speed = ref(1.0);
  const hs = ref(4.0);
  const dragging = ref(false);
  const timeOffset = ref(-0.001); // 預設時間 Offset：-0.001s (-1ms)

  function setTimeOffset(v) {
    timeOffset.value = Math.round(v * 1000) / 1000;
    draw(realTime.value, 0);
  }

  function adjustTimeOffset(delta) {
    timeOffset.value = Math.round((timeOffset.value + delta) * 1000) / 1000;
    draw(realTime.value, 0);
  }

  function resetTimeOffset() {
    timeOffset.value = -0.001;
    draw(realTime.value, 0);
  }

  let renderer = null;
  let logic = null;
  let images = null;
  let outlineImage = null;
  let nowIndexLocal = 0;
  let playScoreRes = { tap: 0, hold: 0, slide: 0, touch: 0, break: 0, score: 0, breakScore: 0, invScore: 0 };
  let previewStart = null;
  let previewStop = null;
  let previewLoop = false;
  let lastTs = 0;
  let size = 320;
  let cv = null;
  let ctx = null;
  let resizeObserver = null;



  function measureIndex(t) {
    const M = chart.M.value;
    if (!M || M.length === 0) return 0;
    let lo = 0, hi = M.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      M[mid] <= t + 1e-6 ? lo = mid : hi = mid - 1;
    }
    return lo;
  }

  function measureIndexFloat(t) {
    const M = chart.M.value;
    if (!M || M.length === 0) return 0;
    const idx = measureIndex(t);
    const t0 = idx === 0 ? 0 : M[idx];
    const t1 = M[idx + 1] ?? (chart.DATA.value?.meta.endTime ?? t0 + 2.0);
    const dt = t1 - t0;
    if (dt <= 0) return idx;
    const frac = Math.max(0, Math.min(1, (t - t0) / dt));
    return idx + frac;
  }

  // measureIndex(t) 的反函式（支援浮點數小節位置）
  function measureTime(idx) {
    if (idx <= 0) return 0;
    const M = chart.M.value;
    if (!M || M.length === 0) return 0;
    const i = Math.floor(idx);
    const frac = idx - i;
    if (i >= M.length - 1) {
      const last = M.length - 1;
      const tLast = M[last];
      const prevDur = last > 0 ? (M[last] - M[last - 1]) : 2.0;
      return tLast + prevDur * frac;
    }
    const t0 = i === 0 ? 0 : M[i];
    const t1 = M[i + 1];
    return t0 + (t1 - t0) * frac;
  }

  // C 最後一格是譜尾 sentinel，不是真正的逗號，搜尋範圍要排除它
  function commaIndexAt(t) {
    const C = chart.C.value;
    let lo = 0, hi = C.length - 2;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      C[mid] <= t + 1e-6 ? lo = mid : hi = mid - 1;
    }
    return lo;
  }

  function currentCommaIndex() {
    return commaIndexAt(realTime.value);
  }

  function currentComboIndex() {
    const N = chart.N.value;
    if (!N || N.length === 0) return 0;
    const idx = N.findIndex(n => n.time >= realTime.value);
    return idx === -1 ? N.length - 1 : idx;
  }

  const hudMeasure = computed(() => measureIndex(realTime.value));
  const hudMeasureFloat = computed(() => measureIndexFloat(realTime.value));
  const hudCombo = computed(() => currentComboIndex());

  function fastForwardNowIndex(targetTime) {
    const N = chart.N.value;
    if (!N || N.length === 0) {
      nowIndexLocal = 0;
      return;
    }
    const idx = N.findIndex(n => n.time >= Math.max(0, targetTime - 2.0));
    nowIndexLocal = idx === -1 ? N.length : idx;
  }

  function seek(t) {
    const endTime = chart.DATA.value?.meta.endTime ?? 0;
    realTime.value = Math.max(0, Math.min(endTime, t));
    // Seek 時清空音效佇列，避免舊音效在新時間點爆出
    audioManager.soundQueue = [];
    audioManager.stopAllScheduledSounds();
    if (realTime.value > 0) {
      fastForwardNowIndex(realTime.value);
    } else {
      nowIndexLocal = 0;
    }
    draw(realTime.value, 0, true);
  }

  function seekComma(i) {
    const idx = Math.max(0, Math.min(chart.C.value.length - 2, i));
    seek(chart.C.value[idx]);
  }

  // 導覽鈕用：移動一個「大概」的秒數，最後精準吸附到最近的逗號
  function jumpByTime(targetSeconds) {
    const cur = currentCommaIndex();
    let j = commaIndexAt(realTime.value + targetSeconds);
    if (targetSeconds > 0 && j <= cur) j = cur + 1;
    if (targetSeconds < 0 && j >= cur) j = cur - 1;
    seekComma(j);
  }

  // 跳到上一顆／下一顆實際的 note（跳過中間沒有音符的逗號、休止拍）
  function jumpToAdjacentNote(dir) {
    const N = chart.N.value;
    if (!N || N.length === 0) return;
    if (dir > 0) {
      const n = N.find(n => n.time > realTime.value + 1e-6);
      seek(n ? n.time : chart.DATA.value.meta.endTime);
    } else {
      let found = null;
      for (let i = N.length - 1; i >= 0; i--) {
        if (N[i].time < realTime.value - 1e-6) { found = N[i]; break; }
      }
      seek(found ? found.time : 0);
    }
  }

  function resizeCanvas() {
    if (!cv) return;
    // 譜面必須是正方形：取畫布容器可用寬高的較小值
    const stage = cv.parentElement;
    const avail = stage ? Math.min(stage.clientWidth, stage.clientHeight) : 320;
    size = Math.max(100, Math.floor(avail));
    cv.style.width = cv.style.height = size + 'px';
    cv.width = cv.height = size * devicePixelRatio;
    draw(realTime.value, 0);
  }

  function attachCanvas(canvasEl) {
    cv = canvasEl;
    ctx = cv.getContext('2d');
    if (renderer) renderer.setContext(ctx);
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);
    if (window.ResizeObserver) {
      let lastSize = 0;
      resizeObserver = new ResizeObserver(() => {
        const rect = cv.getBoundingClientRect();
        const now = Math.round(Math.min(rect.width, rect.height));
        if (now > 0 && Math.abs(now - lastSize) >= 1) {
          lastSize = now;
          resizeCanvas();
        }
      });
      resizeObserver.observe(cv.parentElement);
    }
  }

  function detachCanvas() {
    window.removeEventListener('resize', resizeCanvas);
    resizeObserver?.disconnect();
  }

  async function loadAssets() {
    images = await loadAllImages();
    try {
      const blob = await (async () => {
        try { return await (await fetch('Skin/outline.png')).blob(); }
        catch { return null; }
      })();
      if (blob) outlineImage = await createImageBitmap(blob);
    } catch (e) {
      console.error('Failed to load outline image:', e);
    }
    await document.fonts.ready;
  }

  function initEngine() {
    if (!cv) throw new Error('canvas 尚未掛載');
    renderer = new SimaiRenderer(cv, defaultSettings);
    renderer.setImages(images);
    renderer.setContext(ctx);
    logic = new SimaiLogicControler();
    resizeCanvas();
  }

  function draw(t, dt = 0, isSeeking = false) {
    if (!renderer || !logic || !chart.DATA.value) return;
    const DATA = chart.DATA.value;
    const effectiveTime = Math.max(0, t + timeOffset.value);

    const {
      buckets, playCombo, playScore, noteQuantity,
      nowIndex: updatedNowIndex,
    } = logic.get({
      renderer,
      globalTime: effectiveTime,
      realTime: effectiveTime,
      musicDelay: 0,
      playing: playing.value,
      timeControlSliding: dragging.value || isSeeking,
      readyBeat: false,
      playedClock: [],
      settings: defaultSettings,
      visualHeight: 0,
      notes: chart.N.value,
      decodedTags: DATA.tags || [],
      playScoreRes,
      nowIndex: nowIndexLocal,
      // 必須固定傳 false：暫停/拖曳時要靠 logic 內部的 else 分支重設每顆 note 的音效旗標，
      // 傳 !playing 會導致暫停時整段邏輯被跳過、倒帶後重新播放時的音效就再也不會發聲
      skipAudioQueue: false,
    });
    nowIndexLocal = updatedNowIndex;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = defaultSettings.backgroundColor;
    ctx.fillRect(0, 0, cv.width, cv.height);

    const p = size * devicePixelRatio / scaleBase * renderer.scale;
    ctx.setTransform(p, 0, 0, p, cv.width / 2, cv.height / 2);

    if (outlineImage) {
      ctx.drawImage(outlineImage, scaleBase * -0.5 * 0.9, scaleBase * -0.5 * 0.9, scaleBase * 0.9, scaleBase * 0.9);
    }

    renderer.drawFrame({
      globalTime: effectiveTime,
      buckets,
      dt: dt * speed.value,
      showSensor: defaultSettings.showSensor,
      showSensorText: false,
      playCombo,
      playScore,
      nowIndex: nowIndexLocal,
      skipClear: true,
      noteQuantity,
      playScoreRes,
    });
  }

  function loop(ts) {
    if (!playing.value) return;
    const dt = Math.min(100, ts - lastTs) / 1000;
    lastTs = ts;
    realTime.value += dt * speed.value;
    const endTime = chart.DATA.value.meta.endTime;
    if (previewStop !== null && realTime.value >= previewStop) {
      if (previewLoop) {
        seek(previewStart !== null ? previewStart : 0);
      } else {
        realTime.value = previewStop;
        playing.value = false;
        previewStop = null;
      }
    }
    if (realTime.value >= endTime) {
      if (previewLoop) {
        seek(previewStart !== null ? previewStart : 0);
      } else {
        realTime.value = endTime;
        playing.value = false;
      }
    }
    draw(realTime.value, dt);
    audioManager.update(realTime.value);
    if (playing.value) requestAnimationFrame(loop);
  }

  function unlockAudio() {
    audioManager.ensureContextSync();
    if (audioManager.ctx?.state === 'suspended') {
      audioManager.ctx.resume().catch(() => { });
    }
  }

  function play() {
    if (playing.value) return;
    playing.value = true;
    unlockAudio();
    lastTs = performance.now();
    requestAnimationFrame(loop);
  }

  function pause() {
    playing.value = false;
    previewStop = null;
    previewStart = null;
    previewLoop = false;
  }

  function togglePlay() {
    if (playing.value) pause(); else play();
  }

  function setPreviewStop(t) {
    previewStop = t;
    previewStart = 0;
    previewLoop = false;
  }

  function setPreviewBounds(start, stop, isLoop = false) {
    previewStart = start;
    previewStop = stop;
    previewLoop = isLoop;
  }

  function setSpeed(v) {
    speed.value = v;
  }

  function setHs(v) {
    hs.value = v;
    defaultSettings.speed = v;
    draw(realTime.value, 0);
  }

  function setDragging(v) {
    dragging.value = v;
  }

  // 換一份全新的譜面資料重新播放前要呼叫（例如預覽彈窗每次開啟）：
  // nowIndexLocal／playScoreRes 是跨影格累積的內部狀態，不重設的話上一次播放的
  // combo／score 會殘留到這一次，尤其是「切的乾淨」預覽每次都是完全不同的一小段譜面。
  function resetPlaybackState() {
    nowIndexLocal = 0;
    playScoreRes = { tap: 0, hold: 0, slide: 0, touch: 0, break: 0, score: 0, breakScore: 0, invScore: 0 };
    logic = new SimaiLogicControler();
  }

  return {
    playing, realTime, speed, hs, dragging, timeOffset,
    hudMeasure, hudMeasureFloat, hudCombo,
    measureIndex, measureIndexFloat, measureTime, commaIndexAt, currentCommaIndex, currentComboIndex,
    seek, seekComma, jumpByTime, jumpToAdjacentNote,
    attachCanvas, detachCanvas, resizeCanvas,
    loadAssets, initEngine, resetPlaybackState,
    play, pause, togglePlay, setPreviewStop, setPreviewBounds,
    setSpeed, setHs, setTimeOffset, adjustTimeOffset, resetTimeOffset, setDragging, unlockAudio,
    defaultSettings,
  };
}
