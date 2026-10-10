import 'fake-indexeddb/auto';
import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { FinanceDatabase, type SyncedEntity } from '../src/db/database';
import { createFinanceRepository } from '../src/db/repository';
import { createSyncEngine } from '../src/sync/engine';
import type { Account, Transaction } from '../src/core/types';
import type { SyncProvider } from '../src/sync/provider';

let db: FinanceDatabase, repository: ReturnType<typeof createFinanceRepository>;
const account = (id: string, type: Account['accountType'] = 'SAVINGS', openingBalance = 2000000): Account => ({ id, name: id, accountType: type, currency: 'PHP', openingBalance, openingDate: '2026-01-01', includeInNetWorth: true, includeInLiquidNetWorth: true, includeInFire: true, emergency: false, archived: false });
const expense = (id = 'expense'): Transaction => ({ id, type: 'EXPENSE', date: '2026-10-08', amount: 85000, currency: 'PHP', accountId: 'cash', categoryId: 'food', merchant: 'Grocer' });
beforeEach(async () => {
  db = new FinanceDatabase(`repository-test-${crypto.randomUUID()}`); await db.open(); repository = createFinanceRepository(db);
  await repository.save('accounts', account('cash'));
  await repository.save('accounts', account('wallet', 'EWALLET', 10000));
  await repository.save('accounts', account('card', 'CREDIT_CARD', 100000));
  await repository.save('accounts', account('broker', 'BROKERAGE', 1000000));
  await repository.save('categories', { id: 'food', name: 'Food', kind: 'expense', color: '#aaa', essential: true, archived: false });
  await repository.save('instruments', { id: 'security', name: 'Test security', instrumentType: 'PSE_STOCK', currency: 'PHP', valuationMethod: 'MANUAL_PRICE' });
});
afterEach(async () => { await db.delete(); });

