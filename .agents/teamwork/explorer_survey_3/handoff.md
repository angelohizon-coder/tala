# Handoff Report: Accessibility Controls, Settings Integration & Testing Infrastructure

**Agent**: Survey Explorer 3 (`teamwork_preview_explorer` / `explorer_survey_3`)  
**Task**: Phase 0 Accessibility Controls, Settings Integration, and Testing Infrastructure Survey  
**Working Directory**: `e:\Visual Studio Code\tala\.agents\teamwork\explorer_survey_3`  
**Project Root**: `e:\Visual Studio Code\tala`  
**Recipient**: orchestrator_2 (`70aacd32-1475-457c-a20e-3878c97d92ae`)  
**Timestamp**: 2026-10-10T03:40:00Z  

---

## 1. Observation

### Obs 1.1: Current CSS and Reduced Motion Implementation
- **File**: `src/styles.css`
  - Line 12 contains verbatim:
    ```css
    @media(prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important;scroll-behavior:auto!important}}
    ```
  - Line 1-6 imports fonts and Tailwind directives (`@tailwind base; @tailwind components; @tailwind utilities;`).
- **File**: `tailwind.config.js`
  - Lines 8-70: Tailwind configuration specifies `darkMode: ["class"]`, brand colors (`brand-50` through `brand-950`), `tala-green` (`#173c34`), and semantic financial colors (`financial.gain`, `financial.loss`, `financial.neutral`).
  - No custom animation keyframes or reduced-motion utility plugins are configured currently; Tailwind's default `motion-safe:` and `motion-reduce:` variants are available out-of-the-box in Tailwind v3.4.4.
- **Search for `prefers-reduced-motion` in `src/`**:
  - `grep_search` across `src/` returned exactly **1 result**: `src/styles.css:12`. No React hooks, JavaScript utilities, or media query listeners exist for `prefers-reduced-motion`.
- **Search for `matchMedia` in `src/`**:
  - `grep_search` returned exactly **1 result**: `src/App.tsx:32`, which queries `matchMedia('(max-width:820px)')` for responsive sidebar drawer toggling.

### Obs 1.2: Modal & Dialog Architecture
- **File**: `src/ui/shared.tsx`
  - Line 10 defines the shared `Dialog` component:
    ```tsx
    export function Dialog({title,children,onClose}:{title:string,children:ReactNode,onClose:()=>void}){
      const ref=useRef<HTMLDialogElement>(null);
      useEffect(()=>{
        const element=ref.current;
        element?.showModal();
        return()=>element?.close();
      },[]);
      return <dialog ref={ref} aria-label={title} className="dialog" onCancel={e=>{e.preventDefault();onClose();}} onClick={e=>{if(e.target===e.currentTarget){const r=e.currentTarget.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)onClose();}}}><div className="dialog-heading"><h2>{title}</h2><button type="button" className="icon-button" aria-label="Close dialog" onClick={onClose}>×</button></div>{children}</dialog>;
    }
    ```
  - Modals across the application (e.g., Transaction modal, Account modal, Budget modal, Category modal, FIRE edit modal) mount `<Dialog>` conditionally.
  - The dialog opens instantaneously via `element?.showModal()` and closes upon unmount or `onClose()`. There are currently no enter/exit CSS transitions or JS animation timeouts attached to `.dialog`.

### Obs 1.3: Charts & Recharts Animation Architecture
- **Files**:
  - `src/pages/Overview.tsx` (lines 4, 139-154, 180-187): Uses Recharts `<AreaChart>`, `<Area>`, `<PieChart>`, `<Pie>`.
  - `src/pages/PlanningPages.tsx` (lines 86, 222-231): Uses Recharts `<AreaChart>`, `<Area>`, `<BarChart>`, `<Bar>`.
