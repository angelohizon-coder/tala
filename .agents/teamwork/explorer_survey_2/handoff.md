# Handoff Report: Sound Cues Architecture & Interaction Points Survey

**Agent**: Survey Explorer 2 (`explorer_survey_2`)  
**Parent Conversation ID**: `70aacd32-1475-457c-a20e-3878c97d92ae`  
**Working Directory**: `e:\Visual Studio Code\tala\.agents\teamwork\explorer_survey_2`  
**Project Root**: `e:\Visual Studio Code\tala`  
**Date**: 2026-10-10  
**Milestone**: UI Overhaul — UI Animations & Sound Cues  

---

## 1. Observation

### 1.1 Existing Codebase & Audio Absence
- Pattern search for audio/sound references across `src/` (`grep_search` query: `sound`) returned **0 matches**.
- File search for audio assets (`find_by_name` pattern: `*audio*`) returned only icon definitions from `node_modules/lucide-react` (e.g. `audio-lines.mjs`, `audio-waveform.mjs`). No audio assets currently exist in `public/` or `src/`.
- `package.json` dependencies:
  - Runtime: `dexie: ^4.4.6`, `dexie-react-hooks: ^4.4.0`, `firebase: ^11.0.0`, `lucide-react: ^1.54.0`, `react: ^19.3.0`, `react-dom: ^19.3.0`, `react-router-dom: ^7.18.4`, `recharts: ^3.10.1`.
  - No external sound libraries (e.g. `howler`, `use-sound`, `tone`) are installed.
- `package.json` devDependencies:
  - Vitest v5.0.3 (`"test": "vitest run --config vitest.config.ts"`).
  - `vitest.config.ts` defines `{ test: { include: ['tests/*.test.ts'], testTimeout: 30000 } }`, running by default under a Node.js runtime environment where `window`, `AudioContext`, `HTMLAudioElement`, and `Audio` are undefined.

### 1.2 User Interaction Points & Mutation Flow
Direct inspection of page and component files revealed key state mutation and validation points:

1. **Transaction Lifecycle (`src/pages/LedgerPages.tsx`)**:
   - `TransactionForm` (`src/pages/LedgerPages.tsx:171-228`):
     - Line 212: `if (recurringSave) await recurringSave(entry); else { await financeRepository.saveTransaction(entry); ... }` — successful creation/edit of transaction.
     - Line 214: `catch (failure) { setError(errorText(failure)); }` — validation failure (empty account, non-positive amount, invalid trade units).
     - Line 232: `DeleteTransaction`: `await financeRepository.deleteTransaction(transaction.id); onClose();` — transaction removal.
2. **Account Management (`src/pages/LedgerPages.tsx`)**:
   - `AccountForm` (`src/pages/LedgerPages.tsx:61-107`):
     - Line 88: `await financeRepository.save('accounts', { ...account, ... }); onClose();` — account saved.
     - Line 90: `catch (failure) { setError(errorText(failure)); }` — validation failure (missing name, invalid opening balance).
   - `AccountsPage` (`src/pages/LedgerPages.tsx:118`):
     - Line 118: `archive(account)`: `await financeRepository.save('accounts', { ...account, archived: !account.archived });` — account archived/restored.
3. **Budgets & Recurring Rules (`src/pages/LedgerPages.tsx`)**:
   - `BudgetForm` (`src/pages/LedgerPages.tsx:271-290`):
     - Line 279: `await financeRepository.save('budgets', { ... }); onClose();` — budget created/updated.
     - Line 384: `BudgetsPage`: `await financeRepository.remove('budgets', removing.id);` — budget removed.
   - `RecurringForm` (`src/pages/LedgerPages.tsx:292-332`):
     - Line 312: `await financeRepository.save('recurringRules', { ... }); onClose();` — recurring rule saved.
     - Line 348: `RecurringSection`: `await financeRepository.confirmRecurring(confirming.id, confirming.nextDate);` — occurrence recorded.
     - Line 349: `RecurringSection`: `await financeRepository.remove('recurringRules', removing.id);` — rule removed.
