# Markets View UI Resilience: Investigation & Architectural Design Report

**Target Component**: `MarketsPage` (`src/pages/InvestmentPages.tsx`)  
**Domain**: Milestone 2 (Feature 9 — Markets UI Error Isolation & Feedback Resilience)  
**Author**: Explorer M2-2  
**Date**: 2026-10-10  

---

## 1. Executive Summary

This report delivers the technical investigation and architectural design for fixing two critical UI/UX resilience defects in Tala's `MarketsPage` (`src/pages/InvestmentPages.tsx`):

1. **Defect 1 (Global Error Cascade on Single Ticker Failure)**: In `loadCatalog`, concurrent quote fetching uses `Promise.all` over the top 8 visible tickers, but catches errors inside the map and calls `setError((e as Error).message)`. A failure in a single quote (e.g. unsupported ticker, network glitch, illiquid stock, or offline gateway) triggers a page-wide red error banner, confusing users and making healthy tickers appear broken. Furthermore, clicking on an unquoted ticker throws in `select()`, wiping out the selection and displaying another global error.
2. **Defect 2 (Success Feedback Rendered as Red Error Banner)**: In `saveInstrument()`, successfully saving a quote to Dexie IndexedDB calls `setError(`${quote.name} saved in Investments...`)`. Because the component only has an `error` state connected to `<ErrorMessage message={error}/>`, the application renders a scary red alert box (`.form-error`, `#fff0ed`) for a successful user operation.

We provide a complete, drop-in design that isolates quote errors per ticker using `Promise.allSettled`, introduces dedicated "Unavailable / Stale" cards for failed tickers, replaces the red banner anti-pattern with an accessible green success notice (`role="status"`), and prevents duplicate additions.

---

## 2. Root Cause Analysis

### 2.1 Defect 1: Single Quote Failure Cascades to Global Page Banner

- **Location**: `src/pages/InvestmentPages.tsx:68-71`
```tsx
68: await Promise.all(visible.slice(0,8).map(async record=>{
69:   try{const quote=await marketProvider.latestPrice(record.symbol);if(current())setQuotes(previous=>({...previous,[record.symbol]:quote}));}
70:   catch(e){if(current())setError((e as Error).message);}
71: }));
```
- **Mechanism**:
  1. `visible.slice(0, 8)` maps up to 8 market instruments to concurrent `latestPrice(record.symbol)` calls.
  2. If any single symbol fails (for example, Philippine stocks when gateway is offline, or international stocks without Parquet bars), the catch block at line 70 runs:
     `if (current()) setError((e as Error).message);`
  3. This sets the component-level `error` state.
  4. At line 114:
     `<ErrorMessage message={error}/>`
     Which renders:
     `<p className="form-error" role="alert">{message}</p>`
     Styled via `src/styles.css:7`:
     `.form-error { padding: 12px; background: #fff0ed; color: #9c3832; border-radius: 8px; font-size: 11px; line-height: 1.6; margin: 15px 0; }`
  5. The entire page displays a red error alert box across the top, even if the other 7 tickers loaded with valid prices!
  6. In addition, when the user clicks a row for an instrument that failed to load (`select(record)` at lines 85-89):
     ```tsx
     async function select(record:MarketInstrument){
       const version=++selectionVersion.current,catalog=catalogVersion.current;setError('');setSelected(null);setHistory([]);historyVersion.current++;
       try{const quote=quotes[record.symbol]||await marketProvider.latestPrice(record.symbol);if(version!==selectionVersion.current||catalog!==catalogVersion.current)return;setQuotes(previous=>({...previous,[record.symbol]:quote}));setSelected(quote);}
       catch(e){if(version===selectionVersion.current&&catalog===catalogVersion.current)setError((e as Error).message);}
     }
     ```
     `marketProvider.latestPrice` throws again, `setSelected(null)` keeps the detail pane closed, and `setError` triggers the red banner again. The user cannot see why the quote failed or take any corrective action.
  7. Similarly, in line 80, if historical chart data fails to load (`priceHistory`), it calls `setError((e as Error).message)`, setting the global red banner even though historical chart unavailability is already handled inline in the table (`line 124: !history.length && <p className="helper">No verified history is available for this range.</p>`).

### 2.2 Defect 2: Anti-Pattern Error Banner for Success Feedback

