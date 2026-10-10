import { describe, expect, it } from 'vitest';
import {
  accountBalances, buildLedger, calculateAmortization, calculateBudget, calculateCashFlow,
  calculateFire, calculateNetWorth, calculateNetWorthFromBalances, calculatePositions,
  calculateSavingsRate, categoryDescendants, convertMoney, currencyScale,
  FinanceValidationError, findDuplicateTransactions, fromMinor, getFxRate,
  netWorthHistory, periodBounds, postingsForTransaction, toMinor, transactionFingerprint,
} from '../src/core/calculations';
import type { Account, Budget, Category, FinanceData, FxRate, Instrument, Price, Transaction } from '../src/core/types';

// These explicit fixtures are test data, never initial personal records in the app.
const AS_OF = '2026-10-09';
const NOW = '2026-10-09T12:00:00Z';
function account(id: string, extra: Partial<Account> = {}): Account {
  return { id, name: id, accountType: 'SAVINGS', currency: 'PHP', openingBalance: 0,
    openingDate: '2026-01-01', includeInNetWorth: true, includeInLiquidNetWorth: true,
    includeInFire: true, emergency: false, archived: false, ...extra };
}
function transaction(id: string, extra: Partial<Transaction> = {}): Transaction {
  return { id, type: 'EXPENSE', date: '2026-10-01', amount: 10000, currency: 'PHP', accountId: 'cash', ...extra };
}
function instrument(id = 'stock', extra: Partial<Instrument> = {}): Instrument {
  return { id, name: id, currency: 'PHP', instrumentType: 'PSE_STOCK', valuationMethod: 'LIVE_MARKET', ...extra };
}
function price(id: string, value: number, asOf = '2026-10-08T08:00:00Z', extra: Partial<Price> = {}): Price {
  return { id, instrumentId: 'stock', value, currency: 'PHP', asOf, fetchedAt: asOf,
    source: 'Test statement', staleAfter: '2026-10-09T08:00:00Z', status: 'fresh', ...extra };
}
function fx(extra: Partial<FxRate> = {}): FxRate {
  return { id: 'fx', fromCurrency: 'USD', toCurrency: 'PHP', rate: 56,
    asOf: '2026-01-01T00:00:00Z', source: 'Test FX', ...extra };
}
function data(extra: Partial<FinanceData> = {}): FinanceData {
  return { accounts: [account('cash')], transactions: [], instruments: [], prices: [], fxRates: [], ...extra };
}

describe('money and dated FX', () => {
  it('uses currency precision, symmetric half-cent rounding and safe integers', () => {
    expect(currencyScale('PHP')).toBe(100); expect(currencyScale('USD')).toBe(100);
    expect(currencyScale('JPY')).toBe(1); expect(currencyScale('KWD')).toBe(1000);
    expect(toMinor(1.005, 'PHP')).toBe(101); expect(toMinor(-1.005, 'PHP')).toBe(-101);
    expect(toMinor(123.4, 'JPY')).toBe(123); expect(fromMinor(101, 'PHP')).toBe(1.01);
    expect(toMinor(.00000001, 'BTC', { BTC: 8 })).toBe(1);
    expect(() => fromMinor(.1, 'PHP')).toThrow(FinanceValidationError);
    expect(() => toMinor(Infinity, 'PHP')).toThrow(FinanceValidationError);
    expect(() => toMinor(Number.MAX_SAFE_INTEGER, 'PHP')).toThrow(FinanceValidationError);
    expect(toMinor(20000000000000, 'PHP')).toBe(2000000000000000);
  });
  it('converts major currency rates into destination minor units without assuming missing FX', () => {
    expect(convertMoney(10000, 'USD', 'PHP', [fx()], AS_OF)).toBe(560000);
    expect(convertMoney(560000, 'PHP', 'USD', [fx()], AS_OF)).toBe(10000);
    expect(convertMoney(100, 'JPY', 'PHP', [fx({ fromCurrency: 'JPY', rate: .4 })], AS_OF)).toBe(4000);
    expect(convertMoney(100, 'USD', 'PHP', [], AS_OF)).toBeNull();
    expect(convertMoney(0, 'USD', 'PHP', [], AS_OF)).toBe(0);
  });
  it('selects a valid dated rate and excludes future, deleted or invalid observations', () => {
    const rates = [fx(), fx({ id: 'future', rate: 99, asOf: '2026-10-10T00:00:00Z' }),
      fx({ id: 'later', rate: 57, asOf: '2026-10-08T00:00:00Z' }),
      fx({ id: 'deleted', rate: 80, asOf: '2026-10-09T00:00:00Z', deletedAt: NOW }),
      fx({ id: 'bad', rate: -1, asOf: NOW })];
    expect(getFxRate('USD', 'PHP', rates, '2026-10-07')).toBe(56);
    expect(getFxRate('USD', 'PHP', rates, AS_OF)).toBe(57);
    expect(getFxRate('PHP', 'USD', [fx({ rate: 60, asOf: '2026-10-09T00:00:00Z' }),
      fx({ id: 'old-direct', fromCurrency: 'PHP', toCurrency: 'USD', rate: 1 / 56 })], AS_OF)).toBe(1 / 60);
  });
});

