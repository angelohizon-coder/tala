import { createFreeGlobalMirror } from '../../tools/free-global-mirror.mjs';
import { financeRepository } from '../db/repository';
import { financeDb } from '../db/database';
import type { Instrument, Price } from '../core/types';
import { getAuth } from 'firebase/auth';
import { app } from '../firebase';

export interface MarketInstrument {
  symbol: string;
  name: string;
  currency: string;
  market?: string;
  exchange?: string;
  timeZone?: string;
  assetType: string;
}

export interface MarketQuote extends MarketInstrument {
  value: number;
  asOf: string;
  marketDate?: string;
  timestampPrecision?: string;
  source: string;
  sourceUrl?: string;
  freshness: string;
  changePercent?: number;
  isStale?: boolean;
  change?: number;
  staleReason?: string;
}

export interface PriceProvider {
  search(query: string, market: string): Promise<MarketInstrument[]>;
  latestPrice(symbol: string): Promise<MarketQuote>;
  priceHistory(symbol: string, range: string): Promise<{ points: { date: string; close: number | null }[]; source: string; currency?: string }>;
}

const international = createFreeGlobalMirror({ browserCors: true, timeoutMs: 20000 });
const starters: Record<string, string[]> = {
  US: ['US:AAPL', 'US:MSFT', 'US:NVDA'],
  HK: ['HK:0700'],
  JP: ['JP:7203'],
  GB: ['GB:VOD'],
  CA: ['CA:SHOP'],
  AU: ['AU:BHP'],
};

function safeBase(value: string) {
  const u = new URL(value);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname)))
    throw new Error('Use an HTTPS gateway URL.');
  if (u.username || u.password || u.search || u.hash)
    throw new Error('Use a base URL without credentials.');
  return u.href.replace(/\/$/, '');
}

async function externalResponse(path: string) {
  const configured = await financeRepository.getSetting<string>('marketGateway', '');
  const host = typeof location !== 'undefined' ? location.hostname : '';
  const base = configured
    ? safeBase(configured)
    : ['localhost', '127.0.0.1'].includes(host)
      ? '/api/getMarketQuote'
      : 'https://us-central1-kotoba-41ab0.cloudfunctions.net/getMarketQuote';
  if (!base) throw new Error('Connect a Philippine gateway in Settings, or enter a manual price.');
  let queryStr = path.split('?')[1] || '';
  if (path.startsWith('/history/') && !queryStr.includes('symbol=')) {
    queryStr += (queryStr ? '&' : '') + 'symbol=' + path.split('/')[2].split('?')[0];
  }
  const fetchUrl = base.endsWith('getMarketQuote') ? base + '?' + queryStr : base + path;
  const headers: Record<string, string> = { Accept: 'application/json' };
  try {
    const auth = getAuth(app);
    const token = await auth.currentUser?.getIdToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
  } catch {}
  const response = await fetch(fetchUrl, { signal: AbortSignal.timeout(10000), headers });
  if (!response.ok) throw new Error('The market source could not return this data. Your last saved prices are kept.');
  return response.json();
}

async function globalResponse(path: string) {
  const host = typeof location !== 'undefined' ? location.hostname : '';
  if (['localhost', '127.0.0.1'].includes(host) && !path.includes(':') && !path.includes('%3A')) {
    try {
      return await externalResponse(path);
    } catch {
      /* Public daily data also works without a local gateway. */
    }
  }
  const url = new URL(path, 'https://local.invalid');
  if (url.pathname === '/catalog') {
    const market = url.searchParams.get('market') || 'US',
          query = url.searchParams.get('q') || '',
          catalog = await international.catalog(market, query);
    return {
      ...catalog,
      instruments: query ? catalog.instruments : catalog.instruments.filter(i => (starters[market] || []).includes(i.symbol)),
    };
  }
  if (url.pathname === '/quotes') {
    const quote = await international.quote(url.searchParams.get('symbols') || '');
    return { quotes: [quote] };
  }
  if (url.pathname.startsWith('/history/'))
    return international.history(decodeURIComponent(url.pathname.slice(9)), url.searchParams.get('range') || '1m');
  throw new Error('Unsupported market request.');
}

/**
 * Normalizes quotes from multiple source schemas (Cloud Function gateway,
 * international mirror, local Dexie cache, or manual inputs) into the standard MarketQuote schema.
 * Maps { price, provider } -> { value, source } seamlessly while enforcing strict invariants.
 */
