import { ACCOUNT_TYPES, TRANSACTION_TYPES } from './types';
import type { Account, Budget, CalculationIssue, Category, Currency, FinanceData, FinanceSettings, FxRate, Instrument, Money, Posting, Price, SavingsRateOptions, Transaction } from './types';

const LIABILITY_TYPES = new Set(['CREDIT_CARD', 'PERSONAL_LOAN', 'MORTGAGE', 'OTHER_LIABILITY']);
const TRADE_TYPES = new Set(['INVESTMENT_BUY', 'INVESTMENT_SELL']);
type Precision = Record<string, number>;
const defaultCurrencyPrecision = new Map<string, number>();
export class FinanceValidationError extends Error {
  constructor(message: string) { super(message); this.name = 'FinanceValidationError'; }
}
function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new FinanceValidationError(message);
}
function minor(value: number, label = 'Amount'): number {
  requireValue(Number.isSafeInteger(value), `${label} must be an integer in currency minor units.`);
  return value;
}
function rounded(value: number): number {
  requireValue(Number.isFinite(value), 'Calculation exceeds the supported numeric range.');
  const absolute = Math.abs(value);
  const correction = Number.isInteger(absolute) ? 0 : Math.min(1e-7, Number.EPSILON * Math.max(1, absolute));
  return minor(Math.sign(value) * Math.round(absolute + correction));
}
function add(a: number, b: number): number { return minor(a + b, 'Calculated balance'); }
function moneyRecord(): Record<string, Money> { return Object.create(null) as Record<string, Money>; }
export function validDate(date: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(`${date}T00:00:00Z`))
    && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;
}
export function today(): string {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function throughDate(date: string): number {
  requireValue(validDate(date), 'Use a valid calendar date in YYYY-MM-DD format.');
  return Date.parse(`${date}T23:59:59.999Z`);
}
export function isLiability(account: Account): boolean { return LIABILITY_TYPES.has(account.accountType); }
export function currencyScale(currency: Currency, precision: Precision = {}): number {
  requireValue(/^[A-Z]{3}$/.test(currency), 'Use an uppercase three-letter currency code.');
  let digits = precision[currency] ?? defaultCurrencyPrecision.get(currency);
  if (digits === undefined) {
    const resolved = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits;
    requireValue(typeof resolved === 'number', 'Currency precision is unavailable.');
    digits = resolved;
    defaultCurrencyPrecision.set(currency, digits);
  }
  requireValue(typeof digits === 'number' && Number.isInteger(digits) && digits >= 0 && digits <= 8, 'Currency precision must be between zero and eight.');
  return 10 ** digits;
}
export function toMinor(value: number, currency: Currency, precision: Precision = {}): Money {
  return rounded(value * currencyScale(currency, precision));
}
export function fromMinor(value: Money, currency: Currency, precision: Precision = {}): number {
  return minor(value) / currencyScale(currency, precision);
}

const STANDARD_PIVOT_CURRENCIES: readonly Currency[] = ['USD', 'EUR', 'PHP'];

interface DirectFxObservation {
  rate: number;
  time: number;
}

/** Resolves single-hop direct or inverse FX rate respecting cutoff date. Never recurses. */
function getDirectOrInverseFxRate(
  from: Currency,
  to: Currency,
  rates: readonly FxRate[],
  cutoff: number
): DirectFxObservation | null {
  let direct: FxRate | undefined;
  let inverse: FxRate | undefined;
  let directTime = -Infinity;
  let inverseTime = -Infinity;

  for (const rate of rates) {
    if (rate.deletedAt || !Number.isFinite(rate.rate) || rate.rate <= 0) continue;
    const isDirect = rate.fromCurrency === from && rate.toCurrency === to;
    const isInverse = rate.fromCurrency === to && rate.toCurrency === from;
    if (!isDirect && !isInverse) continue;
    const time = Date.parse(rate.asOf);
    if (!Number.isFinite(time) || time > cutoff) continue;
    if (isDirect && time > directTime) { direct = rate; directTime = time; }
    if (isInverse && time > inverseTime) { inverse = rate; inverseTime = time; }
  }

  if (direct && directTime >= inverseTime) {
    return { rate: direct.rate, time: directTime };
  }
  if (inverse) {
    return { rate: 1 / inverse.rate, time: inverseTime };
  }
  return null;
}

export function getFxRate(from: Currency, to: Currency, rates: readonly FxRate[], asOf = today()): number | null {
  if (from === to) return 1;
  const cutoff = throughDate(asOf);

  // Step 1: Single-hop direct or inverse lookup
  const singleHop = getDirectOrInverseFxRate(from, to, rates, cutoff);
  if (singleHop !== null) return singleHop.rate;

  // Step 2: Triangular cross-rate routing via intermediate pivot currency
  const rateCurrencies = new Set<Currency>();
  for (const rate of rates) {
    if (rate.deletedAt || !Number.isFinite(rate.rate) || rate.rate <= 0) continue;
    const time = Date.parse(rate.asOf);
    if (!Number.isFinite(time) || time > cutoff) continue;
    rateCurrencies.add(rate.fromCurrency);
    rateCurrencies.add(rate.toCurrency);
  }

  // Build candidate pivots prioritizing standard vehicles (USD, EUR, PHP)
  const candidatePivots: Currency[] = [];
  for (const pivot of STANDARD_PIVOT_CURRENCIES) {
    if (pivot !== from && pivot !== to && rateCurrencies.has(pivot)) {
      candidatePivots.push(pivot);
    }
  }
  for (const currency of rateCurrencies) {
    if (currency !== from && currency !== to && !candidatePivots.includes(currency)) {
      candidatePivots.push(currency);
    }
  }

  let bestRate: number | null = null;
  let bestTime = -Infinity;

  for (const pivot of candidatePivots) {
    const leg1 = getDirectOrInverseFxRate(from, pivot, rates, cutoff);
    if (!leg1) continue;
    const leg2 = getDirectOrInverseFxRate(pivot, to, rates, cutoff);
    if (!leg2) continue;

    const effectiveTime = Math.min(leg1.time, leg2.time);
    if (effectiveTime > bestTime) {
      bestTime = effectiveTime;
      bestRate = leg1.rate * leg2.rate;
    }
  }

  return bestRate;
}
export function convertMoney(amount: Money, from: Currency, to: Currency, rates: readonly FxRate[], asOf = today(), precision: Precision = {}): Money | null {
  minor(amount);
  const sourceScale = currencyScale(from, precision), destinationScale = currencyScale(to, precision);
  if (amount === 0) return 0;
  const rate = getFxRate(from, to, rates, asOf);
  return rate === null ? null : rounded(amount / sourceScale * rate * destinationScale);
}
function accountMap(accounts: readonly Account[] | ReadonlyMap<string, Account>): ReadonlyMap<string, Account> {
  if (!Array.isArray(accounts)) return accounts as ReadonlyMap<string, Account>;
  const result = new Map<string, Account>();
  for (const account of accounts) {
    if (account.deletedAt) continue;
    requireValue(Boolean(account.id) && !result.has(account.id), 'Accounts must have unique identifiers.');
    requireValue(ACCOUNT_TYPES.includes(account.accountType), 'Unknown account type.');
    requireValue(validDate(account.openingDate), 'Opening date must be a valid calendar date.');
    if (account.openingBalances && typeof account.openingBalances === 'object') {
      for (const [curr, amt] of Object.entries(account.openingBalances)) {
        currencyScale(curr);
        minor(amt as number, `Opening balance for ${curr}`);
      }
    } else {
      minor(account.openingBalance ?? 0, 'Opening balance');
    }
    currencyScale(account.currency);
    result.set(account.id, account);
  }
  return result;
}
function chronological(transactions: readonly Transaction[], asOf?: string): Transaction[] {
  const seen = new Set<string>();
  return transactions.filter(transaction => {
    if (transaction.deletedAt) return false;
    requireValue(Boolean(transaction.id) && !seen.has(transaction.id), 'Transactions must have unique identifiers.');
    seen.add(transaction.id);
    requireValue(validDate(transaction.date), 'Transaction date must be a valid calendar date.');
    requireValue(TRANSACTION_TYPES.includes(transaction.type), 'Unknown transaction type.');
    return asOf === undefined || transaction.date <= asOf;
  }).map((transaction, index) => ({ transaction, index })).sort((a, b) => a.transaction.date.localeCompare(b.transaction.date)
    || (a.transaction.createdAt ?? '').localeCompare(b.transaction.createdAt ?? '') || a.index - b.index).map(row => row.transaction);
}

/** Positive liabilities mean money owed. A transfer to a liability pays it down. */
export function postingsForTransaction(transaction: Transaction, accounts: readonly Account[] | ReadonlyMap<string, Account>, precision: Precision = {}): Posting[] {
  const map = accountMap(accounts), source = map.get(transaction.accountId);
  requireValue(source, 'Choose an existing account.');
  requireValue(validDate(transaction.date) && transaction.date >= source.openingDate, 'Transaction cannot precede the account opening date.');
  requireValue(TRANSACTION_TYPES.includes(transaction.type), 'Unknown transaction type.');
  requireValue(source.currency === transaction.currency || (source.openingBalances && transaction.currency in source.openingBalances), 'Transaction currency must match its account.');
  minor(transaction.amount);
  requireValue(transaction.type === 'BALANCE_ADJUSTMENT' || transaction.amount > 0, 'Amount must be positive.');
  const fees = minor(transaction.fees ?? 0, 'Fees');
  requireValue(fees >= 0, 'Fees cannot be negative.');
  requireValue(TRADE_TYPES.has(transaction.type) || fees === 0, 'Record other fees as a separate fee transaction.');
  const posting = (account: Account, delta: number, suffix: string, extra: Partial<Posting> = {}): Posting => ({
    id: `${transaction.id}:${suffix}`, transactionId: transaction.id, accountId: account.id, date: transaction.date,
    currency: extra.currency ?? transaction.currency, delta: minor(delta), ...extra,
  });
  const sign = isLiability(source) ? -1 : 1;
  if (transaction.type === 'TRANSFER' || transaction.type === 'INVESTMENT_CONTRIBUTION' || transaction.type === 'INVESTMENT_WITHDRAWAL') {
    const destination = map.get(transaction.transferAccountId ?? '');
    requireValue(destination && (destination.id !== source.id || transaction.currency !== transaction.transferCurrency), 'Choose a different destination account or destination currency.');
    requireValue(transaction.date >= destination.openingDate, 'Transaction cannot precede the destination account opening date.');
    if (destination.id === source.id) {
      requireValue(transaction.transferCurrency && transaction.transferCurrency !== transaction.currency, 'Choose a different destination currency.');
    } else {
      requireValue(transaction.transferCurrency === undefined || transaction.transferCurrency === destination.currency || (destination.openingBalances && transaction.transferCurrency in destination.openingBalances), 'Destination currency does not match its account.');
    }
    const destCurrency = transaction.transferCurrency ?? destination.currency;
    const received = transaction.transferAmount ?? transaction.amount;
    minor(received, 'Destination amount'); requireValue(received > 0, 'Destination amount must be positive.');
    const isCrossCurrency = transaction.currency !== destCurrency;
    requireValue(!isCrossCurrency || transaction.transferAmount !== undefined, 'Cross-currency transfers require an explicit destination amount.');
    requireValue(isCrossCurrency || received === transaction.amount, 'Same-currency transfers must move equal amounts.');
    if (transaction.principalAmount !== undefined) {
      minor(transaction.principalAmount, 'Principal payment');
      requireValue(!isLiability(source) && isLiability(destination) && destination.accountType !== 'CREDIT_CARD'
        && transaction.principalAmount >= 0 && transaction.principalAmount <= received, 'Principal split requires a loan payment and cannot exceed its destination amount.');
    }
    return [
      posting(source, -sign * transaction.amount, 'from', { currency: transaction.currency }),
      posting(destination, (isLiability(destination) ? -1 : 1) * received, 'to', { currency: destCurrency })
    ];
  }
  requireValue(transaction.principalAmount === undefined, 'Principal split applies only to a loan-payment transfer.');
  if (TRADE_TYPES.has(transaction.type)) {
    requireValue(!isLiability(source), 'Investment trades require an asset account.');
    requireValue(transaction.instrumentId && Number.isFinite(transaction.units) && (transaction.units ?? 0) > 0, 'Trade requires an instrument and positive units.');
    if (transaction.unitPrice !== undefined) {
      requireValue(Number.isFinite(transaction.unitPrice) && transaction.unitPrice > 0, 'Trade price must be positive.');
      requireValue(toMinor(transaction.unitPrice * transaction.units!, transaction.currency, precision) === transaction.amount, 'Trade notional must equal units multiplied by price, excluding fees.');
    }
    const buy = transaction.type === 'INVESTMENT_BUY';
    requireValue(buy || fees <= transaction.amount, 'Sale fees cannot exceed gross proceeds.');
    return [posting(source, buy ? -add(transaction.amount, fees) : transaction.amount - fees, 'cash'), posting(source, 0, 'units', {
      instrumentId: transaction.instrumentId, unitsDelta: (buy ? 1 : -1) * transaction.units!,
    })];
  }
  if (transaction.type === 'BALANCE_ADJUSTMENT') return [posting(source, transaction.amount, 'adjustment')];
  if (transaction.type === 'INTEREST' && isLiability(source)) return [posting(source, transaction.amount, 'interest')];
  const increase = ['INCOME', 'REFUND', 'INTEREST', 'DIVIDEND', 'INVESTMENT_CONTRIBUTION'].includes(transaction.type);
  return [posting(source, (increase ? sign : -sign) * transaction.amount, 'balance')];
}

export function buildLedger(accounts: readonly Account[], transactions: readonly Transaction[], asOf = today(), precision: Precision = {}) {
  throughDate(asOf);
  const map = accountMap(accounts), balances: Record<string, Record<Currency, Money>> = Object.create(null), postings: Posting[] = [];
  for (const account of map.values()) {
    const b: Record<string, number> = Object.create(null);
    if (account.openingDate <= asOf) {
      if (account.openingBalances) {
        for (const [curr, amt] of Object.entries(account.openingBalances)) b[curr] = amt;
      } else if (account.openingBalance !== undefined) {
        b[account.currency] = account.openingBalance;
      }
    }
    balances[account.id] = b;
  }
  for (const transaction of chronological(transactions, asOf)) {
    const entries = postingsForTransaction(transaction, map, precision);
    for (const entry of entries) {
      const b = balances[entry.accountId] ??= Object.create(null);
      b[entry.currency] = add(b[entry.currency] || 0, entry.delta);
    }
    postings.push(...entries);
  }
  return { balances, postings };
}
export function accountBalances(accounts: readonly Account[], transactions: readonly Transaction[], asOf = today(), precision: Precision = {}): Record<string, Record<string, number>> {
  return buildLedger(accounts, transactions, asOf, precision).balances;
}

export interface PositionSummary {
  accountId: string;
  instrumentId: string;
  currency: Currency;
  units: number;
  costBasis: Money;
  averageCost: number;
  marketValue: Money | null;
  realizedGain: Money;
  unrealizedGain: Money | null;
  income: Money;
  totalReturn: Money | null;
  returnPercent: number | null;
  price: number | null;
  priceAsOf: string | null;
  stale: boolean;
  projectedValue?: Money;
  projectedAsOf?: string;
  issues: CalculationIssue[];
}
export interface PositionOptions { asOf?: string; now?: string; currencyPrecision?: Precision; }
export function latestValidPrice(instrument: Instrument, prices: readonly Price[], asOf = today(), now = new Date().toISOString()): Price | null {
  const cutoff = Math.min(throughDate(asOf), Date.parse(now));
  return prices.filter(price => !price.deletedAt && price.instrumentId === instrument.id && price.currency === instrument.currency
    && price.status !== 'error' && Number.isFinite(price.value) && (price.value > 0 || (price.value === 0 && instrument.valuationMethod === 'MANUAL_VALUE' && price.status === 'manual'))
    && Number.isFinite(Date.parse(price.asOf)) && Date.parse(price.asOf) <= cutoff)
    .sort((a, b) => Date.parse(b.asOf) - Date.parse(a.asOf))[0] ?? null;
}
export function calculatePositions(transactions: readonly Transaction[], instruments: readonly Instrument[], prices: readonly Price[], options: PositionOptions = {}): PositionSummary[] {
  const asOf = options.asOf ?? today(), now = options.now ?? new Date().toISOString(), precision = options.currencyPrecision ?? {};
  throughDate(asOf); requireValue(Number.isFinite(Date.parse(now)), 'Valuation time must be a valid timestamp.');
  const instrumentsById = new Map<string, Instrument>();
  for (const instrument of instruments) if (!instrument.deletedAt) {
    requireValue(Boolean(instrument.id) && !instrumentsById.has(instrument.id), 'Instruments must have unique identifiers.');
    currencyScale(instrument.currency, precision); instrumentsById.set(instrument.id, instrument);
  }
  const state = new Map<string, PositionSummary & { purchasedCost: number }>();
  for (const transaction of chronological(transactions, asOf)) {
    if (!transaction.instrumentId || (!TRADE_TYPES.has(transaction.type) && transaction.type !== 'DIVIDEND' && transaction.type !== 'INTEREST')) continue;
    const instrument = instrumentsById.get(transaction.instrumentId);
    requireValue(!instrument || transaction.currency === instrument.currency, 'Investment transaction and instrument currencies must match.');
    const key = JSON.stringify([transaction.accountId, transaction.instrumentId]);
    let position = state.get(key);
    if (!position) {
      position = { accountId: transaction.accountId, instrumentId: transaction.instrumentId, currency: transaction.currency,
        units: 0, costBasis: 0, averageCost: 0, marketValue: null, realizedGain: 0, unrealizedGain: null, income: 0,
        totalReturn: null, returnPercent: null, price: null, priceAsOf: null, stale: false, issues: [], purchasedCost: 0 };
      state.set(key, position);
    }
    minor(transaction.amount); const fees = minor(transaction.fees ?? 0);
    requireValue(transaction.amount > 0 && fees >= 0, 'Investment amounts must be positive and fees cannot be negative.');
    if (!TRADE_TYPES.has(transaction.type)) { requireValue(fees === 0, 'Record other fees separately.'); position.income = add(position.income, transaction.amount); continue; }
    const units = transaction.units ?? 0;
    requireValue(Number.isFinite(units) && units > 0, 'Investment units must be positive.');
    if (transaction.unitPrice !== undefined) {
      requireValue(Number.isFinite(transaction.unitPrice) && transaction.unitPrice > 0, 'Trade price must be positive.');
      requireValue(toMinor(transaction.unitPrice * units, transaction.currency, precision) === transaction.amount, 'Trade notional must equal units multiplied by price, excluding fees.');
    }
    if (transaction.type === 'INVESTMENT_BUY') {
      const basis = add(transaction.amount, fees);
      position.units += units; requireValue(Number.isFinite(position.units), 'Units exceed the supported numeric range.');
      position.costBasis = add(position.costBasis, basis); position.purchasedCost = add(position.purchasedCost, basis);
    } else {
      const tolerance = Math.min(1e-7, Number.EPSILON * Math.max(1, position.units, units) * 8);
      requireValue(units <= position.units + tolerance && position.units > 0, 'Sale exceeds units held on its transaction date.');
      requireValue(fees <= transaction.amount, 'Sale fees cannot exceed gross proceeds.');
      const fullSale = Math.abs(position.units - units) <= tolerance;
      const relieved = fullSale ? position.costBasis : rounded(position.costBasis * units / position.units);
      position.costBasis -= relieved; position.units = fullSale ? 0 : position.units - units;
      position.realizedGain = add(position.realizedGain, transaction.amount - fees - relieved);
    }
  }
  const heldInstruments = new Set([...state.values()].filter(position => position.units > 0).map(position => position.instrumentId));
  const pricesByInstrument = new Map<string, Price[]>();
  for (const price of prices) if (heldInstruments.has(price.instrumentId)) {
    const rows = pricesByInstrument.get(price.instrumentId) ?? []; rows.push(price); pricesByInstrument.set(price.instrumentId, rows);
  }
  const currentPrices = new Map<string, Price | null>();
  for (const id of heldInstruments) {
    const instrument = instrumentsById.get(id);
    if (instrument) currentPrices.set(id, latestValidPrice(instrument, pricesByInstrument.get(id) ?? [], asOf, now));
  }
  const manualAllocations = new Map<string, Money>(), principalAllocations = new Map<string, Money>(), manualDates = new Map<string, string>();
  for (const instrument of instrumentsById.values()) {
    let total = instrument.valuationMethod === 'COMPOUNDING' ? instrument.principal : undefined;
    if (instrument.valuationMethod === 'MANUAL_VALUE') {
      // For this method, a stored Price is the total statement value in major units.
      const statement = currentPrices.get(instrument.id) ?? null;
      const declaredAt = instrument.manualValueAsOf ?? instrument.updatedAt ?? instrument.createdAt ?? now;
      const declaredValid = instrument.manualValue !== undefined && Number.isFinite(Date.parse(declaredAt))
        && Date.parse(declaredAt) <= Math.min(throughDate(asOf), Date.parse(now));
      if (statement && (!declaredValid || Date.parse(statement.asOf) >= Date.parse(declaredAt))) {
        total = toMinor(statement.value, instrument.currency, precision); manualDates.set(instrument.id, statement.asOf);
      } else if (declaredValid) { total = instrument.manualValue; manualDates.set(instrument.id, declaredAt); }
    }
    if (total === undefined) continue;
    minor(total, 'Declared value'); requireValue(total >= 0, 'Declared value cannot be negative.');
    const allocations = instrument.valuationMethod === 'MANUAL_VALUE' ? manualAllocations : principalAllocations;
    const positions = [...state.entries()].filter(([, position]) => position.instrumentId === instrument.id && position.units > 0);
    const totalUnits = positions.reduce((total, [, position]) => total + position.units, 0);
    let allocated = 0;
    positions.forEach(([key, position], index) => {
      const value = index === positions.length - 1 ? total - allocated : Math.floor(total * position.units / totalUnits);
      allocated = add(allocated, value); allocations.set(key, value);
    });
  }
  return [...state.entries()].map(([key, stored]) => {
    const { purchasedCost, ...position } = stored;
    const instrument = instrumentsById.get(position.instrumentId);
    const price = instrument ? currentPrices.get(instrument.id) ?? null : null;
    position.averageCost = position.units > 0 ? fromMinor(position.costBasis, position.currency, precision) / position.units : 0;
    if (position.units === 0) position.marketValue = 0;
    else if (!instrument) position.issues.push({ code: 'missing_instrument', instrumentId: position.instrumentId, accountId: position.accountId });
    else if (instrument.valuationMethod === 'FIXED_PRINCIPAL') position.marketValue = position.costBasis;
    else if (manualAllocations.has(key)) { position.marketValue = manualAllocations.get(key)!; position.priceAsOf = manualDates.get(position.instrumentId) ?? null; }
    else if (instrument.valuationMethod === 'MANUAL_VALUE') position.issues.push({ code: 'missing_price', instrumentId: position.instrumentId, accountId: position.accountId });
    else if (price) {
      position.price = price.value; position.priceAsOf = price.asOf;
      position.marketValue = toMinor(position.units * price.value, price.currency, precision);
      position.stale = price.status === 'stale' || (price.status !== 'manual' && (!Number.isFinite(Date.parse(price.staleAfter)) || Date.parse(price.staleAfter) <= Date.parse(now)));
    } else if (instrument.valuationMethod === 'COMPOUNDING') position.marketValue = position.costBasis;
    else position.issues.push({ code: 'missing_price', instrumentId: position.instrumentId, accountId: position.accountId });
    if (position.units > 0 && instrument?.valuationMethod === 'COMPOUNDING' && instrument.annualRate !== undefined && instrument.startDate) {
      const principal = principalAllocations.get(key) ?? position.costBasis;
      const end = instrument.maturityDate ?? asOf, periods = instrument.compoundsPerYear ?? 1, tax = instrument.withholdingRate ?? 0;
      requireValue(validDate(instrument.startDate) && validDate(end) && end >= instrument.startDate, 'Projection dates are invalid.');
      requireValue(Number.isFinite(instrument.annualRate) && instrument.annualRate >= 0 && Number.isInteger(periods) && periods > 0 && periods <= 365
        && Number.isFinite(tax) && tax >= 0 && tax <= 1 && principal >= 0, 'Projection assumptions are invalid.');
      const years = (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${instrument.startDate}T00:00:00Z`)) / (365.25 * 86400000);
      position.projectedAsOf = end;
      const projected = minor(principal) * (1 + instrument.annualRate * (1 - tax) / periods) ** (periods * years);
      if (Number.isFinite(projected) && projected >= 0 && projected <= Number.MAX_SAFE_INTEGER) position.projectedValue = rounded(projected);
      else position.issues.push({ code: 'projection_unavailable', instrumentId: position.instrumentId, accountId: position.accountId });
    }
    position.unrealizedGain = position.marketValue === null ? null : position.marketValue - position.costBasis;
    position.totalReturn = position.unrealizedGain === null ? null : add(add(position.realizedGain, position.unrealizedGain), position.income);
    position.returnPercent = position.totalReturn === null || purchasedCost <= 0 ? null : position.totalReturn / purchasedCost * 100;
    return position;
  });
}

export type ValuationSettings = Pick<FinanceSettings, 'baseCurrency' | 'currencyPrecision'>;
export interface AccountValue {
  accountId: string;
  /** True cash balances broken down by currency. */
  cashBalances: Record<Currency, Money>;
  /** All of these amounts use the account's primary currency. */
  balance: Money;
  holdings: Money | null;
  value: Money | null;
  knownValue: Money;
  currency: Currency;
  baseValue: Money | null;
}
export interface NetWorthSummary {
  assets: Money | null;
  liabilities: Money | null;
  netWorth: Money | null;
  liquidNetWorth: Money | null;
  investableNetWorth: Money | null;
  fireAssets: Money | null;
  emergencyAssets: Money | null;
  knownAssets: Money;
  knownLiabilities: Money;
  knownNetWorth: Money;
  complete: boolean;
  issues: CalculationIssue[];
  accountValues: AccountValue[];
  missingFx: Currency[];
}

/** Balances already contain trade cash postings; only the holdings are added here. */
export function calculateNetWorthFromBalances(accounts: readonly Account[], balances: Readonly<Record<string, Record<Currency, Money> | Money>>, positions: readonly PositionSummary[], fxRates: readonly FxRate[], settings: ValuationSettings, asOf = today()): NetWorthSummary {
  throughDate(asOf); currencyScale(settings.baseCurrency, settings.currencyPrecision);
  const map = accountMap(accounts), issues: CalculationIssue[] = [], accountValues: AccountValue[] = [];
  const grouped = new Map<string, PositionSummary[]>();
  for (const position of positions) {
    requireValue(map.has(position.accountId), 'Position must belong to an existing account.');
    const rows = grouped.get(position.accountId) ?? []; rows.push(position); grouped.set(position.accountId, rows);
  }
  const totals = { assets: 0, liabilities: 0, liquid: 0, fire: 0, fireDebt: 0, emergency: 0 };
  const missing = { assets: false, liabilities: false, liquid: false, fire: false, fireDebt: false, emergency: false };
  for (const account of map.values()) {
    requireValue(Object.hasOwn(balances, account.id) || balances[account.id] !== undefined, 'Every account requires a calculated balance.');
    const rawCash = balances[account.id];
    const cash: Record<string, number> = typeof rawCash === 'number'
      ? { [account.currency]: rawCash }
      : (rawCash || {});
    let balance = 0, incomplete = false;
    for (const [curr, amt] of Object.entries(cash)) {
      if (!amt) continue;
      if (curr === account.currency) { balance = add(balance, minor(amt)); }
      else {
        const converted = convertMoney(amt, curr, account.currency, fxRates, asOf, settings.currencyPrecision);
        if (converted === null) { incomplete = true; issues.push({ code: 'missing_fx', accountId: account.id, currency: curr }); }
        else balance = add(balance, converted);
      }
    }
    let holdings = 0;
    for (const position of grouped.get(account.id) ?? []) {
      requireValue(!isLiability(account), 'Liability accounts cannot contain investment positions.');
      issues.push(...position.issues);
      if (position.marketValue === null) { incomplete = true; continue; }
      const converted = convertMoney(position.marketValue, position.currency, account.currency, fxRates, asOf, settings.currencyPrecision);
      if (converted === null) {
        incomplete = true; issues.push({ code: 'missing_fx', accountId: account.id, instrumentId: position.instrumentId, currency: position.currency });
      } else holdings = add(holdings, converted);
    }
    const knownValue = add(balance, holdings), value = incomplete ? null : knownValue;
    const knownBase = convertMoney(knownValue, account.currency, settings.baseCurrency, fxRates, asOf, settings.currencyPrecision);
    if (knownBase === null) issues.push({ code: 'missing_fx', accountId: account.id, currency: account.currency });
    const baseValue = value === null || knownBase === null ? null : knownBase;
    accountValues.push({ accountId: account.id, cashBalances: cash, balance, holdings: incomplete ? null : holdings, value, knownValue, currency: account.currency, baseValue });
    const amount = knownBase ?? 0, absent = baseValue === null, liability = isLiability(account);
    if (account.includeInNetWorth) {
      const key = liability ? 'liabilities' : 'assets'; totals[key] = add(totals[key], amount); missing[key] ||= absent;
    }
    if (!liability && account.includeInLiquidNetWorth) { totals.liquid = add(totals.liquid, amount); missing.liquid ||= absent; }
    if (account.includeInFire) {
      const key = liability ? 'fireDebt' : 'fire'; totals[key] = add(totals[key], amount); missing[key] ||= absent;
    }
    if (!liability && account.emergency && account.includeInLiquidNetWorth) { totals.emergency = add(totals.emergency, amount); missing.emergency ||= absent; }
  }
  const assets = missing.assets ? null : totals.assets, liabilities = missing.liabilities ? null : totals.liabilities;
  const missingFx = Array.from(
    new Set(
      issues
        .filter(i => i.code === 'missing_fx' && i.currency)
        .map(i => i.currency!)
    )
  );
  return {
    assets, liabilities, netWorth: assets === null || liabilities === null ? null : add(assets, -liabilities),
    liquidNetWorth: missing.liquid || liabilities === null ? null : add(totals.liquid, -liabilities),
    investableNetWorth: missing.fire || missing.fireDebt ? null : add(totals.fire, -totals.fireDebt),
    fireAssets: missing.fire ? null : totals.fire, emergencyAssets: missing.emergency ? null : totals.emergency,
    knownAssets: totals.assets, knownLiabilities: totals.liabilities, knownNetWorth: add(totals.assets, -totals.liabilities),
    complete: !Object.values(missing).some(Boolean), issues, accountValues, missingFx,
  };
}
export function calculateNetWorth(data: FinanceData, baseCurrencyOrSettings: Currency | ValuationSettings = 'PHP', asOf = today()): NetWorthSummary {
  const settings = typeof baseCurrencyOrSettings === 'string' ? { baseCurrency: baseCurrencyOrSettings } : baseCurrencyOrSettings;
  const balances = buildLedger(data.accounts, data.transactions, asOf, settings.currencyPrecision).balances;
  const positions = calculatePositions(data.transactions, data.instruments, data.prices, { asOf, currencyPrecision: settings.currencyPrecision });
  return calculateNetWorthFromBalances(data.accounts, balances, positions, data.fxRates, settings, asOf);
}

export interface CashFlowOptions {
  from?: string;
  to?: string;
  currency?: Currency;
  fxRates?: readonly FxRate[];
  currencyPrecision?: Precision;
  excludeCategoryIds?: readonly string[];
}
export interface CashFlowSummary {
  income: Money | null;
  expenses: Money | null;
  net: Money | null;
  knownIncome: Money;
  knownExpenses: Money;
  complete: boolean;
  issues: CalculationIssue[];
  byCategory: Record<string, Money>;
  investmentFees: Money | null;
  debtPrincipal: Money | null;
}
/** Consumption and earned income only. Trade proceeds and transfers are neither. */
export function calculateCashFlow(transactions: readonly Transaction[], accounts: readonly Account[], options: CashFlowOptions = {}): CashFlowSummary {
  const map = accountMap(accounts), from = options.from ?? '0001-01-01', to = options.to ?? today();
  throughDate(from); throughDate(to); requireValue(from <= to, 'Cash flow start date cannot follow its end date.');
  const currency = options.currency ?? 'PHP', excluded = new Set(options.excludeCategoryIds ?? []);
  currencyScale(currency, options.currencyPrecision);
  let income = 0, expenses = 0, investmentFees = 0, debtPrincipal = 0;
  let missingIncome = false, missingExpenses = false, missingFees = false, missingPrincipal = false;
  const issues: CalculationIssue[] = [], byCategory = moneyRecord();
  for (const transaction of chronological(transactions, to)) {
    if (transaction.date < from) continue;
    const account = map.get(transaction.accountId);
    requireValue(account, 'Cash flow transaction must have an existing account.');
    // This validates the same rules as ledger generation, without counting transfers as income.
    postingsForTransaction(transaction, map, options.currencyPrecision);
    const convert = (amount: Money): Money | null => {
      const converted = convertMoney(amount, transaction.currency, currency, options.fxRates ?? [], transaction.date, options.currencyPrecision);
      if (converted === null) issues.push({ code: 'missing_fx', currency: transaction.currency, transactionId: transaction.id, accountId: account.id });
      return converted;
    };
    const kind = transaction.type;
    const earned = kind === 'INCOME' || kind === 'DIVIDEND' || (kind === 'INTEREST' && !isLiability(account));
    const consumed = kind === 'EXPENSE' || kind === 'FEE' || kind === 'REFUND' || (kind === 'INTEREST' && isLiability(account));
    if (earned) {
      const converted = convert(transaction.amount);
      if (converted === null) missingIncome = true; else income = add(income, converted);
    } else if (consumed && !excluded.has(transaction.categoryId ?? '')) {
      const converted = convert((kind === 'REFUND' ? -1 : 1) * transaction.amount);
      if (converted === null) missingExpenses = true;
      else {
        expenses = add(expenses, converted);
        const category = transaction.categoryId ?? 'uncategorized';
        byCategory[category] = add(byCategory[category] ?? 0, converted);
      }
    }
    if (TRADE_TYPES.has(kind) && (transaction.fees ?? 0) > 0) {
      const converted = convert(transaction.fees!);
      if (converted === null) missingFees = true; else investmentFees = add(investmentFees, converted);
    }
    const destination = map.get(transaction.transferAccountId ?? '');
    if ((kind === 'TRANSFER' || kind === 'INVESTMENT_CONTRIBUTION' || kind === 'INVESTMENT_WITHDRAWAL')
      && !isLiability(account) && destination && isLiability(destination) && destination.accountType !== 'CREDIT_CARD') {
      // A payment can include previously accrued interest. Its split must be entered explicitly.
      if (transaction.principalAmount === undefined) {
        missingPrincipal = true; issues.push({ code: 'unclassified_principal', transactionId: transaction.id, accountId: destination.id }); continue;
      }
      const converted = convertMoney(transaction.principalAmount, destination.currency, currency, options.fxRates ?? [], transaction.date, options.currencyPrecision);
      if (converted === null) {
        missingPrincipal = true; issues.push({ code: 'missing_fx', currency: destination.currency, transactionId: transaction.id, accountId: destination.id });
      } else debtPrincipal = add(debtPrincipal, converted);
    }
  }
  return {
    income: missingIncome ? null : income, expenses: missingExpenses ? null : expenses,
    net: missingIncome || missingExpenses ? null : add(income, -expenses), knownIncome: income, knownExpenses: expenses,
    complete: !missingIncome && !missingExpenses, issues, byCategory,
    investmentFees: missingFees ? null : investmentFees, debtPrincipal: missingPrincipal ? null : debtPrincipal,
  };
}
export function calculateSavingsRate(flow: CashFlowSummary, options: SavingsRateOptions = {}) {
  const income = flow.income;
  const fees = options.includeInvestmentFees ? flow.investmentFees : 0;
  // Optional cash-retention view treats explicitly classified loan principal as an expense.
  // Credit-card repayments are excluded because their purchases already counted as spending.
  const principal = options.includeDebtPrincipal ? flow.debtPrincipal : 0;
  const expenses = flow.expenses === null || fees === null || principal === null ? null : add(add(flow.expenses, fees), principal);
  const saved = income === null || expenses === null ? null : add(income, -expenses);
  return { income, expenses, saved, rate: income === null || income <= 0 || saved === null ? null : saved / income };
}

export interface FireInput {
  annualSpending: Money;
  withdrawalRate: number;
  fireAssets: Money | null;
  essentialMonthlyExpenses?: Money;
  emergencyAssets?: Money | null;
}
export function calculateFire(input: FireInput) {
  minor(input.annualSpending, 'Annual spending');
  requireValue(input.annualSpending >= 0 && Number.isFinite(input.withdrawalRate) && input.withdrawalRate > 0 && input.withdrawalRate <= 1, 'FIRE assumptions must use nonnegative spending and a withdrawal fraction greater than zero and at most one.');
  if (input.fireAssets !== null) minor(input.fireAssets, 'FIRE assets');
  const target = input.annualSpending === 0 ? null : rounded(input.annualSpending / input.withdrawalRate);
  if (input.essentialMonthlyExpenses !== undefined) requireValue(Number.isFinite(input.essentialMonthlyExpenses)
    && input.essentialMonthlyExpenses >= 0 && input.essentialMonthlyExpenses <= Number.MAX_SAFE_INTEGER, 'Essential expense average must be finite and nonnegative.');
  if (input.emergencyAssets !== undefined && input.emergencyAssets !== null) minor(input.emergencyAssets);
  return {
    target, progress: target === null || input.fireAssets === null ? null : input.fireAssets / target,
    gap: target === null || input.fireAssets === null ? null : Math.max(0, add(target, -input.fireAssets)),
    emergencyMonths: !input.essentialMonthlyExpenses || input.emergencyAssets === undefined || input.emergencyAssets === null ? null : input.emergencyAssets / input.essentialMonthlyExpenses,
  };
}

export function periodBounds(period: string, type: 'monthly' | 'annual'): { from: string; to: string } {
  const valid = type === 'monthly' ? /^\d{4}-(0[1-9]|1[0-2])$/.test(period) : /^\d{4}$/.test(period);
  requireValue(valid, 'Budget period must be YYYY-MM for monthly or YYYY for annual.');
  const from = type === 'monthly' ? `${period}-01` : `${period}-01-01`;
  requireValue(validDate(from), 'Budget period is invalid.');
  const year = Number(period.slice(0, 4)), month = type === 'monthly' ? Number(period.slice(5, 7)) : 12;
  const day = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const to = `${period.slice(0, 4)}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return { from, to };
}
export function categoryDescendants(categoryId: string, categories: readonly Category[]): Set<string> {
  const result = new Set([categoryId]), children = new Map<string, string[]>();
  for (const category of categories) {
    if (category.deletedAt || !category.parentId) continue;
    const rows = children.get(category.parentId) ?? []; rows.push(category.id); children.set(category.parentId, rows);
  }
  const queue = [categoryId];
  for (let index = 0; index < queue.length; index++) {
    for (const id of children.get(queue[index]) ?? []) if (!result.has(id)) { result.add(id); queue.push(id); }
  }
  return result;
}
export function calculateBudget(budget: Budget, transactions: readonly Transaction[], accounts: readonly Account[], categories: readonly Category[] = [], fxRates: readonly FxRate[] = [], asOf = today()) {
  throughDate(asOf); minor(budget.amount, 'Budget'); requireValue(budget.amount >= 0, 'Budget cannot be negative.');
  const bounds = periodBounds(budget.period, budget.periodType);
  const accepted = budget.includeChildren === false ? new Set([budget.categoryId]) : categoryDescendants(budget.categoryId, categories);
  const end = asOf < bounds.to ? asOf : bounds.to;
  const flow = end < bounds.from ? { expenses: 0, knownExpenses: 0, complete: true, issues: [] as CalculationIssue[] }
    : calculateCashFlow(transactions.filter(transaction => accepted.has(transaction.categoryId ?? '')), accounts, { from: bounds.from, to: end, currency: budget.currency, fxRates });
  const spent = flow.expenses;
  const days = (Date.parse(`${bounds.to}T00:00:00Z`) - Date.parse(`${bounds.from}T00:00:00Z`)) / 86400000 + 1;
  const elapsed = end < bounds.from ? 0 : (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${bounds.from}T00:00:00Z`)) / 86400000 + 1;
  return {
    budget: budget.amount, spent, knownSpent: flow.knownExpenses,
    remaining: spent === null ? null : add(budget.amount, -spent),
    percentUsed: spent === null || budget.amount === 0 ? null : spent / budget.amount * 100,
    projectedSpend: spent === null ? null : elapsed === 0 ? 0 : rounded(spent * days / elapsed),
    complete: spent !== null, issues: flow.issues,
  };
}

export interface AmortizationRow { month: number; payment: Money; principal: Money; interest: Money; balance: Money; }
export function calculateAmortization(principal: Money, annualRate: number, termMonths: number) {
  minor(principal, 'Loan principal');
  requireValue(principal >= 0 && Number.isFinite(annualRate) && annualRate >= 0 && annualRate <= 100
    && Number.isSafeInteger(termMonths) && termMonths > 0 && termMonths <= 1200, 'Use nonnegative principal/rate and a term of 1 to 1200 months.');
  const schedule: AmortizationRow[] = [];
  if (principal === 0) return { monthlyPayment: 0, totalInterest: 0, totalPaid: 0, schedule };
  const rate = annualRate / 12;
  // expm1 avoids catastrophic cancellation for a tiny positive interest rate.
  const divisor = rate === 0 ? 0 : -Math.expm1(-termMonths * Math.log1p(rate));
  const monthlyPayment = Math.max(1, rounded(rate === 0 ? principal / termMonths : principal * rate / divisor));
  let balance = principal, totalInterest = 0, totalPaid = 0;
  for (let month = 1; month <= termMonths && balance > 0; month++) {
    const interest = rounded(balance * rate);
    const payment = month === termMonths ? add(balance, interest) : Math.min(monthlyPayment, add(balance, interest));
    const principalPaid = payment - interest;
    requireValue(principalPaid >= 0, 'Rounded payment cannot cover accrued interest.');
    balance = add(balance, -principalPaid); totalInterest = add(totalInterest, interest); totalPaid = add(totalPaid, payment);
    schedule.push({ month, payment, principal: principalPaid, interest, balance });
  }
  return { monthlyPayment, totalInterest, totalPaid, schedule };
}

/** A preview match key, never permission to discard an identical legitimate transaction. */
export function transactionFingerprint(transaction: Transaction): string {
  const normalize = (value?: string) => (value ?? '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en');
  return JSON.stringify([transaction.date, transaction.type, transaction.accountId, transaction.currency, transaction.amount,
    transaction.transferAccountId ?? '', transaction.transferAmount ?? null, transaction.transferCurrency ?? '', transaction.instrumentId ?? '',
    transaction.units ?? null, transaction.fees ?? 0, transaction.principalAmount ?? null, normalize(transaction.merchant), normalize(transaction.reference)]);
}
export const duplicateFingerprint = transactionFingerprint;
export function findDuplicateTransactions(existing: readonly Transaction[], incoming: readonly Transaction[]): { index: number; matches: string[] }[] {
  const groups = new Map<string, string[]>();
  for (const transaction of existing.filter(row => !row.deletedAt)) {
    const key = transactionFingerprint(transaction), ids = groups.get(key) ?? []; ids.push(transaction.id); groups.set(key, ids);
  }
  const matches: { index: number; matches: string[] }[] = [];
  incoming.forEach((transaction, index) => {
    const key = transactionFingerprint(transaction), ids = groups.get(key) ?? [];
    if (ids.length) matches.push({ index, matches: [...ids] });
    groups.set(key, [...ids, transaction.id]);
  });
  return matches;
}

/** Ledger postings are swept once; a historical valuation never uses a later price or FX rate. */
export function netWorthHistory(data: FinanceData, baseCurrencyOrSettings: Currency | ValuationSettings, dates: readonly string[]): (NetWorthSummary & { date: string })[] {
  const settings = typeof baseCurrencyOrSettings === 'string' ? { baseCurrency: baseCurrencyOrSettings } : baseCurrencyOrSettings;
  const days = [...new Set(dates)].sort(); days.forEach(throughDate);
  const map = accountMap(data.accounts), ordered = chronological(data.transactions);
  const balances: Record<string, Record<Currency, Money>> = Object.create(null);
  const opened = new Set<string>(), trades: Transaction[] = [];
  for (const account of map.values()) balances[account.id] = Object.create(null);
  let index = 0;
  return days.map(date => {
    for (const account of map.values()) if (!opened.has(account.id) && account.openingDate <= date) {
      if (account.openingBalances) {
        for (const [curr, amt] of Object.entries(account.openingBalances)) {
          balances[account.id][curr] = add(balances[account.id][curr] || 0, amt);
        }
      } else if (account.openingBalance !== undefined) {
        balances[account.id][account.currency] = add(balances[account.id][account.currency] || 0, account.openingBalance);
      }
      opened.add(account.id);
    }
    while (index < ordered.length && ordered[index].date <= date) {
      const transaction = ordered[index++];
      for (const posting of postingsForTransaction(transaction, map, settings.currencyPrecision)) {
        const b = balances[posting.accountId] ??= Object.create(null);
        b[posting.currency] = add(b[posting.currency] || 0, posting.delta);
      }
      if (transaction.instrumentId && (TRADE_TYPES.has(transaction.type) || transaction.type === 'DIVIDEND' || transaction.type === 'INTEREST')) trades.push(transaction);
    }
    const positions = calculatePositions(trades, data.instruments, data.prices, { asOf: date, currencyPrecision: settings.currencyPrecision });
    return { date, ...calculateNetWorthFromBalances(data.accounts, balances, positions, data.fxRates, settings, date) };
  });
}