describe('ledger with natural account balances', () => {
  it('starts empty and derives balances from opening balances and active transactions', () => {
    const accounts = [account('cash', { openingBalance: 100000 }), account('future', { openingBalance: 90000, openingDate: '2026-11-01' })];
    const rows = [transaction('income', { type: 'INCOME', amount: 50000 }), transaction('expense'),
      transaction('refund', { type: 'REFUND', amount: 2000 }), transaction('deleted', { deletedAt: NOW }),
      transaction('future', { date: '2026-11-01', amount: 20000 })];
    expect(calculateNetWorth(data(), 'PHP', AS_OF).netWorth).toBe(0);
    expect(accountBalances(accounts, rows, AS_OF)).toEqual({ cash: { PHP: 142000 }, future: {} });
    expect(accountBalances(accounts, rows.filter(row => row.id !== 'expense'), AS_OF).cash.PHP).toBe(152000);
    expect(accountBalances(accounts, rows.map(row => row.id === 'expense' ? { ...row, amount: 5000 } : row), AS_OF).cash.PHP).toBe(147000);
  });
  it('counts card purchases once and a payment reduces cash and positive debt', () => {
    const accounts = [account('cash', { openingBalance: 100000 }), account('card', { accountType: 'CREDIT_CARD', openingBalance: 5000, includeInFire: false })];
    const rows = [transaction('purchase', { accountId: 'card', amount: 20000 }),
      transaction('payment', { type: 'TRANSFER', amount: 15000, transferAccountId: 'card' }),
      transaction('refund', { type: 'REFUND', accountId: 'card', amount: 1000 }),
      transaction('interest', { type: 'INTEREST', accountId: 'card', amount: 500 })];
    expect(buildLedger(accounts, rows, AS_OF).balances).toEqual({ cash: { PHP: 85000 }, card: { PHP: 9500 } });
    const flow = calculateCashFlow(rows, accounts, { to: AS_OF });
    expect(flow.expenses).toBe(19500); expect(flow.income).toBe(0);
    expect(flow.debtPrincipal).toBe(0);
    expect(calculateNetWorth(data({ accounts, transactions: rows }), 'PHP', AS_OF).netWorth).toBe(75500);
  });
  it('preserves same-currency asset transfers and contribution/withdrawal movements', () => {
    const accounts = [account('cash', { openingBalance: 100000 }), account('broker', { accountType: 'BROKERAGE' })];
    const rows = [transaction('transfer', { type: 'TRANSFER', amount: 10000, transferAccountId: 'broker' }),
      transaction('contribute', { type: 'INVESTMENT_CONTRIBUTION', amount: 20000, transferAccountId: 'broker' }),
      transaction('withdraw', { type: 'INVESTMENT_WITHDRAWAL', amount: 5000, accountId: 'broker', transferAccountId: 'cash' })];
    expect(accountBalances(accounts, rows, AS_OF)).toEqual({ cash: { PHP: 75000 }, broker: { PHP: 25000 } });
    expect(calculateCashFlow(rows, accounts, { to: AS_OF }).net).toBe(0);
    expect(() => postingsForTransaction(transaction('bad', { type: 'INVESTMENT_CONTRIBUTION' }), accounts)).toThrow();
  });
  it('requires explicit actual destination money for cross-currency transfers', () => {
    const accounts = [account('cash', { openingBalance: 560000 }), account('usd', { currency: 'USD' })];
    const move = transaction('fxmove', { type: 'TRANSFER', amount: 560000, transferAccountId: 'usd', transferAmount: 10000, transferCurrency: 'USD' });
    expect(accountBalances(accounts, [move], AS_OF)).toEqual({ cash: { PHP: 0 }, usd: { USD: 10000 } });
    expect(calculateNetWorth(data({ accounts, transactions: [move], fxRates: [fx()] }), 'PHP', AS_OF).netWorth).toBe(560000);
    expect(() => postingsForTransaction({ ...move, transferAmount: undefined }, accounts)).toThrow(/explicit destination/);
    expect(() => postingsForTransaction({ ...move, transferCurrency: 'JPY' }, accounts)).toThrow(/Destination currency/);
  });
  it('rejects duplicate identifiers, invalid dates, pre-opening entries, bad amounts and account mismatches', () => {
    const accounts = [account('cash')];
    expect(() => buildLedger(accounts, [transaction('same'), transaction('same')], AS_OF)).toThrow(/unique/);
    expect(() => postingsForTransaction(transaction('bad', { date: '2026-02-30' }), accounts)).toThrow();
    expect(() => postingsForTransaction(transaction('bad', { date: '2025-12-31' }), accounts)).toThrow(/opening/);
    expect(() => postingsForTransaction(transaction('bad', { amount: 0 }), accounts)).toThrow(/positive/);
    expect(() => postingsForTransaction(transaction('bad', { currency: 'USD' }), accounts)).toThrow(/currency/);
    expect(() => postingsForTransaction(transaction('bad', { amount: 1.5 }), accounts)).toThrow(/integer/);
    expect(() => postingsForTransaction(transaction('bad', { type: 'TRANSFER', transferAccountId: 'cash' }), accounts)).toThrow(/different/);
    expect(() => postingsForTransaction(transaction('bad', { fees: 1 }), accounts)).toThrow(/separate/);
    expect(accountBalances(accounts, [transaction('adjust', { type: 'BALANCE_ADJUSTMENT', amount: -100 })], AS_OF).cash.PHP).toBe(-100);
  });
});