- **Location**: `src/pages/InvestmentPages.tsx:103`
```tsx
90:  async function saveInstrument(quote:MarketQuote){
...
102:      soundService.play('success');
103:      if(catalog===catalogVersion.current)setError(`${quote.name} saved in Investments. Record a purchase to create a holding.`);
104:    }catch(e){soundService.play('error');if(catalog===catalogVersion.current)setError((e as Error).message);}
105:    finally{setSaving(false);}
106:  }
```
- **Mechanism**:
  1. When an instrument quote is saved to `financeDb.instruments` and `financeDb.prices`, Tala plays the positive confirmation chime (`soundService.play('success')`).
  2. But because `MarketsPage` only declared `const [error, setError] = useState('')`, the developer reused `setError` to convey the success message.
  3. The message is rendered by `<ErrorMessage message={error}/>`.
  4. The user hears a cheerful success sound, then sees a red error alert box informing them that their instrument was successfully saved!
  5. Furthermore, if the user clicks the "Add to Investments" button again, line 98 throws `Error('This instrument is already in Investments.')`, playing the error chime and leaving a red banner.

---

## 3. Detailed Architectural Solution

### 3.1 Per-Ticker Quote Fetch Isolation
To achieve true UI resilience, quote fetching must follow strict fault isolation:

1. **Isolated State Maps**:
   ```tsx
   const [quoteErrors, setQuoteErrors] = useState<Record<string, string>>({});
   ```
   Tracks individual ticker error messages without polluting the global page error state.
2. **`Promise.allSettled` Batch Loading in `loadCatalog`**:
   ```tsx
   await Promise.allSettled(
     visible.slice(0, 8).map(async record => {
       try {
         const quote = await marketProvider.latestPrice(record.symbol);
         if (current()) {
           setQuotes(previous => ({ ...previous, [record.symbol]: quote }));
         }
       } catch (e) {
         if (current()) {
           const msg = e instanceof Error ? e.message : 'Quote unavailable';
           setQuoteErrors(previous => ({ ...previous, [record.symbol]: msg }));
         }
       }
     })
   );
   ```
   **Key Invariant**: Inside the quote fetching loop, global `setError` is **never called**.
   Global `setError` is strictly reserved for search catalog failures (e.g. gateway down, network offline, invalid query).
3. **Resilient Table Cell Indicators**:
   - Price column:
     - If quote resolved: Displays formatted price. If `quote.freshness === 'stale'` or `quote.isStale`, appends a `<span className="badge warning">Stale</span>` pill.
     - If quote error exists: Displays `<span className="badge warning" title={quoteErrors[record.symbol]}>Unavailable</span>`.
     - While pending: Displays `<span className="muted">—</span>`.
   - Change % column:
     - Valid finite percentage: `<TrendIndicator value={quote.changePercent} isPercent isMinor={false}/>`.
     - Unavailable / missing: `<span className="muted">—</span>`.
   - Source date column:
     - Resolved: Date string + `<small>{quote.freshness === 'eod' ? 'Daily close' : isStale ? 'Cached / Stale' : 'Source snapshot'}</small>`.
     - Failed: `<span className="muted">—</span><small className="muted">Offline / Error</small>`.
   - Source column:
     - Resolved: `quote.source`.
     - Failed: `<span className="muted" title={quoteErrors[record.symbol]}>Error: {quoteErrors[record.symbol].slice(0, 25)}…</span>`.

### 3.2 Dual Selection State: "Unavailable / Stale" Detail Card
Instead of setting `selected: MarketQuote | null`, split selection into:
```tsx
const [selectedInstrument, setSelectedInstrument] = useState<MarketInstrument | null>(null);
const [selectedQuote, setSelectedQuote] = useState<MarketQuote | null>(null);
```
When user clicks any ticker:
1. `setSelectedInstrument(record)` is always called.
2. If `quotes[record.symbol]` is already cached, `selectedQuote` is set immediately.
3. If not cached, attempt `marketProvider.latestPrice(record.symbol)`. If it succeeds, set `selectedQuote`. If it throws:
   - Record error in `quoteErrors[record.symbol]`.
   - Keep `selectedQuote` as `null`, but keep `selectedInstrument` active!
   - **Do NOT set global `error`**.
