/** Public market gateway. No provider credentials or raw provider errors reach clients. */
export const CATALOG = Object.freeze({
  AC: 'Ayala Corporation', BDO: 'BDO Unibank', SM: 'SM Investments Corporation',
  SMPH: 'SM Prime Holdings', ALI: 'Ayala Land', BPI: 'Bank of the Philippine Islands',
  MBT: 'Metropolitan Bank & Trust', JFC: 'Jollibee Foods Corporation', TEL: 'PLDT',
  GLO: 'Globe Telecom', ICT: 'International Container Terminal Services',
  URC: 'Universal Robina Corporation', AEV: 'Aboitiz Equity Ventures',
  AP: 'Aboitiz Power Corporation', MER: 'Manila Electric Company',
  CNVRG: 'Converge ICT Solutions', MONDE: 'Monde Nissin Corporation',
  DMC: 'DMCI Holdings', LTG: 'LT Group', FMETF: 'First Metro Philippine Equity ETF',
});
const RANGES = Object.freeze({ '1w': 7, '1m': 31, '3m': 93, '1y': 366 });
const CATEGORIES = new Set(['Equity', 'Balanced', 'Bond', 'Money market']);
const NAV_TYPES = new Set(['NAVPS', 'NAVPU', 'iNAV']);
const FUND_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PSE_SYMBOL = /^[A-Z0-9][A-Z0-9.-]{0,14}$/;
const validSymbol = symbol => typeof symbol === 'string' && PSE_SYMBOL.test(symbol) && !symbol.endsWith('.PSE') && symbol !== 'PSEI';
const PROVIDER_BASE = 'https://eodhd.com/api/';
const MAX_BODY_BYTES = 512 * 1024;
const MAX_RETRY_SECONDS = 300;
const CACHE_VERSION = 'v2';
const CATALOG_TTL_SECONDS = 86400;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