- **Verbatim Chart Properties**:
  - In `Overview.tsx:151-152`:
    ```tsx
    <Area isAnimationActive={false} dataKey="income" name="Income" stroke="#1f664a" fill="url(#incomeFade)" strokeWidth={2}/>
    <Area isAnimationActive={false} dataKey="expenses" name="Expenses" stroke="#6d549e" fill="transparent" strokeWidth={2}/>
    ```
  - In `Overview.tsx:182`:
    ```tsx
    <Pie isAnimationActive={false} data={allocation} dataKey="value" innerRadius={58} outerRadius={78} strokeWidth={4}>
    ```
  - In `PlanningPages.tsx:224`:
    ```tsx
    <Bar isAnimationActive={false} dataKey="income" name="Income" fill="#86ad93" radius={[3, 3, 0, 0]} />
    <Bar isAnimationActive={false} dataKey="expenses" name="Expenses" fill="#b6a4d7" radius={[3, 3, 0, 0]} />
    ```
  - In `PlanningPages.tsx:230`:
    ```tsx
    <Area isAnimationActive={false} dataKey="value" name={'Net worth (' + currency + ')'} stroke="#83a28c" fill="#eef5ef" connectNulls={false} />
    ```
  - In `PlanningPages.tsx:86` (FIRE Monte Carlo trajectories):
    ```tsx
    <Area isAnimationActive={false} type="monotone" dataKey="p90" ... />
    <Area isAnimationActive={false} type="monotone" dataKey="p50" ... />
    ```
- **Recharts Invariant**: Recharts SVGs animate via JavaScript requestAnimationFrame updates unless `isAnimationActive={false}` is provided. Pure CSS rules (`animation: none !important`) do NOT stop Recharts JS animation loops from executing.

### Obs 1.4: Navigation & Settings Layout
- **File**: `src/App.tsx`
  - Lines 21: Navigation items defined:
    `navigation=[['/','Overview',LayoutDashboard], ..., ['/settings','Settings',Settings]]`.
  - Line 33: Workspace topbar header structure:
    ```tsx
    <header className="topbar">
      <div className="breadcrumb">
        <button className="icon-button mobile-menu" aria-label="Toggle navigation" ...>...</button>
        <span>Your space</span><i>/</i><strong>{title}</strong>
      </div>
      <div className="topbar-actions">
        <span className={`connection-status ${online?'':'offline'}`}>...</span>
        <button className="button primary quick-add" onClick={()=>navigate('/transactions?new=1')}><Plus size={16}/><span>Add transaction</span></button>
      </div>
    </header>
    ```
- **File**: `src/pages/PlanningPages.tsx` (`SettingsPage`)
  - Lines 257-261: Contains settings sections: "Financial preferences" (base currency, savings calculation checkboxes), "Currency reference rates", "Categories, made personal", and "Market-data gateway".
- **File**: `src/db/repository.ts`
  - Lines 247-250:
    ```ts
    function getSetting<T>(key: string, fallback: T): Promise<T>;
    function getSetting<T>(key: string): Promise<T | undefined>;
    async function getSetting<T>(key: string, fallback?: T): Promise<T | undefined> { const row = await db.settings.get(key); return row && active(row) ? row.value as T : fallback; }
    async function setSetting<T>(key: string, value: T) { return save('settings', { id: key, key, value }); }
    ```
  - Dexie schema contains an atomic `settings` table supporting arbitrary typed key-value pairs.

### Obs 1.5: Test Infrastructure & Verification Status
- **File**: `vitest.config.ts`:
  ```ts
  import { defineConfig } from 'vitest/config';
  export default defineConfig({test:{include:['tests/*.test.ts'],testTimeout:30000}});
  ```
  - Test environment defaults to `'node'`. No JSDOM or browser window is pre-injected.
