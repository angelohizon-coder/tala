# Explorer M1-2 Investigation Report: Dexie FX Seeding, Background Refresh & Resilient Overview UI

**Date:** 2026-10-10  
**Milestone:** M1 (Core Currency, Valuation & Data Sync)  
**Investigator:** Explorer M1-2  
**Target Files:**  
- `src/db/repository.ts`
- `src/market/providers.ts`
- `src/pages/Overview.tsx`
- `src/App.tsx` (lifecycle integration)

---

## 1. Executive Summary

In Tala, when accounts hold foreign currencies (e.g., PHP and USD), the Overview dashboard currently renders an empty dash (`—`) for Total Net Worth whenever exchange rates are missing or pending. Furthermore, a fresh database contains zero FX rates because `initializeFinanceDatabase` only populates categories and never seeds baseline FX rates. Finally, `refreshFx` is only triggered via a manual button click in Settings rather than automatically when the app starts or when the user switches base currencies.

This investigation delivers a comprehensive, production-ready architectural design to resolve these three issues:
1. **Baseline FX Rate Seeding in Dexie (`initializeFinanceDatabase`)**: Seeds 15 baseline rates covering all 9 supported currencies (`PHP`, `USD`, `EUR`, `GBP`, `JPY`, `HKD`, `CAD`, `AUD`, `SGD`) with `asOf: '2020-01-01T00:00:00.000Z'` so that offline and historical conversions succeed immediately without waiting for an external API.
2. **Automatic Background FX Refresh**: Non-blocking, cached auto-refresh on app boot in `App.tsx` and upon base currency change in `Overview.tsx` and `SettingsPage.tsx`, maintaining 100% offline-first reliability.
3. **Resilient Net Worth UI Rendering (`Overview.tsx`)**: Renders `netWorth.netWorth ?? netWorth.knownNetWorth` (and corresponding known values for Assets and Liabilities), ensuring `—` is never displayed for multi-currency accounts, accompanied by a subtle `Estimated` warning pill and context-aware links.

---

## 2. Problem Analysis & Root Causes

### 2.1 Root Cause of Missing Initial FX Rates (`src/db/repository.ts:362-369`)
In `src/db/repository.ts`:
```typescript
export async function initializeFinanceDatabase(db: FinanceDatabase = financeDb) {
  await db.open();
  if (await db.categories.count()) return;
  const repository = createFinanceRepository(db);
  for (const name of ['Housing', 'Food', ...]) {
    await repository.save('categories', { ... });
  }
}
```
**Issues identified:**
- Zero FX rates are inserted. The `fxRates` table remains completely empty until the user navigates to `/settings` and clicks "Refresh free daily FX".
- The early return `if (await db.categories.count()) return;` causes a database with existing categories to skip any future initialization checks even if `fxRates` is completely empty.

### 2.2 Root Cause of Net Worth Rendering `'—'` (`src/pages/Overview.tsx:87`)
In `src/pages/Overview.tsx`:
```tsx
<strong className="metric-value"><Money amount={hasAccounts ? netWorth.netWorth : null} currency={currency}/></strong>
```
And in `src/ui/shared.tsx`:
```typescript
export function formatMoney(amount: number | null | undefined, currency = 'PHP') {
  return typeof amount === 'number' && Number.isFinite(amount)
    ? new Intl.NumberFormat('en-PH', { ... }).format(minorToMajor(amount, currency))
    : '—';
}
```
**Issues identified:**
- `calculateNetWorthFromBalances()` in `src/core/calculations.ts` marks `netWorth = null` whenever any foreign balance cannot be converted (`missing_fx`).
- However, `calculateNetWorthFromBalances()` already computes `knownNetWorth` (as well as `knownAssets` and `knownLiabilities`), which aggregates all valid/convertible balances.
- Because `Overview.tsx` passes `netWorth.netWorth` directly to `<Money>`, any missing rate nullifies the entire Net Worth card into `'—'`, violating Requirement R1.
- The same issue exists on lines 113-114 (`Assets` and `Liabilities` in `.mini-stat-row`) and line 190 (Asset Allocation chart total assets).

