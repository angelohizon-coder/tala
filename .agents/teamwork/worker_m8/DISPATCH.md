# Dispatch: Milestone M8 — Comprehensive UI Overhaul Implementation
Working directory: e:\Visual Studio Code\tala\.agents\teamwork\worker_m8
Project root: e:\Visual Studio Code\tala

## Mandatory Documents
1. User Request: `e:\Visual Studio Code\tala\.agents\teamwork\ORIGINAL_REQUEST.md` (request dated 2026-10-10T03:02:29Z)
2. Scope Document: `e:\Visual Studio Code\tala\.agents\teamwork\orchestrator_2\SCOPE.md`
3. Explorer Reports:
   - UI Animations & Transitions: `e:\Visual Studio Code\tala\.agents\teamwork\explorer_survey_1\handoff.md`
   - Sound Cues Architecture: `e:\Visual Studio Code\tala\.agents\teamwork\explorer_survey_2\handoff.md`
   - Accessibility & Testing Harness: `e:\Visual Studio Code\tala\.agents\teamwork\explorer_survey_3\handoff.md`

## Mandatory Integrity Warning
> DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

## Objective & Tasks
Implement the complete UI overhaul for Tala: UI animations, sound cues, accessibility controls (`prefers-reduced-motion`, mute toggle).

### 1. Motion Accessibility & React Hooks
- Create `src/hooks/useReducedMotion.ts` wrapping `window.matchMedia('(prefers-reduced-motion: reduce)')`. Must be SSR/Node safe. Synchronize `data-reduced-motion` attribute on `document.documentElement`.
- Ensure `src/styles.css` and `tailwind.config.js` include smooth keyframes (`page-fade-in`, `dialog-enter`, `dialog-exit`, `backdrop-fade-in`, etc.) and ensure `motion-reduce:animate-none` / `motion-reduce:transition-none` suppresses animations when reduced motion is preferred.

### 2. Page Transitions & Centralized Modal Lifecycles
- In `src/App.tsx`, apply fast (180ms) GPU-composited entrance animation on `#page-main` keyed by `location.pathname`. Ensure it does not cause layout thrashing and works seamlessly with `useRouteFocus()`.
- In `src/ui/shared.tsx`, enhance `<Dialog>` with internal `isClosing` state (150ms exit keyframe, 200ms enter keyframe, backdrop animation). Provide smooth opening and closing for all 17 modals. In reduced motion mode, bypass exit delay (0ms) and immediately close.

### 3. Chart Rendering Animations
- In `src/pages/Overview.tsx` and `src/pages/PlanningPages.tsx`, update all 6 Recharts visualizations (Cash Flow, Asset Allocation, FIRE Trajectories, Depletion PDF, Reports Cash Flow, Net Worth) to enable SVG animations dynamically using `isAnimationActive={!prefersReducedMotion}` and `animationDuration={prefersReducedMotion ? 0 : 600}`.
- Ensure all chart container heights remain fixed and stable to guarantee 0 layout shifts (CLS = 0) and 0 layout thrashing.

### 4. Sound Cues Engine & Asset Integration
- Create open-source audio assets in `public/sounds/` (`success.mp3`, `error.mp3`, `delete.mp3`, `dialog-open.mp3`, `dialog-close.mp3`). You can create valid, compact audio files or procedural audio buffers.
- Create procedural Web Audio API synthesizer fallback (`src/ui/soundSynthesizer.ts`) using `OscillatorNode` + `GainNode` for 100% offline resilience without network calls.
- Implement `src/ui/soundManager.ts` / `SoundService` singleton:
  - Lazy `AudioContext` unlocking on user gesture.
  - Per-cue debounce (120ms throttle) and max 3 simultaneous voices.
  - Master volume attenuation and dynamic compressor to prevent clipping.
  - Node / Vitest headless safety (never throw in headless test environments).
  - Hard gate: `if (this.isMuted) return;`.
- Implement `src/hooks/useSound.ts` React hook.
- Wire sound cues into user interactions:
  - `success`: saving transactions, accounts, budgets, recurring rules, importing statements, backups, cloud sync, FIRE plans.
  - `error`: form validation failure, sync error, price refresh error.
  - `delete`: deleting transactions, budgets, recurring rules, goals.
  - `dialog_open` / `dialog_close`: modal open and close events in `<Dialog>`.

