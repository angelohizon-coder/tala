# Scope: Comprehensive UI Overhaul (UI Animations, Sound Cues, Accessibility & Controls)
Working Directory: e:\Visual Studio Code\tala\.agents\teamwork\orchestrator_2
Date: 2026-10-10

## Architecture
- **GPU-Accelerated Page Transitions**: Fast (180ms) CSS `@keyframes pageFadeIn` (`opacity: 0 -> 1`, `translateY: 4px -> 0`) applied to `#page-main` keyed by `location.pathname`, harmonized with `useRouteFocus()` for WCAG 2.4.3 compliance.
- **Centralized Modal Lifecycle**: Unified enter/exit state (`isClosing`, 150ms exit keyframe, 200ms enter keyframe, backdrop fade) in `src/ui/shared.tsx` `<Dialog>`, automatically elevating all 17 modals without touching individual form code.
- **Dynamic Recharts Motion Control**: SVG path animations enabled across all 6 charts (Overview Cash Flow, Asset Allocation, FIRE Trajectories, Depletion PDF, Reports Cash Flow, Net Worth) via `isAnimationActive={!prefersReducedMotion}`, with locked container heights preventing Cumulative Layout Shift (CLS = 0).
- **Hybrid Audio Architecture**: 5 semantic sound cues (`success`, `error`, `delete`, `dialog_open`, `dialog_close`) utilizing lightweight open-source MP3 assets in `public/sounds/` with procedural Web Audio API synthesizer (`OscillatorNode` + `GainNode`) fallback for 100% offline reliability.
- **Robust Audio Service & Controls**: Singleton `SoundService` with autoplay gesture unlocking, debounce throttling (120ms), concurrency limiting (max 3 voices), dynamic compression, and headless Node/Vitest test environment safety.
- **Dual-Persistence Global Mute Toggle**: Instant synchronous `localStorage` reading preventing initial click audio leaks, backed by persistent Dexie `settings` table (`soundMuted`). UI access via topbar header button (`Volume2`/`VolumeX`) and settings page toggle.
- **Accessibility Invariants**: `prefers-reduced-motion` suppresses all CSS transitions/animations and dynamically sets Recharts `isAnimationActive={false}`. Global mute toggle strictly halts all audio output.

---

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 23 | UI Animations & Page Transitions | Fast GPU-composited CSS keyframe entrance on route changes keyed by `location.pathname`, zero layout thrashing | M8 | R1, Explorer 1 |
| 24 | Modal Enter/Exit Lifecycles | Centralized `<Dialog>` in `src/ui/shared.tsx` with `isClosing` state, smooth 150ms exit / 200ms enter keyframes across all 17 modals | M8 | R1, Explorer 1 |
| 25 | Dynamic Chart Animations & Motion Accessibility | Recharts `isAnimationActive={!prefersReducedMotion}`, `animationDuration={prefersReducedMotion ? 0 : 600}`, locked heights, `useReducedMotion()` hook | M8 | R1, R3, Explorer 1, Explorer 3 |
| 26 | Sound Cues Engine & Asset Integration | 5 semantic cues (`success`, `error`, `delete`, `dialog_open`, `dialog_close`), `public/sounds/*.mp3` assets + Web Audio API synthesizer fallback, concurrency & debounce | M8 | R2, Explorer 2 |
| 27 | Global Mute Controls & State Persistence | Synchronous `localStorage` + Dexie `settings` table, topbar toggle button (`Volume2`/`VolumeX`) + settings page toggle, hard `if (isMuted) return;` gating | M8 | R3, Explorer 2, Explorer 3 |
| 28 | Accessibility & Sound Suppression Unit Tests | `tests/accessibility-reduced-motion.test.ts` (verifying `prefers-reduced-motion` suppresses chart & dialog animations) and `tests/sound-mute.test.ts` (verifying mute stops sound calls) | M9 | AC Tests, Explorer 3 |
| 29 | UI/UX Review & Forensic Integrity Audit | Agent-as-judge UI/UX verification of smooth non-stuttering transitions, non-overlapping sound cues, zero layout shift, and forensic integrity audit | M9 | AC Judge, Auditor |

---

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M8 | Comprehensive UI Overhaul Implementation | Features 23, 24, 25, 26, 27 (R1, R2, R3) | Phase 0 Survey | DONE |
| M9 | Automated Verification, UI/UX Review & Forensic Audit | Features 28, 29 (AC Verification & Agent-as-Judge) | M8 | DONE |

---

## Interface Contracts

### M8: Motion & Animation Interface
- `src/hooks/useReducedMotion.ts`:
  ```typescript
  export function useReducedMotion(): boolean;
  ```
- `src/ui/shared.tsx`:
  ```typescript
  export function Dialog(props: { title: string; children: ReactNode; onClose: () => void }): JSX.Element;
  ```
  Exposes internal closing state (`isClosing: boolean`) and handles exit animation before invoking `onClose()`.
- `tailwind.config.js` / `src/styles.css`:
  Classes: `animate-page-fade-in`, `animate-modal-in`, `animate-modal-out`, `motion-reduce:animate-none`.

### M8: Audio Service & Mute Controls Interface
- `src/ui/soundManager.ts`:
  ```typescript
  export type SoundCue = 'success' | 'error' | 'delete' | 'dialog_open' | 'dialog_close';
  export interface ISoundService {
    isMuted(): boolean;
    setMuted(muted: boolean): void;
    toggleMute(): boolean;
    play(cue: SoundCue): void;
  }
  export const soundService: ISoundService;
  ```
- React Hook: `src/hooks/useSound.ts`:
  ```typescript
  export function useSound(): {
    play: (cue: SoundCue) => void;
    isMuted: boolean;
    setMuted: (val: boolean) => void;
    toggleMute: () => boolean;
  };
  ```

### M9: Test Suite & Review Interface
- `tests/accessibility-reduced-motion.test.ts`: Passes 100% under Vitest (14 tests).
- `tests/sound-mute.test.ts`: Passes 100% under Vitest (9 tests).
- `tests/challenger-motion-stress.test.ts`: Passes 100% under Vitest (9 tests).
- `tests/challenger-audio-adversarial.test.ts`: Passes 100% under Vitest (20 tests).
- Existing tests (`vitest run`, `node --test tests/*.test.mjs`, `node tests/e2e/run-all.mjs`): Zero regressions across 347 Vitest, 141 Node unit, and 93 E2E tests.
- UI/UX Review: Clean report confirming zero layout shifts, smooth modal/page transitions, and pleasant non-overlapping audio.
- Forensic Auditor: Verdict CLEAN.

---

## Code Layout
- `src/hooks/`: `useReducedMotion.ts`, `useSound.ts`
- `src/ui/`: `soundManager.ts`, `soundSynthesizer.ts`, `shared.tsx` (`Dialog`), accessible switches
- `src/styles.css`: Keyframes for page, modal, and backdrop animations; `@media (prefers-reduced-motion)` rules
- `tailwind.config.js`: Semantic animation tokens and keyframes
- `public/sounds/`: `success.mp3`, `error.mp3`, `delete.mp3`, `dialog-open.mp3`, `dialog-close.mp3`
- `tests/`: `accessibility-reduced-motion.test.ts`, `sound-mute.test.ts`, `challenger-motion-stress.test.ts`, `challenger-audio-adversarial.test.ts`