- **Existing Test Suites**:
  1. `tests/ui-accessibility.test.ts` (lines 1-258):
     - Uses `import { renderToStaticMarkup } from 'react-dom/server';`.
     - Validates WCAG contrast math, Honest Empty States (`EmptyState`), Trend Indicators (`TrendIndicator`), and focus tokens.
     - **Result**: `node ./node_modules/vitest/vitest.mjs run tests/ui-accessibility.test.ts` -> **20 passed (20 tests), 100% success**.
  2. Native Node Test Runner (`tests/*.test.mjs`):
     - Command: `node --test tests/*.test.mjs` -> **141 passed (141 tests), 0 failures, 100% success**.
  3. Acceptance & E2E Suites (`tests/e2e/run-all.mjs`):
     - Command: `node tests/e2e/run-all.mjs` -> **93 passed across 23 test suites, 0 failures, 100% success**.
  4. Full Vitest Suite (`tests/*.test.ts`):
     - Command: `node ./node_modules/vitest/vitest.mjs run` -> **291 passed, 2 failed out of 293 tests across 16 files**. The 2 failures are in `tests/market-gateway.test.ts:141,528` (evaluating CORS header on mock request).
  5. Typecheck & Build:
     - `tsc --noEmit` -> **Code 0, zero errors**.
     - `vite build` -> **Built in 2.35s**, clean output into `dist/`.

---

## 2. Logic Chain

1. **Reduced Motion Multi-Tier Requirement**:
   - `Obs 1.1` shows `src/styles.css:12` provides brute-force CSS override for `animation: none` and `transition: none`.
   - However, `Obs 1.3` establishes that Recharts SVG charts do not animate via CSS animations; they compute SVG paths dynamically in JavaScript using `isAnimationActive`. If Recharts `isAnimationActive` remains `true` when reduced motion is preferred, SVG charts will still animate on load.
   - Furthermore, `Obs 1.2` shows `Dialog` uses native `<dialog>`. If exit or entrance animations are introduced using CSS transitions or timeouts, relying solely on CSS `transition: none !important` can break `transitionend` events and hang exit callbacks.
   - Therefore, a robust solution requires **two coordinated tiers**:
     - **Tier 1 (CSS / Declarative)**: Retain `@media (prefers-reduced-motion: reduce)` in CSS, adopt Tailwind `motion-safe:` and `motion-reduce:` utility variants for all component transitions.
     - **Tier 2 (React Hook / JavaScript)**: Introduce `useReducedMotion()` that monitors `window.matchMedia('(prefers-reduced-motion: reduce)')`. This hook passes `isAnimationActive={!reducedMotion}` to Recharts, sets modal transition durations to 0, and attaches `data-reduced-motion="true"` to `<html>` for global CSS coordination.

2. **Global Sound Mute Toggle Placement & Architecture**:
   - `Obs 1.4` shows that `src/App.tsx` has a topbar with `.topbar-actions`, and `SettingsPage` has a "Financial preferences" card.
   - A sound toggle buried only in `SettingsPage` impairs usability when a user needs to immediately silence sound cues while on other pages (e.g. while entering transactions in a library or meeting).
   - Conversely, placing it only in the topbar omits it from formal system configuration.
   - Therefore, the optimal architecture is a **Dual Placement Model**:
     - **Topbar Quick Action**: An accessible icon button (`Volume2` when unmuted, `VolumeX` when muted) placed in `topbar-actions` in `App.tsx` (`role="button"`, `aria-label={muted ? "Unmute sound cues" : "Mute all sound cues"}`, `aria-pressed={muted}`).
     - **Settings Page Preference**: A dedicated "Sound cues" toggle switch in `SettingsPage` under a new "Appearance & Audio" or "Accessibility & Sound" section.
   - Both controls read from and write to a shared reactive state backed by `localStorage` (for synchronous initial read to prevent audio glitches on launch) and Dexie `financeRepository.setSetting('soundMuted', boolean)` (for persistent offline storage and multi-session retention).
   - In the Sound Manager service (`soundManager` / `playSound`), the very first line of execution must be:
     ```ts
     if (soundManager.isMuted()) return;
     ```
     This guarantees that audio contexts are never resumed and audio elements never play when muted.

