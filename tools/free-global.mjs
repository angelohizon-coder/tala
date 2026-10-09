/** Keyless Yahoo Finance adapter for private local viewing. No substitute prices. */
import { createFreeGlobalMirror, GlobalMirrorError } from './free-global-mirror.mjs';
const SOURCE = 'Yahoo Finance';
const HOSTS = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];
const MAX_BYTES = 1024 * 1024;
const MAX_FUTURE_MS = 300000;
const RANGES = { '1w': '5d', '1m': '1mo', '3m': '3mo', '1y': '1y' };
const MARKETS = {
  US: { suffix: '', currency: 'USD', timeZone: 'America/New_York', exchange: 'US', starters: [['AAPL', 'Apple Inc.'], ['MSFT', 'Microsoft Corporation'], ['NVDA', 'NVIDIA Corporation']] },
  HK: { suffix: '.HK', currency: 'HKD', timeZone: 'Asia/Hong_Kong', exchange: 'Hong Kong', starters: [['0700', 'Tencent Holdings Limited']] },
  JP: { suffix: '.T', currency: 'JPY', timeZone: 'Asia/Tokyo', exchange: 'Tokyo', starters: [['7203', 'Toyota Motor Corporation']] },
  GB: { suffix: '.L', currency: 'GBP', timeZone: 'Europe/London', exchange: 'London', starters: [['VOD', 'Vodafone Group Public Limited Company']] },
  CA: { suffix: '.TO', currency: 'CAD', timeZone: 'America/Toronto', exchange: 'Toronto', starters: [['SHOP', 'Shopify Inc.']] },
  AU: { suffix: '.AX', currency: 'AUD', timeZone: 'Australia/Sydney', exchange: 'Australian Securities Exchange', starters: [['BHP', 'BHP Group Limited']] },
};

class GlobalSourceError extends Error {
  constructor(status, code, message, retryAfter = null) { super(message); Object.assign(this, { status, code, retryAfter }); }
}
const invalid = () => new GlobalSourceError(400, 'invalid_request', 'Use supported markets, qualified stock symbols and request parameters.');
const changed = () => new GlobalSourceError(502, 'source_changed', 'The international source returned invalid or unsupported data.');
const unavailable = () => new GlobalSourceError(503, 'source_unavailable', 'The international data source is temporarily unavailable.');
const timeout = () => new GlobalSourceError(504, 'source_timeout', 'The international data source timed out.');
const unknown = () => new GlobalSourceError(400, 'unknown_symbol', 'The international source does not recognize this symbol.');
const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const nonnegative = value => { const result = finite(value); return result !== null && result >= 0 ? result : null; };
const validText = (value, maximum = 200) => typeof value === 'string' && value.trim().length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(value);
const mono = () => performance.now();

/** Qualified identity is distinct from the provider ticker and from bare PSE symbols. */
export function parseGlobalSymbol(symbol) {
  if (typeof symbol !== 'string') throw invalid();
  const match = /^(US|HK|JP|GB|CA|AU):([A-Z0-9][A-Z0-9.-]{0,14})$/u.exec(symbol);
  if (!match || /\.\.|--|[.-]$/u.test(match[2])) throw invalid();
  const market = match[1], native = match[2], specification = MARKETS[market];
  if ((market === 'HK' && !/^\d{4,5}$/u.test(native)) || (market === 'US' && native.includes('.')) || /\.(?:HK|T|L|TO|AX|PSE|PS)$/u.test(native)) throw invalid();
  return { symbol, market, native, ticker: native + specification.suffix };
}

function marketDate(epochMs, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(epochMs));
    const get = type => parts.find(part => part.type === type)?.value;
    const date = `${get('year')}-${get('month')}-${get('day')}`;
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) throw changed();
    return date;
  } catch { throw changed(); }
}

function sourceEpoch(value, nowMs) {
  if (!Number.isSafeInteger(value) || value <= 0 || value * 1000 > nowMs + MAX_FUTURE_MS) throw changed();
  const epochMs = value * 1000;
  if (!Number.isFinite(new Date(epochMs).getTime())) throw changed();
  return epochMs;
}