4. **Debt Terms (`src/pages/LedgerPages.tsx`)**:
   - `DebtTermsForm` (`src/pages/LedgerPages.tsx:388-417`):
     - Line 401: `await financeRepository.save('liabilityTerms', { ... }); onClose();` — debt terms saved.
5. **Investments & Market Quotes (`src/pages/InvestmentPages.tsx`)**:
   - `InstrumentForm` (`src/pages/InvestmentPages.tsx:25`): `await financeRepository.save('instruments', instrument); onClose();` — investment holding saved.
   - `TradeForm` (`src/pages/InvestmentPages.tsx:28`): `await financeRepository.saveTransaction(...); onClose();` — trade recorded.
   - `PriceForm` (`src/pages/InvestmentPages.tsx:42, 51`): `save valuation` and `importNav()` — manual NAV/prices saved.
   - `InvestmentsPage` (`src/pages/InvestmentPages.tsx:20`): `refresh(instrument)`: `await refreshInstrumentPrice(instrument);` — live quote fetch success or error catch (`priceRefreshErrors`).
   - `MarketsPage` (`src/pages/InvestmentPages.tsx:89-100`): `saveInstrument(quote)`: instrument added from catalog search.
6. **Data, Imports & Cloud Sync (`src/pages/DataPage.tsx`)**:
   - `saveBackup` (`src/pages/DataPage.tsx:25`): Full JSON backup generated and downloaded.
   - `restore` (`src/pages/DataPage.tsx:27`): Full local database restored from backup.
   - `loadCsv` & `previewCsv` (`src/pages/DataPage.tsx:28-29`): Statement parsing & on-device ML categorization preview.
   - `importStatement` (`src/pages/DataPage.tsx:34`): `const result = await financeRepository.importStatement(preview, { skipDuplicates });` — batch statement rows imported.
   - `enableCloud` (`src/pages/DataPage.tsx:30`): Cloud sync enabled.
   - `syncNow` (`src/pages/DataPage.tsx:36`): Remote sync triggered (`await syncNow()`).
   - `resolveConflict` (`src/pages/DataPage.tsx:36`): Manual merge conflict resolved.
7. **FIRE Journey & Milestones (`src/pages/PlanningPages.tsx`)**:
   - `saveSettings` (`src/pages/PlanningPages.tsx:82`): FIRE plan parameters saved.
   - `saveGoal` (`src/pages/PlanningPages.tsx:83`): Milestone goal added/updated.
   - `deleteGoal` (`src/pages/PlanningPages.tsx:86`): `await financeRepository.remove('goals', goal.id);` — goal deleted.
8. **Settings & Preferences (`src/pages/PlanningPages.tsx`)**:
   - `SettingsPage` (`src/pages/PlanningPages.tsx:257-262`):
     - Line 258: `saveCategory` (`financeRepository.save('categories', ...)`).
     - Line 259: `saveFx` (`financeRepository.save('fxRates', ...)`).
     - Line 260: `refreshFx` (`refreshFx(settings.baseCurrency)`).
     - Line 260: Base currency changed, savings calculation rules updated.
     - Line 260: `marketGateway` saved.
     - Line 260: `mergeCategories` completed.
9. **Modal Dialog Lifecycles (`src/ui/shared.tsx`)**:
   - `Dialog` (`src/ui/shared.tsx:10`):
     - Mounting: `element?.showModal();` (dialog open).
     - Unmounting / Cancel / Close: `onClose()` (dialog close).

### 1.3 Settings Persistence Architecture
- `src/db/database.ts:48`: `settings: '${common}, &key'`. Table `settings` in Dexie stores key-value pairs with `{ id: key, key: string, value: unknown }`.
- `src/db/repository.ts:249-250`:
  - `async function getSetting<T>(key: string, fallback?: T): Promise<T | undefined>`
  - `async function setSetting<T>(key: string, value: T) { return save('settings', { id: key, key, value }); }`
- Used across the application for preferences:
  - `financeRepository.getSetting('privacyMode', 'LOCAL_ONLY')`
  - `financeRepository.getSetting('persistenceRequested', false)`
  - `financeRepository.getSetting('marketGateway', '')`
  - `financeRepository.getSetting('ledger:recent-entry', {})`
  - `financeRepository.getSetting('priceRefreshErrors', {})`

