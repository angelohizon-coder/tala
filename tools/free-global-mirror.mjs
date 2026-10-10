/** Dated daily bars from the published Crible dataset, never an intraday feed. */
import { parquetReadObjects } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';

export const GLOBAL_MIRROR_BASE = 'https://maxgfr.github.io/crible/data/';
export const GLOBAL_MIRROR_SOURCE_URL = 'https://maxgfr.github.io/crible/';
const MAX_FILE_BYTES = 128 * 1024 * 1024;
const MAX_RANGE_BYTES = 8 * 1024 * 1024;
const MAX_RANGE_CACHE_BYTES = 16 * 1024 * 1024;
const MARKET = {
  US: { suffix: '', currency: 'USD', timeZone: 'America/New_York', exchanges: ['NMS', 'NGM', 'NCM', 'NYQ', 'PCX', 'ASE', 'BTS', 'PNK', 'OQB', 'OQX'] },
  HK: { suffix: '.HK', currency: 'HKD', timeZone: 'Asia/Hong_Kong', exchanges: ['HKG'] },
  JP: { suffix: '.T', currency: 'JPY', timeZone: 'Asia/Tokyo', exchanges: ['JPX', 'TYO'] },
  GB: { suffix: '.L', currency: 'GBP', timeZone: 'Europe/London', exchanges: ['LSE'] },
  CA: { suffix: '.TO', currency: 'CAD', timeZone: 'America/Toronto', exchanges: ['TOR'] },
  AU: { suffix: '.AX', currency: 'AUD', timeZone: 'Australia/Sydney', exchanges: ['ASX'] },
};
const RANGE_DAYS = { '1w': 7, '1m': 31, '3m': 93, '1y': 366 };
const mono = () => performance.now();
const text = (value, maximum = 200) => typeof value === 'string' && value.trim() && value.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(value);
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const nonnegative = value => { const parsed = number(value); return parsed !== null && parsed >= 0 ? parsed : null; };

export class GlobalMirrorError extends Error {
  constructor(status, code, message, retryAfter = null) { super(message); Object.assign(this, { status, code, retryAfter }); }
}
const changed = () => new GlobalMirrorError(502, 'source_changed', 'The daily mirror returned invalid or unsupported data.');
const unavailable = () => new GlobalMirrorError(503, 'source_unavailable', 'The international daily mirror is temporarily unavailable.');
const timeout = () => new GlobalMirrorError(504, 'source_timeout', 'The international daily mirror timed out.');
const uncovered = () => new GlobalMirrorError(503, 'coverage_unavailable', 'This symbol has no verified daily prices in the reachable mirror.');
const unitUnknown = () => new GlobalMirrorError(503, 'unit_unavailable', 'The daily source does not establish this instrument’s price unit.');

function dateOnly(value) {
  let date;
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime()) || !value.toISOString().endsWith('T00:00:00.000Z')) throw changed();
    date = value.toISOString().slice(0, 10);
  } else if (typeof value === 'string') {
    if (!/^\d{4}-\d{2}-\d{2}(?:T00:00:00\.000Z)?$/u.test(value)) throw changed();
    date = value.slice(0, 10);
  } else throw changed();
  const parsed = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) throw changed();
  return date;
}

