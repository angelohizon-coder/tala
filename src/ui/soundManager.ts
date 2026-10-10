import { financeRepository } from '../db/repository';
import { playSynthesizedCue, type SoundCue } from './soundSynthesizer';

export type { SoundCue };

export interface ISoundService {
  isMuted(): boolean;
  setMuted(muted: boolean): void;
  toggleMute(): boolean;
  play(cue: SoundCue): void;
}

const CUE_FILE_MAP: Record<SoundCue, string> = {
  success: 'success.mp3',
  error: 'error.mp3',
  delete: 'delete.mp3',
  dialog_open: 'dialog-open.mp3',
  dialog_close: 'dialog-close.mp3',
};

const STORAGE_KEY = 'tala:sound-muted';
const LEGACY_STORAGE_KEY = 'tala_sound_muted';

class SoundService implements ISoundService {
  private muted: boolean;
  private audioContext: AudioContext | null = null;
  private compressorNode: DynamicsCompressorNode | null = null;
  private masterGainNode: GainNode | null = null;
  private audioCache = new Map<SoundCue, HTMLAudioElement>();
  private lastPlayed = new Map<SoundCue, number>();
  private activeVoices = 0;
  private unlocked = false;

  constructor() {
    // 1. Immediate synchronous read from localStorage
    let saved: string | null = null;
    try {
      if (typeof localStorage !== 'undefined') {
        saved = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY);
      }
    } catch {
      // In private browsing or sandboxed environments, ignore storage error
    }
    this.muted = saved === 'true';

    // 2. Synchronize with persistent Dexie repository
    if (typeof window !== 'undefined') {
      void financeRepository.getSetting<boolean>('soundMuted', this.muted).then(dbVal => {
        if (typeof dbVal === 'boolean' && dbVal !== this.muted) {
          this.muted = dbVal;
          try {
            if (typeof localStorage !== 'undefined') {
              localStorage.setItem(STORAGE_KEY, String(dbVal));
              localStorage.setItem(LEGACY_STORAGE_KEY, String(dbVal));
            }
          } catch {
            // ignore
          }
          this.notifyMuteChange();
        }
      });

      this.setupAutoplayUnlock();
    }
  }

  private setupAutoplayUnlock(): void {
    if (typeof window === 'undefined') return;

    const unlock = () => {
      if (this.unlocked) return;
      this.unlocked = true;
      this.ensureAudioContext();
      if (this.audioContext && this.audioContext.state === 'suspended') {
        void this.audioContext.resume().catch(() => {});
      }
      for (const event of ['click', 'keydown', 'pointerdown', 'touchstart'] as const) {
        window.removeEventListener(event, unlock, { capture: true });
      }
    };

    for (const event of ['click', 'keydown', 'pointerdown', 'touchstart'] as const) {
      window.addEventListener(event, unlock, { capture: true, passive: true });
    }
  }

  private ensureAudioContext(): AudioContext | null {
    if (this.audioContext) return this.audioContext;
    if (typeof window === 'undefined') return null;

    try {
      const AudioCtxClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtxClass) return null;

      const ctx = new AudioCtxClass();
      const compressor = ctx.createDynamicsCompressor();
      compressor.threshold.setValueAtTime(-24, ctx.currentTime);
      compressor.knee.setValueAtTime(30, ctx.currentTime);
      compressor.ratio.setValueAtTime(12, ctx.currentTime);
      compressor.attack.setValueAtTime(0.003, ctx.currentTime);
      compressor.release.setValueAtTime(0.25, ctx.currentTime);

      const masterGain = ctx.createGain();
      masterGain.gain.setValueAtTime(0.28, ctx.currentTime);

      compressor.connect(masterGain);
      masterGain.connect(ctx.destination);

      this.audioContext = ctx;
      this.compressorNode = compressor;
      this.masterGainNode = masterGain;
      return ctx;
    } catch {
      return null;
    }
  }

  public isMuted(): boolean {
    return this.muted;
  }

  public async setMuted(muted: boolean): Promise<void> {
    this.muted = muted;
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(STORAGE_KEY, String(muted));
        localStorage.setItem(LEGACY_STORAGE_KEY, String(muted));
      }
    } catch {
      // ignore
    }
    await financeRepository.setSetting('soundMuted', muted);
    this.notifyMuteChange();
  }

  public toggleMute(): boolean {
    const next = !this.muted;
    void this.setMuted(next);
    return next;
  }

  private notifyMuteChange(): void {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('tala-mute-change', { detail: { muted: this.muted } }));
    }
  }

  public play(cue: SoundCue): void {
    // Hard gate: strictly zero sound invocation when muted
    if (this.muted) {
      return;
    }

    // Max 3 concurrent voices cap
    if (this.activeVoices >= 3) {
      return;
    }

    // Per-cue debounce: 120ms throttle
    const now = Date.now();
    const last = this.lastPlayed.get(cue) ?? 0;
    if (now - last < 120) {
      return;
    }
    this.lastPlayed.set(cue, now);

    this.executePlay(cue);
  }

  public executePlay(cue: SoundCue): void {
    if (typeof window === 'undefined') {
      return;
    }

    this.activeVoices++;
    const releaseVoice = () => {
      this.activeVoices = Math.max(0, this.activeVoices - 1);
    };

    // Try HTML5 Audio element first
    const filename = CUE_FILE_MAP[cue] || `${cue}.mp3`;
    const basePath = (typeof import.meta !== 'undefined' && import.meta.env?.BASE_URL) || '/';
    const audioUrl = `${basePath}sounds/${filename}`;

    let playedViaElement = false;

    if (typeof Audio !== 'undefined') {
      try {
        let audio = this.audioCache.get(cue);
        if (!audio) {
          audio = new Audio(audioUrl);
          audio.volume = 0.35;
          this.audioCache.set(cue, audio);
        }

        audio.currentTime = 0;
        const playPromise = audio.play();
        if (playPromise !== undefined) {
          playedViaElement = true;
          playPromise
            .then(() => {
              setTimeout(releaseVoice, 250);
            })
            .catch(() => {
              // Asset playback failed (network, decode, 404) -> fallback to procedural synthesizer
              this.fallbackToSynthesizer(cue);
              releaseVoice();
            });
        }
      } catch {
        // Fall back to Web Audio
      }
    }

    if (!playedViaElement) {
      this.fallbackToSynthesizer(cue);
      setTimeout(releaseVoice, 250);
    }
  }

  private fallbackToSynthesizer(cue: SoundCue): void {
    try {
      const ctx = this.ensureAudioContext();
      if (!ctx || !this.compressorNode) return;

      if (ctx.state === 'suspended') {
        void ctx.resume().catch(() => {});
      }
      playSynthesizedCue(ctx, this.compressorNode, cue);
    } catch {
      // Graceful no-op in headless/restricted environments
    }
  }
}

export const soundService: ISoundService = new SoundService();