4. Rendering the Detail Card:
   - **When `selectedQuote` is present**:
     Renders the full live quote card with price, exchange, source attribution, history tabs (`1w`, `1m`, `3m`, `1y`), history table, and "Add to Investments" button.
   - **When `selectedQuote` is null (Quote Unavailable)**:
     Renders an **"Unavailable / Stale" Card**:
     - Shows instrument name, ticker symbol, currency, and exchange.
     - Displays `<span className="badge warning">Quote Unavailable</span>`.
     - Shows an informative notice:
       ```tsx
       <div className="notice warning">
         <strong>Public market data is currently unavailable for {selectedInstrument.symbol}.</strong>
         <p>{quoteErrors[selectedInstrument.symbol] || 'No verified quote could be retrieved from the market provider.'}</p>
         <p>You can still add this instrument to your personal portfolio and record purchase transactions or dated statement values manually.</p>
       </div>
       ```
     - Provides an action button: `"Add with Manual Valuation"`, allowing the user to add the instrument to `financeDb.instruments` with `valuationMethod: 'MANUAL_PRICE'`.
     - Explains: `"Price history chart is unavailable while the external market provider is offline or unverified."` without throwing.

### 3.3 Success Feedback Banner
1. **Dedicated State**:
   ```tsx
   const [successMessage, setSuccessMessage] = useState('');
   ```
2. **Auto-Dismiss Timer**:
   ```tsx
   useEffect(() => {
     if (!successMessage) return;
     const timer = setTimeout(() => setSuccessMessage(''), 5000);
     return () => clearTimeout(timer);
   }, [successMessage]);
   ```
3. **Reset Triggers**:
   `setSuccessMessage('')` is called when initiating a new search, changing the market, or clicking the dismiss button.
4. **Visual Design & Accessibility**:
   The banner adheres to Tala design tokens (`var(--green)`, `#1f664a`, `#eef7ee`):
   ```tsx
   {successMessage && (
     <div
       className="notice success"
       role="status"
       aria-live="polite"
       style={{
         background: '#eef7ee',
         borderColor: '#b9ebbc',
         color: '#173c34',
         display: 'flex',
         alignItems: 'center',
         justifyContent: 'space-between',
         gap: '12px',
         marginBottom: '20px',
         padding: '14px 18px',
         borderRadius: '9px',
         border: '1px solid #b9ebbc',
       }}
     >
       <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
         <span style={{ color: '#1f664a', fontWeight: 'bold' }}>✓</span>
         <span>{successMessage}</span>
       </div>
       <button
         type="button"
         className="icon-button"
         aria-label="Dismiss notification"
         onClick={() => setSuccessMessage('')}
         style={{ width: '28px', height: '28px', fontSize: '18px', border: 0, background: 'transparent' }}
       >
         ×
       </button>
     </div>
   )}
   ```
5. **Duplicate-Add Protection**:
   Query existing saved instruments using `useLiveQuery`:
   ```tsx
   const savedInstruments = useLiveQuery(
     () => financeDb.instruments.filter(i => !i.deletedAt).toArray(),
     []
   );
   const savedSymbols = new Set((savedInstruments || []).map(i => i.sourceSymbol || i.symbol));
   ```
   When `savedSymbols.has(selectedSymbol)` is true, the button renders:
   `<button className="button" disabled={true}>In Investments</button>`
   This prevents user confusion and avoids triggering duplicate key errors in IndexedDB.

---

## 4. Proposed Code Implementation for `MarketsPage`

Here is the complete, proposed drop-in replacement for `MarketsPage` in `src/pages/InvestmentPages.tsx:56-127`:

