# Handoff Report — Explorer M2-2 (Markets View UI Resilience)

## 1. Observation

1. **Global Error Cascade on Single Quote Failure (`src/pages/InvestmentPages.tsx:68-71`)**:
   ```tsx
   68: await Promise.all(visible.slice(0,8).map(async record=>{
   69:   try{const quote=await marketProvider.latestPrice(record.symbol);if(current())setQuotes(previous=>({...previous,[record.symbol]:quote}));}
   70:   catch(e){if(current())setError((e as Error).message);}
   71: }));
   ```
   - In `loadCatalog`, `Promise.all` executes over `visible.slice(0, 8)`.
   - Any single rejected quote invokes `setError((e as Error).message)`.
   - Line 114 renders `<ErrorMessage message={error}/>`.
   - Line 78 in `src/ui/shared.tsx`:
     `export function ErrorMessage({message}:{message?:string}){return message?<p className="form-error" role="alert">{message}</p>:null;}`
   - `src/styles.css:7` styles `.form-error`:
     `.form-error{padding:12px;background:#fff0ed;color:#9c3832;border-radius:8px;font-size:11px;line-height:1.6;margin:15px 0}`
   - Result: A single failed ticker causes a top-level red error box to render, even when the other 7 tickers load valid prices.

2. **Selection Failure on Unquoted Ticker (`src/pages/InvestmentPages.tsx:85-89`)**:
   ```tsx
   85: async function select(record:MarketInstrument){
   86:   const version=++selectionVersion.current,catalog=catalogVersion.current;setError('');setSelected(null);setHistory([]);historyVersion.current++;
   87:   try{const quote=quotes[record.symbol]||await marketProvider.latestPrice(record.symbol);if(version!==selectionVersion.current||catalog!==catalogVersion.current)return;setQuotes(previous=>({...previous,[record.symbol]:quote}));setSelected(quote);}
   88:   catch(e){if(version===selectionVersion.current&&catalog===catalogVersion.current)setError((e as Error).message);}
   89: }
   ```
   - Clicking a row for an instrument without a cached quote calls `marketProvider.latestPrice(record.symbol)`.
   - If that throws, `catch` calls `setError`, while `selected` remains `null`.
   - The user sees no detail card, no explanation of why the quote failed, and only sees the global red error banner.

3. **Success Message Rendered as Red Error Banner (`src/pages/InvestmentPages.tsx:103`)**:
   ```tsx
   90: async function saveInstrument(quote:MarketQuote){
   ...
   102:   soundService.play('success');
   103:   if(catalog===catalogVersion.current)setError(`${quote.name} saved in Investments. Record a purchase to create a holding.`);
   104: }catch(e){soundService.play('error');if(catalog===catalogVersion.current)setError((e as Error).message);}
   ```
   - Successfully adding an instrument to Dexie calls `soundService.play('success')`, followed immediately by `setError(...)`.
   - Because `MarketsPage` only possesses `const [error, setError] = useState('')`, this success message is passed to `<ErrorMessage message={error}/>`.
   - Result: The user receives a red error banner (`#fff0ed` background, `#9c3832` red text) for a successful action.

4. **Duplicate Save Failure (`src/pages/InvestmentPages.tsx:97-98`)**:
   ```tsx
   97: const existing=await financeDb.instruments.where('sourceSymbol').equals(quote.symbol).filter(row=>!row.deletedAt).first();
   98: if(existing)throw new Error('This instrument is already in Investments.');
   ```
   - Clicking "Add to Investments" repeatedly throws an error without any visual cue that the instrument is already added.

5. **Existing Verification State**:
   - `npm.cmd run typecheck` passes with 0 errors.
   - `npm.cmd test` passes 23 of 24 test files (470 passing tests; 1 expected float precision failure in `tests/monte-carlo.test.ts:260` scoped to Milestone 4).

---

## 2. Logic Chain