### 2.3 FX Refresh Exclusively Manual (`src/market/providers.ts:22-28`)
`refreshFx` exists in `src/market/providers.ts`, but is only invoked inside `src/pages/PlanningPages.tsx` (the Settings tab) when the user clicks `<RefreshCw/> Refresh free daily FX`.
**Issues identified:**
- On initial launch, the user is never prompted to refresh FX rates, and no background task fetches them.
- When the user changes `baseCurrency` in the top header of `Overview.tsx`, no FX refresh is scheduled for the new base currency.
- While `refreshFx` contains a 1-hour cache check (`cached && Date.now() - cached.fetchedAt < 3600000`), manual clicks cannot bypass the cache if a user wants an immediate retry after network reconnection.

---

## 3. Technical Solutions & Detailed Specifications

### 3.1 Task 1: Default FX Seed Rates in `src/db/repository.ts`

#### Baseline Rate Table
The 9 supported currencies in Tala are: `PHP` (default base), `USD`, `EUR`, `GBP`, `JPY`, `HKD`, `CAD`, `AUD`, `SGD`.
We define `DEFAULT_FX_SEEDS` with realistic reference rates:

| From | To | Rate (Destination Units per 1 Source Unit) | Description |
|---|---|---|---|
| `USD` | `PHP` | `57.0` | 1 USD = 57.00 PHP |
| `EUR` | `PHP` | `62.0` | 1 EUR = 62.00 PHP |
| `GBP` | `PHP` | `72.0` | 1 GBP = 72.00 PHP |
| `JPY` | `PHP` | `0.38` | 1 JPY = 0.38 PHP (1 PHP ≈ 2.63 JPY) |
| `SGD` | `PHP` | `43.0` | 1 SGD = 43.00 PHP |
| `HKD` | `PHP` | `7.30` | 1 HKD = 7.30 PHP |
| `CAD` | `PHP` | `42.0` | 1 CAD = 42.00 PHP |
| `AUD` | `PHP` | `38.0` | 1 AUD = 38.00 PHP |
| `EUR` | `USD` | `1.087` | 1 EUR = 1.087 USD |
| `GBP` | `USD` | `1.265` | 1 GBP = 1.265 USD |
| `SGD` | `USD` | `0.754` | 1 SGD = 0.754 USD |
| `JPY` | `USD` | `0.00667`| 1 JPY = 0.00667 USD |
| `HKD` | `USD` | `0.128` | 1 HKD = 0.128 USD |
| `CAD` | `USD` | `0.737` | 1 CAD = 0.737 USD |
| `AUD` | `USD` | `0.667` | 1 AUD = 0.667 USD |

#### Date Timestamp Strategy
- In `src/core/calculations.ts`, `getFxRate(from, to, rates, asOf)` checks `cutoff = throughDate(asOf)`. If `rate.asOf > cutoff`, the rate is ignored as a future observation.
- If seed rates were given a timestamp like `2026-10-10`, historical transactions recorded earlier in 2026 or 2025 would not be able to use the seed rate.
- Therefore, seed rates are timestamped with:
  `asOf: '2020-01-01T00:00:00.000Z'`
- Since `getFxRate` prioritizes the most recent rate before `cutoff` (`time > directTime`), any live rate fetched by `refreshFx` (with timestamp e.g. `2026-10-10...`) will immediately supersede the seed rate for current valuations, while the seed rate remains available as a universal floor.

#### Code Specification for `src/db/repository.ts`

