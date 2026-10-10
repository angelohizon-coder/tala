import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import axios from "axios";

/**
 * Standardized market quote schema for Tala financial SPA.
 */
export interface NormalizedMarketQuote {
  symbol: string;
  price: number;
  currency: string;
  timestamp: number;
  asOf: string;
  provider: 'yahoo' | 'fcs' | 'cache';
  freshness: 'realtime' | 'delayed' | 'stale';
  isStale: boolean;
  change?: number;
  changePercent?: number;
  name?: string;
  previousClose?: number;
  volume?: number;
  staleReason?: string;
}

/**
 * Strict allowed CORS origins.
 * Only the canonical GitHub Pages origin and Vite dev/preview ports are permitted.
 */
export const ALLOWED_ORIGINS: readonly string[] = [
  "https://angelohizon-coder.github.io",
  "http://localhost:5173",
  "http://localhost:5174",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:5174",
  "https://kotoba-41ab0.web.app",
  "https://kotoba-41ab0.firebaseapp.com"
];

/**
 * Validates whether an origin is allowed under the strict CORS policy.
 * Returns true if allowed or if origin is absent (same-origin / server-to-server).
 */
export function isOriginAllowed(origin?: string | null): boolean {
  if (!origin) return true;
  return ALLOWED_ORIGINS.includes(origin);
}

/**
 * Validates a financial symbol parameter.
 * Strictly prevents path traversal, XSS, and SQL injection payloads.
 */
export function isValidSymbol(symbol: unknown): symbol is string {
  if (!symbol || typeof symbol !== "string") return false;
  const trimmed = symbol.trim();
  if (trimmed.length === 0 || trimmed.length > 15) return false;
  return /^[A-Za-z0-9._-]+$/.test(trimmed);
}

/**
 * Lazy initializer for Firebase Admin Firestore.
 */
function getFirestoreInstance(injectedDb?: any) {
  if (injectedDb) return injectedDb;
  if (!admin.apps.length) {
    admin.initializeApp();
  }
  return admin.firestore();
}

/**
 * Reads a cached quote from Firestore STALE cache under `/marketCache/{symbol}`.
 */
export async function getCachedQuote(symbol: string, injectedDb?: any): Promise<NormalizedMarketQuote | null> {
  try {
    const db = getFirestoreInstance(injectedDb);
    const cleanSymbol = symbol.trim().toUpperCase();
    const doc = await db.collection("marketCache").doc(cleanSymbol).get();
    if (!doc.exists) {
      return null;
    }
    const data = typeof doc.data === "function" ? doc.data() : doc.data;
    if (!data || typeof data.price !== "number" || !Number.isFinite(data.price) || data.price <= 0) {
      return null;
    }
    return {
      symbol: cleanSymbol,
      price: data.price,
      currency: data.currency || "PHP",
      timestamp: typeof data.timestamp === "number" ? data.timestamp : Date.now(),
      asOf: typeof data.asOf === "string" ? data.asOf : new Date().toISOString(),
      provider: "cache",
      freshness: "stale",
      isStale: true,
      change: typeof data.change === "number" ? data.change : undefined,
      changePercent: typeof data.changePercent === "number" ? data.changePercent : undefined,
      name: data.name,
      previousClose: typeof data.previousClose === "number" ? data.previousClose : undefined,
      volume: typeof data.volume === "number" ? data.volume : undefined,
      staleReason: data.staleReason || "Upstream market providers unreachable; preserved last valid quote"
    };
  } catch (err) {
    logger.warn(`Failed to read quote from Firestore cache for ${symbol}`, err);
    return null;
  }
}

/**
 * Persists a valid, non-zero quote to Firestore cache under `/marketCache/{symbol}`.
 * CRITICAL DEFENSE: Never caches zero, negative, non-finite, or already-stale quotes.
 */