### 5. Global Sound Mute Controls
- Dual-persistence: instant synchronous `localStorage` (`tala:sound-muted`) + persistent Dexie `settings` table (`soundMuted`).
- Topbar quick-access icon button (`Volume2` / `VolumeX`) in `src/App.tsx` (`topbar-actions`) with accessible `role="switch"`, `aria-checked`, and `aria-label`.
- Settings page toggle switch in `src/pages/PlanningPages.tsx` (`SettingsPage`) under "Sound cues".

### 6. Build, Typecheck & Test Verification
- Run:
  1. `node ./node_modules/typescript/bin/tsc --noEmit`
  2. `node ./node_modules/vite/bin/vite.js build`
  3. `node ./node_modules/vitest/vitest.mjs run`
  4. `node --test tests/*.test.mjs`
  5. `node tests/e2e/run-all.mjs`
- Ensure zero errors or regressions.
- Document all changes, files touched, commands run, and verification outputs in `handoff.md`. Send message when done.

## 2026-10-10T03:39:45Z
Sender: 70aacd32-1475-457c-a20e-3878c97d92ae
Priority: MESSAGE_PRIORITY_HIGH
Content:
You are worker_m8.
Your working directory is: e:\Visual Studio Code\tala\.agents\teamwork\worker_m8
Project root: e:\Visual Studio Code\tala

MANDATORY: Read ORIGINAL_REQUEST.md before starting work:
e:\Visual Studio Code\tala\.agents\teamwork\ORIGINAL_REQUEST.md (specifically the latest request dated 2026-10-10T03:02:29Z).

Also read your dispatch task and scope document:
e:\Visual Studio Code\tala\.agents\teamwork\worker_m8\DISPATCH.md
e:\Visual Studio Code\tala\.agents\teamwork\orchestrator_2\SCOPE.md

Also read the survey reports from Phase 0 Explorers:
- UI Animations: e:\Visual Studio Code\tala\.agents\teamwork\explorer_survey_1\handoff.md
- Sound Cues: e:\Visual Studio Code\tala\.agents\teamwork\explorer_survey_2\handoff.md
- Accessibility & Tests: e:\Visual Studio Code\tala\.agents\teamwork\explorer_survey_3\handoff.md

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Your Tasks:
1. Implement `src/hooks/useReducedMotion.ts` and motion utilities/keyframes in `src/styles.css` & `tailwind.config.js`.
2. Implement page transitions in `src/App.tsx` (GPU-accelerated entrance on `#page-main`, no layout thrashing).
3. Enhance `<Dialog>` in `src/ui/shared.tsx` with enter/exit keyframes and `isClosing` lifecycle, preserving WCAG focus.
4. Dynamically enable SVG animations across all 6 Recharts charts in `src/pages/Overview.tsx` and `src/pages/PlanningPages.tsx` with `isAnimationActive={!prefersReducedMotion}`.
5. Create open-source sound assets in `public/sounds/` and procedural Web Audio synthesizer fallback in `src/ui/soundSynthesizer.ts`.
6. Implement `src/ui/soundManager.ts` / singleton sound service with debounce, concurrency throttling, autoplay unlocking, and safe headless behavior, plus `src/hooks/useSound.ts`.
7. Wire sound cues (`success`, `error`, `delete`, `dialog_open`, `dialog_close`) to user interactions across forms and dialogs.
8. Implement global mute controls: topbar icon button in `src/App.tsx` and settings toggle in `src/pages/PlanningPages.tsx`, backed by synchronous `localStorage` + persistent Dexie settings.
9. Run build, typecheck, and existing tests (`tsc --noEmit`, `vite build`, `vitest run`, `node --test tests/*.test.mjs`, `node tests/e2e/run-all.mjs`) to ensure zero errors and zero regressions.
10. Write a comprehensive report in `handoff.md` and keep `progress.md` updated in your working directory. Send message to orchestrator_2 when done.
