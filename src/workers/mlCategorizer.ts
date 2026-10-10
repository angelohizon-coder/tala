/**
 * mlCategorizer.ts
 * Client wrapper for Client-Side ML Categorization and Hybrid IndexedDB Rule Caching.
 * 
 * Provides:
 * - Tier 1: Local IndexedDB / memory rule cache (< 0.05ms merchant resolution).
 * - Tier 2/3: Dedicated Web Worker running INT8 quantized neural inference.
 * - Learning user overrides and category mapping to Tala ledger categories.
 */

import { financeRepository } from '../db/repository';
import type { Category } from '../core/types';
import {
  QuantizedNeuralClassifier,
  CATEGORIES,
  type MLCategoryPrediction,
  type TransactionInput
} from './categorizer.worker';

export type { MLCategoryPrediction, TransactionInput };

export interface HybridCategoryResult extends MLCategoryPrediction {
  resolvedBy: 'idb_rule_cache' | 'ml_worker';
}

const SETTING_KEY_RULES = 'ml-category-rules';

// In-memory cache synced with IndexedDB
let localRuleCache = new Map<string, string>();
let cacheInitialized = false;

// Active worker instance
let activeWorker: Worker | null = null;
let isWorkerInitializing = false;
let initPromise: Promise<{ model: string; quantized: string }> | null = null;

// Local fallback classifier for environments without Web Worker support (e.g., Node/Vitest)
const localFallbackClassifier = new QuantizedNeuralClassifier();

/**
 * Initializes the rule cache from IndexedDB settings.
 */
export async function initRuleCache(): Promise<void> {
  if (cacheInitialized) return;
  try {
    const saved = await financeRepository.getSetting<Record<string, string>>(SETTING_KEY_RULES);
    if (saved && typeof saved === 'object') {
      localRuleCache = new Map(Object.entries(saved));
    }
  } catch {
    // If DB is unavailable, keep in-memory cache
  }
  cacheInitialized = true;
}

/**
 * Normalizes a merchant or description string for consistent indexing.
 */