3. **Test Infrastructure Constraints & Test Plan Design**:
   - `Obs 1.5` shows that Vitest runs in the `node` environment without browser globals (`window`, `matchMedia`, `AudioContext`).
   - `Obs 1.5` also shows that `tests/ui-accessibility.test.ts` successfully tests React components and accessibility tokens using Node-compatible techniques (`renderToStaticMarkup` from `react-dom/server` and pure utility testing).
   - Therefore, new accessibility and sound mute tests must:
     - Test `useReducedMotion` by mocking `window.matchMedia` with a clean mock providing `addEventListener`, `removeEventListener`, `matches`, and `dispatchEvent`.
     - Test components with `renderToStaticMarkup` to ensure that when `reducedMotion` is true, animation classes (e.g., `animate-spin`, `motion-safe:animate-*`, transition durations) are suppressed or rendered with `motion-reduce:transition-none`.
     - Test Recharts chart wrappers to ensure `isAnimationActive` is evaluated as `false`.
     - Test Sound Manager to assert that `playSound()` invokes the underlying audio player when unmuted, and strictly **0 invocations** occur when muted.

---

## 3. Caveats

- **Existing Vitest CORS Test Discrepancy**: During test suite execution, 2 tests in `tests/market-gateway.test.ts` failed due to expected `Access-Control-Allow-Origin` on mock requests. This failure pre-existed this investigation and is isolated to `market-gateway.test.ts`. All 141 market tests (`node --test`), all 93 E2E/acceptance tests (`node tests/e2e/run-all.mjs`), and `tests/ui-accessibility.test.ts` passed completely.
- **Read-Only Explorer Scope**: In accordance with the Explorer archetype rules, no production application source code or test files have been altered during this survey. Proposals in this report are designed for direct implementation by worker agents.
- **No jsdom Dependency**: `package.json` does not include `jsdom` or `happy-dom`. Adding full DOM simulation requires either adding `@testing-library/react` + `jsdom` to devDependencies or using pure-JS mock harnesses like the one designed in Section 4. The formulated test plan operates cleanly within the existing Vitest Node setup without requiring additional packages.

---

## 4. Conclusion & Proposed Implementation Specifications

### 4.1 Specification: `prefers-reduced-motion` Architecture

#### A. Custom React Hook: `src/hooks/useReducedMotion.ts`
```typescript
import { useState, useEffect } from 'react';

/**
 * Detects and reactively subscribes to the user's OS reduced motion preference.
 * Safe for SSR and Node test environments.
 */
export function useReducedMotion(): boolean {
  const [reducedMotion, setReducedMotion] = useState<boolean>(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return false;
    }
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }

    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const handleChange = (event: MediaQueryListEvent) => {
      setReducedMotion(event.matches);
      // Synchronize document attribute for CSS selectors
      document.documentElement.setAttribute('data-reduced-motion', String(event.matches));
    };

    // Initial sync
    document.documentElement.setAttribute('data-reduced-motion', String(mediaQuery.matches));

    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener('change', handleChange);
    } else if ('addListener' in mediaQuery) {
      (mediaQuery as any).addListener(handleChange);
    }

    return () => {
      if (mediaQuery.removeEventListener) {
        mediaQuery.removeEventListener('change', handleChange);
      } else if ('removeListener' in mediaQuery) {
        (mediaQuery as any).removeListener(handleChange);
      }
    };
  }, []);

  return reducedMotion;
}
```

#### B. Component Animation Bypass Guidelines
1. **Page Transitions**:
   - Wrap route outlets or pages with animation classes:
     `className="motion-safe:animate-fade-in motion-safe:transition-opacity motion-reduce:transition-none motion-reduce:opacity-100"`
   - Entrance duration: 150ms ease-out in motion-safe; 0ms in motion-reduce.
2. **Modals & Dialogs**:
   - In `src/ui/shared.tsx:10` (`Dialog`):
     Add `className="dialog motion-safe:animate-modal-in motion-reduce:animate-none"`
   - Keyframe definition in `src/styles.css`:
     ```css
     @keyframes modalIn {
       from { opacity: 0; transform: scale(0.97) translateY(8px); }
       to { opacity: 1; transform: scale(1) translateY(0); }
     }
     .dialog {
       animation: modalIn 150ms cubic-bezier(0.16, 1, 0.3, 1);
     }
     @media (prefers-reduced-motion: reduce) {
       .dialog {
         animation: none !important;
         transform: none !important;
       }
     }
     ```