export async function saveCachedQuote(quote: NormalizedMarketQuote, injectedDb?: any): Promise<void> {
  if (!quote || quote.price <= 0 || !Number.isFinite(quote.price) || quote.isStale) {
    return;
  }
  try {
    const db = getFirestoreInstance(injectedDb);
    const cleanSymbol = quote.symbol.trim().toUpperCase();
    const docRef = db.collection("marketCache").doc(cleanSymbol);
    const dataToSave = {
      symbol: cleanSymbol,
      price: quote.price,
      currency: quote.currency,
      timestamp: quote.timestamp,
      asOf: quote.asOf,
      provider: quote.provider,
      freshness: quote.freshness,
      isStale: quote.isStale,
      change: quote.change,
      changePercent: quote.changePercent,
      name: quote.name,
      previousClose: quote.previousClose,
      volume: quote.volume,
      cachedAt: new Date().toISOString(),
      updatedAtTimestamp: Date.now()
    };
    await docRef.set(dataToSave);
  } catch (err) {
    logger.warn(`Failed to save quote to Firestore cache for ${quote.symbol}`, err);
  }
}

/**
 * Primary Provider: Fetches quote from Yahoo Finance v8 chart API.
 */
export async function fetchYahooQuote(symbol: string): Promise<NormalizedMarketQuote> {
  const cleanSymbol = symbol.trim().toUpperCase();
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(cleanSymbol)}?interval=1d&range=1mo`;
  const response = await axios.get(url, {
    timeout: 8000,
    headers: {
      "User-Agent": "Mozilla/5.0 TalaFinance/2.0 (compatible; MarketGateway/1.0)",
      "Accept": "application/json"
    }
  });

  const result = response.data?.chart?.result?.[0];
  if (!result || !result.meta) {
    throw new Error(`Yahoo Finance empty or missing meta for symbol ${cleanSymbol}`);
  }

  const meta = result.meta;
  const price = Number(meta.regularMarketPrice);
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`Invalid Yahoo price for ${cleanSymbol}: ${price}`);
  }

  const prev = Number(meta.chartPreviousClose ?? meta.previousClose ?? price);
  const change = Number.isFinite(prev) && prev > 0 ? Number((price - prev).toFixed(4)) : undefined;
  const changePercent = Number.isFinite(prev) && prev > 0 && change !== undefined
    ? Number(((change / prev) * 100).toFixed(4))
    : undefined;

  const timestamp = meta.regularMarketTime ? meta.regularMarketTime * 1000 : Date.now();
  const asOf = new Date(timestamp).toISOString();

  return {
    symbol: cleanSymbol,
    price,
    currency: (meta.currency || "PHP").toUpperCase(),
    timestamp,
    asOf,
    provider: "yahoo",
    freshness: "delayed",
    isStale: false,
    change,
    changePercent,
    name: meta.shortName || meta.symbol || cleanSymbol,
    previousClose: Number.isFinite(prev) ? prev : undefined,
    volume: typeof meta.regularMarketVolume === "number" ? meta.regularMarketVolume : undefined
  };
}

/**
 * Secondary Fallback Provider: Fetches quote from FCS API.
 */
export async function fetchFcsQuote(symbol: string, apiKey?: string): Promise<NormalizedMarketQuote> {
  const cleanSymbol = symbol.trim().toUpperCase();
  const key = apiKey || process.env.FCS_API_KEY || "demo_access_key";
  const url = `https://fcsapi.com/api-v3/stock/latest?symbol=${encodeURIComponent(cleanSymbol)}&access_key=${encodeURIComponent(key)}`;
  const response = await axios.get(url, { timeout: 8000 });
  const row = response.data?.response?.[0];
  if (!row) {
    throw new Error(`FCS API empty response for symbol ${cleanSymbol}`);
  }

  const price = Number(row.c ?? row.price);
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`Invalid FCS price for ${cleanSymbol}: ${price}`);
  }

  const prev = Number(row.o ?? price);
  const change = Number.isFinite(prev) ? Number((price - prev).toFixed(4)) : undefined;
  const changePercent = typeof row.chg_percent === "number"
    ? row.chg_percent
    : (change !== undefined && prev > 0 ? Number(((change / prev) * 100).toFixed(4)) : undefined);

  const timestamp = Date.now();
  const asOf = new Date().toISOString();

  return {
    symbol: cleanSymbol,
    price,
    currency: (row.currency || "PHP").toUpperCase(),
    timestamp,
    asOf,
    provider: "fcs",
    freshness: "delayed",
    isStale: false,
    change,
    changePercent,
    name: row.name || cleanSymbol,
    previousClose: Number.isFinite(prev) ? prev : undefined,
    volume: typeof row.v === "number" ? row.v : undefined
  };
}

