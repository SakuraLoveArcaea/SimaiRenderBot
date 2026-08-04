import { ref, computed } from 'vue';
import { audioManager } from '../../../../engine/Scripts/helper.js';

// 音效模式：關 / 簡易（即時合成，免下載）/ 完整（wav 音效檔）。
// 完整模式的檔案只在使用者主動切到該模式時才下載；下載期間先用簡易合成音頂著，
// 載完之後 audioManager 找得到 buffer 就會自動改用真正的音效。
const SFX_MODES = ['off', 'simple', 'full'];
const SFX_MODE_LABEL = { off: '🔇 靜音', simple: '🔉 簡易', full: '🔊 完整' };

export function useSfx() {
  const sfxVolume = ref(0.5);
  const sfxMode = ref('simple');
  const sfxFullLoading = ref(false);
  const sfxFullLoaded = ref(false);
  const sfxLoadingMessage = ref('');

  const sfxModeLabel = computed(() => SFX_MODE_LABEL[sfxMode.value]);

  function applySfxMode() {
    audioManager.muted = sfxMode.value === 'off';
    audioManager.synthFallback = sfxMode.value !== 'off';
    if (sfxMode.value === 'off') {
      audioManager.soundQueue = [];
      audioManager.stopAllScheduledSounds();
    }
  }

  function loadFullSfx() {
    if (sfxFullLoaded.value || sfxFullLoading.value) return;
    sfxFullLoading.value = true;
    sfxLoadingMessage.value = '🔊 正在載入完整音效…（先以簡易音播放）';
    audioManager.init((pct) => {
      sfxLoadingMessage.value = `🔊 正在載入完整音效… ${Math.round(pct)}%（先以簡易音播放）`;
    }).catch(e => console.warn('[Audio] 音效載入部分失敗:', e)).then(() => {
      audioManager.setSFXVolume(sfxVolume.value);
      sfxFullLoaded.value = true;
      sfxFullLoading.value = false;
      sfxLoadingMessage.value = sfxMode.value === 'full' ? '✅ 完整音效已就緒' : '';
      if (sfxLoadingMessage.value) setTimeout(() => { sfxLoadingMessage.value = ''; }, 1500);
    });
  }

  /** 解鎖瀏覽器 AudioContext（必須在使用者手勢中同步呼叫） */
  function unlockAudio() {
    audioManager.ensureContextSync();
    if (audioManager.ctx?.state === 'suspended') {
      audioManager.ctx.resume().catch(() => {});
    }
  }

  function cycleSfxMode() {
    sfxMode.value = SFX_MODES[(SFX_MODES.indexOf(sfxMode.value) + 1) % SFX_MODES.length];
    applySfxMode();
    unlockAudio(); // 使用者手勢，順便解鎖 AudioContext
    if (sfxMode.value === 'full') loadFullSfx();
  }

  function setSfxVolume(v) {
    sfxVolume.value = v;
    audioManager.setSFXVolume(v);
  }

  applySfxMode();

  return {
    sfxVolume, sfxMode, sfxFullLoading, sfxFullLoaded, sfxLoadingMessage, sfxModeLabel,
    cycleSfxMode, unlockAudio, setSfxVolume,
  };
}
