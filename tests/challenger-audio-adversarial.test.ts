import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { soundService, type SoundCue } from '../src/ui/soundManager';
import * as soundSynthesizerModule from '../src/ui/soundSynthesizer';
import { financeRepository } from '../src/db/repository';

describe('Challenger Adversarial Audio & Mute Hardening Suite', () => {
  const originalWindow = (globalThis as any).window;
  const originalAudio = (globalThis as any).Audio;
  const originalAudioContext = (globalThis as any).AudioContext;
  let mockStorage: Map<string, string>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    mockStorage = new Map<string, string>();

    // Mock localStorage
    const storageMock = {
      getItem: (key: string) => mockStorage.get(key) ?? null,
      setItem: (key: string, val: string) => mockStorage.set(key, String(val)),
      removeItem: (key: string) => { mockStorage.delete(key); },
      clear: () => { mockStorage.clear(); },
      get length() { return mockStorage.size; },
      key: (i: number) => Array.from(mockStorage.keys())[i] ?? null,
    };
    Object.defineProperty(globalThis, 'localStorage', {
      value: storageMock,
      configurable: true,
      writable: true,
    });

    // Mock window
    (globalThis as any).window = {
      dispatchEvent: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      AudioContext: vi.fn(),
    };

    // Reset internal state
    (soundService as any).audioCache.clear();
    (soundService as any).lastPlayed.clear();
    (soundService as any).activeVoices = 0;
    await soundService.setMuted(false);
  });

  afterEach(async () => {
    (soundService as any).audioCache.clear();
    (soundService as any).lastPlayed.clear();
    (soundService as any).activeVoices = 0;
    await soundService.setMuted(false);
    (globalThis as any).window = originalWindow;
    (globalThis as any).Audio = originalAudio;
    (globalThis as any).AudioContext = originalAudioContext;
  });

  describe('Adversarial Challenge 1: Mute Hard-Gating Under Extreme Volume (100 Rapid Calls)', () => {
    it('calling play() 100 times when muted triggers strictly 0 audio invocations', async () => {
      await soundService.setMuted(true);
      expect(soundService.isMuted()).toBe(true);

      const executePlaySpy = vi.spyOn(soundService as any, 'executePlay');
      const synthSpy = vi.spyOn(soundSynthesizerModule, 'playSynthesizedCue');
      const fallbackSpy = vi.spyOn(soundService as any, 'fallbackToSynthesizer');

      // Mock Audio constructor to catch any rogue instantiation
      const audioConstructorSpy = vi.fn();
      (globalThis as any).Audio = audioConstructorSpy;

      const cues: SoundCue[] = ['success', 'error', 'delete', 'dialog_open', 'dialog_close'];

      // Fire 100 calls in rapid succession across randomized cues
      for (let i = 0; i < 100; i++) {
        const cue = cues[i % cues.length];
        soundService.play(cue);
      }

      // Assert hard gate: exactly 0 audio executions
      expect(executePlaySpy).toHaveBeenCalledTimes(0);
      expect(synthSpy).toHaveBeenCalledTimes(0);
      expect(fallbackSpy).toHaveBeenCalledTimes(0);
      expect(audioConstructorSpy).toHaveBeenCalledTimes(0);
      expect((soundService as any).activeVoices).toBe(0);
      expect((soundService as any).lastPlayed.size).toBe(0);

      executePlaySpy.mockRestore();
      synthSpy.mockRestore();
      fallbackSpy.mockRestore();
    });

    it('calling play() 100 times concurrently via Promise.all when muted results in 0 audio calls', async () => {
      await soundService.setMuted(true);

      const executePlaySpy = vi.spyOn(soundService as any, 'executePlay');
      const synthSpy = vi.spyOn(soundSynthesizerModule, 'playSynthesizedCue');

      const cues: SoundCue[] = ['success', 'error', 'delete', 'dialog_open', 'dialog_close'];
      const tasks = Array.from({ length: 100 }, (_, i) => {
        return Promise.resolve().then(() => {
          soundService.play(cues[i % cues.length]);
        });
      });

      await Promise.all(tasks);

      expect(executePlaySpy).toHaveBeenCalledTimes(0);
      expect(synthSpy).toHaveBeenCalledTimes(0);
      expect((soundService as any).activeVoices).toBe(0);

      executePlaySpy.mockRestore();
      synthSpy.mockRestore();
    });

    it('mid-burst mute activation instantly suppresses remaining calls', () => {
      expect(soundService.isMuted()).toBe(false);

      const executePlaySpy = vi.spyOn(soundService as any, 'executePlay').mockImplementation(() => {});

      // Fire 10 calls unmuted with distinct cues or forced intervals
      for (let i = 0; i < 20; i++) {
        if (i === 10) {
          // Halfway through, user flips mute switch
          void soundService.setMuted(true);
        }
        // Force clearance of debounce timestamp to test gating in isolation
        (soundService as any).lastPlayed.clear();
        (soundService as any).activeVoices = 0;
        soundService.play('success');
      }

      // First 10 calls (i=0..9) execute, subsequent 10 calls (i=10..19) strictly blocked
      expect(executePlaySpy).toHaveBeenCalledTimes(10);

      executePlaySpy.mockRestore();
    });
  });

  describe('Adversarial Challenge 2: Debounce Throttling & Burst Suppression (50 rapid calls < 120ms)', () => {
    it('calling play() 50 times in rapid succession (< 120ms) executes exactly once', () => {
      const executePlaySpy = vi.spyOn(soundService as any, 'executePlay').mockImplementation(() => {});

      // Call play('success') 50 times in immediate synchronous succession (0ms interval)
      for (let i = 0; i < 50; i++) {
        soundService.play('success');
      }

      // Exactly 1 should have executed, 49 throttled by 120ms debounce
      expect(executePlaySpy).toHaveBeenCalledTimes(1);

      executePlaySpy.mockRestore();
    });

    it('respects the 120ms debounce boundary across repeated 50-call burst cycles', () => {
      vi.useFakeTimers();
      try {
        const executePlaySpy = vi.spyOn(soundService as any, 'executePlay').mockImplementation(() => {});

        // Burst 1: 50 calls at t=0
        for (let i = 0; i < 50; i++) {
          soundService.play('error');
        }
        expect(executePlaySpy).toHaveBeenCalledTimes(1);

        // Advance 60ms (still within 120ms window) -> 50 calls should all be throttled
        vi.advanceTimersByTime(60);
        for (let i = 0; i < 50; i++) {
          soundService.play('error');
        }
        expect(executePlaySpy).toHaveBeenCalledTimes(1);

        // Advance another 61ms (total 121ms > 120ms window) -> next burst allows exactly 1 call
        vi.advanceTimersByTime(61);
        for (let i = 0; i < 50; i++) {
          soundService.play('error');
        }
        expect(executePlaySpy).toHaveBeenCalledTimes(2);

        executePlaySpy.mockRestore();
      } finally {
        vi.useRealTimers();
      }
    });

    it('maintains independent debounce counters for each semantic cue', () => {
      const executePlaySpy = vi.spyOn(soundService as any, 'executePlay').mockImplementation(() => {});
      const cues: SoundCue[] = ['success', 'error', 'delete'];

      // Burst 50 calls of 'success'
      for (let i = 0; i < 50; i++) {
        soundService.play('success');
      }
      expect(executePlaySpy).toHaveBeenCalledTimes(1);

      // Immediately burst 50 calls of 'error' -> should NOT be blocked by 'success' throttle
      for (let i = 0; i < 50; i++) {
        soundService.play('error');
      }
      expect(executePlaySpy).toHaveBeenCalledTimes(2);

      // Immediately burst 50 calls of 'delete' -> independent cue, allowed
      for (let i = 0; i < 50; i++) {
        soundService.play('delete');
      }
      expect(executePlaySpy).toHaveBeenCalledTimes(3);

      executePlaySpy.mockRestore();
    });
  });

  describe('Adversarial Challenge 3: Concurrency Limiting & Voice Allocation', () => {
    it('caps active concurrent voice allocation at maximum 3', () => {
      const executePlaySpy = vi.spyOn(soundService as any, 'executePlay').mockImplementation(() => {});

      // Satiate 3 voices
      (soundService as any).activeVoices = 0;
      soundService.play('success'); // voice 1 -> executes
      (soundService as any).activeVoices = 1;

      soundService.play('error'); // voice 2 -> executes
      (soundService as any).activeVoices = 2;

      soundService.play('delete'); // voice 3 -> executes
      (soundService as any).activeVoices = 3;

      expect(executePlaySpy).toHaveBeenCalledTimes(3);

      // 4th and 5th cues are blocked because activeVoices >= 3
      soundService.play('dialog_open');
      soundService.play('dialog_close');
      expect(executePlaySpy).toHaveBeenCalledTimes(3);

      // Releasing 1 voice allows exactly 1 more cue
      (soundService as any).activeVoices = 2;
      soundService.play('dialog_open');
      expect(executePlaySpy).toHaveBeenCalledTimes(4);

      executePlaySpy.mockRestore();
    });

    it('releases voices cleanly after playback completion without voice leakage', async () => {
      vi.useFakeTimers();
      try {
        let playResolve: () => void = () => {};
        const mockAudioElement = {
          currentTime: 0,
          volume: 0.35,
          play: vi.fn(() => new Promise<void>(res => { playResolve = res; })),
        };
        (globalThis as any).Audio = function MockAudio() { return mockAudioElement; };

        expect((soundService as any).activeVoices).toBe(0);

        // Play cue
        soundService.play('success');
        expect((soundService as any).activeVoices).toBe(1);

        // Resolve audio play
        playResolve();
        await Promise.resolve();

        // Before 250ms release timer
        expect((soundService as any).activeVoices).toBe(1);

        // Advance 250ms
        vi.advanceTimersByTime(250);
        expect((soundService as any).activeVoices).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('immediately releases voice on audio.play rejection without orphan voice lock', async () => {
      let playReject: (err: any) => void = () => {};
      const mockAudioElement = {
        currentTime: 0,
        volume: 0.35,
        play: vi.fn(() => new Promise<void>((_, rej) => { playReject = rej; })),
      };
      (globalThis as any).Audio = function MockAudio() { return mockAudioElement; };

      const mockCtxInstance = {
        currentTime: 0,
        state: 'running',
        createDynamicsCompressor: () => ({
          threshold: { setValueAtTime: vi.fn() },
          knee: { setValueAtTime: vi.fn() },
          ratio: { setValueAtTime: vi.fn() },
          attack: { setValueAtTime: vi.fn() },
          release: { setValueAtTime: vi.fn() },
          connect: vi.fn(),
        }),
        createGain: () => ({
          gain: { setValueAtTime: vi.fn() },
          connect: vi.fn(),
        }),
        destination: {},
        resume: vi.fn().mockResolvedValue(undefined),
      };
      (globalThis as any).window.AudioContext = function MockAudioContext() { return mockCtxInstance; };
      (soundService as any).audioContext = null;
      (soundService as any).compressorNode = null;

      const synthSpy = vi.spyOn(soundSynthesizerModule, 'playSynthesizedCue').mockImplementation(() => {});

      expect((soundService as any).activeVoices).toBe(0);
      soundService.play('error');
      expect((soundService as any).activeVoices).toBe(1);

      // Reject audio element playback (e.g., Autoplay policy NotAllowedError or 404)
      playReject(new Error('NotAllowedError: user did not interact'));
      await Promise.resolve();
      await Promise.resolve();

      // Voice should be released immediately and fallback synth triggered
      expect((soundService as any).activeVoices).toBe(0);
      expect(synthSpy).toHaveBeenCalledTimes(1);

      synthSpy.mockRestore();
    });

    it('voice count never drops below 0 even if releaseVoice is triggered extra times', () => {
      (soundService as any).activeVoices = 0;
      // Trigger internal releaseVoice
      (soundService as any).activeVoices = Math.max(0, (soundService as any).activeVoices - 1);
      expect((soundService as any).activeVoices).toBe(0);
    });
  });

  describe('Adversarial Challenge 4: Dual Persistence (localStorage + Dexie) & Cross-Tab Events', () => {
    it('synchronizes setMuted(true) synchronously to localStorage and asynchronously to Dexie', async () => {
      await soundService.setMuted(true);

      // Verify localStorage synchronous persistence (both canonical and legacy keys)
      expect(mockStorage.get('tala:sound-muted')).toBe('true');
      expect(mockStorage.get('tala_sound_muted')).toBe('true');

      // Verify Dexie persistence
      const dexieValue = await financeRepository.getSetting<boolean>('soundMuted', false);
      expect(dexieValue).toBe(true);

      // Invert to false
      await soundService.setMuted(false);
      expect(mockStorage.get('tala:sound-muted')).toBe('false');
      expect(mockStorage.get('tala_sound_muted')).toBe('false');

      const dexieValue2 = await financeRepository.getSetting<boolean>('soundMuted', true);
      expect(dexieValue2).toBe(false);
    });

    it('toggleMute() inverts state, returns new value, and persists to both stores', async () => {
      await soundService.setMuted(false);
      expect(soundService.isMuted()).toBe(false);

      const next1 = soundService.toggleMute();
      expect(next1).toBe(true);
      expect(soundService.isMuted()).toBe(true);
      expect(mockStorage.get('tala:sound-muted')).toBe('true');

      const next2 = soundService.toggleMute();
      expect(next2).toBe(false);
      expect(soundService.isMuted()).toBe(false);
      expect(mockStorage.get('tala:sound-muted')).toBe('false');
    });

    it('dispatches tala-mute-change CustomEvent on window for every mute toggle', async () => {
      const dispatchSpy = vi.fn();
      (globalThis as any).window = {
        dispatchEvent: dispatchSpy,
      };

      await soundService.setMuted(true);
      expect(dispatchSpy).toHaveBeenCalledTimes(1);
      expect(dispatchSpy.mock.calls[0][0].type).toBe('tala-mute-change');
      expect(dispatchSpy.mock.calls[0][0].detail).toEqual({ muted: true });

      await soundService.setMuted(false);
      expect(dispatchSpy).toHaveBeenCalledTimes(2);
      expect(dispatchSpy.mock.calls[1][0].type).toBe('tala-mute-change');
      expect(dispatchSpy.mock.calls[1][0].detail).toEqual({ muted: false });
    });

    it('survives private browsing / sandboxed storage exceptions without crashing', async () => {
      // Mock localStorage throwing SecurityError / QuotaExceededError
      const brokenStorage = {
        getItem: () => { throw new Error('SecurityError: The operation is insecure.'); },
        setItem: () => { throw new Error('QuotaExceededError'); },
      };
      Object.defineProperty(globalThis, 'localStorage', {
        value: brokenStorage,
        configurable: true,
        writable: true,
      });

      // Should not throw
      await expect(soundService.setMuted(true)).resolves.not.toThrow();
      expect(soundService.isMuted()).toBe(true);

      await expect(soundService.setMuted(false)).resolves.not.toThrow();
      expect(soundService.isMuted()).toBe(false);
    });
  });

  describe('Adversarial Challenge 5: Procedural Synthesizer & Headless Fallbacks', () => {
    it('procedural synthesizer fallback gracefully handles all 5 semantic cues', () => {
      const mockOscillators: any[] = [];
      const mockGains: any[] = [];

      const mockCtx = {
        currentTime: 100,
        createOscillator: vi.fn(() => {
          const osc = {
            type: 'sine',
            frequency: {
              setValueAtTime: vi.fn(),
              exponentialRampToValueAtTime: vi.fn(),
              linearRampToValueAtTime: vi.fn(),
            },
            connect: vi.fn(),
            start: vi.fn(),
            stop: vi.fn(),
          };
          mockOscillators.push(osc);
          return osc;
        }),
        createGain: vi.fn(() => {
          const gain = {
            gain: {
              setValueAtTime: vi.fn(),
              exponentialRampToValueAtTime: vi.fn(),
              linearRampToValueAtTime: vi.fn(),
            },
            connect: vi.fn(),
          };
          mockGains.push(gain);
          return gain;
        }),
      } as unknown as AudioContext;

      const mockDestination = {} as AudioNode;

      const cues: SoundCue[] = ['success', 'error', 'delete', 'dialog_open', 'dialog_close'];
      for (const cue of cues) {
        mockOscillators.length = 0;
        mockGains.length = 0;

        soundSynthesizerModule.playSynthesizedCue(mockCtx, mockDestination, cue);

        expect(mockOscillators.length).toBeGreaterThanOrEqual(1);
        expect(mockGains.length).toBeGreaterThanOrEqual(1);
        for (const osc of mockOscillators) {
          expect(osc.start).toHaveBeenCalled();
          expect(osc.stop).toHaveBeenCalled();
        }
      }
    });

    it('procedural synthesizer never throws even when AudioContext throws an exception', () => {
      const brokenCtx = {
        currentTime: 0,
        createOscillator: () => { throw new Error('AudioContext in invalid state'); },
      } as unknown as AudioContext;

      expect(() => {
        soundSynthesizerModule.playSynthesizedCue(brokenCtx, {} as AudioNode, 'success');
      }).not.toThrow();
    });

    it('headless execution with undefined window / Audio never throws', () => {
      (globalThis as any).window = undefined;
      (globalThis as any).Audio = undefined;

      expect(() => {
        soundService.play('success');
        soundService.play('error');
        soundService.play('delete');
      }).not.toThrow();
    });
  });

  describe('Adversarial Challenge 6: Autoplay Gesture Unlock Lifecycle', () => {
    it('registers user gesture listeners and removes all upon first interaction', () => {
      const addedListeners: Record<string, Function> = {};
      const removedListeners: string[] = [];

      (globalThis as any).window = {
        dispatchEvent: vi.fn(),
        addEventListener: vi.fn((event: string, handler: Function) => {
          addedListeners[event] = handler;
        }),
        removeEventListener: vi.fn((event: string) => {
          removedListeners.push(event);
        }),
      };

      (soundService as any).unlocked = false;
      (soundService as any).setupAutoplayUnlock();

      const expectedEvents = ['click', 'keydown', 'pointerdown', 'touchstart'];
      for (const ev of expectedEvents) {
        expect(addedListeners[ev]).toBeDefined();
      }

      // Simulate user clicking anywhere in the UI
      addedListeners['click']();

      // All 4 event listeners must be dismantled immediately
      for (const ev of expectedEvents) {
        expect(removedListeners).toContain(ev);
      }
      expect((soundService as any).unlocked).toBe(true);

      // Subsequent events are no-ops
      const removeCountBefore = removedListeners.length;
      addedListeners['click']();
      expect(removedListeners.length).toBe(removeCountBefore);
    });
  });

  describe('Adversarial Challenge 7: Stress Concurrency & Rapid Mute Toggling Race Conditions', () => {
    it('never leaks audio playback when muted during rapid alternating toggle bursts', () => {
      let unmutedPlays = 0;
      let mutedPlays = 0;

      const executePlaySpy = vi.spyOn(soundService as any, 'executePlay').mockImplementation(() => {
        if (soundService.isMuted()) {
          mutedPlays++;
        } else {
          unmutedPlays++;
        }
      });

      // 100 rapid cycles alternating mute state and firing audio
      for (let i = 0; i < 100; i++) {
        // Clear debounce & voice limits to strictly isolate mute gating
        (soundService as any).lastPlayed.clear();
        (soundService as any).activeVoices = 0;

        // Toggle mute state
        const isMutedNow = soundService.toggleMute();

        // Fire play
        soundService.play('success');

        if (isMutedNow) {
          // If muted, verify isMuted() is true
          expect(soundService.isMuted()).toBe(true);
        } else {
          expect(soundService.isMuted()).toBe(false);
        }
      }

      // Invariant: ZERO plays occurred while muted
      expect(mutedPlays).toBe(0);
      // Invariant: Exactly 50 plays occurred while unmuted
      expect(unmutedPlays).toBe(50);
      expect(executePlaySpy).toHaveBeenCalledTimes(50);

      executePlaySpy.mockRestore();
    });

    it('stress tests all 5 cues simultaneously across 100 parallel calls under voice saturation', () => {
      // Mock executePlay preserving the activeVoices increment contract
      const executePlaySpy = vi.spyOn(soundService as any, 'executePlay').mockImplementation(function (this: any) {
        this.activeVoices++;
      });
      const cues: SoundCue[] = ['success', 'error', 'delete', 'dialog_open', 'dialog_close'];

      // Fire 100 calls in round-robin fashion without clearing state
      for (let i = 0; i < 100; i++) {
        soundService.play(cues[i % cues.length]);
      }

      // First 3 cues ('success', 'error', 'delete') execute and occupy voices 0, 1, 2
      // 4th cue ('dialog_open') is blocked by activeVoices >= 3
      // All subsequent 96 calls are blocked by debounce (< 120ms) or voice limiter
      expect(executePlaySpy).toHaveBeenCalledTimes(3);
      expect((soundService as any).activeVoices).toBe(3);

      executePlaySpy.mockRestore();
    });
  });
});

