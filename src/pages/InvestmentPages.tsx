import { useEffect, useRef, useState, type FormEvent } from 'react';
import Papa from 'papaparse';
import { useLiveQuery } from 'dexie-react-hooks';
import { Plus, RefreshCw, Search, Trash2, LineChart } from 'lucide-react';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import { financeDb } from '../db/database';
import { financeRepository } from '../db/repository';
import { INSTRUMENT_TYPES, type Instrument, type Transaction, type ValuationMethod } from '../core/types';
import { toMinor, validDate, convertMoney, calculatePositions } from '../core/calculations';
import { useFinance } from '../ui/useFinance';
import { Dialog, Field, PageHeading, Money, ErrorMessage, today } from '../ui/shared';
import { EmptyState } from '../components/EmptyState';
import { TrendIndicator } from '../components/TrendIndicator';
import { marketProvider, refreshInstrumentPrice, type MarketInstrument, type MarketQuote } from '../market/providers';
import { soundService } from '../ui/soundManager';
import { useReducedMotion } from '../hooks/useReducedMotion';

const methodNames: Record<ValuationMethod, string> = {
  LIVE_MARKET: 'Market quote',
  DAILY_NAV: 'Daily NAV',
  MANUAL_PRICE: 'Manual unit price',
  FIXED_PRINCIPAL: 'Fixed principal',
  COMPOUNDING: 'Compounding projection',
  MANUAL_VALUE: 'Manual position value',
};

const marketNames: Record<string, string> = {
  PH: 'Philippines',
  US: 'United States',
  HK: 'Hong Kong',
  JP: 'Japan',
  GB: 'United Kingdom',
  CA: 'Canada',
  AU: 'Australia',
};

const currencies = ['PHP', 'USD', 'EUR', 'GBP', 'JPY', 'HKD', 'CAD', 'AUD', 'SGD'];

function enteredNumber(form: FormData, name: string, allowZero = true) {
  const raw = String(form.get(name) ?? '').trim(),
    value = Number(raw);
  if (!raw || !Number.isFinite(value) || value < 0 || (!allowZero && value === 0))
    throw new Error('Enter a valid ' + name + ' value.');
  return value;
}

function valuationDate(form: FormData) {
  const value = String(form.get('date') ?? '');
  if (!validDate(value) || value > today()) throw new Error('Enter a valid valuation date through today.');
  return value;
}

function getAssetCategory(type: string): { label: string; color: string; key: string } {
  const t = type.toUpperCase();
  if (['PSE_STOCK', 'PSE_REIT', 'FOREIGN_STOCK'].includes(t)) {
    return { key: 'equity', label: 'Equities & Stocks', color: '#1f664a' };
  }
  if (['UITF', 'MUTUAL_FUND', 'PSE_ETF', 'FOREIGN_ETF', 'PERA'].includes(t)) {
    return { key: 'funds', label: 'Funds & ETFs', color: '#6d549e' };
  }
  if (['PAGIBIG_MP2', 'TIME_DEPOSIT', 'BOND'].includes(t)) {
    return { key: 'fixed_income', label: 'Fixed Income & Gov', color: '#d9b76c' };
  }
  return { key: 'alternatives', label: 'Alternatives & Other', color: '#4c958d' };
}