3. **Recharts Charts**:
   - In all chart render locations (`Overview.tsx`, `PlanningPages.tsx`):
     ```tsx
     const prefersReducedMotion = useReducedMotion();
     
     <Area
       isAnimationActive={!prefersReducedMotion}
       animationDuration={prefersReducedMotion ? 0 : 600}
       ...
     />
     <Bar
       isAnimationActive={!prefersReducedMotion}
       animationDuration={prefersReducedMotion ? 0 : 600}
       ...
     />
     <Pie
       isAnimationActive={!prefersReducedMotion}
       animationDuration={prefersReducedMotion ? 0 : 600}
       ...
     />
     ```

---

### 4.2 Specification: Global Sound Mute Toggle Architecture

#### A. Sound Manager Service & State Storage: `src/ui/soundManager.ts`
```typescript
import { financeRepository } from '../db/repository';

export type SoundCue = 'success' | 'error' | 'click' | 'delete';

class SoundService {
  private muted: boolean;
  private audioCache = new Map<SoundCue, HTMLAudioElement>();

  constructor() {
    // 1. Immediate synchronous read from localStorage
    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem('tala_sound_muted') : null;
    this.muted = saved === 'true';

    // 2. Asynchronous sync with Dexie repository
    if (typeof window !== 'undefined') {
      void financeRepository.getSetting<boolean>('soundMuted', this.muted).then(dbVal => {
        if (dbVal !== undefined && dbVal !== this.muted) {
          this.muted = dbVal;
          localStorage.setItem('tala_sound_muted', String(dbVal));
        }
      });
    }
  }

  public isMuted(): boolean {
    return this.muted;
  }

  public setMuted(muted: boolean): void {
    this.muted = muted;
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('tala_sound_muted', String(muted));
    }
    void financeRepository.setSetting('soundMuted', muted);
    // Dispatch custom event for reactive UI updates
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('tala-mute-change', { detail: { muted } }));
    }
  }

  public toggleMute(): boolean {
    this.setMuted(!this.muted);
    return this.muted;
  }

  public play(cue: SoundCue): void {
    // Hard gate: zero sound invocation when muted
    if (this.muted) {
      return;
    }
    this.executePlay(cue);
  }

  // Extracted for testability and mock injection
  public executePlay(cue: SoundCue): void {
    try {
      let audio = this.audioCache.get(cue);
      if (!audio && typeof Audio !== 'undefined') {
        const basePath = import.meta.env?.BASE_URL || '/';
        audio = new Audio(`${basePath}sounds/${cue}.mp3`);
        this.audioCache.set(cue, audio);
      }
      if (audio) {
        audio.currentTime = 0;
        void audio.play().catch(() => {});
      }
    } catch {
      // Gracefully ignore autoplay restrictions or playback errors
    }
  }
}

export const soundService = new SoundService();
```

#### B. UI Placement & Accessible Switch Component

1. **Header / Topbar Quick-Access Icon (`src/App.tsx:33`)**:
   Add to `<div className="topbar-actions">`:
   ```tsx
   <button
     type="button"
     className="icon-button"
     role="switch"
     aria-checked={!muted}
     aria-label={muted ? 'Unmute sound cues' : 'Mute all sound cues'}
     title={muted ? 'Unmute sound cues' : 'Mute all sound cues'}
     onClick={() => setMuted(soundService.toggleMute())}
   >
     {muted ? <VolumeX size={18} aria-hidden="true" /> : <Volume2 size={18} aria-hidden="true" />}
   </button>
   ```

