/** Private loopback adapter. Credentials stay outside the publicly served site. */
import { readFile, open, rename, unlink, stat, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createWorker } from '../worker/index.mjs';
import { createFreeMarket, FREE_MARKETS } from './free-market.mjs';

export const DEFAULT_CONFIG_PATH = fileURLToPath(new URL('../.local-market.json', import.meta.url));
const MAX_CONFIG_BYTES = 4096;
const MAX_TOKEN_LENGTH = 200;

class LocalError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const failure = (status, code, message) => new LocalError(status, code, message);
function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  } });
}

function validToken(token) {
  // A token is an opaque credential, never a URL/query fragment or multiline text.
  return typeof token === 'string' && token.length >= 8 && token.length <= MAX_TOKEN_LENGTH
    && /^[\x21-\x7e]+$/u.test(token) && !/[&=?#%\\/"'`<>]/u.test(token);
}

function configuration(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || Object.keys(raw).length !== 2 || !Object.hasOwn(raw, 'token') || !Object.hasOwn(raw, 'personalUse')
    || raw.personalUse !== true || !validToken(raw.token)) {
    throw failure(400, 'invalid_configuration', 'Provide a valid EODHD token and explicitly confirm personal use.');
  }
  return { token: raw.token, personalUse: true };
}

export function createMemoryCache({ now = () => Date.now(), maximumEntries = 256 } = {}) {
  const entries = new Map();
  return {
    async match(request) {
      const key = typeof request === 'string' ? request : request.url;
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= now()) { entries.delete(key); return undefined; }
      return entry.response.clone();
    },
    async put(request, response) {
      const age = response.headers.get('Cache-Control')?.match(/(?:^|[,\s])max-age=(\d+)(?:$|[,\s])/iu);
      if (!response.ok || !age || Number(age[1]) <= 0) return;
      const key = typeof request === 'string' ? request : request.url;
      entries.delete(key);
      if (entries.size >= maximumEntries) entries.delete(entries.keys().next().value);
      entries.set(key, { response: response.clone(), expiresAt: now() + Number(age[1]) * 1000 });
    },
    clear() { entries.clear(); },
  };
}

async function readConfiguration(request, timeoutMs) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(request.headers.get('Content-Type') ?? '')) {
    throw failure(415, 'json_required', 'Configuration must be sent as application/json.');
  }
  const length = request.headers.get('Content-Length');
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > MAX_CONFIG_BYTES)) {
    throw failure(413, 'configuration_too_large', 'Configuration exceeds the allowed size.');
  }
  if (!request.body) throw failure(400, 'invalid_configuration', 'Configuration JSON is required.');
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0, timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(failure(408, 'request_timeout', 'Configuration request timed out.')), timeoutMs); });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), timeout]);
      if (done) break;
      total += value.byteLength;
      if (total > MAX_CONFIG_BYTES) throw failure(413, 'configuration_too_large', 'Configuration exceeds the allowed size.');
      chunks.push(value);
    }
    const text = Buffer.concat(chunks, total).toString('utf8');
    let raw;
    try { raw = JSON.parse(text); } catch { throw failure(400, 'invalid_configuration', 'Configuration must be valid JSON.'); }
    return configuration(raw);
  } catch (error) {
    reader.cancel().catch(() => {});
    throw error;
  } finally { clearTimeout(timer); reader.releaseLock(); }
}

async function storeConfiguration(path, payload) {
  const destination = resolve(path);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  await mkdir(dirname(destination), { recursive: true });
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(`${JSON.stringify(payload)}\n`, 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, destination);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function loadConfiguration(path, env) {
  if (env.PRIVATE_LOCAL_USE_CONFIRMED === 'true' && validToken(env.EODHD_TOKEN)) {
    return { token: env.EODHD_TOKEN, personalUse: true };
  }
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_CONFIG_BYTES) return null;
    return configuration(JSON.parse(await readFile(path, 'utf8')));
  } catch { return null; }
}

