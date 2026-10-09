/** Keyless personal-use adapter for the public PSE EDGE pages. */
const BASE = 'https://edge.pse.com.ph';
const SOURCE = 'PSE EDGE';
export const MIRROR_URL = 'https://raw.githubusercontent.com/zhameersheraz/ph-stocks/main/stocks.json';
const MIRROR_SOURCE = 'PSE EDGE via ph-stocks mirror';
const SYMBOL = /^[A-Z0-9][A-Z0-9.-]{0,14}$/;
const RANGES = { '1w': 7, '1m': 31, '3m': 93, '1y': 366 };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MAX_BYTES = 1024 * 1024;

class SourceError extends Error {
  constructor(status, code, message, retryAfter = null) { super(message); Object.assign(this, { status, code, retryAfter }); }
}
const drift = () => new SourceError(502, 'source_changed', 'The PSE page format changed or its data is invalid.');
const unavailable = () => new SourceError(503, 'source_unavailable', 'The public PSE source is temporarily unavailable.');
const invalid = () => new SourceError(400, 'invalid_request', 'Use supported request parameters and PSE symbols.');
const isSymbol = value => typeof value === 'string' && SYMBOL.test(value) && !value.endsWith('.PSE') && value !== 'PSEI';

function decode(value) {
  return value.replace(/&#(x[0-9a-f]+|\d+);/gi, (_, code) => {
    const number = code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : Number(code);
    return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : '';
  }).replace(/&(nbsp|amp|lt|gt|quot|apos);/gi, (_, name) => ({ nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[name.toLowerCase()]);
}
function plain(value) {
  return decode(String(value ?? '').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<img\b[^>]*\balt=["']([^"']*)["'][^>]*>/gi, ' $1 ').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}
function number(value) {
  const text = plain(value);
  if (!/^[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/.test(text)) return null;
  const result = Number(text.replaceAll(',', ''));
  return Number.isFinite(result) ? result : null;
}
const positiveOrZero = value => { const parsed = number(value); return parsed !== null && parsed >= 0 ? parsed : null; };
function calendarDate(year, month, day) {
  const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date ? date : null;
}
export function parseEdgeTimestamp(text, nowMs = Date.now()) {
  const match = plain(text).match(/\bAs of\s+([A-Za-z]{3})\s+(\d{1,2}),?\s+(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)\b/i);
  if (!match) throw drift();
  const month = MONTHS.findIndex(value => value.toLowerCase() === match[1].toLowerCase()) + 1;
  const date = calendarDate(match[3], month, Number(match[2]));
  const hours = Number(match[4]);
  const minutes = Number(match[5]);
  if (!date || !month || hours < 1 || hours > 12 || minutes > 59) throw drift();
  const hour24 = hours % 12 + (match[6].toUpperCase() === 'PM' ? 12 : 0);
  const asOf = `${date}T${String(hour24).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00+08:00`;
  if (Date.parse(asOf) > nowMs + 5 * 60 * 1000) throw drift();
  return { asOf, marketDate: date };
}
function attr(html, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = html.match(new RegExp(`\\b${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return match ? decode(match[1] ?? match[2] ?? match[3]) : null;
}
function labelPairs(html) {
  const fields = new Map();
  for (const row of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const labels = [...row[1].matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].map(match => plain(match[1]));
    const values = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(match => match[1]);
    if (labels.length && labels.length === values.length) labels.forEach((label, index) => fields.set(label, values[index]));
  }
  return fields;
}
function sourceChanges(raw, value, previousClose) {
  const text = plain(raw);
  const match = text.match(/([+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)\s*\(\s*([+-]?\d+(?:\.\d+)?)\s*%\s*\)/);
  if (!match || value === null) return { change: null, changePercent: null };
  let change = number(match[1]);
  let changePercent = number(match[2]);
  const down = /\bdown\b|▼|(?:class|src)\s*=\s*["'][^"']*(?:down|decline)/i.test(String(raw)) || change < 0 || changePercent < 0 || (previousClose !== null && value < previousClose);
  if (down) { change = -Math.abs(change); changePercent = -Math.abs(changePercent); }
  return { change, changePercent: previousClose === 0 ? null : changePercent };
}

export function parseEdgeQuote(html, instrument, nowMs = Date.now()) {
  const fields = labelPairs(html);
  if (!fields.has('Last Traded Price') || !fields.has('Previous Close and Date') || !fields.has('Volume')) throw drift();
  const timestamp = parseEdgeTimestamp(html, nowMs);
  const value = positiveOrZero(fields.get('Last Traded Price'));
  const previous = plain(fields.get('Previous Close and Date')).match(/^([+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)(?:\s|\(|$)/);
  const previousClose = previous ? positiveOrZero(previous[1]) : null;
  const volume = positiveOrZero(fields.get('Volume'));
  const companyInput = [...html.matchAll(/<input\b[^>]*>/gi)].find(match => attr(match[0], 'name') === 'cmpy_id');
  const companyId = companyInput ? attr(companyInput[0], 'value') : null;
  if (companyId && companyId !== instrument.companyId) throw drift();
  const select = [...html.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)].find(match => attr(match[1], 'name') === 'security_id');
  let securityId = instrument.securityId ?? null;
  if (select) {
    const options = [...select[2].matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)];
    const chosen = options.find(option => /\bselected(?:\s|=|$)/i.test(option[1])) ?? options[0];
    if (chosen) securityId = attr(chosen[1], 'value');
  }
  if (securityId !== null && !/^\d{1,10}$/.test(securityId)) throw drift();
  if (instrument.securityId && securityId !== instrument.securityId) throw drift();
  return {
    quote: {
      symbol: instrument.symbol, name: instrument.name, assetType: instrument.assetType, currency: 'PHP',
      value, valueType: 'last_trade', previousClose, ...sourceChanges(fields.get('Change(% Change)'), value, previousClose),
      volume: Number.isInteger(volume) ? volume : null, ...timestamp, freshness: 'snapshot', delayMinutes: null,
      source: SOURCE, sourceUrl: `${BASE}/companyPage/stockData.do?cmpy_id=${instrument.companyId}`,
    },
    companyId: instrument.companyId, securityId,
  };
}

export function parseEdgeDirectory(html) {
  const content = plain(html);
  const pages = content.match(/\[\s*(\d+)\s*\/\s*(\d+)\s*\]/);
  const total = content.match(/\[\s*Total\s+([\d,]+)\s*\]/i);
  if (!pages || !total) throw drift();
  const page = Number(pages[1]), pageCount = Number(pages[2]), expectedTotal = Number(total[1].replaceAll(',', ''));
  if (page < 1 || pageCount < page || pageCount > 30 || expectedTotal < 1 || expectedTotal > 1500) throw drift();
  const headers = [...html.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].map(match => plain(match[1]).toLowerCase());
  const nameAt = headers.indexOf('company name'), symbolAt = headers.indexOf('stock symbol'), sectorAt = headers.indexOf('sector');
  if (nameAt < 0 || symbolAt < 0) throw drift();
  const instruments = [];
  for (const row of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)];
    if (!cells.length) continue;
    if (cells.length !== headers.length) {
      if (/no data\.?/i.test(plain(row[1]))) continue;
      throw drift();
    }
    const name = plain(cells[nameAt][1]), symbol = plain(cells[symbolAt][1]);
    const action = decode(row[0]).match(/cmDetail\(\s*['"]?(\d+)['"]?\s*,\s*['"]?(\d+)['"]?\s*\)/i);
    const link = decode(row[0]).match(/cmpy_id=(\d+)(?:&(?:amp;)?security_id=(\d+))?/i);
    const companyId = action?.[1] ?? link?.[1], securityId = action?.[2] ?? link?.[2] ?? null;
    if (!name || !isSymbol(symbol) || !companyId || !/^\d{1,10}$/.test(companyId)) throw drift();
    const sector = sectorAt < 0 ? '' : plain(cells[sectorAt][1]);
    instruments.push({ symbol, name, assetType: symbol === 'FMETF' || /exchange.traded|\betf\b/i.test(sector) ? 'etf' : 'stock', currency: 'PHP', ...(sector ? { sector } : {}), companyId, securityId });
  }
  if (!instruments.length) throw drift();
  return { instruments, page, pages: pageCount, total: expectedTotal };
}

export function parseEdgeIndex(html, nowMs = Date.now()) {
  const row = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].find(match => {
    const first = match[1].match(/<td\b[^>]*>([\s\S]*?)<\/td>/i);
    return first && plain(first[1]).toUpperCase() === 'PSEI';
  });
  if (!row) throw drift();
  const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(match => match[1]);
  if (cells.length !== 4) throw drift();
  const value = positiveOrZero(cells[1]);
  const directionText = plain(cells[2] + ' ' + cells[3]);
  const unsignedChange = number(plain(cells[2]).replace(/[▲▼]/g, '').trim());
  const unsignedPercent = number(plain(cells[3]).replace(/[▲▼%]/g, '').trim());
  if (value === null || (unsignedChange !== 0 && unsignedChange !== null && !/[▲▼+-]/.test(directionText))) throw drift();
  const direction = directionText.includes('▼') || unsignedChange < 0 || unsignedPercent < 0 ? -1 : 1;
  const change = unsignedChange === null ? null : direction * Math.abs(unsignedChange);
  const changePercent = unsignedPercent === null ? null : direction * Math.abs(unsignedPercent);
  return { symbol: 'PSEI', name: 'PSE Composite Index', assetType: 'index', currency: 'PHP', value, valueType: 'index_level', previousClose: null, change, changePercent, volume: null, ...parseEdgeTimestamp(html, nowMs), freshness: 'snapshot', delayMinutes: null, source: SOURCE, sourceUrl: `${BASE}/index/form.do` };
}
function chartDate(raw) {
  if (typeof raw !== 'string') return null;
  const match = raw.match(/^([A-Za-z]{3})\s+(\d{1,2}),\s+(\d{4})\s+00:00:00$/);
  if (!match) return null;
  return calendarDate(match[3], MONTHS.indexOf(match[1]) + 1, Number(match[2]));
}
export function parseEdgeHistory(raw, from, to) {
  if (!raw || !Array.isArray(raw.chartData) || raw.chartData.length > 15000) throw drift();
  const mapped = new Map();
  for (const row of raw.chartData) {
    const date = chartDate(row?.CHART_DATE);
    if (!date) throw drift();
    const close = positiveOrZero(row.CLOSE);
    if (mapped.has(date) && mapped.get(date) !== close) throw drift();
    mapped.set(date, close);
  }
  return [...mapped].filter(([date]) => date >= from && date <= to).sort(([a], [b]) => a.localeCompare(b)).map(([date, close]) => ({ date, close }));
}

function response(body, status = 200, retryAfter = null) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  if (retryAfter !== null) headers['Retry-After'] = String(retryAfter);
  return new Response(JSON.stringify(body), { status, headers });
}
function paramsAllowed(params, allowed) {
  const keys = [...params.keys()];
  if (keys.some(key => !allowed.includes(key)) || new Set(keys).size !== keys.length) throw invalid();
}
function marketDate(nowMs) { return new Date(nowMs + 8 * 3600 * 1000).toISOString().slice(0, 10); }

function mirrorDate(value, nowMs) {
  if (value === null || value === undefined) return null;
  const match = typeof value === 'string' && value.match(/^([A-Za-z]{3})\s+(\d{1,2}),\s+(\d{4})$/);
  const date = match && calendarDate(match[3], MONTHS.indexOf(match[1]) + 1, Number(match[2]));
  if (!date || date > marketDate(nowMs)) throw drift();
  return date;
}
export function parseMirrorSnapshot(raw, nowMs = Date.now()) {
  if (!raw || raw.source !== BASE || typeof raw.generated_utc !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw.generated_utc) || !Array.isArray(raw.stocks) || !raw.stocks.length || raw.stocks.length > 1500) throw drift();
  const generated = raw.generated_utc.replace(' ', 'T');
  const generatedMs = Date.parse(`${generated}Z`);
  if (!Number.isFinite(generatedMs) || new Date(generatedMs).toISOString().slice(0, 19) !== generated || generatedMs > nowMs + 300000) throw drift();
  const generatedAt = new Date(generatedMs).toISOString();
  const instruments = [], quotes = {}, seen = new Set();
  for (const row of raw.stocks) {
    if (!row || !isSymbol(row.symbol) || seen.has(row.symbol) || typeof row.name !== 'string' || !row.name.trim() || row.name.length > 200) throw drift();
    seen.add(row.symbol);
    const timestamp = parseEdgeTimestamp(`As of ${row.as_of}`, nowMs);
    if (Date.parse(timestamp.asOf) > generatedMs + 300000) throw drift();
    const previousCloseDate = mirrorDate(row.previous_close_date, nowMs);
    const suspended = typeof row.status === 'string' && /suspended/i.test(row.status);
    const value = positiveOrZero(row.last_traded_price), previousClose = positiveOrZero(row.previous_close);
    const direction = typeof row.change === 'string' ? row.change.toLowerCase() : null;
    const signed = value => {
      const parsed = number(value);
      if (parsed === null) return null;
      if (direction === 'down') return -Math.abs(parsed);
      if (direction === 'up') return Math.abs(parsed);
      return parsed === 0 ? 0 : null;
    };
    const instrument = { symbol: row.symbol, name: row.name.trim(), assetType: row.symbol === 'FMETF' ? 'etf' : 'stock', currency: 'PHP' };
    instruments.push(instrument);
    const volume = positiveOrZero(row.volume);
    quotes[row.symbol] = {
      ...instrument, value, valueType: 'last_trade', previousClose,
      change: value === null || suspended ? null : signed(row.change_amount),
      changePercent: value === null || previousClose === 0 || suspended ? null : signed(row.change_pct),
      volume: Number.isInteger(volume) && !suspended ? volume : null,
      ...timestamp, marketDate: suspended ? previousCloseDate : timestamp.marketDate,
      previousCloseDate, tradingStatus: typeof row.status === 'string' ? row.status : null,
      freshness: suspended ? 'suspended' : 'snapshot', delayMinutes: null,
      source: MIRROR_SOURCE, sourceUrl: MIRROR_URL, originalSourceUrl: BASE, mirrorGeneratedAt: generatedAt,
    };
  }
  instruments.sort((a, b) => a.symbol.localeCompare(b.symbol));
  let index = null;
  if (raw.index?.indices !== undefined) {
    if (!Array.isArray(raw.index.indices)) throw drift();
    const rows = raw.index.indices.filter(row => row?.name?.toUpperCase() === 'PSEI');
    if (rows.length !== 1) throw drift();
    const row = rows[0], timestamp = parseEdgeTimestamp(`As of ${raw.index.as_of}`, nowMs);
    if (Date.parse(timestamp.asOf) > generatedMs + 300000) throw drift();
    const value = positiveOrZero(row.value);
    if (value === null) throw drift();
    const direction = row.direction ?? row.change_direction;
    const signed = field => { const parsed = number(field); return parsed === null ? null : direction === 'down' ? -Math.abs(parsed) : direction === 'up' ? Math.abs(parsed) : parsed; };
    index = { symbol: 'PSEI', name: 'PSE Composite Index', assetType: 'index', currency: 'PHP', value, valueType: 'index_level', previousClose: null, change: signed(row.change), changePercent: signed(row.change_pct), volume: null, ...timestamp, freshness: 'snapshot', delayMinutes: null, source: MIRROR_SOURCE, sourceUrl: MIRROR_URL, originalSourceUrl: `${BASE}/index/form.do`, mirrorGeneratedAt: generatedAt, marketStatus: typeof raw.index.market_status === 'string' ? raw.index.market_status : null };
  }
  return { instruments, quotes, index, source: MIRROR_SOURCE, sourceUrl: MIRROR_URL, originalSourceUrl: BASE, generatedAt, asOf: generatedAt, limitedCoverage: true,
    coverage: { type: 'mirror', count: instruments.length, note: 'Only the listed stocks are covered by this free fallback.' } };
}

export function createFreePse({ fetchFn = globalThis.fetch, now = () => Date.now(), timeoutMs = 12000, throttleMs = 250, mirrorFallback = false } = {}) {
  const cached = new Map(), pending = new Map();
  let nextFetchAt = 0, cooldownUntil = 0;
  let mirrorStrategyUntil = 0;
  const generatedAt = () => new Date(now()).toISOString();
  async function memo(key, ttl, load) {
    const previous = cached.get(key);
    if (previous?.expires > now()) return structuredClone(previous.value);
    if (pending.has(key)) return structuredClone(await pending.get(key));
    const task = load();
    pending.set(key, task);
    try { const value = await task; cached.set(key, { value, expires: now() + ttl }); return structuredClone(value); }
    finally { pending.delete(key); }
  }
  async function fetchSource(path, { form = null, json = null, query = null } = {}) {
    if (cooldownUntil > now()) throw new SourceError(429, 'rate_limited', 'The public source is rate limited. Try again later.', Math.min(300, Math.max(1, Math.ceil((cooldownUntil - now()) / 1000))));
    const url = new URL(path, BASE);
    if (query) for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const headers = { Accept: json ? 'application/json' : 'text/html', 'User-Agent': 'PSE-Dashboard/1.0 (personal market-data viewer)' };
    let body;
    if (form) { headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8'; body = new URLSearchParams(form).toString(); }
    if (json) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
    const wait = Math.max(0, nextFetchAt - now());
    nextFetchAt = Math.max(nextFetchAt, now()) + throttleMs;
    if (wait) await new Promise(resolve => setTimeout(resolve, wait));
    const controller = new AbortController();
    let timer;
    try {
      return await Promise.race([
        new Promise((resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new SourceError(504, 'source_timeout', 'The public PSE source timed out.')); }, mirrorFallback ? Math.min(timeoutMs, 4000) : timeoutMs); }),
        (async () => {
          const result = await fetchFn(url.toString(), { method: body ? 'POST' : 'GET', headers, ...(body ? { body } : {}), signal: controller.signal, redirect: 'error' });
          if (result.status === 429) {
            const header = result.headers.get('Retry-After');
            const supplied = header && /^\d+(?:\.\d+)?$/.test(header) ? Number(header) : header ? (Date.parse(header) - now()) / 1000 : 30;
            const seconds = Number.isFinite(supplied) ? Math.min(300, Math.max(1, Math.ceil(supplied))) : 30;
            cooldownUntil = now() + seconds * 1000;
            throw new SourceError(429, 'rate_limited', 'The public source is rate limited. Try again later.', seconds);
          }
          if (!result.ok) throw unavailable();
          if (Number(result.headers.get('Content-Length')) > MAX_BYTES) throw drift();
          const text = await result.text();
          if (new TextEncoder().encode(text).byteLength > MAX_BYTES) throw drift();
          if (json) { try { return JSON.parse(text); } catch { throw drift(); } }
          return text;
        })(),
      ]);
    } catch (error) { if (error instanceof SourceError) throw error; throw unavailable(); }
    finally { clearTimeout(timer); }
  }
  async function mirrorSnapshot() {
    const cacheHit = cached.get('mirror')?.expires > now();
    const data = await memo('mirror', 300000, async () => {
      const controller = new AbortController();
      let timer;
      try {
        return await Promise.race([
          new Promise((resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new SourceError(504, 'source_timeout', 'The stock mirror timed out.')); }, timeoutMs); }),
          (async () => {
            const result = await fetchFn(MIRROR_URL, { method: 'GET', headers: { Accept: 'application/json' }, signal: controller.signal, redirect: 'error' });
            if (!result.ok) throw unavailable();
            if (Number(result.headers.get('Content-Length')) > MAX_BYTES) throw drift();
            const text = await result.text();
            if (new TextEncoder().encode(text).byteLength > MAX_BYTES) throw drift();
            let raw;
            try { raw = JSON.parse(text); } catch { throw drift(); }
            return parseMirrorSnapshot(raw, now());
          })(),
        ]);
      } catch (error) { if (error instanceof SourceError) throw error; throw unavailable(); }
      finally { clearTimeout(timer); }
    });
    return { ...data, cached: Boolean(cacheHit) };
  }
  const usingMirror = () => mirrorFallback && mirrorStrategyUntil > now();
  const canFallback = error => mirrorFallback && error instanceof SourceError && ['source_timeout', 'source_unavailable'].includes(error.code);
  async function startMirror() { mirrorStrategyUntil = now() + 900000; return mirrorSnapshot(); }
  const mirrorCatalog = data => ({ instruments: data.instruments, source: data.source, sourceUrl: data.sourceUrl, originalSourceUrl: data.originalSourceUrl, asOf: data.asOf, limitedCoverage: true, coverage: data.coverage, cached: data.cached });
  async function edgeCatalog() {
    return memo('catalog', 86400000, async () => {
      const instruments = new Map();
      let pages = 1, total;
      for (let page = 1; page <= pages; page++) {
        const html = await fetchSource('/companyDirectory/search.ax', { form: { pageNo: String(page), companyId: '', keyword: '', sortType: 'symbol', dateSortType: 'DESC', cmpySortType: 'ASC', symbolSortType: 'ASC', sector: 'ALL', subsector: 'ALL' } });
        const parsed = parseEdgeDirectory(html);
        if (parsed.page !== page || (total !== undefined && (parsed.total !== total || parsed.pages !== pages))) throw drift();
        pages = parsed.pages; total = parsed.total;
        for (const instrument of parsed.instruments) {
          if (instruments.has(instrument.symbol)) throw drift();
          instruments.set(instrument.symbol, instrument);
        }
      }
      if (instruments.size !== total) throw drift();
      return { instruments: [...instruments.values()].sort((a, b) => a.symbol.localeCompare(b.symbol)), source: SOURCE, asOf: generatedAt() };
    });
  }
  async function catalog() {
    if (usingMirror()) return mirrorCatalog(await mirrorSnapshot());
    try { return await edgeCatalog(); }
    catch (error) { if (canFallback(error)) return mirrorCatalog(await startMirror()); throw error; }
  }
  async function mirrorQuote(symbol) {
    const data = await mirrorSnapshot();
    const quote = data.quotes[symbol];
    if (!quote) throw new SourceError(503, 'coverage_unavailable', 'The reachable free source does not cover this symbol.');
    return { quote: { ...quote, cached: data.cached }, companyId: null, securityId: null, mirror: true };
  }
  async function instrument(symbol) {
    const result = (await catalog()).instruments.find(row => row.symbol === symbol);
    if (!result) throw new SourceError(400, 'unknown_symbol', 'This symbol is absent from the current PSE directory.');
    return result;
  }
  async function quotePage(symbol) {
    await catalog();
    if (usingMirror()) return mirrorQuote(symbol);
    try { return await memo(`quote:${symbol}`, 300000, async () => {
      const record = await instrument(symbol);
      const html = await fetchSource('/companyPage/stockData.do', { query: { cmpy_id: record.companyId, ...(record.securityId ? { security_id: record.securityId } : {}) } });
      return parseEdgeQuote(html, record, now());
    }); } catch (error) { if (canFallback(error)) { await startMirror(); return mirrorQuote(symbol); } throw error; }
  }
  async function handle(request) {
    try {
      if (request.method !== 'GET') return response({ error: { code: 'method_not_allowed', message: 'Only GET requests are supported.' } }, 405);
      const url = new URL(request.url), params = url.searchParams;
      if (url.pathname === '/catalog') {
        paramsAllowed(params, ['q']);
        const query = params.has('q') ? params.get('q').trim() : null;
        if (query !== null && (!query || query.length > 80)) throw invalid();
        const data = await catalog();
        const records = data.instruments.map(({ companyId, securityId, ...row }) => row);
        const filtered = query === null ? records : records.filter(row => `${row.symbol} ${row.name}`.toLowerCase().includes(query.toLowerCase())).slice(0, 30);
        return response({ ...data, instruments: filtered });
      }
      if (url.pathname === '/quotes') {
        paramsAllowed(params, ['symbols']);
        const symbols = (params.get('symbols') ?? '').split(',');
        if (!symbols.length || symbols.length > 20 || symbols.some(symbol => !isSymbol(symbol)) || new Set(symbols).size !== symbols.length) throw invalid();
        // Keep a batch responsive while bounding concurrent outbound requests.
        await catalog();
        const quotes = new Array(symbols.length);
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(3, symbols.length) }, async () => {
          while (next < symbols.length) {
            const index = next++;
            quotes[index] = (await quotePage(symbols[index])).quote;
          }
        }));
        return response({ quotes, generatedAt: generatedAt(), ...(usingMirror() ? { coverage: (await mirrorSnapshot()).coverage } : {}) });
      }
      const history = /^\/history\/([A-Z0-9][A-Z0-9.-]{0,14})$/.exec(url.pathname);
      if (history) {
        paramsAllowed(params, ['range']);
        const range = params.get('range') ?? '1m', symbol = history[1];
        if (!Object.hasOwn(RANGES, range)) throw invalid();
        if (symbol === 'PSEI') throw new SourceError(503, 'history_unavailable', 'This source does not provide verified PSEi history.');
        if (!isSymbol(symbol)) throw invalid();
        const to = marketDate(now());
        const from = new Date(Date.parse(`${to}T00:00:00Z`) - RANGES[range] * 86400000).toISOString().slice(0, 10);
        const points = await memo(`history:${symbol}:${range}:${to}`, 86400000, async () => {
          const page = await quotePage(symbol);
          if (page.mirror) throw new SourceError(503, 'history_unavailable', 'The reachable stock mirror does not provide current verified history.');
          if (!page.securityId) throw new SourceError(503, 'history_unavailable', 'The source did not supply this security’s history identifier.');
          const wireDate = value => `${value.slice(5, 7)}-${value.slice(8, 10)}-${value.slice(0, 4)}`;
          const raw = await fetchSource('/common/DisclosureCht.ax', { json: { cmpy_id: page.companyId, security_id: page.securityId, startDate: wireDate(from), endDate: wireDate(to) } });
          return parseEdgeHistory(raw, from, to);
        });
        return response({ symbol, points, source: SOURCE, freshness: 'eod' });
      }
      paramsAllowed(params, []);
      if (url.pathname === '/index/PSEI') {
        let quote;
        if (usingMirror()) {
          const data = await mirrorSnapshot();
          if (!data.index) throw unavailable();
          quote = { ...data.index, cached: data.cached };
        } else {
          try { quote = await memo('index:PSEI', 300000, async () => parseEdgeIndex(await fetchSource('/index/form.do'), now())); }
          catch (error) {
            if (!canFallback(error)) throw error;
            const data = await startMirror();
            if (!data.index) throw unavailable();
            quote = { ...data.index, cached: data.cached };
          }
        }
        return response({ quote, generatedAt: generatedAt() });
      }
      if (url.pathname === '/etf/FMETF') return response({ quote: (await quotePage('FMETF')).quote, nav: null });
      if (url.pathname === '/funds') return response({ funds: [], generatedAt: generatedAt() });
      return response({ error: { code: 'not_found', message: 'Endpoint not found.' } }, 404);
    } catch (error) {
      const safe = error instanceof SourceError ? error : unavailable();
      return response({ error: { code: safe.code, message: safe.message } }, safe.status, safe.retryAfter);
    }
  }
  return { handle, fetch: handle };
}
