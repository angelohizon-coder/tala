import Dexie from 'dexie';
import { ACCOUNT_TYPES, TRANSACTION_TYPES, INSTRUMENT_TYPES, type Entity, type Transaction, type Account } from '../core/types';
import { postingsForTransaction, calculatePositions } from '../core/calculations';
import { financeDb, FINANCE_TABLES, type FinanceDatabase, type FinanceTableName, type FinanceTableMap, type SyncedEntity, type StoredMetadata } from './database';

export const DEFAULT_FINANCE_SETTINGS = { id: 'finance', baseCurrency: 'PHP', withdrawalRate: 0.04, selectedAnnualSpendingBasis: 'MANUAL' as const, annualSpending: 0, essentialCategoryIds: [] as string[], inflationAssumption: 0.03, investmentReturnAssumption: 0.06, monthlyContribution: 0, privacyMode: 'LOCAL_ONLY' as const };
const id = () => crypto.randomUUID();
const stamp = () => new Date().toISOString();
const active = (row: Entity) => !row.deletedAt;
const string = (value: unknown, max = 500) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
const money = (value: unknown, signed = false) => Number.isSafeInteger(value) && (signed || (value as number) >= 0);
const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value);
const currency = (value: unknown) => typeof value === 'string' && /^[A-Z]{3}$/u.test(value);
export function validDate(value: unknown): value is string { if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false; const date = new Date(`${value}T00:00:00Z`); return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value; }
function required(ok: unknown, message = 'The financial record is invalid.'): asserts ok { if (!ok) throw new Error(message); }
const today = () => { const date = new Date(); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; };