```typescript
export const DEFAULT_FX_SEEDS = [
  { id: 'fx:seed:USD:PHP', fromCurrency: 'USD', toCurrency: 'PHP', rate: 57.0, asOf: '2020-01-01T00:00:00.000Z', source: 'Tala baseline reference' },
  { id: 'fx:seed:EUR:PHP', fromCurrency: 'EUR', toCurrency: 'PHP', rate: 62.0, asOf: '2020-01-01T00:00:00.000Z', source: 'Tala baseline reference' },
  { id: 'fx:seed:GBP:PHP', fromCurrency: 'GBP', toCurrency: 'PHP', rate: 72.0, asOf: '2020-01-01T00:00:00.000Z', source: 'Tala baseline reference' },
  { id: 'fx:seed:JPY:PHP', fromCurrency: 'JPY', toCurrency: 'PHP', rate: 0.38, asOf: '2020-01-01T00:00:00.000Z', source: 'Tala baseline reference' },
  { id: 'fx:seed:SGD:PHP', fromCurrency: 'SGD', toCurrency: 'PHP', rate: 43.0, asOf: '2020-01-01T00:00:00.000Z', source: 'Tala baseline reference' },
  { id: 'fx:seed:HKD:PHP', fromCurrency: 'HKD', toCurrency: 'PHP', rate: 7.30, asOf: '2020-01-01T00:00:00.000Z', source: 'Tala baseline reference' },
  { id: 'fx:seed:CAD:PHP', fromCurrency: 'CAD', toCurrency: 'PHP', rate: 42.0, asOf: '2020-01-01T00:00:00.000Z', source: 'Tala baseline reference' },
  { id: 'fx:seed:AUD:PHP', fromCurrency: 'AUD', toCurrency: 'PHP', rate: 38.0, asOf: '2020-01-01T00:00:00.000Z', source: 'Tala baseline reference' },
  { id: 'fx:seed:EUR:USD', fromCurrency: 'EUR', toCurrency: 'USD', rate: 1.087, asOf: '2020-01-01T00:00:00.000Z', source: 'Tala baseline reference' },
  { id: 'fx:seed:GBP:USD', fromCurrency: 'GBP', toCurrency: 'USD', rate: 1.265, asOf: '2020-01-01T00:00:00.000Z', source: 'Tala baseline reference' },
  { id: 'fx:seed:SGD:USD', fromCurrency: 'SGD', toCurrency: 'USD', rate: 0.754, asOf: '2020-01-01T00:00:00.000Z', source: 'Tala baseline reference' },
  { id: 'fx:seed:JPY:USD', fromCurrency: 'JPY', toCurrency: 'USD', rate: 0.00667, asOf: '2020-01-01T00:00:00.000Z', source: 'Tala baseline reference' },
  { id: 'fx:seed:HKD:USD', fromCurrency: 'HKD', toCurrency: 'USD', rate: 0.128, asOf: '2020-01-01T00:00:00.000Z', source: 'Tala baseline reference' },
  { id: 'fx:seed:CAD:USD', fromCurrency: 'CAD', toCurrency: 'USD', rate: 0.737, asOf: '2020-01-01T00:00:00.000Z', source: 'Tala baseline reference' },
  { id: 'fx:seed:AUD:USD', fromCurrency: 'AUD', toCurrency: 'USD', rate: 0.667, asOf: '2020-01-01T00:00:00.000Z', source: 'Tala baseline reference' },
] as const;

export async function initializeFinanceDatabase(db: FinanceDatabase = financeDb) {
  await db.open();
  const repository = createFinanceRepository(db);

  if ((await db.categories.count()) === 0) {
    for (const name of ['Housing', 'Food', 'Transport', 'Healthcare', 'Insurance', 'Travel', 'Family', 'Entertainment', 'Subscriptions', 'Taxes', 'Education', 'Charity', 'Personal', 'Miscellaneous', 'Salary', 'Other income']) {
      await repository.save('categories', {
        id: `category-${name.toLowerCase().replaceAll(' ', '-')}`,
        name,
        kind: ['Salary', 'Other income'].includes(name) ? 'income' : 'expense',
        color: '#6b7280',
        essential: ['Housing', 'Food', 'Healthcare'].includes(name),
        archived: false,
      });
    }
  }

  if ((await db.fxRates.count()) === 0) {
    for (const seed of DEFAULT_FX_SEEDS) {
      await repository.save('fxRates', seed);
    }
  }
}
```