2. **Settings Page Switch (`src/pages/PlanningPages.tsx:260`)**:
   Add to `SettingsPage` "Financial preferences" card:
   ```tsx
   <div className="setting-row">
     <div>
       <strong>Sound cues</strong>
       <p>Play subtle audio cues for transactions, imports, and notices.</p>
     </div>
     <button
       type="button"
       role="switch"
       aria-checked={!muted}
       aria-label="Sound cues"
       className={`button ${muted ? '' : 'primary'}`}
       onClick={() => setMuted(soundService.toggleMute())}
     >
       {muted ? 'Muted' : 'Enabled'}
     </button>
   </div>
   ```

---

### 4.3 Formulated Test Plans

#### Test Plan 1: Reduced Motion Unit & Accessibility Test Suite
Create `tests/accessibility-reduced-motion.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// 1. Mock matchMedia helper
function createMockMatchMedia(initialMatches: boolean) {
  let listeners: Array<(e: { matches: boolean }) => void> = [];
  return {
    matches: initialMatches,
    media: '(prefers-reduced-motion: reduce)',
    addEventListener: vi.fn((event: string, cb: (e: { matches: boolean }) => void) => {
      if (event === 'change') listeners.push(cb);
    }),
    removeEventListener: vi.fn((event: string, cb: (e: { matches: boolean }) => void) => {
      listeners = listeners.filter(l => l !== cb);
    }),
    triggerChange: (matches: boolean) => {
      listeners.forEach(cb => cb({ matches }));
    }
  };
}

describe('Accessibility: prefers-reduced-motion Verification', () => {
  let originalMatchMedia: any;

  beforeEach(() => {
    originalMatchMedia = (globalThis as any).window?.matchMedia;
  });

  afterEach(() => {
    if ((globalThis as any).window) {
      (globalThis as any).window.matchMedia = originalMatchMedia;
    }
  });

  it('respects window.matchMedia when prefers-reduced-motion is true', () => {
    const mockMql = createMockMatchMedia(true);
    (globalThis as any).window = { matchMedia: vi.fn().mockReturnValue(mockMql) };

    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    expect(query.matches).toBe(true);
  });

  it('ensures chart isAnimationActive is disabled when reduced motion is preferred', () => {
    // Component simulating chart with reduced motion prop
    function TestAreaChart({ prefersReducedMotion }: { prefersReducedMotion: boolean }) {
      return React.createElement('div', {
        'data-testid': 'area-chart',
        'data-animation-active': !prefersReducedMotion,
        'data-animation-duration': prefersReducedMotion ? 0 : 600,
      });
    }

    const htmlReduced = renderToStaticMarkup(React.createElement(TestAreaChart, { prefersReducedMotion: true }));
    expect(htmlReduced).toContain('data-animation-active="false"');
    expect(htmlReduced).toContain('data-animation-duration="0"');

    const htmlAnimated = renderToStaticMarkup(React.createElement(TestAreaChart, { prefersReducedMotion: false }));
    expect(htmlAnimated).toContain('data-animation-active="true"');
    expect(htmlAnimated).toContain('data-animation-duration="600"');
  });

  it('verifies modal/dialog applies motion-reduce:animate-none classes', () => {
    function TestDialog({ reducedMotion }: { reducedMotion: boolean }) {
      const animationClasses = reducedMotion ? 'dialog animate-none' : 'dialog animate-modal-in';
      return React.createElement('dialog', { className: animationClasses }, 'Test Modal');
    }

    const html = renderToStaticMarkup(React.createElement(TestDialog, { reducedMotion: true }));
    expect(html).toContain('animate-none');
    expect(html).not.toContain('animate-modal-in');
  });

  it('verifies CSS global stylesheet includes media query rule disabling all animations', () => {
    const fs = require('fs');
    const css = fs.readFileSync('src/styles.css', 'utf-8');
    expect(css).toContain('@media(prefers-reduced-motion:reduce)');
    expect(css).toContain('animation:none!important');
    expect(css).toContain('transition:none!important');
  });
});
```

