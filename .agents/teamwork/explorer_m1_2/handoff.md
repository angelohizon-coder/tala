# Handoff Report: Dexie FX Seeding, Background Refresh & Overview UI Resilience

**Agent:** Explorer M1-2  
**Role:** Dexie FX Seeding & UI Valuation Explorer  
**Task:** Milestone 1 — Dexie FX Seeding, Background Refresh & Overview UI  
**Target Files:**  
- `src/db/repository.ts`
- `src/market/providers.ts`
- `src/pages/Overview.tsx`
- `src/App.tsx`  
**Related Report:** `e:/Visual Studio Code/tala/.agents/teamwork/explorer_m1_2/report.md`

---

## 1. Observation

### Observation 1: Empty FX Rates in Initial Database
- **File:** `src/db/repository.ts:362-369`
- **Code:**
  ```typescript
  export async function initializeFinanceDatabase(db: FinanceDatabase = financeDb) {
    await db.open();
    if (await db.categories.count()) return;
    const repository = createFinanceRepository(db);
    for (const name of ['Housing', 'Food', 'Transport', 'Healthcare', 'Insurance', 'Travel', 'Family', 'Entertainment', 'Subscriptions', 'Taxes', 'Education', 'Charity', 'Personal', 'Miscellaneous', 'Salary', 'Other income']) {
      await repository.save('categories', { id: `category-${name.toLowerCase().replaceAll(' ', '-')}`, name, kind: ['Salary', 'Other income'].includes(name) ? 'income' : 'expense', color: '#6b7280', essential: ['Housing', 'Food', 'Healthcare'].includes(name), archived: false });
    }
  }
  ```
- **Finding:** Only categories are seeded. No rates are inserted into `db.fxRates`. Furthermore, if `db.categories.count() > 0`, it returns immediately, blocking any future seeding.

### Observation 2: Net Worth Evaluates to Null on Missing FX and Renders `'—'`
- **File:** `src/pages/Overview.tsx:87`
- **Code:**
  ```tsx
  <strong className="metric-value"><Money amount={hasAccounts?netWorth.netWorth:null} currency={currency}/></strong>
  ```
- **File:** `src/ui/shared.tsx:8`
- **Code:**
  ```typescript
  export function formatMoney(amount:number|null|undefined,currency='PHP'){return typeof amount==='number'&&Number.isFinite(amount)?new Intl.NumberFormat('en-PH',{style:'currency',currency,currencyDisplay:currency==='PHP'?'symbol':'code',maximumFractionDigits:precision(currency)}).format(minorToMajor(amount,currency)):'—';}
  ```
- **Finding:** When any account has a currency lacking an FX rate to base currency, `calculateNetWorthFromBalances` in `src/core/calculations.ts` marks `incomplete = true` and `netWorth = null`, although `knownNetWorth` is computed. Passing `netWorth.netWorth` (`null`) to `<Money>` forces `formatMoney` to return `'—'`, violating requirement R1.
- Identical null references exist on lines 113-114 (`netWorth.assets` and `netWorth.liabilities`) and line 190 (`netWorth.assets`).

