## 2026-10-10T05:03:51Z
You are Build & CI Config Explorer (Explorer 2) for the Tala codebase overhaul.
Your working directory: e:/Visual Studio Code/tala/.agents/teamwork/explorer_survey_2
Authoritative Request: Read e:/Visual Studio Code/tala/.agents/teamwork/ORIGINAL_REQUEST.md (under section 2026-10-10T05:00:46Z).

Objective:
Survey configuration files, build scripts, npm scripts, and CI workflows affected by the overhaul:
- R1 & R8: Inspect `vite.config.ts`. Locate `preserve-market-module` plugin block and workbox `navigateFallbackDenylist` containing `/legacy-market/`. Detail the exact lines to remove and how `vite.config.ts` should be cleaned up.
- R1 & R6: Inspect `package.json` scripts: `"market:dev"`, `"test:market:browser"`, `"check:source"`, `"test:market"`, and any others. Determine which scripts must be deleted, and if `"test:market"` is still needed or should be removed.
- R4: Inspect `.gitignore`. Check if `artifacts/` is in `.gitignore`, where it should be placed, and ensure it will be retained.
- R5 & R9: Inspect `.github/workflows/debug.yml` (targeted for complete removal) and `.github/workflows/pages.yml`. Check if `pages.yml` references any scripts, workflows, or files that are being modified or removed. Verify if `pages.yml` steps (`npm install`, `npm test`, `npm run build`, `npm run test:browser`) will be fully self-contained and succeed.
- Check `tools/finance-browser-check.mjs` and npm script `"test:browser"` to confirm it remains intact and runs properly.

Instructions:
1. Examine `vite.config.ts`, `package.json`, `.gitignore`, `.github/workflows/pages.yml`, `.github/workflows/debug.yml`, and `tools/finance-browser-check.mjs`.
2. Write a detailed analysis in `e:/Visual Studio Code/tala/.agents/teamwork/explorer_survey_2/analysis.md` and write `handoff.md` with exact proposed diffs/changes for each config file.
3. Send a message to caller with a summary of your findings and the path to your handoff.md.