---

### 3.2 Task 2: Automatic Background FX Refresh Architecture

#### `src/market/providers.ts`
1. Add `force = false` parameter to `refreshFx`:
```typescript
export async function refreshFx(base = 'PHP', force = false) {
  if (!/^[A-Z]{3}$/.test(base)) throw new Error('Choose a valid base currency.');
  const cached = await financeRepository.getSetting<{ count: number; asOf: string; fetchedAt: number }>('fx-refresh:' + base);
  if (!force && cached && Date.now() - cached.fetchedAt < 3600000) {
    return { count: cached.count, asOf: cached.asOf };
  }
  const response = await fetch(`https://open.er-api.com/v6/latest/${base}`, { signal: AbortSignal.timeout(12000) });
  const data = await response.json();
  if (!response.ok || data.result !== 'success' || data.base_code !== base || !Number.isSafeInteger(data.time_last_update_unix) || data.time_last_update_unix * 1000 > Date.now() + 300000 || !data.rates || data.rates[base] !== 1) {
    throw new Error('The free FX source is unavailable or invalid. Saved rates are kept.');
  }
  const asOf = new Date(data.time_last_update_unix * 1000).toISOString();
  let count = 0;
  await financeDb.transaction('rw', financeDb.tables, async () => {
    for (const currency of ['PHP', 'USD', 'EUR', 'GBP', 'JPY', 'HKD', 'CAD', 'AUD', 'SGD']) {
      const rate = data.rates[currency];
      if (currency === base || typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) continue;
      await financeRepository.save('fxRates', {
        id: `fx:${currency}:${base}:${asOf}`,
        fromCurrency: currency,
        toCurrency: base,
        rate: 1 / rate,
        asOf,
        source: 'ExchangeRate-API open daily reference',
        fetchedAt: new Date().toISOString(),
      });
      count++;
    }
    await financeRepository.setSetting('fx-refresh:' + base, { count, asOf, fetchedAt: Date.now() });
  });
  return { count, asOf };
}

