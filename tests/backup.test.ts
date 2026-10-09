import 'fake-indexeddb/auto';
import { beforeEach, afterEach, it, expect } from 'vitest';
import { FinanceDatabase } from '../src/db/database';
import { createFinanceRepository } from '../src/db/repository';
import { exportBackup, restoreBackup, validateBackup, encryptBackup, decryptBackup, csvCell } from '../src/db/backup';
import { postingsForTransaction } from '../src/core/calculations';
import type { Account, Transaction } from '../src/core/types';

let db: FinanceDatabase, repository: ReturnType<typeof createFinanceRepository>;
beforeEach(async () => {
  db = new FinanceDatabase(`backup-test-${crypto.randomUUID()}`); await db.open(); repository = createFinanceRepository(db);
  await repository.save('accounts', { id: 'cash', name: 'Cash', accountType: 'CASH', currency: 'PHP', openingBalance: 100000, openingDate: '2026-01-01', includeInNetWorth: true, includeInLiquidNetWorth: true, includeInFire: true, emergency: false, archived: false });
  await repository.saveTransaction({ id: 'expense', date: '2026-10-08', type: 'EXPENSE', accountId: 'cash', currency: 'PHP', amount: 10000 });
});
afterEach(async () => { await db.delete(); });

it('exports a consistent ledger with schema metadata and excludes authentication secrets', async () => {
  await db.syncState.put({ id: 'auth:session', value: 'private-session-secret' });
  const backup = await exportBackup(db); expect(backup.schemaVersion).toBe(2); expect(backup.tables.transactions).toHaveLength(1); expect(JSON.stringify(backup)).not.toContain('private-session-secret'); expect(validateBackup(JSON.stringify(backup)).format).toBe('tala-finance-backup');
});
it('requires explicit restore confirmation and restores committed values atomically', async () => {
  const backup = await exportBackup(db); await repository.saveTransaction({ id: 'second', date: '2026-10-09', type: 'EXPENSE', accountId: 'cash', currency: 'PHP', amount: 5000 });
  await expect(restoreBackup(db, backup, { confirmed: false })).rejects.toThrow('confirmation'); expect(await db.transactions.count()).toBe(2);
  await restoreBackup(db, backup, { confirmed: true }); expect(await db.transactions.count()).toBe(1); expect((await repository.accountBalances('2026-10-09')).cash).toBe(90000); expect(await repository.getSetting('privacyMode')).toBe('LOCAL_ONLY');
});
it('rejects corrupted amounts, orphaned accounts and mismatched postings without clearing current data', async () => {
  const backup = await exportBackup(db);
  for (const change of [(value: typeof backup) => { (value.tables.transactions[0] as { amount: number }).amount = 999; }, (value: typeof backup) => { value.tables.accounts = []; }, (value: typeof backup) => { (value.tables.postings[0] as { delta: number }).delta = 0; }]) {
    const corrupt = structuredClone(backup); change(corrupt); await expect(restoreBackup(db, corrupt, { confirmed: true })).rejects.toThrow(); expect((await repository.accountBalances('2026-10-09')).cash).toBe(90000);
  }
});
it('password encryption uses random salts/IVs, rejects wrong passwords and altered ciphertext', async () => {
  const backup = await exportBackup(db), password = 'test-only-strong-password';
  const one = await encryptBackup(backup, password), two = await encryptBackup(backup, password);
  expect(one.salt).not.toBe(two.salt); expect(one.iv).not.toBe(two.iv); expect(JSON.stringify(one)).not.toContain(password); expect(JSON.stringify(one)).not.toContain('cash');
  expect((await decryptBackup(one, password)).tables.transactions).toEqual(backup.tables.transactions);
  await expect(decryptBackup(one, 'wrong-password')).rejects.toThrow();
  const altered = { ...one, ciphertext: (one.ciphertext[0] === 'A' ? 'B' : 'A') + one.ciphertext.slice(1) }; await expect(decryptBackup(altered, password)).rejects.toThrow();
});
it('rejects orphaned valuations and category cycles before replacing a valid database', async () => {
  const backup = await exportBackup(db);
  const orphan = structuredClone(backup); orphan.tables.prices.push({ id: 'orphan-price', instrumentId: 'missing', value: 100, currency: 'PHP', asOf: '2026-10-08', fetchedAt: '2026-10-09T00:00:00Z', source: 'User statement', staleAfter: '2026-10-10T00:00:00Z', status: 'manual' });
  await expect(restoreBackup(db, orphan, { confirmed: true })).rejects.toThrow('orphaned price');
  const cycle = structuredClone(backup); cycle.tables.categories.push(...['one', 'two'].map((id, index) => ({ id, name: id, parentId: index ? 'one' : 'two', kind: 'expense', color: '#aaa', essential: false, archived: false })));
  await expect(restoreBackup(db, cycle, { confirmed: true })).rejects.toThrow('cycle');
  expect((await repository.accountBalances('2026-10-09')).cash).toBe(90000);
});
it('validates future trade chronology even when its journal is otherwise consistent', async () => {
  const backup = await exportBackup(db);
  backup.tables.instruments.push({ id: 'future-security', name: 'Future trade fixture', currency: 'PHP', instrumentType: 'PSE_STOCK', valuationMethod: 'MANUAL_PRICE' });
  const sale: Transaction = { id: 'future-sale', type: 'INVESTMENT_SELL', date: '2099-01-01', accountId: 'cash', instrumentId: 'future-security', currency: 'PHP', amount: 10000, units: 1, unitPrice: 100 };
  backup.tables.transactions.push(sale); backup.tables.postings.push(...postingsForTransaction(sale, backup.tables.accounts as Account[]));
  await expect(restoreBackup(db, backup, { confirmed: true })).rejects.toThrow('units held');
  expect(await db.transactions.count()).toBe(1);
});
it('CSV text cells escape spreadsheet formulas and embedded quotes', () => {
  expect(csvCell('=HYPERLINK("unsafe")')).toBe('"\'=HYPERLINK(""unsafe"")"'); expect(csvCell('ordinary "note"')).toBe('"ordinary ""note"""'); expect(csvCell(-100)).toBe('"-100"');
  expect(csvCell('   =SUM(A1)')).toBe('"\'   =SUM(A1)"'); expect(csvCell('\n@formula')).toBe('"\'\n@formula"');
});