/** Shared boundary validation for forms, backups, imports and authenticated sync. */
export function validateFinanceRecord(table: FinanceTableName, input: unknown): asserts input is FinanceTableMap[FinanceTableName] {
  required(input && typeof input === 'object' && !Array.isArray(input));
  const row = input as Record<string, unknown>;
  required(string(row.id, 200) && /^[A-Za-z0-9_.:-]+$/u.test(row.id as string), 'A valid record ID is required.');
  for (const key of ['createdAt', 'updatedAt', 'deletedAt']) if (row[key] != null) required(typeof row[key] === 'string' && /T/u.test(row[key] as string) && Number.isFinite(Date.parse(row[key] as string)));
  if (row.version !== undefined) required(Number.isSafeInteger(row.version) && (row.version as number) >= 1);
  if (row.ownerId !== undefined) required(string(row.ownerId, 200));
  if (row.deviceId !== undefined) required(string(row.deviceId, 200));
  if (table === 'accounts') {
    required(string(row.name, 200) && ACCOUNT_TYPES.includes(row.accountType as Account['accountType']) && currency(row.currency) && validDate(row.openingDate));
    if (row.openingBalances) {
      required(typeof row.openingBalances === 'object' && !Array.isArray(row.openingBalances));
      for (const [curr, amt] of Object.entries(row.openingBalances as Record<string, unknown>)) required(currency(curr) && money(amt as number, true));
    } else required(money(row.openingBalance, true));
    for (const key of ['includeInNetWorth', 'includeInLiquidNetWorth', 'includeInFire', 'emergency', 'archived']) required(typeof row[key] === 'boolean');
  } else if (table === 'transactions') {
    required(TRANSACTION_TYPES.includes(row.type as Transaction['type']) && validDate(row.date) && money(row.amount, row.type === 'BALANCE_ADJUSTMENT') && currency(row.currency) && string(row.accountId, 200));
    if (row.type !== 'BALANCE_ADJUSTMENT') required((row.amount as number) > 0, 'Transaction amounts must be positive minor units.');
    if (row.fees !== undefined) required(money(row.fees));
    if (row.transferAmount !== undefined) required(money(row.transferAmount));
    if (row.principalAmount !== undefined) required(money(row.principalAmount));
    if (row.transferCurrency !== undefined) required(currency(row.transferCurrency));
    if (row.units !== undefined) required(finite(row.units) && (row.units as number) > 0);
    if (row.unitPrice !== undefined) required(finite(row.unitPrice) && (row.unitPrice as number) >= 0);
    if (row.tags !== undefined) required(Array.isArray(row.tags) && row.tags.length <= 100 && row.tags.every(tag => string(tag, 100)));
    for (const key of ['merchant', 'notes', 'reference']) if (row[key] !== undefined) required(typeof row[key] === 'string' && (row[key] as string).length <= 10000);
  } else if (table === 'postings') required(string(row.transactionId, 200) && string(row.accountId, 200) && validDate(row.date) && currency(row.currency) && money(row.delta, true));
  else if (table === 'categories') required(string(row.name, 200) && ['expense', 'income'].includes(row.kind as string) && typeof row.color === 'string' && typeof row.essential === 'boolean' && typeof row.archived === 'boolean');
  else if (table === 'instruments') {
    required(string(row.name, 200) && currency(row.currency) && INSTRUMENT_TYPES.includes(row.instrumentType as never) && ['LIVE_MARKET', 'DAILY_NAV', 'MANUAL_PRICE', 'FIXED_PRINCIPAL', 'COMPOUNDING', 'MANUAL_VALUE'].includes(row.valuationMethod as string) && (row.manualValue === undefined || money(row.manualValue)));
    if (row.principal !== undefined) required(money(row.principal));
    for (const key of ['startDate', 'maturityDate']) if (row[key] !== undefined) required(validDate(row[key]));
    if (row.startDate !== undefined && row.maturityDate !== undefined) required(String(row.maturityDate) >= String(row.startDate));
    for (const key of ['annualRate', 'withholdingRate']) if (row[key] !== undefined) required(finite(row[key]) && (row[key] as number) >= 0 && (row[key] as number) <= 1);
    if (row.compoundsPerYear !== undefined) required(Number.isInteger(row.compoundsPerYear) && (row.compoundsPerYear as number) >= 1 && (row.compoundsPerYear as number) <= 365);
    if (row.manualValueAsOf !== undefined) required(typeof row.manualValueAsOf === 'string' && validDate(row.manualValueAsOf.slice(0, 10)) && Number.isFinite(Date.parse(row.manualValueAsOf)));
    if (row.valuationMethod === 'COMPOUNDING') required(money(row.principal) && validDate(row.startDate) && validDate(row.maturityDate) && finite(row.annualRate), 'Compounding needs explicit principal, dates and rate assumptions.');
  }
  else if (table === 'prices') required(string(row.instrumentId, 200) && finite(row.value) && (row.value as number) >= 0 && currency(row.currency) && typeof row.asOf === 'string' && Number.isFinite(Date.parse(row.asOf)) && typeof row.fetchedAt === 'string' && Number.isFinite(Date.parse(row.fetchedAt)) && typeof row.staleAfter === 'string' && Number.isFinite(Date.parse(row.staleAfter)) && string(row.source) && ['fresh', 'stale', 'manual', 'error'].includes(row.status as string));
  else if (table === 'fxRates') required(currency(row.fromCurrency) && currency(row.toCurrency) && finite(row.rate) && (row.rate as number) > 0 && typeof row.asOf === 'string' && Number.isFinite(Date.parse(row.asOf)) && string(row.source));
  else if (table === 'budgets') required(string(row.categoryId, 200) && money(row.amount) && currency(row.currency) && (row.periodType === 'monthly' ? /^\d{4}-(?:0[1-9]|1[0-2])$/u.test(String(row.period)) : row.periodType === 'annual' && /^\d{4}$/u.test(String(row.period))));
  else if (table === 'recurringRules') required(string(row.name, 200) && ['daily', 'weekly', 'monthly', 'quarterly', 'annual'].includes(row.frequency as string) && validDate(row.startDate) && validDate(row.nextDate) && typeof row.active === 'boolean' && row.template && typeof row.template === 'object' && (row.monthlyDay === undefined || Number.isInteger(row.monthlyDay) && (row.monthlyDay as number) >= 1 && (row.monthlyDay as number) <= 31));
  else if (table === 'liabilityTerms') required(string(row.accountId, 200) && finite(row.annualInterestRate) && (row.annualInterestRate as number) >= 0 && money(row.minimumPayment) && (row.dueDay === undefined || Number.isInteger(row.dueDay) && (row.dueDay as number) >= 1 && (row.dueDay as number) <= 31));
  else if (table === 'goals') required(string(row.name, 200) && money(row.target) && currency(row.currency));
  else if (table === 'investmentLots') required(string(row.accountId, 200) && string(row.instrumentId, 200) && string(row.transactionId, 200) && validDate(row.date) && finite(row.units) && (row.units as number) >= 0 && money(row.costBasis) && currency(row.currency));
  else if (table === 'balanceSnapshots') required((row.accountId === undefined || string(row.accountId, 200)) && validDate(row.date) && (money(row.balance, true) || money(row.netWorth, true)) && currency(row.currency));
  else if (table === 'settings') {
    required(string(row.key, 200) && Object.hasOwn(row, 'value'));
    if (row.key === 'finance') {
      const settings = row.value as Record<string, unknown>; required(settings && currency(settings.baseCurrency) && finite(settings.withdrawalRate) && (settings.withdrawalRate as number) > 0 && (settings.withdrawalRate as number) <= 1 && money(settings.annualSpending) && money(settings.monthlyContribution) && finite(settings.inflationAssumption) && finite(settings.investmentReturnAssumption) && ['MANUAL', 'TRAILING_12_MONTHS'].includes(settings.selectedAnnualSpendingBasis as string) && Array.isArray(settings.essentialCategoryIds) && settings.essentialCategoryIds.every(value => string(value, 200)));
      if (settings.privacyMode !== undefined) required(['LOCAL_ONLY', 'CLOUD_SYNC'].includes(settings.privacyMode as string));
      if (settings.currencyPrecision !== undefined) { required(settings.currencyPrecision && typeof settings.currencyPrecision === 'object' && !Array.isArray(settings.currencyPrecision)); for (const [code, digits] of Object.entries(settings.currencyPrecision)) required(currency(code) && Number.isInteger(digits) && (digits as number) >= 0 && (digits as number) <= 8); }
      if (settings.savingsRate !== undefined) {
        const savings = settings.savingsRate as Record<string, unknown>; required(savings && typeof savings === 'object' && !Array.isArray(savings));
        for (const key of ['includeInvestmentFees', 'includeDebtPrincipal']) if (savings[key] !== undefined) required(typeof savings[key] === 'boolean');
        if (savings.excludeCategoryIds !== undefined) required(Array.isArray(savings.excludeCategoryIds) && savings.excludeCategoryIds.every(value => string(value, 200)));
      }
    }
  }
  else if (table === 'transactionTags') required(string(row.transactionId, 200) && string(row.tagId, 200));
  else required(string(row.name, 200));
}