export function normalizeQuote(raw: any, fallbackSymbol?: string): MarketQuote {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid quote data: expected an object.');
  }

  const rawSymbol = typeof raw.symbol === 'string' && raw.symbol.trim()
    ? raw.symbol.trim()
    : (fallbackSymbol ? fallbackSymbol.trim() : '');
  if (!rawSymbol) {
    throw new Error('Invalid quote data: missing ticker symbol.');
  }

  // Value normalization: support raw.value (client schema) and raw.price (gateway schema)
  const rawValue = raw.value ?? raw.price;
  const value = typeof rawValue === 'number' ? rawValue : Number(rawValue);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid market price for ${rawSymbol}: ${rawValue}`);
  }

  // Currency normalization: default to PHP if absent, ensure uppercase 3-letter code
  const currency = typeof raw.currency === 'string' && raw.currency.trim()
    ? raw.currency.trim().toUpperCase()
    : 'PHP';
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new Error(`Invalid currency code for ${rawSymbol}: ${raw.currency}`);
  }

  // Source normalization: support raw.source (client schema) and raw.provider (gateway schema)
  let source: string;
  if (typeof raw.source === 'string' && raw.source.trim()) {
    source = raw.source.trim();
  } else if (typeof raw.provider === 'string' && raw.provider.trim()) {
    const prov = raw.provider.trim().toLowerCase();
    source = prov === 'cache'
      ? 'Gateway Cache (Stale)'
      : `Gateway (${raw.provider.trim()})`;
  } else {
    source = 'Market Gateway';
  }

  // Freshness normalization
  const freshness = typeof raw.freshness === 'string' && raw.freshness.trim()
    ? raw.freshness.trim()
    : (raw.isStale ? 'stale' : 'delayed');

  const isStale = Boolean(raw.isStale || freshness === 'stale');

  // Timestamp / asOf normalization
  let asOf: string;
  if (typeof raw.asOf === 'string' && raw.asOf.trim() && Number.isFinite(Date.parse(raw.asOf))) {
    asOf = raw.asOf.trim();
  } else if (Number.isFinite(raw.timestamp) && raw.timestamp > 0) {
    asOf = new Date(raw.timestamp).toISOString();
  } else {
    asOf = new Date().toISOString();
  }

  // Guard against clock skew (> 5 minutes in future)
  if (Date.parse(asOf) > Date.now() + 300000) {
    asOf = new Date().toISOString();
  }

  const name = typeof raw.name === 'string' && raw.name.trim()
    ? raw.name.trim()
    : rawSymbol;

  const assetType = typeof raw.assetType === 'string' && raw.assetType.trim()
    ? raw.assetType.trim()
    : 'stock';

  const changePercent = typeof raw.changePercent === 'number' && Number.isFinite(raw.changePercent)
    ? raw.changePercent
    : undefined;

  const change = typeof raw.change === 'number' && Number.isFinite(raw.change)
    ? raw.change
    : undefined;

  return {
    ...raw,
    symbol: rawSymbol,
    name,
    currency,
    assetType,
    value,
    source,
    asOf,
    freshness,
    isStale,
    ...(changePercent !== undefined ? { changePercent } : {}),
    ...(change !== undefined ? { change } : {}),
  };
}

/**
 * Queries Dexie IndexedDB (`financeDb.prices` and `financeDb.instruments`)
 * for the latest recorded price for a given ticker or instrument ID.
 * Returns a standardized stale MarketQuote or null if none found.
 */
export async function getStalePriceFromDb(symbol: string): Promise<MarketQuote | null> {
  try {
    const cleanSym = symbol.trim().toUpperCase();
    const baseSym = cleanSym.replace(/\.PS$/, '');

    // 1. Locate any instruments with matching symbol, sourceSymbol, or ID
    const matchingInstruments = await financeDb.instruments
      .filter(inst => {
        if (inst.deletedAt) return false;
        const s = inst.symbol?.toUpperCase();
        const src = inst.sourceSymbol?.toUpperCase();
        return (
          inst.id === symbol ||
          s === cleanSym ||
          src === cleanSym ||
          (Boolean(s) && s!.replace(/\.PS$/, '') === baseSym) ||
          (Boolean(src) && src!.replace(/\.PS$/, '') === baseSym)
        );
      })
      .toArray();

    const instrumentIds = new Set(matchingInstruments.map(i => i.id));
    instrumentIds.add(symbol);

    // 2. Query prices table for matching instrumentIds OR matching sourceSymbol
    const prices = await financeDb.prices
      .filter(p => {
        if (p.deletedAt || !Number.isFinite(p.value) || p.value <= 0) return false;
        if (instrumentIds.has(p.instrumentId)) return true;
        const pSym = p.sourceSymbol?.toUpperCase();
        if (pSym) {
          return pSym === cleanSym || pSym.replace(/\.PS$/, '') === baseSym;
        }
        return false;
      })
      .toArray();

    if (!prices.length) return null;

    // 3. Select most recent price by asOf / fetchedAt
    prices.sort((a, b) => {
      const timeB = Date.parse(b.asOf) || Date.parse(b.fetchedAt) || 0;
      const timeA = Date.parse(a.asOf) || Date.parse(a.fetchedAt) || 0;
      return timeB - timeA;
    });

    const latest = prices[0];
    const matchedInst = matchingInstruments.find(i => i.id === latest.instrumentId);

    const baseSource = latest.source || 'Saved price';
    const sourceWithStale = baseSource.toLowerCase().includes('stale') || baseSource.toLowerCase().includes('cache')
      ? baseSource
      : `${baseSource} (Stale cache)`;

    return {
      symbol: latest.sourceSymbol || matchedInst?.symbol || symbol,
      name: matchedInst?.name || latest.sourceSymbol || symbol,
      currency: latest.currency || matchedInst?.currency || 'PHP',
      assetType: matchedInst?.instrumentType?.toLowerCase().includes('etf') ? 'etf' : 'stock',
      value: latest.value,
      source: sourceWithStale,
      asOf: latest.asOf,
      freshness: 'stale',
      isStale: true,
      changePercent: undefined,
      change: undefined,
    };
  } catch {
    return null;
  }
}

export const marketProvider: PriceProvider = {
  async search(query, market) {
    const path = `/catalog${market === 'PH' ? '' : `?market=${market}`}${query ? `${market === 'PH' ? '?' : '&'}q=${encodeURIComponent(query)}` : ''}`;
    try {
      const data = market === 'PH' ? await externalResponse(path) : await globalResponse(path);
      return data.instruments || [];
    } catch {
      return [];
    }
  },

  async latestPrice(symbol) {
    const cleanSymbol = symbol.trim();
    const path = '/quotes?symbols=' + encodeURIComponent(cleanSymbol);
    let liveQuote: MarketQuote | null = null;
    let fetchError: Error | null = null;

    try {
      const data = cleanSymbol.includes(':')
        ? await globalResponse(path)
        : await externalResponse(path);

      if (data) {
        const cleanUpper = cleanSymbol.toUpperCase();
        const baseUpper = cleanUpper.replace(/\.PS$/, '');

        let rawQuote: any = null;
        if (Array.isArray(data.quotes) && data.quotes.length > 0) {
          rawQuote = data.quotes.find((q: any) => {
            if (!q) return false;
            const s = typeof q.symbol === 'string' ? q.symbol.trim().toUpperCase() : '';
            return s === cleanUpper || s.replace(/\.PS$/, '') === baseUpper;
          });
          if (!rawQuote && data.quotes.length === 1) {
            rawQuote = data.quotes[0];
          }
        } else if (data.price !== undefined || data.value !== undefined) {
          rawQuote = data;
        }

        if (rawQuote) {
          liveQuote = normalizeQuote(rawQuote, cleanSymbol);
        }
      }
    } catch (err: any) {
      fetchError = err instanceof Error ? err : new Error(String(err));
    }

    if (liveQuote) {
      return liveQuote;
    }

    // Network fetch failed or returned no verified quote; attempt Dexie stale price fallback
    const staleQuote = await getStalePriceFromDb(cleanSymbol);
    if (staleQuote) {
      return staleQuote;
    }

    // Neither live quote nor stale cache is available
    throw fetchError || new Error(`No recent verified quote is available for ${cleanSymbol}.`);
  },

  async priceHistory(symbol, range) {
    const path = '/history/' + encodeURIComponent(symbol) + '?range=' + encodeURIComponent(range);
    return symbol.includes(':') ? globalResponse(path) : externalResponse(path);
  },
};

export async function refreshInstrumentPrice(instrument: Instrument) {
  if (!instrument.sourceSymbol && !instrument.symbol)
    throw new Error('Add a provider ticker to this instrument first.');
  const quote = await marketProvider.latestPrice(instrument.sourceSymbol || instrument.symbol!);
  if (quote.currency !== instrument.currency)
    throw new Error('The source currency differs from this instrument. Verify its price unit before saving.');
  const existing = await financeRepository.getSetting('priceRefreshErrors', {} as Record<string, string>);
  const date = new Date().toISOString();
  const price: Price = {
    id: crypto.randomUUID(),
    instrumentId: instrument.id,
    value: quote.value,
    currency: quote.currency,
    asOf: quote.asOf,
    fetchedAt: date,
    source: quote.source,
    sourceSymbol: quote.symbol,
    staleAfter: new Date(Date.parse(quote.asOf) + 3 * 86400000).toISOString(),
    status: Date.now() - Date.parse(quote.asOf) > 3 * 86400000 ? 'stale' : 'fresh',
  };
  await financeRepository.save('prices', price);
  delete existing[instrument.id];
  await financeRepository.setSetting('priceRefreshErrors', existing);
  return price;
}

export async function refreshFx(base = 'PHP', force = false) {
  if (!/^[A-Z]{3}$/.test(base)) throw new Error('Choose a valid base currency.');
  const cached = await financeRepository.getSetting<{ count: number; asOf: string; fetchedAt: number }>('fx-refresh:' + base);
  if (!force && cached && Date.now() - cached.fetchedAt < 3600000) return { count: cached.count, asOf: cached.asOf };
  const response = await fetch(`https://open.er-api.com/v6/latest/${base}`, { signal: AbortSignal.timeout(12000) });
  const data = await response.json();
  if (!response.ok || data.result !== 'success' || data.base_code !== base || !Number.isSafeInteger(data.time_last_update_unix) || data.time_last_update_unix * 1000 > Date.now() + 300000 || !data.rates || data.rates[base] !== 1)
    throw new Error('The free FX source is unavailable or invalid. Saved rates are kept.');
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

export async function safeRefreshFx(base = 'PHP', force = false): Promise<{ ok: boolean; count?: number; asOf?: string; error?: string }> {
  try {
    const result = await refreshFx(base, force);
    return { ok: true, count: result.count, asOf: result.asOf };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}