### Observation 3: FX Refresh is Exclusively Manual in Settings
- **File:** `src/market/providers.ts:22-28`
- **Code:**
  ```typescript
  export async function refreshFx(base='PHP'){
    if(!/^[A-Z]{3}$/.test(base))throw new Error('Choose a valid base currency.');
    const cached=await financeRepository.getSetting<{count:number;asOf:string;fetchedAt:number}>('fx-refresh:'+base);if(cached&&Date.now()-cached.fetchedAt<3600000)return {count:cached.count,asOf:cached.asOf};
    const response=await fetch(`https://open.er-api.com/v6/latest/${base}`,{signal:AbortSignal.timeout(12000)});const data=await response.json();if(!response.ok||data.result!=='success'||data.base_code!==base||!Number.isSafeInteger(data.time_last_update_unix)||data.time_last_update_unix*1000>Date.now()+300000||!data.rates||data.rates[base]!==1)throw new Error('The free FX source is unavailable or invalid. Saved rates are kept.');
    const asOf=new Date(data.time_last_update_unix*1000).toISOString();let count=0;
    await financeDb.transaction('rw',financeDb.tables,async()=>{for(const currency of ['PHP','USD','EUR','GBP','JPY','HKD','CAD','AUD','SGD']){const rate=data.rates[currency];if(currency===base||typeof rate!=='number'||!Number.isFinite(rate)||rate<=0)continue;await financeRepository.save('fxRates',{id:`fx:${currency}:${base}:${asOf}`,fromCurrency:currency,toCurrency:base,rate:1/rate,asOf,source:'ExchangeRate-API open daily reference',fetchedAt:new Date().toISOString()});count++;}await financeRepository.setSetting('fx-refresh:'+base,{count,asOf,fetchedAt:Date.now()});});return {count,asOf};
  }
  ```
- **Finding:** `refreshFx` is only called in `src/pages/PlanningPages.tsx:294` on manual button click. It is never called on app boot (`src/App.tsx:30`) or when base currency is changed (`Overview.tsx:52`).

### Observation 4: Date Cutoff Behavior in `getFxRate`
- **File:** `src/core/calculations.ts:60,67-68`
- **Code:**
  ```typescript
  const cutoff = throughDate(asOf);
  ...
  const time = Date.parse(rate.asOf);
  if (!Number.isFinite(time) || time > cutoff) continue;
  ```
- **Finding:** `getFxRate` discards rates where `rate.asOf > cutoff`. If baseline seed rates were dated with the current date (e.g. `2026-10-10`), any historical query earlier in the year would discard the seed rate. Using `2020-01-01T00:00:00.000Z` ensures all realistic historical ledger cutoffs include the seed rate, while live rates from `refreshFx` (dated today) supersede it whenever `cutoff >= today`.

---

## 2. Logic Chain

1. **Premise 1 (from Obs 1):** On a fresh installation, `db.fxRates` has 0 records. Any account in a foreign currency (e.g. USD) cannot be converted to PHP immediately without network access.
2. **Premise 2 (from Obs 2):** When any account cannot be converted, `netWorth.netWorth` is `null`. The Overview component renders `<Money amount={hasAccounts ? netWorth.netWorth : null} />`, resulting in `formatMoney(null)` which displays `'—'`.
3. **Inference 1:** Providing default baseline seed rates in `initializeFinanceDatabase` for all supported currencies guarantees that foreign balances can convert immediately on fresh installs without an external API.
4. **Inference 2 (from Obs 4):** Timestamping seed rates with `2020-01-01T00:00:00.000Z` ensures they are never excluded by `asOf > cutoff` filters for historical ledger transactions, while allowing fresher live rates to automatically supersede them.
5. **Inference 3 (from Obs 2):** In `Overview.tsx`, replacing `netWorth.netWorth` with `netWorth.netWorth ?? netWorth.knownNetWorth` ensures a valid numeric valuation is ALWAYS rendered, even if an exotic currency or missing price leaves the calculation partial. Adding an `Estimated` badge gives transparent feedback to the user.
6. **Inference 4 (from Obs 3):** Hooking non-blocking background `safeRefreshFx` into `App.tsx` (after `financeRepository.initialize()`) and `Overview.tsx` (when base currency changes) guarantees rates stay up-to-date automatically while preserving offline-first non-blocking speed.

---

## 3. Caveats

- **Triangular Routing:** The exact multi-hop FX conversion logic (e.g. `EUR -> USD -> PHP`) is implemented by Explorer M1-1 in `src/core/calculations.ts`. Our seed data includes both `currency -> PHP` and `currency -> USD` pairs to supply optimal pivot points.
- **Network Rate Variations:** Default seed rates are fixed baselines (e.g., USD:PHP = 57.0, EUR:PHP = 62.0). They represent approximate baseline values until `refreshFx` fetches live market daily rates from `ExchangeRate-API`.
- **No other caveats.**

---

## 4. Conclusion

1. In `src/db/repository.ts`:
   - Export `DEFAULT_FX_SEEDS` with 15 pairs across the 9 supported currencies, dated `2020-01-01T00:00:00.000Z`.
   - Update `initializeFinanceDatabase` to decouple category and FX checks: seed categories if `categories.count() === 0`, and seed FX rates if `fxRates.count() === 0`.
2. In `src/market/providers.ts`:
   - Add `force = false` to `refreshFx`.
   - Export `safeRefreshFx(base = 'PHP', force = false)` to encapsulate error swallowing for background callers.
3. In `src/App.tsx`:
   - Invoke `void financeRepository.getSetting<FinanceSettings>('finance').then(s => safeRefreshFx(s?.baseCurrency || 'PHP')).catch(() => {})` in the startup `useEffect`.
4. In `src/pages/Overview.tsx`:
   - Render `netWorth.netWorth ?? netWorth.knownNetWorth` in the Total Net Worth card.
   - Render `netWorth.assets ?? netWorth.knownAssets` and `netWorth.liabilities ?? netWorth.knownLiabilities` in `.mini-stat-row` and Asset Allocation.
   - Display a subtle `<span className="badge warning">Estimated</span>` badge when `!netWorth.complete && hasAccounts`.
   - Trigger `safeRefreshFx(value)` on base currency change.

---

## 5. Verification Method

### 5.1 Independent Test Commands
Execute Vitest across unit and integration tests:
```powershell
cmd /c npx vitest run tests/repository.test.ts
cmd /c npx vitest run tests/calculations.test.ts
```

### 5.2 Seeding Verification (Unit Test)
Add a test in `tests/repository.test.ts`:
```typescript
it('seeds default FX rates and categories on a fresh database', async () => {
  const freshDb = new FinanceDatabase(`fresh-db-${crypto.randomUUID()}`);
  await freshDb.open();
  await initializeFinanceDatabase(freshDb);
  expect(await freshDb.categories.count()).toBe(16);
  expect(await freshDb.fxRates.count()).toBe(15);
  const usdRate = await freshDb.fxRates.get('fx:seed:USD:PHP');
  expect(usdRate?.rate).toBe(57.0);
  expect(usdRate?.asOf).toBe('2020-01-01T00:00:00.000Z');
  // Verify idempotence
  await initializeFinanceDatabase(freshDb);
  expect(await freshDb.fxRates.count()).toBe(15);
  await freshDb.delete();
});
```

### 5.3 Resilient Net Worth Rendering Verification
Verify that when an account with a non-base currency exists:
1. When rates exist (seeded or fetched), Total Net Worth renders the converted total.
2. If rates are completely absent, Total Net Worth renders `knownNetWorth` with the `Estimated` pill and NEVER renders `'—'`.
3. Invalidation condition: If `formatMoney` returns `'—'` for an account portfolio with accounts present, verification has failed.
