# Tala — personal finance, investments and FIRE

A React + TypeScript application with an IndexedDB transaction ledger, budgets, investment valuations, debt views, reports and configurable FIRE projections. It starts empty: there are no invented personal balances or income. Public market feeds cover Philippine and international instruments; manual prices, NAV and dated FX work offline.

## Run

Use Node 24 or newer and Google Chrome for browser checks.

```sh
npm ci
npm run dev              # http://127.0.0.1:5173
npm run market:dev       # separate terminal; free PH gateway on port 5180
npm run build
npm run preview          # http://127.0.0.1:5174; installable/offline production build
```

The production preview is needed to test the service worker. The development server deliberately does not install one. International browser feeds can use the public daily mirror without the local gateway; Philippine feeds need the gateway or a configured HTTPS adapter. Finances and manual valuations work without either.

## Accounting and storage

`src/core/` contains pure calculations. Money is stored as integer minor units in each native currency; instrument prices use major units and holdings support fractional units. `src/db/` uses Dexie as the source of truth. React subscribes with `useLiveQuery`; local writes atomically update transactions, postings, lots and the sync outbox. Financial records are never stored in localStorage or committed to this repository.

- Asset balances are amounts held; liability balances are amounts owed. Net worth subtracts liabilities.
- Transfers affect balances without becoming income or expenses. Cross-currency transfers require an explicit received amount.
- A card purchase increases spending and card debt once. Paying the card reduces cash and debt without adding spending. Explicit non-card loan principal can optionally affect the savings calculation; unsplit principal is not guessed.
- Investment buys reduce cash and add units and cost basis. Sales use weighted average cost, including fees. Dividends are income. Purchases are excluded from consumption budgets.
- A missing price or FX rate makes affected totals incomplete. Refresh errors retain the previous valid value and original valuation date, with a stale indicator.
- Manual total values and NAVs retain statement dates. Compounding and FIRE curves are labelled projections; assumed maturity returns never replace actual assets.
- Recurring rules show due reminders and create a transaction only after confirmation. Duplicate occurrences and imports are prevented atomically.
- Transactions use indexed, filtered, bounded pages. Overview cash flow streams a date index into monthly summaries. Investments are aggregated into positions; full transaction histories are not held in React state.

Add accounts first, then record transactions. Account flags control net worth, liquid assets, FIRE and emergency funds. Budgets can include a category’s descendants. Settings supports category hierarchy, archive and merge. FIRE spending, withdrawal rate, contributions, inflation, return assumptions and milestone targets are editable. Recorded daily net-worth snapshots appear in Reports after opening Overview with complete valuations.

## Backups and imports

Data & sync exports a full versioned JSON database and transactions, investments and recorded net-worth CSVs. An optional password encrypts the backup with WebCrypto AES-256-GCM and PBKDF2; the password is not stored. Restore validates format, financial boundaries, references and ledger consistency before an explicitly confirmed atomic replacement. Restore always disables cloud sync.

CSV statement import maps date, signed amount or debit/credit, merchant and reference columns. Dates have an explicit format. Preview shows duplicates and the first 100 rows; imports are capped at 25,000 rows per file. Mapping templates are stored locally by institution name. The importer handles income and expenses; use transfer and investment forms for their corresponding accounting semantics. Manual NAV history has a separate dated preview in Investments.

IndexedDB belongs to the browser profile and site origin. Moving from localhost to GitHub Pages requires backup/export and restore at the destination. Persistent storage is requested after the first account and can be requested again in Data & sync; browsers decide whether to grant it. Clearing browser storage clears local records.

## Free prices

`src/market/providers.ts` implements a replaceable search / latest-price / history interface. Locally, the gateway uses Yahoo public snapshots with a [Crible](https://github.com/maxgfr/crible) daily-data fallback. On static hosting, international requests go directly to the browser-compatible Crible daily reader. The app also uses that reader if the local gateway fails. It validates decoded file sizes and Parquet signatures when CORS hides range headers. The mirror preserves source date, native currency and upstream identity; stale current records and ambiguous price units are rejected. These sources do not promise real-time availability or complete market coverage.

The local Philippine adapter reads PSE EDGE with its named 21-stock public mirror fallback. See [MARKETS.md](MARKETS.md) for existing market-dashboard details and [worker/README.md](worker/README.md) for an optional separate gateway. The original dashboard is packaged under `legacy-market/`; its explicit sample mode is separate from the personal finance ledger.

Optional daily FX uses the [ExchangeRate-API open endpoint](https://www.exchangerate-api.com/docs/free), retains the provider’s date, and caches refreshes for an hour. [Rates by ExchangeRate-API](https://www.exchangerate-api.com). Manual dated conversion rates are also supported. No private market credential is bundled into this application.

## Optional Supabase synchronization

Local Only is the default and the sync engine returns before any financial provider call. Public price requests contain ticker or currency identifiers only. Cloud synchronization is an explicit optional feature.

1. Create your own Supabase project, then run [supabase/schema.sql](supabase/schema.sql) in its SQL editor. Review the owner RLS policies, compare-and-swap RPC and private Realtime broadcast policy.
2. In Data & sync, save the project HTTPS URL and its **publishable or anon** browser key. Privileged/service-role keys are rejected.
3. Sign in or register, including email confirmation if your project requires it.
4. Review the upload consent and select **Enable cloud sync**. Signing in alone does not authorize finance uploads.

The authenticated owner is bound to local records; switching owners with an existing database is blocked. Auth sessions stay in IndexedDB sync state and are excluded from backups. Writes are queued locally and retried after connectivity returns. Server versions use compare-and-swap; conflicts retain both values for manual review. Tombstones preserve deletes. Incoming records are owner- and schema-validated before local application. Private Realtime updates are written to IndexedDB.

Choose **Use Local Only** to stop financial sync; queued changes stay available locally. Configuration or connectivity errors do not prevent offline finance work. No remote Supabase account is configured by the repository. Live two-device sync and owner-isolation acceptance must be verified against your configured project; local contract tests do not substitute for those live checks.

## Verification

```sh
npm run typecheck
npm test                 # financial engine, atomic repository, imports, backups and sync
npm run test:market      # existing public feed/client/gateway contracts
npm run build
npm run test:browser     # isolated production browser, offline reload and subpath checks
npm run check:source     # optional real external market probe
npm run test:browser -- --live-source   # actual Yahoo quotes through preview + local gateway
npm run test:browser -- --static-source # actual daily mirror, with no market gateway
```

Browser checks use an isolated profile and an ephemeral local production server. Set `CHROME_PATH` if Google Chrome is installed elsewhere. Screenshots and results are saved under ignored `artifacts/`; they contain test records only. Test fixtures never seed the app’s normal database.

## GitHub Pages

Put this directory at your repository root, push to `main`, and choose **GitHub Actions** under Settings → Pages. [.github/workflows/pages.yml](.github/workflows/pages.yml) runs checks and uploads only `dist/`. It publishes the app shell and public market assets, never IndexedDB records or server configuration. No repository or external account has been configured or published here.

Vite uses relative assets and HashRouter so repository subpaths need no rewrites. The PWA precaches the application shell and routes; opening it online once permits subsequent offline reloads. Service-worker updates display a prompt so you can save an open form before reloading. Core finances keep working when quote requests fail. For an explicit path build, set `VITE_BASE=/repository-name/` before `npm run build`.