---

## 2. Logic Chain

1. **Premise 1 (Interaction Consistency)**: Sound cues in finance applications must provide confirmation and confidence without inducing cognitive fatigue or acoustic distraction. Mapping sound cues to 5 coherent semantic cues (`success`, `error`, `delete`, `dialog_open`, `dialog_close`) covers 100% of user interactions while preserving acoustic cohesion.
2. **Premise 2 (Zero-Network & Offline Reliability)**:
   - Tala is strictly an offline-first application (Requirement R1: *"Local-only mode produces zero outbound network requests"*).
   - Audio assets stored in `public/sounds/` are automatically cached by Vite PWA's Service Worker for offline availability.
   - However, network latency, cache misses, or missing assets should never break audio feedback. Therefore, implementing a procedural Web Audio API synthesizer (`OscillatorNode` + `GainNode` with ADSR envelope) provides an indestructible zero-byte fallback that generates crystal-clear audio even if external audio files fail to load.
3. **Premise 3 (Browser Autoplay Policy & Concurrency Control)**:
   - Modern browsers block unprompted audio execution with `NotAllowedError` unless preceded by a user gesture.
   - An `AudioContext` singleton initialized lazily and unlocked on the first user interaction (`pointerdown`, `keydown`) safely resolves autoplay constraints.
   - Rapid UI actions (e.g. rapid clicking or multi-statement processing) can cause overlapping playback and acoustic clipping. Introducing a debounce throttle (120ms between identical sound cues), an active voice limiter (max 3 concurrent voices), and a master `DynamicsCompressorNode` eliminates clipping and harshness.
4. **Premise 4 (Mute State Synchronization)**:
   - Requirement R3 mandates: *"Implement a global settings toggle allowing users to mute all sound cues."*
   - Reading mute state asynchronously from Dexie on startup causes a flash of unmuted state during early user interactions.
   - By combining synchronous `localStorage` caching (`'tala:sound-muted'`) with Dexie `settings` table persistence (`'soundMuted'`), the application achieves immediate synchronous mute enforcement on initial render, full reactive subscription via `useLiveQuery`, and backup persistence.
5. **Premise 5 (Node/Vitest Test Environment Safety)**:
   - Because `vitest` runs in a Node environment where `window` and `AudioContext` are undefined, the sound service must perform safe feature detection (`typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext)`) and silently no-op when executed in unit test suites, preventing regressions in `npm test`.

---

## 3. Caveats

1. **No External Sound Dependencies**: Installing third-party packages like `howler` or `use-sound` is unnecessary and introduces bundle weight, security dependencies, and potential React 19 compatibility hurdles. Native HTML5 `Audio` plus Web Audio API provides superior performance with 0 extra dependencies.
2. **User Gesture Constraints on First Interaction**: If a user's very first action is non-interactive (e.g. background sync completion immediately on page load), the browser will prevent audio playback. The sound service must gracefully catch and silence `NotAllowedError` rejections without console errors.
3. **Volume Levels & Accessibility**: Sound cues must be subtle and pleasant, with a master volume default around -15dB to -18dB (0.25 to 0.35 scalar) so they do not startle users or clash with screen readers (`aria-live` announcer).

---

## 4. Conclusion & Proposed Architecture

### 4.1 Semantic Sound Cue Palette
We define 5 core semantic sound cues for Tala:

| Cue Name | Acoustic Characteristics | Primary Triggers in Tala |
| :--- | :--- | :--- |
| **`success`** | Warm, ascending dual-tone chime (e.g. C5 $\to$ G5, 220ms, soft sine/triangle wave) | Transaction saved, account added/edited, budget created, recurring occurrence confirmed, statement imported, sync completed, FIRE plan saved, backup restored |
| **`error`** | Gentle low double-tap (e.g. Eb4 $\to$ C4, 200ms, non-abrasive soft thud) | Form validation failure, sync failure, price refresh failure, invalid CSV/JSON file |
| **`delete`** | Soft descending tone or muted wooden click (e.g. G4 $\to$ D4, 180ms) | Delete transaction, remove budget, delete recurring rule, delete goal, archive account |
| **`dialog_open`** | Subtle airy swell (120ms, very low volume -18dB) | Modal dialog mounted / `showModal()` triggered |
| **`dialog_close`**| Soft quiet latch (80ms, very low volume -20dB) | Modal dialog dismissed / `onClose()` triggered |

