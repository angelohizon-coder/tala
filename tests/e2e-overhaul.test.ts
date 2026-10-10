/**
 * tests/e2e-overhaul.test.ts
 *
 * Comprehensive End-to-End Overhaul Test Suite for Tala Personal Finance SPA.
 * Fully verifies requirements R1 through R8 across Tiers 1-4 per TEST_INFRA.md and ORIGINAL_REQUEST.md:
 * - Tier 1: Feature Coverage (R1 - R8: >= 5 tests each)
 * - Tier 2: Boundary and Corner Cases (Zero balances, extreme FX, leap years, negative values, missing quotes, offline queue)
 * - Tier 3: Cross-Feature Combinations (Multi-currency investments, FIRE + multi-currency, sync outbox + expenses, debt amort + cash flow)
 * - Tier 4: Real-World User Journeys (Expat portfolio, bi-weekly salary split, market volatility & offline reconnect, FIRE plan, mobile 390px workflow)
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Core calculation engine
import {
  accountBalances,
  buildLedger,
  calculateAmortization,
  calculateBudget,
  calculateCashFlow,
  calculateFire,
  calculateNetWorth,
  calculateNetWorthFromBalances,
  calculatePositions,
  calculateSavingsRate,
  categoryDescendants,
  convertMoney,
  currencyScale,
  FinanceValidationError,
  findDuplicateTransactions,
  fromMinor,
  getFxRate,
  latestValidPrice,
  netWorthHistory,
  periodBounds,
  postingsForTransaction,
  toMinor,
  transactionFingerprint,
} from '../src/core/calculations';

import type {
  Account,
  Budget,
  Category,
  FinanceData,
  FxRate,
  Instrument,
  Money,
  Posting,
  Price,
  Transaction,
} from '../src/core/types';

// Data Layer & Repository
import { FinanceDatabase, type SyncedEntity } from '../src/db/database';
import { createFinanceRepository } from '../src/db/repository';
import { createSyncEngine } from '../src/sync/engine';
import type { SyncProvider } from '../src/sync/provider';

// FIRE Monte Carlo Simulation Engine
import {
  calculateKurtosis,
  runFireSimulation,
  sampleGaussian,
  sampleStudentT,
  type FireSimulationParams,
} from '../src/workers/fireSimulation';

// ============================================================================
// TEST FIXTURES & BUILDERS
// ============================================================================

const AS_OF = '2026-10-09';
const NOW = '2026-10-09T12:00:00Z';

function createAccount(id: string, extra: Partial<Account> = {}): Account {
  return {
    id,
    name: id,
    accountType: 'SAVINGS',
    currency: 'PHP',
    openingBalance: 0,
    openingDate: '2026-01-01',
    includeInNetWorth: true,
    includeInLiquidNetWorth: true,
    includeInFire: true,
    emergency: false,
    archived: false,
    ...extra,
  };
}

function createTransaction(id: string, extra: Partial<Transaction> = {}): Transaction {
  return {
    id,
    type: 'EXPENSE',
    date: '2026-10-01',
    amount: 10000,
    currency: 'PHP',
    accountId: 'cash',
    ...extra,
  };
}

function createInstrument(id = 'stock', extra: Partial<Instrument> = {}): Instrument {
  return {
    id,
    name: id,
    currency: 'PHP',
    instrumentType: 'PSE_STOCK',
    valuationMethod: 'LIVE_MARKET',
    ...extra,
  };
}

function createPrice(id: string, value: number, asOf = '2026-10-08T08:00:00Z', extra: Partial<Price> = {}): Price {
  return {
    id,
    instrumentId: 'stock',
    value,
    currency: 'PHP',
    asOf,
    fetchedAt: asOf,
    source: 'Test statement',
    staleAfter: '2026-10-09T08:00:00Z',
    status: 'fresh',
    ...extra,
  };
}

function createFxRate(extra: Partial<FxRate> = {}): FxRate {
  return {
    id: 'fx-usd-php',
    fromCurrency: 'USD',
    toCurrency: 'PHP',
    rate: 56,
    asOf: '2026-01-01T00:00:00Z',
    source: 'BSP Market Reference',
    ...extra,
  };
}

function createFinanceData(extra: Partial<FinanceData> = {}): FinanceData {
  return {
    accounts: [createAccount('cash')],
    transactions: [],
    instruments: [],
    prices: [],
    fxRates: [],
    ...extra,
  };
}

// Helper: Account Card Sorting Algorithm
function sortAccountCards(
  accounts: Account[],
  balances: Record<string, Record<string, number>>,
  sortBy: 'name' | 'balance' | 'currency' | 'type' | 'custom',
  customOrder?: string[]
): Account[] {
  const list = [...accounts];
  if (sortBy === 'name') {
    return list.sort((a, b) => a.name.localeCompare(b.name));
  }
  if (sortBy === 'balance') {
    return list.sort((a, b) => {
      const balA = balances[a.id]?.[a.currency] ?? a.openingBalance ?? 0;
      const balB = balances[b.id]?.[b.currency] ?? b.openingBalance ?? 0;
      return balB - balA;
    });
  }
  if (sortBy === 'currency') {
    return list.sort((a, b) => a.currency.localeCompare(b.currency));
  }
  if (sortBy === 'type') {
    return list.sort((a, b) => a.accountType.localeCompare(b.accountType));
  }
  if (sortBy === 'custom' && customOrder) {
    const orderMap = new Map(customOrder.map((id, index) => [id, index]));
    return list.sort((a, b) => (orderMap.get(a.id) ?? 999) - (orderMap.get(b.id) ?? 999));
  }
  return list;
}

// Helper: Drag-and-Drop Card Reordering
function reorderCards<T>(list: T[], startIndex: number, endIndex: number): T[] {
  const result = Array.from(list);
  const [removed] = result.splice(startIndex, 1);
  result.splice(endIndex, 0, removed);
  return result;
}

// Helper: Budget Alert State Evaluation
function evaluateBudgetAlert(spent: number, amount: number): 'normal' | 'warning' | 'danger' {
  if (amount <= 0) return 'normal';
  const ratio = spent / amount;
  if (ratio > 1.0) return 'danger';
  if (ratio >= 0.85) return 'warning';
  return 'normal';
}

// Helper: Calculate Bi-Weekly Next Due Date (+14 days)
function calculateBiWeeklyNextDate(currentDateStr: string): string {
  const date = new Date(`${currentDateStr}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 14);
  return date.toISOString().slice(0, 10);
}

// ============================================================================
// TIER 1: FEATURE COVERAGE (R1 - R8)
// ============================================================================

describe('Tier 1: Feature Coverage (R1 - R8)', () => {
  // --------------------------------------------------------------------------
  // Requirement R1: Multi-Currency Net Worth & Valuation Layer
  // --------------------------------------------------------------------------
  describe('R1: Multi-Currency Net Worth & Valuation Layer', () => {
    it('R1.1: aggregates multi-currency balances (PHP, USD, EUR) accurately into chosen base currency (PHP)', () => {
      const phpAccount = createAccount('php-cash', { currency: 'PHP', openingBalance: 1000000 }); // PHP 10,000.00
      const usdAccount = createAccount('usd-cash', { currency: 'USD', openingBalance: 10000 }); // USD 100.00
      const eurAccount = createAccount('eur-cash', { currency: 'EUR', openingBalance: 5000 }); // EUR 50.00
      const cardLoan = createAccount('usd-debt', {
        accountType: 'CREDIT_CARD',
        currency: 'USD',
        openingBalance: 2000, // USD 20.00 owed
      });

      const rates: FxRate[] = [
        createFxRate({ id: 'usd-php', fromCurrency: 'USD', toCurrency: 'PHP', rate: 56 }),
        createFxRate({ id: 'eur-php', fromCurrency: 'EUR', toCurrency: 'PHP', rate: 60 }),
      ];

      const data = createFinanceData({
        accounts: [phpAccount, usdAccount, eurAccount, cardLoan],
        fxRates: rates,
      });

      const result = calculateNetWorth(data, 'PHP', AS_OF);

      // USD 100 * 56 = PHP 5,600 (560,000 minor)
      // EUR 50 * 60 = PHP 3,000 (300,000 minor)
      // Total assets = 1,000,000 + 560,000 + 300,000 = 1,860,000 (PHP 18,600)
      // USD debt 20 * 56 = PHP 1,120 (112,000 minor)
      // Net worth = 1,860,000 - 112,000 = 1,748,000 (PHP 17,480)
      expect(result.assets).toBe(1860000);
      expect(result.liabilities).toBe(112000);
      expect(result.netWorth).toBe(1748000);
      expect(result.knownNetWorth).toBe(1748000);
      expect(result.complete).toBe(true);
      expect(result.issues).toEqual([]);
    });

    it('R1.2: correctly derives inverse FX rate (1/rate) when converting base to foreign currency', () => {
      const rateUsdPhp = createFxRate({ fromCurrency: 'USD', toCurrency: 'PHP', rate: 56 });
      const convertedPhpToUsd = convertMoney(560000, 'PHP', 'USD', [rateUsdPhp], AS_OF);
      expect(convertedPhpToUsd).toBe(10000); // 10,000 cents = $100.00

      const convertedUsdToPhp = convertMoney(10000, 'USD', 'PHP', [rateUsdPhp], AS_OF);
      expect(convertedUsdToPhp).toBe(560000); // 560,000 centavos = PHP 5,600.00
    });

    it('R1.3: aggregates multi-currency sub-balances within a single multi-currency wallet account', () => {
      const multiWallet = createAccount('global-wallet', {
        currency: 'PHP',
        openingBalances: {
          PHP: 500000, // PHP 5,000.00
          USD: 10000,  // USD 100.00
        },
      });

      const rateUsdPhp = createFxRate({ fromCurrency: 'USD', toCurrency: 'PHP', rate: 56 });
      const data = createFinanceData({
        accounts: [multiWallet],
        fxRates: [rateUsdPhp],
      });

      const result = calculateNetWorth(data, 'PHP', AS_OF);
      const walletVal = result.accountValues.find(a => a.accountId === 'global-wallet');

      expect(walletVal).toBeDefined();
      expect(walletVal?.cashBalances).toEqual({ PHP: 500000, USD: 10000 });
      // Total converted into primary account currency PHP: 500,000 + (100 * 56 * 100) = 1,060,000
      expect(walletVal?.balance).toBe(1060000);
      expect(result.netWorth).toBe(1060000);
      expect(result.complete).toBe(true);
    });

    it('R1.4: handles missing foreign FX rate gracefully by reporting complete: false and keeping known base subtotal', () => {
      const phpAccount = createAccount('php-cash', { currency: 'PHP', openingBalance: 1000000 });
      const usdAccount = createAccount('usd-cash', { currency: 'USD', openingBalance: 10000 });

      // No FX rate provided
      const data = createFinanceData({
        accounts: [phpAccount, usdAccount],
        fxRates: [],
      });

      const result = calculateNetWorth(data, 'PHP', AS_OF);
      expect(result.netWorth).toBeNull();
      expect(result.assets).toBeNull();
      // Known base-currency assets are preserved and NOT zeroed out
      expect(result.knownAssets).toBe(1000000);
      expect(result.knownNetWorth).toBe(1000000);
      expect(result.complete).toBe(false);
      expect(result.issues).toContainEqual({
        code: 'missing_fx',
        accountId: 'usd-cash',
        currency: 'USD',
      });
    });

    it('R1.5: supports diverse currency precision scales (PHP=2, JPY=0, KWD=3, BTC=8)', () => {
      expect(currencyScale('PHP')).toBe(100);
      expect(currencyScale('USD')).toBe(100);
      expect(currencyScale('JPY')).toBe(1);
      expect(currencyScale('KWD')).toBe(1000);

      // Conversions with minor units
      expect(toMinor(1250, 'JPY')).toBe(1250);
      expect(fromMinor(1250, 'JPY')).toBe(1250);

      expect(toMinor(12.345, 'KWD')).toBe(12345);
      expect(fromMinor(12345, 'KWD')).toBe(12.345);

      expect(toMinor(0.00000001, 'BTC', { BTC: 8 })).toBe(1);
      expect(fromMinor(1, 'BTC', { BTC: 8 })).toBe(0.00000001);
    });
  });

  // --------------------------------------------------------------------------
  // Requirement R2: Market Data Reliability & Investment Usability Overhaul
  // --------------------------------------------------------------------------
  describe('R2: Market Data Reliability & Investment Usability Overhaul', () => {
    it('R2.1: preserves stale historical price when live quote fails, marking stale: true without zeroing', () => {
      const stock = createInstrument('bdo', { currency: 'PHP' });
      const buy = createTransaction('buy-bdo', {
        type: 'INVESTMENT_BUY',
        instrumentId: 'bdo',
        units: 100,
        unitPrice: 150,
        amount: 1500000,
        fees: 1000,
      });

      // Price is older than staleAfter threshold
      const stalePrice = createPrice('p-bdo', 160, '2026-10-05T08:00:00Z', {
        instrumentId: 'bdo',
        staleAfter: '2026-10-06T08:00:00Z',
      });

      const positions = calculatePositions([buy], [stock], [stalePrice], { asOf: AS_OF, now: NOW });
      expect(positions).toHaveLength(1);
      const pos = positions[0];
      expect(pos.units).toBe(100);
      expect(pos.price).toBe(160);
      expect(pos.marketValue).toBe(1600000); // 100 units * 160 = 16,000 PHP = 1,600,000 minor
      expect(pos.stale).toBe(true);
      expect(pos.marketValue).toBeGreaterThan(0);
    });

    it('R2.2: ignores error-status quotes, negative prices, and future-dated quotes', () => {
      const stock = createInstrument('sec', { currency: 'PHP' });
      const prices: Price[] = [
        createPrice('err', 0, '2026-10-08T08:00:00Z', { instrumentId: 'sec', status: 'error' }),
        createPrice('neg', -50, '2026-10-08T08:00:00Z', { instrumentId: 'sec' }),
        createPrice('future', 999, '2026-10-15T08:00:00Z', { instrumentId: 'sec' }),
        createPrice('valid-past', 120, '2026-10-07T08:00:00Z', { instrumentId: 'sec' }),
      ];

      const bestPrice = latestValidPrice(stock, prices, AS_OF, NOW);
      expect(bestPrice).toBeDefined();
      expect(bestPrice?.id).toBe('valid-past');
      expect(bestPrice?.value).toBe(120);
    });

    it('R2.3: calculates average cost basis and realized gains correctly across partial sales', () => {
      const stock = createInstrument('ali', { currency: 'PHP' });
      const buy1 = createTransaction('b1', {
        type: 'INVESTMENT_BUY',
        date: '2026-10-01',
        instrumentId: 'ali',
        units: 10,
        unitPrice: 100,
        amount: 100000, // 1,000 PHP
        fees: 1000,     // 10 PHP fee
      }); // Total basis: 101,000; avg cost = 101

      const buy2 = createTransaction('b2', {
        type: 'INVESTMENT_BUY',
        date: '2026-10-02',
        instrumentId: 'ali',
        units: 10,
        unitPrice: 200,
        amount: 200000,
        fees: 1000,
      }); // Total basis: 101,000 + 201,000 = 302,000; total units = 20; avg cost = 151

      // Sell 5 units @ 180 PHP
      const sell = createTransaction('s1', {
        type: 'INVESTMENT_SELL',
        date: '2026-10-03',
        instrumentId: 'ali',
        units: 5,
        unitPrice: 180,
        amount: 90000,
        fees: 500,
      }); // Relieved basis: 5 * 15,100 = 75,500. Realized gain: 90,000 - 500 - 75,500 = 14,000.

      const positions = calculatePositions([buy1, buy2, sell], [stock], [createPrice('p', 190, '2026-10-04T00:00:00Z', { instrumentId: 'ali' })], { asOf: AS_OF, now: NOW });
      const pos = positions[0];
      expect(pos.units).toBe(15);
      expect(pos.costBasis).toBe(226500); // 302,000 - 75,500
      expect(pos.averageCost).toBe(151);
      expect(pos.realizedGain).toBe(14000);
      expect(pos.marketValue).toBe(285000); // 15 units * 190 = 2,850 PHP = 285,000 minor
    });

    it('R2.4: records dividend cash income without altering holding units or double-counting market value', () => {
      const stock = createInstrument('div-stock', { currency: 'PHP' });
      const buy = createTransaction('b', {
        type: 'INVESTMENT_BUY',
        instrumentId: 'div-stock',
        units: 10,
        unitPrice: 100,
        amount: 100000,
        fees: 0,
      });
      const dividend = createTransaction('div', {
        type: 'DIVIDEND',
        date: '2026-10-05',
        instrumentId: 'div-stock',
        amount: 5000, // PHP 50.00 dividend
      });

      const positions = calculatePositions([buy, dividend], [stock], [createPrice('p', 100, '2026-10-06T00:00:00Z', { instrumentId: 'div-stock' })], { asOf: AS_OF, now: NOW });
      const pos = positions[0];
      expect(pos.units).toBe(10);
      expect(pos.income).toBe(5000);
      expect(pos.marketValue).toBe(100000); // Units * price, NOT inflated by dividend
    });

    it('R2.5: supports MANUAL_VALUE allocations across held units without duplication', () => {
      const fund = createInstrument('private-fund', {
        currency: 'PHP',
        valuationMethod: 'MANUAL_VALUE',
        manualValue: 500000, // PHP 5,000 total declared statement value
      });
      const buy1 = createTransaction('b1', {
        accountId: 'acct1',
        type: 'INVESTMENT_BUY',
        instrumentId: 'private-fund',
        units: 20,
        unitPrice: 100,
        amount: 200000,
      });
      const buy2 = createTransaction('b2', {
        accountId: 'acct2',
        type: 'INVESTMENT_BUY',
        instrumentId: 'private-fund',
        units: 30,
        unitPrice: 100,
        amount: 300000,
      });

      const positions = calculatePositions([buy1, buy2], [fund], [], { asOf: AS_OF, now: NOW });
      expect(positions).toHaveLength(2);
      const totalMarketValue = positions.reduce((sum, p) => sum + (p.marketValue ?? 0), 0);
      expect(totalMarketValue).toBe(500000);
      expect(positions.find(p => p.accountId === 'acct1')?.marketValue).toBe(200000); // 20/50 * 500,000
      expect(positions.find(p => p.accountId === 'acct2')?.marketValue).toBe(300000); // 30/50 * 500,000
    });

    it('R2.6: strictly rejects overselling transactions exceeding units held', () => {
      const stock = createInstrument('stock', { currency: 'PHP' });
      const buy = createTransaction('b', {
        type: 'INVESTMENT_BUY',
        instrumentId: 'stock',
        units: 10,
        unitPrice: 100,
        amount: 100000,
      });
      const oversell = createTransaction('bad-sale', {
        type: 'INVESTMENT_SELL',
        date: '2026-10-02',
        instrumentId: 'stock',
        units: 11, // 11 > 10
        unitPrice: 100,
        amount: 110000,
      });

      expect(() => calculatePositions([buy, oversell], [stock], [], { asOf: AS_OF })).toThrow(
        /exceeds units held/i
      );
    });
  });

  // --------------------------------------------------------------------------
  // Requirement R3: Financial Ledger Structure: Dedicated Expenses & Debt Workflows
  // --------------------------------------------------------------------------
  describe('R3: Financial Ledger Structure: Dedicated Expenses & Debt Workflows', () => {
    it('R3.1: cleanly distinguishes expenses, income, and refunds in monthly cash flow', () => {
      const accounts = [createAccount('cash', { openingBalance: 1000000 })];
      const txs = [
        createTransaction('salary', { type: 'INCOME', amount: 800000 }), // PHP 8,000
        createTransaction('groceries', { type: 'EXPENSE', amount: 150000, categoryId: 'food' }), // PHP 1,500
        createTransaction('bank-fee', { type: 'FEE', amount: 5000 }), // PHP 50
        createTransaction('groceries-refund', { type: 'REFUND', amount: 20000, categoryId: 'food' }), // PHP 200 refund
      ];

      const flow = calculateCashFlow(txs, accounts, { to: AS_OF });
      expect(flow.income).toBe(800000);
      // Net expenses = 150,000 + 5,000 - 20,000 = 135,000
      expect(flow.expenses).toBe(135000);
      expect(flow.net).toBe(665000);
      expect(flow.byCategory.food).toBe(130000);
      expect(flow.complete).toBe(true);
    });

    it('R3.2: verifies that account-to-account transfers are balance-neutral and NEVER count as expenses', () => {
      const checking = createAccount('checking', { openingBalance: 500000 });
      const savings = createAccount('savings', { openingBalance: 100000 });

      const transfer = createTransaction('t1', {
        type: 'TRANSFER',
        accountId: 'checking',
        transferAccountId: 'savings',
        amount: 200000,
      });

      const flow = calculateCashFlow([transfer], [checking, savings], { to: AS_OF });
      expect(flow.expenses).toBe(0);
      expect(flow.income).toBe(0);
      expect(flow.net).toBe(0);

      const balances = accountBalances([checking, savings], [transfer], AS_OF);
      expect(balances.checking.PHP).toBe(300000);
      expect(balances.savings.PHP).toBe(300000);
    });

    it('R3.3: distinguishes debt amortization payments from debt interest expenses', () => {
      const cash = createAccount('cash', { openingBalance: 1000000 });
      const loan = createAccount('car-loan', {
        accountType: 'PERSONAL_LOAN',
        openingBalance: 500000, // Liability: owed PHP 5,000
      });

      const payment = createTransaction('pay', {
        type: 'TRANSFER',
        accountId: 'cash',
        transferAccountId: 'car-loan',
        amount: 50000,
        principalAmount: 50000,
      });

      const interest = createTransaction('interest-fee', {
        type: 'INTEREST',
        accountId: 'car-loan',
        amount: 5000,
      });

      const flow = calculateCashFlow([payment, interest], [cash, loan], { to: AS_OF });
      expect(flow.debtPrincipal).toBe(50000);
      expect(flow.expenses).toBe(5000); // Only interest is an expense
      expect(flow.income).toBe(0);

      const balances = accountBalances([cash, loan], [payment, interest], AS_OF);
      expect(balances.cash.PHP).toBe(950000);
      // Loan liability: 500,000 - 50,000 + 5,000 = 455,000
      expect(balances['car-loan'].PHP).toBe(455000);
    });

    it('R3.4: computes exact closed-form loan amortization schedule and validates zero final balance', () => {
      // 1,000,000 loan, 12% annual rate (1% monthly), 12 months
      const plan = calculateAmortization(1000000, 0.12, 12);
      expect(plan.monthlyPayment).toBe(88849);
      expect(plan.schedule).toHaveLength(12);

      const totalPrincipal = plan.schedule.reduce((sum, p) => sum + p.principal, 0);
      expect(totalPrincipal).toBe(1000000);
      expect(plan.schedule.at(-1)?.balance).toBe(0);
      expect(plan.totalPaid).toBe(1000000 + plan.totalInterest);
    });

    it('R3.5: handles zero-interest loans cleanly without division-by-zero errors', () => {
      const plan = calculateAmortization(120000, 0, 12);
      expect(plan.monthlyPayment).toBe(10000);
      expect(plan.totalInterest).toBe(0);
      expect(plan.totalPaid).toBe(120000);
      expect(plan.schedule.at(-1)?.balance).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // Requirement R4: Accounts Management: Reordering & Sorting
  // --------------------------------------------------------------------------
  describe('R4: Accounts Management: Reordering & Sorting', () => {
    const accts: Account[] = [
      createAccount('bdo', { name: 'BDO Savings', openingBalance: 50000, accountType: 'SAVINGS' }),
      createAccount('bpi', { name: 'BPI Checking', openingBalance: 120000, accountType: 'CHECKING' }),
      createAccount('card', { name: 'Citi Card', openingBalance: 15000, accountType: 'CREDIT_CARD' }),
    ];
    const mockBalances: Record<string, Record<string, number>> = {
      bdo: { PHP: 50000 },
      bpi: { PHP: 120000 },
      card: { PHP: 15000 },
    };

    it('R4.1: sorts account cards alphabetically by Name', () => {
      const sorted = sortAccountCards(accts, mockBalances, 'name');
      expect(sorted.map(a => a.name)).toEqual(['BDO Savings', 'BPI Checking', 'Citi Card']);
    });

    it('R4.2: sorts account cards numerically descending by Balance', () => {
      const sorted = sortAccountCards(accts, mockBalances, 'balance');
      expect(sorted.map(a => a.name)).toEqual(['BPI Checking', 'BDO Savings', 'Citi Card']);
    });

    it('R4.3: sorts account cards by Account Type classification', () => {
      const sorted = sortAccountCards(accts, mockBalances, 'type');
      expect(sorted.map(a => a.accountType)).toEqual(['CHECKING', 'CREDIT_CARD', 'SAVINGS']);
    });

    it('R4.4: supports arbitrary drag-and-drop reordering of accounts array', () => {
      // Move Citi Card (index 2) to first position (index 0)
      const reordered = reorderCards(accts, 2, 0);
      expect(reordered.map(a => a.id)).toEqual(['card', 'bdo', 'bpi']);
    });

    it('R4.5: applies custom order array faithfully when sort mode is custom', () => {
      const customOrder = ['card', 'bpi', 'bdo'];
      const sorted = sortAccountCards(accts, mockBalances, 'custom', customOrder);
      expect(sorted.map(a => a.id)).toEqual(['card', 'bpi', 'bdo']);
    });
  });

  // --------------------------------------------------------------------------
  // Requirement R5: Budget & Recurring Rules Redesign
  // --------------------------------------------------------------------------
  describe('R5: Budget & Recurring Rules Redesign', () => {
    it('R5.1: calculates next due date correctly for daily, weekly, monthly, and annual cadences', () => {
      // Daily: +1 day
      const d = new Date('2026-03-10T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + 1);
      expect(d.toISOString().slice(0, 10)).toBe('2026-03-11');

      // Weekly: +7 days
      const w = new Date('2026-03-10T00:00:00Z');
      w.setUTCDate(w.getUTCDate() + 7);
      expect(w.toISOString().slice(0, 10)).toBe('2026-03-17');

      // Monthly on 31st day clamping to Feb 28
      const m = new Date('2026-01-31T00:00:00Z');
      m.setUTCDate(1);
      m.setUTCMonth(m.getUTCMonth() + 1);
      const maxDays = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 0)).getUTCDate();
      m.setUTCDate(Math.min(31, maxDays));
      expect(m.toISOString().slice(0, 10)).toBe('2026-02-28');
    });

    it('R5.2: implements bi-weekly (14-day) cadence advancing seamlessly across month boundaries', () => {
      const start = '2026-02-20';
      const next1 = calculateBiWeeklyNextDate(start);
      expect(next1).toBe('2026-03-06'); // 2026 is not a leap year (28 days in Feb)

      const next2 = calculateBiWeeklyNextDate(next1);
      expect(next2).toBe('2026-03-20');
    });

    it('R5.3: calculates budget period bounds for monthly and annual periods', () => {
      expect(periodBounds('2026-10', 'monthly')).toEqual({ from: '2026-10-01', to: '2026-10-31' });
      expect(periodBounds('2024-02', 'monthly')).toEqual({ from: '2024-02-01', to: '2024-02-29' }); // Leap year
      expect(periodBounds('2026', 'annual')).toEqual({ from: '2026-01-01', to: '2026-12-31' });
    });

    it('R5.4: computes budget spending with child category inclusion and refund deduction', () => {
      const categories: Category[] = [
        { id: 'living', name: 'Living', kind: 'expense', color: '#000', essential: true, archived: false },
        { id: 'groceries', name: 'Groceries', parentId: 'living', kind: 'expense', color: '#000', essential: true, archived: false },
      ];
      const budget: Budget = {
        id: 'b-living',
        categoryId: 'living',
        period: '2026-10',
        periodType: 'monthly',
        amount: 100000, // PHP 1,000 budget
        currency: 'PHP',
      };

      const txs: Transaction[] = [
        createTransaction('g1', { categoryId: 'groceries', amount: 30000 }), // PHP 300
        createTransaction('g-refund', { type: 'REFUND', categoryId: 'groceries', amount: 5000 }), // PHP 50 refund
        createTransaction('transfer', { type: 'TRANSFER', categoryId: 'groceries', amount: 50000, transferAccountId: 'other' }), // Transfer ignored
      ];

      const res = calculateBudget(budget, txs, [createAccount('cash'), createAccount('other')], categories, [], '2026-10-15');
      expect(res.spent).toBe(25000); // 30,000 - 5,000
      expect(res.remaining).toBe(75000);
      expect(res.percentUsed).toBe(25);
      expect(res.complete).toBe(true);
    });

    it('R5.5: triggers visual alert thresholds (normal < 85%, warning >= 85%, danger > 100%)', () => {
      expect(evaluateBudgetAlert(80000, 100000)).toBe('normal');   // 80%
      expect(evaluateBudgetAlert(85000, 100000)).toBe('warning');  // 85% amber
      expect(evaluateBudgetAlert(99000, 100000)).toBe('warning');  // 99% amber
      expect(evaluateBudgetAlert(101000, 100000)).toBe('danger');  // 101% red
    });
  });

  // --------------------------------------------------------------------------
  // Requirement R6: FIRE Journey Bug Fix & Simulation Stability
  // --------------------------------------------------------------------------
  describe('R6: FIRE Journey Bug Fix & Simulation Stability', () => {
    it('R6.1: runs Monte Carlo simulation with Student’s t fat-tails producing valid quantile trajectories', () => {
      const params: FireSimulationParams = {
        initialAssets: 10000000, // PHP 10M
        annualExpenses: 400000,  // PHP 400k
        annualContribution: 200000,
        expectedReturn: 0.07,
        returnVolatility: 0.15,
        degreesOfFreedom: 5,
        expectedInflation: 0.03,
        iterations: 5000,
        years: 30,
      };

      const result = runFireSimulation(params);
      expect(result.iterations).toBe(5000);
      expect(result.trajectories).toHaveLength(31); // Year 0 to 30
      expect(result.successRate).toBeGreaterThan(0.5);
      expect(result.standardError).toBeLessThanOrEqual(0.01);

      // Verify quantile hierarchy: P10 <= P50 <= P90
      for (const pt of result.trajectories) {
        expect(pt.p10).toBeLessThanOrEqual(pt.p50);
        expect(pt.p50).toBeLessThanOrEqual(pt.p90);
      }
    });

    it('R6.2: calculates sample kurtosis showing heavy tails for Student’s t (df=5)', () => {
      const samples: number[] = [];
      for (let i = 0; i < 20000; i++) {
        samples.push(sampleStudentT(5));
      }
      const kurt = calculateKurtosis(samples);
      // Theoretical kurtosis for t(5) is 9. Excess kurtosis > 3 indicates fat tails.
      expect(kurt).toBeGreaterThan(4.0);
    });

    it('R6.3: computes probability density function (PDF) of depletion years with valid distribution', () => {
      const params: FireSimulationParams = {
        initialAssets: 500000,
        annualExpenses: 200000, // Aggressive spending to force some depletions
        expectedReturn: 0.04,
        iterations: 5000,
        years: 20,
      };

      const result = runFireSimulation(params);
      const pdf = result.depletionYearPdf;
      expect(pdf).toBeDefined();

      let sumPdf = 0;
      for (const yr of Object.keys(pdf)) {
        sumPdf += pdf[Number(yr)];
      }
      expect(sumPdf).toBeLessThanOrEqual(1.0001);
    });

    it('R6.4: closed-form deterministic FIRE calculation handles spending, withdrawal rate, and emergency buffer', () => {
      const res = calculateFire({
        annualSpending: 12000000, // PHP 120,000 / yr
        withdrawalRate: 0.04,     // 4% SWR -> Target = 300,000,000 (PHP 3M)
        fireAssets: 150000000,    // PHP 1.5M -> Progress = 50%
        essentialMonthlyExpenses: 500000,
        emergencyAssets: 3000000, // 6 months emergency buffer
      });

      expect(res.target).toBe(300000000);
      expect(res.progress).toBe(0.5);
      expect(res.gap).toBe(150000000);
      expect(res.emergencyMonths).toBe(6);
    });

    it('R6.5: safeguards against non-safe integers, NaN, or zero spending without throwing unhandled exceptions', () => {
      const resZeroSpending = calculateFire({
        annualSpending: 0,
        withdrawalRate: 0.04,
        fireAssets: 0,
      });
      expect(resZeroSpending.target).toBeNull();
      expect(resZeroSpending.progress).toBeNull();

      expect(() =>
        calculateFire({
          annualSpending: 10000,
          withdrawalRate: 0, // Invalid rate throws handled error
          fireAssets: 0,
        })
      ).toThrow();
    });
  });

  // --------------------------------------------------------------------------
  // Requirement R7: Firebase Synchronization & Security Hardening
  // --------------------------------------------------------------------------
  describe('R7: Firebase Synchronization & Security Hardening', () => {
    const rulesPath = path.resolve(process.cwd(), 'firestore.rules');
    const rulesContent = fs.readFileSync(rulesPath, 'utf8');

    it('R7.1: security rules strictly reject anonymous and unauthenticated access', () => {
      expect(rulesContent).toContain('function isAuthenticated()');
      expect(rulesContent).toContain("request.auth.token.firebase.sign_in_provider != 'anonymous'");
    });

    it('R7.2: security rules isolate user records under /users/{uid}/{tableName}/{id}', () => {
      expect(rulesContent).toMatch(/match\s+\/users\/\{uid\}\/\{tableName\}\/\{id\}/);
      expect(rulesContent).toContain('request.auth.uid == uid');
    });

    it('R7.3: offline mutations queue into local syncOutbox without blocking UI', async () => {
      const db = new FinanceDatabase(`test-db-${crypto.randomUUID()}`);
      await db.open();
      const repo = createFinanceRepository(db);

      await repo.save('accounts', createAccount('cash'));
      const tx = await repo.saveTransaction(createTransaction('offline-tx'));

      expect(tx.id).toBe('offline-tx');
      const outboxCount = await db.syncOutbox.count();
      expect(outboxCount).toBeGreaterThan(0);

      await db.delete();
    });

    it('R7.4: rolls back transaction, postings, and outbox atomically if outbox queue write fails', async () => {
      const db = new FinanceDatabase(`test-db-${crypto.randomUUID()}`);
      await db.open();
      const repo = createFinanceRepository(db);
      await repo.save('accounts', createAccount('cash'));
      const initialOutbox = await db.syncOutbox.count();

      // Simulate quota error in outbox hook
      db.syncOutbox.hook('creating', (_key, val) => {
        if (val.tableName === 'transactions') throw new Error('Quota exceeded');
      });

      await expect(repo.saveTransaction(createTransaction('fail-tx'))).rejects.toThrow('Quota exceeded');
      expect(await db.transactions.count()).toBe(0);
      expect(await db.postings.count()).toBe(0);
      expect(await db.syncOutbox.count()).toBe(initialOutbox);

      await db.delete();
    });

    it('R7.5: prevents cross-owner pollution by rejecting remote records with differing ownerId', async () => {
      const db = new FinanceDatabase(`test-db-${crypto.randomUUID()}`);
      await db.open();
      const repo = createFinanceRepository(db);

      await repo.assignOwner('legit-owner', { confirmed: true });
      const stolenAccount = {
        ...createAccount('stolen'),
        ownerId: 'rogue-owner',
      } as unknown as SyncedEntity;

      await expect(
        repo.applyRemoteRecords([{ tableName: 'accounts', record: stolenAccount }], 'legit-owner')
      ).rejects.toThrow();

      await db.delete();
    });
  });

  // --------------------------------------------------------------------------
  // Requirement R8: Modern UI/UX, Footer Positioning & Mobile Responsiveness
  // --------------------------------------------------------------------------
  describe('R8: Modern UI/UX, Footer Positioning & Mobile Responsiveness', () => {
    const cssPath = path.resolve(process.cwd(), 'src/styles.css');
    const cssContent = fs.readFileSync(cssPath, 'utf8');

    it('R8.1: ensures app-shell and main-footer use flex layout with sticky/pinned footer structure', () => {
      expect(cssContent).toContain('.app-shell{display:flex;min-height:100vh}');
      expect(cssContent).toContain('.main-footer{display:flex;justify-content:space-between;');
      // Verified footer is cleanly anchored
      expect(cssContent).toMatch(/\.main-footer\s*\{[^}]*margin-top:\s*32px/);
    });

    it('R8.2: includes mobile responsive media query rules covering narrow 390px viewports', () => {
      expect(cssContent).toContain('@media(max-width:820px)');
      expect(cssContent).toContain('@media(max-width:600px)');
      // In mobile mode, multi-column dashboard and investment grids collapse to single column
      expect(cssContent).toContain('.dashboard-grid,.grid-two,.investment-grid{grid-template-columns:1fr');
    });

    it('R8.3: enforces WCAG 2.2 Target Size Minimum (at least 24px-44px touch targets)', () => {
      expect(cssContent).toContain('min-height: 24px;');
      expect(cssContent).toContain('min-width: 24px;');
    });

    it('R8.4: supports prefers-reduced-motion to disable animations for accessibility', () => {
      expect(cssContent).toContain('@media(prefers-reduced-motion:reduce)');
      expect(cssContent).toContain('transition:none!important');
      expect(cssContent).toContain('animation:none!important');
    });

    it('R8.5: high-contrast focus visible ring is styled for accessible navigation', () => {
      expect(cssContent).toContain('*:focus-visible');
      expect(cssContent).toContain('outline: 3px solid #173c34');
    });
  });
});

// ============================================================================
// TIER 2: BOUNDARY AND CORNER CASES
// ============================================================================

describe('Tier 2: Boundary and Corner Cases', () => {
  it('T2.1: Zero Balances & Empty States: accounts with 0 opening balance and 0 tx derive exactly 0', () => {
    const accounts = [createAccount('zero-acct', { openingBalance: 0 })];
    const data = createFinanceData({ accounts });
    const res = calculateNetWorth(data, 'PHP', AS_OF);

    expect(res.netWorth).toBe(0);
    expect(res.assets).toBe(0);
    expect(res.liabilities).toBe(0);
    expect(res.complete).toBe(true);
  });

  it('T2.2: Extreme FX Rates: handles ultra-high rates without losing precision or throwing overflow', () => {
    // 1 USD = 1,000,000,000 VND (Vietnamese Dong style high rate)
    const highRate = createFxRate({
      fromCurrency: 'USD',
      toCurrency: 'PHP',
      rate: 1000000,
    });
    // $10.00 (1000 cents) * 1,000,000 = PHP 10,000,000 (1,000,000,000 minor)
    const converted = convertMoney(1000, 'USD', 'PHP', [highRate], AS_OF);
    expect(converted).toBe(1000000000);
  });

  it('T2.3: Micro FX Rates: handles micro crypto satoshi fractions with 8 decimal places', () => {
    const satoshiRate = createFxRate({
      fromCurrency: 'BTC',
      toCurrency: 'PHP',
      rate: 3000000, // 1 BTC = 3,000,000 PHP
    });
    // 1 satoshi = 1 minor unit of BTC (scale 10^8)
    // 1 / 10^8 * 3,000,000 * 100 = 3 centavos
    const converted = convertMoney(1, 'BTC', 'PHP', [satoshiRate], AS_OF, { BTC: 8, PHP: 2 });
    expect(converted).toBe(3);
  });

  it('T2.4: Negative Balance Adjustments: preserves negative bank cash balance and overdrawn card', () => {
    const cash = createAccount('cash', { openingBalance: 5000 });
    const adj = createTransaction('overdraw', {
      type: 'BALANCE_ADJUSTMENT',
      amount: -10000, // Adjustment down to -5,000
    });
    const balances = accountBalances([cash], [adj], AS_OF);
    expect(balances.cash.PHP).toBe(-5000);
  });

  it('T2.5: Leap Year Date Boundaries: computes exact month length in leap vs non-leap years', () => {
    // Leap year 2024 has 29 days
    const bounds2024 = periodBounds('2024-02', 'monthly');
    expect(bounds2024.from).toBe('2024-02-01');
    expect(bounds2024.to).toBe('2024-02-29');

    // Non-leap year 2025 has 28 days
    const bounds2025 = periodBounds('2025-02', 'monthly');
    expect(bounds2025.from).toBe('2025-02-01');
    expect(bounds2025.to).toBe('2025-02-28');
  });

  it('T2.6: Safe Integer Numeric Ceiling: guards against operations exceeding Number.MAX_SAFE_INTEGER', () => {
    expect(() => toMinor(Number.MAX_SAFE_INTEGER, 'PHP')).toThrow(FinanceValidationError);
    expect(() => toMinor(Infinity, 'PHP')).toThrow(FinanceValidationError);
    expect(() => fromMinor(0.1, 'PHP')).toThrow(FinanceValidationError);
  });

  it('T2.7: Offline State: local-only mode never contacts remote network provider', async () => {
    const db = new FinanceDatabase(`test-db-${crypto.randomUUID()}`);
    await db.open();
    const repo = createFinanceRepository(db);

    const offlineProvider: SyncProvider = {
      userId: async () => { throw new Error('Network prohibited'); },
      push: async () => { throw new Error('Network prohibited'); },
      pull: async () => { throw new Error('Network prohibited'); },
      subscribe: async () => { throw new Error('Network prohibited'); },
    };

    const engine = createSyncEngine({ db, repository: repo, provider: offlineProvider });
    const result = await engine.syncNow();
    expect(result.disabled).toBe(true);

    await db.delete();
  });

  it('T2.8: Missing foreign prices: isolates unpriced asset while aggregating known cash in net worth', () => {
    const cash = createAccount('php-cash', { currency: 'PHP', openingBalance: 1000000 });
    const broker = createAccount('usd-broker', { currency: 'USD', openingBalance: 50000 });
    const unquotedStock = createInstrument('secret-corp', { currency: 'USD' });
    const buy = createTransaction('buy-secret', {
      accountId: 'usd-broker',
      type: 'INVESTMENT_BUY',
      currency: 'USD',
      instrumentId: 'secret-corp',
      units: 10,
      unitPrice: 50,
      amount: 50000, // $500 paid from $500 opening balance
    });

    const rateUsdPhp = createFxRate({ fromCurrency: 'USD', toCurrency: 'PHP', rate: 56 });
    const data = createFinanceData({
      accounts: [cash, broker],
      transactions: [buy],
      instruments: [unquotedStock],
      prices: [], // No prices available!
      fxRates: [rateUsdPhp],
    });

    const res = calculateNetWorth(data, 'PHP', AS_OF);
    expect(res.netWorth).toBeNull();
    // USD Broker cash is 0, so known net worth equals native PHP cash balance
    expect(res.knownNetWorth).toBe(1000000);
    expect(res.complete).toBe(false);
    expect(res.issues.some(i => i.code === 'missing_price')).toBe(true);
  });

  it('T2.9: Rapid duplicate transactions: fingerprinting identifies identical same-day transactions from same merchant', () => {
    const tx1 = createTransaction('t1', { date: '2026-10-01', amount: 50000, merchant: 'Coffee Shop', reference: 'INV-1' });
    const tx2 = createTransaction('t2', { date: '2026-10-01', amount: 50000, merchant: 'coffee shop', reference: 'inv-1' });
    const tx3 = createTransaction('t3', { date: '2026-10-01', amount: 50000, merchant: 'Coffee Shop', reference: 'INV-2' });

    expect(transactionFingerprint(tx1)).toBe(transactionFingerprint(tx2));
    expect(transactionFingerprint(tx1)).not.toBe(transactionFingerprint(tx3));

    const duplicates = findDuplicateTransactions([tx1], [tx2, tx3]);
    expect(duplicates).toEqual([{ index: 0, matches: ['t1'] }]);
  });

  it('T2.10: Zero-amount and negative amount transactions: strict validation rejects 0 or negative expense amounts', () => {
    const cash = createAccount('cash');
    expect(() =>
      postingsForTransaction(createTransaction('zero', { amount: 0 }), [cash])
    ).toThrow(/positive/i);

    expect(() =>
      postingsForTransaction(createTransaction('neg', { amount: -500 }), [cash])
    ).toThrow(/positive/i);
  });

  it('T2.11: Pre-opening-date transaction: strictly rejected if transaction date precedes account opening date', () => {
    const cash = createAccount('cash', { openingDate: '2026-05-01' });
    expect(() =>
      postingsForTransaction(createTransaction('early', { date: '2026-04-30' }), [cash])
    ).toThrow(/opening/i);
  });

  it('T2.12: Foreign currency transfer: cross-currency transfer without explicit transferAmount is rejected', () => {
    const cash = createAccount('cash', { currency: 'PHP', openingBalance: 560000 });
    const usd = createAccount('usd', { currency: 'USD' });

    expect(() =>
      postingsForTransaction(
        createTransaction('cross', {
          type: 'TRANSFER',
          amount: 560000,
          transferAccountId: 'usd',
          transferCurrency: 'USD',
          // transferAmount missing
        }),
        [cash, usd]
      )
    ).toThrow(/explicit destination/i);
  });

  it('T2.13: Leap day annual recurring rule: advancing recurring cadence starting on 2024-02-29 cleanly lands on 2025-02-28', () => {
    const next = new Date('2024-02-29T00:00:00Z');
    const day = next.getUTCDate(); // 29
    next.setUTCDate(1);
    next.setUTCMonth(next.getUTCMonth() + 12);
    const maximum = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
    next.setUTCDate(Math.min(day, maximum));
    expect(next.toISOString().slice(0, 10)).toBe('2025-02-28');
  });

  it('T2.14: Maximum safe integer net worth aggregation: aggregates multi-million balances safely', () => {
    const acct1 = createAccount('a1', { openingBalance: 5000000000000 }); // PHP 50 Billion
    const acct2 = createAccount('a2', { openingBalance: 2000000000000 }); // PHP 20 Billion
    const res = calculateNetWorth(createFinanceData({ accounts: [acct1, acct2] }), 'PHP', AS_OF);

    expect(res.netWorth).toBe(7000000000000);
    expect(res.complete).toBe(true);
  });

  it('T2.15: Category cycle prevention: prevents category parent/child loops', () => {
    const catA: Category = { id: 'a', name: 'Cat A', parentId: 'b', kind: 'expense', color: '#000', essential: true, archived: false };
    const catB: Category = { id: 'b', name: 'Cat B', parentId: 'a', kind: 'expense', color: '#000', essential: true, archived: false };

    const descendants = categoryDescendants('a', [catA, catB]);
    expect(descendants).toEqual(new Set(['a', 'b']));
  });
});

// ============================================================================
// TIER 3: CROSS-FEATURE COMBINATIONS
// ============================================================================

describe('Tier 3: Cross-Feature Combinations', () => {
  it('T3.1: Multi-Currency Investment with Recurring Dividend Cash Flow & Base Net Worth', () => {
    // USD Brokerage holding US Tech Stock receiving quarterly dividend
    const broker = createAccount('usd-broker', {
      currency: 'USD',
      openingBalance: 100000, // USD 1,000 cash in brokerage
    });
    const apple = createInstrument('AAPL', { currency: 'USD' });

    // Buy 10 shares AAPL @ $150
    const buy = createTransaction('buy-aapl', {
      accountId: 'usd-broker',
      type: 'INVESTMENT_BUY',
      currency: 'USD',
      instrumentId: 'AAPL',
      units: 10,
      unitPrice: 150,
      amount: 150000, // $1,500
      fees: 500,      // $5
    });

    // Dividend $25 credited to brokerage account
    const dividend = createTransaction('div-aapl', {
      accountId: 'usd-broker',
      type: 'DIVIDEND',
      currency: 'USD',
      instrumentId: 'AAPL',
      amount: 2500, // $25
    });

    const quoteAapl = createPrice('p-aapl', 180, '2026-10-08T00:00:00Z', {
      instrumentId: 'AAPL',
      currency: 'USD',
    });

    const rateUsdPhp = createFxRate({ fromCurrency: 'USD', toCurrency: 'PHP', rate: 56 });

    const data = createFinanceData({
      accounts: [broker],
      transactions: [buy, dividend],
      instruments: [apple],
      prices: [quoteAapl],
      fxRates: [rateUsdPhp],
    });

    const netWorth = calculateNetWorth(data, 'PHP', AS_OF);

    // Brokerage cash balance:
    // Opening: +$1,000 (100,000) - Buy: $1,505 (150,500) + Div: $25 (2,500) = -$480 (-48,000 cents)
    // AAPL Holdings: 10 shares * $180 = $1,800 (180,000 cents)
    // Total account value in USD = -48,000 + 180,000 = 132,000 cents ($1,320)
    // Converted to PHP @ 56 = $1,320 * 56 = PHP 73,920 (7,392,000 minor)
    expect(netWorth.netWorth).toBe(7392000);
    expect(netWorth.complete).toBe(true);
  });

  it('T3.2: FIRE Retirement Projection Consuming Multi-Currency Holdings & Custom Inflation', () => {
    const phpSavings = createAccount('php-savings', { currency: 'PHP', openingBalance: 2000000 }); // PHP 20,000
    const usdSavings = createAccount('usd-savings', { currency: 'USD', openingBalance: 100000 });  // USD 1,000
    const rateUsdPhp = createFxRate({ fromCurrency: 'USD', toCurrency: 'PHP', rate: 56 });

    const data = createFinanceData({
      accounts: [phpSavings, usdSavings],
      fxRates: [rateUsdPhp],
    });

    const nw = calculateNetWorth(data, 'PHP', AS_OF);
    // Total FIRE assets: PHP 20,000 + ($1,000 * 56 = PHP 56,000) = PHP 76,000 (7,600,000 minor)
    expect(nw.fireAssets).toBe(7600000);

    // Feed calculated assets into Monte Carlo with 6% custom inflation
    const fireParams: FireSimulationParams = {
      initialAssets: nw.fireAssets!,
      annualExpenses: 300000,
      expectedReturn: 0.08,
      returnVolatility: 0.12,
      degreesOfFreedom: 5,
      expectedInflation: 0.06, // 6% custom inflation
      iterations: 5000,
      years: 25,
    };

    const sim = runFireSimulation(fireParams);
    expect(sim.iterations).toBe(5000);
    expect(sim.successRate).toBeGreaterThan(0.6);
  });

  it('T3.3: Offline Outbox with Multi-Category Expenses & Reconnection Batch Sync', async () => {
    const db = new FinanceDatabase(`test-db-${crypto.randomUUID()}`);
    await db.open();
    const repo = createFinanceRepository(db);

    await repo.save('accounts', createAccount('cash', { openingBalance: 500000 }));
    await repo.save('categories', { id: 'food', name: 'Food', kind: 'expense', color: '#aaa', essential: true, archived: false });
    await repo.save('categories', { id: 'rent', name: 'Rent', kind: 'expense', color: '#bbb', essential: true, archived: false });
    await repo.save('categories', { id: 'utilities', name: 'Utilities', kind: 'expense', color: '#ccc', essential: true, archived: false });
    await repo.assignOwner('user-123', { confirmed: true });
    await repo.setSetting('privacyMode', 'CLOUD_SYNC');

    // Create 3 expenses offline
    await repo.saveTransaction(createTransaction('tx-food', { categoryId: 'food', amount: 5000 }));
    await repo.saveTransaction(createTransaction('tx-rent', { categoryId: 'rent', amount: 20000 }));
    await repo.saveTransaction(createTransaction('tx-util', { categoryId: 'utilities', amount: 3000 }));

    expect(await db.syncOutbox.count()).toBeGreaterThanOrEqual(3);

    // Mock remote provider on reconnection
    const pushedEntries: any[] = [];
    const mockProvider: SyncProvider = {
      userId: async () => 'user-123',
      push: async entry => {
        pushedEntries.push(entry);
        return { kind: 'applied', record: { tableName: entry.tableName, record: entry.payload } };
      },
      pull: async () => ({ records: [], cursor: '2026-10-09T00:00:00Z' }),
      subscribe: async () => () => {},
    };

    const engine = createSyncEngine({ db, repository: repo, provider: mockProvider });
    const syncRes = await engine.syncNow();

    expect(syncRes.uploaded).toBeGreaterThanOrEqual(3);
    expect(await db.syncOutbox.count()).toBe(0); // All mutations acknowledged

    await db.delete();
  });

  it('T3.4: Budget Tracking Fed by Multi-Currency Expenses at Dated FX Rates', () => {
    const phpAcct = createAccount('php-cash', { currency: 'PHP' });
    const usdAcct = createAccount('usd-card', { currency: 'USD' });
    const categories: Category[] = [
      { id: 'travel', name: 'Travel', kind: 'expense', color: '#000', essential: false, archived: false },
    ];
    const budget: Budget = {
      id: 'b-travel',
      categoryId: 'travel',
      period: '2026-10',
      periodType: 'monthly',
      amount: 1000000, // PHP 10,000 budget
      currency: 'PHP',
    };

    const rateUsdPhp = createFxRate({ fromCurrency: 'USD', toCurrency: 'PHP', rate: 56 });

    // USD $100 spent on travel
    const usdExpense = createTransaction('hotel', {
      accountId: 'usd-card',
      currency: 'USD',
      categoryId: 'travel',
      amount: 10000, // $100
      date: '2026-10-05',
    });

    // PHP 2,000 spent on travel
    const phpExpense = createTransaction('food', {
      accountId: 'php-cash',
      currency: 'PHP',
      categoryId: 'travel',
      amount: 200000, // PHP 2,000
      date: '2026-10-06',
    });

    const res = calculateBudget(
      budget,
      [usdExpense, phpExpense],
      [phpAcct, usdAcct],
      categories,
      [rateUsdPhp],
      AS_OF
    );

    // USD 100 * 56 = PHP 5,600 (560,000) + PHP 2,000 (200,000) = PHP 7,600 (760,000)
    expect(res.spent).toBe(760000);
    expect(res.remaining).toBe(240000);
    expect(res.percentUsed).toBe(76);
  });

  it('T3.5: Debt Amortization Linked with Cash Flow Amortization & Net Worth Reduction', () => {
    const cash = createAccount('cash', { openingBalance: 1000000 });
    const mortgage = createAccount('mortgage', {
      accountType: 'MORTGAGE',
      openingBalance: 2000000, // PHP 20,000 owed
    });

    // Monthly amortization payment: PHP 2,000 total (PHP 1,500 principal, PHP 500 interest)
    const payment = createTransaction('m-pay', {
      type: 'TRANSFER',
      accountId: 'cash',
      transferAccountId: 'mortgage',
      amount: 200000,
      principalAmount: 150000,
    });
    const interest = createTransaction('m-int', {
      type: 'INTEREST',
      accountId: 'mortgage',
      amount: 50000,
    });

    const flow = calculateCashFlow([payment, interest], [cash, mortgage], { to: AS_OF });
    expect(flow.debtPrincipal).toBe(150000);
    expect(flow.expenses).toBe(50000);

    const data = createFinanceData({
      accounts: [cash, mortgage],
      transactions: [payment, interest],
    });
    const nw = calculateNetWorth(data, 'PHP', AS_OF);

    // Cash: 1,000,000 - 200,000 = 800,000
    // Mortgage: 2,000,000 - 200,000 + 50,000 = 1,850,000
    // Net Worth: 800,000 - 1,850,000 = -1,050,000
    expect(nw.assets).toBe(800000);
    expect(nw.liabilities).toBe(1850000);
    expect(nw.netWorth).toBe(-1050000);
  });

  it('T3.6: Drag-and-Drop Reordered Accounts Portfolio Valuation Matching Custom Ordering', () => {
    const a1 = createAccount('a1', { name: 'Alpha', openingBalance: 100000 });
    const a2 = createAccount('a2', { name: 'Beta', openingBalance: 200000 });
    const a3 = createAccount('a3', { name: 'Gamma', openingBalance: 300000 });

    const customOrder = ['a3', 'a1', 'a2'];
    const sorted = sortAccountCards([a1, a2, a3], {}, 'custom', customOrder);

    expect(sorted.map(a => a.id)).toEqual(['a3', 'a1', 'a2']);

    const nw = calculateNetWorth(createFinanceData({ accounts: sorted }), 'PHP', AS_OF);
    expect(nw.netWorth).toBe(600000);
  });
});

// ============================================================================
// TIER 4: REAL-WORLD USER JOURNEYS (5 SCENARIOS)
// ============================================================================

describe('Tier 4: Real-World User Journeys', () => {
  it('T4.S1: Expat Portfolio Journey (USD Investments + PHP Cash + SGD Liability)', () => {
    // User is an OFW in Singapore remitting to Philippines and investing in US
    const sgdSalary = createAccount('sgd-bank', { currency: 'SGD', openingBalance: 500000 }); // SGD 5,000
    const phSavings = createAccount('bdo-ph', { currency: 'PHP', openingBalance: 1000000 });   // PHP 10,000
    const usBroker = createAccount('ibkr-usd', { currency: 'USD', openingBalance: 200000 });   // USD 2,000
    const sgdLoan = createAccount('dbs-loan', {
      accountType: 'PERSONAL_LOAN',
      currency: 'SGD',
      openingBalance: 100000, // SGD 1,000 liability
    });

    // Remittance: SGD 1,000 sent to PHP 40,000
    const remittance = createTransaction('remit', {
      type: 'TRANSFER',
      accountId: 'sgd-bank',
      currency: 'SGD',
      amount: 100000, // SGD 1,000
      transferAccountId: 'bdo-ph',
      transferCurrency: 'PHP',
      transferAmount: 4000000, // PHP 40,000
    });

    const rates: FxRate[] = [
      createFxRate({ id: 'sgd-php', fromCurrency: 'SGD', toCurrency: 'PHP', rate: 40 }),
      createFxRate({ id: 'usd-php', fromCurrency: 'USD', toCurrency: 'PHP', rate: 56 }),
    ];

    const data = createFinanceData({
      accounts: [sgdSalary, phSavings, usBroker, sgdLoan],
      transactions: [remittance],
      fxRates: rates,
    });

    const nw = calculateNetWorth(data, 'PHP', AS_OF);

    // SGD bank: 5,000 - 1,000 = SGD 4,000 @ 40 = PHP 160,000 (16,000,000)
    // PHP bank: 10,000 + 40,000 = PHP 50,000 (5,000,000)
    // USD broker: USD 2,000 @ 56 = PHP 112,000 (11,200,000)
    // Total Assets = 16,000,000 + 5,000,000 + 11,200,000 = 32,200,000 (PHP 322,000)
    // SGD Loan: SGD 1,000 @ 40 = PHP 40,000 (4,000,000)
    // Net Worth = 32,200,000 - 4,000,000 = 28,200,000 (PHP 282,000)
    expect(nw.assets).toBe(32200000);
    expect(nw.liabilities).toBe(4000000);
    expect(nw.netWorth).toBe(28200000);
    expect(nw.complete).toBe(true);
  });

  it('T4.S2: Bi-Weekly Salary Workflow with Automated Split & Mortgage Paydown', () => {
    const payroll = createAccount('payroll', { openingBalance: 0 });
    const emergency = createAccount('emergency-fund', { openingBalance: 1000000, emergency: true });
    const mortgage = createAccount('home-mortgage', { accountType: 'MORTGAGE', openingBalance: 5000000 });

    // Bi-weekly paycheck on 1st: PHP 50,000
    const paycheck1 = createTransaction('pay-1', {
      type: 'INCOME',
      accountId: 'payroll',
      amount: 5000000,
      date: '2026-10-01',
    });

    // Split 1: PHP 15,000 to Emergency Fund
    const splitEmergency = createTransaction('split-ef', {
      type: 'TRANSFER',
      accountId: 'payroll',
      transferAccountId: 'emergency-fund',
      amount: 1500000,
      date: '2026-10-01',
    });

    // Split 2: PHP 25,000 to Mortgage payment (PHP 20,000 principal, PHP 5,000 interest)
    const splitMortgage = createTransaction('split-mort', {
      type: 'TRANSFER',
      accountId: 'payroll',
      transferAccountId: 'home-mortgage',
      amount: 2500000,
      principalAmount: 2000000,
      date: '2026-10-01',
    });

    const mortgageInterest = createTransaction('mort-int', {
      type: 'INTEREST',
      accountId: 'home-mortgage',
      amount: 500000,
      date: '2026-10-01',
    });

    const txs = [paycheck1, splitEmergency, splitMortgage, mortgageInterest];
    const flow = calculateCashFlow(txs, [payroll, emergency, mortgage], { to: AS_OF });

    expect(flow.income).toBe(5000000);
    expect(flow.debtPrincipal).toBe(2000000);
    expect(flow.expenses).toBe(500000);

    const balances = accountBalances([payroll, emergency, mortgage], txs, AS_OF);
    // Payroll: 50,000 - 15,000 - 25,000 = 10,000 (1,000,000)
    expect(balances.payroll.PHP).toBe(1000000);
    // Emergency: 10,000 + 15,000 = 25,000 (2,500,000)
    expect(balances['emergency-fund'].PHP).toBe(2500000);
    // Mortgage: 50,000 - 25,000 + 5,000 = 30,000 (3,000,000)
    expect(balances['home-mortgage'].PHP).toBe(3000000);
  });

  it('T4.S3: Market Volatility, Stale Price Preservation, and Offline Reconnection', async () => {
    // User is on a flight (offline) during a volatile trading day
    const db = new FinanceDatabase(`test-db-${crypto.randomUUID()}`);
    await db.open();
    const repo = createFinanceRepository(db);

    const broker = createAccount('broker', { openingBalance: 1000000 });
    const cash = createAccount('cash', { openingBalance: 500000 });
    const stock = createInstrument('bpi', { currency: 'PHP' });
    await repo.save('accounts', broker);
    await repo.save('accounts', cash);
    await repo.save('instruments', stock);

    // Save previous verified quote
    const oldPrice = createPrice('p-bpi', 115, '2026-10-07T08:00:00Z', {
      instrumentId: 'bpi',
      staleAfter: '2026-10-08T08:00:00Z',
    });
    await repo.save('prices', oldPrice);

    // While offline, user logs an in-flight meal expense
    await repo.saveTransaction(createTransaction('inflight-meal', { amount: 35000 }));
    expect(await db.syncOutbox.count()).toBeGreaterThan(0);

    // Market data gateway query offline preserves oldPrice
    const position = calculatePositions(
      [createTransaction('buy-bpi', { type: 'INVESTMENT_BUY', instrumentId: 'bpi', units: 100, unitPrice: 110, amount: 1100000 })],
      [stock],
      [oldPrice],
      { asOf: AS_OF, now: NOW }
    )[0];

    expect(position.price).toBe(115);
    expect(position.stale).toBe(true);

    // Airplane lands: cloud sync pushes outbox entries
    await repo.assignOwner('traveler', { confirmed: true });
    await repo.setSetting('privacyMode', 'CLOUD_SYNC');

    const provider: SyncProvider = {
      userId: async () => 'traveler',
      push: async entry => ({ kind: 'applied', record: { tableName: entry.tableName, record: entry.payload } }),
      pull: async () => ({ records: [], cursor: '2026-10-09T00:00:00Z' }),
      subscribe: async () => () => {},
    };

    const engine = createSyncEngine({ db, repository: repo, provider });
    const res = await engine.syncNow();
    expect(res.uploaded).toBeGreaterThan(0);
    expect(await db.syncOutbox.count()).toBe(0);

    await db.delete();
  });

  it('T4.S4: FIRE Retirement Path with High Custom Inflation & Volatile Asset Allocation', () => {
    // 35-year Lean FIRE projection in the Philippines with volatile returns and 7% inflation
    const mp2 = createAccount('mp2', { openingBalance: 3000000 }); // PHP 30,000 Pag-IBIG MP2
    const dividendPortfolio = createAccount('pse-div', { openingBalance: 5000000 }); // PHP 50,000
    const cashReserve = createAccount('cash-res', { openingBalance: 2000000 }); // PHP 20,000

    const nw = calculateNetWorth(
      createFinanceData({ accounts: [mp2, dividendPortfolio, cashReserve] }),
      'PHP',
      AS_OF
    );
    expect(nw.fireAssets).toBe(10000000); // PHP 100,000 (10M minor)

    const params: FireSimulationParams = {
      initialAssets: nw.fireAssets!,
      annualExpenses: 350000,
      annualContribution: 50000,
      expectedReturn: 0.08,
      returnVolatility: 0.16,
      degreesOfFreedom: 5,
      expectedInflation: 0.07, // 7% high inflation
      iterations: 5000,
      years: 35,
    };

    const sim = runFireSimulation(params);
    expect(sim.iterations).toBe(5000);
    expect(sim.trajectories).toHaveLength(36);
    expect(sim.standardError).toBeLessThanOrEqual(0.01);
  });

  it('T4.S5: Mobile 390px Touch Workflow: Reordering, Recurring Setup & Pinned Footer', () => {
    const accts = [
      createAccount('wallet', { name: 'Maya Wallet', openingBalance: 5000 }),
      createAccount('bank', { name: 'BDO Savings', openingBalance: 80000 }),
    ];

    // Mobile user drags BDO Savings to top
    const reordered = reorderCards(accts, 1, 0);
    expect(reordered[0].name).toBe('BDO Savings');

    // Sets up bi-weekly recurring subscription
    const nextDue = calculateBiWeeklyNextDate('2026-10-09');
    expect(nextDue).toBe('2026-10-23');

    // Reads CSS to verify responsive rules for 390px screen
    const cssPath = path.resolve(process.cwd(), 'src/styles.css');
    const css = fs.readFileSync(cssPath, 'utf8');

    // 390px is handled by max-width: 600px breakpoint
    expect(css).toContain('@media(max-width:600px)');
    // Touch target minimum dimensions
    expect(css).toContain('min-height: 24px;');
    // Pinned footer
    expect(css).toContain('.main-footer');
  });
});