function localDate(epochMs, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(epochMs));
  const get = type => parts.find(part => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function identity(symbol) {
  const match = /^(US|HK|JP|GB|CA|AU):([A-Z0-9][A-Z0-9.-]{0,14})$/u.exec(symbol ?? '');
  if (!match || /\.\.|--|[.-]$/u.test(match[2])) throw new GlobalMirrorError(400, 'invalid_request', 'Use a supported qualified international symbol.');
  const market = match[1], native = match[2], specification = MARKET[market];
  if ((market === 'US' && native.includes('.')) || (market === 'HK' && !/^\d{4,5}$/u.test(native)) || /\.(?:HK|T|L|TO|AX|PSE|PS)$/u.test(native)) throw new GlobalMirrorError(400, 'invalid_request', 'Use a supported qualified international symbol.');
  return { symbol, market, native, ticker: native + specification.suffix };
}

export function parseCribleManifest(raw, nowMs = Date.now()) {
  if (!raw || raw.schema !== 2 || number(raw.generated_at) === null || raw.generated_at <= 0 || raw.generated_at * 1000 > nowMs + 300000
    || !Number.isSafeInteger(raw.universe_rows) || raw.universe_rows < 1 || raw.universe_rows > 200000
    || !Number.isSafeInteger(raw.prices?.symbols) || raw.prices.symbols < 1 || raw.prices.symbols > raw.universe_rows
    || !Array.isArray(raw.prices.shards) || raw.prices.shards.length < 1 || raw.prices.shards.length > 30) throw changed();
  const maxDate = dateOnly(raw.prices.max_date);
  if (Date.parse(`${maxDate}T00:00:00Z`) > nowMs + 86400000) throw changed();
  const files = new Set();
  let previousMax = null;
  const shards = raw.prices.shards.map(shard => {
    if (!/^prices-\d{2}\.parquet$/u.test(shard?.file ?? '') || files.has(shard.file)
      || !Number.isSafeInteger(shard.bytes) || shard.bytes < 12 || shard.bytes > MAX_FILE_BYTES
      || !text(shard.min_symbol, 40) || !text(shard.max_symbol, 40) || shard.min_symbol > shard.max_symbol
      || (previousMax !== null && shard.min_symbol <= previousMax)) throw changed();
    files.add(shard.file); previousMax = shard.max_symbol;
    return { file: shard.file, bytes: shard.bytes, min_symbol: shard.min_symbol, max_symbol: shard.max_symbol };
  });
  return { generatedAt: new Date(raw.generated_at * 1000).toISOString(), generatedMs: raw.generated_at * 1000, universeRows: raw.universe_rows, pricedSymbols: raw.prices.symbols, maxDate, shards };
}

/** Listing exchange and unit determine a market; company domicile never does. */
export function parseCribleUniverse(rows) {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 200000) throw changed();
  const instruments = new Map();
  for (const row of rows) {
    if (!row || !text(row.symbol, 40) || !text(row.name) || row.delisted === true || !text(row.exchange, 30) || !text(row.currency, 10)) continue;
    for (const [market, specification] of Object.entries(MARKET)) {
      if (!specification.exchanges.includes(row.exchange) || (row.currency !== specification.currency && !(market === 'GB' && row.currency === 'GBp'))) continue;
      if (specification.suffix && !row.symbol.endsWith(specification.suffix)) continue;
      const native = specification.suffix ? row.symbol.slice(0, -specification.suffix.length) : row.symbol;
      let parsed;
      try { parsed = identity(`${market}:${native}`); } catch { continue; }
      if (parsed.ticker !== row.symbol) continue;
      const instrument = { symbol: parsed.symbol, ticker: parsed.ticker, market, name: row.name.trim(), assetType: 'stock', currency: specification.currency, sourceCurrency: row.currency, exchange: row.exchange, timeZone: specification.timeZone, verified: true };
      if (instruments.has(parsed.symbol)) {
        const prior = instruments.get(parsed.symbol);
        if (prior.name !== instrument.name || prior.exchange !== instrument.exchange || prior.sourceCurrency !== instrument.sourceCurrency) throw changed();
      } else instruments.set(parsed.symbol, instrument);
      break;
    }
  }
  return instruments;
}

export function parseCribleBars(rows, instrument, manifest, nowMs = Date.now()) {
  if (!Array.isArray(rows) || rows.length > 1500) throw changed();
  const collectedDate = localDate(manifest.generatedMs, instrument.timeZone), today = localDate(nowMs, instrument.timeZone);
  const cutoff = collectedDate < today ? collectedDate : today;
  const dates = new Map();
  for (const row of rows) {
    if (!row || row.symbol !== instrument.ticker || !['yfinance', 'stooq'].includes(row.source)) throw changed();
    const date = dateOnly(row.date);
    if (date > today || date > manifest.maxDate) throw changed();
    // The collector keeps partial current-day rows. They cannot become final later.
    if (date >= cutoff) continue;
    const close = nonnegative(row.close);
    let volume = row.volume;
    if (typeof volume === 'bigint') volume = volume <= BigInt(Number.MAX_SAFE_INTEGER) && volume >= 0n ? Number(volume) : null;
    volume = nonnegative(volume);
    const bar = { date, close, volume: Number.isSafeInteger(volume) ? volume : null, source: row.source };
    if (dates.has(date)) {
      const prior = dates.get(date);
      if (prior.close !== bar.close || prior.volume !== bar.volume || prior.source !== bar.source) throw changed();
    } else dates.set(date, bar);
  }
  // GBP catalog metadata cannot establish whether raw London closes mean pounds or pence.
  if (instrument.market === 'GB' && instrument.sourceCurrency !== 'GBp') throw unitUnknown();
  const scale = instrument.sourceCurrency === 'GBp' ? 100 : 1;
  return [...dates.values()].sort((a, b) => a.date.localeCompare(b.date)).map(bar => ({ ...bar, close: bar.close === null ? null : bar.close / scale }));
}