```tsx
export function MarketsPage() {
  const [market, setMarket] = useState('PH');
  const [query, setQuery] = useState('');
  const [records, setRecords] = useState<MarketInstrument[]>([]);
  const [quotes, setQuotes] = useState<Record<string, MarketQuote>>({});
  const [quoteErrors, setQuoteErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [selectedInstrument, setSelectedInstrument] = useState<MarketInstrument | null>(null);
  const [selectedQuote, setSelectedQuote] = useState<MarketQuote | null>(null);
  const [history, setHistory] = useState<{ date: string; close: number | null }[]>([]);
  const [historyError, setHistoryError] = useState('');
  const [range, setRange] = useState('1m');

  const catalogVersion = useRef(0);
  const selectionVersion = useRef(0);
  const historyVersion = useRef(0);
  const currentMarket = useRef(market);
  currentMarket.current = market;

  // Track instruments already added to user portfolio
  const savedInstruments = useLiveQuery(
    () => financeDb.instruments.filter(i => !i.deletedAt).toArray(),
    []
  );
  const savedSymbols = new Set((savedInstruments || []).map(i => i.sourceSymbol || i.symbol));

  // Auto-dismiss success notification after 5 seconds
  useEffect(() => {
    if (!successMessage) return;
    const timer = setTimeout(() => setSuccessMessage(''), 5000);
    return () => clearTimeout(timer);
  }, [successMessage]);

  function invalidateSelection() {
    selectionVersion.current++;
    historyVersion.current++;
    setSelectedInstrument(null);
    setSelectedQuote(null);
    setHistory([]);
    setHistoryError('');
  }

  async function loadCatalog(searchQuery: string, requestedMarket: string) {
    const version = ++catalogVersion.current;
    const current = () => catalogVersion.current === version && currentMarket.current === requestedMarket;
    invalidateSelection();
    setRecords([]);
    setQuotes({});
    setQuoteErrors({});
    setError('');
    setSuccessMessage('');
    setBusy(true);

    try {
      const rows = await marketProvider.search(searchQuery, requestedMarket);
      if (!current()) return;
      const visible = rows.slice(0, searchQuery.trim() ? 20 : 8);
      setRecords(visible);

      // Fault-isolated quote fetching: a single failed quote NEVER triggers global page error
      await Promise.allSettled(
        visible.slice(0, 8).map(async record => {
          try {
            const quote = await marketProvider.latestPrice(record.symbol);
            if (current()) {
              setQuotes(previous => ({ ...previous, [record.symbol]: quote }));
            }
          } catch (e) {
            if (current()) {
              const msg = e instanceof Error ? e.message : 'Quote unavailable';
              setQuoteErrors(previous => ({ ...previous, [record.symbol]: msg }));
            }
          }
        })
      );
    } catch (e) {
      if (current()) setError((e as Error).message);
    } finally {
      if (current()) setBusy(false);
    }
  }

  useEffect(() => {
    void loadCatalog('', market);
    return () => {
      catalogVersion.current++;
      selectionVersion.current++;
      historyVersion.current++;
    };
  }, [market]);

  useEffect(() => {
    const version = ++historyVersion.current;
    setHistory([]);
    setHistoryError('');
    const targetSymbol = selectedQuote?.symbol || selectedInstrument?.symbol;
    if (!targetSymbol) return;

    marketProvider
      .priceHistory(targetSymbol, range)
      .then(result => {
        if (historyVersion.current === version) {
          setHistory(
            result.points.filter(
              point =>
                validDate(point.date) &&
                typeof point.close === 'number' &&
                Number.isFinite(point.close) &&
                point.close >= 0
            )
          );
        }
      })
      .catch(e => {
        if (historyVersion.current === version) {
          setHistoryError((e as Error).message);
        }
      });

    return () => {
      historyVersion.current++;
    };
  }, [selectedQuote, selectedInstrument, range]);

  function changeMarket(value: string) {
    catalogVersion.current++;
    invalidateSelection();
    currentMarket.current = value;
    setMarket(value);
    setQuery('');
    setBusy(true);
  }

  function search(e: FormEvent) {
    e.preventDefault();
    void loadCatalog(query, market);
  }

  async function select(record: MarketInstrument) {
    const version = ++selectionVersion.current,
      catalog = catalogVersion.current;
    setError('');
    setSelectedInstrument(record);
    setSelectedQuote(quotes[record.symbol] || null);
    setHistory([]);
    setHistoryError('');
    historyVersion.current++;

    if (!quotes[record.symbol]) {
      try {
        const quote = await marketProvider.latestPrice(record.symbol);
        if (version !== selectionVersion.current || catalog !== catalogVersion.current) return;
        setQuotes(previous => ({ ...previous, [record.symbol]: quote }));
        setSelectedQuote(quote);
      } catch (e) {
        if (version === selectionVersion.current && catalog === catalogVersion.current) {
          const msg = e instanceof Error ? e.message : 'Quote unavailable';
          setQuoteErrors(previous => ({ ...previous, [record.symbol]: msg }));
        }
      }
    }
  }

  async function saveInstrument(quote: MarketQuote) {
    const catalog = catalogVersion.current;
    setSaving(true);
    setError('');
    setSuccessMessage('');
    try {
      if (!Number.isFinite(quote.value) || quote.value < 0 || !Number.isFinite(Date.parse(quote.asOf))) {
        throw new Error('The source valuation is invalid.');
      }
      const foreign = quote.symbol.includes(':');
      const etf = (quote.assetType || '').toLowerCase() === 'etf';
      const instrument: Instrument = {
        id: crypto.randomUUID(),
        name: quote.name,
        symbol: quote.symbol,
        sourceSymbol: quote.symbol,
        instrumentType: foreign ? (etf ? 'FOREIGN_ETF' : 'FOREIGN_STOCK') : etf ? 'PSE_ETF' : 'PSE_STOCK',
        currency: quote.currency,
        valuationMethod: 'LIVE_MARKET',
      };
      await financeDb.transaction('rw', financeDb.tables, async () => {
        const existing = await financeDb.instruments
          .where('sourceSymbol')
          .equals(quote.symbol)
          .filter(row => !row.deletedAt)
          .first();
        if (existing) throw new Error('This instrument is already in Investments.');
        await financeRepository.save('instruments', instrument);
        await financeRepository.save('prices', {
          id: crypto.randomUUID(),
          instrumentId: instrument.id,
          value: quote.value,
          currency: quote.currency,
          asOf: quote.asOf,
          fetchedAt: new Date().toISOString(),
          source: quote.source,
          sourceSymbol: quote.symbol,
          staleAfter: new Date(Date.parse(quote.asOf) + 3 * 86400000).toISOString(),
          status: Date.now() - Date.parse(quote.asOf) > 3 * 86400000 ? 'stale' : 'fresh',
        });
      });
      soundService.play('success');
      if (catalog === catalogVersion.current) {
        setSuccessMessage(`${quote.name} (${quote.symbol}) saved in Investments. Record a purchase to create a holding.`);
      }
    } catch (e) {
      soundService.play('error');
      if (catalog === catalogVersion.current) setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function saveUnavailableInstrument(record: MarketInstrument) {
    const catalog = catalogVersion.current;
    setSaving(true);
    setError('');
    setSuccessMessage('');
    try {
      const foreign = record.symbol.includes(':');
      const etf = (record.assetType || '').toLowerCase() === 'etf';
      const instrument: Instrument = {
        id: crypto.randomUUID(),
        name: record.name,
        symbol: record.symbol,
        sourceSymbol: record.symbol,
        instrumentType: foreign ? (etf ? 'FOREIGN_ETF' : 'FOREIGN_STOCK') : etf ? 'PSE_ETF' : 'PSE_STOCK',
        currency: record.currency,
        valuationMethod: 'MANUAL_PRICE',
      };
      await financeDb.transaction('rw', financeDb.tables, async () => {
        const existing = await financeDb.instruments
          .where('sourceSymbol')
          .equals(record.symbol)
          .filter(row => !row.deletedAt)
          .first();
        if (existing) throw new Error('This instrument is already in Investments.');
        await financeRepository.save('instruments', instrument);
      });
      soundService.play('success');
      if (catalog === catalogVersion.current) {
        setSuccessMessage(`${record.name} (${record.symbol}) saved in Investments with manual valuation. Add a manual unit price anytime.`);
      }
    } catch (e) {
      soundService.play('error');
      if (catalog === catalogVersion.current) setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <PageHeading
        eyebrow="A WIDER PERSPECTIVE"
        title="Markets beyond borders"
        description="Free public quotes, original currencies, and clear source dates. Market requests contain tickers only."
      />
      <div className="card page-section">
        <form className="inline-form" onSubmit={search}>
          <Field label="Stock market">
            <select value={market} onChange={e => changeMarket(e.target.value)}>
              {Object.entries(marketNames).map(([code, name]) => (
                <option value={code} key={code}>
                  {name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Company or ticker">
            <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search a company or exchange ticker" />
          </Field>
          <button className="button primary" disabled={busy}>
            <Search size={14} />
            {busy ? 'Loading…' : 'Search'}
          </button>
        </form>
        <p className="helper" style={{ marginTop: 13 }}>
          Some free international records are older or unavailable. Unverified units and stale records are never presented as current prices. Philippine prices on GitHub Pages require a configured gateway; personal finance works without it.
        </p>
      </div>

      <ErrorMessage message={error} />

      {successMessage && (
        <div
          className="notice success"
          role="status"
          aria-live="polite"
          style={{
            background: '#eef7ee',
            borderColor: '#b9ebbc',
            color: '#173c34',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '12px',
            marginBottom: '20px',
            padding: '14px 18px',
            borderRadius: '9px',
            border: '1px solid #b9ebbc',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ color: '#1f664a', fontWeight: 'bold' }}>✓</span>
            <span>{successMessage}</span>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Dismiss notification"
            onClick={() => setSuccessMessage('')}
            style={{ width: '28px', height: '28px', fontSize: '18px', border: 0, background: 'transparent' }}
          >
            ×
          </button>
        </div>
      )}

      <div className="card page-section">
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Instrument</th>
                <th>Price</th>
                <th>Change %</th>
                <th>Source date</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {records.map(record => {
                const quote = quotes[record.symbol];
                const tickerError = quoteErrors[record.symbol];
                const isStale = quote?.freshness === 'stale' || (quote as any)?.isStale;
                return (
                  <tr key={record.symbol}>
                    <td>
                      <button className="text-link" style={{ border: 0, background: 'none' }} onClick={() => select(record)}>
                        {record.symbol}
                      </button>
                      <small>{record.name}</small>
                    </td>
                    <td>
                      {quote ? (
                        <div style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                          <span>
                            {new Intl.NumberFormat('en', {
                              style: 'currency',
                              currency: quote.currency,
                              currencyDisplay: 'code',
                            }).format(quote.value)}
                          </span>
                          {isStale && <span className="badge warning">Stale</span>}
                        </div>
                      ) : tickerError ? (
                        <span className="badge warning" title={tickerError}>
                          Unavailable
                        </span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td>
                      <TrendIndicator
                        value={typeof quote?.changePercent === 'number' && Number.isFinite(quote.changePercent) ? quote.changePercent : null}
                        isPercent
                        isMinor={false}
                      />
                    </td>
                    <td>
                      {quote?.asOf?.slice(0, 10) || '—'}
                      <small>
                        {quote?.freshness === 'eod'
                          ? 'Daily close'
                          : isStale
                          ? 'Cached / Stale'
                          : quote
                          ? 'Source snapshot'
                          : tickerError
                          ? 'Offline / Error'
                          : 'Awaiting quote'}
                      </small>
                    </td>
                    <td>
                      {quote ? (
                        quote.source
                      ) : tickerError ? (
                        <span className="muted" title={tickerError}>
                          Error: {tickerError.slice(0, 30)}…
                        </span>
                      ) : (
                        'Awaiting source'
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!records.length && !busy && (
          <EmptyState
            view="watchlist"
            title="Search a market to explore"
            description="Missing data stays unavailable. Use a manual valuation for your own investments anytime."
          />
        )}
      </div>

      {selectedInstrument && (
        <div className="card">
          {selectedQuote ? (
            <>
              <div className="section-title">
                <div>
                  <span className="eyebrow">
                    {selectedQuote.currency} · {selectedQuote.exchange || selectedInstrument.market || 'Market'}
                    {(selectedQuote.freshness === 'stale' || (selectedQuote as any).isStale) && (
                      <span className="badge warning" style={{ marginLeft: 8 }}>
                        Stale / Offline
                      </span>
                    )}
                  </span>
                  <h2>
                    {selectedQuote.name} ({selectedQuote.symbol})
                  </h2>
                </div>
                <button
                  className="button primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-tala-green"
                  disabled={saving || savedSymbols.has(selectedQuote.symbol)}
                  onClick={() => saveInstrument(selectedQuote)}
                >
                  {savedSymbols.has(selectedQuote.symbol) ? 'In Investments' : saving ? 'Saving…' : 'Add to Investments'}
                </button>
              </div>
              <p className="helper">
                {selectedQuote.source} · As of {selectedQuote.asOf}{' '}
                {selectedQuote.sourceUrl && (
                  <a className="source-link" href={selectedQuote.sourceUrl} target="_blank" rel="noreferrer">
                    Source ↗
                  </a>
                )}
              </p>
              <div className="tabs">
                {['1w', '1m', '3m', '1y'].map(value => (
                  <button key={value} className={range === value ? 'active' : ''} onClick={() => setRange(value)}>
                    {value.toUpperCase()}
                  </button>
                ))}
              </div>
              <div className="import-preview">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Exchange session date</th>
                      <th>Close ({selectedQuote.currency})</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...history].reverse().map(point => (
                      <tr key={point.date}>
                        <td>{point.date}</td>
                        <td>{point.close?.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!history.length && (
                <p className="helper">
                  {historyError ? `Price history unavailable: ${historyError}` : 'No verified history is available for this range.'}
                </p>
              )}
            </>
          ) : (
            <>
              <div className="section-title">
                <div>
                  <span className="eyebrow">
                    {selectedInstrument.currency} · {selectedInstrument.exchange || selectedInstrument.market || 'Market'}
                    <span className="badge warning" style={{ marginLeft: 8 }}>
                      Quote Unavailable
                    </span>
                  </span>
                  <h2>
                    {selectedInstrument.name} ({selectedInstrument.symbol})
                  </h2>
                </div>
                <button
                  className="button primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-tala-green"
                  disabled={saving || savedSymbols.has(selectedInstrument.symbol)}
                  onClick={() => saveUnavailableInstrument(selectedInstrument)}
                >
                  {savedSymbols.has(selectedInstrument.symbol) ? 'In Investments' : saving ? 'Saving…' : 'Add with Manual Valuation'}
                </button>
              </div>
              <div className="notice warning" style={{ marginTop: 12 }}>
                <strong>Public market data is currently unavailable for {selectedInstrument.symbol}.</strong>
                <p style={{ marginTop: 4 }}>
                  {quoteErrors[selectedInstrument.symbol] || 'No verified quote could be retrieved from the market provider.'}
                </p>
                <p style={{ marginTop: 4 }}>
                  You can still add this instrument to your personal portfolio and record purchase transactions or dated statement values manually.
                </p>
              </div>
              <p className="helper" style={{ marginTop: 15 }}>
                Price history chart is unavailable while the external market provider is offline or unverified.
              </p>
            </>
          )}
        </div>
      )}
    </>
  );
}
```