describe('investments and actual valuation', () => {
  const buys = [transaction('buy1', { type: 'INVESTMENT_BUY', instrumentId: 'stock', units: 10, unitPrice: 100, amount: 100000, fees: 1000 }),
    transaction('buy2', { type: 'INVESTMENT_BUY', date: '2026-10-02', instrumentId: 'stock', units: 10, unitPrice: 200, amount: 200000, fees: 1000 })];
  it('includes acquisition fees in basis and nets sale fees under average cost', () => {
    const sale = transaction('sell', { type: 'INVESTMENT_SELL', date: '2026-10-03', instrumentId: 'stock', units: 5, unitPrice: 180, amount: 90000, fees: 500 });
    const dividend = transaction('div', { type: 'DIVIDEND', date: '2026-10-04', instrumentId: 'stock', amount: 3000 });
    const position = calculatePositions([...buys, sale, dividend], [instrument()], [price('p', 190)], { asOf: AS_OF, now: NOW })[0];
    expect(position.units).toBe(15); expect(position.costBasis).toBe(226500); expect(position.averageCost).toBe(151);
    expect(position.realizedGain).toBe(14000); expect(position.marketValue).toBe(285000);
    expect(position.unrealizedGain).toBe(58500); expect(position.income).toBe(3000); expect(position.totalReturn).toBe(75500);
    expect(position.returnPercent).toBeCloseTo(75500 / 302000 * 100);
    expect(position.stale).toBe(true);
  });
  it('adds holdings once to posted brokerage cash; investment buys are not expenses', () => {
    const accounts = [account('cash', { accountType: 'BROKERAGE', openingBalance: 500000 })];
    const result = calculateNetWorth(data({ accounts, transactions: buys, instruments: [instrument()], prices: [price('p', 150)] }), 'PHP', AS_OF);
    expect(result.accountValues[0].balance).toBe(198000); expect(result.accountValues[0].holdings).toBe(300000);
    expect(result.netWorth).toBe(498000);
    const flow = calculateCashFlow(buys, accounts, { to: AS_OF });
    expect(flow.expenses).toBe(0); expect(flow.investmentFees).toBe(2000);
  });
  it('clears every basis cent on full sale and rejects dated overselling or a wrong notional', () => {
    const sale = transaction('sell', { type: 'INVESTMENT_SELL', date: '2026-10-03', instrumentId: 'stock', units: 20, amount: 320000, fees: 1000 });
    const position = calculatePositions([...buys, sale], [instrument()], [], { asOf: AS_OF, now: NOW })[0];
    expect(position.units).toBe(0); expect(position.costBasis).toBe(0); expect(position.marketValue).toBe(0);
    expect(position.realizedGain).toBe(17000); expect(position.issues).toEqual([]);
    expect(() => calculatePositions([...buys, { ...sale, units: 21 }], [instrument()], [], { asOf: AS_OF })).toThrow(/exceeds/);
    expect(() => calculatePositions([{ ...sale, date: '2026-09-30' }, ...buys], [instrument()], [], { asOf: AS_OF })).toThrow(/exceeds/);
    expect(() => calculatePositions([{ ...buys[0], unitPrice: 99 }], [instrument()], [], { asOf: AS_OF })).toThrow(/notional/);
  });
  it('retains a real previous stale price instead of substituting zero or future/error prices', () => {
    const quotes = [price('old', 100, '2026-10-07T08:00:00Z'), price('error', 0, '2026-10-08T08:00:00Z', { status: 'error' }),
      price('future', 999, '2026-10-10T08:00:00Z'), price('same-day-future', 888, '2026-10-09T20:00:00Z')];
    const position = calculatePositions([buys[0]], [instrument()], quotes, { asOf: AS_OF, now: NOW })[0];
    expect(position.price).toBe(100); expect(position.marketValue).toBe(100000); expect(position.stale).toBe(true);
  });
  it('marks missing market prices incomplete with a known cash subtotal', () => {
    const accounts = [account('cash', { openingBalance: 200000, accountType: 'BROKERAGE' })];
    const result = calculateNetWorth(data({ accounts, transactions: [buys[0]], instruments: [instrument()] }), 'PHP', AS_OF);
    expect(result.netWorth).toBeNull(); expect(result.assets).toBeNull(); expect(result.knownNetWorth).toBe(99000);
    expect(result.accountValues[0].holdings).toBeNull(); expect(result.complete).toBe(false);
    expect(result.issues[0].code).toBe('missing_price');
  });
  it('keeps principal actual and dividends cash rather than adding dividends to holdings again', () => {
    const accounts = [account('cash', { openingBalance: 200000 })];
    const dividend = transaction('div', { type: 'DIVIDEND', instrumentId: 'stock', amount: 3000 });
    const fixed = instrument('stock', { valuationMethod: 'FIXED_PRINCIPAL', instrumentType: 'TIME_DEPOSIT' });
    const result = calculateNetWorth(data({ accounts, transactions: [buys[0], dividend], instruments: [fixed], prices: [price('ignored', 900)] }), 'PHP', AS_OF);
    expect(result.accountValues[0].holdings).toBe(101000); expect(result.netWorth).toBe(203000);
  });
  it('allocates one total manual value across accounts without double-counting it', () => {
    const rows = [buys[0], { ...buys[0], id: 'other', accountId: 'other', units: 20, unitPrice: 50 }];
    const positions = calculatePositions(rows, [instrument('stock', { valuationMethod: 'MANUAL_VALUE', manualValue: 400001 })], [], { asOf: AS_OF, now: NOW });
    expect(positions.reduce((sum, position) => sum + position.marketValue!, 0)).toBe(400001);
    expect(positions.every(position => position.marketValue! >= 0)).toBe(true);
    const tiny = calculatePositions(Array.from({ length: 4 }, (_, index) => ({ ...buys[0], id: 'buy-' + index, accountId: 'account-' + index })),
      [instrument('stock', { valuationMethod: 'MANUAL_VALUE', manualValue: 2 })], [], { asOf: AS_OF, now: NOW });
    expect(tiny.reduce((sum, row) => sum + row.marketValue!, 0)).toBe(2);
    expect(tiny.every(row => row.marketValue! >= 0)).toBe(true);
  });
  it('preserves manual statement dates and total-value history instead of applying future values retroactively', () => {
    const manual = instrument('stock', { valuationMethod: 'MANUAL_VALUE', manualValue: 300000, manualValueAsOf: '2026-10-09' });
    const older = price('statement', 1500, '2026-10-08T00:00:00Z', { status: 'manual' });
    expect(calculatePositions([buys[0]], [manual], [older], { asOf: '2026-10-08', now: NOW })[0].marketValue).toBe(150000);
    expect(calculatePositions([buys[0]], [manual], [older], { asOf: AS_OF, now: NOW })[0].marketValue).toBe(300000);
    expect(calculatePositions([buys[0]], [manual], [], { asOf: '2026-10-08', now: NOW })[0].marketValue).toBeNull();
    const zero = price('zero', 0, NOW, { status: 'manual' });
    expect(calculatePositions([buys[0]], [manual], [zero], { asOf: AS_OF, now: NOW })[0].marketValue).toBe(0);
  });
  it('keeps compounding projections visibly separate from actual principal', () => {
    const term = instrument('stock', { valuationMethod: 'COMPOUNDING', instrumentType: 'TIME_DEPOSIT',
      startDate: '2026-01-01', maturityDate: '2027-01-01', annualRate: .06, withholdingRate: .2, compoundsPerYear: 1 });
    const position = calculatePositions([buys[0]], [term], [], { asOf: AS_OF, now: NOW })[0];
    expect(position.marketValue).toBe(101000); expect(position.projectedValue).toBeGreaterThan(101000);
    expect(position.projectedAsOf).toBe('2027-01-01'); expect(position.unrealizedGain).toBe(0);
    const actualStatement = calculatePositions([buys[0]], [term], [price('manual', 105, undefined, { status: 'manual' })], { asOf: AS_OF, now: NOW })[0];
    expect(actualStatement.marketValue).toBe(105000);
  });
  it('keeps actual book value available when a long compounding projection exceeds supported money precision', () => {
    const term = instrument('stock', { valuationMethod: 'COMPOUNDING', instrumentType: 'TIME_DEPOSIT',
      startDate: '2026-01-01', maturityDate: '2200-01-01', annualRate: 1, compoundsPerYear: 12 });
    const accounts = [account('cash', { openingBalance: 200000 })];
    const position = calculatePositions([buys[0]], [term], [], { asOf: AS_OF, now: NOW })[0];
    expect(position.marketValue).toBe(101000); expect(position.projectedValue).toBeUndefined();
    expect(position.issues).toContainEqual({ code: 'projection_unavailable', instrumentId: 'stock', accountId: 'cash' });
    const worth = calculateNetWorth(data({ accounts, transactions: [buys[0]], instruments: [term] }), 'PHP', AS_OF);
    expect(worth.netWorth).toBe(200000); expect(worth.complete).toBe(true);
  });
});

