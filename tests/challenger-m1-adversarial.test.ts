import { describe, expect, it } from 'vitest';
import {
  calculateNetWorth,
  calculateNetWorthFromBalances,
  convertMoney,
  currencyScale,
  FinanceValidationError,
  fromMinor,
  getFxRate,
  toMinor,
} from '../src/core/calculations';
import type { Account, FxRate, FinanceData } from '../src/core/types';

describe('Adversarial Challenger M1-1: Triangular FX & Multi-Currency Valuation Stress Testing', () => {
  // Helpers
  const createAccount = (
    id: string,
    currency: string,
    openingBalances?: Record<string, number>,
    extra: Partial<Account> = {}
  ): Account => ({
    id,
    name: `Account ${id}`,
    accountType: 'SAVINGS',
    currency,
    openingBalances,
    openingBalance: openingBalances ? undefined : 0,
    openingDate: '2026-01-01',
    includeInNetWorth: true,
    includeInLiquidNetWorth: true,
    includeInFire: true,
    emergency: false,
    archived: false,
    ...extra,
  });

  const createFx = (
    id: string,
    fromCurrency: string,
    toCurrency: string,
    rate: number,
    asOf: string,
    extra: Partial<FxRate> = {}
  ): FxRate => ({
    id,
    fromCurrency,
    toCurrency,
    rate,
    asOf,
    source: 'Challenger Adversarial Feed',
    ...extra,
  });

  /* ===================================================================================
   * 1. Extreme Rates & Precision Limits (1e-9, 1e9, Cross-Cancellation)
   * =================================================================================== */
  describe('1. Extreme Rates & Precision Limits', () => {
    it('1.1: Handles tiny rate (1e-9) and large rate (1e9) with exact cross-leg product cancellation', () => {
      // Leg 1: BTC -> SAT = 1e8, Leg 2: SAT -> USD = 1e-6 => BTC -> USD = 100
      // Adversarial extreme: ABC -> PIVOT = 1e-9, PIVOT -> XYZ = 1e9 => ABC -> XYZ = 1.0
      const rates: FxRate[] = [
        createFx('r1', 'ABC', 'USD', 1e-9, '2026-06-01T00:00:00Z'),
        createFx('r2', 'USD', 'XYZ', 1e9, '2026-06-01T00:00:00Z'),
      ];

      const resolved = getFxRate('ABC', 'XYZ', rates, '2026-06-01');
      expect(resolved).not.toBeNull();
      expect(resolved!).toBeCloseTo(1.0, 10);

      // Converting 10,000 minor units ABC (100.00 ABC) -> 10,000 minor units XYZ (100.00 XYZ)
      const converted = convertMoney(10000, 'ABC', 'XYZ', rates, '2026-06-01');
      expect(converted).toBe(10000);
    });

    it('1.2: Handles tiny rate product without crashing or subnormal corruption', () => {
      // Rates: FOO -> USD = 1e-5, USD -> BAR = 1e-4 => FOO -> BAR = 1e-9
      const rates: FxRate[] = [
        createFx('r1', 'FOO', 'USD', 1e-5, '2026-06-01T00:00:00Z'),
        createFx('r2', 'USD', 'BAR', 1e-4, '2026-06-01T00:00:00Z'),
      ];

      const rate = getFxRate('FOO', 'BAR', rates, '2026-06-01');
      expect(rate).not.toBeNull();
      expect(rate!).toBeCloseTo(1e-9, 14);

      // Converting 1,000,000 minor units of FOO -> rounds to 0 BAR minor units cleanly
      const converted = convertMoney(1000000, 'FOO', 'BAR', rates, '2026-06-01');
      expect(converted).toBe(0);
    });

    it('1.3: Throws FinanceValidationError if converted amount exceeds MAX_SAFE_INTEGER', () => {
      // Huge rate: ABC -> USD = 1e8, USD -> XYZ = 1e8 => ABC -> XYZ = 1e16
      const rates: FxRate[] = [
        createFx('r1', 'ABC', 'USD', 1e8, '2026-06-01T00:00:00Z'),
        createFx('r2', 'USD', 'XYZ', 1e8, '2026-06-01T00:00:00Z'),
      ];

      const rate = getFxRate('ABC', 'XYZ', rates, '2026-06-01');
      expect(rate).toBe(1e16);

      // Converting 100 minor units (1.00 ABC) * 1e16 = 1e18, exceeding MAX_SAFE_INTEGER (9e15)
      expect(() => convertMoney(100, 'ABC', 'XYZ', rates, '2026-06-01')).toThrow(FinanceValidationError);
    });

    it('1.4: Ignores non-positive and non-finite rates in direct and triangular legs', () => {
      const corruptRates: FxRate[] = [
        createFx('r-zero', 'EUR', 'USD', 0, '2026-06-01T00:00:00Z'),
        createFx('r-neg', 'EUR', 'USD', -1.08, '2026-06-01T00:00:00Z'),
        createFx('r-nan', 'EUR', 'USD', NaN, '2026-06-01T00:00:00Z'),
        createFx('r-inf', 'EUR', 'USD', Infinity, '2026-06-01T00:00:00Z'),
        createFx('r-ninf', 'EUR', 'USD', -Infinity, '2026-06-01T00:00:00Z'),
        createFx('r-valid-leg2', 'USD', 'PHP', 56.0, '2026-06-01T00:00:00Z'),
      ];

      expect(getFxRate('EUR', 'PHP', corruptRates, '2026-06-01')).toBeNull();
      expect(convertMoney(10000, 'EUR', 'PHP', corruptRates, '2026-06-01')).toBeNull();
    });
  });

  /* ===================================================================================
   * 2. Circular Currencies & Complex Topologies
   * =================================================================================== */
  describe('2. Circular Currencies & Complex Topologies', () => {
    it('2.1: Resolves cleanly in a 3-way circular loop (A -> B -> C -> A) without infinite recursion', () => {
      // Loop: AUD -> EUR = 0.6, EUR -> JPY = 160, JPY -> AUD = 0.01041666...
      const rates: FxRate[] = [
        createFx('r-aud-eur', 'AUD', 'EUR', 0.6, '2026-06-01T00:00:00Z'),
        createFx('r-eur-jpy', 'EUR', 'JPY', 160, '2026-06-01T00:00:00Z'),
        createFx('r-jpy-aud', 'JPY', 'AUD', 1 / 96, '2026-06-01T00:00:00Z'),
      ];

      // Route AUD -> JPY via EUR pivot: 0.6 * 160 = 96
      const rateAudJpy = getFxRate('AUD', 'JPY', rates, '2026-06-01');
      expect(rateAudJpy).not.toBeNull();
      expect(rateAudJpy!).toBeCloseTo(96.0, 6);

      // Route JPY -> EUR via AUD pivot: (1/96) * (1/0.6) = 1/96 * 1.6666 = 1/160 = 0.00625
      const rateJpyEur = getFxRate('JPY', 'EUR', rates, '2026-06-01');
      expect(rateJpyEur).not.toBeNull();
      expect(rateJpyEur!).toBeCloseTo(1 / 160, 6);

      // Querying identity currency returns 1 immediately
      expect(getFxRate('AUD', 'AUD', rates, '2026-06-01')).toBe(1);
    });

    it('2.2: Resolves 2-hop routing when opposing quotes exist with different timestamps', () => {
      // Direct CAD -> USD = 0.74 @ t1
      // Inverse USD -> CAD = 1.34 (implies CAD -> USD = 1 / 1.34 = 0.746268) @ t2 (fresher)
      // Destination USD -> PHP = 56.0 @ t3
      const rates: FxRate[] = [
        createFx('cad-usd-old', 'CAD', 'USD', 0.74, '2026-06-01T00:00:00Z'),
        createFx('usd-cad-new', 'USD', 'CAD', 1.34, '2026-06-02T00:00:00Z'),
        createFx('usd-php', 'USD', 'PHP', 56.0, '2026-06-02T00:00:00Z'),
      ];

      // CAD -> PHP via USD pivot should select the fresher leg 1 (usd-cad-new inverse = 1 / 1.34)
      const rateCadPhp = getFxRate('CAD', 'PHP', rates, '2026-06-02');
      expect(rateCadPhp).not.toBeNull();
      expect(rateCadPhp!).toBeCloseTo((1 / 1.34) * 56.0, 4);
    });

    it('2.3: Same timestamp tie-breaking between direct and inverse quotes prefers direct quote', () => {
      const rates: FxRate[] = [
        createFx('direct', 'GBP', 'USD', 1.30, '2026-06-01T12:00:00Z'),
        createFx('inverse', 'USD', 'GBP', 0.76, '2026-06-01T12:00:00Z'), // 1 / 0.76 = 1.31578
      ];

      // When directTime === inverseTime, direct rate (1.30) must be chosen
      expect(getFxRate('GBP', 'USD', rates, '2026-06-01')).toBe(1.30);
    });
  });

  /* ===================================================================================
   * 3. Missing Pivot Legs & Candidate Routing
   * =================================================================================== */
  describe('3. Missing Pivot Legs & Candidate Routing', () => {
    it('3.1: Returns null when Leg 1 exists but Leg 2 is missing', () => {
      const rates: FxRate[] = [
        createFx('r1', 'CHF', 'USD', 1.10, '2026-06-01T00:00:00Z'),
        // No USD -> PHP rate exists!
      ];
      expect(getFxRate('CHF', 'PHP', rates, '2026-06-01')).toBeNull();
    });

    it('3.2: Returns null when Leg 2 exists but Leg 1 is missing', () => {
      const rates: FxRate[] = [
        // No CHF -> USD rate!
        createFx('r2', 'USD', 'PHP', 56.0, '2026-06-01T00:00:00Z'),
      ];
      expect(getFxRate('CHF', 'PHP', rates, '2026-06-01')).toBeNull();
    });

    it('3.3: Ignores pivot where one leg is marked deletedAt and falls back to alternate pivot', () => {
      const rates: FxRate[] = [
        // USD pivot: Leg 2 is deleted!
        createFx('chf-usd', 'CHF', 'USD', 1.10, '2026-06-01T00:00:00Z'),
        createFx('usd-php-del', 'USD', 'PHP', 56.0, '2026-06-01T00:00:00Z', { deletedAt: '2026-06-02T00:00:00Z' }),
        // EUR pivot: Both legs active!
        createFx('chf-eur', 'CHF', 'EUR', 1.05, '2026-06-01T00:00:00Z'),
        createFx('eur-php', 'EUR', 'PHP', 60.0, '2026-06-01T00:00:00Z'),
      ];

      const rate = getFxRate('CHF', 'PHP', rates, '2026-06-05');
      expect(rate).not.toBeNull();
      // Must successfully use EUR pivot: 1.05 * 60.0 = 63.0
      expect(rate!).toBeCloseTo(63.0, 4);
    });

    it('3.4: Selects candidate pivot with freshest effective observation time (min of leg1, leg2)', () => {
      // Pivot 1 (USD): Leg 1 is from May 1, Leg 2 is from Jun 1 => effective time = May 1
      // Pivot 2 (EUR): Leg 1 is from May 20, Leg 2 is from May 25 => effective time = May 20 (fresher than May 1!)
      const rates: FxRate[] = [
        createFx('cad-usd', 'CAD', 'USD', 0.75, '2026-05-01T00:00:00Z'),
        createFx('usd-php', 'USD', 'PHP', 56.0, '2026-06-01T00:00:00Z'),

        createFx('cad-eur', 'CAD', 'EUR', 0.70, '2026-05-20T00:00:00Z'),
        createFx('eur-php', 'EUR', 'PHP', 62.0, '2026-05-25T00:00:00Z'),
      ];

      const rate = getFxRate('CAD', 'PHP', rates, '2026-06-05');
      expect(rate).not.toBeNull();
      // EUR effective time (May 20) is fresher than USD effective time (May 1)
      expect(rate!).toBeCloseTo(0.70 * 62.0, 4);
    });
  });

  /* ===================================================================================
   * 4. Temporal Boundary Conditions (Cutoff, Exact Millisecond, 1ms Post-Cutoff)
   * =================================================================================== */
  describe('4. Temporal Boundary Conditions', () => {
    it('4.1: Rate exactly on cutoff timestamp (23:59:59.999Z) is accepted', () => {
      const rates: FxRate[] = [
        createFx('r-exact-eod', 'USD', 'PHP', 55.5, '2026-07-15T23:59:59.999Z'),
      ];

      expect(getFxRate('USD', 'PHP', rates, '2026-07-15')).toBe(55.5);
    });

    it('4.2: Rate exactly 1ms after cutoff timestamp (00:00:00.000Z next day) is strictly rejected', () => {
      const rates: FxRate[] = [
        createFx('r-past', 'USD', 'PHP', 50.0, '2026-07-14T12:00:00.000Z'),
        createFx('r-1ms-after', 'USD', 'PHP', 60.0, '2026-07-16T00:00:00.000Z'),
      ];

      // Query as of 2026-07-15: cutoff is 2026-07-15T23:59:59.999Z
      // r-1ms-after is at 2026-07-16T00:00:00.000Z (+1ms past cutoff) -> must NOT be used!
      expect(getFxRate('USD', 'PHP', rates, '2026-07-15')).toBe(50.0);
    });

    it('4.3: Triangular routing: if Leg 1 is on cutoff but Leg 2 is 1ms post-cutoff, pivot fails', () => {
      const rates: FxRate[] = [
        createFx('eur-usd', 'EUR', 'USD', 1.08, '2026-07-15T23:59:59.999Z'), // Valid
        createFx('usd-php', 'USD', 'PHP', 56.0, '2026-07-16T00:00:00.000Z'), // 1ms past cutoff
      ];

      expect(getFxRate('EUR', 'PHP', rates, '2026-07-15')).toBeNull();
    });

    it('4.4: Triangular routing: if Leg 1 is 1ms post-cutoff but Leg 2 is on cutoff, pivot fails', () => {
      const rates: FxRate[] = [
        createFx('eur-usd', 'EUR', 'USD', 1.08, '2026-07-16T00:00:00.000Z'), // 1ms past cutoff
        createFx('usd-php', 'USD', 'PHP', 56.0, '2026-07-15T23:59:59.999Z'), // Valid
      ];

      expect(getFxRate('EUR', 'PHP', rates, '2026-07-15')).toBeNull();
    });

    it('4.5: Triangular routing: both legs exactly on cutoff (23:59:59.999Z) succeeds', () => {
      const rates: FxRate[] = [
        createFx('eur-usd', 'EUR', 'USD', 1.08, '2026-07-15T23:59:59.999Z'),
        createFx('usd-php', 'USD', 'PHP', 56.0, '2026-07-15T23:59:59.999Z'),
      ];

      const rate = getFxRate('EUR', 'PHP', rates, '2026-07-15');
      expect(rate).not.toBeNull();
      expect(rate!).toBeCloseTo(1.08 * 56.0, 4);
    });
  });

  /* ===================================================================================
   * 5. Multi-Currency Net Worth Aggregation Stress Testing
   * =================================================================================== */
  describe('5. Multi-Currency Net Worth Aggregation Stress Testing', () => {
    it('5.1: All balances foreign (USD, EUR, JPY) converted to PHP base currency via triangular routes', () => {
      const accUsd = createAccount('acc-usd', 'USD', { USD: 100000 }); // $1,000.00
      const accEur = createAccount('acc-eur', 'EUR', { EUR: 50000 });  // €500.00
      const accJpy = createAccount('acc-jpy', 'JPY', { JPY: 100000 }); // ¥100,000 (0 decimals)

      // Rates:
      // USD -> PHP = 56.0 (direct)
      // EUR -> USD = 1.08 (EUR -> PHP = 1.08 * 56 = 60.48)
      // USD -> JPY = 150.0 (JPY -> PHP = (1 / 150) * 56 = 0.373333...)
      const rates: FxRate[] = [
        createFx('usd-php', 'USD', 'PHP', 56.0, '2026-06-01T00:00:00Z'),
        createFx('eur-usd', 'EUR', 'USD', 1.08, '2026-06-01T00:00:00Z'),
        createFx('usd-jpy', 'USD', 'JPY', 150.0, '2026-06-01T00:00:00Z'),
      ];

      const data: FinanceData = {
        accounts: [accUsd, accEur, accJpy],
        transactions: [],
        instruments: [],
        prices: [],
        fxRates: rates,
      };

      const result = calculateNetWorth(data, 'PHP', '2026-06-01');

      expect(result.complete).toBe(true);
      expect(result.missingFx).toEqual([]);
      expect(result.netWorth).not.toBeNull();

      // Expected values:
      // USD: $1,000 * 56.0 = PHP 56,000.00 = 5,600,000 centavos
      // EUR: €500 * 60.48 = PHP 30,240.00 = 3,024,000 centavos
      // JPY: ¥100,000 * (56 / 150) = PHP 37,333.33 = 3,733,333 centavos
      // Total = 5,600,000 + 3,024,000 + 3,733,333 = 12,357,333 centavos
      expect(result.netWorth).toBe(12357333);
      expect(result.knownNetWorth).toBe(12357333);
    });

    it('5.2: All balances foreign with ONE missing rate: netWorth is null, knownNetWorth preserves convertible balances', () => {
      const accUsd = createAccount('acc-usd', 'USD', { USD: 100000 }); // $1,000.00
      const accEur = createAccount('acc-eur', 'EUR', { EUR: 50000 });  // €500.00
      const accGbp = createAccount('acc-gbp', 'GBP', { GBP: 20000 });  // £200.00 (missing rate!)

      const rates: FxRate[] = [
        createFx('usd-php', 'USD', 'PHP', 56.0, '2026-06-01T00:00:00Z'),
        createFx('eur-usd', 'EUR', 'USD', 1.08, '2026-06-01T00:00:00Z'),
        // No GBP rate anywhere!
      ];

      const data: FinanceData = {
        accounts: [accUsd, accEur, accGbp],
        transactions: [],
        instruments: [],
        prices: [],
        fxRates: rates,
      };

      const result = calculateNetWorth(data, 'PHP', '2026-06-01');

      // Incomplete valuation
      expect(result.netWorth).toBeNull();
      expect(result.complete).toBe(false);

      // Known net worth = USD ($1,000 * 56 = 56,000) + EUR (€500 * 60.48 = 30,240) = 86,240 PHP (8,624,000 centavos)
      expect(result.knownNetWorth).toBe(8624000);
      expect(result.missingFx).toEqual(['GBP']);

      // GBP account has baseValue: null
      const gbpAccVal = result.accountValues.find(a => a.accountId === 'acc-gbp');
      expect(gbpAccVal?.baseValue).toBeNull();
      expect(gbpAccVal?.value).toBe(20000);
    });

    it('5.3: All balances foreign with ALL rates missing: netWorth is null, knownNetWorth is 0, all currencies listed', () => {
      const accUsd = createAccount('acc-usd', 'USD', { USD: 100000 });
      const accEur = createAccount('acc-eur', 'EUR', { EUR: 50000 });

      const data: FinanceData = {
        accounts: [accUsd, accEur],
        transactions: [],
        instruments: [],
        prices: [],
        fxRates: [], // Zero FX rates!
      };

      const result = calculateNetWorth(data, 'PHP', '2026-06-01');

      expect(result.netWorth).toBeNull();
      expect(result.complete).toBe(false);
      expect(result.knownNetWorth).toBe(0);
      expect(result.knownAssets).toBe(0);
      expect(result.missingFx).toEqual(expect.arrayContaining(['USD', 'EUR']));
      expect(result.missingFx).toHaveLength(2);
    });

    it('5.4: Mixed positive foreign asset, overdrawn foreign asset, and foreign credit card liability', () => {
      // Asset 1: USD Savings +$10,000.00
      const accUsdSavings = createAccount('usd-sav', 'USD', { USD: 1000000 });
      // Asset 2: USD Checking with overdraft -$1,000.00 (negative cash balance)
      const accUsdOverdraft = createAccount('usd-chk', 'USD', { USD: -100000 });
      // Liability: USD Credit Card +$4,000.00 (debt)
      const accUsdCard = createAccount('usd-card', 'USD', { USD: 400000 }, {
        accountType: 'CREDIT_CARD',
      });

      const rates: FxRate[] = [
        createFx('usd-php', 'USD', 'PHP', 56.0, '2026-06-01T00:00:00Z'),
      ];

      const data: FinanceData = {
        accounts: [accUsdSavings, accUsdOverdraft, accUsdCard],
        transactions: [],
        instruments: [],
        prices: [],
        fxRates: rates,
      };

      const result = calculateNetWorth(data, 'PHP', '2026-06-01');

      expect(result.complete).toBe(true);
      expect(result.missingFx).toEqual([]);

      // Assets: (+$10,000 - $1,000) = $9,000 @ 56.0 = PHP 504,000.00 (50,400,000 centavos)
      expect(result.assets).toBe(50400000);

      // Liabilities: $4,000 @ 56.0 = PHP 224,000.00 (22,400,000 centavos)
      expect(result.liabilities).toBe(22400000);

      // Net Worth: Assets - Liabilities = 50,400,000 - 22,400,000 = 28,000,000 centavos (PHP 280,000.00)
      expect(result.netWorth).toBe(28000000);
      expect(result.knownNetWorth).toBe(28000000);
    });

    it('5.5: Foreign liability with missing FX rate marks liabilities and netWorth as null', () => {
      const phpSavings = createAccount('php-sav', 'PHP', { PHP: 1000000 }); // PHP 10,000.00
      const usdCard = createAccount('usd-card', 'USD', { USD: 50000 }, {     // USD 500.00 (debt)
        accountType: 'CREDIT_CARD',
      });

      const dataWithoutUsdRate: FinanceData = {
        accounts: [phpSavings, usdCard],
        transactions: [],
        instruments: [],
        prices: [],
        fxRates: [], // No USD FX rate
      };

      const result = calculateNetWorth(dataWithoutUsdRate, 'PHP', '2026-06-01');

      expect(result.netWorth).toBeNull();
      expect(result.liabilities).toBeNull();
      expect(result.complete).toBe(false);

      // Known assets are PHP 10,000.00 (1,000,000 centavos)
      expect(result.knownAssets).toBe(1000000);
      // Known liabilities is 0 because USD card cannot be converted
      expect(result.knownLiabilities).toBe(0);
      expect(result.knownNetWorth).toBe(1000000);
      expect(result.missingFx).toEqual(['USD']);
    });

    it('5.6: Multi-currency account holding foreign cash sub-balances converted via triangular FX', () => {
      // Primary account is PHP, holding PHP 50,000 and EUR 200
      const multiWallet = createAccount('wallet-multi', 'PHP', {
        PHP: 5000000, // PHP 50,000.00
        EUR: 20000,   // EUR 200.00
      });

      // Rates: EUR -> USD = 1.08, USD -> PHP = 56.0 => EUR -> PHP = 60.48
      const rates: FxRate[] = [
        createFx('eur-usd', 'EUR', 'USD', 1.08, '2026-06-01T00:00:00Z'),
        createFx('usd-php', 'USD', 'PHP', 56.0, '2026-06-01T00:00:00Z'),
      ];

      const data: FinanceData = {
        accounts: [multiWallet],
        transactions: [],
        instruments: [],
        prices: [],
        fxRates: rates,
      };

      const result = calculateNetWorth(data, 'PHP', '2026-06-01');

      expect(result.complete).toBe(true);
      expect(result.missingFx).toEqual([]);

      // 50,000 PHP + 200 EUR * 60.48 = 50,000 + 12,096 = 62,096 PHP (6,209,600 centavos)
      expect(result.netWorth).toBe(6209600);
    });
  });
});