class GatewayError extends Error {
  constructor(status, code, message, headers = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}
const invalid = (message = 'Invalid request parameters.') =>
  new GatewayError(400, 'invalid_request', message);
const unavailable = () => new GatewayError(503, 'data_unavailable', 'Licensed data is unavailable.');
const badPayload = () => new GatewayError(502, 'invalid_provider_data', 'The data service returned an invalid response.');

export function numberOrNull(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
const nonnegative = value => {
  const parsed = numberOrNull(value);
  return parsed !== null && parsed >= 0 ? parsed : null;
};
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function textOrNull(value) {
  return typeof value === 'string' && value.trim() && value.length <= 160 && !/[\u0000-\u001f]/.test(value) ? value.trim() : null;
}
function dateOrNull(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null;
}
function isoOrNull(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  if (!dateOrNull(value.slice(0, 10))) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
export function manilaDate(timestamp) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(timestamp));
  const part = type => parts.find(item => item.type === type).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
function providerTimestamp(value) {
  const seconds = numberOrNull(value);
  if (seconds === null || seconds <= 0 || !Number.isInteger(seconds)) return null;
  const date = new Date(seconds * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
function changes(value, previousClose, change, percent) {
  if (value === null) return { change: null, changePercent: null };
  const suppliedChange = numberOrNull(change);
  const suppliedPercent = numberOrNull(percent);
  const difference = suppliedChange ?? (previousClose !== null ? value - previousClose : null);
  return {
    change: difference,
    changePercent: previousClose === 0 ? null : suppliedPercent ?? (previousClose !== null && difference !== null ? difference / previousClose * 100 : null),
  };
}

export function normalizeQuote(row, symbol, instrument = {}) {
  const raw = isRecord(row) ? row : {};
  const value = nonnegative(raw.close);
  const previousClose = nonnegative(raw.previousClose);
  const asOf = providerTimestamp(raw.timestamp);
  return {
    symbol, name: textOrNull(instrument.name) ?? CATALOG[symbol] ?? symbol,
    assetType: instrument.assetType === 'etf' || symbol === 'FMETF' ? 'etf' : 'stock', currency: 'PHP',
    value, valueType: 'last_trade', previousClose,
    ...changes(value, previousClose, raw.change, raw.change_p),
    volume: nonnegative(raw.volume), asOf, marketDate: asOf ? manilaDate(asOf) : null,
    freshness: 'delayed', delayMinutes: 20, source: 'EODHD',
  };
}
function checkSourceTime(value, nowMs) {
  if (value === null || value === undefined) return;
  const timestamp = isoOrNull(value);
  if (!timestamp || Date.parse(timestamp) > nowMs + MAX_CLOCK_SKEW_MS) throw unavailable();
}
function checkSourceDate(value, nowMs) {
  if (value === null || value === undefined) return;
  if (!dateOrNull(value) || value > manilaDate(nowMs)) throw unavailable();
}
function normalizeIndex(raw, nowMs) {
  requireApprovedSource(raw);
  checkSourceTime(raw.asOf, nowMs);
  checkSourceDate(raw.marketDate, nowMs);
  if (!isRecord(raw) || raw.symbol !== 'PSEI' || raw.valueType !== 'index_level' || !textOrNull(raw.source) || !['delayed', 'eod', 'real_time'].includes(raw.freshness)) throw unavailable();
  const value = nonnegative(raw.value);
  const previousClose = nonnegative(raw.previousClose);
  const asOf = isoOrNull(raw.asOf);
  const marketDate = dateOrNull(raw.marketDate);
  if (value === null || (!asOf && !marketDate)) throw unavailable();
  const delayMinutes = nonnegative(raw.delayMinutes);
  if (raw.freshness === 'delayed' && delayMinutes === null) throw unavailable();
  return {
    symbol: 'PSEI', name: textOrNull(raw.name) ?? 'PSE Composite Index', assetType: 'index', currency: 'PHP',
    value, valueType: 'index_level', previousClose, ...changes(value, previousClose, raw.change, raw.changePercent),
    volume: nonnegative(raw.volume), asOf, marketDate: marketDate ?? (asOf ? manilaDate(asOf) : null),
    freshness: raw.freshness, delayMinutes: raw.freshness === 'delayed' ? delayMinutes : null, source: textOrNull(raw.source),
  };
}
function normalizeNav(raw, nowMs) {
  requireApprovedSource(raw);
  checkSourceTime(raw.asOf, nowMs);
  checkSourceDate(raw.valuationDate, nowMs);
  if (!isRecord(raw) || !NAV_TYPES.has(raw.valueType) || !textOrNull(raw.source) || !(nonnegative(raw.value) > 0) || !dateOrNull(raw.valuationDate)) throw unavailable();
  return { value: nonnegative(raw.value), valueType: raw.valueType, asOf: isoOrNull(raw.asOf), valuationDate: dateOrNull(raw.valuationDate), source: textOrNull(raw.source) };
}
function normalizeFunds(raw, nowMs) {
  requireApprovedSource(raw);
  checkSourceTime(raw.generatedAt, nowMs);
  if (!isRecord(raw) || !Array.isArray(raw.funds) || raw.funds.length > 500 || !isoOrNull(raw.generatedAt)) throw unavailable();
  const seen = new Set();
  const funds = raw.funds.map(row => {
    requireApprovedSource(row);
    checkSourceTime(row.asOf, nowMs);
    checkSourceDate(row.valuationDate, nowMs);
    if (!isRecord(row) || typeof row.id !== 'string' || !FUND_ID.test(row.id) || seen.has(row.id) || !textOrNull(row.name) || !CATEGORIES.has(row.category) || row.currency !== 'PHP' || !['NAVPS', 'NAVPU'].includes(row.valueType) || !textOrNull(row.source) || !dateOrNull(row.valuationDate)) throw unavailable();
    seen.add(row.id);
    const value = nonnegative(row.value);
    if (!(value > 0)) throw unavailable();
    const previousClose = nonnegative(row.previousClose);
    return {
      id: row.id, name: textOrNull(row.name), category: row.category, currency: row.currency,
      value, valueType: row.valueType, previousClose, ...changes(value, previousClose, row.change, row.changePercent),
      valuationDate: dateOrNull(row.valuationDate), asOf: isoOrNull(row.asOf), freshness: 'daily_nav', source: textOrNull(row.source),
    };
  });
  return { funds, generatedAt: isoOrNull(raw.generatedAt) };
}
function requireApprovedSource(raw) {
  if (!isRecord(raw) || raw.mode === 'demo' || raw.approvedForPublicDisplay === false || raw.provenance?.approvedForPublicDisplay === false) throw unavailable();
}
function normalizeCatalog(raw, { provider = false, asOf, nowMs }) {
  if (!provider) {
    requireApprovedSource(raw);
    checkSourceTime(raw.asOf, nowMs);
    if (!textOrNull(raw.source) || !isoOrNull(raw.asOf)) throw unavailable();
  }
  const rows = provider ? raw : raw.instruments;
  const fail = provider ? badPayload : unavailable;
  if (!Array.isArray(rows) || !rows.length || rows.length > 5000) throw fail();
  const seen = new Set();
  const instruments = [];
  for (const row of rows) {
    if (!isRecord(row)) throw fail();
    if (!provider) requireApprovedSource(row);
    const symbol = provider ? row.Code : row.symbol;
    const name = textOrNull(provider ? row.Name : row.name);
    const currency = provider ? row.Currency : row.currency;
    const kind = provider ? String(row.Type ?? '').toLowerCase() : row.assetType;
    const assetType = provider ? (kind === 'etf' ? 'etf' : ['common stock', 'preferred stock', 'stock', 'reit'].includes(kind) ? 'stock' : null) : kind;
    // The exchange listing may include non-PHP or unsupported instrument types.
    if (provider && (currency !== 'PHP' || assetType === null || symbol === 'PSEI')) continue;
    if (!validSymbol(symbol) || !name || currency !== 'PHP' || !['stock', 'etf'].includes(assetType) || seen.has(symbol)) throw fail();
    if (provider && row.Exchange !== undefined && row.Exchange !== 'PSE') throw fail();
    seen.add(symbol);
    const sector = textOrNull(provider ? row.Sector : row.sector);
    instruments.push({ symbol, name, assetType, currency: 'PHP', ...(sector ? { sector } : {}) });
  }
  if (!instruments.length) throw fail();
  instruments.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return { instruments, source: provider ? 'EODHD' : textOrNull(raw.source), asOf: provider ? asOf : isoOrNull(raw.asOf) };
}

function validateParams(params, permitted) {
  const seen = new Set();
  for (const key of params.keys()) {
    if (!permitted.includes(key) || seen.has(key)) throw invalid();
    seen.add(key);
  }
}
export function parseRoute(url) {
  const params = url.searchParams;
  if (url.pathname === '/catalog') {
    validateParams(params, ['q']);
    const query = params.has('q') ? params.get('q').trim() : null;
    if (query !== null && (!query || query.length > 80 || !/^[A-Za-z0-9 .&'()-]+$/.test(query))) throw invalid('Search by a symbol or company name, up to 80 characters.');
    return { type: 'catalog', query, ttl: CATALOG_TTL_SECONDS, key: '/catalog' };
  }
  if (url.pathname === '/quotes') {
    validateParams(params, ['symbols']);
    const symbols = (params.get('symbols') ?? '').split(',');
    if (symbols.length > 20) throw invalid('A maximum of 20 symbols is allowed.');
    if (!symbols.length || symbols.some(symbol => !validSymbol(symbol)) || new Set(symbols).size !== symbols.length) throw invalid('Use unique, valid PSE symbols without an exchange suffix.');
    return { type: 'quotes', symbols: symbols.sort(), ttl: 60, key: `/quotes?symbols=${symbols.join(',')}`, usesEodhd: true };
  }
  const equityHistory = /^\/history\/([A-Z0-9][A-Z0-9.-]{0,14})$/.exec(url.pathname);
  if (equityHistory) {
    validateParams(params, ['range']);
    const symbol = equityHistory[1];
    const range = params.get('range') ?? '1m';
    if ((!validSymbol(symbol) && symbol !== 'PSEI') || !Object.hasOwn(RANGES, range)) throw invalid();
    if (symbol === 'PSEI') return { type: 'indexHistory', symbol, range, ttl: 3600, key: `/history/PSEI?range=${range}` };
    return { type: 'history', symbol, range, ttl: 3600, key: `/history/${symbol}?range=${range}`, usesEodhd: true };
  }
  const fundHistory = /^\/funds\/([a-z0-9][a-z0-9-]{0,63})\/history$/.exec(url.pathname);
  if (fundHistory) {
    validateParams(params, ['range']);
    const range = params.get('range') ?? '1m';
    if (!Object.hasOwn(RANGES, range)) throw invalid();
    return { type: 'fundHistory', id: fundHistory[1], range, ttl: 3600, key: `/funds/${fundHistory[1]}/history?range=${range}` };
  }
  validateParams(params, []);
  if (url.pathname === '/index/PSEI') return { type: 'index', ttl: 60, key: '/index/PSEI' };
  if (url.pathname === '/funds') return { type: 'funds', ttl: 3600, key: '/funds' };
  if (url.pathname === '/etf/FMETF') return { type: 'etf', symbols: ['FMETF'], ttl: 60, key: '/etf/FMETF', usesEodhd: true };
  throw new GatewayError(404, 'not_found', 'Endpoint not found.');
}

function allowedOrigin(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin) return null;
  const allowed = String(env.ALLOWED_ORIGINS ?? '').split(',').map(value => value.trim()).filter(value => {
    try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && value === url.origin; } catch { return false; }
  });
  if (!allowed.includes(origin)) throw new GatewayError(403, 'origin_forbidden', 'This origin is not allowed.');
  return origin;
}
function publicResponse(body, { status = 200, origin = null, headers: extra = {} } = {}) {
  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Vary': 'Origin', ...extra });
  if (origin) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Expose-Headers', 'Retry-After, X-Market-Cache');
  }
  return new Response(body === null ? null : JSON.stringify(body), { status, headers });
}
export function retrySeconds(header, now) {
  const numeric = numberOrNull(header);
  const date = typeof header === 'string' && numeric === null ? Date.parse(header) : NaN;
  const seconds = numeric ?? (Number.isFinite(date) ? (date - now) / 1000 : 30);
  return Math.max(1, Math.min(MAX_RETRY_SECONDS, Math.ceil(seconds)));
}
async function limitedJson(response) {
  const size = numberOrNull(response.headers.get('Content-Length'));
  if (size !== null && size > MAX_BODY_BYTES) throw badPayload();
  if (!response.body) throw badPayload();
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY_BYTES) { await reader.cancel(); throw badPayload(); }
      chunks.push(value);
    }
    const data = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder().decode(data));
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    throw badPayload();
  } finally { reader.releaseLock(); }
}