describe('net worth scope, cash flow, savings and FIRE', () => {
  it('honors liability, liquid, FIRE and emergency flags without imposing asset eligibility', () => {
    const accounts = [account('cash', { openingBalance: 100000, emergency: true }),
      account('house', { accountType: 'PROPERTY', openingBalance: 500000, includeInLiquidNetWorth: false, includeInFire: false }),
      account('loan', { accountType: 'MORTGAGE', openingBalance: 200000, includeInLiquidNetWorth: false, includeInFire: false }),
      account('private', { openingBalance: 50000, includeInNetWorth: false, includeInLiquidNetWorth: false, includeInFire: false })];
    const result = calculateNetWorth(data({ accounts }), 'PHP', AS_OF);
    expect(result.assets).toBe(600000); expect(result.liabilities).toBe(200000); expect(result.netWorth).toBe(400000);
    expect(result.liquidNetWorth).toBe(-100000); expect(result.fireAssets).toBe(100000);
    expect(result.investableNetWorth).toBe(100000); expect(result.emergencyAssets).toBe(100000);
    expect(result.complete).toBe(true);
  });
  it('reports missing FX as incomplete and retains the known base-currency subtotal', () => {
    const accounts = [account('cash', { openingBalance: 100000 }), account('usd', { currency: 'USD', openingBalance: 10000 })];
    const result = calculateNetWorthFromBalances(accounts, { cash: 100000, usd: 10000 }, [], [], { baseCurrency: 'PHP' }, AS_OF);
    expect(result.netWorth).toBeNull(); expect(result.knownNetWorth).toBe(100000); expect(result.complete).toBe(false);
    expect(result.accountValues.find(row => row.accountId === 'usd')?.baseValue).toBeNull();
    expect(result.issues).toContainEqual({ code: 'missing_fx', accountId: 'usd', currency: 'USD' });
  });
  it('calculates selected cash flow with refunds, category exclusions and transaction-date FX', () => {
    const accounts = [account('cash'), account('usd', { currency: 'USD' })];
    const rows = [transaction('income', { type: 'INCOME', amount: 100000 }),
      transaction('food', { categoryId: 'food', amount: 30000 }), transaction('refund', { type: 'REFUND', categoryId: 'food', amount: 5000 }),
      transaction('exclude', { categoryId: 'business', amount: 7000 }), transaction('usd-expense', { accountId: 'usd', currency: 'USD', date: '2026-10-02', amount: 1000 })];
    const rates = [fx(), fx({ id: 'future-rate', rate: 100, asOf: '2026-10-03T00:00:00Z' })];
    const flow = calculateCashFlow(rows, accounts, { from: '2026-10-01', to: AS_OF, fxRates: rates, excludeCategoryIds: ['business'] });
    expect(flow.income).toBe(100000); expect(flow.expenses).toBe(81000); expect(flow.net).toBe(19000);
    expect(flow.byCategory.food).toBe(25000); expect(calculateSavingsRate(flow).rate).toBe(.19);
    expect(calculateCashFlow(rows, accounts, { to: AS_OF }).expenses).toBeNull();
  });
  it('excludes investment purchases and transfer payments from default savings rate', () => {
    const accounts = [account('cash'), account('loan', { accountType: 'PERSONAL_LOAN' }), account('broker', { accountType: 'BROKERAGE' })];
    const rows = [transaction('income', { type: 'INCOME', amount: 100000 }), transaction('expense', { amount: 30000 }),
      transaction('loanpay', { type: 'TRANSFER', amount: 20000, transferAccountId: 'loan', principalAmount: 20000 }),
      transaction('fund', { type: 'TRANSFER', amount: 10000, transferAccountId: 'broker' }),
      transaction('buy', { type: 'INVESTMENT_BUY', accountId: 'broker', instrumentId: 'stock', units: 1, amount: 5000, fees: 100 })];
    const flow = calculateCashFlow(rows, accounts, { to: AS_OF });
    expect(flow.debtPrincipal).toBe(20000); expect(calculateSavingsRate(flow).rate).toBe(.7);
    expect(calculateSavingsRate(flow, { includeDebtPrincipal: true }).rate).toBe(.5);
    expect(calculateSavingsRate(flow, { includeDebtPrincipal: false }).rate).toBe(.7);
    expect(calculateSavingsRate(flow, { includeInvestmentFees: true }).rate).toBe(.699);
    expect(calculateSavingsRate(calculateCashFlow([], accounts)).rate).toBeNull();
    const unsplit = calculateCashFlow(rows.map(row => row.id === 'loanpay' ? { ...row, principalAmount: undefined } : row), accounts, { to: AS_OF });
    expect(unsplit.debtPrincipal).toBeNull(); expect(unsplit.complete).toBe(true);
    expect(calculateSavingsRate(unsplit).rate).toBe(.7);
    expect(calculateSavingsRate(unsplit, { includeDebtPrincipal: true }).rate).toBeNull();
  });
  it('calculates FIRE assumptions without inventing spending, assets or emergency expenses', () => {
    expect(calculateFire({ annualSpending: 12000000, withdrawalRate: .04, fireAssets: 150000000,
      essentialMonthlyExpenses: 500000, emergencyAssets: 3000000 })).toEqual({ target: 300000000, progress: .5, gap: 150000000, emergencyMonths: 6 });
    expect(calculateFire({ annualSpending: 0, withdrawalRate: .04, fireAssets: 0 }).target).toBeNull();
    expect(calculateFire({ annualSpending: 10000, withdrawalRate: .04, fireAssets: null }).progress).toBeNull();
    expect(calculateFire({ annualSpending: 10000, withdrawalRate: .04, fireAssets: 300000 }).gap).toBe(0);
    expect(() => calculateFire({ annualSpending: 10000, withdrawalRate: 0, fireAssets: 0 })).toThrow();
    expect(calculateFire({ annualSpending: 0, withdrawalRate: .04, fireAssets: 0,
      essentialMonthlyExpenses: 10000 / 12, emergencyAssets: 10000 }).emergencyMonths).toBe(12);
  });
});