export interface ResolveQuoteOptions {
  db?: any;
  fcsApiKey?: string;
  yahooFetcher?: (symbol: string) => Promise<NormalizedMarketQuote>;
  fcsFetcher?: (symbol: string, key?: string) => Promise<NormalizedMarketQuote>;
}

/**
 * Resolves a market quote using the resilient multi-tier strategy:
 * Tier 1: Primary Yahoo Finance v8 chart API
 * Tier 2: Secondary fallback FCS API
 * Tier 3: Firestore STALE Cache (Zero-Price Defense)
 *
 * CRITICAL INVARIANT: NEVER returns price: 0 or replaces a failed quote with zero.
 */
export async function resolveMarketQuote(
  symbol: string,
  options: ResolveQuoteOptions = {}
): Promise<NormalizedMarketQuote> {
  const cleanSymbol = symbol.trim().toUpperCase();
  const yahoo = options.yahooFetcher || fetchYahooQuote;
  const fcs = options.fcsFetcher || fetchFcsQuote;

  // Tier 1: Primary Yahoo Finance
  try {
    const quote = await yahoo(cleanSymbol);
    if (quote && quote.price > 0 && Number.isFinite(quote.price)) {
      await saveCachedQuote(quote, options.db);
      return quote;
    }
  } catch (yahooErr) {
    logger.warn(`Primary Yahoo provider failed for ${cleanSymbol}:`, yahooErr);
  }

  // Tier 2: Secondary FCS Fallback
  try {
    const quote = await fcs(cleanSymbol, options.fcsApiKey);
    if (quote && quote.price > 0 && Number.isFinite(quote.price)) {
      await saveCachedQuote(quote, options.db);
      return quote;
    }
  } catch (fcsErr) {
    logger.warn(`Secondary FCS provider failed for ${cleanSymbol}:`, fcsErr);
  }

  // Tier 3: Firestore STALE Cache lookup
  const cached = await getCachedQuote(cleanSymbol, options.db);
  if (cached && cached.price > 0 && Number.isFinite(cached.price)) {
    return {
      ...cached,
      provider: "cache",
      freshness: "stale",
      isStale: true,
      staleReason: cached.staleReason || "Upstream market providers unreachable; preserved last valid quote"
    };
  }

  // ZERO-PRICE DEFENSE: If no prior quote exists, throw an error instead of returning zero!
  throw new Error(`Market quote unavailable for ${cleanSymbol}; no prior valid quote recorded.`);
}

/**
 * Express request/response handler logic for Market Data Gateway.
 */
