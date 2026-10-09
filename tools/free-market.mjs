/** Route keyless Philippine and international market data without mixing identities. */
import { createFreePse } from './free-pse.mjs';
import { createFreeGlobal } from './free-global.mjs';

export const FREE_MARKETS = Object.freeze(['PH', 'US', 'HK', 'JP', 'GB', 'CA', 'AU']);
const FOREIGN_MARKETS = new Set(FREE_MARKETS.slice(1));
const BARE_SYMBOL = /^[A-Z0-9][A-Z0-9.-]{0,14}$/;
const QUALIFIED_SYMBOL = /^(US|HK|JP|GB|CA|AU):[A-Z0-9][A-Z0-9.-]{0,14}$/;
const FAILURE = {
  invalid_request: [400, 'Use supported market identifiers and request parameters.'],
  unknown_symbol: [400, 'The source does not recognize this stock symbol.'],
  method_not_allowed: [405, 'Only GET requests are supported.'],
  rate_limited: [429, 'The public market source is rate-limited. Try again later.'],
  source_changed: [502, 'The public source returned an unexpected data format.'],
  source_unavailable: [503, 'The public market source is temporarily unavailable.'],
  coverage_unavailable: [503, 'The reachable free source does not cover this symbol.'],
  stale_source: [503, 'The reachable source only has older records for this stock.'],
  unit_unavailable: [503, 'The daily source does not confirm this stock’s price unit.'],
  history_unavailable: [503, 'Verified historical data is unavailable for this symbol.'],
  source_timeout: [504, 'The public market source timed out.'],
};

function json(body, status = 200, retryAfter = null) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  if (retryAfter !== null) headers['Retry-After'] = String(retryAfter);
  return new Response(JSON.stringify(body), { status, headers });
}
function error(code, issues = undefined, retryAfter = null) {
  const safeCode = Object.hasOwn(FAILURE, code) ? code : 'source_unavailable';
  const [status, message] = FAILURE[safeCode];
  return json({ error: { code: safeCode, message }, ...(issues ? { issues } : {}) }, status, retryAfter);
}
function allowed(params, names) {
  const keys = [...params.keys()];
  return keys.every(key => names.includes(key)) && new Set(keys).size === keys.length;
}
function isBareSymbol(symbol) {
  return BARE_SYMBOL.test(symbol) && !symbol.endsWith('.PSE') && symbol !== 'PSEI';
}
function forwarded(request, update) {
  const url = new URL(request.url);
  update(url);
  return new Request(url, { method: request.method, headers: request.headers, signal: request.signal });
}
function issueFor(symbol, code, retryAfter = null) {
  const market = symbol.includes(':') ? symbol.split(':', 1)[0] : 'PH';
  const safeCode = Object.hasOwn(FAILURE, code) ? code : 'source_unavailable';
  return {
    symbol, qualifiedSymbol: market === 'PH' ? `PH:${symbol}` : symbol, market,
    code: safeCode, message: FAILURE[safeCode][1],
    ...(retryAfter !== null ? { retryAfter } : {}),
  };
}
function retrySeconds(value) {
  if (value === null || value === undefined || !/^\d+$/.test(String(value))) return null;
  return Math.max(1, Math.min(300, Number(value)));
}
function phCoverage(coverage) {
  return coverage && typeof coverage === 'object' && !Array.isArray(coverage) ? { ...coverage, market: 'PH' } : undefined;
}