/** Injectable Request/Response handler; importing this module does not bind a port. */
export async function createLocalGateway({
  port, configPath = DEFAULT_CONFIG_PATH, env = {}, workerFactory = createWorker, freeFactory = createFreeMarket,
  fetchFn = globalThis.fetch, now = () => Date.now(), timeoutMs = 5000,
} = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('A valid loopback port is required.');
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const origins = [...hosts].map(host => `http://${host}`).join(',');
  let current = await loadConfiguration(configPath, env);
  const makeWorker = () => workerFactory({ privateLocalUse: true, fetchFn, now, cache: createMemoryCache({ now }) });
  let worker = makeWorker();
  const publicStocks = freeFactory({ fetchFn, now, mirrorFallback: true });
  let configureQueue = Promise.resolve();
  const status = () => ({ configured: Boolean(current), provider: 'EODHD', personalUse: current?.personalUse === true,
    freeAvailable: true, freeApiBase: '/api/public', freeSource: 'PSE EDGE / Yahoo Finance', markets: FREE_MARKETS, globalSearch: true });
  return {
    async handle(request) {
      try {
        const url = new URL(request.url);
        if (url.protocol !== 'http:' || url.username || url.password || !hosts.has(url.host)
          || (request.headers.has('Host') && request.headers.get('Host') !== url.host)) {
          throw failure(403, 'loopback_required', 'This service is available only at its local loopback address.');
        }
        if (!url.pathname.startsWith('/api/')) throw failure(404, 'not_found', 'Local API route not found.');
        const origin = request.headers.get('Origin');
        if (origin !== null && origin !== url.origin) throw failure(403, 'origin_not_allowed', 'This request must come from the same local dashboard.');
        if (url.pathname === '/api/status') {
          if (request.method !== 'GET' || url.search) throw failure(400, 'invalid_request', 'Status supports GET without parameters.');
          return json(status());
        }
        if (url.pathname === '/api/config') {
          if (request.method !== 'POST' || url.search) throw failure(405, 'method_not_allowed', 'Configuration supports POST without parameters.');
          if (origin !== url.origin) throw failure(403, 'origin_required', 'Configuration requires the same local dashboard Origin.');
          const next = await readConfiguration(request, timeoutMs);
          const operation = configureQueue.catch(() => {}).then(async () => {
            try { await storeConfiguration(configPath, next); }
            catch { throw failure(500, 'configuration_not_saved', 'The local configuration could not be saved.'); }
            const nextWorker = makeWorker();
            current = next; worker = nextWorker;
          });
          configureQueue = operation;
          await operation;
          return json(status());
        }
        if (url.pathname.startsWith('/api/public/')) {
          const publicUrl = new URL(url);
          publicUrl.pathname = url.pathname.slice('/api/public'.length);
          return await publicStocks.handle(new Request(publicUrl, { method: request.method }));
        }
        if (!current) throw failure(503, 'service_configuration', 'Connect an EODHD token for private local use first.');
        const workerUrl = new URL(url);
        workerUrl.pathname = url.pathname.slice('/api'.length);
        const headers = new Headers();
        for (const name of ['Origin', 'Accept', 'Content-Type', 'Access-Control-Request-Method', 'Access-Control-Request-Headers']) {
          const value = request.headers.get(name);
          if (value !== null) headers.set(name, value);
        }
        const forwarded = new Request(workerUrl, { method: request.method, headers });
        const active = current, activeWorker = worker;
        return await activeWorker.fetch(forwarded, {
          EODHD_TOKEN: active.token, PRIVATE_LOCAL_USE_CONFIRMED: active.personalUse === true ? 'true' : 'false',
          PUBLIC_DISPLAY_LICENSED: 'false', ALLOWED_ORIGINS: origins,
        });
      } catch (error) {
        const safe = error instanceof LocalError ? error : failure(503, 'service_unavailable', 'The local market-data service is temporarily unavailable.');
        return json({ error: { code: safe.code, message: safe.message } }, safe.status);
      }
    },
  };
}