function chartResult(raw) {
  if (raw?.chart?.error) {
    if (['Not Found', 'Bad Request'].includes(raw.chart.error.code)) throw unknown();
    throw unavailable();
  }
  if (!raw?.chart || !Array.isArray(raw.chart.result) || raw.chart.result.length !== 1 || !raw.chart.result[0]?.meta) throw changed();
  return raw.chart.result[0];
}

function chartMetadata(result, identity, nowMs) {
  const meta = result.meta, specification = MARKETS[identity.market];
  const pence = identity.market === 'GB' && meta.currency === 'GBp';
  if (meta.symbol !== identity.ticker || !['EQUITY', 'ETF'].includes(meta.instrumentType)
    || (!pence && meta.currency !== specification.currency)
    || meta.exchangeTimezoneName !== specification.timeZone || !validText(meta.exchangeName, 80)) throw changed();
  const epochMs = sourceEpoch(meta.regularMarketTime, nowMs);
  const name = validText(meta.longName) ? meta.longName.trim() : validText(meta.shortName) ? meta.shortName.trim() : identity.native;
  return {
    symbol: identity.symbol, ticker: identity.ticker, market: identity.market, name,
    assetType: meta.instrumentType === 'ETF' ? 'etf' : 'stock', currency: specification.currency,
    exchange: validText(meta.fullExchangeName, 80) ? meta.fullExchangeName.trim() : meta.exchangeName.trim(),
    timeZone: meta.exchangeTimezoneName, asOf: new Date(epochMs).toISOString(), marketDate: marketDate(epochMs, meta.exchangeTimezoneName),
    source: SOURCE, sourceUrl: `https://finance.yahoo.com/quote/${encodeURIComponent(identity.ticker)}/`,
    ...(pence ? { sourceCurrency: 'GBp', sourceUnit: 'pence' } : {}),
    scale: pence ? 100 : 1,
  };
}

