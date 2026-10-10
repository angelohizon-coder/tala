# Dispatch: Worker Fix — Backdrop Reduced Motion & Dialog Timer Cleanup
Working directory: e:\Visual Studio Code\tala\.agents\teamwork\worker_fix
Project root: e:\Visual Studio Code\tala

## Mandatory Documents
1. User Request: `e:\Visual Studio Code\tala\.agents\teamwork\ORIGINAL_REQUEST.md` (request dated 2026-10-10T03:02:29Z)
2. Scope Document: `e:\Visual Studio Code\tala\.agents\teamwork\orchestrator_2\SCOPE.md`
3. Fix Explorer Reports:
   - `e:\Visual Studio Code\tala\.agents\teamwork\explorer_fix_1\handoff.md` (Exact CSS replacements)
   - `e:\Visual Studio Code\tala\.agents\teamwork\explorer_fix_2\handoff.md` (Exact Dialog timeout cleanup)
   - `e:\Visual Studio Code\tala\.agents\teamwork\explorer_fix_3\handoff.md` (Exact test assertion updates)

## Mandatory Integrity Warning
> DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

## Objective & Tasks
Apply the pinpointed fixes to `src/styles.css`, `src/ui/shared.tsx`, and `tests/challenger-motion-stress.test.ts`:

### 1. `src/styles.css`
Apply exact replacement chunks from `explorer_fix_1/handoff.md` (Section 4):
- Replace line 12 with:
```css
@media(prefers-reduced-motion:reduce){*,*::before,*::after,::backdrop,.dialog::backdrop,.dialog.dialog-closing::backdrop{transition:none!important;animation:none!important;scroll-behavior:auto!important}.page-transition,.dialog,.dialog.dialog-closing,.dialog::backdrop,.dialog.dialog-closing::backdrop,::backdrop,.chart-container{animation:none!important;transform:none!important;transition:none!important}}
```
- Replace lines 62–76 with:
```css
html[data-reduced-motion="true"] *,
html[data-reduced-motion="true"] *::before,
html[data-reduced-motion="true"] *::after,
html[data-reduced-motion="true"] ::backdrop,
html[data-reduced-motion="true"] .dialog::backdrop,
html[data-reduced-motion="true"] .dialog.dialog-closing::backdrop {
  transition: none !important;
  animation: none !important;
  scroll-behavior: auto !important;
}

html[data-reduced-motion="true"] .page-transition,
html[data-reduced-motion="true"] .dialog,
html[data-reduced-motion="true"] .dialog.dialog-closing,
html[data-reduced-motion="true"] .dialog::backdrop,
html[data-reduced-motion="true"] .dialog.dialog-closing::backdrop,
html[data-reduced-motion="true"] ::backdrop,
html[data-reduced-motion="true"] .chart-container {
  animation: none !important;
  transform: none !important;
  transition: none !important;
}
```

### 2. `src/ui/shared.tsx`
Apply defensive `closeTimerRef` and `clearTimeout` in unmount cleanup per `explorer_fix_2/handoff.md` (Section 4).

### 3. `tests/challenger-motion-stress.test.ts`
Update lines 50–68 to assert `toBe(true)` per `explorer_fix_1/handoff.md` and `explorer_fix_3/handoff.md`.

### 4. Build, Typecheck & Verification Runs
Run:
1. `node ./node_modules/typescript/bin/tsc --noEmit`
2. `node ./node_modules/vite/bin/vite.js build`
3. `node ./node_modules/vitest/vitest.mjs run`
4. `node --test tests/*.test.mjs`
5. `node tests/e2e/run-all.mjs`

Verify that all test suites pass with 100% success and 0 errors. Document all verification outputs in `handoff.md` and send a message when done.


## 2026-10-10T04:19:08Z
You are worker_fix.
Your working directory is: e:\Visual Studio Code\tala\.agents\teamwork\worker_fix
Project root: e:\Visual Studio Code\tala

MANDATORY: Read ORIGINAL_REQUEST.md:
e:\Visual Studio Code\tala\.agents\teamwork\ORIGINAL_REQUEST.md (request dated 2026-10-10T03:02:29Z).

Also read your dispatch task and fix specifications:
- e:\Visual Studio Code\tala\.agents\teamwork\worker_fix\DISPATCH.md
- e:\Visual Studio Code\tala\.agents\teamwork\explorer_fix_1\handoff.md
- e:\Visual Studio Code\tala\.agents\teamwork\explorer_fix_2\handoff.md
- e:\Visual Studio Code\tala\.agents\teamwork\explorer_fix_3\handoff.md

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Your Tasks:
1. Update `src/styles.css` with the exact replacement chunks in `explorer_fix_1/handoff.md` Section 4 to suppress `.dialog::backdrop`, `.dialog.dialog-closing::backdrop`, and `::backdrop` animations under reduced motion.
2. Update `src/ui/shared.tsx` with defensive `closeTimerRef` and `clearTimeout` in unmount cleanup per `explorer_fix_2/handoff.md` Section 4.
3. Update `tests/challenger-motion-stress.test.ts` lines 50–68 to assert `toBe(true)` per `explorer_fix_1` and `explorer_fix_3`.
4. Run full verification:
   - `node ./node_modules/typescript/bin/tsc --noEmit`
   - `node ./node_modules/vite/bin/vite.js build`
   - `node ./node_modules/vitest/vitest.mjs run`
   - `node --test tests/*.test.mjs`
   - `node tests/e2e/run-all.mjs`
5. Ensure 100% test pass rate with 0 errors and zero regressions.
6. Write handoff report in `handoff.md` and send message when done.