function coverage(manifest) {
  return { type: 'daily_mirror', pricedSymbols: manifest.pricedSymbols, note: 'Daily historical mirror, not live quotes. Catalog membership does not guarantee current price coverage; source dates and availability vary by instrument.' };
}

function parquetMagic(bytes, offset = 0) {
  const values = new Uint8Array(bytes);
  return values[offset] === 80 && values[offset + 1] === 65 && values[offset + 2] === 82 && values[offset + 3] === 49;
}

async function boundedBinary(result, maximum = MAX_RANGE_BYTES) {
  if (!result.body) throw changed();
  const reader = result.body.getReader(), chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > maximum) { await reader.cancel(); throw changed(); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes.buffer;
}

/** Injectable reader keeps unit tests independent of network and Parquet binaries. */
export function createFreeGlobalMirror({ fetchFn = globalThis.fetch, now = () => Date.now(), timeoutMs = 7000, readParquetFn = parquetReadObjects, browserCors = false } = {}) {
  const cache = new Map(), pending = new Map(), files = new Map();
  let fileVersion = null;
  async function memo(key, ttl, load) {
    const prior = cache.get(key);
    if (prior?.expires > now()) return { data: prior.data, cached: true };
    if (prior) cache.delete(key);
    if (pending.has(key)) return { data: await pending.get(key), cached: false };
    const operation = (async () => { const data = await load(); if (cache.size >= 256) cache.delete(cache.keys().next().value); cache.set(key, { data, expires: now() + ttl }); return data; })();
    pending.set(key, operation);
    try { return { data: await operation, cached: false }; } finally { pending.delete(key); }
  }

  async function fetched(file, options, deadline, read) {
    if (file !== 'manifest.json' && file !== 'universe.parquet' && !/^prices-\d{2}\.parquet$/u.test(file)) throw changed();
    const remaining = Math.min(timeoutMs, deadline - mono());
    if (remaining <= 1) throw timeout();
    const controller = new AbortController();
    let timer;
    try {
      return await Promise.race([
        new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(timeout()); }, remaining); }),
        (async () => {
          const result = await fetchFn(GLOBAL_MIRROR_BASE + file, { ...options, headers: { Accept: file === 'manifest.json' ? 'application/json' : 'application/octet-stream', 'Accept-Encoding': 'identity', ...options.headers }, signal: controller.signal, redirect: 'error' });
          if (!result.ok) throw unavailable();
          return read(result);
        })(),
      ]);
    } catch (error) { if (error instanceof GlobalMirrorError) throw error; throw unavailable(); }
    finally { clearTimeout(timer); }
  }

  async function manifest(deadline) {
    return (await memo('manifest', 3600000, () => fetched('manifest.json', { method: 'GET' }, deadline, async result => {
      if (Number(result.headers.get('Content-Length')) > 1024 * 1024) throw changed();
      const raw = await result.text();
      if (new TextEncoder().encode(raw).byteLength > 1024 * 1024) throw changed();
      let parsed;
      try { parsed = JSON.parse(raw); } catch { throw changed(); }
      return parseCribleManifest(parsed, now());
    }))).data;
  }

  async function buffer(fileName, byteLength, published, deadline) {
    if (fileVersion !== published.generatedAt) { files.clear(); fileVersion = published.generatedAt; }
    const view = file => ({ byteLength: file.byteLength, slice: (start, end) => file.read(start, end, deadline) });
    if (files.has(fileName)) { const file = files.get(fileName); await file.ready; return view(file); }
    let whole = null;
    if (byteLength === undefined) {
      const information = await fetched(fileName, { method: 'HEAD' }, deadline, result => {
        // CORS hides Content-Encoding; HEAD may describe gzip rather than decoded bytes.
        if (browserCors && result.type === 'cors') return { browser: true };
        const value = result.headers.get('Content-Length');
        if (!value || !/^\d+$/u.test(value)) throw changed();
        return { bytes: Number(value) };
      });
      if (information.browser) {
        whole = await fetched(fileName, { method: 'GET' }, deadline, async result => {
          if (result.status !== 200 || result.type !== 'cors') throw changed();
          const bytes = await boundedBinary(result);
          if (bytes.byteLength < 12 || !parquetMagic(bytes) || !parquetMagic(bytes, bytes.byteLength - 4)) throw changed();
          return bytes;
        });
        byteLength = whole.byteLength;
      } else byteLength = information.bytes;
    }
    if (!Number.isSafeInteger(byteLength) || byteLength < 12 || byteLength > MAX_FILE_BYTES) throw changed();
    const slices = new Map(), slicePending = new Map();
    let cachedBytes = 0;
    const file = { byteLength, async read(start, end = byteLength, rangeDeadline) {
      if (start < 0) { if (end !== byteLength) throw changed(); start = Math.max(0, byteLength + start); }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > byteLength || end - start > MAX_RANGE_BYTES) throw changed();
      if (whole) return whole.slice(start, end);
      if (end === start) return new ArrayBuffer(0);
      const key = `${start}:${end}`;
      if (slices.has(key)) return slices.get(key);
      if (slicePending.has(key)) return slicePending.get(key);
      const operation = fetched(fileName, { method: 'GET', headers: { Range: `bytes=${start}-${end - 1}` } }, rangeDeadline, async result => {
        const encoding = result.headers.get('Content-Encoding');
        if (encoding && encoding !== 'identity') throw changed();
        if (result.status === 200) {
          if (byteLength > MAX_RANGE_BYTES || Number(result.headers.get('Content-Length')) !== byteLength) { result.body?.cancel().catch(() => {}); throw changed(); }
          const all = await result.arrayBuffer();
          if (all.byteLength !== byteLength) throw changed();
          whole = all; return all.slice(start, end);
        }
        const contentRange = result.headers.get('Content-Range');
        const match = /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(contentRange ?? '');
        const hiddenCorsRange = browserCors && result.type === 'cors' && contentRange === null;
        if (result.status !== 206 || (!hiddenCorsRange && (!match || Number(match[1]) !== start || Number(match[2]) !== end - 1 || Number(match[3]) !== byteLength))) throw changed();
        const length = result.headers.get('Content-Length');
        if (length !== null && (!/^\d+$/u.test(length) || Number(length) !== end - start)) throw changed();
        const bytes = await result.arrayBuffer();
        if (bytes.byteLength !== end - start) throw changed();
        return bytes;
      });
      slicePending.set(key, operation);
      try {
        const bytes = await operation;
        while (cachedBytes + bytes.byteLength > MAX_RANGE_CACHE_BYTES && slices.size) { const oldest = slices.keys().next().value; cachedBytes -= slices.get(oldest).byteLength; slices.delete(oldest); }
        slices.set(key, bytes); cachedBytes += bytes.byteLength;
        return bytes;
      } finally { slicePending.delete(key); }
    } };
    file.ready = browserCors ? Promise.all([file.read(0, 4, deadline), file.read(byteLength - 8, byteLength, deadline)]).then(([head, tail]) => {
      if (!parquetMagic(head) || !parquetMagic(tail, 4)) throw changed();
    }) : Promise.resolve();
    files.set(fileName, file);
    try { await file.ready; return view(file); }
    catch (error) { if (files.get(fileName) === file) files.delete(fileName); throw error; }
  }

  async function universe(published, deadline) {
    return (await memo(`universe:${published.generatedAt}`, 86400000, async () => {
      const file = await buffer('universe.parquet', undefined, published, deadline);
      let rows;
      try { rows = await readParquetFn({ file, compressors, columns: ['symbol', 'name', 'exchange', 'currency', 'delisted'] }); }
      catch (error) { if (error instanceof GlobalMirrorError) throw error; throw changed(); }
      return parseCribleUniverse(rows);
    })).data;
  }

  async function series(symbol, deadline) {
    const parsed = identity(symbol), published = await manifest(deadline), instruments = await universe(published, deadline);
    const instrument = instruments.get(parsed.symbol);
    if (!instrument) throw uncovered();
    const shard = published.shards.find(candidate => parsed.ticker >= candidate.min_symbol && parsed.ticker <= candidate.max_symbol);
    if (!shard) throw uncovered();
    const result = await memo(`bars:${published.generatedAt}:${symbol}`, 3600000, async () => {
      const file = await buffer(shard.file, shard.bytes, published, deadline);
      let rows;
      try { rows = await readParquetFn({ file, compressors, columns: ['symbol', 'date', 'close', 'volume', 'source'], filter: { symbol: { $eq: parsed.ticker } } }); }
      catch (error) { if (error instanceof GlobalMirrorError) throw error; throw changed(); }
      const bars = parseCribleBars(rows, instrument, published, now());
      if (!bars.length) throw uncovered();
      return bars;
    });
    return { instrument, bars: result.data, published, cached: result.cached };
  }

  async function catalog(market = 'US', query = '', requestDeadline = mono() + timeoutMs) {
    if (!Object.hasOwn(MARKET, market)) throw new GlobalMirrorError(400, 'invalid_request', 'Use a supported international market.');
    const published = await manifest(requestDeadline), instruments = await universe(published, requestDeadline);
    const matching = [...instruments.values()].filter(row => row.market === market && (!query || `${row.symbol} ${row.ticker} ${row.name}`.toLowerCase().includes(query.toLowerCase())));
    return { instruments: query ? matching.slice(0, 30) : matching, market, source: 'Crible daily mirror', sourceProvider: 'Crible daily mirror', sourceUrl: GLOBAL_MIRROR_SOURCE_URL, asOf: published.generatedAt, mirrorGeneratedAt: published.generatedAt, coverage: coverage(published) };
  }

  async function quote(symbol, requestDeadline = mono() + timeoutMs) {
    const { instrument, bars, published, cached } = await series(symbol, requestDeadline);
    const last = bars.findLast(bar => bar.close !== null);
    if (!last) throw uncovered();
    const ageDays = (Date.parse(`${localDate(now(), instrument.timeZone)}T00:00:00Z`) - Date.parse(`${last.date}T00:00:00Z`)) / 86400000;
    if (ageDays > 7) throw new GlobalMirrorError(503, 'stale_source', `The latest verified daily close is dated ${last.date}; current prices are unavailable.`);
    const at = bars.indexOf(last), previousClose = bars[at - 1]?.close ?? null;
    const change = previousClose === null ? null : last.close - previousClose;
    return {
      ...instrument, value: last.close, valueType: 'daily_close', previousClose, change,
      changePercent: change === null || previousClose === 0 ? null : change / previousClose * 100,
      volume: last.volume, asOf: last.date, marketDate: last.date, timestampPrecision: 'date', freshness: 'eod', delayMinutes: null,
      source: `Crible daily mirror · ${last.source}`, sourceUrl: GLOBAL_MIRROR_SOURCE_URL, originalSource: last.source,
      ...(last.source === 'yfinance' ? { originalSourceUrl: `https://finance.yahoo.com/quote/${encodeURIComponent(instrument.ticker)}/` } : {}),
      mirrorGeneratedAt: published.generatedAt, cached, coverage: coverage(published),
      ...(instrument.sourceCurrency === 'GBp' ? { sourceUnit: 'pence' } : {}),
    };
  }

  async function history(symbol, range = '1m', requestDeadline = mono() + timeoutMs) {
    if (!Object.hasOwn(RANGE_DAYS, range)) throw new GlobalMirrorError(400, 'invalid_request', 'Use a supported history range.');
    const { instrument, bars, published, cached } = await series(symbol, requestDeadline);
    const today = localDate(now(), instrument.timeZone), since = new Date(Date.parse(`${today}T00:00:00Z`) - RANGE_DAYS[range] * 86400000).toISOString().slice(0, 10);
    const points = bars.filter(bar => bar.date >= since).map(({ date, close }) => ({ date, close }));
    const sources = [...new Set(bars.map(bar => bar.source))].sort();
    const last = bars.findLast(bar => bar.close !== null), stale = !last || (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${last.date}T00:00:00Z`)) > 7 * 86400000;
    return {
      symbol, points, market: instrument.market, ticker: instrument.ticker, exchange: instrument.exchange, currency: instrument.currency, timeZone: instrument.timeZone,
      source: `Crible daily mirror · ${sources.join(', ')}`, sourceUrl: GLOBAL_MIRROR_SOURCE_URL, freshness: 'eod',
      asOf: last?.date ?? null, marketDate: last?.date ?? null, timestampPrecision: 'date', mirrorGeneratedAt: published.generatedAt, cached, coverage: coverage(published),
      ...(stale ? { issues: [{ symbol, code: 'stale_source', message: 'This historical dataset has no recent verified closing price.' }] } : {}),
      ...(instrument.sourceCurrency === 'GBp' ? { sourceCurrency: 'GBp', sourceUnit: 'pence' } : {}),
    };
  }
  return { catalog, quote, history };
}