export function createWorker({ fetchFn = globalThis.fetch, cache = globalThis.caches?.default, now = () => Date.now(), timeoutMs = 8000, privateLocalUse = false } = {}) {
  const generatedAt = () => new Date(now()).toISOString();
  let catalogMemo = null;
  let catalogPending = null;
  let catalogCooldown = null;
  const configuredToken = env => typeof env.EODHD_TOKEN === 'string' && Boolean(env.EODHD_TOKEN.trim());
  const configurationError = () => new GatewayError(503, 'service_configuration', 'The data service is not configured for this request.');
  const sameCatalogConfig = (record, env, origin) => record && record.origin === origin && record.token === env.EODHD_TOKEN && record.binding === env.MARKET_DATA;
  async function upstream(path, params, env) {
    const url = new URL(path, PROVIDER_BASE);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    url.searchParams.set('api_token', env.EODHD_TOKEN);
    url.searchParams.set('fmt', 'json');
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new GatewayError(504, 'provider_timeout', 'The data service timed out.')); }, timeoutMs);
    });
    try {
      return await Promise.race([timeout, (async () => {
        const response = await fetchFn(url.toString(), { method: 'GET', headers: { Accept: 'application/json' }, signal: controller.signal, redirect: 'error' });
        if (response.status === 429) throw new GatewayError(429, 'rate_limited', 'The data service is rate limited. Try again later.', { 'Retry-After': String(retrySeconds(response.headers.get('Retry-After'), now())) });
        if (response.status === 401 || response.status === 403) throw new GatewayError(503, 'service_configuration', 'The data service is not configured for this request.');
        if (response.status === 404) throw new GatewayError(404, 'quote_unavailable', 'No data is available for this instrument.');
        if (!response.ok) throw new GatewayError(502, 'provider_unavailable', 'The data service is temporarily unavailable.');
        return limitedJson(response);
      })()]);
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      if (controller.signal.aborted) throw new GatewayError(504, 'provider_timeout', 'The data service timed out.');
      throw new GatewayError(502, 'provider_unavailable', 'The data service is temporarily unavailable.');
    } finally { clearTimeout(timer); }
  }
  async function quotes(symbols, env, instruments) {
    const [first, ...rest] = symbols;
    const raw = await upstream(`real-time/${first}.PSE`, rest.length ? { s: rest.map(symbol => `${symbol}.PSE`).join(',') } : {}, env);
    const rows = Array.isArray(raw) ? raw : [raw];
    if (!rows.length || rows.length > 20 || rows.some(row => !isRecord(row) || typeof row.code !== 'string')) throw badPayload();
    const mapped = new Map();
    for (const row of rows) {
      const symbol = row.code.replace(/\.PSE$/, '');
      if (!symbols.includes(symbol) || row.code !== `${symbol}.PSE` || mapped.has(symbol)) throw badPayload();
      if (row.timestamp !== null && row.timestamp !== undefined) {
        const asOf = providerTimestamp(row.timestamp);
        if (!asOf || Date.parse(asOf) > now() + MAX_CLOCK_SKEW_MS) throw badPayload();
      }
      mapped.set(symbol, row);
    }
    return symbols.map(symbol => normalizeQuote(mapped.get(symbol), symbol, instruments.get(symbol)));
  }
  async function stored(env, key, optional = false) {
    if (!env.MARKET_DATA?.get) { if (optional) return null; throw unavailable(); }
    try {
      const raw = await env.MARKET_DATA.get(key, { type: 'json' });
      if (raw === null || raw === undefined) { if (optional) return null; throw unavailable(); }
      return raw;
    } catch { throw unavailable(); }
  }
  async function writeCache(key, body, ttl, ctx) {
    if (!cache) return;
    const response = new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${ttl}`, 'X-Market-Cached-At': String(now()) } });
    const pending = Promise.resolve().then(() => cache.put(key, response)).catch(() => {});
    if (ctx.waitUntil) ctx.waitUntil(pending); else await pending;
  }
  async function catalog(env, origin, ctx = {}) {
    if (sameCatalogConfig(catalogMemo, env, origin) && catalogMemo.expiresAt > now()) return catalogMemo.body;
    if (sameCatalogConfig(catalogCooldown, env, origin) && catalogCooldown.until > now()) throw new GatewayError(429, 'rate_limited', 'The data service is rate limited. Try again later.', { 'Retry-After': String(retrySeconds((catalogCooldown.until - now()) / 1000, now())) });
    if (sameCatalogConfig(catalogPending, env, origin)) return catalogPending.promise;
    const key = new Request(`${origin}/__market_cache/${CACHE_VERSION}/catalog`);
    const promise = (async () => {
      let body;
      let expiresAt;
      if (cache) {
        try {
          const hit = await cache.match(key);
          const cachedAt = hit ? numberOrNull(hit.headers.get('X-Market-Cached-At')) : null;
          if (hit?.ok && cachedAt !== null && cachedAt <= now() && cachedAt + CATALOG_TTL_SECONDS * 1000 > now()) {
            body = normalizeCatalog(await hit.json(), { nowMs: now() });
            expiresAt = cachedAt + CATALOG_TTL_SECONDS * 1000;
          }
        } catch { /* An invalid/failed cache is recovered from the actual source. */ }
      }
      if (!body) {
        const approved = await stored(env, 'catalog:PSE', true);
        if (approved !== null) body = normalizeCatalog(approved, { nowMs: now() });
        else {
          if (!configuredToken(env)) throw configurationError();
          const raw = await upstream('exchange-symbol-list/PSE', {}, env);
          body = normalizeCatalog(raw, { provider: true, asOf: generatedAt(), nowMs: now() });
        }
        await writeCache(key, body, CATALOG_TTL_SECONDS, ctx);
        expiresAt = now() + CATALOG_TTL_SECONDS * 1000;
      }
      catalogMemo = { origin, token: env.EODHD_TOKEN, binding: env.MARKET_DATA, body, expiresAt };
      return body;
    })();
    const pending = { origin, token: env.EODHD_TOKEN, binding: env.MARKET_DATA, promise };
    catalogPending = pending;
    try { return await promise; }
    catch (error) {
      if (error instanceof GatewayError && error.status === 429) catalogCooldown = { origin, token: env.EODHD_TOKEN, binding: env.MARKET_DATA, until: now() + retrySeconds(error.headers['Retry-After'], now()) * 1000 };
      throw error;
    } finally { if (catalogPending === pending) catalogPending = null; }
  }
  async function verifyInstruments(route, env, origin, ctx) {
    let instruments;
    let fallback = false;
    try { instruments = (await catalog(env, origin, ctx)).instruments; }
    catch (error) {
      // Only the small reference list may survive a catalog outage. It contains no prices.
      // Entitlement and quota errors must propagate without another provider request.
      if (!(error instanceof GatewayError) || !['provider_unavailable', 'invalid_provider_data', 'provider_timeout', 'quote_unavailable'].includes(error.code)) throw error;
      fallback = true;
      instruments = Object.entries(CATALOG).map(([symbol, name]) => ({ symbol, name, assetType: symbol === 'FMETF' ? 'etf' : 'stock', currency: 'PHP' }));
    }
    const mapped = new Map(instruments.map(instrument => [instrument.symbol, instrument]));
    const requested = route.symbols ?? [route.symbol];
    if (requested.some(symbol => !mapped.has(symbol))) {
      if (fallback) throw new GatewayError(503, 'catalog_unavailable', 'The exchange catalog is temporarily unavailable.');
      throw new GatewayError(400, 'unknown_symbol', 'An instrument is not listed in the verified PSE catalog.');
    }
    return mapped;
  }
  function rangeDates(range) {
    const end = manilaDate(now());
    const start = new Date(`${end}T00:00:00Z`);
    start.setUTCDate(start.getUTCDate() - RANGES[range]);
    return { from: start.toISOString().slice(0, 10), to: end };
  }
  function points(raw, range, sourceError) {
    if (!Array.isArray(raw) || raw.length > 15000) throw sourceError();
    const { from, to } = rangeDates(range);
    const seen = new Set();
    return raw.map(row => {
      if (!isRecord(row) || !dateOrNull(row.date) || seen.has(row.date)) throw sourceError();
      seen.add(row.date);
      return { date: row.date, close: nonnegative(row.close) };
    }).filter(row => row.date >= from && row.date <= to).sort((a, b) => a.date.localeCompare(b.date));
  }
  async function load(route, env) {
    if (route.type === 'quotes') return { quotes: await quotes(route.symbols, env, route.instruments), generatedAt: generatedAt() };
    if (route.type === 'history') {
      const raw = await upstream(`eod/${route.symbol}.PSE`, { ...rangeDates(route.range), period: 'd', order: 'a' }, env);
      return { symbol: route.symbol, points: points(raw, route.range, badPayload), source: 'EODHD', freshness: 'eod' };
    }
    if (route.type === 'index') return { quote: normalizeIndex(await stored(env, 'index:PSEI'), now()), generatedAt: generatedAt() };
    if (route.type === 'indexHistory') {
      const raw = await stored(env, 'history:PSEI');
      requireApprovedSource(raw);
      if (raw.symbol !== 'PSEI' || !textOrNull(raw.source) || raw.freshness !== 'eod') throw unavailable();
      return { symbol: 'PSEI', points: points(raw.points, route.range, unavailable), source: textOrNull(raw.source), freshness: 'eod' };
    }
    if (route.type === 'funds') return normalizeFunds(await stored(env, 'funds:list'), now());
    if (route.type === 'fundHistory') {
      const catalog = normalizeFunds(await stored(env, 'funds:list'), now());
      if (!catalog.funds.some(fund => fund.id === route.id)) throw new GatewayError(404, 'fund_unavailable', 'No data is available for this fund.');
      const raw = await stored(env, `history:${route.id}`);
      requireApprovedSource(raw);
      if (!isRecord(raw) || (raw.symbol ?? raw.id) !== route.id || !textOrNull(raw.source) || raw.freshness !== 'eod') throw unavailable();
      return { symbol: route.id, points: points(raw.points, route.range, unavailable), source: textOrNull(raw.source), freshness: 'eod' };
    }
    if (route.type === 'etf') {
      const quote = (await quotes(['FMETF'], env, route.instruments))[0];
      const rawNav = await stored(env, 'etf:FMETF:nav', true);
      return { quote, nav: rawNav === null ? null : normalizeNav(rawNav, now()) };
    }
    throw unavailable();
  }
  return {
    async fetch(request, env = {}, ctx = {}) {
      let origin = null;
      try {
        origin = allowedOrigin(request, env);
        if (request.method !== 'GET' && request.method !== 'OPTIONS') throw new GatewayError(405, 'method_not_allowed', 'Only GET requests are supported.', { Allow: 'GET, OPTIONS' });
        const url = new URL(request.url);
        const route = parseRoute(url);
        if (request.method === 'OPTIONS') {
          if (!origin || request.headers.get('Access-Control-Request-Method') !== 'GET') throw invalid('Invalid preflight request.');
          const headers = (request.headers.get('Access-Control-Request-Headers') ?? '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
          if (headers.some(header => !['accept', 'content-type'].includes(header))) throw invalid('Unsupported request headers.');
          return publicResponse(null, { status: 204, origin, headers: { 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Accept, Content-Type', 'Access-Control-Max-Age': '600' } });
        }
        const privateLocal = privateLocalUse === true && env.PRIVATE_LOCAL_USE_CONFIRMED === 'true' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
        if (env.PUBLIC_DISPLAY_LICENSED !== 'true' && !privateLocal) throw new GatewayError(503, 'license_required', 'Public market-data display has not been enabled.');
        if (route.usesEodhd && !configuredToken(env)) throw configurationError();
        if (route.type === 'catalog' && !configuredToken(env) && !env.MARKET_DATA?.get) throw configurationError();
        if (['index', 'indexHistory', 'funds', 'fundHistory'].includes(route.type) && !env.MARKET_DATA?.get) throw unavailable();
        if (env.RATE_LIMITER?.limit) {
          const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
          const result = await env.RATE_LIMITER.limit({ key: ip });
          if (!result.success) throw new GatewayError(429, 'rate_limited', 'Too many requests. Try again later.', { 'Retry-After': '30' });
        }
        if (route.type === 'catalog') {
          const body = await catalog(env, url.origin, ctx);
          if (route.query === null) return publicResponse(body, { origin, headers: { 'X-Market-Cache': 'CATALOG' } });
          const query = route.query.toLowerCase();
          const matches = body.instruments.filter(instrument => instrument.symbol.toLowerCase().includes(query) || instrument.name.toLowerCase().includes(query));
          matches.sort((a, b) => {
            const rank = instrument => instrument.symbol.toLowerCase() === query ? 0 : instrument.symbol.toLowerCase().startsWith(query) ? 1 : 2;
            return rank(a) - rank(b) || a.symbol.localeCompare(b.symbol);
          });
          return publicResponse({ ...body, instruments: matches.slice(0, 30) }, { origin, headers: { 'X-Market-Cache': 'CATALOG' } });
        }
        if (route.usesEodhd) route.instruments = await verifyInstruments(route, env, url.origin, ctx);
        // No Origin or visitor headers enter this key. Authorization gates run on hits too.
        const cacheKey = new Request(`${url.origin}/__market_cache/${CACHE_VERSION}${route.key}`);
        if (cache) {
          try {
            const hit = await cache.match(cacheKey);
            if (hit?.ok) return publicResponse(await hit.json(), { origin, headers: { 'X-Market-Cache': 'HIT' } });
          } catch { /* Cache failure must not prevent a fresh request. */ }
        }
        const body = await load(route, env);
        if (cache) {
          await writeCache(cacheKey, body, route.ttl, ctx);
        }
        return publicResponse(body, { origin, headers: { 'X-Market-Cache': 'MISS' } });
      } catch (error) {
        const safe = error instanceof GatewayError ? error : new GatewayError(503, 'service_unavailable', 'The market-data service is temporarily unavailable.');
        return publicResponse({ error: { code: safe.code, message: safe.message } }, { status: safe.status, origin, headers: safe.headers });
      }
    },
  };
}

export default createWorker();
