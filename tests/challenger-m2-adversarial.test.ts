import { describe, expect, it } from 'vitest';
import {
  accountBalances,
  buildLedger,
  calculateCashFlow,
  calculateNetWorth,
  calculateNetWorthFromBalances,
  calculatePositions,
  convertMoney,
  currencyScale,
  FinanceValidationError,
  fromMinor,
  getFxRate,
  netWorthHistory,
  postingsForTransaction,
  toMinor,
} from '../src/core/calculations';
import type { Account, FinanceData, FxRate, Transaction } from '../src/core/types';

describe('Challenger M2 Adversarial Verification Suite', () => {
  const AS_OF = '2026-10-09';

  // Helper factory
  function makeAccount(id: string, extra: Partial<Account> = {}): Account {
    return {
      id,
      name: `Account-${id}`,
      accountType: 'SAVINGS',
      currency: 'PHP',
      openingDate: '2026-01-01',
      includeInNetWorth: true,
      includeInLiquidNetWorth: true,
      includeInFire: true,
      emergency: false,
      archived: false,
      ...extra,
    };
  }

  function makeFx(from: string, to: string, rate: number, asOf = '2026-01-01T00:00:00Z', extra: Partial<FxRate> = {}): FxRate {
    return {
      id: `fx-${from}-${to}-${rate}`,
      fromCurrency: from,
      toCurrency: to,
      rate,
      asOf,
      source: 'Adversarial Test Rate',
      ...extra,
    };
  }

  // =========================================================================
  // SECTION 1: High-Precision Rounding Attacks, Fractional Cents & Numeric Boundaries
  // =========================================================================
  describe('1. Arithmetic Precision, Fractional Cents & Boundaries', () => {
    it('prevents fractional cent accumulation by preserving sub-ledger native minor integers', () => {
      // Attack scenario: 10,000 micro-transactions of 1 cent USD ($0.01 = 1 minor unit).
      // If each $0.01 were naively converted to PHP at rate 56.495:
      // $0.01 * 56.495 = 0.56495 PHP -> rounded to 1 centavo (1) or 0.
      // 10,000 * 1 = 10,000 centavos = PHP 100.00 (naive drift!)
      // True portfolio: 10,000 cents = $100.00.
      // Correct converted portfolio: $100.00 * 56.495 = PHP 5,649.50 = 564,950 centavos.
      const acc = makeAccount('usd-wallet', {
        currency: 'USD',
        openingBalances: { USD: 0 },
      });

      // 10,000 micro transactions of $0.01
      const microTxCount = 10000;
      const transactions: Transaction[] = [];
      for (let i = 0; i < microTxCount; i++) {
        transactions.push({
          id: `tx-micro-${i}`,
          type: 'INCOME',
          date: '2026-05-01',
          accountId: 'usd-wallet',
          currency: 'USD',
          amount: 1, // 1 cent
        });
      }

      const rates = [makeFx('USD', 'PHP', 56.495, '2026-01-01T00:00:00Z')];
      const data: FinanceData = {
        accounts: [acc],
        transactions,
        instruments: [],
        prices: [],
        fxRates: rates,
      };

      const ledger = buildLedger([acc], transactions, AS_OF);
      // Native sub-ledger must equal exactly 10,000 cents ($100.00) without any drift
      expect(ledger.balances['usd-wallet'].USD).toBe(10000);

      const netWorth = calculateNetWorth(data, 'PHP', AS_OF);
      // Valuation of $100.00 @ 56.495 must equal exactly 564,950 centavos (PHP 5,649.50)
      expect(netWorth.netWorth).toBe(564950);
      expect(netWorth.complete).toBe(true);
    });

    it('handles asymmetric currency decimal scales (JPY=0, PHP=2, KWD=3, BTC=8)', () => {
      expect(currencyScale('JPY')).toBe(1);
      expect(currencyScale('USD')).toBe(100);
      expect(currencyScale('KWD')).toBe(1000);
      expect(currencyScale('BTC', { BTC: 8 })).toBe(100000000);

      // JPY to PHP: 10,000 JPY @ rate 0.3805 PHP/JPY -> 3,805.00 PHP = 380,500 centavos
      const jpyToPhpRate = makeFx('JPY', 'PHP', 0.3805);
      expect(convertMoney(10000, 'JPY', 'PHP', [jpyToPhpRate], AS_OF)).toBe(380500);

      // KWD to PHP: 50.125 KWD (50125 minor units) @ rate 182.4 PHP/KWD
      // 50.125 * 182.4 = 9,142.8 PHP = 914,280 centavos
      const kwdToPhpRate = makeFx('KWD', 'PHP', 182.4);
      expect(convertMoney(50125, 'KWD', 'PHP', [kwdToPhpRate], AS_OF)).toBe(914280);

      // JPY to KWD: 1,000,000 JPY @ rate 0.002086 KWD/JPY
      // 1,000,000 * 0.002086 = 2,086 KWD = 2,086,000 fils
      const jpyToKwdRate = makeFx('JPY', 'KWD', 0.002086);
      expect(convertMoney(1000000, 'JPY', 'KWD', [jpyToKwdRate], AS_OF)).toBe(2086000);
    });

    it('enforces half-cent epsilon-protected rounding symmetry for positive and negative amounts', () => {
      // Positive half-cent rounding
      expect(toMinor(1.005, 'PHP')).toBe(101);
      expect(toMinor(1.004999, 'PHP')).toBe(100);
      expect(toMinor(0.005, 'USD')).toBe(1);

      // Negative half-cent symmetric rounding (rounds away from zero)
      expect(toMinor(-1.005, 'PHP')).toBe(-101);
      expect(toMinor(-1.004999, 'PHP')).toBe(-100);
      expect(toMinor(-0.005, 'USD')).toBe(-1);

      // fromMinor exactness
      expect(fromMinor(101, 'PHP')).toBe(1.01);
      expect(fromMinor(-101, 'PHP')).toBe(-1.01);
    });

    it('strictly throws FinanceValidationError at safe integer boundaries instead of silently corrupting', () => {
      // Rejects values exceeding Number.MAX_SAFE_INTEGER
      expect(() => toMinor(Number.MAX_SAFE_INTEGER, 'PHP')).toThrow(FinanceValidationError);
      expect(() => toMinor(Infinity, 'PHP')).toThrow(FinanceValidationError);
      expect(() => toMinor(-Infinity, 'PHP')).toThrow(FinanceValidationError);
      expect(() => toMinor(NaN, 'PHP')).toThrow(FinanceValidationError);

      // Rejects non-integer minor values in fromMinor
      expect(() => fromMinor(1.5, 'PHP')).toThrow(FinanceValidationError);
      expect(() => fromMinor(NaN, 'PHP')).toThrow(FinanceValidationError);

      // Overflow in convertMoney: large minor unit * FX rate exceeding MAX_SAFE_INTEGER
      const extremeAcc = makeAccount('extreme', {
        currency: 'USD',
        openingBalances: { USD: 9000000000000000 }, // 9 * 10^15 minor units
      });
      const highRate = makeFx('USD', 'PHP', 100); // 9*10^15 * 100 = 9*10^17 > MAX_SAFE_INTEGER
      const extremeData: FinanceData = {
        accounts: [extremeAcc],
        transactions: [],
        instruments: [],
        prices: [],
        fxRates: [highRate],
      };
      expect(() => calculateNetWorth(extremeData, 'PHP', AS_OF)).toThrow(FinanceValidationError);
    });

    it('handles negative overdraft and liability balances with proper algebraic netting', () => {
      const overdraftAcc = makeAccount('overdraft-acc', {
        currency: 'PHP',
        openingBalances: { PHP: 0 },
      });
      const creditCard = makeAccount('credit-card', {
        accountType: 'CREDIT_CARD',
        currency: 'USD',
        openingBalances: { USD: 10000 }, // $100 owed
      });

      // Overdraft transaction: spend PHP 50,000 from empty account via BALANCE_ADJUSTMENT
      const adjustTx: Transaction = {
        id: 'adjust-overdraft',
        type: 'BALANCE_ADJUSTMENT',
        date: '2026-02-01',
        accountId: 'overdraft-acc',
        currency: 'PHP',
        amount: -50000, // -500.00 PHP
      };

      const fxRate = makeFx('USD', 'PHP', 56);
      const data: FinanceData = {
        accounts: [overdraftAcc, creditCard],
        transactions: [adjustTx],
        instruments: [],
        prices: [],
        fxRates: [fxRate],
      };

      const summary = calculateNetWorth(data, 'PHP', AS_OF);
      // Assets: -500.00 PHP (-50,000 centavos)
      // Liabilities: $100.00 @ 56 = PHP 5,600.00 (560,000 centavos)
      // Net Worth: -50,000 - 560,000 = -610,000 centavos (-PHP 6,100.00)
      expect(summary.assets).toBe(-50000);
      expect(summary.liabilities).toBe(560000);
      expect(summary.netWorth).toBe(-610000);
      expect(summary.complete).toBe(true);
    });
  });

  // =========================================================================
  // SECTION 2: Complex Multi-Currency Portfolios (PHP, USD, EUR, JPY, GBP)
  // =========================================================================
  describe('2. Multi-Currency Portfolios & Dated FX Valuation Engine', () => {
    it('consolidates a 5-currency portfolio (PHP, USD, EUR, JPY, GBP) with mixed dated FX rates', () => {
      const multiWallet = makeAccount('multi-5', {
        currency: 'PHP',
        openingBalances: {
          PHP: 1000000, // PHP 10,000.00 = 1,000,000
          USD: 10000,   // USD 100.00 @ 56.00 = PHP 5,600.00 (560,000)
          EUR: 5000,    // EUR 50.00 @ 60.00 = PHP 3,000.00 (300,000)
          JPY: 100000,  // JPY 100,000 @ 0.38 = PHP 38,000.00 (3,800,000)
          GBP: 2000,    // GBP 20.00 @ 70.00 = PHP 1,400.00 (140,000)
        },
      });

      // FX rates with various dates
      const rates: FxRate[] = [
        // USD: older rate 55, newer rate 56 on 2026-10-01, future rate 99 on 2026-10-15
        makeFx('USD', 'PHP', 55, '2026-01-01T00:00:00Z'),
        makeFx('USD', 'PHP', 56, '2026-10-01T00:00:00Z'),
        makeFx('USD', 'PHP', 99, '2026-10-15T00:00:00Z'), // Future! Must be ignored for AS_OF 2026-10-09

        // EUR: inverse rate (PHP -> EUR = 1/60 = 0.016666666666666666)
        makeFx('PHP', 'EUR', 1 / 60, '2026-10-05T00:00:00Z'),

        // JPY: direct rate 0.38
        makeFx('JPY', 'PHP', 0.38, '2026-10-08T00:00:00Z'),

        // GBP: direct rate 70
        makeFx('GBP', 'PHP', 70, '2026-10-07T00:00:00Z'),
      ];

      const data: FinanceData = {
        accounts: [multiWallet],
        transactions: [],
        instruments: [],
        prices: [],
        fxRates: rates,
      };

      const summary = calculateNetWorth(data, 'PHP', AS_OF);

      // Converted total:
      // PHP: 1,000,000
      // USD: 100 * 56 = 560,000
      // EUR: 50 * 60 = 300,000
      // JPY: 100,000 * 0.38 = 3,800,000
      // GBP: 20 * 70 = 140,000
      // Total = 1,000,000 + 560,000 + 300,000 + 3,800,000 + 140,000 = 5,800,000 centavos (PHP 58,000.00)
      expect(summary.netWorth).toBe(5800000);
      expect(summary.assets).toBe(5800000);
      expect(summary.complete).toBe(true);
      expect(summary.issues).toEqual([]);

      // Verify sub-ledger integrity in accountValues
      const accVal = summary.accountValues[0];
      expect(accVal.cashBalances).toEqual({
        PHP: 1000000,
        USD: 10000,
        EUR: 5000,
        JPY: 100000,
        GBP: 2000,
      });
      expect(accVal.balance).toBe(5800000);
    });

    it('strictly isolates unconvertible balances when FX rates are missing (no 1:1, no collapse to 0)', () => {
      const multiWallet = makeAccount('multi-5', {
        currency: 'PHP',
        openingBalances: {
          PHP: 1000000, // PHP 10,000.00 (1,000,000)
          USD: 10000,   // USD 100.00 @ 56 = PHP 5,600.00 (560,000)
          EUR: 5000,    // EUR 50.00 (Missing FX!)
          JPY: 100000,  // JPY 100,000 @ 0.38 = PHP 38,000.00 (3,800,000)
          GBP: 2000,    // GBP 20.00 (Missing FX!)
        },
      });

      // Provide FX rates only for USD and JPY; EUR and GBP are missing
      const partialRates: FxRate[] = [
        makeFx('USD', 'PHP', 56, '2026-10-01T00:00:00Z'),
        makeFx('JPY', 'PHP', 0.38, '2026-10-01T00:00:00Z'),
      ];

      const data: FinanceData = {
        accounts: [multiWallet],
        transactions: [],
        instruments: [],
        prices: [],
        fxRates: partialRates,
      };

      const summary = calculateNetWorth(data, 'PHP', AS_OF);

      // Incomplete state
      expect(summary.netWorth).toBeNull();
      expect(summary.assets).toBeNull();
      expect(summary.complete).toBe(false);

      // Known assets must include ONLY convertible: PHP (1,000,000) + USD (560,000) + JPY (3,800,000) = 5,360,000
      expect(summary.knownNetWorth).toBe(5360000);
      expect(summary.knownAssets).toBe(5360000);

      // Missing FX issues registered for both EUR and GBP
      expect(summary.issues).toHaveLength(2);
      expect(summary.issues).toContainEqual({
        code: 'missing_fx',
        accountId: 'multi-5',
        currency: 'EUR',
      });
      expect(summary.issues).toContainEqual({
        code: 'missing_fx',
        accountId: 'multi-5',
        currency: 'GBP',
      });
    });

    it('does not flag missing FX for foreign currencies holding exactly zero balance', () => {
      const acc = makeAccount('zero-foreign', {
        currency: 'PHP',
        openingBalances: {
          PHP: 500000, // PHP 5,000.00
          USD: 0,      // $0.00 (No FX provided!)
          EUR: 0,      // €0.00 (No FX provided!)
        },
      });

      const data: FinanceData = {
        accounts: [acc],
        transactions: [],
        instruments: [],
        prices: [],
        fxRates: [], // Zero rates
      };

      const summary = calculateNetWorth(data, 'PHP', AS_OF);
      expect(summary.complete).toBe(true);
      expect(summary.netWorth).toBe(500000);
      expect(summary.issues).toEqual([]);
    });

    it('resolves direct and inverse rate timestamps with correct chronological precedence', () => {
      // Case 1: Direct rate is newer than inverse rate -> choose direct
      const rates1 = [
        makeFx('USD', 'PHP', 50, '2026-01-01T00:00:00Z'),
        makeFx('PHP', 'USD', 1 / 55, '2026-01-02T00:00:00Z'),
        makeFx('USD', 'PHP', 56, '2026-01-03T00:00:00Z'), // Direct is newest
      ];
      expect(getFxRate('USD', 'PHP', rates1, AS_OF)).toBe(56);

      // Case 2: Inverse rate is newer than direct rate -> choose inverse
      const rates2 = [
        makeFx('USD', 'PHP', 50, '2026-01-01T00:00:00Z'),
        makeFx('PHP', 'USD', 1 / 58, '2026-01-05T00:00:00Z'), // Inverse is newest
      ];
      expect(getFxRate('USD', 'PHP', rates2, AS_OF)).toBe(58);

      // Case 3: Same timestamp -> prefers direct
      const rates3 = [
        makeFx('USD', 'PHP', 56, '2026-01-01T00:00:00Z'),
        makeFx('PHP', 'USD', 1 / 57, '2026-01-01T00:00:00Z'),
      ];
      expect(getFxRate('USD', 'PHP', rates3, AS_OF)).toBe(56);

      // Case 4: Deleted or non-positive rates are ignored
      const rates4 = [
        makeFx('USD', 'PHP', 60, '2026-01-05T00:00:00Z', { deletedAt: '2026-01-06T00:00:00Z' }),
        makeFx('USD', 'PHP', -5, '2026-01-05T00:00:00Z'),
        makeFx('USD', 'PHP', 56, '2026-01-01T00:00:00Z'),
      ];
      expect(getFxRate('USD', 'PHP', rates4, AS_OF)).toBe(56);
    });

    it('supports chained cross-currency transfers and maintains zero cash flow consumption', () => {
      const phpAcc = makeAccount('acc-php', { currency: 'PHP', openingBalances: { PHP: 10000000 } }); // 100k PHP
      const usdAcc = makeAccount('acc-usd', { currency: 'USD', openingBalances: { USD: 0 } });
      const eurAcc = makeAccount('acc-eur', { currency: 'EUR', openingBalances: { EUR: 0 } });

      // Transfer 1: PHP -> USD ($1,000 received for PHP 56,000)
      const tx1: Transaction = {
        id: 'xfer-php-usd',
        type: 'TRANSFER',
        date: '2026-02-01',
        accountId: 'acc-php',
        currency: 'PHP',
        amount: 5600000,
        transferAccountId: 'acc-usd',
        transferCurrency: 'USD',
        transferAmount: 100000,
      };

      // Transfer 2: USD -> EUR (€800 received for $900)
      const tx2: Transaction = {
        id: 'xfer-usd-eur',
        type: 'TRANSFER',
        date: '2026-02-02',
        accountId: 'acc-usd',
        currency: 'USD',
        amount: 90000,
        transferAccountId: 'acc-eur',
        transferCurrency: 'EUR',
        transferAmount: 80000,
      };

      const accounts = [phpAcc, usdAcc, eurAcc];
      const transactions = [tx1, tx2];

      const ledger = buildLedger(accounts, transactions, AS_OF);
      expect(ledger.balances['acc-php'].PHP).toBe(4400000); // 100,000 - 56,000 = 44,000 PHP
      expect(ledger.balances['acc-usd'].USD).toBe(10000);   // 1,000 - 900 = 100 USD
      expect(ledger.balances['acc-eur'].EUR).toBe(80000);   // 800 EUR

      const fxRates = [
        makeFx('USD', 'PHP', 56),
        makeFx('EUR', 'PHP', 60),
      ];

      const flow = calculateCashFlow(transactions, accounts, {
        from: '2026-01-01',
        to: AS_OF,
        currency: 'PHP',
        fxRates,
      });

      // Transfer zero-consumption invariant
      expect(flow.income).toBe(0);
      expect(flow.expenses).toBe(0);
      expect(flow.net).toBe(0);
      expect(flow.complete).toBe(true);
    });
  });

  // =========================================================================
  // SECTION 3: Prototype Pollution & Reserved Account ID Stress Testing
  // =========================================================================
  describe('3. Prototype Pollution & Reserved Identifiers Stress Testing', () => {
    const RESERVED_KEYS = ['__proto__', 'toString', 'valueOf', 'constructor', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable'];

    it('safely handles reserved object keys as account IDs without polluting Object.prototype', () => {
      const accounts = RESERVED_KEYS.map((key, index) =>
        makeAccount(key, {
          name: `Reserved Account ${key}`,
          openingBalances: { PHP: (index + 1) * 10000 },
        })
      );

      // Create transactions between reserved accounts
      const transactions: Transaction[] = [
        {
          id: 'tx-proto-to-tostring',
          type: 'TRANSFER',
          date: '2026-03-01',
          accountId: '__proto__',
          currency: 'PHP',
          amount: 5000,
          transferAccountId: 'toString',
        },
        {
          id: 'tx-constructor-income',
          type: 'INCOME',
          date: '2026-03-02',
          accountId: 'constructor',
          currency: 'PHP',
          amount: 2000,
        },
      ];

      const ledger = buildLedger(accounts, transactions, AS_OF);

      // Verify each reserved account has correct balances in ledger
      expect(ledger.balances['__proto__'].PHP).toBe(5000); // 10,000 - 5,000
      expect(ledger.balances['toString'].PHP).toBe(25000); // 20,000 + 5,000
      expect(ledger.balances['valueOf'].PHP).toBe(30000);  // 30,000
      expect(ledger.balances['constructor'].PHP).toBe(42000); // 40,000 + 2,000

      // Calculate net worth
      const data: FinanceData = {
        accounts,
        transactions,
        instruments: [],
        prices: [],
        fxRates: [],
      };

      const summary = calculateNetWorth(data, 'PHP', AS_OF);
      expect(summary.complete).toBe(true);
      expect(summary.netWorth).toBe(
        5000 + 25000 + 30000 + 42000 + 50000 + 60000 + 70000
      );

      // CRITICAL SECURITY ASSERTION: Object.prototype must remain unpolluted!
      expect(({} as any).polluted).toBeUndefined();
      expect(({} as any).PHP).toBeUndefined();
      expect(({} as any)['__proto__']).toBe(Object.prototype);
      expect(Object.prototype.toString).toBe(Function.prototype.toString.call(Object.prototype.toString) ? Object.prototype.toString : Object.prototype.toString);
      expect(typeof ({}).toString).toBe('function');
      expect(typeof ({}).valueOf).toBe('function');
      expect(({}).constructor).toBe(Object);
    });

    it('safely handles reserved category IDs in cash flow calculations', () => {
      const acc = makeAccount('cash-acc', { openingBalances: { PHP: 100000 } });
      const transactions: Transaction[] = RESERVED_KEYS.map((key, index) => ({
        id: `tx-cat-${key}`,
        type: 'EXPENSE',
        date: '2026-04-01',
        accountId: 'cash-acc',
        currency: 'PHP',
        amount: (index + 1) * 1000,
        categoryId: key,
      }));

      const flow = calculateCashFlow(transactions, [acc], {
        from: '2026-01-01',
        to: AS_OF,
        currency: 'PHP',
      });

      expect(flow.complete).toBe(true);
      expect(flow.expenses).toBe(1000 + 2000 + 3000 + 4000 + 5000 + 6000 + 7000);

      // byCategory uses Object.create(null)
      expect(flow.byCategory['__proto__']).toBe(1000);
      expect(flow.byCategory['toString']).toBe(2000);
      expect(flow.byCategory['valueOf']).toBe(3000);
      expect(flow.byCategory['constructor']).toBe(4000);

      // Ensure Object.prototype is unpolluted
      expect(({} as any)['__proto__']).toBe(Object.prototype);
      expect(({} as any)['constructor']).toBe(Object);
    });

    it('safely rejects plain object balances missing required accounts when using calculateNetWorthFromBalances', () => {
      const acc1 = makeAccount('acc-1');
      const acc2 = makeAccount('acc-2');
      const accounts = [acc1, acc2];

      // External plain object with only acc1 provided
      const partialBalances = {
        'acc-1': { PHP: 1000 },
      };

      // Calling calculateNetWorthFromBalances with missing acc2 must throw validation error
      expect(() =>
        calculateNetWorthFromBalances(accounts, partialBalances, [], [], { baseCurrency: 'PHP' }, AS_OF)
      ).toThrow(/Every account requires a calculated balance/);
    });
  });

  // =========================================================================
  // SECTION 4: Historical Time-Series & Leakage Verification
  // =========================================================================
  describe('4. Historical Trajectory & Leakage Safeguards', () => {
    it('evaluates historical dates with strict point-in-time FX isolation (no future FX leakage)', () => {
      const acc = makeAccount('usd-vault', {
        currency: 'USD',
        openingDate: '2026-01-01',
        openingBalances: { USD: 10000 }, // $100.00
      });

      const rates: FxRate[] = [
        makeFx('USD', 'PHP', 50, '2026-01-01T00:00:00Z'),
        makeFx('USD', 'PHP', 55, '2026-05-01T00:00:00Z'),
        makeFx('USD', 'PHP', 60, '2026-09-01T00:00:00Z'),
      ];

      const data: FinanceData = {
        accounts: [acc],
        transactions: [],
        instruments: [],
        prices: [],
        fxRates: rates,
      };

      const history = netWorthHistory(data, 'PHP', [
        '2026-01-15', // Should use rate 50 -> PHP 5,000 (500,000)
        '2026-06-01', // Should use rate 55 -> PHP 5,500 (550,000)
        '2026-09-15', // Should use rate 60 -> PHP 6,000 (600,000)
      ]);

      expect(history).toHaveLength(3);
      expect(history[0].date).toBe('2026-01-15');
      expect(history[0].netWorth).toBe(500000);

      expect(history[1].date).toBe('2026-06-01');
      expect(history[1].netWorth).toBe(550000);

      expect(history[2].date).toBe('2026-09-15');
      expect(history[2].netWorth).toBe(600000);
    });

    it('correctly tracks completeness when FX rates appear only on later historical dates', () => {
      const acc = makeAccount('usd-vault', {
        currency: 'USD',
        openingDate: '2026-01-01',
        openingBalances: { USD: 10000 },
      });

      // FX rate first appears on 2026-06-01
      const rates: FxRate[] = [
        makeFx('USD', 'PHP', 55, '2026-06-01T00:00:00Z'),
      ];

      const data: FinanceData = {
        accounts: [acc],
        transactions: [],
        instruments: [],
        prices: [],
        fxRates: rates,
      };

      const history = netWorthHistory(data, 'PHP', [
        '2026-03-01', // Missing FX -> incomplete!
        '2026-07-01', // FX present -> complete!
      ]);

      expect(history[0].date).toBe('2026-03-01');
      expect(history[0].netWorth).toBeNull();
      expect(history[0].complete).toBe(false);
      expect(history[0].knownNetWorth).toBe(0);

      expect(history[1].date).toBe('2026-07-01');
      expect(history[1].netWorth).toBe(550000);
      expect(history[1].complete).toBe(true);
    });
  });
});