describe('budgets, debt, duplicate preview and dated history', () => {
  const categories: Category[] = [{ id: 'needs', name: 'Needs', kind: 'expense', color: '#000', essential: true, archived: false },
    { id: 'food', name: 'Food', parentId: 'needs', kind: 'expense', color: '#000', essential: true, archived: false }];
  const budget: Budget = { id: 'budget', categoryId: 'needs', period: '2026-10', periodType: 'monthly', amount: 100000, currency: 'PHP' };
  it('includes child expenses, subtracts refunds and ignores investments/transfers in budgets', () => {
    const accounts = [account('cash'), account('other')];
    const rows = [transaction('food', { categoryId: 'food', amount: 20000 }),
      transaction('refund', { type: 'REFUND', categoryId: 'food', amount: 5000 }),
      transaction('transfer', { type: 'TRANSFER', categoryId: 'food', amount: 80000, transferAccountId: 'other' }),
      transaction('buy', { type: 'INVESTMENT_BUY', categoryId: 'food', instrumentId: 'stock', units: 10, amount: 50000 }),
      transaction('future', { date: '2026-10-20', categoryId: 'food', amount: 90000 })];
    const result = calculateBudget(budget, rows, accounts, categories, [], '2026-10-15');
    expect(result.spent).toBe(15000); expect(result.remaining).toBe(85000); expect(result.percentUsed).toBe(15);
    expect(result.projectedSpend).toBe(31000); expect(result.complete).toBe(true);
    expect(calculateBudget({ ...budget, includeChildren: false }, rows, accounts, categories, [], AS_OF).spent).toBe(0);
    expect(calculateBudget({ ...budget, amount: 0 }, rows, accounts, categories, [], AS_OF).percentUsed).toBeNull();
  });
  it('uses exact calendar month lengths and annual periods, handling category cycles safely', () => {
    expect(periodBounds('2024-02', 'monthly')).toEqual({ from: '2024-02-01', to: '2024-02-29' });
    expect(periodBounds('2026', 'annual')).toEqual({ from: '2026-01-01', to: '2026-12-31' });
    expect(() => periodBounds('2026-13', 'monthly')).toThrow();
    expect(categoryDescendants('needs', [{ ...categories[0], parentId: 'food' }, categories[1]])).toEqual(new Set(['needs', 'food']));
    expect(calculateBudget(budget, [], [account('cash')], categories, [], '2026-09-30').projectedSpend).toBe(0);
  });
  it('amortizes zero-rate loans with an exact payoff and separate interest/principal totals', () => {
    const plan = calculateAmortization(10000, 0, 3);
    expect(plan.monthlyPayment).toBe(3333); expect(plan.totalInterest).toBe(0); expect(plan.totalPaid).toBe(10000);
    expect(plan.schedule.map(row => row.payment)).toEqual([3333, 3333, 3334]);
    expect(plan.schedule.at(-1)?.balance).toBe(0);
    expect(calculateAmortization(0, .06, 12).schedule).toEqual([]);
  });
  it('computes interest schedules without overflow, negative rates or invalid terms', () => {
    const plan = calculateAmortization(1000000, .12, 12);
    expect(plan.monthlyPayment).toBe(88849); expect(plan.schedule).toHaveLength(12);
    expect(plan.schedule.reduce((sum, row) => sum + row.principal, 0)).toBe(1000000);
    expect(plan.totalPaid).toBe(1000000 + plan.totalInterest); expect(plan.schedule.at(-1)?.balance).toBe(0);
    expect(plan.schedule.every(row => row.payment === row.principal + row.interest && row.balance >= 0)).toBe(true);
    for (const args of [[-1, .1, 12], [100, -.1, 12], [100, .1, 0], [100, .1, 1.5], [Number.MAX_SAFE_INTEGER, 100, 12]] as const) {
      expect(() => calculateAmortization(args[0], args[1], args[2])).toThrow(FinanceValidationError);
    }
  });
  it('provides duplicate preview matches without removing legitimate same-day transactions', () => {
    const first = transaction('one', { merchant: '  Coffee   SHOP ', reference: ' Ref-1' });
    const second = { ...first, id: 'two', merchant: 'coffee shop', reference: 'ref-1', createdAt: NOW };
    expect(transactionFingerprint(first)).toBe(transactionFingerprint(second));
    expect(transactionFingerprint({ ...second, reference: 'ref-2' })).not.toBe(transactionFingerprint(first));
    expect(findDuplicateTransactions([first], [second, { ...second, id: 'three', reference: 'ref-2' }])).toEqual([{ index: 0, matches: ['one'] }]);
    expect(findDuplicateTransactions([], [first, second])).toEqual([{ index: 1, matches: ['one'] }]);
    expect(buildLedger([account('cash', { openingBalance: 100000 })], [first, second], AS_OF).balances.cash.PHP).toBe(80000);
  });
  it('safely aggregates reserved object-key strings as ordinary user labels', () => {
    const accounts = [account('__proto__', { openingBalance: 10000 })];
    const rows = [transaction('one', { accountId: '__proto__', categoryId: 'constructor', amount: 1000 })];
    expect(accountBalances(accounts, rows, AS_OF)['__proto__'].PHP).toBe(9000);
    expect(calculateCashFlow(rows, accounts, { to: AS_OF }).byCategory.constructor).toBe(1000);
  });
  it('produces exact requested historical dates with no future transaction, quote or FX leakage', () => {
    const accounts = [account('cash', { openingBalance: 200000, accountType: 'BROKERAGE' }),
      account('usd', { openingBalance: 10000, currency: 'USD', openingDate: '2026-10-02' })];
    const buy = transaction('buy', { type: 'INVESTMENT_BUY', instrumentId: 'stock', units: 10, amount: 100000, date: '2026-10-02' });
    const snapshots = netWorthHistory(data({ accounts, transactions: [buy], instruments: [instrument()],
      prices: [price('old', 110, '2026-10-02T08:00:00Z'), price('new', 150, '2026-10-03T08:00:00Z')],
      fxRates: [fx(), fx({ id: 'new', rate: 60, asOf: '2026-10-03T00:00:00Z' })] }), 'PHP', ['2026-10-03', '2026-10-01', '2026-10-02', '2026-10-02']);
    expect(snapshots.map(row => row.date)).toEqual(['2026-10-01', '2026-10-02', '2026-10-03']);
    expect(snapshots.map(row => row.netWorth)).toEqual([200000, 770000, 850000]);
    expect(snapshots.every(row => row.complete)).toBe(true);
  });
  it('aggregates a 100,000-entry ledger without counting transfers as consumption', () => {
    const accounts = [account('cash', { openingBalance: 100000 }), account('other')];
    const rows = Array.from({ length: 100000 }, (_, index) => transaction(`entry-${index}`, {
      type: 'TRANSFER', amount: 1, accountId: index % 2 ? 'other' : 'cash', transferAccountId: index % 2 ? 'cash' : 'other',
    }));
    expect(accountBalances(accounts, rows, AS_OF)).toEqual({ cash: { PHP: 100000 }, other: { PHP: 0 } });
    expect(calculateCashFlow(rows, accounts, { to: AS_OF }).expenses).toBe(0);
  });
});