function dailyBars(result, metadata, nowMs) {
  const timestamps = result.timestamp;
  if (timestamps === undefined || timestamps === null) return [];
  const series = result.indicators?.quote;
  if (!Array.isArray(timestamps) || timestamps.length > 1000 || !Array.isArray(series) || series.length !== 1
    || !Array.isArray(series[0]?.close) || series[0].close.length !== timestamps.length) throw changed();
  const dates = new Map();
  let lastTimestamp = -1;
  timestamps.forEach((stamp, index) => {
    const epochMs = sourceEpoch(stamp, nowMs);
    if (stamp <= lastTimestamp) throw changed();
    lastTimestamp = stamp;
    const date = marketDate(epochMs, metadata.timeZone);
    const close = nonnegative(series[0].close[index]);
    const normalized = close === null ? null : close / metadata.scale;
    if (dates.has(date)) throw changed();
    dates.set(date, { date, close: normalized });
  });
  return [...dates.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** Normalize only source values. chartPreviousClose is deliberately ignored. */
export function parseYahooQuote(raw, symbol, nowMs = Date.now()) {
  const identity = parseGlobalSymbol(symbol), result = chartResult(raw);
  const metadata = chartMetadata(result, identity, nowMs), bars = dailyBars(result, metadata, nowMs);
  const valueRaw = nonnegative(result.meta.regularMarketPrice);
  const explicitPrevious = nonnegative(result.meta.previousClose);
  const priorBar = bars.filter(bar => bar.date < metadata.marketDate).at(-1);
  const value = valueRaw === null ? null : valueRaw / metadata.scale;
  const previousClose = explicitPrevious === null ? priorBar?.close ?? null : explicitPrevious / metadata.scale;
  const change = value === null || previousClose === null ? null : value - previousClose;
  const changePercent = change === null || previousClose === 0 ? null : change / previousClose * 100;
  const suppliedVolume = nonnegative(result.meta.regularMarketVolume);
  const { scale, ...publicMetadata } = metadata;
  return {
    ...publicMetadata, value, valueType: 'last_trade', previousClose, change, changePercent,
    volume: Number.isSafeInteger(suppliedVolume) ? suppliedVolume : null,
    freshness: 'snapshot', delayMinutes: null,
    ...(validText(result.meta.marketState, 30) ? { tradingStatus: result.meta.marketState.trim() } : {}),
  };
}

export function parseYahooHistory(raw, symbol, range = '1m', nowMs = Date.now()) {
  if (!Object.hasOwn(RANGES, range)) throw invalid();
  const identity = parseGlobalSymbol(symbol), result = chartResult(raw);
  const metadata = chartMetadata(result, identity, nowMs), bars = dailyBars(result, metadata, nowMs);
  const today = marketDate(nowMs, metadata.timeZone);
  const end = finite(result.meta.currentTradingPeriod?.regular?.end);
  const sessionFinished = Number.isSafeInteger(end) && end > 0 && end * 1000 <= nowMs && marketDate(end * 1000, metadata.timeZone) === today;
  // A current-day daily bar remains a partial session until its source session ends.
  const points = bars.filter(bar => bar.date < today || (bar.date === today && sessionFinished));
  return {
    symbol, points, source: SOURCE, sourceUrl: metadata.sourceUrl, freshness: 'eod',
    market: metadata.market, ticker: metadata.ticker, exchange: metadata.exchange, currency: metadata.currency,
    timeZone: metadata.timeZone, asOf: metadata.asOf,
    ...(metadata.sourceCurrency ? { sourceCurrency: metadata.sourceCurrency, sourceUnit: metadata.sourceUnit } : {}),
  };
}

function qualifiedSearchTicker(ticker, market) {
  if (typeof ticker !== 'string') return null;
  const suffix = MARKETS[market].suffix;
  if (suffix && !ticker.endsWith(suffix)) return null;
  const native = suffix ? ticker.slice(0, -suffix.length) : ticker;
  try { const identity = parseGlobalSymbol(`${market}:${native}`); return identity.ticker === ticker ? identity : null; }
  catch { return null; }
}

export function parseYahooSearch(raw, market = 'US') {
  if (!Object.hasOwn(MARKETS, market) || !raw || !Array.isArray(raw.quotes) || raw.quotes.length > 200) throw changed();
  const specification = MARKETS[market], instruments = new Map();
  for (const row of raw.quotes) {
    if (!row || !['EQUITY', 'ETF'].includes(row.quoteType) || row.isYahooFinance === false) continue;
    const identity = qualifiedSearchTicker(row.symbol, market);
    const name = validText(row.longname) ? row.longname.trim() : validText(row.shortname) ? row.shortname.trim() : null;
    if (!identity || !name || !validText(row.exchange, 80)) continue;
    if (row.currency !== undefined && row.currency !== specification.currency && !(market === 'GB' && row.currency === 'GBp')) continue;
    instruments.set(identity.symbol, {
      symbol: identity.symbol, ticker: identity.ticker, market, name, assetType: row.quoteType === 'ETF' ? 'etf' : 'stock',
      currency: specification.currency, timeZone: specification.timeZone,
      exchange: validText(row.exchDisp, 80) ? row.exchDisp.trim() : row.exchange.trim(), verified: true,
    });
    if (instruments.size >= 30) break;
  }
  return [...instruments.values()];
}

function response(payload, status = 200, retryAfter = null) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  if (retryAfter !== null) headers['Retry-After'] = String(retryAfter);
  return new Response(JSON.stringify(payload), { status, headers });
}

function parameters(params, allowed) {
  for (const key of params.keys()) if (!allowed.includes(key) || params.getAll(key).length !== 1) throw invalid();
}

/** Importing the adapter makes no connection. The caller retains loopback/origin checks. */
export function createFreeGlobal({ fetchFn = globalThis.fetch, now = () => Date.now(), timeoutMs = 3500, maximumConcurrency = 4, requestBudgetMs = 8500, mirrorFallback = false, mirrorFactory = createFreeGlobalMirror } = {}) {
  if (typeof fetchFn !== 'function' || typeof now !== 'function' || !Number.isFinite(timeoutMs) || timeoutMs <= 0
    || !Number.isInteger(maximumConcurrency) || maximumConcurrency < 1 || maximumConcurrency > 4 || !Number.isFinite(requestBudgetMs) || requestBudgetMs <= 0) throw new TypeError('Invalid international adapter options.');
  const cache = new Map(), pending = new Map();
  let cooldownUntil = 0, mirrorUntil = 0;
  const mirror = mirrorFallback ? mirrorFactory({ fetchFn, now, timeoutMs: 7000 }) : null;
  const usingMirror = () => mirrorFallback && mirrorUntil > now();
  const canMirror = error => mirrorFallback && error instanceof GlobalSourceError && ['source_unavailable', 'source_timeout', 'rate_limited'].includes(error.code);
  const safeError = error => error instanceof GlobalSourceError || error instanceof GlobalMirrorError ? error : unavailable();
  const startMirror = () => { mirrorUntil = now() + 900000; };
  const generatedAt = () => new Date(now()).toISOString();
  async function memo(key, ttl, load) {
    const prior = cache.get(key);
    if (prior?.expires > now()) return { data: prior.data, cached: true };
    if (prior) cache.delete(key);
    if (pending.has(key)) return { data: await pending.get(key), cached: false };
    const operation = (async () => {
      const data = await load();
      if (cache.size >= 256) cache.delete(cache.keys().next().value);
      cache.set(key, { data, expires: now() + ttl });
      return data;
    })();
    pending.set(key, operation);
    try { return { data: await operation, cached: false }; }
    finally { pending.delete(key); }
  }

  async function fetchJson(path, query, requestDeadline) {
    if (cooldownUntil > now()) throw new GlobalSourceError(429, 'rate_limited', 'The international source is rate limited. Try again later.', Math.min(300, Math.max(1, Math.ceil((cooldownUntil - now()) / 1000))));
    const deadline = Math.min(requestDeadline, mono() + (mirrorFallback ? Math.min(timeoutMs, 1500) : timeoutMs));
    let lastError = unavailable();
    for (const host of HOSTS) {
      const remaining = deadline - mono();
      if (remaining <= 1) throw timeout();
      const url = new URL(path, host);
      for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
      const controller = new AbortController();
      let timer;
      try {
        return await Promise.race([
          new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(timeout()); }, remaining); }),
          (async () => {
            const result = await fetchFn(url.toString(), { method: 'GET', headers: { Accept: 'application/json', 'User-Agent': 'Market-Dashboard/1.0 (personal local viewer)' }, signal: controller.signal, redirect: 'error' });
            if (result.status === 429) {
              const header = result.headers.get('Retry-After');
              const supplied = header && /^\d+(?:\.\d+)?$/u.test(header) ? Number(header) : header ? (Date.parse(header) - now()) / 1000 : 30;
              const seconds = Number.isFinite(supplied) ? Math.min(300, Math.max(1, Math.ceil(supplied))) : 30;
              cooldownUntil = now() + seconds * 1000;
              throw new GlobalSourceError(429, 'rate_limited', 'The international source is rate limited. Try again later.', seconds);
            }
            if (result.status === 404) throw unknown();
            if (!result.ok) throw unavailable();
            if (Number(result.headers.get('Content-Length')) > MAX_BYTES) throw changed();
            const text = await result.text();
            if (new TextEncoder().encode(text).byteLength > MAX_BYTES) throw changed();
            try { return JSON.parse(text); } catch { throw changed(); }
          })(),
        ]);
      } catch (error) {
        lastError = error instanceof GlobalSourceError ? error : unavailable();
        if (!['source_unavailable'].includes(lastError.code)) throw lastError;
      } finally { clearTimeout(timer); }
    }
    throw lastError;
  }

  async function chart(identity, range, requestDeadline) {
    return fetchJson(`/v8/finance/chart/${encodeURIComponent(identity.ticker)}`, { interval: '1d', range, includePrePost: 'false', events: 'div,splits' }, requestDeadline);
  }

  async function quote(symbol, requestDeadline) {
    const identity = parseGlobalSymbol(symbol);
    if (usingMirror()) return mirror.quote(symbol, requestDeadline);
    try {
      const result = await memo(`quote:${symbol}`, 60000, async () => parseYahooQuote(await chart(identity, '5d', requestDeadline), symbol, now()));
      return { ...result.data, cached: result.cached };
    } catch (error) { if (!canMirror(error)) throw error; startMirror(); return mirror.quote(symbol, requestDeadline); }
  }

  async function handle(request) {
    try {
      if (request.method !== 'GET') return response({ error: { code: 'method_not_allowed', message: 'Only GET requests are supported.' } }, 405);
      const url = new URL(request.url), params = url.searchParams, deadline = mono() + requestBudgetMs;
      if (url.pathname === '/catalog') {
        parameters(params, ['market', 'q']);
        const market = params.get('market') ?? 'US';
        if (!Object.hasOwn(MARKETS, market)) throw invalid();
        const specification = MARKETS[market];
        let query = params.get('q')?.trim() ?? '';
        if (/^[A-Z]{2}:/u.test(query)) {
          const identity = parseGlobalSymbol(query);
          if (identity.market !== market) throw invalid();
          query = identity.ticker;
        }
        if (query.length > 80 || (query && !/^[\p{L}\p{N} .&'()+-]+$/u.test(query))) throw invalid();
        const coverage = { type: 'searchable', note: 'Search Yahoo Finance to find additional instruments. These examples are metadata only; quote availability requires a provider response.' };
        if (usingMirror()) return response(await mirror.catalog(market, query, deadline));
        if (!query) {
          const instruments = specification.starters.map(([native, name]) => ({ symbol: `${market}:${native}`, ticker: native + specification.suffix, market, name, assetType: 'stock', currency: specification.currency, timeZone: specification.timeZone, exchange: specification.exchange, verified: false }));
          return response({ instruments, market, source: SOURCE, sourceProvider: SOURCE, asOf: generatedAt(), coverage });
        }
        try {
          const result = await memo(`search:${market}:${query.toLowerCase()}`, 600000, async () => ({
            instruments: parseYahooSearch(await fetchJson('/v1/finance/search', { q: query, quotesCount: '30', newsCount: '0', enableFuzzyQuery: 'false' }, deadline), market), asOf: generatedAt(),
          }));
          return response({ ...result.data, market, source: SOURCE, sourceProvider: SOURCE, coverage, cached: result.cached });
        } catch (error) { if (!canMirror(error)) throw error; startMirror(); return response(await mirror.catalog(market, query, deadline)); }
      }
      if (url.pathname === '/quotes') {
        parameters(params, ['symbols']);
        const symbols = (params.get('symbols') ?? '').split(',');
        if (symbols.length < 1 || symbols.length > 20 || new Set(symbols).size !== symbols.length) throw invalid();
        symbols.forEach(parseGlobalSymbol);
        const outcomes = new Array(symbols.length);
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(maximumConcurrency, symbols.length) }, async () => {
          while (next < symbols.length) {
            const index = next++, symbol = symbols[index];
            try { if (deadline - mono() <= 1) throw timeout(); outcomes[index] = { quote: await quote(symbol, deadline) }; }
            catch (error) {
              const safe = safeError(error);
              outcomes[index] = { issue: { symbol, code: safe.code, message: safe.message, ...(safe.retryAfter !== null ? { retryAfter: safe.retryAfter } : {}) } };
            }
          }
        }));
        const issues = outcomes.flatMap(outcome => outcome.issue ? [outcome.issue] : []);
        const retries = issues.map(issue => issue.retryAfter).filter(value => Number.isFinite(value));
        const quotes = outcomes.flatMap(outcome => outcome.quote ? [outcome.quote] : []);
        const mirrorCoverage = quotes.find(quote => quote.coverage?.type === 'daily_mirror')?.coverage;
        return response({ quotes, issues, generatedAt: generatedAt(), ...(mirrorCoverage ? { coverage: mirrorCoverage } : {}) }, 200, retries.length ? Math.max(...retries) : null);
      }
      const history = /^\/history\/([^/]+)$/u.exec(url.pathname);
      if (history) {
        parameters(params, ['range']);
        let symbol;
        try { symbol = decodeURIComponent(history[1]); } catch { throw invalid(); }
        const identity = parseGlobalSymbol(symbol), range = params.get('range') ?? '1m';
        if (!Object.hasOwn(RANGES, range)) throw invalid();
        if (usingMirror()) return response(await mirror.history(symbol, range, deadline));
        try {
          const result = await memo(`history:${symbol}:${range}`, 300000, async () => parseYahooHistory(await chart(identity, RANGES[range], deadline), symbol, range, now()));
          return response({ ...result.data, cached: result.cached });
        } catch (error) { if (!canMirror(error)) throw error; startMirror(); return response(await mirror.history(symbol, range, deadline)); }
      }
      parameters(params, []);
      return response({ error: { code: 'not_found', message: 'International endpoint not found.' } }, 404);
    } catch (error) {
      const safe = safeError(error);
      return response({ error: { code: safe.code, message: safe.message } }, safe.status, safe.retryAfter);
    }
  }
  return { handle, fetch: handle };
}