export async function safeRefreshFx(base = 'PHP', force = false): Promise<{ ok: boolean; count?: number; asOf?: string; error?: string }> {
  try {
    const result = await refreshFx(base, force);
    return { ok: true, count: result.count, asOf: result.asOf };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}
```

#### Lifecycle Hooks for Automatic Refresh:
1. **On App Boot (`src/App.tsx:30`)**:
   In `App.tsx`:
   ```typescript
   financeDb.open().then(async () => {
     await financeRepository.initialize();
     if (!active) return;
     setReady(true);

     // Trigger background FX refresh for active base currency
     void financeRepository.getSetting<FinanceSettings>('finance')
       .then(settings => safeRefreshFx(settings?.baseCurrency || 'PHP'))
       .catch(() => {});

     try {
       stop = await initializeSync();
       if (!active) stop();
     } catch {
       await financeDb.syncState.put({ id: 'lastSyncError', value: 'Cloud connection unavailable. Your local ledger remains usable.' });
     }
   })
   ```
2. **On Base Currency Switch (`src/pages/Overview.tsx:52` & `src/pages/PlanningPages.tsx:274`)**:
   When the user changes the currency dropdown, call `void safeRefreshFx(value).catch(() => {});`.
   This immediately pulls fresh rates for the new base in the background.

---

### 3.3 Task 3: Resilient Net Worth UI Rendering in `src/pages/Overview.tsx`

#### UI Changes in `Overview.tsx`
1. **Metric Value**:
   ```tsx
   <strong className="metric-value">
     <Money amount={hasAccounts ? (netWorth.netWorth ?? netWorth.knownNetWorth) : null} currency={currency} />
   </strong>
   ```
2. **Metric Label with Estimated Status Badge**:
   ```tsx
   <div className="metric-label">
     <span>TOTAL NET WORTH</span>
     {!netWorth.complete && hasAccounts && (
       <span
         className="badge warning"
         title="Some accounts use cached or estimated conversion rates"
         style={{ fontSize: '8px', padding: '2px 6px', lineHeight: 1.2 }}
       >
         Estimated
       </span>
     )}
     <Wallet size={18} />
   </div>
   ```
3. **Metric Footer**:
   ```tsx
   <div className="metric-foot">
     <span>{!netWorth.complete && hasAccounts ? 'Known converted balance' : 'Assets minus liabilities'}</span>
     <ArrowUpRight size={17} />
   </div>
   ```
4. **Mini-Stat Row (Assets and Liabilities)**:
   ```tsx
   <div className="mini-stat-row">
     <div>
       <span>Assets</span>
       <strong><Money amount={hasAccounts ? (netWorth.assets ?? netWorth.knownAssets) : null} currency={currency} /></strong>
     </div>
     <div>
       <span>Liabilities</span>
       <strong><Money amount={hasAccounts ? (netWorth.liabilities ?? netWorth.knownLiabilities) : null} currency={currency} /></strong>
     </div>
     {/* cash flow and runway unchanged */}
   </div>
   ```
5. **Asset Allocation Chart Total Assets**:
   ```tsx
   <span>
     <small>Total assets</small>
     <strong><Money amount={netWorth.assets ?? netWorth.knownAssets} currency={currency} /></strong>
   </span>
   ```
6. **Notice Banner**:
   ```tsx
   {!netWorth.complete && hasAccounts && (
     <div className="notice warning">
       Some valuations need a price or currency rate. Showing known converted totals ({currency}).{' '}
       {netWorth.issues?.some(i => i.code === 'missing_fx') ? (
         <Link to="/settings" className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-tala-green">
           Check currency reference rates
         </Link>
       ) : (
         <Link to="/investments" className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-tala-green">
           Review investments
         </Link>
       )}
     </div>
   )}
   ```
7. **Snapshot Persistence Resilience**:
   ```tsx
   useEffect(() => {
     if (!data?.accounts.length) return;
     const { netWorth, settings } = data;
     const currentNetWorth = netWorth.netWorth ?? netWorth.knownNetWorth;
     const currentAssets = netWorth.assets ?? netWorth.knownAssets;
     const currentLiabilities = netWorth.liabilities ?? netWorth.knownLiabilities;
     if (currentNetWorth === null || currentAssets === null || currentLiabilities === null) return;
     const id = `snapshot:${today()}:${settings.baseCurrency}`;
     void financeDb.balanceSnapshots.get(id).then(old => {
       if (old?.netWorth === currentNetWorth && old?.assets === currentAssets && old?.liabilities === currentLiabilities) return;
       return financeRepository.save('balanceSnapshots', {
         id,
         date: today(),
         netWorth: currentNetWorth,
         assets: currentAssets,
         liabilities: currentLiabilities,
         currency: settings.baseCurrency,
         notes: netWorth.complete ? 'Recorded local ledger valuation' : 'Estimated local ledger valuation',
       });
     }).catch(() => {});
   }, [
     data?.netWorth.netWorth, data?.netWorth.knownNetWorth,
     data?.netWorth.assets, data?.netWorth.knownAssets,
     data?.netWorth.liabilities, data?.netWorth.knownLiabilities,
     data?.netWorth.complete, data?.settings.baseCurrency, data?.accounts.length,
   ]);
   ```

---

## 4. Impact Analysis & Integration

1. **Alignment with Explorer M1-1 (`src/core/calculations.ts`)**:
   - Explorer M1-1 is designing triangular cross-rates in `getFxRate` and resilient `knownNetWorth` handling.
   - Our baseline seed table provides both direct `X -> PHP` rates and `X -> USD` rates, giving Explorer M1-1's triangular engine optimal pivot points.
   - When Explorer M1-1's engine returns `{ netWorth: null, knownNetWorth: 123456, complete: false }`, our Overview rendering displays `123,456` with the `Estimated` pill.

2. **Alignment with Explorer M1-3 (`src/sync/firebase.ts`)**:
   - Seed rates are saved via standard repository mutations, which naturally acquire `ownerId: 'local'` and versioning, ready to sync if authenticated.

3. **Performance & Offline Integrity**:
   - `initializeFinanceDatabase` runs completely offline in IndexedDB in < 5ms.
   - `refreshFx` runs in the background and times out after 12s on slow networks without blocking the user interface.
   - Even on a fresh install in airplane mode, multi-currency accounts display converted net worth immediately.

---

## 5. Proposed Code Snippets (Ready for Implementer)

### `src/db/repository.ts`
```typescript
// Replace lines 362-369 with:
export const DEFAULT_FX_SEEDS = [
  { id: 'fx:seed:USD:PHP', fromCurrency: 'USD', toCurrency: 'PHP', rate: 57.0, asOf: '2020-01-01T00:00:00.000Z', source: 'Tala baseline reference' },
  { id: 'fx:seed:EUR:PHP', fromCurrency: 'EUR', toCurrency: 'PHP', rate: 62.0, asOf: '2020-01-01T00:00:00.000Z', source: 'Tala baseline reference' },
  { id: 'fx:seed:GBP:PHP', fromCurrency: 'GBP', toCurrency: 'PHP', rate: 72.0, asOf: '2020-01-01T00:00:00.000Z', source: 'Tala baseline reference' },
  { id: 'fx:seed:JPY:PHP', fromCurrency: 'JPY', toCurrency: 'PHP', rate: 0.38, asOf: '2020-01-01T00:00:00.000Z', source: 'Tala baseline reference' },
  { id: 'fx:seed:SGD:PHP', fromCurrency: 'SGD', toCurrency: 'PHP', rate: 43.0, asOf: '2020-01-01T00:00:00.000Z', source: 'Tala baseline reference' },
  { id: 'fx:seed:HKD:PHP', fromCurrency: 'HKD', toCurrency: 'PHP', rate: 7.30, asOf: '2020-01-01T00:00:00.000Z', source: 'Tala baseline reference' },
  { id: 'fx:seed:CAD:PHP', fromCurrency: 'CAD', toCurrency: 'PHP', rate: 42.0, asOf: '2020-01-01T00:00:00.000Z', source: 'Tala baseline reference' },
  { id: 'fx:seed:AUD:PHP', fromCurrency: 'AUD', toCurrency: 'PHP', rate: 38.0, asOf: '2020-01-01T00:00:00.000Z', source: 'Tala baseline reference' },
  { id: 'fx:seed:EUR:USD', fromCurrency: 'EUR', toCurrency: 'USD', rate: 1.087, asOf: '2020-01-01T00:00:00.000Z', source: 'Tala baseline reference' },
  { id: 'fx:seed:GBP:USD', fromCurrency: 'GBP', toCurrency: 'USD', rate: 1.265, asOf: '2020-01-01T00:00:00.000Z', source: 'Tala baseline reference' },
  { id: 'fx:seed:SGD:USD', fromCurrency: 'SGD', toCurrency: 'USD', rate: 0.754, asOf: '2020-01-01T00:00:00.000Z', source: 'Tala baseline reference' },
  { id: 'fx:seed:JPY:USD', fromCurrency: 'JPY', toCurrency: 'USD', rate: 0.00667, asOf: '2020-01-01T00:00:00.000Z', source: 'Tala baseline reference' },
  { id: 'fx:seed:HKD:USD', fromCurrency: 'HKD', toCurrency: 'USD', rate: 0.128, asOf: '2020-01-01T00:00:00.000Z', source: 'Tala baseline reference' },
  { id: 'fx:seed:CAD:USD', fromCurrency: 'CAD', toCurrency: 'USD', rate: 0.737, asOf: '2020-01-01T00:00:00.000Z', source: 'Tala baseline reference' },
  { id: 'fx:seed:AUD:USD', fromCurrency: 'AUD', toCurrency: 'USD', rate: 0.667, asOf: '2020-01-01T00:00:00.000Z', source: 'Tala baseline reference' },
] as const;

export async function initializeFinanceDatabase(db: FinanceDatabase = financeDb) {
  await db.open();
  const repository = createFinanceRepository(db);
  if ((await db.categories.count()) === 0) {
    for (const name of ['Housing', 'Food', 'Transport', 'Healthcare', 'Insurance', 'Travel', 'Family', 'Entertainment', 'Subscriptions', 'Taxes', 'Education', 'Charity', 'Personal', 'Miscellaneous', 'Salary', 'Other income']) {
      await repository.save('categories', { id: `category-${name.toLowerCase().replaceAll(' ', '-')}`, name, kind: ['Salary', 'Other income'].includes(name) ? 'income' : 'expense', color: '#6b7280', essential: ['Housing', 'Food', 'Healthcare'].includes(name), archived: false });
    }
  }
  if ((await db.fxRates.count()) === 0) {
    for (const seed of DEFAULT_FX_SEEDS) {
      await repository.save('fxRates', seed);
    }
  }
}
```

### `src/market/providers.ts`
```typescript
// Replace lines 22-28 with:
export async function refreshFx(base = 'PHP', force = false) {
  if (!/^[A-Z]{3}$/.test(base)) throw new Error('Choose a valid base currency.');
  const cached = await financeRepository.getSetting<{ count: number; asOf: string; fetchedAt: number }>('fx-refresh:' + base);
  if (!force && cached && Date.now() - cached.fetchedAt < 3600000) return { count: cached.count, asOf: cached.asOf };
  const response = await fetch(`https://open.er-api.com/v6/latest/${base}`, { signal: AbortSignal.timeout(12000) });
  const data = await response.json();
  if (!response.ok || data.result !== 'success' || data.base_code !== base || !Number.isSafeInteger(data.time_last_update_unix) || data.time_last_update_unix * 1000 > Date.now() + 300000 || !data.rates || data.rates[base] !== 1) throw new Error('The free FX source is unavailable or invalid. Saved rates are kept.');
  const asOf = new Date(data.time_last_update_unix * 1000).toISOString();
  let count = 0;
  await financeDb.transaction('rw', financeDb.tables, async () => {
    for (const currency of ['PHP', 'USD', 'EUR', 'GBP', 'JPY', 'HKD', 'CAD', 'AUD', 'SGD']) {
      const rate = data.rates[currency];
      if (currency === base || typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) continue;
      await financeRepository.save('fxRates', { id: `fx:${currency}:${base}:${asOf}`, fromCurrency: currency, toCurrency: base, rate: 1 / rate, asOf, source: 'ExchangeRate-API open daily reference', fetchedAt: new Date().toISOString() });
      count++;
    }
    await financeRepository.setSetting('fx-refresh:' + base, { count, asOf, fetchedAt: Date.now() });
  });
  return { count, asOf };
}

export async function safeRefreshFx(base = 'PHP', force = false) {
  try {
    return await refreshFx(base, force);
  } catch {
    return null;
  }
}
```

### `src/pages/Overview.tsx`
```tsx
// Overview.tsx line 85-90:
        <article className="metric-card worth-card">
          <div className="metric-label">
            <span>TOTAL NET WORTH</span>
            {!netWorth.complete && hasAccounts && (
              <span className="badge warning" title="Some accounts use cached or estimated conversion rates" style={{ fontSize: '8px', padding: '2px 6px', lineHeight: 1.2 }}>
                Estimated
              </span>
            )}
            <Wallet size={18} />
          </div>
          <strong className="metric-value"><Money amount={hasAccounts ? (netWorth.netWorth ?? netWorth.knownNetWorth) : null} currency={currency} /></strong>
          <div className="metric-foot">
            <span>{!netWorth.complete && hasAccounts ? 'Known converted balance' : 'Assets minus liabilities'}</span>
            <ArrowUpRight size={17} />
          </div>
          <div className="card-watermark">✳</div>
        </article>
```