export interface TransactionFilter { start?: string; end?: string; accountId?: string; institutionId?: string; categoryId?: string; type?: Transaction['type']; currency?: string; tag?: string; search?: string; offset?: number; limit?: number; }
export interface ImportPreviewRow { transaction: Transaction; fingerprint: string; duplicate: boolean; reason?: string; }
export interface ImportPreview { rows: ImportPreviewRow[]; duplicateCount: number; validCount: number; }
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)])) : value;
const sameRecord = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
function sameDerivedValues(table: FinanceTableName, local: Entity, remote: Entity) {
  const keys = table === 'postings' ? ['transactionId', 'accountId', 'date', 'currency', 'delta', 'instrumentId', 'unitsDelta'] : ['accountId', 'instrumentId', 'transactionId', 'date', 'currency', 'units', 'costBasis', 'realizedGain'];
  const values = (row: Entity) => [Boolean(row.deletedAt), ...keys.map(key => (row as unknown as Record<string, unknown>)[key] ?? null)];
  return sameRecord(values(local), values(remote));
}

export async function transactionFingerprint(transaction: Transaction) {
  const normalize = (value: string | undefined) => (value ?? '').normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
  const payload = JSON.stringify([transaction.accountId, transaction.date, transaction.currency, transaction.amount, transaction.type, transaction.fees ?? 0, normalize(transaction.merchant), normalize(transaction.reference), transaction.transferAccountId ?? '', transaction.transferAmount ?? null]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function createFinanceRepository(db: FinanceDatabase = financeDb) {
  // Dexie must see an async scope so nested native awaits keep their transaction context.
  const atomic = <T>(work: () => Promise<T>) => db.transaction('rw', db.tables, async () => await work());
  async function context() {
    let device = await db.syncState.get('deviceId');
    if (!device) { device = { id: 'deviceId', value: id() }; await db.syncState.put(device); }
    return { deviceId: String(device.value), ownerId: String((await db.syncState.get('ownerId'))?.value ?? 'local') };
  }
  async function put<K extends FinanceTableName>(table: K, input: FinanceTableMap[K], enqueue = true, remote = false) {
    validateFinanceRecord(table, input);
    const existing = await db.table<FinanceTableMap[K], string>(table).get(input.id);
    const identity = await context(), timestamp = stamp();
    const metadata: StoredMetadata = remote ? { id: input.id, ownerId: input.ownerId!, createdAt: input.createdAt!, updatedAt: input.updatedAt!, version: input.version!, deletedAt: input.deletedAt ?? null, deviceId: input.deviceId! } : {
      id: input.id, ownerId: existing?.ownerId ?? identity.ownerId, deviceId: identity.deviceId,
      createdAt: existing?.createdAt ?? timestamp, updatedAt: timestamp, version: (existing?.version ?? 0) + 1, deletedAt: input.deletedAt ?? null,
    };
    const row = { ...input, ...metadata } as FinanceTableMap[K] & StoredMetadata;
    await db.table(table).put(row);
    if (enqueue) await db.syncOutbox.add({ id: id(), tableName: table, entityId: row.id, ownerId: row.ownerId, baseVersion: existing?.version ?? 0, payload: row as unknown as SyncedEntity, status: 'pending', attempts: 0, createdAt: timestamp });
    return row;
  }
  async function tombstone(table: FinanceTableName, record: Entity, enqueue = true, remote = false, metadata?: Entity) {
    await put(table, { ...record, ...metadata, id: record.id, deletedAt: metadata?.deletedAt ?? stamp() } as FinanceTableMap[typeof table], enqueue, remote);
  }
  async function precision() { return ((await db.settings.get('finance'))?.value as { currencyPrecision?: Record<string, number> } | undefined)?.currencyPrecision; }
  async function rebuildPair(accountId: string, instrumentId: string, enqueue = true) {
    const transactions = await db.transactions.where('[accountId+instrumentId]').equals([accountId, instrumentId]).filter(active).toArray();
    const instrument = await db.instruments.get(instrumentId);
    required(instrument && active(instrument), 'The investment instrument is unavailable.');
    const currencyPrecision = await precision(), latestDate = [...transactions].map(transaction => transaction.date).sort().at(-1);
    if (latestDate && latestDate > today()) calculatePositions(transactions, [instrument], [], { asOf: latestDate, currencyPrecision });
    const position = calculatePositions(transactions, [instrument], [], { currencyPrecision })[0];
    const lotId = `position:${accountId}:${instrumentId}`;
    if (!position) { const old = await db.investmentLots.get(lotId); if (old && active(old)) await tombstone('investmentLots', old, enqueue); return; }
    const last = [...transactions].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id)).at(-1)!;
    const value = position as unknown as { units: number; costBasis: number; realizedGain: number };
    await put('investmentLots', { id: lotId, accountId, instrumentId, transactionId: last.id, date: last.date, units: value.units, costBasis: Math.round(value.costBasis), realizedGain: Math.round(value.realizedGain), currency: instrument.currency }, enqueue);
  }
  async function writeTransaction(input: Transaction, fingerprint?: string, enqueue = true, remote = false) {
    validateFinanceRecord('transactions', input);
    const previous = await db.transactions.get(input.id);
    const accountIds = [...new Set([input.accountId, input.transferAccountId].filter(Boolean))] as string[];
    const accounts = (await db.accounts.bulkGet(accountIds)).filter(Boolean) as Account[];
    required(accounts.length === accountIds.length && accounts.every(active), 'Every transaction account must exist and be active.');
    required(accounts.every(account => input.date >= account.openingDate), 'A transaction cannot precede the account opening date.');
    if (input.categoryId) required(active((await db.categories.get(input.categoryId)) ?? { id: '', deletedAt: 'missing' }), 'The category is unavailable.');
    if (input.instrumentId) required(active((await db.instruments.get(input.instrumentId)) ?? { id: '', deletedAt: 'missing' }), 'The instrument is unavailable.');
    const postings = input.deletedAt ? [] : postingsForTransaction(input, accounts, await precision());
    const stored = await put('transactions', input, enqueue, remote);
    const former = await db.postings.where('transactionId').equals(input.id).toArray(), wanted = new Set<string>();
    for (let index = 0; index < postings.length; index++) {
      const postingId = `posting:${input.id}:${index}`; wanted.add(postingId);
      await put('postings', { ...postings[index], id: postingId, deletedAt: null, ...(remote ? { ownerId: stored.ownerId, createdAt: stored.createdAt, updatedAt: stored.updatedAt, version: stored.version, deviceId: stored.deviceId } : {}) }, enqueue, remote);
    }
    for (const old of former) if (active(old) && !wanted.has(old.id)) await tombstone('postings', old, enqueue, remote, remote ? stored : undefined);
    const pairs = new Map<string, [string, string]>();
    for (const transaction of [previous, stored]) if (transaction?.instrumentId) pairs.set(`${transaction.accountId}:${transaction.instrumentId}`, [transaction.accountId, transaction.instrumentId]);
    for (const [accountId, instrumentId] of pairs.values()) await rebuildPair(accountId, instrumentId, enqueue);
    if (fingerprint) await db.importFingerprints.put({ id: fingerprint, transactionId: input.id, createdAt: stamp() });
    return stored;
  }

  async function saveTransaction(transaction: Transaction) { const computation = transactionFingerprint(transaction); const fingerprint = await (Dexie.currentTransaction ? Dexie.waitFor(computation) : computation); return atomic(() => writeTransaction(transaction, fingerprint)); }
  async function deleteTransaction(transactionId: string) { return atomic(async () => { const prior = await db.transactions.get(transactionId); required(prior, 'Transaction not found.'); if (prior.deletedAt) return prior; return writeTransaction({ ...prior, deletedAt: stamp() }); }); }
  async function save<K extends FinanceTableName>(table: K, entity: FinanceTableMap[K]) {
    if (table === 'transactions') return saveTransaction(entity as Transaction) as Promise<FinanceTableMap[K]>;
    required(!['postings', 'investmentLots'].includes(table), 'Postings and investment lots are generated by transactions.');
    return atomic(async () => {
      if (table === 'accounts') {
        const prior = await db.accounts.get(entity.id), next = entity as Account;
        if (prior && (prior.currency !== next.currency || prior.accountType !== next.accountType)) required(!await db.postings.where('accountId').equals(entity.id).filter(active).count(), 'Currency and account type cannot change after transactions exist.');
        if (prior && next.openingDate > prior.openingDate) required(!await db.postings.where('[accountId+date]').between([entity.id, Dexie.minKey], [entity.id, next.openingDate], true, false).filter(active).count(), 'Opening date cannot move past existing transactions.');
      }
      if (table === 'categories' && (entity as FinanceTableMap['categories']).parentId) {
        const visited = new Set([entity.id]); let parent = (entity as FinanceTableMap['categories']).parentId;
        while (parent) { required(!visited.has(parent), 'Category hierarchy cannot contain a cycle.'); visited.add(parent); const row = await db.categories.get(parent); required(row && active(row), 'Parent category is unavailable.'); required(row.kind === (entity as FinanceTableMap['categories']).kind, 'Parent and child categories must share the same kind.'); parent = row.parentId; }
      }
      if (table === 'prices') { const price = entity as FinanceTableMap['prices']; required(price.status !== 'error', 'Failed prices cannot replace valid cached valuations.'); const instrument = await db.instruments.get(price.instrumentId); required(instrument && price.currency === instrument.currency, 'Price currency must match its instrument.'); }
      if (table === 'recurringRules') { const rule = entity as FinanceTableMap['recurringRules']; validateFinanceRecord('transactions', { ...rule.template, id: 'preview', date: rule.nextDate }); }
      return put(table, entity);
    });
  }
  async function remove(table: FinanceTableName, entityId: string) {
    if (table === 'transactions') return deleteTransaction(entityId);
    return atomic(async () => {
      const record = await db.table<Entity, string>(table).get(entityId); required(record, 'Record not found.');
      if (table === 'accounts') required(!await db.postings.where('accountId').equals(entityId).filter(active).count(), 'Archive accounts with existing transactions instead of deleting them.');
      if (table === 'instruments') required(!await db.transactions.where('instrumentId').equals(entityId).filter(active).count(), 'Archive instruments with existing trades instead of deleting them.');
      required(!['postings', 'investmentLots'].includes(table), 'Delete the parent transaction instead.');
      return tombstone(table, record);
    });
  }
  async function listTransactions(filter: TransactionFilter = {}) {
    const start = filter.start ?? '0000-01-01', end = filter.end ?? '9999-12-31';
    const institutionAccounts = filter.institutionId ? new Set((await db.accounts.where('institutionId').equals(filter.institutionId).filter(active).primaryKeys()) as string[]) : null;
    if (institutionAccounts && !institutionAccounts.size) return { items: [], total: 0 };
    let query = filter.accountId ? db.transactions.where('[accountId+date]').between([filter.accountId, start], [filter.accountId, end], true, true) : filter.categoryId ? db.transactions.where('[categoryId+date]').between([filter.categoryId, start], [filter.categoryId, end], true, true) : filter.type ? db.transactions.where('[type+date]').between([filter.type, start], [filter.type, end], true, true) : db.transactions.where('date').between(start, end, true, true);
    query = query.filter(row => active(row) && (!institutionAccounts || institutionAccounts.has(row.accountId)) && (!filter.categoryId || row.categoryId === filter.categoryId) && (!filter.type || row.type === filter.type) && (!filter.currency || row.currency === filter.currency) && (!filter.tag || row.tags?.includes(filter.tag) === true) && (!filter.search || `${row.merchant ?? ''} ${row.notes ?? ''} ${row.reference ?? ''}`.toLowerCase().includes(filter.search.toLowerCase())));
    const total = await query.count();
    const items = await query.reverse().offset(Math.max(0, filter.offset ?? 0)).limit(Math.min(500, Math.max(1, filter.limit ?? 100))).toArray();
    return { items, total };
  }
  async function accountBalances(asOf = today()) {
    const accounts = await db.accounts.filter(active).toArray();
    const balances: Record<string, Record<string, number>> = Object.create(null);
    for (const account of accounts) {
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
    await db.postings.where('date').belowOrEqual(asOf).each(posting => {
      if (active(posting) && Object.hasOwn(balances, posting.accountId)) {
        const b = balances[posting.accountId];
        const next = (b[posting.currency] || 0) + posting.delta;
        required(Number.isSafeInteger(next), 'Balance exceeds supported precision.');
        b[posting.currency] = next;
      }
    });
    return balances;
  }
  async function monthlyCashFlow(start: string, end: string, targetCurrency = 'PHP') {
    required(validDate(start) && validDate(end) && start <= end && currency(targetCurrency));
    const byCurrency: Record<string, { income: number; expenses: number; net: number }> = Object.create(null), months: Record<string, Record<string, { income: number; expenses: number; net: number }>> = Object.create(null);
    await db.transactions.where('date').between(start, end, true, true).each(row => {
      if (!active(row)) return;
      let income = 0, expenses = 0;
      if (['INCOME', 'INTEREST', 'DIVIDEND'].includes(row.type)) income = row.amount;
      else if (['EXPENSE', 'FEE'].includes(row.type)) expenses = row.amount;
      else if (row.type === 'REFUND') expenses = -row.amount;
      if (['INVESTMENT_BUY', 'INVESTMENT_SELL'].includes(row.type)) expenses += row.fees ?? 0;
      if (!income && !expenses) return;
      const values = byCurrency[row.currency] ??= { income: 0, expenses: 0, net: 0 }; values.income += income; values.expenses += expenses; values.net = values.income - values.expenses;
      const month = months[row.date.slice(0, 7)] ??= Object.create(null), monthly = month[row.currency] ??= { income: 0, expenses: 0, net: 0 }; monthly.income += income; monthly.expenses += expenses; monthly.net = monthly.income - monthly.expenses;
    });
    const native = byCurrency[targetCurrency] ?? { income: 0, expenses: 0, net: 0 }, unresolvedCurrencies = Object.keys(byCurrency).filter(value => value !== targetCurrency);
    return { ...native, currency: targetCurrency, byCurrency, months, unresolvedCurrencies };
  }
  async function portfolio() {
    const transactions = await db.transactions.where('type').anyOf(['INVESTMENT_BUY', 'INVESTMENT_SELL', 'DIVIDEND', 'INTEREST']).filter(active).toArray();
    return calculatePositions(transactions, await db.instruments.filter(active).toArray(), await db.prices.filter(active).toArray(), { currencyPrecision: await precision() });
  }
  function getSetting<T>(key: string, fallback: T): Promise<T>;
  function getSetting<T>(key: string): Promise<T | undefined>;
  async function getSetting<T>(key: string, fallback?: T): Promise<T | undefined> { const row = await db.settings.get(key); return row && active(row) ? row.value as T : fallback; }
  async function setSetting<T>(key: string, value: T) { return save('settings', { id: key, key, value }); }
  async function confirmRecurring(ruleId: string, date: string) {
    required(validDate(date), 'A valid occurrence date is required.');
    const rule = await db.recurringRules.get(ruleId); required(rule && active(rule) && rule.active, 'Recurring rule is unavailable.');
    required(date >= rule.startDate && (!rule.endDate || date <= rule.endDate), 'Occurrence is outside the rule dates.');
    const occurrenceId = `occurrence:${ruleId}:${date}`, transaction: Transaction = { ...rule.template, id: `recurring:${ruleId}:${date}`, date };
    const fingerprint = await transactionFingerprint(transaction);
    return atomic(async () => {
      const existing = await db.recurringOccurrences.get(occurrenceId); if (existing) return (await db.transactions.get(existing.transactionId))!;
      const latest = await db.recurringRules.get(ruleId); required(latest && latest.version === rule.version && latest.active && active(latest), 'Recurring rule changed; review the occurrence again.');
      const stored = await writeTransaction(transaction, fingerprint);
      await db.recurringOccurrences.add({ id: occurrenceId, ruleId, date, transactionId: stored.id, createdAt: stamp() });
      const next = new Date(`${date}T12:00:00Z`);
      if (rule.frequency === 'daily' || rule.frequency === 'weekly') next.setUTCDate(next.getUTCDate() + (rule.frequency === 'daily' ? 1 : 7));
      else { const day = rule.monthlyDay ?? next.getUTCDate(), increase = rule.frequency === 'monthly' ? 1 : rule.frequency === 'quarterly' ? 3 : 12; next.setUTCDate(1); next.setUTCMonth(next.getUTCMonth() + increase); const maximum = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate(); next.setUTCDate(Math.min(day, maximum)); }
      await put('recurringRules', { ...latest, nextDate: next.toISOString().slice(0, 10) }); return stored;
    });
  }
  async function previewImport(transactions: Transaction[]): Promise<ImportPreview> {
    required(Array.isArray(transactions) && transactions.length <= 100000, 'Import is too large.');
    const seen = new Set<string>(), rows: ImportPreviewRow[] = [];
    for (const transaction of transactions) {
      validateFinanceRecord('transactions', transaction); const fingerprint = await transactionFingerprint(transaction);
      const stored = await db.importFingerprints.get(fingerprint), duplicate = seen.has(fingerprint) || Boolean(stored);
      rows.push({ transaction, fingerprint, duplicate, ...(duplicate ? { reason: seen.has(fingerprint) ? 'Duplicate within this file' : 'Already recorded' } : {}) }); seen.add(fingerprint);
    }
    return { rows, duplicateCount: rows.filter(row => row.duplicate).length, validCount: rows.filter(row => !row.duplicate).length };
  }
  async function importStatement(preview: ImportPreview, options: { skipDuplicates?: boolean } = {}) {
    const verified = await previewImport(preview.rows.map(row => row.transaction));
    if (!options.skipDuplicates) required(verified.duplicateCount === 0, 'Duplicate rows require explicit skip confirmation.');
    return atomic(async () => {
      let imported = 0, skipped = 0;
      for (const row of verified.rows) {
        const existing = await db.importFingerprints.get(row.fingerprint);
        if (row.duplicate || existing) { required(options.skipDuplicates, 'The import changed; duplicate rows require confirmation.'); skipped++; continue; }
        required(!await db.transactions.get(row.transaction.id), 'An imported transaction ID already exists.');
        await writeTransaction(row.transaction, row.fingerprint); imported++;
      }
      return { imported, skipped };
    });
  }
  async function assignOwner(ownerId: string, options: { confirmed: boolean }) {
    required(options.confirmed === true && string(ownerId, 200) && ownerId !== 'local', 'Explicit authenticated ownership confirmation is required.');
    return atomic(async () => {
      for (const table of FINANCE_TABLES) required(!await db.table<Entity, string>(table).filter(row => Boolean(row.ownerId && row.ownerId !== 'local' && row.ownerId !== ownerId)).count(), 'This database belongs to another cloud account; export it before changing users.');
      await db.syncState.put({ id: 'ownerId', value: ownerId });
      await db.syncOutbox.where('ownerId').equals('local').delete();
      const device = await context();
      for (const table of FINANCE_TABLES) {
        const rows = await db.table<Entity, string>(table).filter(row => !row.ownerId || row.ownerId === 'local').toArray();
        for (const row of rows) { const payload = { ...row, ownerId, deviceId: device.deviceId, createdAt: row.createdAt ?? stamp(), updatedAt: stamp(), version: 1, deletedAt: row.deletedAt ?? null } as SyncedEntity; await db.table(table).put(payload); await db.syncOutbox.add({ id: id(), tableName: table, entityId: row.id, ownerId, baseVersion: 0, payload, status: 'pending', attempts: 0, createdAt: stamp() }); }
      }
    });
  }
  async function applyRemoteRecords(records: { tableName: FinanceTableName; record: SyncedEntity }[], ownerId: string) {
    return atomic(async () => {
      const identity = await context(); required(identity.ownerId === ownerId && ownerId !== 'local', 'Authenticated ownership mismatch.');
      const retainConflict = async (tableName: FinanceTableName, local: Entity, record: SyncedEntity) => {
        await db.conflicts.put({ id: `conflict:${tableName}:${record.id}:${record.version}`, tableName, entityId: record.id, ownerId, local: local as SyncedEntity, remote: record, createdAt: stamp() });
        await db.syncOutbox.where('[tableName+entityId]').equals([tableName, record.id]).modify({ status: 'conflict' });
      };
      const rank = (table: FinanceTableName) => ['accounts', 'categories', 'instruments', 'institutions'].includes(table) ? 0 : table === 'transactions' ? 1 : 2;
      const sorted = [...records].sort((a, b) => rank(a.tableName) - rank(b.tableName));
      for (const { tableName, record } of sorted) {
        required(FINANCE_TABLES.includes(tableName) && record.ownerId === ownerId, 'Foreign financial records are blocked.'); validateFinanceRecord(tableName, record);
        required(record.createdAt && record.updatedAt && record.deviceId && Number.isSafeInteger(record.version), 'Remote metadata is incomplete.');
        const local = await db.table<Entity, string>(tableName).get(record.id);
        if (local && sameRecord(local, record)) continue;
        const pendingWrites = await db.syncOutbox.where('[tableName+entityId]').equals([tableName, record.id]).count();
        if (tableName === 'postings' || tableName === 'investmentLots') {
          // Transactions regenerate the journal and holdings atomically. A separately
          // arriving child may update metadata only when its money matches that journal.
          if (!local) continue;
          const transactionId = String(record.transactionId);
          const parent = await db.transactions.get(transactionId);
          const parentConflict = await db.conflicts.where('entityId').equals(transactionId).filter(row => row.tableName === 'transactions' && !row.resolvedAt).count();
          const parentPending = await db.syncOutbox.where('[tableName+entityId]').equals(['transactions', transactionId]).count();
          if (!parent || parentConflict || parentPending || pendingWrites || !sameDerivedValues(tableName, local, record)) { await retainConflict(tableName, local, record); continue; }
          await put(tableName, record as unknown as FinanceTableMap[typeof tableName], false, true); continue;
        }
        if (local && ((local.version ?? 0) === record.version || pendingWrites)) {
          await retainConflict(tableName, local, record); continue;
        }
        if (local && (local.version ?? 0) > record.version) continue;
        if (tableName === 'transactions') await writeTransaction(record as unknown as Transaction, undefined, false, true);
        else await put(tableName, record as unknown as FinanceTableMap[typeof tableName], false, true);
      }
    });
  }
  async function resolveConflict(conflictId: string, choice: 'local' | 'remote') {
    required(['local', 'remote'].includes(choice), 'Choose which version to apply explicitly.');
    return atomic(async () => {
      const conflict = await db.conflicts.get(conflictId); required(conflict && !conflict.resolvedAt, 'Unresolved conflict not found.');
      const local = await db.table<Entity, string>(conflict.tableName).get(conflict.entityId); required(local, 'Local record not found.');
      if (choice === 'remote' && ['postings', 'investmentLots'].includes(conflict.tableName)) required(sameDerivedValues(conflict.tableName, local, conflict.remote), 'Resolve the parent transaction first; derived money must match its journal.');
      await db.syncOutbox.where('[tableName+entityId]').equals([conflict.tableName, conflict.entityId]).delete();
      if (choice === 'remote') {
        if (conflict.tableName === 'transactions') await writeTransaction(conflict.remote as unknown as Transaction, undefined, false, true);
        else await put(conflict.tableName, conflict.remote as unknown as FinanceTableMap[typeof conflict.tableName], false, true);
      } else {
        await db.table(conflict.tableName).put({ ...local, version: conflict.remote.version });
        if (conflict.tableName === 'transactions') await writeTransaction(local as Transaction);
        else await put(conflict.tableName, local as FinanceTableMap[typeof conflict.tableName]);
      }
      await db.conflicts.update(conflictId, { resolvedAt: stamp() });
    });
  }
  return { save, remove, saveTransaction, deleteTransaction, listTransactions, accountBalances, monthlyCashFlow, portfolio, getSetting, setSetting, confirmRecurring, previewImport, importStatement, assignOwner, applyRemoteRecords, resolveConflict, initialize: () => initializeFinanceDatabase(db) };
}
export const financeRepository = createFinanceRepository();

export async function initializeFinanceDatabase(db: FinanceDatabase = financeDb) {
  await db.open();
  if (await db.categories.count()) return;
  const repository = createFinanceRepository(db);
  for (const name of ['Housing', 'Food', 'Transport', 'Healthcare', 'Insurance', 'Travel', 'Family', 'Entertainment', 'Subscriptions', 'Taxes', 'Education', 'Charity', 'Personal', 'Miscellaneous', 'Salary', 'Other income']) {
    await repository.save('categories', { id: `category-${name.toLowerCase().replaceAll(' ', '-')}`, name, kind: ['Salary', 'Other income'].includes(name) ? 'income' : 'expense', color: '#6b7280', essential: ['Housing', 'Food', 'Healthcare'].includes(name), archived: false });
  }

  const accountsData = [
    { name: 'Emergency Fund (Maya)', type: 'EWALLET', bal: 13001779 },
    { name: 'DragonFi Investments', type: 'BROKERAGE', bal: 24341868 },
    { name: 'UITF EQF (BDO)', type: 'UITF', bal: 1000000 },
    { name: 'UITF STF (BDO)', type: 'UITF', bal: 101407210 },
    { name: 'GoTrade (USD)', type: 'BROKERAGE', bal: 54997, curr: 'USD' },
    { name: 'IBKR (USD)', type: 'BROKERAGE', bal: 3371917, curr: 'USD' },
    { name: 'Insurance (PhilamLife)', type: 'OTHER_ASSET', bal: 926859 },
    { name: 'PERA Account (DragonFi)', type: 'PERA', bal: 326625 },
    { name: 'MP2 (Pag-ibig)', type: 'PAGIBIG_MP2', bal: 3000000 },
    { name: 'MP1 (Pag-ibig)', type: 'OTHER_ASSET', bal: 1497481 },
    { name: 'Retirement Fund (SSS)', type: 'RETIREMENT', bal: 18585000 }
  ];
  
  for (const a of accountsData) {
    await repository.save('accounts', {
      id: `account-${a.name.replace(/[^a-z0-9]/gi, '').toLowerCase()}`,
      name: a.name,
      accountType: a.type as never,
      currency: a.curr || 'PHP',
      openingBalance: a.bal,
      openingDate: '2026-10-01',
      includeInNetWorth: true,
      includeInLiquidNetWorth: true,
      includeInFire: true,
      emergency: a.name.includes('Emergency'),
      archived: false
    });
  }

  await repository.save('accounts', {
    id: 'account-braces',
    name: 'Braces (Healthcare)',
    accountType: 'OTHER_LIABILITY',
    currency: 'PHP',
    openingBalance: 6875000,
    openingDate: '2026-10-01',
    includeInNetWorth: true,
    includeInLiquidNetWorth: true,
    includeInFire: true,
    emergency: false,
    archived: false
  });

  await repository.setSetting('finance', {
    baseCurrency: 'PHP',
    withdrawalRate: 0.04,
    selectedAnnualSpendingBasis: 'MANUAL',
    annualSpending: 15924 * 12 * 100,
    essentialCategoryIds: [],
    inflationAssumption: 0.03,
    investmentReturnAssumption: 0.06,
    monthlyContribution: 880000,
    privacyMode: 'LOCAL_ONLY'
  });
  
  await repository.save('goals', {
    id: 'goal-fire',
    name: 'Target FIRE',
    target: 1500000000,
    currency: 'PHP'
  });
  
  await repository.save('recurringRules', {
    id: 'rule-job1',
    name: 'Job 1',
    frequency: 'monthly',
    startDate: '2026-10-01',
    nextDate: '2026-11-01',
    active: true,
    template: {
      accountId: 'account-emergencyfundmaya',
      categoryId: 'category-salary',
      type: 'INCOME',
      amount: 4265000,
      currency: 'PHP'
    }
  });

  const expenses = [
    { name: 'Internet', val: 179900, cat: 'subscriptions' },
    { name: 'Water', val: 100000, cat: 'housing' },
    { name: 'Meralco', val: 500000, cat: 'housing' },
    { name: 'Whey Protein', val: 200000, cat: 'healthcare' }
  ];
  for (const e of expenses) {
    await repository.save('budgets', {
      id: `budget-${e.name.toLowerCase().replace(/[^a-z0-9]/gi, '')}`,
      categoryId: `category-${e.cat}`,
      amount: e.val,
      currency: 'PHP',
      periodType: 'monthly',
      period: '2026-10'
    });
  }
}
export const initializeDatabase = initializeFinanceDatabase;