describe('atomic offline ledger', () => {
  it('saves, edits and deletes journal entries without double-counting; reopened data persists', async () => {
    const first = await repository.saveTransaction(expense());
    expect(first.version).toBe(1); expect(first.ownerId).toBe('local');
    expect((await repository.accountBalances('2026-10-09')).cash.PHP).toBe(1915000);
    await repository.saveTransaction({ ...first, amount: 50000 });
    expect((await repository.accountBalances('2026-10-09')).cash.PHP).toBe(1950000);
    expect((await db.transactions.get(first.id))?.version).toBe(2);
    db.close(); await db.open();
    expect((await repository.monthlyCashFlow('2026-10-01', '2026-10-31')).expenses).toBe(50000);
    await repository.deleteTransaction(first.id);
    expect((await repository.accountBalances('2026-10-09')).cash.PHP).toBe(2000000);
    expect((await db.transactions.get(first.id))?.deletedAt).toBeTruthy();
    expect(await db.postings.filter(row => !row.deletedAt).count()).toBe(0);
  });
  it('transfers and card payments move natural balances without inflating spending', async () => {
    await repository.saveTransaction({ ...expense('transfer'), type: 'TRANSFER', amount: 1000000, transferAccountId: 'wallet', categoryId: undefined });
    await repository.saveTransaction({ ...expense('card-expense'), accountId: 'card', amount: 125000 });
    await repository.saveTransaction({ ...expense('payment'), type: 'TRANSFER', amount: 200000, transferAccountId: 'card', categoryId: undefined });
    const balances = await repository.accountBalances('2026-10-09');
    expect(balances.cash.PHP).toBe(800000); expect(balances.wallet.PHP).toBe(1010000); expect(balances.card.PHP).toBe(25000);
    const flow = await repository.monthlyCashFlow('2026-10-01', '2026-10-31'); expect(flow.expenses).toBe(125000); expect(flow.income).toBe(0);
  });
  it('rolls back transaction, postings and outbox together if the queue write fails', async () => {
    const before = await db.syncOutbox.count();
    db.syncOutbox.hook('creating', (_key, value) => { if (value.tableName === 'transactions') throw new Error('Simulated quota failure'); });
    await expect(repository.saveTransaction(expense())).rejects.toThrow('Simulated quota');
    expect(await db.transactions.count()).toBe(0); expect(await db.postings.count()).toBe(0); expect(await db.syncOutbox.count()).toBe(before);
  });
  it('maintains investment cash, average-cost holdings and rejects overselling atomically', async () => {
    await repository.saveTransaction({ id: 'buy', type: 'INVESTMENT_BUY', date: '2026-10-01', accountId: 'broker', instrumentId: 'security', currency: 'PHP', amount: 100000, units: 10, unitPrice: 100, fees: 100 });
    await repository.saveTransaction({ id: 'sell', type: 'INVESTMENT_SELL', date: '2026-10-02', accountId: 'broker', instrumentId: 'security', currency: 'PHP', amount: 48000, units: 4, unitPrice: 120, fees: 100 });
    const lot = await db.investmentLots.get('position:broker:security'); expect(lot?.units).toBe(6); expect(lot?.costBasis).toBe(60060); expect(lot?.realizedGain).toBe(7860);
    expect((await repository.accountBalances('2026-10-09')).broker.PHP).toBe(947800);
    expect((await repository.monthlyCashFlow('2026-10-01', '2026-10-31')).expenses).toBe(200);
    await expect(repository.saveTransaction({ id: 'bad-sale', type: 'INVESTMENT_SELL', date: '2026-10-03', accountId: 'broker', instrumentId: 'security', currency: 'PHP', amount: 70000, units: 7, unitPrice: 100 })).rejects.toThrow();
    expect(await db.transactions.get('bad-sale')).toBeUndefined(); expect((await db.investmentLots.get('position:broker:security'))?.units).toBe(6);
    await expect(repository.deleteTransaction('buy')).rejects.toThrow(); expect((await db.transactions.get('buy'))?.deletedAt).toBeNull();
  });
  it('blocks accounting-unit/type changes on used accounts and filters before pagination', async () => {
    await repository.saveTransaction({ ...expense('tagged'), tags: ['essential'] });
    await repository.saveTransaction({ ...expense('other'), merchant: 'Other', tags: ['optional'] });
    await expect(repository.save('accounts', { ...account('cash'), currency: 'USD' })).rejects.toThrow();
    await expect(repository.save('accounts', account('cash', 'CREDIT_CARD'))).rejects.toThrow();
    const page = await repository.listTransactions({ tag: 'essential', currency: 'PHP', limit: 1 }); expect(page.total).toBe(1); expect(page.items[0].id).toBe('tagged');
  });
  it('confirms recurring occurrences once and never posts unconfirmed rules', async () => {
    await repository.save('recurringRules', { id: 'rent', name: 'Rent', frequency: 'monthly', startDate: '2026-01-01', nextDate: '2026-01-31', monthlyDay: 31, active: true, template: { type: 'EXPENSE', amount: 10000, accountId: 'cash', currency: 'PHP', categoryId: 'food' } });
    expect(await db.transactions.count()).toBe(0);
    const [first, repeated] = await Promise.all([repository.confirmRecurring('rent', '2026-01-31'), repository.confirmRecurring('rent', '2026-01-31')]);
    expect(first.id).toBe(repeated.id); expect(await db.transactions.count()).toBe(1); expect((await db.recurringRules.get('rent'))?.nextDate).toBe('2026-02-28');
  });
  it('detects duplicates within files and existing ledger, and rechecks atomically before import', async () => {
    const preview = await repository.previewImport([expense('import1'), expense('import2')]); expect(preview.duplicateCount).toBe(1);
    await expect(repository.importStatement(preview)).rejects.toThrow('Duplicate');
    expect(await repository.importStatement(preview, { skipDuplicates: true })).toEqual({ imported: 1, skipped: 1 });
    const again = await repository.previewImport([expense('import3')]); expect(again.duplicateCount).toBe(1);
    await expect(repository.importStatement(again)).rejects.toThrow(); expect(await db.transactions.count()).toBe(1);
  });
  it('keeps outer category merges atomic and rejects self/descendant cycles', async () => {
    await repository.save('categories', { id: 'groceries', name: 'Groceries', parentId: 'food', kind: 'expense', color: '#aaa', essential: true, archived: false });
    const transaction = await repository.saveTransaction(expense());
    await expect(db.transaction('rw', db.tables, async () => {
      await repository.saveTransaction({ ...transaction, categoryId: 'groceries' });
      await repository.save('categories', { id: 'food', name: 'Food', parentId: 'groceries', kind: 'expense', color: '#aaa', essential: true, archived: false });
    })).rejects.toThrow('cycle');
    expect((await db.transactions.get(transaction.id))?.categoryId).toBe('food');
  });
  it('validates future investment chronology without applying its units to today', async () => {
    await expect(repository.saveTransaction({ id: 'future-sale', type: 'INVESTMENT_SELL', date: '2099-01-01', accountId: 'broker', instrumentId: 'security', currency: 'PHP', amount: 10000, units: 1, unitPrice: 100 })).rejects.toThrow();
    expect(await db.transactions.get('future-sale')).toBeUndefined();
  });
  it('rejects malformed valuation assumptions and currency precision before persistence', async () => {
    await expect(repository.save('instruments', { id: 'invalid', name: 'Invalid projection', currency: 'PHP', instrumentType: 'TIME_DEPOSIT', valuationMethod: 'COMPOUNDING', principal: 10000, startDate: '2026-10-09', maturityDate: '2026-02-30', annualRate: 0.06 })).rejects.toThrow();
    expect(await db.instruments.get('invalid')).toBeUndefined();
    await expect(repository.setSetting('finance', { id: 'finance', baseCurrency: 'PHP', withdrawalRate: 0.04, selectedAnnualSpendingBasis: 'MANUAL', annualSpending: 0, essentialCategoryIds: [], inflationAssumption: 0.03, investmentReturnAssumption: 0.06, monthlyContribution: 0, currencyPrecision: { PHP: 2.5 } })).rejects.toThrow();
    expect(await db.settings.get('finance')).toBeUndefined();
  });
});

