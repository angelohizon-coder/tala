"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getMarketQuote = exports.ALLOWED_ORIGINS = void 0;
exports.isOriginAllowed = isOriginAllowed;
exports.isValidSymbol = isValidSymbol;
exports.getCachedQuote = getCachedQuote;
exports.saveCachedQuote = saveCachedQuote;
exports.fetchYahooQuote = fetchYahooQuote;
exports.fetchFcsQuote = fetchFcsQuote;
exports.resolveMarketQuote = resolveMarketQuote;
exports.handleMarketQuoteRequest = handleMarketQuoteRequest;
const https_1 = require("firebase-functions/v2/https");
const logger = __importStar(require("firebase-functions/logger"));
const admin = __importStar(require("firebase-admin"));
const axios_1 = __importDefault(require("axios"));
/**
 * Strict allowed CORS origins.
 * Only the canonical GitHub Pages origin and Vite dev/preview ports are permitted.
 */
exports.ALLOWED_ORIGINS = [
    "https://angelohizon-coder.github.io",
    "http://localhost:5173",
    "http://localhost:5174",
    "http://127.0.0.1:5173",
    "http://127.0.0.1:5174"
];
/**
 * Validates whether an origin is allowed under the strict CORS policy.
 * Returns true if allowed or if origin is absent (same-origin / server-to-server).
 */
function isOriginAllowed(origin) {
    if (!origin)
        return true;
    return exports.ALLOWED_ORIGINS.includes(origin);
}
/**
 * Validates a financial symbol parameter.
 * Strictly prevents path traversal, XSS, and SQL injection payloads.
 */
function isValidSymbol(symbol) {
    if (!symbol || typeof symbol !== "string")
        return false;
    const trimmed = symbol.trim();
    if (trimmed.length === 0 || trimmed.length > 15)
        return false;
    return /^[A-Za-z0-9._-]+$/.test(trimmed);
}
/**
 * Lazy initializer for Firebase Admin Firestore.
 */
function getFirestoreInstance(injectedDb) {
    if (injectedDb)
        return injectedDb;
    if (!admin.apps.length) {
        admin.initializeApp();
    }
    return admin.firestore();
}
/**
 * Reads a cached quote from Firestore STALE cache under `/marketCache/{symbol}`.
 */
async function getCachedQuote(symbol, injectedDb) {
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
    }
    catch (err) {
        logger.warn(`Failed to read quote from Firestore cache for ${symbol}`, err);
        return null;
    }
}
/**
 * Persists a valid, non-zero quote to Firestore cache under `/marketCache/{symbol}`.
 * CRITICAL DEFENSE: Never caches zero, negative, non-finite, or already-stale quotes.
 */
async function saveCachedQuote(quote, injectedDb) {
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
    }
    catch (err) {
        logger.warn(`Failed to save quote to Firestore cache for ${quote.symbol}`, err);
    }
}
/**
 * Primary Provider: Fetches quote from Yahoo Finance v8 chart API.
 */
async function fetchYahooQuote(symbol) {
    var _a, _b, _c;
    var _d, _e;
    const cleanSymbol = symbol.trim().toUpperCase();
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(cleanSymbol)}?interval=1d&range=1mo`;
    const response = await axios_1.default.get(url, {
        timeout: 8000,
        headers: {
            "User-Agent": "Mozilla/5.0 TalaFinance/2.0 (compatible; MarketGateway/1.0)",
            "Accept": "application/json"
        }
    });
    const result = (_c = (_b = (_a = response.data) === null || _a === void 0 ? void 0 : _a.chart) === null || _b === void 0 ? void 0 : _b.result) === null || _c === void 0 ? void 0 : _c[0];
    if (!result || !result.meta) {
        throw new Error(`Yahoo Finance empty or missing meta for symbol ${cleanSymbol}`);
    }
    const meta = result.meta;
    const price = Number(meta.regularMarketPrice);
    if (!Number.isFinite(price) || price <= 0) {
        throw new Error(`Invalid Yahoo price for ${cleanSymbol}: ${price}`);
    }
    const prev = Number((_e = (_d = meta.chartPreviousClose) !== null && _d !== void 0 ? _d : meta.previousClose) !== null && _e !== void 0 ? _e : price);
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
async function fetchFcsQuote(symbol, apiKey) {
    var _a, _b;
    var _c, _d;
    const cleanSymbol = symbol.trim().toUpperCase();
    const key = apiKey || process.env.FCS_API_KEY || "demo_access_key";
    const url = `https://fcsapi.com/api-v3/stock/latest?symbol=${encodeURIComponent(cleanSymbol)}&access_key=${encodeURIComponent(key)}`;
    const response = await axios_1.default.get(url, { timeout: 8000 });
    const row = (_b = (_a = response.data) === null || _a === void 0 ? void 0 : _a.response) === null || _b === void 0 ? void 0 : _b[0];
    if (!row) {
        throw new Error(`FCS API empty response for symbol ${cleanSymbol}`);
    }
    const price = Number((_c = row.c) !== null && _c !== void 0 ? _c : row.price);
    if (!Number.isFinite(price) || price <= 0) {
        throw new Error(`Invalid FCS price for ${cleanSymbol}: ${price}`);
    }
    const prev = Number((_d = row.o) !== null && _d !== void 0 ? _d : price);
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
/**
 * Resolves a market quote using the resilient multi-tier strategy:
 * Tier 1: Primary Yahoo Finance v8 chart API
 * Tier 2: Secondary fallback FCS API
 * Tier 3: Firestore STALE Cache (Zero-Price Defense)
 *
 * CRITICAL INVARIANT: NEVER returns price: 0 or replaces a failed quote with zero.
 */