export async function handleMarketQuoteRequest(
  req: { method?: string; headers?: Record<string, any>; query?: Record<string, any>; body?: any },
  res: { status: (code: number) => any; send: (data: any) => any; json?: (data: any) => any; setHeader?: (k: string, v: string) => any; end?: () => any },
  options: ResolveQuoteOptions = {}
): Promise<void> {
  const origin = req.headers?.origin || req.headers?.Origin;

  // 1. Strict CORS validation
  if (!isOriginAllowed(origin)) {
    res.status(403);
    const errorBody = { error: "CORS origin not allowed" };
    if (typeof res.json === "function") res.json(errorBody);
    else res.send(errorBody);
    return;
  }

  if (req.method === "OPTIONS") {
    res.status(204);
    if (typeof res.end === "function") res.end();
    else res.send("");
    return;
  }

  // 1.5. Firebase Auth Validation
  const authHeader = req.headers?.authorization || req.headers?.Authorization;
  if (!authHeader || typeof authHeader !== "string" || !authHeader.startsWith("Bearer ")) {
    res.status(401);
    const errorBody = { error: "Unauthorized: Missing or invalid token." };
    if (typeof res.json === "function") res.json(errorBody);
    else res.send(errorBody);
    return;
  }
  const idToken = authHeader.split("Bearer ")[1];
  try {
    if (!admin.apps.length) admin.initializeApp();
    await admin.auth().verifyIdToken(idToken);
  } catch (err) {
    res.status(401);
    const errorBody = { error: "Unauthorized: Token verification failed." };
    if (typeof res.json === "function") res.json(errorBody);
    else res.send(errorBody);
    return;
  }

  // 2. Extract symbol(s)
  const querySymbol = req.query?.symbol;
  const bodySymbol = req.body?.symbol;
  const rawSymbol = (typeof querySymbol === "string" ? querySymbol : undefined) ||
                     (typeof bodySymbol === "string" ? bodySymbol : undefined);

  // Check for batch symbols
  const rawSymbols = req.query?.symbols || req.body?.symbols;

  if (rawSymbols) {
    const symbolList: string[] = Array.isArray(rawSymbols)
      ? rawSymbols
      : typeof rawSymbols === "string"
      ? rawSymbols.split(",").map((s: string) => s.trim()).filter(Boolean)
      : [];

    if (symbolList.length === 0 || symbolList.some(s => !isValidSymbol(s))) {
      res.status(400);
      const errorBody = { error: "Invalid symbol parameter" };
      if (typeof res.json === "function") res.json(errorBody);
      else res.send(errorBody);
      return;
    }

    const quotes: NormalizedMarketQuote[] = [];
    const errors: { symbol: string; error: string }[] = [];

    for (const sym of symbolList) {
      try {
        const quote = await resolveMarketQuote(sym, options);
        quotes.push(quote);
      } catch (err: any) {
        errors.push({ symbol: sym, error: err.message || "Failed to resolve quote" });
      }
    }

    res.status(200);
    const body = { quotes, errors: errors.length > 0 ? errors : undefined, timestamp: Date.now() };
    if (typeof res.json === "function") res.json(body);
    else res.send(body);
    return;
  }

  if (!rawSymbol || !isValidSymbol(rawSymbol)) {
    res.status(400);
    const errorBody = { error: "Invalid symbol parameter" };
    if (typeof res.json === "function") res.json(errorBody);
    else res.send(errorBody);
    return;
  }

  try {
    const quote = await resolveMarketQuote(rawSymbol, options);
    // Strict invariant: price must be strictly positive
    if (quote.price <= 0 || !Number.isFinite(quote.price)) {
      throw new Error(`CRITICAL_ZERO_PRICE_VIOLATION: Quote for ${rawSymbol} had non-positive price`);
    }

    res.status(200);
    if (typeof res.json === "function") res.json(quote);
    else res.send(quote);
  } catch (err: any) {
    logger.error(`Error resolving quote for ${rawSymbol}:`, err);
    const status = err.message?.includes("no prior valid quote recorded") ? 503 : 500;
    res.status(status);
    const errorBody = { error: err.message || "Failed to fetch market data." };
    if (typeof res.json === "function") res.json(errorBody);
    else res.send(errorBody);
  }
}

/**
 * Cloud Function entry point for Market Data Gateway.
 */
export const getMarketQuote = onRequest(
  { cors: [...ALLOWED_ORIGINS] },
  async (req, res) => {
    await handleMarketQuoteRequest(req, res);
  }
);
