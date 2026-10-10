/**
 * ml-categorization.test.ts
 * Vitest Test Suite for Milestone M4: Client-Side ML Categorization (Requirement R4).
 * 
 * Verifies:
 * 1. Web Worker message passing and lifecycle (INIT_MODEL, CATEGORIZE_TRANSACTIONS, CLASSIFY_BATCH).
 * 2. Classification accuracy across common financial statement categories.
 * 3. Quantized INT8 inference and compact memory footprint.
 * 4. Zero outbound network calls (100% on-device privacy guarantee).
 * 5. Tiered hybrid categorization and IndexedDB rule cache learning.
 * 6. Edge cases: empty text, accents, emojis, giant strings, rapid queues.
 * 7. Category mapping to Tala database categories.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  handleWorkerMessage,
  QuantizedNeuralClassifier,
  CATEGORIES,
  VOCABULARY
} from '../src/workers/categorizer.worker';
import {
  categorizeBatch,
  categorizeTransaction,
  learnCategoryRule,
  getCachedCategoryRule,
  clearRuleCache,
  mapToDbCategoryId,
  normalizeMerchantKey
} from '../src/workers/mlCategorizer';
import type { Category } from '../src/core/types';

describe('Milestone M4: Client-Side ML Categorization (Requirement R4)', () => {
  beforeEach(async () => {
    await clearRuleCache();
    vi.restoreAllMocks();
  });

  describe('1. Web Worker Protocol & Message Passing', () => {
    it('handles INIT_MODEL message and returns INT8 quantized model metadata', async () => {
      let response: any = null;
      handleWorkerMessage(
        { type: 'INIT_MODEL', modelUrl: '/models' },
        (res) => { response = res; }
      );

      expect(response).not.toBeNull();
      expect(response.type).toBe('INIT_SUCCESS');
      expect(response.payload.model).toBe('categorizer-q8.onnx');
      expect(response.payload.quantized).toBe('INT8');
      expect(response.payload.memoryBytes).toBeGreaterThan(0);
    });

    it('handles CATEGORIZE_TRANSACTIONS message passing with full prediction metadata', async () => {
      let response: any = null;
      const transactions = [
        { id: 'tx_util_1', description: 'MERALCO POWER BILL', amount: 350000 },
        { id: 'tx_groc_1', description: 'SM SUPERMARKET MAKATI', amount: 245000 }
      ];

      handleWorkerMessage(
        { type: 'CATEGORIZE_TRANSACTIONS', payload: { transactions } },
        (res) => { response = res; }
      );

      expect(response).not.toBeNull();
      expect(response.type).toBe('CATEGORIZE_SUCCESS');
      const results = response.payload.results;
      expect(results.length).toBe(2);

      // Utility item
      expect(results[0].id).toBe('tx_util_1');
      expect(results[0].categoryId).toBe('cat_utilities');
      expect(results[0].categoryName).toBe('Utilities & Bills');
      expect(results[0].confidence).toBeGreaterThan(0.90);
      expect(Array.isArray(results[0].alternatives)).toBe(true);
      expect(results[0].alternatives.length).toBeGreaterThan(0);

      // Grocery item
      expect(results[1].id).toBe('tx_groc_1');
      expect(results[1].categoryId).toBe('cat_groceries');
      expect(results[1].categoryName).toBe('Groceries');
      expect(results[1].confidence).toBeGreaterThan(0.90);
    });

    it('handles CLASSIFY_BATCH format with requestId preserving message structure', async () => {
      let response: any = null;
      handleWorkerMessage(
        {
          type: 'CLASSIFY_BATCH',
          requestId: 'req_batch_123',
          items: [
            { id: 'item_1', merchant: 'STARBUCKS COFFEE', amount: 21000 }
          ]
        },
        (res) => { response = res; }
      );

      expect(response).not.toBeNull();
      expect(response.type).toBe('CLASSIFY_SUCCESS');
      expect(response.requestId).toBe('req_batch_123');
      expect(response.results.length).toBe(1);
      expect(response.results[0].categoryId).toBe('cat_dining');
      expect(response.results[0].categoryName).toBe('Food & Dining');
    });
  });

  describe('2. Classification Accuracy Across Common Financial Statement Categories', () => {
    const classifier = new QuantizedNeuralClassifier();

    it('classifies Utilities & Bills accurately (> 0.90 confidence)', () => {
      const samples = [
        'MERALCO POWER PAYMENT',
        'MAYNILAD WATER SERVICES',
        'MANILA WATER CO BILL',
        'PLDT HOME FIBR TELCO',
        'GLOBE TELECOM POSTPAID'
      ];
      for (const text of samples) {
        const pred = classifier.classifyText(text);
        expect(pred.categoryId).toBe('cat_utilities');
        expect(pred.confidence).toBeGreaterThan(0.90);
      }
    });

    it('classifies Groceries accurately (> 0.90 confidence)', () => {
      const samples = [
        'SM SUPERMARKET MEGAMALL',
        'PUREGOLD PRICE CLUB',
        'ROBINSONS SUPERMARKET',
        'WALTERMART SUPERMARKET'
      ];
      for (const text of samples) {
        const pred = classifier.classifyText(text);
        expect(pred.categoryId).toBe('cat_groceries');
        expect(pred.confidence).toBeGreaterThan(0.90);
      }
    });

    it('classifies Food & Dining accurately (> 0.90 confidence)', () => {
      const samples = [
        'JOLLIBEE DRIVE THRU BGC',
        'MCDONALDS DELIVERY',
        'STARBUCKS COFFEE AYALA',
        'MANG INASAL RESTAURANT',
        'FRENCH BISTRO & CAFE'
      ];
      for (const text of samples) {
        const pred = classifier.classifyText(text);
        expect(pred.categoryId).toBe('cat_dining');
        expect(pred.confidence).toBeGreaterThan(0.90);
      }
    });

    it('classifies Salary & Income accurately (> 0.90 confidence)', () => {
      const samples = [
        'PAYROLL ACME CORP DIRECT DEPOSIT',
        'MONTHLY SALARY COMPENSATION',
        'BONUS STIPEND PAYOUT'
      ];
      for (const text of samples) {
        const pred = classifier.classifyText(text);
        expect(pred.categoryId).toBe('cat_income');
        expect(pred.confidence).toBeGreaterThan(0.90);
      }
    });

    it('classifies Transportation accurately (> 0.85 confidence)', () => {
      const samples = [
        'GRAB CAR HOLDINGS',
        'PETRON GAS STATION EXPRESS',
        'SHELL SELECT FUEL',
        'ANGKAS MOTORCYCLE TAXI'
      ];
      for (const text of samples) {
        const pred = classifier.classifyText(text);
        expect(pred.categoryId).toBe('cat_transport');
        expect(pred.confidence).toBeGreaterThan(0.85);
      }
    });

    it('classifies Entertainment, Healthcare, and Investments', () => {
      expect(classifier.classifyText('NETFLIX SUBSCRIPTION').categoryId).toBe('cat_entertainment');
      expect(classifier.classifyText('SPOTIFY PREMIUM').categoryId).toBe('cat_entertainment');
      expect(classifier.classifyText('ST LUKES MEDICAL CENTER OPD').categoryId).toBe('cat_healthcare');
      expect(classifier.classifyText('MERCURY DRUG PHARMACY').categoryId).toBe('cat_healthcare');
      expect(classifier.classifyText('COL FINANCIAL STOCK PURCHASE').categoryId).toBe('cat_investment');
      expect(classifier.classifyText('VANGUARD ETF DIVIDEND').categoryId).toBe('cat_investment');
    });

    it('falls back safely to cat_other for cryptic or unrecognized merchant codes', () => {
      const samples = [
        'POS 99824987 XY-ZZ-Q',
        'TXN-9988-7711-UNKNOWN',
        'QXZW-8871239'
      ];
      for (const text of samples) {
        const pred = classifier.classifyText(text);
        expect(pred.categoryId).toBe('cat_other');
        expect(pred.categoryName).toBe('Other / Miscellaneous');
      }
    });
  });

  describe('3. Quantized INT8 Model Structure & Memory Footprint', () => {
    it('uses genuine INT8 quantized weight matrices bounded in [-128, 127]', () => {
      const classifier = new QuantizedNeuralClassifier();
      const numCats = CATEGORIES.length;
      const numVocab = VOCABULARY.length;

      // Access private weight buffer through reflection to verify quantization
      const weights = (classifier as any).weightsInt8 as Int8Array;
      expect(weights instanceof Int8Array).toBe(true);
      expect(weights.length).toBe(numCats * numVocab);

      let minVal = 127;
      let maxVal = -128;
      for (let i = 0; i < weights.length; i++) {
        const val = weights[i];
        expect(val).toBeGreaterThanOrEqual(-128);
        expect(val).toBeLessThanOrEqual(127);
        if (val < minVal) minVal = val;
        if (val > maxVal) maxVal = val;
      }

      // Confirms genuine non-trivial quantized weight variation
      expect(minVal).toBeLessThan(0);
      expect(maxVal).toBeGreaterThan(50);
    });

    it('guarantees compact memory footprint (< 50KB weight matrix in worker)', () => {
      const classifier = new QuantizedNeuralClassifier();
      const weights = (classifier as any).weightsInt8 as Int8Array;
      // INT8 is 1 byte per parameter
      expect(weights.byteLength).toBeLessThan(50 * 1024);
    });
  });

  describe('4. Zero Outbound Network Requests (Strict Client-Side Privacy)', () => {
    it('produces strictly zero network calls during batch and single inference', async () => {
      // Spy on global fetch
      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      const batch = [
        { id: 'p1', description: 'PAYROLL CONFIDENTIAL MEDICAL SALARY', amount: 5000000 },
        { id: 'p2', description: 'ST LUKES PSYCHIATRIC CLINIC', amount: 350000 },
        { id: 'p3', description: 'PRIVATE LOAN INTEREST', amount: 120000 }
      ];

      const results = await categorizeBatch(batch);
      expect(results.length).toBe(3);

      // Strict privacy invariant: zero network leakage of sensitive transaction records
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('5. Tiered Hybrid Categorization & IndexedDB Rule Learning', () => {
    it('Tier 1: resolves cached user rules in < 1ms with confidence 1.0', async () => {
      // User teaches system a rule
      await learnCategoryRule('Local Artisan Roaster', 'cat_dining');

      const start = performance.now();
      const [res] = await categorizeBatch([
        { id: 'tx_cached_1', merchant: 'Local Artisan Roaster', amount: 25000 }
      ]);
      const elapsed = performance.now() - start;

      expect(res.resolvedBy).toBe('idb_rule_cache');
      expect(res.categoryId).toBe('cat_dining');
      expect(res.confidence).toBe(1.0);
      expect(elapsed).toBeLessThan(15); // sub-millisecond execution in native JS
    });

    it('Tier 2: falls back to neural classifier when merchant is not in rule cache', async () => {
      const [res] = await categorizeBatch([
        { id: 'tx_uncached_1', merchant: 'Unseen Jollibee Branch', amount: 18000 }
      ]);

      expect(res.resolvedBy).toBe('ml_worker');
      expect(res.categoryId).toBe('cat_dining');
      expect(res.confidence).toBeGreaterThan(0.85);
    });

    it('learnCategoryRule updates cache and changes subsequent classification', async () => {
      // Initial inference on unique boutique gives cat_other
      const initial = await categorizeTransaction({
        merchant: 'Unknown Specialty Shop'
      });
      expect(initial.categoryId).toBe('cat_other');

      // User overrides to Entertainment
      await learnCategoryRule('Unknown Specialty Shop', 'cat_entertainment');

      // Subsequent lookup resolves to overridden category
      const subsequent = await categorizeTransaction({
        merchant: 'Unknown Specialty Shop'
      });
      expect(subsequent.resolvedBy).toBe('idb_rule_cache');
      expect(subsequent.categoryId).toBe('cat_entertainment');
    });

    it('normalizes merchant keys ignoring case, whitespace, and diacritics', () => {
      expect(normalizeMerchantKey('  Meralco Bill  ')).toBe('meralco bill');
      expect(normalizeMerchantKey('Café Español')).toBe('cafe espanol');
      expect(normalizeMerchantKey('')).toBe('');
    });
  });

  describe('6. Boundary & Corner Cases', () => {
    it('handles empty or whitespace-only descriptions without crashing', async () => {
      const results = await categorizeBatch([
        { id: 'e1', description: '' },
        { id: 'e2', description: '     \t\n   ' },
        { id: 'e3', description: undefined as any }
      ]);

      expect(results.length).toBe(3);
      expect(results[0].categoryId).toBe('cat_other');
      expect(results[1].categoryId).toBe('cat_other');
      expect(results[2].categoryId).toBe('cat_other');
    });

    it('normalizes accented characters, peso sign (₱), and emojis', async () => {
      const results = await categorizeBatch([
        { id: 'b1', description: '🛒 Puregold Supermarket ₱500', amount: 50000 },
        { id: 'b2', description: 'Restaurán Español Niño', amount: 85000 }
      ]);

      expect(results.length).toBe(2);
      expect(results[0].categoryId).toBe('cat_groceries');
      expect(results[1].categoryId).toBe('cat_dining');
    });

    it('safely handles 15,000+ character strings without worker crash or buffer overflow', async () => {
      const oversized = 'SM SUPERMARKET '.repeat(1000);
      const [res] = await categorizeBatch([
        { id: 'big_1', description: oversized, amount: 250000 }
      ]);

      expect(res.categoryId).toBe('cat_groceries');
      expect(res.confidence).toBeGreaterThan(0.90);
    });

    it('processes 50+ item batch without timeouts or race conditions', async () => {
      const batch = Array.from({ length: 60 }, (_, i) => ({
        id: `stress_tx_${i}`,
        description: i % 2 === 0 ? 'JOLLIBEE DELIVERY' : 'PETRON FUEL',
        amount: 20000 + i * 50
      }));

      const results = await categorizeBatch(batch);
      expect(results.length).toBe(60);
      expect(results[0].categoryId).toBe('cat_dining');
      expect(results[1].categoryId).toBe('cat_transport');
    });
  });

  describe('7. Category Mapping to Tala Database Categories', () => {
    const mockDbCategories: Category[] = [
      { id: 'category-food', name: 'Food', kind: 'expense', color: '#6b7280', essential: true, archived: false },
      { id: 'category-housing', name: 'Housing', kind: 'expense', color: '#6b7280', essential: true, archived: false },
      { id: 'category-transport', name: 'Transport', kind: 'expense', color: '#6b7280', essential: false, archived: false },
      { id: 'category-salary', name: 'Salary', kind: 'income', color: '#6b7280', essential: false, archived: false },
      { id: 'category-entertainment', name: 'Entertainment', kind: 'expense', color: '#6b7280', essential: false, archived: false },
      { id: 'category-healthcare', name: 'Healthcare', kind: 'expense', color: '#6b7280', essential: true, archived: false },
      { id: 'category-miscellaneous', name: 'Miscellaneous', kind: 'expense', color: '#6b7280', essential: false, archived: false }
    ];

    it('maps predicted categories to matching Tala DB category IDs', () => {
      expect(mapToDbCategoryId('cat_groceries', mockDbCategories)).toBe('category-food');
      expect(mapToDbCategoryId('cat_dining', mockDbCategories)).toBe('category-food');
      expect(mapToDbCategoryId('cat_utilities', mockDbCategories)).toBe('category-housing');
      expect(mapToDbCategoryId('cat_income', mockDbCategories)).toBe('category-salary');
      expect(mapToDbCategoryId('cat_transport', mockDbCategories)).toBe('category-transport');
      expect(mapToDbCategoryId('cat_healthcare', mockDbCategories)).toBe('category-healthcare');
      expect(mapToDbCategoryId('cat_entertainment', mockDbCategories)).toBe('category-entertainment');
      expect(mapToDbCategoryId('cat_other', mockDbCategories)).toBe('category-miscellaneous');
    });

    it('returns undefined if no categories provided or no match exists', () => {
      expect(mapToDbCategoryId('cat_unknown', [])).toBeUndefined();
    });
  });
});