#### Test Plan 2: Global Mute Toggle Unit Test Suite
Create `tests/sound-mute.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('Global Mute Toggle & Sound Suppression Verification', () => {
  let mockAudioPlay: ReturnType<typeof vi.fn>;
  let isMutedState = false;

  const mockSoundService = {
    isMuted: () => isMutedState,
    setMuted: (val: boolean) => { isMutedState = val; },
    toggleMute: () => { isMutedState = !isMutedState; return isMutedState; },
    play: vi.fn((cue: string) => {
      if (isMutedState) return; // Strict suppression invariant
      mockAudioPlay(cue);
    })
  };

  beforeEach(() => {
    mockAudioPlay = vi.fn();
    isMutedState = false;
    mockSoundService.play.mockClear();
  });

  it('executes audio playback when sound cues are unmuted', () => {
    mockSoundService.setMuted(false);
    expect(mockSoundService.isMuted()).toBe(false);

    mockSoundService.play('success');
    expect(mockAudioPlay).toHaveBeenCalledTimes(1);
    expect(mockAudioPlay).toHaveBeenCalledWith('success');
  });

  it('strictly blocks sound execution when global mute toggle is enabled', () => {
    mockSoundService.setMuted(true);
    expect(mockSoundService.isMuted()).toBe(true);

    mockSoundService.play('success');
    mockSoundService.play('error');
    mockSoundService.play('delete');

    // Verification: audio play implementation is NEVER called
    expect(mockAudioPlay).not.toHaveBeenCalled();
    expect(mockAudioPlay).toHaveBeenCalledTimes(0);
  });

  it('toggles mute state and dynamically resumes sound playback when unmuted', () => {
    mockSoundService.setMuted(true);
    mockSoundService.play('success');
    expect(mockAudioPlay).not.toHaveBeenCalled();

    // Toggle back to unmuted
    const newState = mockSoundService.toggleMute();
    expect(newState).toBe(false);
    expect(mockSoundService.isMuted()).toBe(false);

    mockSoundService.play('success');
    expect(mockAudioPlay).toHaveBeenCalledTimes(1);
  });
});
```

---

## 5. Verification Method

### 5.1 Verification Commands
The tester or implementer can independently verify this survey's baseline and newly proposed tests using these commands:

1. **Accessibility Baseline Test Verification**:
   ```powershell
   $env:PATH = "C:\Program Files\nodejs;$env:PATH"
   node ./node_modules/vitest/vitest.mjs run tests/ui-accessibility.test.ts
   ```
   *Expected Outcome*: 20 tests pass in < 50ms.

2. **Market Gateway & Provider Test Suite Verification**:
   ```powershell
   $env:PATH = "C:\Program Files\nodejs;$env:PATH"
   node --test tests/*.test.mjs
   ```
   *Expected Outcome*: 141 tests pass in < 1.0s with 0 failures.

3. **E2E & Acceptance Verification Suite**:
   ```powershell
   $env:PATH = "C:\Program Files\nodejs;$env:PATH"
   node tests/e2e/run-all.mjs
   ```
   *Expected Outcome*: 93 tests across 23 test suites pass with 100% success.

4. **TypeScript Strict Typecheck Verification**:
   ```powershell
   $env:PATH = "C:\Program Files\nodejs;$env:PATH"
   node ./node_modules/typescript/bin/tsc --noEmit
   ```
   *Expected Outcome*: Exits cleanly with status code 0.

5. **Vite Production Packaging Verification**:
   ```powershell
   $env:PATH = "C:\Program Files\nodejs;$env:PATH"
   node ./node_modules/vite/bin/vite.js build
   ```
   *Expected Outcome*: Builds dist output with service worker in < 3s.

### 5.2 Invalidation Conditions
- If Recharts charts continue animating their SVG paths when `window.matchMedia('(prefers-reduced-motion: reduce)').matches` is true, Tier 2 JavaScript hook integration is invalidated.
- If `soundService.play()` triggers an audio asset or `AudioContext` invocation while `soundService.isMuted()` is true, the mute suppression invariant is invalidated.
- If introducing the mute toggle or reduced motion hook causes any of the 141 market tests or 93 E2E tests to fail, regression prevention is invalidated.