---

## 5. Test Strategy & Verification Plan

### 5.1 Proposed Test Suite: `tests/markets-resilience.test.ts`
Implementer M2-2 should create unit and component tests verifying:

1. **Per-Ticker Error Isolation**:
   - Mock `marketProvider.search` returning 3 symbols (`['SYM_OK_1', 'SYM_FAIL', 'SYM_OK_2']`).
   - Mock `marketProvider.latestPrice('SYM_OK_1')` returning a valid quote.
   - Mock `marketProvider.latestPrice('SYM_FAIL')` throwing `Error('Quote unavailable')`.
   - Mock `marketProvider.latestPrice('SYM_OK_2')` returning a valid quote.
   - Assert `quoteErrors['SYM_FAIL']` is set to `'Quote unavailable'`.
   - Assert `quotes['SYM_OK_1']` and `quotes['SYM_OK_2']` contain valid quotes.
   - Assert global `error` is empty string (`""`).
2. **Unavailable Detail Card Rendering**:
   - When user clicks `SYM_FAIL`, assert the component displays the "Unavailable / Stale" detail card with the specific error message and `"Add with Manual Valuation"` button.
   - Assert no global red `<ErrorMessage />` is triggered.
3. **Success Notice Verification**:
   - Call `saveInstrument(quote)`.
   - Assert `successMessage` is populated with `"... saved in Investments"`.
   - Assert `error` is empty string (`""`).
   - Assert the success banner renders with `role="status"` and light green styling.
4. **Already Saved Protection**:
   - Assert button displays `"In Investments"` and `disabled={true}` when instrument is already present in `financeDb.instruments`.

---

## 6. Implementation Handoff Recommendations

- **Target file**: `src/pages/InvestmentPages.tsx` (specifically `MarketsPage` component, lines 56-127).
- **Zero build breaks**: All imports (`useLiveQuery`, `financeDb`, `financeRepository`, `marketProvider`, `soundService`, `PageHeading`, `Field`, `ErrorMessage`, `TrendIndicator`, `EmptyState`, etc.) are already in `InvestmentPages.tsx`!
- **CSS compatibility**: Uses existing classes (`.card`, `.section-title`, `.eyebrow`, `.badge`, `.badge.warning`, `.notice`, `.notice.warning`, `.helper`, `.data-table`, `.button`, `.button.primary`, `.table-scroll`) and standard inline styles.
