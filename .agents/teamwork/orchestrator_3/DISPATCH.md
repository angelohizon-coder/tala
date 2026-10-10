## 2026-10-10T05:02:33Z

You are the Project Orchestrator for the Tala codebase overhaul.
Working directory for this project: e:/Visual Studio Code/tala
Your dedicated agent metadata working directory: e:/Visual Studio Code/tala/.agents/teamwork/orchestrator_3

Authoritative User Request:
Refer to e:/Visual Studio Code/tala/.agents/teamwork/ORIGINAL_REQUEST.md (under section 2026-10-10T05:00:46Z).

Objective:
Perform a full codebase overhaul of the Tala personal finance app (a React/TypeScript SPA deployed on GitHub Pages, using Firebase for auth and Firestore sync) by removing dead code, legacy modules, redundant tooling, and infrastructure artifacts that do not belong in a Firebase + GitHub Pages deployment.
Integrity mode: development.

Key Requirements:
1. What to Keep:
- `src/` — all application source code (App.tsx, pages, hooks, db, sync, ui, workers, market, core, components)
- `functions/` — Firebase Cloud Functions (market data gateway)
- `public/` — static assets (icons, sounds, models)
- `tests/` — Vitest unit + integration tests (*.test.ts) and the browser journey test (tools/finance-browser-check.mjs)
- `.github/workflows/pages.yml` — the GitHub Actions deployment pipeline
- `firebase.json`, `firestore.indexes.json`, `firestore.rules` (if it exists) — Firebase config
- `vite.config.ts`, `tailwind.config.js`, `postcss.config.js`, `tsconfig.json`, `package.json`

2. R1. Remove Legacy Market Dashboard (the `site/` directory):
- Remove `site/` entirely.
- Remove `preserve-market-module` plugin block from `vite.config.ts`.
- Remove scripts, tools, or tests that exist exclusively to serve or test this legacy module (e.g. `tools/serve.mjs`, `tools/check.mjs`, `tools/browser-check.mjs`, `tests/client.test.mjs`, `tests/data.test.mjs`, `tests/worker.test.mjs`).
- Remove `"market:dev"` and `"test:market:browser"` npm scripts.

3. R2. Remove Cloudflare Worker Infrastructure:
- Remove `worker/` directory entirely (`worker/index.mjs`, `worker/wrangler.toml`, `worker/README.md`).

4. R3. Remove `.agents/` Teamwork Scaffolding:
- Note: Keep active orchestration metadata for the current running agents in `.agents/teamwork/` during execution if needed, but per R3, clean up legacy `.agents/` files from previous runs, or ensure repository cleanliness at completion. Be mindful of git tracking.

5. R4. Remove `artifacts/` Directory from Git:
- Remove `artifacts/` directory.
- Add `artifacts/` to `.gitignore`. Retain `artifacts/` in `.gitignore`.

6. R5. Remove Debug Workflow and Debug Log Files:
- Remove `.github/workflows/debug.yml` entirely.
- Delete committed `debug*.txt` files (`debug.txt`, `debug_test.txt`, `debug_build.txt`, `debug_browser.txt`).
- Remove temporary/scratch files at repo root (e.g. root-level `ORIGINAL_REQUEST.md`, `fix.ps1`, `fix2.ps1`, any `.md` files that are agent-generated planning docs at the repo root — keeping `README.md`).

7. R6. Remove Redundant Market Tools and Tests:
- Remove: `tools/free-market.mjs`, `tools/free-pse.mjs`, `tools/free-global.mjs`, `tools/free-global-mirror.mjs`, `tools/probe-free-source.mjs`, `tools/generate-icons.mjs`.
- Remove corresponding tests: `tests/free-market.test.mjs`, `tests/free-pse.test.mjs`, `tests/free-global.test.mjs`, `tests/free-global-mirror.test.mjs`, `tests/local-gateway.test.mjs`, `tests/acceptance/` directory, `tests/e2e/` directory.
- Remove `"check:source"` npm script.
- Update `package.json` to remove `"test:market"` script if no remaining `.mjs` test files exist (or point only to remaining ones).

8. R7. Remove Unused devDependencies:
- Audit `package.json` devDependencies. Specifically check `axios`, `class-variance-authority`, `tailwind-merge`, `clsx`. If unused in remaining `.tsx`/`.ts` frontend code, remove them.
- Do NOT remove `firebase-admin` or `firebase-functions` (needed for `functions/` typecheck during root `tsc`). Keep all other genuinely used dependencies.

9. R8. Clean Up `vite.config.ts`:
- Simplify `vite.config.ts`. Remove `preserve-market-module` plugin block completely.
- Drop `/legacy-market/` from `workbox` `navigateFallbackDenylist`.

10. R9. Fix `debug.yml` Removal Impact on `pages.yml`:
- Verify `pages.yml` is self-contained.
- Verify `npm test` and `npm run build` pass, and `npm run test:browser` works.
- Update CI pipeline if test/script references changed.

Acceptance Criteria to verify:
- Codebase cleanliness (no `site/`, no `worker/`, `artifacts/` in `.gitignore`, no `debug.yml`, no `debug*.txt`, clean root).
- Build integrity: `npm run build` (`tsc --noEmit && vite build`) succeeds without type errors.
- Vitest: `npm test` passes with zero regressions on remaining tests.
- CI pipeline integrity: `pages.yml` clean and tests pass.
- Typecheck: `npm run typecheck` (`tsc --noEmit`) passes with zero errors. No broken imports.
