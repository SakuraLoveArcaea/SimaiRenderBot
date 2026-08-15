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
  noteEndBehavior: 'through',
  noteEndFadeTime: 0.3,
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
 * 播放引擎：支援單播放器以及雙人/協同（Utage L/R）同步雙播放器
 */
export function usePlayerEngine(chart, chartR = null) {
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
  let nowIndexLocal = 0;
  let playScoreRes = { tap: 0, hold: 0, slide: 0, touch: 0, break: 0, score: 0, breakScore: 0, invScore: 0 };
  let size = 320;
  let cv = null;
  let ctx = null;
  let resizeObserver = null;

  // 雙播放器 (2P / R)
  let rendererR = null;
  let logicR = null;
  let nowIndexLocalR = 0;
  let playScoreResR = { tap: 0, hold: 0, slide: 0, touch: 0, break: 0, score: 0, breakScore: 0, invScore: 0 };
  let sizeR = 320;
  let cvR = null;
  let ctxR = null;
  let resizeObserverR = null;

  let images = null;
  let outlineImage = null;
  let previewStart = null;
  let previewStop = null;
  let previewLoop = false;
  let lastTs = 0;

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

  function currentComboIndexR() {
    if (!chartR || !chartR.N.value) return 0;
    const N = chartR.N.value;
    if (N.length === 0) return 0;
    const idx = N.findIndex(n => n.time >= realTime.value);
    return idx === -1 ? N.length - 1 : idx;
  }

  const hudMeasure = computed(() => measureIndex(realTime.value));
  const hudMeasureFloat = computed(() => measureIndexFloat(realTime.value));
  const hudCombo = computed(() => currentComboIndex());
  const hudComboR = computed(() => currentComboIndexR());

  function fastForwardNowIndex(targetTime) {
    const N = chart.N.value;
    if (!N || N.length === 0) {
      nowIndexLocal = 0;
    } else {
      const idx = N.findIndex(n => n.time >= Math.max(0, targetTime - 2.0));
      nowIndexLocal = idx === -1 ? N.length : idx;
    }

    if (chartR && chartR.N.value) {
      const NR = chartR.N.value;
      if (!NR || NR.length === 0) {
        nowIndexLocalR = 0;
      } else {
        const idxR = NR.findIndex(n => n.time >= Math.max(0, targetTime - 2.0));
        nowIndexLocalR = idxR === -1 ? NR.length : idxR;
      }
    }
  }

  function seek(t) {
    const endTime = chart.DATA.value?.meta.endTime ?? 0;
    realTime.value = Math.max(0, Math.min(endTime, t));
    audioManager.soundQueue = [];
    audioManager.stopAllScheduledSounds();
    if (realTime.value > 0) {
      fastForwardNowIndex(realTime.value);
    } else {
      nowIndexLocal = 0;
      nowIndexLocalR = 0;
    }
    draw(realTime.value, 0, true);
  }

  function seekComma(i) {
    const idx = Math.max(0, Math.min(chart.C.value.length - 2, i));
    seek(chart.C.value[idx]);
  }

  function jumpByTime(targetSeconds) {
    const cur = currentCommaIndex();
    let j = commaIndexAt(realTime.value + targetSeconds);
    if (targetSeconds > 0 && j <= cur) j = cur + 1;
    if (targetSeconds < 0 && j >= cur) j = cur - 1;
    seekComma(j);
  }

  function jumpToAdjacentNote(dir) {
    const N = chart.N.value;
    if (!N || N.length === 0) return;
    const eps = 1e-4;
    if (dir > 0) {
      const found = N.find(n => n.time > realTime.value + eps);
      seek(found ? found.time : chart.DATA.value.meta.endTime);
    } else {
      let found = null;
      for (let i = N.length - 1; i >= 0; i--) {
        if (N[i].time < realTime.value - eps) {
          found = N[i];
          break;
        }
      }
      seek(found ? found.time : 0);
    }
  }

  function resizeCanvas() {
    if (cv) {
      const stage = cv.parentElement;
      const avail = stage ? Math.min(stage.clientWidth, stage.clientHeight) : 320;
      size = Math.max(100, Math.floor(avail));
      cv.style.width = cv.style.height = size + 'px';
      cv.width = cv.height = size * devicePixelRatio;
    }
    if (cvR) {
      const stageR = cvR.parentElement;
      const availR = stageR ? Math.min(stageR.clientWidth, stageR.clientHeight) : 320;
      sizeR = Math.max(100, Math.floor(availR));
      cvR.style.width = cvR.style.height = sizeR + 'px';
      cvR.width = cvR.height = sizeR * devicePixelRatio;
    }
    draw(realTime.value, 0);
  }

  function attachCanvas(canvasEl) {
    cv = canvasEl;
    ctx = cv ? cv.getContext('2d') : null;
    if (renderer && ctx) renderer.setContext(ctx);
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);
    if (window.ResizeObserver && cv && cv.parentElement) {
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
    cv = null;
    ctx = null;
  }

  function attachCanvasR(canvasEl) {
    cvR = canvasEl;
    ctxR = cvR ? cvR.getContext('2d') : null;
    if (rendererR && ctxR) rendererR.setContext(ctxR);
    if (cvR && images) {
      rendererR = new SimaiRenderer(cvR, defaultSettings);
      rendererR.setImages(images);
      rendererR.setContext(ctxR);
      logicR = new SimaiLogicControler();
    }
    resizeCanvas();
    if (window.ResizeObserver && cvR && cvR.parentElement) {
      let lastSize = 0;
      resizeObserverR = new ResizeObserver(() => {
        const rect = cvR.getBoundingClientRect();
        const now = Math.round(Math.min(rect.width, rect.height));
        if (now > 0 && Math.abs(now - lastSize) >= 1) {
          lastSize = now;
          resizeCanvas();
        }
      });
      resizeObserverR.observe(cvR.parentElement);
    }
  }

  function detachCanvasR() {
    resizeObserverR?.disconnect();
    cvR = null;
    ctxR = null;
    rendererR = null;
    logicR = null;
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

    if (cvR && ctxR) {
      rendererR = new SimaiRenderer(cvR, defaultSettings);
      rendererR.setImages(images);
      rendererR.setContext(ctxR);
      logicR = new SimaiLogicControler();
    }

    resizeCanvas();
  }

  function drawSingle(targetCv, targetCtx, targetRenderer, targetLogic, targetChart, targetNowIndex, targetPlayScore, isRight = false, effectiveTime, dt, isSeeking) {
    if (!targetRenderer || !targetLogic || !targetChart || !targetChart.DATA.value) return targetNowIndex;
    const DATA = targetChart.DATA.value;

    const {
      buckets, playCombo, playScore, noteQuantity,
      nowIndex: updatedNowIndex,
    } = targetLogic.get({
      renderer: targetRenderer,
      globalTime: effectiveTime,
      realTime: effectiveTime,
      musicDelay: 0,
      playing: playing.value,
      timeControlSliding: dragging.value || isSeeking,
      readyBeat: false,
      playedClock: [],
      settings: defaultSettings,
      visualHeight: 0,
      notes: targetChart.N.value,
      decodedTags: DATA.tags || [],
      playScoreRes: targetPlayScore,
      nowIndex: targetNowIndex,
      skipAudioQueue: isRight, // 若為 2P (R) 則不重複排隊音效，以 1P 為主音效
    });

    targetCtx.setTransform(1, 0, 0, 1, 0, 0);
    targetCtx.fillStyle = defaultSettings.backgroundColor;
    targetCtx.fillRect(0, 0, targetCv.width, targetCv.height);

    const curSize = isRight ? sizeR : size;
    const p = curSize * devicePixelRatio / scaleBase * targetRenderer.scale;
    targetCtx.setTransform(p, 0, 0, p, targetCv.width / 2, targetCv.height / 2);

    if (outlineImage) {
      targetCtx.drawImage(outlineImage, scaleBase * -0.5 * 0.9, scaleBase * -0.5 * 0.9, scaleBase * 0.9, scaleBase * 0.9);
    }

    targetRenderer.drawFrame({
      globalTime: effectiveTime,
      buckets,
      dt: dt * speed.value,
      showSensor: defaultSettings.showSensor,
      showSensorText: false,
      playCombo,
      playScore,
      nowIndex: targetNowIndex,
      skipClear: true,
      noteQuantity,
      playScoreRes: targetPlayScore,
    });

    return updatedNowIndex;
  }

  function draw(t, dt = 0, isSeeking = false) {
    const effectiveTime = Math.max(0, t + timeOffset.value);

    // 繪製 1P / 主播放器
    if (renderer && logic && chart.DATA.value && cv && ctx) {
      nowIndexLocal = drawSingle(cv, ctx, renderer, logic, chart, nowIndexLocal, playScoreRes, false, effectiveTime, dt, isSeeking);
    }

    // 繪製 2P (R) 播放器（若存在）
    if (rendererR && logicR && chartR && chartR.DATA.value && cvR && ctxR) {
      nowIndexLocalR = drawSingle(cvR, ctxR, rendererR, logicR, chartR, nowIndexLocalR, playScoreResR, true, effectiveTime, dt, isSeeking);
    }
  }

  function loop(ts) {
    if (!playing.value) return;
    const dt = Math.min(100, ts - lastTs) / 1000;
    lastTs = ts;
    realTime.value += dt * speed.value;
    const endTime = chart.DATA.value?.meta.endTime ?? 0;
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
    unlockAudio();
    playing.value = true;
    lastTs = performance.now();
    requestAnimationFrame(loop);
  }

  function pause() {
    playing.value = false;
    audioManager.soundQueue = [];
    audioManager.stopAllScheduledSounds();
  }

  function togglePlay() {
    playing.value ? pause() : play();
  }

  function setPreviewStop(stopTime) {
    previewStop = stopTime;
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

  function resetPlaybackState() {
    nowIndexLocal = 0;
    nowIndexLocalR = 0;
    playScoreRes = { tap: 0, hold: 0, slide: 0, touch: 0, break: 0, score: 0, breakScore: 0, invScore: 0 };
    playScoreResR = { tap: 0, hold: 0, slide: 0, touch: 0, break: 0, score: 0, breakScore: 0, invScore: 0 };
    logic = new SimaiLogicControler();
    if (chartR) logicR = new SimaiLogicControler();
  }

  return {
    playing, realTime, speed, hs, dragging, timeOffset,
    hudMeasure, hudMeasureFloat, hudCombo, hudComboR,
    measureIndex, measureIndexFloat, measureTime, commaIndexAt, currentCommaIndex, currentComboIndex, currentComboIndexR,
    seek, seekComma, jumpByTime, jumpToAdjacentNote,
    attachCanvas, detachCanvas, attachCanvasR, detachCanvasR, resizeCanvas,
    loadAssets, initEngine, resetPlaybackState,
    play, pause, togglePlay, setPreviewStop, setPreviewBounds,
    setSpeed, setHs, setTimeOffset, adjustTimeOffset, resetTimeOffset, setDragging, unlockAudio,
    defaultSettings,
  };
}
