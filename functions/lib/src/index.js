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
exports.getMarketQuote = void 0;
const https_1 = require("firebase-functions/v2/https");
const logger = __importStar(require("firebase-functions/logger"));
const axios_1 = __importDefault(require("axios"));
// Hardcode allowed origins as per the directive.
const ALLOWED_ORIGINS = [
    "https://angelohizon-coder.github.io",
    "http://localhost:5173", // For local frontend development
    "http://127.0.0.1:5173"
];
exports.getMarketQuote = (0, https_1.onRequest)({ cors: ALLOWED_ORIGINS }, async (req, res) => {
    try {
        const { symbol } = req.query;
        if (!symbol || typeof symbol !== "string") {
            res.status(400).send({ error: "Missing or invalid symbol parameter." });
            return;
        }
        // Example integration: fetching from Yahoo Finance or a public API
        // To keep it simple and stable, we use Yahoo Finance's v8 API
        const response = await axios_1.default.get(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`);
        const result = response.data.chart.result;
        if (!result || result.length === 0) {
            res.status(404).send({ error: "Symbol not found." });
            return;
        }
        const price = result[0].meta.regularMarketPrice;
        const currency = result[0].meta.currency;
        res.status(200).send({
            symbol,
            price,
            currency,
            timestamp: Date.now()
        });
    }
    catch (error) {
        logger.error("Error fetching market quote", error);
        res.status(500).send({ error: "Failed to fetch market data." });
    }
});
//# sourceMappingURL=index.js.map