1. From **Observation 1**, `Promise.all` in `loadCatalog` shares a single error handler that sets `error` at the page level. Therefore, quote fetch failures are not isolated per ticker, creating an all-or-nothing failure impression for end users.
2. Changing `Promise.all` to `Promise.allSettled` and routing individual failures into a per-ticker `quoteErrors: Record<string, string>` map ensures that successful quotes populate `quotes`, while failed quotes populate `quoteErrors` without setting the global `error`.
3. In the table view, mapping each row against `quote` and `quoteErrors[record.symbol]` allows rendering either the active price (with a `Stale` badge if applicable), or an inline `<span className="badge warning">Unavailable</span>` pill with tooltip explanation, keeping the remaining rows intact.
4. From **Observation 2**, `select()` currently ties selection entirely to `selected: MarketQuote | null`. If quote fetching fails, `selected` is `null` and `error` is set. Decoupling selection into `selectedInstrument: MarketInstrument | null` and `selectedQuote: MarketQuote | null` enables rendering an informative "Unavailable / Stale" detail card for the instrument. This card informs the user why the public market feed is unreachable and provides an "Add with Manual Valuation" action.
5. From **Observation 3**, reusing `setError` for confirmation messages directly violates the semantic contract of `<ErrorMessage />`. Introducing `successMessage: string` and rendering a dedicated green banner (`.notice.success` or `#eef7ee` border/background) with an auto-dismiss timer and dismiss button provides proper positive feedback.
6. From **Observation 4**, querying `savedInstruments` via `useLiveQuery` and checking `savedSymbols.has(symbol)` enables disabling the button with label `"In Investments"`, preventing duplicate submission errors.

---

## 3. Caveats

1. **Gateway Dependency for Live Philippine Quotes**: When running locally without an active Cloud Function gateway or API key, Philippine quotes will legitimately fail to fetch. Under this resilient design, the UI will cleanly show "Unavailable" without crashing the application.
2. **Parquet Mirror for International Stocks**: International stocks rely on the client-side `free-global-mirror.mjs`. Historical bars may not exist for newly listed or illiquid tickers; the design isolates price history errors to the chart area so they do not crash the detail card.
3. **Scope Boundary**: This explorer is read-only. Source changes in `src/pages/InvestmentPages.tsx` and accompanying tests in `tests/markets-resilience.test.ts` must be executed by Implementer M2-2.

---

## 4. Conclusion

The defects in `MarketsPage` (`src/pages/InvestmentPages.tsx`) can be completely resolved with zero external dependencies and zero schema migrations:
1. Replace concurrent `Promise.all` with `Promise.allSettled`, isolating quote errors into a `quoteErrors` dictionary so healthy tickers render cleanly.
2. Introduce a dual-state selection model (`selectedInstrument` + `selectedQuote`) that displays an "Unavailable / Stale" card for unquoted tickers, complete with an "Add with Manual Valuation" button.
3. Replace `setError` feedback in `saveInstrument` with a dedicated `successMessage` state and an accessible green banner (`role="status"`, auto-dismiss after 5s).
4. Add duplicate-addition defense (`"In Investments"`) using `useLiveQuery`.

The full design and replacement code are documented in `e:/Visual Studio Code/tala/.agents/teamwork/explorer_m2_2/report.md`.

---

## 5. Verification Method

To independently verify the proposed design after implementation:

1. **Static Analysis & Type Checking**:
   ```powershell
   npm.cmd run typecheck
   ```
   Must pass with zero TypeScript errors.

2. **Targeted Unit & Component Tests**:
   Create and execute `tests/markets-resilience.test.ts`:
   ```powershell
   npx.cmd vitest run tests/markets-resilience.test.ts
   ```
   Verify:
   - Partial quote fetch failures (e.g. 1 out of 3 tickers fails) leave global `error` empty and populate `quoteErrors`.
   - Selecting a failed ticker displays the "Unavailable" state without global error.
   - Calling `saveInstrument` sets `successMessage` and leaves `error` empty.
   - Already-saved instruments show disabled "In Investments" button.

3. **Full Test Suite Regression**:
   ```powershell
   npm.cmd test
   ```
   Ensure no regressions are introduced across the 23 passing test suites.