export function normalizeMerchantKey(raw: string): string {
  if (!raw) return '';
  return raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

/**
 * Retrieves a cached rule if present in the IDB rule cache.
 */
export function getCachedCategoryRule(merchant: string): string | null {
  const key = normalizeMerchantKey(merchant);
  return localRuleCache.get(key) || null;
}

/**
 * Stores a user-confirmed category rule in memory and persists to IndexedDB.
 */
export async function learnCategoryRule(
  merchant: string,
  categoryId: string
): Promise<void> {
  const key = normalizeMerchantKey(merchant);
  if (!key) return;

  localRuleCache.set(key, categoryId);

  try {
    const rulesObj = Object.fromEntries(localRuleCache.entries());
    await financeRepository.setSetting(SETTING_KEY_RULES, rulesObj);
  } catch {
    // Graceful fallback if IDB write fails
  }
}

/**
 * Clears the rule cache (useful for testing and reset).
 */
export async function clearRuleCache(): Promise<void> {
  localRuleCache.clear();
  try {
    await financeRepository.setSetting(SETTING_KEY_RULES, {});
  } catch {
    // Ignore error
  }
}

/**
 * Initializes the Dedicated Web Worker.
 */
export async function initCategorizerWorker(): Promise<{ model: string; quantized: string }> {
  if (initPromise) return initPromise;

  initPromise = new Promise((resolve) => {
    try {
      if (typeof Worker !== 'undefined') {
        if (!activeWorker) {
          activeWorker = new Worker(
            new URL('./categorizer.worker.ts', import.meta.url),
            { type: 'module' }
          );
        }

        const handler = (e: MessageEvent) => {
          if (e.data?.type === 'INIT_SUCCESS') {
            activeWorker?.removeEventListener('message', handler);
            resolve(e.data.payload);
          }
        };

        activeWorker.addEventListener('message', handler);
        activeWorker.postMessage({ type: 'INIT_MODEL', modelUrl: '/models' });
      } else {
        // Fallback for non-worker environments
        resolve({
          model: 'categorizer-q8.onnx',
          quantized: 'INT8'
        });
      }
    } catch {
      resolve({
        model: 'categorizer-q8.onnx',
        quantized: 'INT8'
      });
    }
  });

  return initPromise;
}

/**
 * Terminates the categorizer worker and resets worker state.
 */
export function terminateCategorizerWorker(): void {
  if (activeWorker) {
    activeWorker.terminate();
    activeWorker = null;
  }
  initPromise = null;
  isWorkerInitializing = false;
}

/**
 * Dispatches a batch of transactions to the Web Worker for classification.
 */
async function classifyWithWorker(
  items: TransactionInput[]
): Promise<MLCategoryPrediction[]> {
  if (items.length === 0) return [];

  // If in browser and Worker is supported
  if (typeof Worker !== 'undefined') {
    try {
      if (!activeWorker) {
        await initCategorizerWorker();
      }

      return await new Promise<MLCategoryPrediction[]>((resolve, reject) => {
        if (!activeWorker) {
          // Worker initialization failed, use fallback
          resolve(classifyWithLocalFallback(items));
          return;
        }

        const timeout = setTimeout(() => {
          activeWorker?.removeEventListener('message', onMessage);
          resolve(classifyWithLocalFallback(items));
        }, 8000);

        const onMessage = (e: MessageEvent) => {
          if (e.data?.type === 'CATEGORIZE_SUCCESS' || e.data?.type === 'CLASSIFY_SUCCESS') {
            clearTimeout(timeout);
            activeWorker?.removeEventListener('message', onMessage);
            const results = e.data.payload?.results || e.data.results || [];
            resolve(results);
          }
        };

        activeWorker.addEventListener('message', onMessage);
        activeWorker.postMessage({
          type: 'CATEGORIZE_TRANSACTIONS',
          payload: { transactions: items }
        });
      });
    } catch {
      return classifyWithLocalFallback(items);
    }
  }

  // Local fallback for Node / Vitest
  return classifyWithLocalFallback(items);
}

function classifyWithLocalFallback(
  items: TransactionInput[]
): MLCategoryPrediction[] {
  return items.map((item) => {
    const text = item.description || item.merchant || '';
    const res = localFallbackClassifier.classifyText(text);
    return {
      id: item.id,
      categoryId: res.categoryId,
      categoryName: res.categoryName,
      confidence: res.confidence,
      alternatives: res.alternatives
    };
  });
}

/**
 * Tiered Hybrid Categorization:
 * Tier 1: Resolves cached rules in IDB (0.05ms)
 * Tier 2/3: Dispatches uncached items to Web Worker
 */
export async function categorizeBatch(
  transactions: Array<{ id: string; description?: string; merchant?: string; amount?: number }>
): Promise<HybridCategoryResult[]> {
  await initRuleCache();

  const results: HybridCategoryResult[] = new Array(transactions.length);
  const uncachedIndices: number[] = [];
  const uncachedItems: TransactionInput[] = [];

  for (let i = 0; i < transactions.length; i++) {
    const tx = transactions[i];
    const text = tx.merchant || tx.description || '';
    const key = normalizeMerchantKey(text);

    if (key && localRuleCache.has(key)) {
      const cachedCatId = localRuleCache.get(key)!;
      const def = CATEGORIES.find(c => c.id === cachedCatId);
      results[i] = {
        id: tx.id,
        categoryId: cachedCatId,
        categoryName: def?.name || 'User Custom',
        confidence: 1.0,
        alternatives: [],
        resolvedBy: 'idb_rule_cache'
      };
    } else {
      uncachedIndices.push(i);
      uncachedItems.push({
        id: tx.id,
        description: tx.description || tx.merchant || '',
        merchant: tx.merchant || tx.description || '',
        amount: tx.amount
      });
    }
  }

  if (uncachedItems.length > 0) {
    const mlResults = await classifyWithWorker(uncachedItems);
    for (let j = 0; j < uncachedItems.length; j++) {
      const originalIdx = uncachedIndices[j];
      const ml = mlResults[j];
      results[originalIdx] = {
        ...ml,
        resolvedBy: 'ml_worker'
      };
    }
  }

  return results;
}

/**
 * Categorizes a single transaction using the hybrid pipeline.
 */
export async function categorizeTransaction(
  tx: { id?: string; description?: string; merchant?: string; amount?: number }
): Promise<HybridCategoryResult> {
  const id = tx.id || crypto.randomUUID();
  const [res] = await categorizeBatch([{ ...tx, id }]);
  return res;
}

/**
 * Maps a predicted internal category ID (e.g. 'cat_groceries', 'cat_dining')
 * to a corresponding Tala Category in the database.
 */
export function mapToDbCategoryId(
  predictedCategoryId: string,
  categories: Category[]
): string | undefined {
  if (!categories || categories.length === 0) return undefined;

  // Direct ID exact match
  const exact = categories.find(c => c.id === predictedCategoryId && !c.archived);
  if (exact) return exact.id;

  // Keyword / category group mappings
  const mappingRules: Record<string, string[]> = {
    cat_utilities: ['housing', 'utility', 'utilities', 'bills'],
    cat_groceries: ['food', 'grocery', 'groceries', 'supermarket'],
    cat_dining: ['food', 'dining', 'restaurant', 'cafe'],
    cat_income: ['salary', 'income', 'wage'],
    cat_transport: ['transport', 'transportation', 'travel'],
    cat_entertainment: ['entertainment', 'subscription', 'subscriptions'],
    cat_healthcare: ['healthcare', 'health', 'medical'],
    cat_investment: ['invest', 'investment', 'miscellaneous'],
    cat_housing: ['housing', 'rent'],
    cat_travel: ['travel', 'transport'],
    cat_other: ['miscellaneous', 'other', 'personal']
  };

  const keywords = mappingRules[predictedCategoryId] || [];
  for (const kw of keywords) {
    const found = categories.find(c =>
      !c.archived && (
        c.name.toLowerCase().includes(kw) ||
        c.id.toLowerCase().includes(kw)
      )
    );
    if (found) return found.id;
  }

  return undefined;
}
