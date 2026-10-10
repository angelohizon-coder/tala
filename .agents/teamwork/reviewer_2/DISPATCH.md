# Review Task: Audio Architecture, Sound Cues & Global Controls
Working directory: e:\Visual Studio Code\tala\.agents\teamwork\reviewer_2
Project root: e:\Visual Studio Code\tala
MANDATORY: Read ORIGINAL_REQUEST.md:
e:\Visual Studio Code\tala\.agents\teamwork\ORIGINAL_REQUEST.md (specifically request dated 2026-10-10T03:02:29Z)

Also read:
- Scope: e:\Visual Studio Code\tala\.agents\teamwork\orchestrator_2\SCOPE.md
- Worker Handoff: e:\Visual Studio Code\tala\.agents\teamwork\worker_m8\handoff.md

## Objective
Independently review the UI overhaul implementation with a focus on audio architecture, sound cues, accessibility, and mute controls:
1. Examine `src/ui/soundManager.ts`, `src/ui/soundSynthesizer.ts`, `src/hooks/useSound.ts`, `public/sounds/`, `src/hooks/useReducedMotion.ts`.
2. Verify sound cues are properly triggered across mutations in `src/pages/LedgerPages.tsx`, `src/pages/PlanningPages.tsx`, `src/pages/InvestmentPages.tsx`, `src/pages/DataPage.tsx`.
3. Verify that the global mute toggle in topbar (`src/App.tsx`) and settings page (`src/pages/PlanningPages.tsx`) strictly halts audio execution (`if (this.muted) return;`).
4. Verify audio debouncing (120ms throttle), concurrency limit (max 3 voices), dynamic compression, and headless Node/Vitest test safety.
5. Run the build and test suites:
   - `node ./node_modules/typescript/bin/tsc --noEmit`
   - `node ./node_modules/vite/bin/vite.js build`
   - `node ./node_modules/vitest/vitest.mjs run`
   - `node --test tests/*.test.mjs`
   - `node tests/e2e/run-all.mjs`
6. Output a verdict: `APPROVE` or `REQUEST_CHANGES` with clear evidence in `handoff.md` and send a message when done.

## 2026-10-10T04:03:52Z
[Message] timestamp=2026-10-10T04:03:52Z sender=70aacd32-1475-457c-a20e-3878c97d92ae priority=MESSAGE_PRIORITY_HIGH content=You are reviewer_2.
Your working directory is: e:\Visual Studio Code\tala\.agents\teamwork\reviewer_2
Project root: e:\Visual Studio Code\tala

MANDATORY: Read ORIGINAL_REQUEST.md:
e:\Visual Studio Code\tala\.agents\teamwork\ORIGINAL_REQUEST.md (request dated 2026-10-10T03:02:29Z).

Also read:
e:\Visual Studio Code\tala\.agents\teamwork\reviewer_2\DISPATCH.md
e:\Visual Studio Code\tala\.agents\teamwork\orchestrator_2\SCOPE.md
e:\Visual Studio Code\tala\.agents\teamwork\worker_m8\handoff.md

Tasks:
1. Review audio architecture, sound cues, accessibility, and mute controls across `src/ui/soundManager.ts`, `src/ui/soundSynthesizer.ts`, `src/hooks/useSound.ts`, `public/sounds/`, `src/hooks/useReducedMotion.ts`.
2. Verify sound cues are wired across user mutations in ledger, planning, investment, and data pages.
3. Verify global mute controls in topbar and settings strictly halt audio execution.
4. Verify debounce (120ms), concurrency limiter (max 3 voices), dynamic compressor, and headless test safety.
5. Run build and tests:
   `node ./node_modules/typescript/bin/tsc --noEmit`
   `node ./node_modules/vite/bin/vite.js build`
   `node ./node_modules/vitest/vitest.mjs run`
6. Output verdict APPROVE or REQUEST_CHANGES in handoff.md and send message when done.
