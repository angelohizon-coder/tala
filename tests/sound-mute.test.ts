/**
 * tests/sound-mute.test.ts
 *
 * Milestone M8 Test Suite: Sound Engine, Debouncing, Mute Gating & Persistence
 * Verifies:
 * 1. soundService singleton state management (isMuted, setMuted, toggleMute).
 * 2. Dual-persistence: localStorage ('tala:sound-muted') and Dexie ('soundMuted').
 * 3. Reactive notification: window 'tala-mute-change' custom event.
 * 4. Hard mute gating: strict zero audio invocation when muted.
 * 5. Per-cue 120ms debounce throttle (rapid bursts throttled, distinct cues independent).
 * 6. Maximum 3 concurrent active voices limiter.
 * 7. Procedural Web Audio synthesizer fallback for all 5 semantic cues.
 * 8. Headless Node / SSR runtime safety (never throws on missing Audio/AudioContext).
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { soundService, type SoundCue } from '../src/ui/soundManager';
import { playSynthesizedCue } from '../src/ui/soundSynthesizer';
import { financeRepository } from '../src/db/repository';

describe('M8.5: Sound Service State, Dual-Persistence & Mute Controls', () => {
  const originalWindow = (globalThis as any).window;

  beforeEach(async () => {
    (globalThis as any).window = {
      dispatchEvent: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    (soundService as any).lastPlayed.clear();
    (soundService as any).activeVoices = 0;
    await soundService.setMuted(false);
  });

  afterEach(async () => {
    await soundService.setMuted(false);
    (globalThis as any).window = originalWindow;
  });

  it('toggles mute state and returns the new value', async () => {
    expect(soundService.isMuted()).toBe(false);

    const toggled1 = soundService.toggleMute();
    expect(toggled1).toBe(true);
    expect(soundService.isMuted()).toBe(true);

    const toggled2 = soundService.toggleMute();
    expect(toggled2).toBe(false);
    expect(soundService.isMuted()).toBe(false);
  });

  it('persists mute state to localStorage immediately', async () => {
    await soundService.setMuted(true);
    if (typeof localStorage !== 'undefined') {
      expect(localStorage.getItem('tala:sound-muted')).toBe('true');
    }

    await soundService.setMuted(false);
    if (typeof localStorage !== 'undefined') {
      expect(localStorage.getItem('tala:sound-muted')).toBe('false');
    }
  });

  it('persists mute state to Dexie settings repository', async () => {
    await soundService.setMuted(true);
    const dbVal = await financeRepository.getSetting<boolean>('soundMuted', false);
    expect(dbVal).toBe(true);

    await soundService.setMuted(false);
    const dbVal2 = await financeRepository.getSetting<boolean>('soundMuted', true);
    expect(dbVal2).toBe(false);
  });

  it('dispatches tala-mute-change CustomEvent on window when mute state changes', async () => {
    const dispatchSpy = vi.fn();
    (globalThis as any).window = {
      dispatchEvent: dispatchSpy,
    };

    await soundService.setMuted(true);
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    const callArg1 = dispatchSpy.mock.calls[0][0];
    expect(callArg1.type).toBe('tala-mute-change');
    expect(callArg1.detail).toEqual({ muted: true });

    await soundService.setMuted(false);
    expect(dispatchSpy).toHaveBeenCalledTimes(2);
    const callArg2 = dispatchSpy.mock.calls[1][0];
    expect(callArg2.type).toBe('tala-mute-change');
    expect(callArg2.detail).toEqual({ muted: false });
  });
});

describe('M8.6: Strict Audio Mute Gating & Throttling Rules', () => {
  beforeEach(async () => {
    (soundService as any).lastPlayed.clear();
    (soundService as any).activeVoices = 0;
    await soundService.setMuted(false);
  });

  afterEach(async () => {
    (soundService as any).lastPlayed.clear();
    (soundService as any).activeVoices = 0;
    await soundService.setMuted(false);
  });

  it('strictly suppresses sound execution when muted (hard gate)', async () => {
    await soundService.setMuted(true);

    // Spy on executePlay
    const executeSpy = vi.spyOn(soundService as any, 'executePlay');

    soundService.play('success');
    soundService.play('error');
    soundService.play('delete');
    soundService.play('dialog_open');
    soundService.play('dialog_close');

    expect(executeSpy).not.toHaveBeenCalled();
    executeSpy.mockRestore();
  });

  it('enforces 120ms debounce throttle per semantic cue', () => {
    const executeSpy = vi.spyOn(soundService as any, 'executePlay').mockImplementation(() => {});

    // First call plays
    soundService.play('success');
    expect(executeSpy).toHaveBeenCalledTimes(1);

    // Immediate second call for same cue within < 120ms is dropped
    soundService.play('success');
    expect(executeSpy).toHaveBeenCalledTimes(1);

    // Different cue is NOT blocked by 'success' throttle
    soundService.play('dialog_open');
    expect(executeSpy).toHaveBeenCalledTimes(2);

    executeSpy.mockRestore();
  });

  it('limits active concurrent voice count to maximum 3', () => {
    const executeSpy = vi.spyOn(soundService as any, 'executePlay').mockImplementation(() => {});

    // Artificially saturate voices
    (soundService as any).activeVoices = 3;

    soundService.play('delete');
    expect(executeSpy).not.toHaveBeenCalled();

    // Release one voice
    (soundService as any).activeVoices = 2;
    soundService.play('delete');
    expect(executeSpy).toHaveBeenCalledTimes(1);

    (soundService as any).activeVoices = 0;
    executeSpy.mockRestore();
  });
});

describe('M8.7: Web Audio Procedural Synthesizer Fallback', () => {
  it('synthesizes all 5 semantic cues using Oscillator and Gain nodes', () => {
    const createdOscillators: any[] = [];
    const createdGains: any[] = [];

    const mockCtx = {
      currentTime: 10,
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
        createdOscillators.push(osc);
        return osc;
      }),
      createGain: vi.fn(() => {
        const gain = {
          gain: {
            setValueAtTime: vi.fn(),
            linearRampToValueAtTime: vi.fn(),
            exponentialRampToValueAtTime: vi.fn(),
          },
          connect: vi.fn(),
        };
        createdGains.push(gain);
        return gain;
      }),
    } as unknown as AudioContext;

    const mockDestination = {} as AudioNode;

    const cues: SoundCue[] = ['success', 'error', 'delete', 'dialog_open', 'dialog_close'];
    for (const cue of cues) {
      createdOscillators.length = 0;
      createdGains.length = 0;

      playSynthesizedCue(mockCtx, mockDestination, cue);

      expect(createdOscillators.length).toBeGreaterThanOrEqual(1);
      expect(createdGains.length).toBeGreaterThanOrEqual(1);
      expect(createdOscillators[0].start).toHaveBeenCalled();
      expect(createdOscillators[0].stop).toHaveBeenCalled();
    }
  });

  it('runs safely in headless/restricted environments without throwing', () => {
    // Calling play with missing browser objects should gracefully no-op
    expect(() => {
      soundService.play('success');
      soundService.play('error');
    }).not.toThrow();
  });
});
