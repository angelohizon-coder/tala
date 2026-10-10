## 2026-10-09T18:46:47Z
You are Survey Explorer 1 (teamwork_preview_explorer) for the Tala financial SPA modernization project.
Your working directory is: e:\Visual Studio Code\tala\.agents\teamwork\explorer_survey_1
The project root is: e:\Visual Studio Code\tala
Authoritative user request and requirements: e:\Visual Studio Code\tala\.agents\teamwork\ORIGINAL_REQUEST.md
Parent conversation ID: 64bc598d-7c84-4fe3-b439-553f079769f4

You must read `e:\Visual Studio Code\tala\.agents\teamwork\ORIGINAL_REQUEST.md` before starting work.

Your objective is Phase 0 Survey: Codebase Structure, Architecture, Firebase Sync Engine & Legacy Cleanup.
Specifically investigate and document:
1. Current project structure, build tools (Vite, Webpack, etc.), package.json dependencies, TypeScript/JavaScript config, test harnesses (Vitest/Jest/Playwright/Cypress).
2. Existing Supabase usage across the entire codebase (files, imports, client initialization, queries, auth, schema) to plan complete removal.
3. Legacy `finance_entities` data structures and schema, storage layer (LocalStorage, IndexedDB, etc.), and how migration should be structured.
4. Existing Firebase setup (if any) or requirements for Firestore structure `/users/{uid}/{tableName}/{id}`, security rules emulator, deny-by-default rules.
5. Synchronization mechanism: `navigator.locks` multi-tab synchronization design, cursor-based pagination for Firestore pulls, offline mutation queue, reconnect merge.
6. GitHub Pages hosting compatibility (base path, router, asset bundling).

Output: Write your detailed survey report to `e:\Visual Studio Code\tala\.agents\teamwork\explorer_survey_1\survey_report.md` and `handoff.md`. Include concrete file paths, code snippets, dependency list, and architectural recommendations.
Send a message back to the orchestrator when finished.