### 4.2 Asset Integration Strategy
1. **Public Audio Files (`public/sounds/`)**:
   - `public/sounds/success.mp3` (~4 KB)
   - `public/sounds/error.mp3` (~3 KB)
   - `public/sounds/delete.mp3` (~3 KB)
   - `public/sounds/dialog-open.mp3` (~2 KB)
   - `public/sounds/dialog-close.mp3` (~2 KB)
   - Total payload: **< 15 KB**, formatted in MP3 (universal browser compatibility).
2. **Procedural Web Audio API Fallback (`src/services/soundSynthesizer.ts`)**:
   - Generates pure mathematical sine/triangle audio via Web Audio API if audio files are unavailable or disabled.
   - Guaranteed 100% offline and zero network request footprint.

### 4.3 Sound Service Architecture (`src/services/soundService.ts`)
A clean TypeScript singleton service:
- **Audio Context & Master Limiter**:
  - Lazily initializes `AudioContext`.
  - Connects to `DynamicsCompressorNode` $\to$ `GainNode` (Master Volume: 0.3) $\to$ `destination`.
- **Autoplay Handling**:
  - Automatically hooks `['click', 'keydown', 'touchstart']` to call `audioContext.resume()` on the first interaction.
- **Concurrency & Debouncing**:
  - Per-cue throttle: drops calls to the identical cue if triggered within 120ms.
  - Max voice limit: caps simultaneous voices at 3 to prevent acoustic clutter.
- **Mute Enforcement**:
  - Instant synchronous guard: `if (this.isMuted) return;`

### 4.4 React Hook (`src/hooks/useSound.ts`)
```ts
export function useSound() {
  const muted = useLiveQuery(() => financeRepository.getSetting('soundMuted', false), []);
  return {
    play: (cue: SoundCue) => soundService.play(cue),
    playSuccess: () => soundService.play('success'),
    playError: () => soundService.play('error'),
    playDelete: () => soundService.play('delete'),
    playDialogOpen: () => soundService.play('dialog_open'),
    playDialogClose: () => soundService.play('dialog_close'),
    isMuted: Boolean(muted),
    setMuted: (val: boolean) => soundService.setMuted(val),
  };
}
```

### 4.5 Mute State Storage & Global Toggle Placement
1. **Dual Storage**:
   - Synchronous read/write in `localStorage` (`'tala:sound-muted'`).
   - Canonical persistence in Dexie `settings` table (`'soundMuted'`).
2. **UI Placement**:
   - **Top Bar (`src/App.tsx:topbar-actions`)**: Accessible icon button (`Volume2` / `VolumeX`) with `aria-label="Mute all sound cues"` and `aria-pressed`.
   - **Settings Page (`src/pages/PlanningPages.tsx:SettingsPage`)**: Dedicated "Audio & Accessibility" section with a master toggle switch and sound test button.

---

## 5. Verification Method

To independently verify these architectural findings and validate the sound cues implementation:

1. **Verify No Codebase Regressions**:
   ```powershell
   $env:PATH = "C:\Program Files\nodejs;$env:PATH"; npm.cmd test
   ```
2. **Verify Sound Service Unit Tests**:
   - Create a test file `tests/sound-service.test.ts`:
     - Test that calling `soundService.play()` when `soundService.isMuted === true` produces zero audio calls.
     - Test that toggling mute persists to `localStorage` and Dexie settings.
     - Test that rapid successive `play('success')` calls within 120ms are throttled to a single execution.
     - Test that in a headless environment without `AudioContext`, calls execute safely without throwing exceptions.
3. **Verify Audio Asset & Fallback Behavior**:
   - Inspect `public/sounds/` assets with audio tools.
   - Disable network or mock audio asset load failure to confirm the procedural Web Audio synthesizer triggers seamless audio fallback.