describe('optional authenticated sync', () => {
  const offlineProvider: SyncProvider = { userId: async () => { throw new Error('Must not connect'); }, push: async () => { throw new Error('Must not connect'); }, pull: async () => { throw new Error('Must not connect'); }, subscribe: async () => { throw new Error('Must not connect'); } };
  it('local-only mode never calls a provider, even with queued changes', async () => {
    await repository.saveTransaction(expense());
    const engine = createSyncEngine({ db, repository, provider: offlineProvider }); expect((await engine.syncNow()).disabled).toBe(true);
  });
  it('retains failed uploads and keeps both financial versions on conflicts', async () => {
    await repository.saveTransaction(expense()); await repository.assignOwner('owner-a', { confirmed: true }); await repository.setSetting('privacyMode', 'CLOUD_SYNC');
    const failed = createSyncEngine({ db, repository, provider: { ...offlineProvider, userId: async () => 'owner-a', push: async () => { throw new Error('offline'); } } });
    await expect(failed.syncNow()).rejects.toThrow(); expect(await db.syncOutbox.where('status').equals('failed').count()).toBeGreaterThan(0);
    const local = (await db.transactions.get('expense')) as unknown as SyncedEntity;
    const remote = { ...local, amount: 50000, version: local.version + 1 };
    await repository.applyRemoteRecords([{ tableName: 'transactions', record: remote }], 'owner-a');
    expect((await db.transactions.get('expense'))?.amount).toBe(85000); const conflict = await db.conflicts.toCollection().first(); expect(conflict?.local.amount).toBe(85000); expect(conflict?.remote.amount).toBe(50000);
  });
  it('blocks other-owner records and treats canonical copies as identical', async () => {
    await repository.assignOwner('owner-a', { confirmed: true }); await db.syncOutbox.clear();
    const local = (await db.accounts.get('cash')) as unknown as SyncedEntity;
    await expect(repository.applyRemoteRecords([{ tableName: 'accounts', record: { ...local, ownerId: 'owner-b' } }], 'owner-a')).rejects.toThrow();
    const reordered = Object.fromEntries(Object.entries(local).reverse()) as SyncedEntity;
    await repository.applyRemoteRecords([{ tableName: 'accounts', record: reordered }], 'owner-a'); expect(await db.conflicts.count()).toBe(0);
  });
  it('retains the local journal when incoming children belong to a conflicting transaction', async () => {
    await repository.saveTransaction(expense()); await repository.assignOwner('owner-a', { confirmed: true }); await db.syncOutbox.clear();
    const local = (await db.transactions.get('expense')) as unknown as SyncedEntity;
    const posting = (await db.postings.get('posting:expense:0')) as unknown as SyncedEntity;
    const remote = { ...local, amount: 50000 };
    const remotePosting = { ...posting, delta: -50000, version: posting.version + 1 };
    await repository.applyRemoteRecords([{ tableName: 'postings', record: remotePosting }, { tableName: 'transactions', record: remote }], 'owner-a');
    expect((await db.transactions.get('expense'))?.amount).toBe(85000);
    expect((await repository.accountBalances('2026-10-09')).cash.PHP).toBe(1915000);
    const childConflict = await db.conflicts.where('entityId').equals(posting.id).first(); expect(childConflict?.local.delta).toBe(-85000); expect(childConflict?.remote.delta).toBe(-50000);
    await expect(repository.resolveConflict(childConflict!.id, 'remote')).rejects.toThrow('parent transaction');
    const parentConflict = await db.conflicts.where('entityId').equals(local.id).first();
    await repository.resolveConflict(parentConflict!.id, 'remote'); await repository.resolveConflict(childConflict!.id, 'remote');
    expect((await repository.accountBalances('2026-10-09')).cash.PHP).toBe(1950000);
  });
  it('acknowledges successful uploads and atomically derives incoming device transactions', async () => {
    await repository.assignOwner('owner-a', { confirmed: true }); await db.syncOutbox.clear(); await repository.saveTransaction(expense()); await repository.setSetting('privacyMode', 'CLOUD_SYNC');
    const metadata = { ownerId: 'owner-a', version: 1, createdAt: '2026-10-09T01:00:00Z', updatedAt: '2026-10-09T01:00:00Z', deletedAt: null, deviceId: 'other-device' };
    const remoteAccount = { ...account('other-cash', 'CASH', 200000), ...metadata } as unknown as SyncedEntity;
    const remoteTransaction = { ...expense('remote-expense'), accountId: 'other-cash', categoryId: undefined, amount: 5000, ...metadata } as unknown as SyncedEntity;
    const provider: SyncProvider = { userId: async () => 'owner-a', push: async entry => ({ kind: 'applied', record: { tableName: entry.tableName, record: entry.payload } }), pull: async () => ({ records: [{ tableName: 'transactions', record: remoteTransaction }, { tableName: 'accounts', record: remoteAccount }], cursor: '2026-10-09T01:00:00Z' }), subscribe: async () => () => {} };
    const result = await createSyncEngine({ db, repository, provider }).syncNow(); expect(result.uploaded).toBeGreaterThan(0); expect(result.downloaded).toBe(2); expect(await db.syncOutbox.count()).toBe(0); expect((await repository.accountBalances('2026-10-09'))['other-cash'].PHP).toBe(195000);
  });
});