async function resolveMarketQuote(symbol, options = {}) {
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
    }
    catch (yahooErr) {
        logger.warn(`Primary Yahoo provider failed for ${cleanSymbol}:`, yahooErr);
    }
    // Tier 2: Secondary FCS Fallback
    try {
        const quote = await fcs(cleanSymbol, options.fcsApiKey);
        if (quote && quote.price > 0 && Number.isFinite(quote.price)) {
            await saveCachedQuote(quote, options.db);
            return quote;
        }
    }
    catch (fcsErr) {
        logger.warn(`Secondary FCS provider failed for ${cleanSymbol}:`, fcsErr);
    }
    // Tier 3: Firestore STALE Cache lookup
    const cached = await getCachedQuote(cleanSymbol, options.db);
    if (cached && cached.price > 0 && Number.isFinite(cached.price)) {
        return Object.assign(Object.assign({}, cached), { provider: "cache", freshness: "stale", isStale: true, staleReason: cached.staleReason || "Upstream market providers unreachable; preserved last valid quote" });
    }
    // ZERO-PRICE DEFENSE: If no prior quote exists, throw an error instead of returning zero!
    throw new Error(`Market quote unavailable for ${cleanSymbol}; no prior valid quote recorded.`);
}
/**
 * Express request/response handler logic for Market Data Gateway.
 */
async function handleMarketQuoteRequest(req, res, options = {}) {
    var _a, _b, _c, _d, _e, _f, _g;
    const origin = ((_a = req.headers) === null || _a === void 0 ? void 0 : _a.origin) || ((_b = req.headers) === null || _b === void 0 ? void 0 : _b.Origin);
    // 1. Strict CORS validation
    if (!isOriginAllowed(origin)) {
        res.status(403);
        const errorBody = { error: "CORS origin not allowed" };
        if (typeof res.json === "function")
            res.json(errorBody);
        else
            res.send(errorBody);
        return;
    }
    // Set CORS headers for authorized origins
    if (origin && typeof res.setHeader === "function") {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    }
    // Handle HTTP OPTIONS preflight
    if (req.method === "OPTIONS") {
        res.status(204);
        if (typeof res.end === "function")
            res.end();
        else
            res.send("");
        return;
    }
    // 2. Extract symbol(s)
    const querySymbol = (_c = req.query) === null || _c === void 0 ? void 0 : _c.symbol;
    const bodySymbol = (_d = req.body) === null || _d === void 0 ? void 0 : _d.symbol;
    const rawSymbol = (typeof querySymbol === "string" ? querySymbol : undefined) ||
        (typeof bodySymbol === "string" ? bodySymbol : undefined);
    // Check for batch symbols
    const rawSymbols = ((_e = req.query) === null || _e === void 0 ? void 0 : _e.symbols) || ((_f = req.body) === null || _f === void 0 ? void 0 : _f.symbols);
    if (rawSymbols) {
        const symbolList = Array.isArray(rawSymbols)
            ? rawSymbols
            : typeof rawSymbols === "string"
                ? rawSymbols.split(",").map((s) => s.trim()).filter(Boolean)
                : [];
        if (symbolList.length === 0 || symbolList.some(s => !isValidSymbol(s))) {
            res.status(400);
            const errorBody = { error: "Invalid symbol parameter" };
            if (typeof res.json === "function")
                res.json(errorBody);
            else
                res.send(errorBody);
            return;
        }
        const quotes = [];
        const errors = [];
        for (const sym of symbolList) {
            try {
                const quote = await resolveMarketQuote(sym, options);
                quotes.push(quote);
            }
            catch (err) {
                errors.push({ symbol: sym, error: err.message || "Failed to resolve quote" });
            }
        }
        res.status(200);
        const body = { quotes, errors: errors.length > 0 ? errors : undefined, timestamp: Date.now() };
        if (typeof res.json === "function")
            res.json(body);
        else
            res.send(body);
        return;
    }
    if (!rawSymbol || !isValidSymbol(rawSymbol)) {
        res.status(400);
        const errorBody = { error: "Invalid symbol parameter" };
        if (typeof res.json === "function")
            res.json(errorBody);
        else
            res.send(errorBody);
        return;
    }
    try {
        const quote = await resolveMarketQuote(rawSymbol, options);
        // Strict invariant: price must be strictly positive
        if (quote.price <= 0 || !Number.isFinite(quote.price)) {
            throw new Error(`CRITICAL_ZERO_PRICE_VIOLATION: Quote for ${rawSymbol} had non-positive price`);
        }
        res.status(200);
        if (typeof res.json === "function")
            res.json(quote);
        else
            res.send(quote);
    }
    catch (err) {
        logger.error(`Error resolving quote for ${rawSymbol}:`, err);
        const status = ((_g = err.message) === null || _g === void 0 ? void 0 : _g.includes("no prior valid quote recorded")) ? 503 : 500;
        res.status(status);
        const errorBody = { error: err.message || "Failed to fetch market data." };
        if (typeof res.json === "function")
            res.json(errorBody);
        else
            res.send(errorBody);
    }
}
/**
 * Cloud Function entry point for Market Data Gateway.
 */
exports.getMarketQuote = (0, https_1.onRequest)({ cors: [...exports.ALLOWED_ORIGINS] }, async (req, res) => {
    await handleMarketQuoteRequest(req, res);
});
//# sourceMappingURL=index.js.map