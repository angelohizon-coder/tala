import { describe, expect, it } from 'vitest';
import {
  accountBalances,
  buildLedger,
  calculateCashFlow,
  calculateNetWorth,
  calculateNetWorthFromBalances,
  convertMoney,
  currencyScale,
  FinanceValidationError,
  getFxRate,
  netWorthHistory,
  postingsForTransaction,
  toMinor,
  fromMinor,
} from '../src/core/calculations';
import type { Account, FxRate, Transaction, FinanceData } from '../src/core/types';

describe('Challenger Adversarial Stress Tests: Financial Integrity & Multi-Currency', () => {
  // Helpers
  const createAccount = (id: string, currency: string, openingBalances?: Record<string, number>, extra: Partial<Account> = {}): Account => ({
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

  const createFx = (id: string, fromCurrency: string, toCurrency: string, rate: number, asOf: string, extra: Partial<FxRate> = {}): FxRate => ({
    id,
    fromCurrency,
    toCurrency,
    rate,
    asOf,
    source: 'Adversarial Test Exchange',
    ...extra,
  });

  /* ===================================================================================
   * 1. Multi-Leg Transfers & Zero-Net-Flow Invariants
   * =================================================================================== */
  describe('1. Multi-Leg Transfers & Zero-Net-Flow Invariants', () => {
    it('1.1: 3-leg transfer chain across 3 currencies produces strictly zero cash flow income or expense', () => {
      // PHP -> USD -> EUR
      const accPhp = createAccount('acc-php', 'PHP', { PHP: 10000000 }); // PHP 100,000.00
      const accUsd = createAccount('acc-usd', 'USD', { USD: 0 });
      const accEur = createAccount('acc-eur', 'EUR', { EUR: 0 });

      const txLeg1: Transaction = {
        id: 'leg-1-php-usd',
        type: 'TRANSFER',
        date: '2026-05-10',
        accountId: 'acc-php',
        currency: 'PHP',
        amount: 5600000, // PHP 56,000.00
        transferAccountId: 'acc-usd',
        transferCurrency: 'USD',
        transferAmount: 100000, // USD 1,000.00
      };

      const txLeg2: Transaction = {
        id: 'leg-2-usd-eur',
        type: 'TRANSFER',
        date: '2026-05-11',
        accountId: 'acc-usd',
        currency: 'USD',
        amount: 100000, // USD 1,000.00
        transferAccountId: 'acc-eur',
        transferCurrency: 'EUR',
        transferAmount: 90000, // EUR 900.00
      };

      const accounts = [accPhp, accUsd, accEur];
      const transactions = [txLeg1, txLeg2];

      const flow = calculateCashFlow(transactions, accounts, {
        from: '2026-05-01',
        to: '2026-05-31',
        currency: 'PHP',
      });

      expect(flow.income).toBe(0);
      expect(flow.expenses).toBe(0);
      expect(flow.net).toBe(0);
      expect(flow.complete).toBe(true);

      const ledger = buildLedger(accounts, transactions, '2026-05-31');
      expect(ledger.balances['acc-php']).toEqual({ PHP: 4400000 }); // 100,000 - 56,000 = 44,000 PHP
      expect(ledger.balances['acc-usd']).toEqual({ USD: 0 });       // 0 + 1,000 - 1,000 = 0 USD
      expect(ledger.balances['acc-eur']).toEqual({ EUR: 90000 });   // 0 + 900 = 900 EUR
    });

    it('1.2: Circular transfer loop (A -> B -> C -> A) generates zero income and zero expenses', () => {
      // Account A (PHP) -> Account B (USD) -> Account C (EUR) -> Account A (PHP)
      const accA = createAccount('acc-a', 'PHP', { PHP: 20000000 }); // PHP 200,000.00
      const accB = createAccount('acc-b', 'USD', { USD: 0 });
      const accC = createAccount('acc-c', 'EUR', { EUR: 0 });

      const tx1: Transaction = {
        id: 'cycle-1',
        type: 'TRANSFER',
        date: '2026-06-01',
        accountId: 'acc-a',
        currency: 'PHP',
        amount: 5600000, // 56,000 PHP
        transferAccountId: 'acc-b',
        transferCurrency: 'USD',
        transferAmount: 100000, // 1,000 USD
      };

      const tx2: Transaction = {
        id: 'cycle-2',
        type: 'TRANSFER',
        date: '2026-06-02',
        accountId: 'acc-b',
        currency: 'USD',
        amount: 100000, // 1,000 USD
        transferAccountId: 'acc-c',
        transferCurrency: 'EUR',
        transferAmount: 92000, // 920 EUR
      };

      const tx3: Transaction = {
        id: 'cycle-3',
        type: 'TRANSFER',
        date: '2026-06-03',
        accountId: 'acc-c',
        currency: 'EUR',
        amount: 92000, // 920 EUR
        transferAccountId: 'acc-a',
        transferCurrency: 'PHP',
        transferAmount: 5520000, // 55,200 PHP returned (e.g. after exchange slippage)
      };

      const accounts = [accA, accB, accC];
      const transactions = [tx1, tx2, tx3];

      const flow = calculateCashFlow(transactions, accounts, {
        from: '2026-06-01',
        to: '2026-06-10',
        currency: 'PHP',
      });

      // Crucial invariant: cash flow must NOT fabricate income or expenses from currency conversion spread
      expect(flow.income).toBe(0);
      expect(flow.expenses).toBe(0);
      expect(flow.net).toBe(0);
      expect(flow.complete).toBe(true);

      const ledger = buildLedger(accounts, transactions, '2026-06-10');
      // Acc A: 200,000 - 56,000 + 55,200 = 199,200 PHP
      expect(ledger.balances['acc-a']).toEqual({ PHP: 19920000 });
      expect(ledger.balances['acc-b']).toEqual({ USD: 0 });
      expect(ledger.balances['acc-c']).toEqual({ EUR: 0 });
    });

    it('1.3: 50-leg rapid alternating transfer stress test yields strictly zero cash flow', () => {
      const accPhp = createAccount('wallet-php', 'PHP', { PHP: 100000000 });
      const accUsd = createAccount('wallet-usd', 'USD', { USD: 0 });

      const txs: Transaction[] = [];
      for (let i = 0; i < 50; i++) {
        const fromPhp = i % 2 === 0;
        const day = String(1 + Math.floor(i / 2)).padStart(2, '0');
        txs.push({
          id: `stress-tx-${i}`,
          type: 'TRANSFER',
          date: `2026-07-${day}`,
          accountId: fromPhp ? 'wallet-php' : 'wallet-usd',
          currency: fromPhp ? 'PHP' : 'USD',
          amount: fromPhp ? 560000 : 10000, // 5,600 PHP or 100 USD
          transferAccountId: fromPhp ? 'wallet-usd' : 'wallet-php',
          transferCurrency: fromPhp ? 'USD' : 'PHP',
          transferAmount: fromPhp ? 10000 : 560000,
        });
      }

      const flow = calculateCashFlow(txs, [accPhp, accUsd], {
        from: '2026-07-01',
        to: '2026-07-31',
        currency: 'PHP',
      });

      expect(flow.income).toBe(0);
      expect(flow.expenses).toBe(0);
      expect(flow.net).toBe(0);
      expect(flow.complete).toBe(true);
    });

    it('1.4: Transfers interleaved with real income and expenses do not corrupt cash flow figures', () => {
      const acc = createAccount('main-checking', 'PHP', { PHP: 5000000 });
      const foreignAcc = createAccount('usd-savings', 'USD', { USD: 0 });

      const txs: Transaction[] = [
        { id: 'inc-1', type: 'INCOME', date: '2026-08-01', accountId: 'main-checking', currency: 'PHP', amount: 8000000 }, // +80,000 PHP
        { id: 'tx-1', type: 'TRANSFER', date: '2026-08-02', accountId: 'main-checking', currency: 'PHP', amount: 2000000, transferAccountId: 'usd-savings', transferCurrency: 'USD', transferAmount: 35000 },
        { id: 'exp-1', type: 'EXPENSE', date: '2026-08-03', accountId: 'main-checking', currency: 'PHP', amount: 1500000 }, // -15,000 PHP
        { id: 'tx-2', type: 'TRANSFER', date: '2026-08-04', accountId: 'usd-savings', currency: 'USD', amount: 10000, transferAccountId: 'main-checking', transferCurrency: 'PHP', transferAmount: 560000 },
        { id: 'exp-2', type: 'EXPENSE', date: '2026-08-05', accountId: 'main-checking', currency: 'PHP', amount: 500000 },  // -5,000 PHP
      ];

      const flow = calculateCashFlow(txs, [acc, foreignAcc], {
        from: '2026-08-01',
        to: '2026-08-10',
        currency: 'PHP',
      });

      expect(flow.income).toBe(8000000);  // Exactly the 80,000 PHP income
      expect(flow.expenses).toBe(2000000); // 15,000 + 5,000 = 20,000 PHP expenses
      expect(flow.net).toBe(6000000);      // 80,000 - 20,000 = 60,000 PHP
      expect(flow.complete).toBe(true);
    });
  });

  /* ===================================================================================
   * 2. Explicit Transfer Fees & Separation Invariant
   * =================================================================================== */
  describe('2. Explicit Transfer Fees & Separation Invariant', () => {
    it('2.1: Transfer with linked separate FEE transaction correctly isolates fee as expense', () => {
      const source = createAccount('bdo-php', 'PHP', { PHP: 10000000 });
      const dest = createAccount('revolut-usd', 'USD', { USD: 0 });

      // Cross-currency transfer
      const transferTx: Transaction = {
        id: 'wire-1',
        type: 'TRANSFER',
        date: '2026-09-01',
        accountId: 'bdo-php',
        currency: 'PHP',
        amount: 5600000, // PHP 56,000.00
        transferAccountId: 'revolut-usd',
        transferCurrency: 'USD',
        transferAmount: 100000, // USD 1,000.00
      };

      // Explicit separate transfer fee
      const feeTx: Transaction = {
        id: 'wire-fee-1',
        type: 'FEE',
        date: '2026-09-01',
        accountId: 'bdo-php',
        currency: 'PHP',
        amount: 25000, // PHP 250.00 fee
      };

      const accounts = [source, dest];
      const transactions = [transferTx, feeTx];

      const flow = calculateCashFlow(transactions, accounts, {
        from: '2026-09-01',
        to: '2026-09-02',
        currency: 'PHP',
      });

      // Income must be 0, expenses must equal exactly the fee
      expect(flow.income).toBe(0);
      expect(flow.expenses).toBe(25000);
      expect(flow.net).toBe(-25000);
      expect(flow.complete).toBe(true);

      const ledger = buildLedger(accounts, transactions, '2026-09-02');
      // Source balance: 100,000 - 56,000 - 250 = 43,750 PHP
      expect(ledger.balances['bdo-php']).toEqual({ PHP: 4375000 });
      // Destination balance: +1,000 USD
      expect(ledger.balances['revolut-usd']).toEqual({ USD: 100000 });
    });

    it('2.2: Directly assigning fees to TRANSFER transactions is rejected with FinanceValidationError', () => {
      const source = createAccount('bdo-php', 'PHP', { PHP: 10000000 });
      const dest = createAccount('revolut-usd', 'USD', { USD: 0 });

      const invalidTransferWithFee: Transaction = {
        id: 'wire-bad',
        type: 'TRANSFER',
        date: '2026-09-01',
        accountId: 'bdo-php',
        currency: 'PHP',
        amount: 5600000,
        transferAccountId: 'revolut-usd',
        transferCurrency: 'USD',
        transferAmount: 100000,
        fees: 25000, // Explicit fees attached to TRANSFER directly
      };

      expect(() => {
        postingsForTransaction(invalidTransferWithFee, [source, dest]);
      }).toThrow(/Record other fees as a separate fee transaction/);
    });

    it('2.3: Foreign currency fee on cross-currency transfer correctly converts into base currency cash flow', () => {
      const source = createAccount('source-php', 'PHP', { PHP: 10000000 });
      const dest = createAccount('dest-usd', 'USD', { USD: 0 });

      const fxRate = createFx('fx-usd-php', 'USD', 'PHP', 56, '2026-01-01');

      const transferTx: Transaction = {
        id: 'xfer-foreign',
        type: 'TRANSFER',
        date: '2026-09-05',
        accountId: 'source-php',
        currency: 'PHP',
        amount: 5600000, // PHP 56,000.00
        transferAccountId: 'dest-usd',
        transferCurrency: 'USD',
        transferAmount: 100000, // USD 1,000.00
      };

      // USD 5.00 intermediary wire fee paid in USD
      const foreignFeeTx: Transaction = {
        id: 'wire-fee-usd',
        type: 'FEE',
        date: '2026-09-05',
        accountId: 'dest-usd',
        currency: 'USD',
        amount: 500, // USD 5.00 = 500 cents
      };

      const flow = calculateCashFlow([transferTx, foreignFeeTx], [source, dest], {
        from: '2026-09-01',
        to: '2026-09-10',
        currency: 'PHP',
        fxRates: [fxRate],
      });

      // USD 5.00 * 56 = PHP 280.00 = 28,000 centavos
      expect(flow.income).toBe(0);
      expect(flow.expenses).toBe(28000);
      expect(flow.net).toBe(-28000);
      expect(flow.complete).toBe(true);

      const ledger = buildLedger([source, dest], [transferTx, foreignFeeTx], '2026-09-10');
      // Dest balance: 1,000 USD - 5 USD = 995 USD (99,500 cents)
      expect(ledger.balances['dest-usd']).toEqual({ USD: 99500 });
    });
  });

  /* ===================================================================================
   * 3. Intra-Account Currency Conversions
   * =================================================================================== */
  describe('3. Intra-Account Currency Conversions', () => {
    it('3.1: Intra-account conversion adjusts sub-ledgers accurately without triggering cash flow', () => {
      const multiWallet = createAccount('multi-wise', 'PHP', {
        PHP: 1000000, // PHP 10,000.00
        USD: 50000,   // USD 500.00
      });

      // Convert USD 200 to PHP 11,200 inside multi-wise
      const intraConvert: Transaction = {
        id: 'intra-1',
        type: 'TRANSFER',
        date: '2026-09-15',
        accountId: 'multi-wise',
        currency: 'USD',
        amount: 20000, // $200.00
        transferAccountId: 'multi-wise',
        transferCurrency: 'PHP',
        transferAmount: 1120000, // PHP 11,200.00
      };

      const postings = postingsForTransaction(intraConvert, [multiWallet]);
      expect(postings).toHaveLength(2);
      expect(postings[0]).toMatchObject({ accountId: 'multi-wise', currency: 'USD', delta: -20000 });
      expect(postings[1]).toMatchObject({ accountId: 'multi-wise', currency: 'PHP', delta: 1120000 });

      const ledger = buildLedger([multiWallet], [intraConvert], '2026-09-20');
      expect(ledger.balances['multi-wise']).toEqual({
        PHP: 2120000, // 10,000 + 11,200 = 21,200 PHP
        USD: 30000,   // 500 - 200 = 300 USD
      });

      const flow = calculateCashFlow([intraConvert], [multiWallet], {
        from: '2026-09-01',
        to: '2026-09-20',
        currency: 'PHP',
      });
      expect(flow.income).toBe(0);
      expect(flow.expenses).toBe(0);
      expect(flow.net).toBe(0);
    });

    it('3.2: Multi-currency triangular intra-account conversion (USD -> EUR -> JPY)', () => {
      const globalAcc = createAccount('global-pot', 'PHP', {
        PHP: 0,
        USD: 100000, // $1,000
        EUR: 0,
        JPY: 0,
      });

      // Step 1: USD 500 to EUR 460
      const tx1: Transaction = {
        id: 'intra-step-1',
        type: 'TRANSFER',
        date: '2026-09-21',
        accountId: 'global-pot',
        currency: 'USD',
        amount: 50000,
        transferAccountId: 'global-pot',
        transferCurrency: 'EUR',
        transferAmount: 46000,
      };

      // Step 2: EUR 200 to JPY 32,000
      const tx2: Transaction = {
        id: 'intra-step-2',
        type: 'TRANSFER',
        date: '2026-09-22',
        accountId: 'global-pot',
        currency: 'EUR',
        amount: 20000,
        transferAccountId: 'global-pot',
        transferCurrency: 'JPY',
        transferAmount: 32000, // 32,000 JPY (scale 1)
      };

      const ledger = buildLedger([globalAcc], [tx1, tx2], '2026-09-25');
      expect(ledger.balances['global-pot']).toEqual({
        PHP: 0,
        USD: 50000, // $500 remaining
        EUR: 26000, // €260 remaining
        JPY: 32000, // ¥32,000
      });

      const flow = calculateCashFlow([tx1, tx2], [globalAcc], {
        from: '2026-09-20',
        to: '2026-09-25',
        currency: 'PHP',
      });
      expect(flow.income).toBe(0);
      expect(flow.expenses).toBe(0);
    });

    it('3.3: Rejects same-currency intra-account transfer (destination currency must differ)', () => {
      const multiWallet = createAccount('wallet-1', 'PHP', { PHP: 1000000 });

      const sameCurrencyIntra: Transaction = {
        id: 'bad-intra',
        type: 'TRANSFER',
        date: '2026-09-15',
        accountId: 'wallet-1',
        currency: 'PHP',
        amount: 100000,
        transferAccountId: 'wallet-1',
        transferCurrency: 'PHP', // Same currency!
        transferAmount: 100000,
      };

      expect(() => {
        postingsForTransaction(sameCurrencyIntra, [multiWallet]);
      }).toThrow(/destination currency/);
    });
  });

  /* ===================================================================================
   * 4. Absolute Protection Against Fabricated Income/Expenses
   * =================================================================================== */
  describe('4. Absolute Protection Against Fabricated Income/Expenses', () => {
    it('4.1: Sweep of balance adjustments, investments and transfers generates strictly zero earned/consumed flow', () => {
      const acc = createAccount('asset-acc', 'PHP', { PHP: 5000000 });
      const dest = createAccount('dest-acc', 'PHP', { PHP: 0 });

      const nonFlowTxs: Transaction[] = [
        { id: 't-adj-pos', type: 'BALANCE_ADJUSTMENT', date: '2026-10-01', accountId: 'asset-acc', currency: 'PHP', amount: 1000000 },
        { id: 't-adj-neg', type: 'BALANCE_ADJUSTMENT', date: '2026-10-02', accountId: 'asset-acc', currency: 'PHP', amount: -500000 },
        { id: 't-xfer', type: 'TRANSFER', date: '2026-10-03', accountId: 'asset-acc', currency: 'PHP', amount: 500000, transferAccountId: 'dest-acc' },
      ];

      const flow = calculateCashFlow(nonFlowTxs, [acc, dest], {
        from: '2026-10-01',
        to: '2026-10-05',
        currency: 'PHP',
      });

      expect(flow.income).toBe(0);
      expect(flow.expenses).toBe(0);
      expect(flow.net).toBe(0);
      expect(flow.complete).toBe(true);
    });

    it('4.2: REFUND transactions strictly reduce expenses and never fabricate income', () => {
      const acc = createAccount('card-acc', 'PHP', { PHP: 1000000 });

      const txs: Transaction[] = [
        { id: 't-exp', type: 'EXPENSE', date: '2026-10-01', accountId: 'card-acc', currency: 'PHP', amount: 500000 }, // 5,000 PHP expense
        { id: 't-ref', type: 'REFUND', date: '2026-10-02', accountId: 'card-acc', currency: 'PHP', amount: 200000 },  // 2,000 PHP refund
      ];

      const flow = calculateCashFlow(txs, [acc], {
        from: '2026-10-01',
        to: '2026-10-05',
        currency: 'PHP',
      });

      // Income MUST remain 0 (refund is NOT income)
      expect(flow.income).toBe(0);
      // Expenses net to 5,000 - 2,000 = 3,000 PHP
      expect(flow.expenses).toBe(300000);
      expect(flow.net).toBe(-300000);
    });
  });

  /* ===================================================================================
   * 5. Removal and Omission of Exchange Rates (No 1:1 Fallback)
   * =================================================================================== */
  describe('5. Removal and Omission of Exchange Rates (No 1:1 Fallback)', () => {
    it('5.1: Missing FX rate excludes foreign sub-balance from net worth and strictly avoids 1:1 fallback', () => {
      // Account has PHP 10,000.00 and USD 500.00
      const account = createAccount('wallet', 'PHP', {
        PHP: 1000000, // PHP 10,000.00
        USD: 50000,   // USD 500.00
      });

      const dataWithoutRates: FinanceData = {
        accounts: [account],
        transactions: [],
        instruments: [],
        prices: [],
        fxRates: [], // No FX rates!
      };

      const summary = calculateNetWorth(dataWithoutRates, 'PHP', '2026-10-09');

      // Net worth is incomplete
      expect(summary.netWorth).toBeNull();
      expect(summary.complete).toBe(false);

      // knownNetWorth MUST strictly equal ONLY the PHP balance (1,000,000 centavos)
      // If a bug fell back to 1:1, it would be 1,000,000 + 50,000 = 1,050,000.
      expect(summary.knownNetWorth).toBe(1000000);
      expect(summary.knownAssets).toBe(1000000);
      expect(summary.knownNetWorth).not.toBe(1050000);

      // Issues list must highlight missing_fx for USD
      expect(summary.issues).toContainEqual({
        code: 'missing_fx',
        accountId: 'wallet',
        currency: 'USD',
      });
    });

    it('5.2: Standalone foreign currency account with missing FX rate is completely excluded from base net worth', () => {
      const phpAccount = createAccount('php-bank', 'PHP', { PHP: 2000000 }); // PHP 20,000.00
      const usdAccount = createAccount('usd-bank', 'USD', { USD: 100000 });  // USD 1,000.00 (currency USD)

      const dataWithoutUsdRate: FinanceData = {
        accounts: [phpAccount, usdAccount],
        transactions: [],
        instruments: [],
        prices: [],
        fxRates: [],
      };

      const summary = calculateNetWorth(dataWithoutUsdRate, 'PHP', '2026-10-09');

      expect(summary.netWorth).toBeNull();
      expect(summary.complete).toBe(false);

      // Only the PHP account contributes to known net worth
      expect(summary.knownNetWorth).toBe(2000000);
      expect(summary.knownNetWorth).not.toBe(3000000); // Must NOT be 20,000 + 1,000 * 1

      const usdVal = summary.accountValues.find(a => a.accountId === 'usd-bank');
      expect(usdVal?.baseValue).toBeNull();
    });

    it('5.3: Selective removal of one foreign rate excludes only the unpriced currency', () => {
      // 4-currency account: PHP 10,000, USD 100, EUR 100, GBP 100
      const multi = createAccount('quad-wallet', 'PHP', {
        PHP: 1000000, // PHP 10,000.00
        USD: 10000,   // USD 100.00 @ 56 -> PHP 5,600.00
        EUR: 10000,   // EUR 100.00 @ 60 -> PHP 6,000.00
        GBP: 10000,   // GBP 100.00 -> missing rate!
      });

      const rates: FxRate[] = [
        createFx('fx-usd', 'USD', 'PHP', 56, '2026-01-01'),
        createFx('fx-eur', 'EUR', 'PHP', 60, '2026-01-01'),
        // GBP rate omitted!
      ];

      const summary = calculateNetWorth({
        accounts: [multi],
        transactions: [],
        instruments: [],
        prices: [],
        fxRates: rates,
      }, 'PHP', '2026-10-09');

      expect(summary.netWorth).toBeNull();
      expect(summary.complete).toBe(false);

      // Known net worth = PHP 10,000 + USD 100 * 56 (5,600) + EUR 100 * 60 (6,000) = 21,600 PHP (2,160,000 centavos)
      // GBP is strictly excluded
      expect(summary.knownNetWorth).toBe(2160000);
      expect(summary.issues).toContainEqual({
        code: 'missing_fx',
        accountId: 'quad-wallet',
        currency: 'GBP',
      });
    });

    it('5.4: Corrupt or non-positive FX rates are ignored and treated as missing rate', () => {
      const account = createAccount('wallet-corrupt', 'PHP', {
        PHP: 1000000,
        USD: 10000,
      });

      const corruptRates: FxRate[] = [
        createFx('zero-rate', 'USD', 'PHP', 0, '2026-01-01'),
        createFx('negative-rate', 'USD', 'PHP', -56, '2026-01-01'),
        createFx('nan-rate', 'USD', 'PHP', NaN, '2026-01-01'),
        createFx('deleted-rate', 'USD', 'PHP', 56, '2026-01-01', { deletedAt: '2026-05-01' }),
      ];

      const summary = calculateNetWorth({
        accounts: [account],
        transactions: [],
        instruments: [],
        prices: [],
        fxRates: corruptRates,
      }, 'PHP', '2026-10-09');

      expect(summary.netWorth).toBeNull();
      expect(summary.complete).toBe(false);
      expect(summary.knownNetWorth).toBe(1000000); // Foreign USD balance excluded!
      expect(summary.issues).toContainEqual({
        code: 'missing_fx',
        accountId: 'wallet-corrupt',
        currency: 'USD',
      });
    });
  });

  /* ===================================================================================
   * 6. Dated Exchange Rates & Zero Temporal Leakage
   * =================================================================================== */
  describe('6. Dated Exchange Rates & Zero Temporal Leakage', () => {
    const historicalRates: FxRate[] = [
      createFx('fx-usd-php-1', 'USD', 'PHP', 50, '2026-01-01T00:00:00Z'),
      createFx('fx-usd-php-2', 'USD', 'PHP', 54, '2026-04-01T00:00:00Z'),
      createFx('fx-usd-php-3', 'USD', 'PHP', 58, '2026-08-01T00:00:00Z'),
    ];

    it('6.1: getFxRate and convertMoney strictly respect cutoff dates without looking ahead', () => {
      // Before Apr 1 -> rate is 50
      expect(getFxRate('USD', 'PHP', historicalRates, '2026-03-31')).toBe(50);
      // On Apr 1 -> rate is 54
      expect(getFxRate('USD', 'PHP', historicalRates, '2026-04-01')).toBe(54);
      // Between Apr 1 and Aug 1 -> rate is 54
      expect(getFxRate('USD', 'PHP', historicalRates, '2026-07-31')).toBe(54);
      // On or after Aug 1 -> rate is 58
      expect(getFxRate('USD', 'PHP', historicalRates, '2026-08-01')).toBe(58);
      expect(getFxRate('USD', 'PHP', historicalRates, '2026-12-31')).toBe(58);

      // Before Jan 1 -> no rate available (returns null)
      expect(getFxRate('USD', 'PHP', historicalRates, '2025-12-31')).toBeNull();
    });

    it('6.2: Future-only rate strictly produces null in past valuations and does not leak backward', () => {
      const futureRateOnly: FxRate[] = [
        createFx('future-rate', 'USD', 'PHP', 70, '2026-11-01T00:00:00Z'),
      ];

      // Valuation as of 2026-10-01 (before 2026-11-01)
      const account = createAccount('wallet', 'PHP', {
        PHP: 1000000,
        USD: 10000, // USD 100
      });

      const summary = calculateNetWorth({
        accounts: [account],
        transactions: [],
        instruments: [],
        prices: [],
        fxRates: futureRateOnly,
      }, 'PHP', '2026-10-01');

      // Must NOT leak future rate of 70!
      expect(summary.netWorth).toBeNull();
      expect(summary.complete).toBe(false);
      expect(summary.knownNetWorth).toBe(1000000); // USD 100 excluded
      expect(summary.issues).toContainEqual({
        code: 'missing_fx',
        accountId: 'wallet',
        currency: 'USD',
      });
    });

    it('6.3: Microsecond boundary testing on dated exchange rates', () => {
      const edgeRates: FxRate[] = [
        createFx('rate-eod', 'USD', 'PHP', 52, '2026-06-15T23:59:59.999Z'),
        createFx('rate-next-day', 'USD', 'PHP', 56, '2026-06-16T00:00:00.000Z'),
      ];

      // Query as of '2026-06-15' must pick rate-eod (52)
      expect(getFxRate('USD', 'PHP', edgeRates, '2026-06-15')).toBe(52);

      // Query as of '2026-06-16' must pick rate-next-day (56)
      expect(getFxRate('USD', 'PHP', edgeRates, '2026-06-16')).toBe(56);
    });

    it('6.4: Historical net worth trajectory (netWorthHistory) evaluates accurately at each date without future leakage', () => {
      const account = createAccount('hist-wallet', 'PHP', {
        PHP: 1000000, // PHP 10,000.00
        USD: 10000,   // USD 100.00
      });

      const data: FinanceData = {
        accounts: [account],
        transactions: [],
        instruments: [],
        prices: [],
        fxRates: historicalRates, // Jan 1: 50, Apr 1: 54, Aug 1: 58
      };

      const dates = ['2026-02-01', '2026-05-01', '2026-09-01'];
      const history = netWorthHistory(data, 'PHP', dates);

      expect(history).toHaveLength(3);

      // Feb 1: rate 50 -> 10,000 + 100 * 50 = 15,000 PHP (1,500,000 centavos)
      expect(history[0].date).toBe('2026-02-01');
      expect(history[0].netWorth).toBe(1500000);
      expect(history[0].complete).toBe(true);

      // May 1: rate 54 -> 10,000 + 100 * 54 = 15,400 PHP (1,540,000 centavos)
      expect(history[1].date).toBe('2026-05-01');
      expect(history[1].netWorth).toBe(1540000);
      expect(history[1].complete).toBe(true);

      // Sep 1: rate 58 -> 10,000 + 100 * 58 = 15,800 PHP (1,580,000 centavos)
      expect(history[2].date).toBe('2026-09-01');
      expect(history[2].netWorth).toBe(1580000);
      expect(history[2].complete).toBe(true);
    });

    it('6.5: Historical cash flow transactions convert strictly using the rate on their transaction date', () => {
      const usdAcc = createAccount('usd-wallet', 'USD', { USD: 100000 });

      // Expense 1 on Feb 15 ($50) -> should convert at Jan 1 rate (50) -> 2,500 PHP
      // Expense 2 on Aug 15 ($50) -> should convert at Aug 1 rate (58) -> 2,900 PHP
      const txs: Transaction[] = [
        { id: 'exp-feb', type: 'EXPENSE', date: '2026-02-15', accountId: 'usd-wallet', currency: 'USD', amount: 5000 },
        { id: 'exp-aug', type: 'EXPENSE', date: '2026-08-15', accountId: 'usd-wallet', currency: 'USD', amount: 5000 },
      ];

      const flow = calculateCashFlow(txs, [usdAcc], {
        from: '2026-01-01',
        to: '2026-09-01',
        currency: 'PHP',
        fxRates: historicalRates,
      });

      // Total expected expenses: 2,500.00 + 2,900.00 = PHP 5,400.00 (540,000 centavos)
      // If the future rate of 58 leaked into the Feb 15 expense, expenses would be 580,000 centavos.
      expect(flow.income).toBe(0);
      expect(flow.expenses).toBe(540000);
      expect(flow.net).toBe(-540000);
      expect(flow.complete).toBe(true);
    });
  });
});
