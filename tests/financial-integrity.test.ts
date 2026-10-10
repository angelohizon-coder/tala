import { describe, expect, it } from 'vitest';
import {
  calculateNetWorth,
  calculateNetWorthFromBalances,
  buildLedger,
  convertMoney,
  postingsForTransaction,
  calculateCashFlow,
  toMinor,
  fromMinor,
  currencyScale,
} from '../src/core/calculations';
import type { Account, FxRate, Transaction, FinanceData } from '../src/core/types';

describe('Financial Integrity & Multi-Currency Data Modeling (R2)', () => {
  const AS_OF = '2026-10-09';

  const fxRateUsdPhp: FxRate = {
    id: 'fx-usd-php',
    fromCurrency: 'USD',
    toCurrency: 'PHP',
    rate: 56,
    asOf: '2026-01-01T00:00:00Z',
    source: 'BSP Market Rate',
  };

  const fxRateEurPhp: FxRate = {
    id: 'fx-eur-php',
    fromCurrency: 'EUR',
    toCurrency: 'PHP',
    rate: 60,
    asOf: '2026-01-01T00:00:00Z',
    source: 'ECB Market Rate',
  };

  it('R2/AC1: test account holding PHP 10,000 and USD 100 correctly shows converted total of PHP 15,600 without double-counting', () => {
    // PHP 10,000.00 = 1,000,000 centavos
    // USD 100.00 = 10,000 cents
    // At rate 56 PHP/USD:
    // USD 100 * 56 = PHP 5,600.00 = 560,000 centavos
    // Total PHP balance: 1,000,000 + 560,000 = 1,560,000 centavos = PHP 15,600.00
    const multiAccount: Account = {
      id: 'multi-wallet',
      name: 'Global Multi-Currency Wallet',
      accountType: 'SAVINGS',
      currency: 'PHP',
      openingBalances: {
        PHP: 1000000,
        USD: 10000,
      },
      openingDate: '2026-01-01',
      includeInNetWorth: true,
      includeInLiquidNetWorth: true,
      includeInFire: true,
      emergency: false,
      archived: false,
    };

    const data: FinanceData = {
      accounts: [multiAccount],
      transactions: [],
      instruments: [],
      prices: [],
      fxRates: [fxRateUsdPhp],
    };

    const summary = calculateNetWorth(data, 'PHP', AS_OF);

    // 1. Verify ledger sub-balances are preserved exactly
    const accountVal = summary.accountValues.find(a => a.accountId === 'multi-wallet');
    expect(accountVal).toBeDefined();
    expect(accountVal?.cashBalances).toEqual({
      PHP: 1000000,
      USD: 10000,
    });

    // 2. Converted total in primary currency PHP:
    expect(accountVal?.balance).toBe(1560000);
    expect(accountVal?.baseValue).toBe(1560000);

    // 3. Consolidated net worth equals exactly PHP 15,600 (1560000 centavos) with no double counting
    expect(summary.netWorth).toBe(1560000);
    expect(summary.assets).toBe(1560000);
    expect(summary.liabilities).toBe(0);
    expect(summary.complete).toBe(true);
    expect(summary.issues).toEqual([]);
  });

  it('R2/AC2: removing an exchange rate excludes foreign balance from aggregated net worth rather than 1:1 fallback', () => {
    const multiAccount: Account = {
      id: 'multi-wallet',
      name: 'Global Wallet',
      accountType: 'SAVINGS',
      currency: 'PHP',
      openingBalances: {
        PHP: 1000000, // PHP 10,000.00
        USD: 10000,   // USD 100.00
      },
      openingDate: '2026-01-01',
      includeInNetWorth: true,
      includeInLiquidNetWorth: true,
      includeInFire: true,
      emergency: false,
      archived: false,
    };

    // No FX rates provided
    const dataWithoutRates: FinanceData = {
      accounts: [multiAccount],
      transactions: [],
      instruments: [],
      prices: [],
      fxRates: [],
    };

    const summary = calculateNetWorth(dataWithoutRates, 'PHP', AS_OF);

    // Strict completeness invalidation: net worth is incomplete (null)
    expect(summary.netWorth).toBeNull();
    expect(summary.assets).toBeNull();
    expect(summary.complete).toBe(false);

    // Known net worth contains ONLY the verifiable PHP balance (1,000,000 centavos = PHP 10,000)
    // It must NOT assume USD 100 == PHP 100 (which would yield 1,010,000)
    expect(summary.knownNetWorth).toBe(1000000);
    expect(summary.knownAssets).toBe(1000000);

    // Missing FX issue registered
    expect(summary.issues).toContainEqual({
      code: 'missing_fx',
      accountId: 'multi-wallet',
      currency: 'USD',
    });
  });

  it('R2/AC3: cross-currency transfers reflect zero generated income or expense', () => {
    const phpAccount: Account = {
      id: 'bdo-php',
      name: 'BDO Checking',
      accountType: 'CHECKING',
      currency: 'PHP',
      openingBalances: { PHP: 10000000 }, // PHP 100,000.00
      openingDate: '2026-01-01',
      includeInNetWorth: true,
      includeInLiquidNetWorth: true,
      includeInFire: true,
      emergency: false,
      archived: false,
    };

    const usdAccount: Account = {
      id: 'wise-usd',
      name: 'Wise USD Balance',
      accountType: 'SAVINGS',
      currency: 'USD',
      openingBalances: { USD: 0 },
      openingDate: '2026-01-01',
      includeInNetWorth: true,
      includeInLiquidNetWorth: true,
      includeInFire: true,
      emergency: false,
      archived: false,
    };

    const crossTransfer: Transaction = {
      id: 'x-transfer-1',
      type: 'TRANSFER',
      date: '2026-10-05',
      accountId: 'bdo-php',
      currency: 'PHP',
      amount: 5600000, // Sent PHP 56,000.00
      transferAccountId: 'wise-usd',
      transferCurrency: 'USD',
      transferAmount: 100000, // Received USD 1,000.00
    };

    const accounts = [phpAccount, usdAccount];
    const flow = calculateCashFlow([crossTransfer], accounts, {
      from: '2026-10-01',
      to: '2026-10-09',
      currency: 'PHP',
      fxRates: [fxRateUsdPhp],
    });

    // Zero generated income, zero generated expenses, zero net change
    expect(flow.income).toBe(0);
    expect(flow.expenses).toBe(0);
    expect(flow.net).toBe(0);
    expect(flow.complete).toBe(true);

    // Verify ledger postings reflect exact source and destination minor amounts
    const ledger = buildLedger(accounts, [crossTransfer], AS_OF);
    expect(ledger.balances['bdo-php']).toEqual({ PHP: 4400000 }); // 100,000 - 56,000 = 44,000 PHP
    expect(ledger.balances['wise-usd']).toEqual({ USD: 100000 }); // 0 + 1,000 = 1,000 USD
  });

  it('R2/IntraAccount: intra-account cross-currency transfers adjust sub-ledgers with zero cash flow consumption', () => {
    const multiAccount: Account = {
      id: 'wise-multi',
      name: 'Wise Multi-Currency',
      accountType: 'SAVINGS',
      currency: 'PHP',
      openingBalances: {
        USD: 100000, // USD 1,000.00
        PHP: 0,
      },
      openingDate: '2026-01-01',
      includeInNetWorth: true,
      includeInLiquidNetWorth: true,
      includeInFire: true,
      emergency: false,
      archived: false,
    };

    // Exchange USD 200 to PHP 11,200 within the same Wise multi-currency account
    const exchangeTx: Transaction = {
      id: 'intra-exchange-1',
      type: 'TRANSFER',
      date: '2026-10-06',
      accountId: 'wise-multi',
      currency: 'USD',
      amount: 20000, // $200.00
      transferAccountId: 'wise-multi',
      transferCurrency: 'PHP',
      transferAmount: 1120000, // PHP 11,200.00
    };

    const accounts = [multiAccount];
    const postings = postingsForTransaction(exchangeTx, accounts);
    expect(postings).toHaveLength(2);
    expect(postings[0]).toMatchObject({
      accountId: 'wise-multi',
      currency: 'USD',
      delta: -20000,
    });
    expect(postings[1]).toMatchObject({
      accountId: 'wise-multi',
      currency: 'PHP',
      delta: 1120000,
    });

    const ledger = buildLedger(accounts, [exchangeTx], AS_OF);
    expect(ledger.balances['wise-multi']).toEqual({
      USD: 80000,    // $800.00 remaining
      PHP: 1120000,  // PHP 11,200.00 received
    });

    const flow = calculateCashFlow([exchangeTx], accounts, {
      from: '2026-10-01',
      to: '2026-10-09',
      currency: 'PHP',
      fxRates: [fxRateUsdPhp],
    });
    expect(flow.income).toBe(0);
    expect(flow.expenses).toBe(0);
    expect(flow.net).toBe(0);
  });

  it('R2/MultiCurrency3: supports three concurrent currencies (PHP, USD, EUR) in one account', () => {
    const multiAccount: Account = {
      id: 'global-acc',
      name: 'Global Triple Account',
      accountType: 'SAVINGS',
      currency: 'PHP',
      openingBalances: {
        PHP: 1000000, // PHP 10,000.00
        USD: 10000,   // USD 100.00 @ 56 -> PHP 5,600.00 (560,000)
        EUR: 5000,    // EUR 50.00 @ 60 -> PHP 3,000.00 (300,000)
      },
      openingDate: '2026-01-01',
      includeInNetWorth: true,
      includeInLiquidNetWorth: true,
      includeInFire: true,
      emergency: false,
      archived: false,
    };

    const data: FinanceData = {
      accounts: [multiAccount],
      transactions: [],
      instruments: [],
      prices: [],
      fxRates: [fxRateUsdPhp, fxRateEurPhp],
    };

    // Expected total: 1,000,000 + 560,000 + 300,000 = 1,860,000 centavos = PHP 18,600.00
    const summary = calculateNetWorth(data, 'PHP', AS_OF);
    expect(summary.netWorth).toBe(1860000);
    expect(summary.assets).toBe(1860000);
    expect(summary.complete).toBe(true);

    // If EUR rate is removed, net worth becomes incomplete, but knownNetWorth retains PHP + USD = 1,560,000
    const dataWithoutEur: FinanceData = {
      ...data,
      fxRates: [fxRateUsdPhp],
    };
    const summaryWithoutEur = calculateNetWorth(dataWithoutEur, 'PHP', AS_OF);
    expect(summaryWithoutEur.netWorth).toBeNull();
    expect(summaryWithoutEur.complete).toBe(false);
    expect(summaryWithoutEur.knownNetWorth).toBe(1560000);
    expect(summaryWithoutEur.issues).toContainEqual({
      code: 'missing_fx',
      accountId: 'global-acc',
      currency: 'EUR',
    });
  });

  it('R2/StrictMinorUnits: minor unit conversion guarantees integer accuracy with zero float drift', () => {
    // 0.1 + 0.2 in JS float produces 0.30000000000000004
    // In minor units: 10 + 20 = 30 cents exactly
    expect(toMinor(0.1, 'USD')).toBe(10);
    expect(toMinor(0.2, 'USD')).toBe(20);
    expect(toMinor(0.1, 'USD') + toMinor(0.2, 'USD')).toBe(30);
    expect(fromMinor(30, 'USD')).toBe(0.3);

    // Asymmetric currency scales
    expect(currencyScale('JPY')).toBe(1);
    expect(toMinor(2500, 'JPY')).toBe(2500);
    expect(fromMinor(2500, 'JPY')).toBe(2500);

    expect(currencyScale('KWD')).toBe(1000);
    expect(toMinor(1.5, 'KWD')).toBe(1500);
    expect(fromMinor(1500, 'KWD')).toBe(1.5);

    // Half-cent rounding with epsilon protection
    expect(toMinor(1.005, 'USD')).toBe(101);
    expect(toMinor(1.004, 'USD')).toBe(100);
  });
});