/** Factories and fetch are injectable; importing the router never starts a server. */
export function createFreeMarket({ pseFactory = createFreePse, globalFactory = createFreeGlobal, now = () => Date.now(), ...options } = {}) {
  const pse = pseFactory({ ...options, now });
  const global = globalFactory({ ...options, now });

  async function quoteGroup(adapter, request, symbols, market) {
    let response, body;
    try {
      response = await adapter.handle(forwarded(request, url => url.searchParams.set('symbols', symbols.join(','))));
    } catch { return { quotes: [], issues: symbols.map(symbol => issueFor(symbol, 'source_unavailable')) }; }
    try { body = await response.json(); }
    catch { return { quotes: [], issues: symbols.map(symbol => issueFor(symbol, 'source_changed')) }; }
    const headerRetry = retrySeconds(response.headers.get('Retry-After'));
    if (!response.ok) {
      const code = body?.error?.code ?? 'source_unavailable';
      return { quotes: [], issues: symbols.map(symbol => issueFor(symbol, code, code === 'rate_limited' ? headerRetry : null)) };
    }
    if (!Array.isArray(body?.quotes) || (body.issues !== undefined && !Array.isArray(body.issues))) {
      return { quotes: [], issues: symbols.map(symbol => issueFor(symbol, 'source_changed')) };
    }
    const wanted = new Set(symbols), quotes = new Map(), issues = new Map();
    for (const quote of body.quotes) {
      if (!quote || typeof quote !== 'object' || !wanted.has(quote.symbol) || quotes.has(quote.symbol)) {
        return { quotes: [], issues: symbols.map(symbol => issueFor(symbol, 'source_changed')) };
      }
      quotes.set(quote.symbol, quote);
    }
    for (const issue of body.issues ?? []) {
      if (!issue || !wanted.has(issue.symbol) || issues.has(issue.symbol) || quotes.has(issue.symbol)) {
        return { quotes: [], issues: symbols.map(symbol => issueFor(symbol, 'source_changed')) };
      }
      issues.set(issue.symbol, issueFor(issue.symbol, issue.code, issue.code === 'rate_limited' ? retrySeconds(issue.retryAfter) ?? headerRetry : null));
    }
    for (const symbol of symbols) if (!quotes.has(symbol) && !issues.has(symbol)) issues.set(symbol, issueFor(symbol, 'source_changed'));
    return {
      quotes: [...quotes.values()], issues: [...issues.values()],
      ...(market === 'PH' && phCoverage(body.coverage) ? { coverage: phCoverage(body.coverage) } : {}),
    };
  }

  async function handle(request) {
    if (request.method !== 'GET') return error('method_not_allowed');
    const url = new URL(request.url), params = url.searchParams;
    if (url.pathname === '/catalog') {
      if (!allowed(params, ['q', 'market'])) return error('invalid_request');
      const market = params.get('market') ?? 'PH';
      if (market !== 'PH' && !FOREIGN_MARKETS.has(market)) return error('invalid_request');
      if (market !== 'PH') return global.handle(request);
      const response = await pse.handle(forwarded(request, next => next.searchParams.delete('market')));
      if (!response.ok) return response;
      try {
        const body = await response.json();
        return json({ ...body, market: 'PH', ...(phCoverage(body.coverage) ? { coverage: phCoverage(body.coverage) } : {}) });
      } catch { return error('source_changed'); }
    }
    if (url.pathname === '/quotes') {
      if (!allowed(params, ['symbols'])) return error('invalid_request');
      const symbols = (params.get('symbols') ?? '').split(',');
      if (!symbols.length || symbols.length > 20 || new Set(symbols).size !== symbols.length
        || symbols.some(symbol => !isBareSymbol(symbol) && !QUALIFIED_SYMBOL.test(symbol))) return error('invalid_request');
      const phSymbols = symbols.filter(isBareSymbol), foreignSymbols = symbols.filter(symbol => QUALIFIED_SYMBOL.test(symbol));
      const groups = await Promise.all([
        ...(phSymbols.length ? [quoteGroup(pse, request, phSymbols, 'PH')] : []),
        ...(foreignSymbols.length ? [quoteGroup(global, request, foreignSymbols, 'GLOBAL')] : []),
      ]);
      const bySymbol = new Map(groups.flatMap(group => group.quotes).map(quote => [quote.symbol, quote]));
      const byIssue = new Map(groups.flatMap(group => group.issues).map(issue => [issue.symbol, issue]));
      const quotes = symbols.filter(symbol => bySymbol.has(symbol)).map(symbol => bySymbol.get(symbol));
      const issues = symbols.filter(symbol => byIssue.has(symbol)).map(symbol => byIssue.get(symbol));
      const retryAfter = issues.reduce((maximum, issue) => Math.max(maximum, issue.retryAfter ?? 0), 0) || null;
      if (!quotes.length) {
        const failure = issues.find(issue => FAILURE[issue.code][0] >= 500) ?? issues.find(issue => issue.code === 'rate_limited') ?? issues[0];
        return error(failure?.code ?? 'source_unavailable', issues, retryAfter);
      }
      const coverage = groups.find(group => group.coverage)?.coverage;
      return json({ quotes, issues, generatedAt: new Date(now()).toISOString(), ...(coverage ? { coverage } : {}) }, 200, retryAfter);
    }
    if (url.pathname.startsWith('/history/')) {
      let symbol;
      try { symbol = decodeURIComponent(url.pathname.slice('/history/'.length)); } catch { return error('invalid_request'); }
      if (QUALIFIED_SYMBOL.test(symbol)) return global.handle(request);
      return pse.handle(request);
    }
    // Index, Philippine mutual funds and FMETF retain their existing source contracts.
    return pse.handle(request);
  }
  return { handle, fetch: handle };
}
