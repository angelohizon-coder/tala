export type SoundCue = 'success' | 'error' | 'delete' | 'dialog_open' | 'dialog_close';

function playChime(ctx: AudioContext, dest: AudioNode, freq: number, startTime: number, duration: number, gainVal: number) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(freq, startTime);

  gain.gain.setValueAtTime(0.0001, startTime);
  gain.gain.exponentialRampToValueAtTime(gainVal, startTime + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

  osc.connect(gain);
  gain.connect(dest);

  osc.start(startTime);
  osc.stop(startTime + duration);
}

function playTone(
  ctx: AudioContext,
  dest: AudioNode,
  freq: number,
  startTime: number,
  duration: number,
  gainVal: number,
  type: OscillatorType = 'sine'
) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, startTime);

  gain.gain.setValueAtTime(0.0001, startTime);
  gain.gain.linearRampToValueAtTime(gainVal, startTime + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

  osc.connect(gain);
  gain.connect(dest);

  osc.start(startTime);
  osc.stop(startTime + duration);
}

function playDescending(
  ctx: AudioContext,
  dest: AudioNode,
  startFreq: number,
  endFreq: number,
  startTime: number,
  duration: number,
  gainVal: number
) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(startFreq, startTime);
  osc.frequency.exponentialRampToValueAtTime(endFreq, startTime + duration);

  gain.gain.setValueAtTime(0.0001, startTime);
  gain.gain.linearRampToValueAtTime(gainVal, startTime + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

  osc.connect(gain);
  gain.connect(dest);

  osc.start(startTime);
  osc.stop(startTime + duration);
}

function playSwell(
  ctx: AudioContext,
  dest: AudioNode,
  startFreq: number,
  endFreq: number,
  startTime: number,
  duration: number,
  gainVal: number
) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(startFreq, startTime);
  osc.frequency.linearRampToValueAtTime(endFreq, startTime + duration);

  gain.gain.setValueAtTime(0.0001, startTime);
  gain.gain.linearRampToValueAtTime(gainVal, startTime + duration * 0.4);
  gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

  osc.connect(gain);
  gain.connect(dest);

  osc.start(startTime);
  osc.stop(startTime + duration);
}

/**
 * Procedural Web Audio API sound synthesizer fallback.
 * Uses OscillatorNode + GainNode with smooth ADSR envelope.
 * Completely offline, zero network requests, zero bundle dependencies.
 */
export function playSynthesizedCue(ctx: AudioContext, destination: AudioNode, cue: SoundCue): void {
  try {
    const now = ctx.currentTime;
    switch (cue) {
      case 'success': {
        // Warm ascending dual-tone chime (C5 523Hz -> G5 784Hz)
        playChime(ctx, destination, 523.25, now, 0.11, 0.16);
        playChime(ctx, destination, 783.99, now + 0.09, 0.17, 0.22);
        break;
      }
      case 'error': {
        // Gentle low double-tap (Eb4 311Hz -> C4 261Hz)
        playTone(ctx, destination, 311.13, now, 0.09, 0.13, 'triangle');
        playTone(ctx, destination, 261.63, now + 0.11, 0.13, 0.15, 'triangle');
        break;
      }
      case 'delete': {
        // Soft descending tone (G4 392Hz -> D4 294Hz)
        playDescending(ctx, destination, 392.0, 293.66, now, 0.16, 0.14);
        break;
      }
      case 'dialog_open': {
        // Subtle airy swell (C5 523Hz -> E5 659Hz, very low volume)
        playSwell(ctx, destination, 523.25, 659.25, now, 0.12, 0.07);
        break;
      }
      case 'dialog_close': {
        // Soft quiet latch (E4 330Hz -> C4 261Hz, very low volume)
        playSwell(ctx, destination, 329.63, 261.63, now, 0.08, 0.06);
        break;
      }
    }
  } catch {
    // Graceful no-op in restricted environments
  }
}