function HoldingSparkline({ instrumentId, currency }: { instrumentId: string; currency: string }) {
  const prefersReducedMotion = useReducedMotion();
  const prices = useLiveQuery(
    () =>
      financeDb.prices
        .where('instrumentId')
        .equals(instrumentId)
        .filter(p => !p.deletedAt && Number.isFinite(p.value) && p.value > 0)
        .sortBy('asOf'),
    [instrumentId]
  );

  if (!prices || prices.length < 2) {
    return (
      <div style={{ padding: '6px 0', color: '#799688', fontSize: '10px' }}>
        <small>{prices?.length === 1 ? '1 recorded valuation point' : 'No price trend yet'}</small>
      </div>
    );
  }

  const chartData = prices.map(p => ({
    date: p.asOf.slice(0, 10),
    value: p.value,
  }));
  const first = prices[0].value;
  const latest = prices.at(-1)!.value;
  const isUp = latest >= first;
  const pct = first > 0 ? ((latest - first) / first) * 100 : 0;
  const strokeColor = isUp ? '#1f664a' : '#9c3832';

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', height: '40px', margin: '10px 0' }}>
      <div style={{ flex: 1, height: '100%' }}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={chartData} margin={{ top: 2, right: 2, left: 2, bottom: 2 }}>
            <defs>
              <linearGradient id={`spark-${instrumentId}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={strokeColor} stopOpacity={0.3} />
                <stop offset="100%" stopColor={strokeColor} stopOpacity={0.0} />
              </linearGradient>
            </defs>
            <Tooltip
              formatter={v => [
                new Intl.NumberFormat('en', { style: 'currency', currency, currencyDisplay: 'code' }).format(Number(v)),
                'Price',
              ]}
              labelFormatter={l => `Date: ${l}`}
            />
            <Area
              isAnimationActive={!prefersReducedMotion}
              type="monotone"
              dataKey="value"
              stroke={strokeColor}
              strokeWidth={1.8}
              fill={`url(#spark-${instrumentId})`}
              dot={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <span
        style={{
          fontSize: '10px',
          fontWeight: 600,
          whiteSpace: 'nowrap',
          color: strokeColor,
          background: isUp ? '#eef7ee' : '#fff0ed',
          padding: '2px 6px',
          borderRadius: '4px',
        }}
      >
        {isUp ? '↗ +' : '↘ '}
        {pct.toFixed(2)}%
      </span>
    </div>
  );
}

function HoldingHistoryModal({ instrument, onClose }: { instrument: Instrument; onClose: () => void }) {
  const prefersReducedMotion = useReducedMotion();
  const [range, setRange] = useState<'1m' | '3m' | '6m' | '1y' | 'all'>('6m');
  const allPrices = useLiveQuery(
    () =>
      financeDb.prices
        .where('instrumentId')
        .equals(instrument.id)
        .filter(p => !p.deletedAt && Number.isFinite(p.value) && p.value > 0)
        .sortBy('asOf'),
    [instrument.id]
  );

  const filteredPrices = (allPrices || []).filter(p => {
    if (range === 'all') return true;
    const now = Date.now();
    const days = range === '1m' ? 30 : range === '3m' ? 90 : range === '6m' ? 180 : 365;
    return now - Date.parse(p.asOf) <= days * 86400000;
  });

  const chartData = filteredPrices.map(p => ({
    date: p.asOf.slice(0, 10),
    value: p.value,
  }));

  const values = filteredPrices.map(p => p.value);
  const high = values.length ? Math.max(...values) : null;
  const low = values.length ? Math.min(...values) : null;
  const current = values.length ? values.at(-1)! : null;
  const first = values.length ? values[0] : null;
  const diff = current !== null && first !== null ? current - first : null;
  const pct = first && diff !== null ? (diff / first) * 100 : null;

  return (
    <Dialog title={`${instrument.name} — Price Performance`} onClose={onClose}>
      <div className="section-title">
        <div>
          <span className="eyebrow">
            {instrument.currency} · {instrument.instrumentType.replaceAll('_', ' ')}
          </span>
          <h2>{instrument.name}</h2>
        </div>
      </div>
      <div className="tabs">
        {(['1m', '3m', '6m', '1y', 'all'] as const).map(tab => (
          <button key={tab} className={range === tab ? 'active' : ''} onClick={() => setRange(tab)}>
            {tab.toUpperCase()}
          </button>
        ))}
      </div>
      <div className="mini-stat-row" style={{ margin: '15px 0' }}>
        <div>
          <span>Latest</span>
          <strong>{current !== null ? `${current.toFixed(2)} ${instrument.currency}` : '—'}</strong>
        </div>
        <div>
          <span>Period change</span>
          <strong>
            <TrendIndicator value={pct} isPercent isMinor={false} />
          </strong>
        </div>
        <div>
          <span>High</span>
          <strong>{high !== null ? `${high.toFixed(2)} ${instrument.currency}` : '—'}</strong>
        </div>
        <div>
          <span>Low</span>
          <strong>{low !== null ? `${low.toFixed(2)} ${instrument.currency}` : '—'}</strong>
        </div>
      </div>
      {chartData.length >= 2 ? (
        <div style={{ height: '220px', width: '100%', margin: '20px 0' }}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData}>
              <defs>
                <linearGradient id={`historyFade-${instrument.id}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#1f664a" stopOpacity={0.25} />
                  <stop offset="100%" stopColor="#1f664a" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} stroke="#edf0ec" />
              <XAxis dataKey="date" fontSize={10} tickLine={false} axisLine={false} />
              <YAxis fontSize={10} tickLine={false} axisLine={false} width={50} />
              <Tooltip formatter={v => [`${Number(v).toFixed(2)} ${instrument.currency}`, 'Price']} />
              <Area
                isAnimationActive={!prefersReducedMotion}
                type="monotone"
                dataKey="value"
                stroke="#1f664a"
                strokeWidth={2}
                fill={`url(#historyFade-${instrument.id})`}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <p className="helper" style={{ textAlign: 'center', padding: '30px 0' }}>
          {chartData.length === 1 ? 'Only 1 recorded price point for this time range.' : 'No recorded price points in this period.'}
        </p>
      )}
      <div className="import-preview" style={{ maxHeight: '200px', overflowY: 'auto' }}>
        <table className="data-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Valuation ({instrument.currency})</th>
              <th>Source</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {[...filteredPrices].reverse().map(p => (
              <tr key={p.id}>
                <td>{p.asOf.slice(0, 10)}</td>
                <td>
                  <strong>{p.value.toFixed(4)}</strong>
                </td>
                <td>{p.source}</td>
                <td>
                  <span className={`badge ${p.status === 'stale' ? 'warning' : ''}`}>{p.status}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="dialog-actions" style={{ marginTop: '20px' }}>
        <button type="button" className="button" onClick={onClose}>
          Close
        </button>
      </div>
    </Dialog>
  );
}

export function InvestmentsPage() {
  const priceRefreshErrors = useLiveQuery(
    () => financeRepository.getSetting('priceRefreshErrors', {} as Record<string, string>),
    []
  );
  const data = useFinance();
  const instruments = useLiveQuery(
    () => financeDb.instruments.filter(i => !i.deletedAt && !i.archived).toArray(),
    []
  );
  const [newOpen, setNewOpen] = useState(false);
  const [trade, setTrade] = useState<Instrument | null>(null);
  const [priceFor, setPriceFor] = useState<Instrument | null>(null);
  const [historyFor, setHistoryFor] = useState<Instrument | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  async function refresh(instrument: Instrument) {
    setBusy(instrument.id);
    setError('');
    try {
      await refreshInstrumentPrice(instrument);
      soundService.play('success');
    } catch (e) {
      soundService.play('error');
      setError((e as Error).message);
      const failures = await financeRepository.getSetting('priceRefreshErrors', {} as Record<string, string>);
      failures[instrument.id] = (e as Error).message;
      await financeRepository.setSetting('priceRefreshErrors', failures);
    } finally {
      setBusy('');
    }
  }

  if (!data || !instruments) return <div className="loading">Reading your investment ledger…</div>;

  const baseCurrency = data.settings.baseCurrency || 'PHP';

  // Portfolio Aggregations
  let totalPortfolioValue = 0;
  let totalCostBasis = 0;
  let totalRealizedGain = 0;
  let totalDividends = 0;

  const allocationTotals: Record<string, { label: string; color: string; value: number }> = {
    equity: { label: 'Equities & Stocks', color: '#1f664a', value: 0 },
    funds: { label: 'Funds & ETFs', color: '#6d549e', value: 0 },
    fixed_income: { label: 'Fixed Income & Gov', color: '#d9b76c', value: 0 },
    alternatives: { label: 'Alternatives & Other', color: '#4c958d', value: 0 },
  };

  instruments.forEach(inst => {
    const positions = data.positions.filter(p => p.instrumentId === inst.id);
    const units = positions.reduce((s, p) => s + p.units, 0);
    if (units > 0) {
      const rawVal = positions.every(p => p.marketValue !== null)
        ? positions.reduce((s, p) => s + (p.marketValue || 0), 0)
        : null;
      const rawCost = positions.reduce((s, p) => s + p.costBasis, 0);
      const rawRealized = positions.reduce((s, p) => s + p.realizedGain, 0);
      const rawIncome = positions.reduce((s, p) => s + p.income, 0);

      const convertedVal = rawVal !== null
        ? (convertMoney(rawVal, inst.currency, baseCurrency, data.fxRates, today(), data.settings.currencyPrecision) ?? (inst.currency === baseCurrency ? rawVal : 0))
        : 0;
      const convertedCost = convertMoney(rawCost, inst.currency, baseCurrency, data.fxRates, today(), data.settings.currencyPrecision) ?? (inst.currency === baseCurrency ? rawCost : 0);
      const convertedRealized = convertMoney(rawRealized, inst.currency, baseCurrency, data.fxRates, today(), data.settings.currencyPrecision) ?? (inst.currency === baseCurrency ? rawRealized : 0);
      const convertedIncome = convertMoney(rawIncome, inst.currency, baseCurrency, data.fxRates, today(), data.settings.currencyPrecision) ?? (inst.currency === baseCurrency ? rawIncome : 0);

      totalPortfolioValue += convertedVal;
      totalCostBasis += convertedCost;
      totalRealizedGain += convertedRealized;
      totalDividends += convertedIncome;

      const cat = getAssetCategory(inst.instrumentType);
      allocationTotals[cat.key].value += convertedVal;
    }
  });

  const totalUnrealized = totalPortfolioValue - totalCostBasis;
  const totalUnrealizedPct = totalCostBasis > 0 ? (totalUnrealized / totalCostBasis) * 100 : 0;
  const activeCategories = Object.values(allocationTotals).filter(cat => cat.value > 0);

  return (
    <>
      <PageHeading
        eyebrow="MAKE ROOM FOR YOUR FUTURE"
        title="Your investments, together"
        description="From stocks and funds to MP2 and time deposits. Every holding starts with a recorded transaction."
        action={
          <button
            className="button primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-tala-green focus-visible:ring-offset-2"
            onClick={() => setNewOpen(true)}
          >
            <Plus size={15} />
            Add investment
          </button>
        }
      />
      <ErrorMessage message={error} />

      {/* Portfolio Overview & Asset Allocation Header */}
      <div className="card page-section" style={{ background: '#fff' }}>
        <div className="metric-grid">
          <div className="metric-card worth-card">
            <span className="metric-label">PORTFOLIO MARKET VALUE</span>
            <strong className="metric-value">
              <Money amount={totalPortfolioValue} currency={baseCurrency} />
            </strong>
            <div className="metric-foot">
              <span>Converted to {baseCurrency}</span>
              <span>{instruments.length} tracked instruments</span>
            </div>
          </div>
          <div className="metric-card">
            <span className="metric-label">OPEN COST BASIS</span>
            <strong className="metric-value">
              <Money amount={totalCostBasis} currency={baseCurrency} />
            </strong>
            <div className="metric-foot">
              <span>Capital deployed</span>
            </div>
          </div>
          <div className="metric-card savings-card">
            <span className="metric-label">UNREALIZED RETURN</span>
            <div style={{ marginTop: 19 }}>
              <span
                style={{
                  fontSize: 22,
                  fontWeight: 750,
                  letterSpacing: '-0.8px',
                  display: 'block',
                  color: totalUnrealized >= 0 ? '#1f664a' : '#9c3832',
                }}
              >
                <Money amount={totalUnrealized} currency={baseCurrency} />
              </span>
            </div>
            <div className="metric-foot">
              <TrendIndicator value={totalUnrealizedPct} isPercent isMinor={false} />
              <span>Overall Gain/Loss</span>
            </div>
          </div>
          <div className="metric-card">
            <span className="metric-label">INCOME & REALIZED</span>
            <strong className="metric-value" style={{ color: '#6d549e' }}>
              <Money amount={totalDividends + totalRealizedGain} currency={baseCurrency} />
            </strong>
            <div className="metric-foot">
              <span>Dividends: <Money amount={totalDividends} currency={baseCurrency} /></span>
            </div>
          </div>
        </div>

        {/* Multi-segment Asset Allocation Bar */}
        <div style={{ marginTop: 22 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span className="eyebrow" style={{ margin: 0 }}>
              PORTFOLIO ASSET ALLOCATION
            </span>
            <span style={{ fontSize: 10, color: '#4f5e58' }}>
              {totalPortfolioValue > 0 ? `${activeCategories.length} active asset classes` : 'No active holdings'}
            </span>
          </div>
          {totalPortfolioValue > 0 ? (
            <>
              <div
                style={{
                  display: 'flex',
                  height: '10px',
                  borderRadius: '5px',
                  overflow: 'hidden',
                  background: '#eceef0',
                  margin: '12px 0 10px',
                }}
              >
                {activeCategories.map(cat => (
                  <div
                    key={cat.label}
                    style={{
                      width: `${((cat.value / totalPortfolioValue) * 100).toFixed(2)}%`,
                      backgroundColor: cat.color,
                      transition: 'width 0.3s ease',
                    }}
                    title={`${cat.label}: ${((cat.value / totalPortfolioValue) * 100).toFixed(1)}%`}
                  />
                ))}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '16px', fontSize: '11px', color: '#4f5e58' }}>
                {activeCategories.map(cat => (
                  <div key={cat.label} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <span
                      style={{
                        width: '8px',
                        height: '8px',
                        borderRadius: '50%',
                        backgroundColor: cat.color,
                        display: 'inline-block',
                      }}
                    />
                    <span>{cat.label}:</span>
                    <strong style={{ color: '#173c34' }}>{((cat.value / totalPortfolioValue) * 100).toFixed(1)}%</strong>
                    <span style={{ color: '#799688' }}>
                      (<Money amount={cat.value} currency={baseCurrency} />)
                    </span>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <p className="helper" style={{ marginTop: 8 }}>
              No active holdings yet. Record a purchase transaction to see your live portfolio allocation.
            </p>
          )}
        </div>
      </div>

      <div className="notice">
        Missing market data keeps the last valid price with its original date. Add an FX rate in Settings to include foreign holdings in your base-currency totals.
      </div>

      {!instruments.length ? (
        <div className="card">
          <EmptyState
            view="investments"
            action={
              <button
                className="button primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-tala-green focus-visible:ring-offset-2"
                onClick={() => setNewOpen(true)}
              >
                Add an investment
              </button>
            }
          />
        </div>
      ) : (
        <div className="investment-grid">
          {instruments.map(instrument => {
            const positions = data.positions.filter(p => p.instrumentId === instrument.id);
            const value =
              positions.length && positions.every(p => p.marketValue !== null)
                ? positions.reduce((s, p) => s + (p.marketValue || 0), 0)
                : null;
            const units = positions.reduce((s, p) => s + p.units, 0);
            const cost = positions.reduce((s, p) => s + p.costBasis, 0);
            const unrealized =
              positions.every(p => p.unrealizedGain !== null)
                ? positions.reduce((s, p) => s + (p.unrealizedGain || 0), 0)
                : null;
            const latest = positions.find(p => p.priceAsOf);
            const refreshError = priceRefreshErrors?.[instrument.id];
            const stale = positions.some(p => p.stale) || Boolean(refreshError);
            const isHeld = units > 0;

            const convertedHoldingVal =
              value !== null
                ? (convertMoney(value, instrument.currency, baseCurrency, data.fxRates, today(), data.settings.currencyPrecision) ??
                  (instrument.currency === baseCurrency ? value : 0))
                : 0;
            const portfolioWeight =
              totalPortfolioValue > 0 && isHeld ? (convertedHoldingVal / totalPortfolioValue) * 100 : 0;

            return (
              <section className="card investment-card" key={instrument.id}>
                <div className="section-title">
                  <div>
                    <span className="eyebrow">{instrument.instrumentType.replaceAll('_', ' ')}</span>
                    <h2>{instrument.name}</h2>
                  </div>
                  <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                    {!isHeld && <span className="badge">Watchlist</span>}
                    <span className={`badge ${stale ? 'warning' : ''}`}>
                      {stale ? 'Saved price · stale' : methodNames[instrument.valuationMethod]}
                    </span>
                  </div>
                </div>

                <div className="value">
                  <Money amount={value} currency={instrument.currency} />
                </div>
                <div className="value-type">
                  {units.toLocaleString(undefined, { maximumFractionDigits: 8 })} units · {instrument.currency} ·{' '}
                  {instrument.symbol || 'Unquoted instrument'}
                  {portfolioWeight > 0 && (
                    <span style={{ marginLeft: 8, color: '#1f664a', fontWeight: 600 }}>
                      ({portfolioWeight.toFixed(1)}% of portfolio)
                    </span>
                  )}
                </div>

                {/* Embedded Responsive Recharts Sparkline */}
                <HoldingSparkline instrumentId={instrument.id} currency={instrument.currency} />

                <div className="holding-stats">
                  <div>
                    <small>Open cost basis</small>
                    <strong>
                      <Money amount={cost} currency={instrument.currency} />
                    </strong>
                  </div>
                  <div>
                    <small>Unrealized gain / loss</small>
                    <strong>
                      <TrendIndicator value={unrealized} currency={instrument.currency} />
                    </strong>
                  </div>
                  <div>
                    <small>Realized gain / loss</small>
                    <strong>
                      <TrendIndicator value={positions.reduce((s, p) => s + p.realizedGain, 0)} currency={instrument.currency} />
                    </strong>
                  </div>
                  <div>
                    <small>Dividends / income</small>
                    <strong>
                      <Money amount={positions.reduce((s, p) => s + p.income, 0)} currency={instrument.currency} />
                    </strong>
                  </div>
                </div>

                {refreshError && (
                  <p className="helper" role="status">
                    {refreshError} The saved valuation is retained.
                  </p>
                )}
                {latest?.priceAsOf && (
                  <p className="helper">
                    Price as of {latest.priceAsOf.slice(0, 10)} · {stale ? 'Last valid valuation retained' : 'Stored source valuation'}
                  </p>
                )}
                {positions.some(p => p.projectedValue !== undefined) && (
                  <p className="projection-label">
                    Projected maturity value <Money amount={positions[0]?.projectedValue} currency={instrument.currency} /> · editable assumptions, separate from actual holdings
                  </p>
                )}

                <div className="card-actions">
                  <button
                    className="button primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-tala-green focus-visible:ring-offset-2"
                    onClick={() => setTrade(instrument)}
                  >
                    {isHeld ? 'Record activity' : 'Record first purchase'}
                  </button>
                  <button
                    className="button focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-tala-green focus-visible:ring-offset-2"
                    onClick={() => setPriceFor(instrument)}
                  >
                    Manual valuation
                  </button>
                  <button
                    className="button focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-tala-green focus-visible:ring-offset-2"
                    onClick={() => setHistoryFor(instrument)}
                    title="View historical price charts and valuation logs"
                  >
                    <LineChart size={13} />
                    Price history
                  </button>
                  {['LIVE_MARKET', 'DAILY_NAV'].includes(instrument.valuationMethod) && (
                    <button
                      className="button focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-tala-green focus-visible:ring-offset-2"
                      disabled={busy === instrument.id}
                      onClick={() => refresh(instrument)}
                    >
                      <RefreshCw size={13} />
                      Refresh price
                    </button>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      )}

      <p className="helper page-section" style={{ marginTop: 20 }}>
        MP2 dividends and time-deposit proceeds are recorded when received; projected returns are assumptions. Investment purchases never count as consumption spending.
      </p>

      {newOpen && <InstrumentForm onClose={() => setNewOpen(false)} />}
      {trade && <TradeForm instrument={trade} onClose={() => setTrade(null)} />}
      {priceFor && <PriceForm instrument={priceFor} onClose={() => setPriceFor(null)} />}
      {historyFor && <HoldingHistoryModal instrument={historyFor} onClose={() => setHistoryFor(null)} />}
    </>
  );
}

function InstrumentForm({ onClose }: { onClose: () => void }) {
  const [type, setType] = useState<Instrument['instrumentType']>('PSE_STOCK');
  const [method, setMethod] = useState<ValuationMethod>('LIVE_MARKET');
  const [currency, setCurrency] = useState('PHP');
  const [error, setError] = useState('');

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError('');
    const form = new FormData(e.currentTarget);
    try {
      const instrument: Instrument = {
        id: crypto.randomUUID(),
        name: String(form.get('name')).trim(),
        symbol: String(form.get('symbol') || '').trim().toUpperCase(),
        sourceSymbol: String(form.get('symbol') || '').trim().toUpperCase(),
        instrumentType: type,
        currency,
        valuationMethod: method,
      };
      if (!instrument.name) throw new Error('Enter a name.');
      if (method === 'MANUAL_VALUE') {
        instrument.manualValue = toMinor(enteredNumber(form, 'manualValue'), currency);
        instrument.manualValueAsOf = valuationDate(form);
      }
      if (method === 'COMPOUNDING') {
        instrument.principal = toMinor(enteredNumber(form, 'principal'), currency);
        instrument.startDate = String(form.get('start'));
        instrument.maturityDate = String(form.get('maturity'));
        instrument.annualRate = enteredNumber(form, 'rate') / 100;
        instrument.withholdingRate = enteredNumber(form, 'tax') / 100;
        instrument.compoundsPerYear = enteredNumber(form, 'compounds', false);
        if (!validDate(instrument.startDate) || !validDate(instrument.maturityDate) || instrument.maturityDate < instrument.startDate)
          throw new Error('Use valid start and maturity dates.');
        if (instrument.annualRate > 1 || instrument.withholdingRate > 1 || !Number.isInteger(instrument.compoundsPerYear) || instrument.compoundsPerYear > 365)
          throw new Error('Verify the interest, tax and compounding assumptions.');
      }
      await financeDb.transaction('rw', financeDb.tables, async () => {
        await financeRepository.save('instruments', instrument);
        if (method === 'MANUAL_VALUE') {
          const date = instrument.manualValueAsOf!;
          await financeRepository.save('prices', {
            id: `manual-price:${instrument.id}:${date}`,
            instrumentId: instrument.id,
            value: enteredNumber(form, 'manualValue'),
            currency: instrument.currency,
            asOf: date,
            fetchedAt: new Date().toISOString(),
            source: 'Initial manual statement value',
            staleAfter: date + 'T23:59:59Z',
            status: 'manual',
          });
        }
      });
      soundService.play('success');
      onClose();
    } catch (e) {
      soundService.play('error');
      setError((e as Error).message);
    }
  }

  return (
    <Dialog title="Add an investment" onClose={onClose}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <Field label="Investment name">
            <input name="name" required autoFocus placeholder="e.g. MP2 savings or Apple shares" />
          </Field>
          <Field label="Investment type">
            <select value={type} onChange={e => setType(e.target.value as Instrument['instrumentType'])}>
              {INSTRUMENT_TYPES.map(t => (
                <option key={t} value={t}>
                  {t.replaceAll('_', ' ')}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Currency">
            <select value={currency} onChange={e => setCurrency(e.target.value)}>
              {currencies.map(c => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </Field>
          <Field label="Valuation method">
            <select value={method} onChange={e => setMethod(e.target.value as ValuationMethod)}>
              {Object.entries(methodNames).map(([m, n]) => (
                <option key={m} value={m}>
                  {n}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Provider ticker (optional)">
            <input name="symbol" placeholder="BDO or US:AAPL" />
          </Field>
          {method === 'MANUAL_VALUE' && (
            <>
              <Field label="Current total position value">
                <input name="manualValue" type="number" min="0" step="any" required />
              </Field>
              <Field label="Valuation date">
                <input name="date" type="date" max={today()} defaultValue={today()} required />
              </Field>
            </>
          )}
          {method === 'COMPOUNDING' && (
            <>
              <Field label="Principal">
                <input name="principal" type="number" min="0" step="any" required />
              </Field>
              <Field label="Start date">
                <input name="start" type="date" defaultValue={today()} required />
              </Field>
              <Field label="Maturity date">
                <input name="maturity" type="date" required />
              </Field>
              <Field label="Annual gross interest (%)">
                <input name="rate" type="number" min="0" max="100" step=".01" required />
              </Field>
              <Field label="Withholding (%)">
                <input name="tax" type="number" min="0" max="100" step=".01" defaultValue="0" required />
              </Field>
              <Field label="Compounds per year">
                <input name="compounds" type="number" min="1" max="365" defaultValue="1" required />
              </Field>
            </>
          )}
        </div>
        <p className="helper" style={{ marginTop: 15 }}>
          Provider tickers retrieve public prices only. They do not connect to your bank or broker. Manual values and projections remain clearly identified.
        </p>
        <ErrorMessage message={error} />
        <div className="dialog-actions">
          <button className="button" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary">Save investment</button>
        </div>
      </form>
    </Dialog>
  );
}

function TradeForm({ instrument, onClose }: { instrument: Instrument; onClose: () => void }) {
  const accounts = useLiveQuery(
    () =>
      financeDb.accounts
        .filter(
          a =>
            !a.deletedAt &&
            !a.archived &&
            !['CREDIT_CARD', 'PERSONAL_LOAN', 'MORTGAGE', 'OTHER_LIABILITY'].includes(a.accountType)
        )
        .toArray()
  );

  const prices = useLiveQuery(
    () =>
      financeDb.prices
        .where('instrumentId')
        .equals(instrument.id)
        .filter(p => !p.deletedAt && Number.isFinite(p.value) && p.value > 0)
        .sortBy('asOf'),
    [instrument.id]
  );
  const latestPriceValue = prices?.at(-1)?.value;

  const [type, setType] = useState<Transaction['type']>('INVESTMENT_BUY');
  const [selectedAccount, setSelectedAccount] = useState<string>('');
  const [units, setUnits] = useState<string>('');
  const [unitPrice, setUnitPrice] = useState<string>('');
  const [cashAmount, setCashAmount] = useState<string>('');
  const [fees, setFees] = useState<string>('0');
  const [mode, setMode] = useState<'UNITS' | 'CASH'>('UNITS');
  const [error, setError] = useState<string>('');

  // Auto-select first matching currency account
  useEffect(() => {
    if (accounts?.length && !selectedAccount) {
      const match = accounts.find(a => a.currency === instrument.currency) || accounts[0];
      setSelectedAccount(match.id);
    }
  }, [accounts, instrument.currency, selectedAccount]);

  // Pre-fill unit price from latest recorded price
  useEffect(() => {
    if (latestPriceValue && !unitPrice) {
      setUnitPrice(String(latestPriceValue));
    }
  }, [latestPriceValue, unitPrice]);

  const parsedPrice = Number(unitPrice) || 0;
  const numUnits =
    mode === 'UNITS'
      ? Number(units) || 0
      : parsedPrice > 0
      ? (Number(cashAmount) || 0) / parsedPrice
      : 0;
  const grossValue = numUnits * parsedPrice;
  const numFees = Number(fees) || 0;
  const netSettlement = type === 'INVESTMENT_BUY' ? grossValue + numFees : Math.max(0, grossValue - numFees);

  // Check held units for the selected account
  const heldLots = useLiveQuery(
    async () => {
      if (!selectedAccount) return 0;
      const txs = await financeDb.transactions
        .where('accountId')
        .equals(selectedAccount)
        .filter(t => !t.deletedAt && t.instrumentId === instrument.id)
        .toArray();
      const pos = calculatePositions(txs, [instrument], [], { asOf: today() });
      return pos[0]?.units || 0;
    },
    [selectedAccount, instrument.id]
  );

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError('');
    const form = new FormData(e.currentTarget);
    try {
      const date = String(form.get('date'));
      const accountId = selectedAccount;
      if (!accountId) throw new Error('Select a funding account.');

      if (['INVESTMENT_BUY', 'INVESTMENT_SELL'].includes(type)) {
        if (numUnits <= 0) throw new Error('Enter positive units.');
        if (parsedPrice <= 0) throw new Error('Enter a positive unit price.');
        if (type === 'INVESTMENT_SELL' && heldLots !== undefined && numUnits > heldLots + 1e-7) {
          throw new Error(`Cannot sell ${numUnits} units; you hold ${heldLots.toLocaleString()} units in this account.`);
        }
        const exactAmount = toMinor(numUnits * parsedPrice, instrument.currency);
        const exactFees = toMinor(numFees, instrument.currency);
        await financeRepository.saveTransaction({
          id: crypto.randomUUID(),
          date,
          type,
          accountId,
          currency: instrument.currency,
          amount: exactAmount,
          instrumentId: instrument.id,
          units: numUnits,
          unitPrice: parsedPrice,
          fees: exactFees,
          notes: String(form.get('notes') || ''),
        });
      } else {
        const rawAmount = Number(form.get('amount'));
        if (!rawAmount || rawAmount <= 0) throw new Error('Enter a positive amount.');
        await financeRepository.saveTransaction({
          id: crypto.randomUUID(),
          date,
          type,
          accountId,
          currency: instrument.currency,
          amount: toMinor(rawAmount, instrument.currency),
          instrumentId: instrument.id,
          notes: String(form.get('notes') || ''),
        });
      }
      soundService.play('success');
      onClose();
    } catch (err) {
      soundService.play('error');
      setError((err as Error).message);
    }
  }

  return (
    <Dialog title={`Record ${instrument.name} Activity`} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <Field label="Activity">
            <select value={type} onChange={e => setType(e.target.value as Transaction['type'])}>
              <option value="INVESTMENT_BUY">Buy units</option>
              <option value="INVESTMENT_SELL">Sell units</option>
              <option value="DIVIDEND">Dividend / Distribution</option>
              <option value="INTEREST">Interest received</option>
            </select>
          </Field>
          <Field label="Account">
            <select value={selectedAccount} onChange={e => setSelectedAccount(e.target.value)} required>
              {accounts?.map(a => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.currency}) {a.currency !== instrument.currency ? '— FX conversion required' : ''}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Date">
            <input name="date" type="date" defaultValue={today()} max={today()} required />
          </Field>
          {['INVESTMENT_BUY', 'INVESTMENT_SELL'].includes(type) ? (
            <>
              <Field label="Calculation Mode">
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button
                    type="button"
                    className={`button ${mode === 'UNITS' ? 'primary' : ''}`}
                    onClick={() => setMode('UNITS')}
                  >
                    By Units
                  </button>
                  <button
                    type="button"
                    className={`button ${mode === 'CASH' ? 'primary' : ''}`}
                    onClick={() => setMode('CASH')}
                  >
                    By Cash Amount
                  </button>
                </div>
              </Field>
              {mode === 'UNITS' ? (
                <Field label="Units">
                  <div style={{ display: 'flex', gap: '6px' }}>
                    <input
                      name="units"
                      type="number"
                      step="any"
                      min="0.00000001"
                      value={units}
                      onChange={e => setUnits(e.target.value)}
                      placeholder="e.g. 50"
                      required
                    />
                    {type === 'INVESTMENT_SELL' && heldLots !== undefined && (
                      <button
                        type="button"
                        className="button"
                        onClick={() => setUnits(String(heldLots))}
                        title="Sell all available units"
                      >
                        Sell All
                      </button>
                    )}
                  </div>
                </Field>
              ) : (
                <Field label={`Total Cash (${instrument.currency})`}>
                  <input
                    type="number"
                    step="any"
                    min="0.01"
                    value={cashAmount}
                    onChange={e => setCashAmount(e.target.value)}
                    placeholder="e.g. 10000"
                    required
                  />
                </Field>
              )}
              <Field label={`Price per unit (${instrument.currency})`}>
                <input
                  name="unitPrice"
                  type="number"
                  step="any"
                  min="0.00000001"
                  value={unitPrice}
                  onChange={e => setUnitPrice(e.target.value)}
                  placeholder="e.g. 155.00"
                  required
                />
              </Field>
              <Field label="Brokerage / Transaction Fees">
                <input
                  name="fees"
                  type="number"
                  step="any"
                  min="0"
                  value={fees}
                  onChange={e => setFees(e.target.value)}
                />
              </Field>
              <div className="full notice" style={{ marginTop: '10px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>Calculated units:</span>
                  <strong>{numUnits.toLocaleString(undefined, { maximumFractionDigits: 8 })}</strong>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '4px' }}>
                  <span>Net cash settlement:</span>
                  <strong>
                    {new Intl.NumberFormat('en', { style: 'currency', currency: instrument.currency, currencyDisplay: 'code' }).format(netSettlement)}
                  </strong>
                </div>
                {type === 'INVESTMENT_SELL' && heldLots !== undefined && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '4px', color: '#4f5e58' }}>
                    <span>Account holding balance:</span>
                    <span>{heldLots.toLocaleString()} units available</span>
                  </div>
                )}
              </div>
            </>
          ) : (
            <Field label={`Cash Amount (${instrument.currency})`}>
              <input name="amount" type="number" min="0.01" step="any" placeholder="e.g. 2500" required />
            </Field>
          )}
          <Field label="Notes (optional)">
            <input name="notes" placeholder="e.g. Q3 dividend or regular DCA" />
          </Field>
        </div>
        <p className="helper" style={{ marginTop: 13 }}>
          Purchases move cash into units and cost basis. They are excluded from spending and budgets. Sales use weighted average cost for realized gains.
        </p>
        <ErrorMessage message={error} />
        <div className="dialog-actions" style={{ marginTop: '20px' }}>
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary">Confirm and Record</button>
        </div>
      </form>
    </Dialog>
  );
}

function PriceForm({ instrument, onClose }: { instrument: Instrument; onClose: () => void }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [inputVal, setInputVal] = useState('');
  const [dateVal, setDateVal] = useState(today());
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<{ date: string; value: number }[]>([]);

  const total = instrument.valuationMethod === 'MANUAL_VALUE';

  // Query past valuations
  const history = useLiveQuery(
    () =>
      financeDb.prices
        .where('instrumentId')
        .equals(instrument.id)
        .filter(p => !p.deletedAt && Number.isFinite(p.value) && p.value >= 0)
        .sortBy('asOf'),
    [instrument.id]
  );

  // Query current held units
  const unitsHeld = useLiveQuery(async () => {
    const txs = await financeDb.transactions
      .where('instrumentId')
      .equals(instrument.id)
      .filter(t => !t.deletedAt)
      .toArray();
    const pos = calculatePositions(txs, [instrument], [], { asOf: today() });
    return pos.reduce((s, p) => s + p.units, 0);
  }, [instrument.id]);

  const prior = history?.at(-1);
  const priorVal = prior?.value;
  const numInput = Number(inputVal) || 0;
  const delta = priorVal !== undefined && numInput > 0 ? numInput - priorVal : null;
  const deltaPct = priorVal && delta !== null ? (delta / priorVal) * 100 : null;

  async function removePrice(id: string) {
    try {
      await financeRepository.remove('prices', id);
      soundService.play('success');
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError('');
    setBusy(true);
    const form = new FormData(e.currentTarget);
    try {
      const date = valuationDate(form);
      const value = enteredNumber(form, 'price', total);
      const source = String(form.get('source') || 'Manual valuation').trim();

      await financeDb.transaction('rw', financeDb.tables, async () => {
        // Seamless date overwrite: remove prior entries on this date
        const existing = await financeDb.prices
          .where('instrumentId')
          .equals(instrument.id)
          .filter(p => !p.deletedAt && p.asOf.slice(0, 10) === date)
          .toArray();
        for (const old of existing) {
          await financeRepository.remove('prices', old.id);
        }

        const priceKey = `manual-price:${instrument.id}:${date}`;
        await financeRepository.save('prices', {
          id: priceKey,
          instrumentId: instrument.id,
          value,
          currency: instrument.currency,
          asOf: date,
          fetchedAt: new Date().toISOString(),
          source,
          sourceSymbol: instrument.symbol,
          staleAfter: date + 'T23:59:59Z',
          status: 'manual',
        });

        if (total) {
          const latest = await financeDb.instruments.get(instrument.id);
          if (latest && (!latest.manualValueAsOf || date >= latest.manualValueAsOf.slice(0, 10))) {
            await financeRepository.save('instruments', {
              ...latest,
              manualValue: toMinor(value, instrument.currency),
              manualValueAsOf: date,
            });
          }
        }
      });

      soundService.play('success');
      onClose();
    } catch (err) {
      soundService.play('error');
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function previewNav() {
    setError('');
    setPreview([]);
    try {
      if (!text.trim() || text.length > 1000000) throw new Error('Paste a NAV CSV with date,value rows.');
      const parsed = Papa.parse<string[]>(text, { skipEmptyLines: 'greedy' });
      if (parsed.errors.length) throw new Error('The CSV contains invalid quoting or columns.');
      const raw = [...parsed.data];
      if (raw[0]?.[0]?.trim().toLowerCase() === 'date') raw.shift();
      if (!raw.length || raw.length > 10000) throw new Error('Import between 1 and 10,000 valuations.');
      const dates = new Set<string>();
      const rows: { date: string; value: number }[] = [];
      for (const cells of raw) {
        if (cells.length !== 2) throw new Error('Each NAV row needs exactly date,value.');
        const date = cells[0].trim(),
          input = cells[1].trim(),
          val = Number(input);
        if (!validDate(date) || date > today() || !input || !Number.isFinite(val) || val < 0 || (!total && val === 0))
          throw new Error('Use real calendar dates and explicit valid valuation amounts.');
        if (dates.has(date)) throw new Error('Duplicate valuation dates in this CSV.');
        dates.add(date);
        rows.push({ date, value: val });
      }
      rows.sort((a, b) => a.date.localeCompare(b.date));
      setPreview(rows);
    } catch (e) {
      soundService.play('error');
      setError((e as Error).message);
    }
  }

  async function importNav() {
    setBusy(true);
    setError('');
    try {
      if (!preview.length) throw new Error('Preview the CSV first.');
      await financeDb.transaction('rw', financeDb.tables, async () => {
        for (const row of preview) {
          const existing = await financeDb.prices
            .where('instrumentId')
            .equals(instrument.id)
            .filter(p => !p.deletedAt && p.asOf.slice(0, 10) === row.date)
            .toArray();
          for (const old of existing) {
            await financeRepository.remove('prices', old.id);
          }
          await financeRepository.save('prices', {
            id: `manual-price:${instrument.id}:${row.date}`,
            instrumentId: instrument.id,
            value: row.value,
            currency: instrument.currency,
            asOf: row.date,
            fetchedAt: new Date().toISOString(),
            source: total ? 'Manual CSV statement value' : 'Manual CSV NAV import',
            sourceSymbol: instrument.symbol,
            staleAfter: row.date + 'T23:59:59Z',
            status: 'manual',
          });
        }
      });
      soundService.play('success');
      onClose();
    } catch (e) {
      soundService.play('error');
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={total ? `Update Statement Valuation — ${instrument.name}` : `Update NAV / Price — ${instrument.name}`}
      onClose={onClose}
    >
      <form onSubmit={submit}>
        <div className="form-grid">
          <Field label={total ? `Total Position Value (${instrument.currency})` : `Price / NAV per unit (${instrument.currency})`}>
            <input
              name="price"
              type="number"
              step="any"
              min={total ? '0' : '0.00000001'}
              value={inputVal}
              onChange={e => setInputVal(e.target.value)}
              placeholder={priorVal !== undefined ? `Previous: ${priorVal.toFixed(4)}` : 'e.g. 125.50'}
              required
              autoFocus
            />
          </Field>
          <Field label="Valuation Date">
            <input
              name="date"
              type="date"
              max={today()}
              value={dateVal}
              onChange={e => setDateVal(e.target.value)}
              required
            />
          </Field>
          <Field label="Source / Reference Note">
            <input name="source" defaultValue="Manual statement / NAV" />
          </Field>
        </div>

        {priorVal !== undefined && numInput > 0 && (
          <div className="notice" style={{ marginTop: '12px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>Valuation delta:</span>
              <strong>
                <TrendIndicator value={deltaPct} isPercent isMinor={false} /> ({delta && delta > 0 ? '+' : ''}
                {delta?.toFixed(4)} {instrument.currency})
              </strong>
            </div>
            {!total && unitsHeld !== undefined && unitsHeld > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '4px' }}>
                <span>Impact on holding value:</span>
                <strong>
                  {new Intl.NumberFormat('en', { style: 'currency', currency: instrument.currency, currencyDisplay: 'code' }).format(
                    unitsHeld * numInput
                  )}{' '}
                  ({delta && delta > 0 ? '+' : ''}
                  {new Intl.NumberFormat('en', { style: 'currency', currency: instrument.currency, currencyDisplay: 'code' }).format(
                    unitsHeld * (delta || 0)
                  )})
                </strong>
              </div>
            )}
          </div>
        )}

        <ErrorMessage message={error} />
        <div className="dialog-actions" style={{ marginTop: '20px' }}>
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" disabled={busy}>
            Save Valuation
          </button>
        </div>
      </form>

      {history && history.length > 0 && (
        <div style={{ marginTop: '25px', borderTop: '1px solid #edf1ed', paddingTop: '15px' }}>
          <h3>Recent Valuation History</h3>
          <table className="data-table" style={{ marginTop: '10px' }}>
            <thead>
              <tr>
                <th>Date</th>
                <th>NAV / Value</th>
                <th>Source</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {[...history]
                .reverse()
                .slice(0, 5)
                .map(p => (
                  <tr key={p.id}>
                    <td>{p.asOf.slice(0, 10)}</td>
                    <td>
                      <strong>
                        {p.value.toFixed(4)} {p.currency}
                      </strong>
                    </td>
                    <td>
                      <small>{p.source}</small>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="icon-button"
                        title="Delete entry"
                        onClick={() => removePrice(p.id)}
                        style={{ color: '#9c3832' }}
                      >
                        <Trash2 size={13} />
                      </button>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}

      <details style={{ marginTop: 25 }}>
        <summary>Import {total ? 'statement values' : 'NAV history'} from CSV</summary>
        <p className="helper" style={{ margin: '12px 0' }}>
          Paste date,value columns. Preview validates every row before an atomic import.
        </p>
        <textarea
          aria-label="NAV CSV"
          value={text}
          onChange={e => {
            setText(e.target.value);
            setPreview([]);
          }}
        />
        <button type="button" className="button" onClick={previewNav} disabled={busy} style={{ marginTop: 8 }}>
          Preview NAV rows
        </button>
        {preview.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <p className="helper">
              {preview.length} valuations · {preview[0].date} to {preview.at(-1)?.date}
            </p>
            <button
              type="button"
              className="button primary"
              disabled={busy}
              onClick={importNav}
              style={{ marginTop: 6 }}
            >
              Import these valuations
            </button>
          </div>
        )}
      </details>
    </Dialog>
  );
}

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
        setSuccessMessage(
          `${record.name} (${record.symbol}) saved in Investments with manual valuation. Add a manual unit price anytime.`
        );
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
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search a company or exchange ticker"
            />
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
                        value={
                          typeof quote?.changePercent === 'number' && Number.isFinite(quote.changePercent)
                            ? quote.changePercent
                            : null
                        }
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
