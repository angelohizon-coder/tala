import { postingsForTransaction, calculatePositions } from '../core/calculations';
import type { Account, Transaction, Posting, Instrument } from '../core/types';
import { financeDb, FINANCE_TABLES, BACKUP_TABLES, DATABASE_SCHEMA_VERSION, type FinanceDatabase, type FinanceTableName, type FinanceTableMap } from './database';
import { validateFinanceRecord, validDate } from './repository';

export interface FinanceBackup { format: 'tala-finance-backup'; schemaVersion: number; appVersion: string; createdAt: string; tables: Record<string, unknown[]>; }
export interface EncryptedBackup { format: 'tala-finance-encrypted'; version: 1; kdf: 'PBKDF2-SHA256'; cipher: 'AES-256-GCM'; iterations: number; salt: string; iv: string; ciphertext: string; }
const AUXILIARY = ['syncOutbox', 'conflicts'] as const;
const TABLES = [...BACKUP_TABLES, ...AUXILIARY];
function assert(valid: unknown, message = 'The backup is invalid or incomplete.'): asserts valid { if (!valid) throw new Error(message); }
const alive = (row: { deletedAt?: string | null }) => !row.deletedAt;

export async function exportBackup(db: FinanceDatabase = financeDb): Promise<FinanceBackup> {
  return db.transaction('r', db.tables, async () => {
    const tables: Record<string, unknown[]> = {};
    for (const table of TABLES) tables[table] = await db.table(table).toArray();
    return { format: 'tala-finance-backup', schemaVersion: DATABASE_SCHEMA_VERSION, appVersion: '2.0.0', createdAt: new Date().toISOString(), tables };
  });
}

export function validateBackup(input: unknown): FinanceBackup {
  let data = input;
  if (typeof input === 'string') { assert(input.length <= 250 * 1024 * 1024, 'Backup exceeds the supported size.'); try { data = JSON.parse(input); } catch { throw new Error('Backup must be valid JSON.'); } }
  assert(data && typeof data === 'object' && !Array.isArray(data));
  const backup = data as FinanceBackup;
  assert(backup.format === 'tala-finance-backup' && backup.schemaVersion === DATABASE_SCHEMA_VERSION && typeof backup.appVersion === 'string' && typeof backup.createdAt === 'string' && Number.isFinite(Date.parse(backup.createdAt)) && backup.tables && typeof backup.tables === 'object');
  assert(Object.keys(backup.tables).every(table => TABLES.includes(table as typeof TABLES[number])));
  let totalRows = 0;
  for (const table of TABLES) {
    const rows = backup.tables[table]; assert(Array.isArray(rows)); totalRows += rows.length; assert(totalRows <= 1000000, 'Backup contains too many records.');
    const ids = new Set<string>();
    for (const unknownRow of rows) {
      assert(unknownRow && typeof unknownRow === 'object' && !Array.isArray(unknownRow)); const row = unknownRow as Record<string, unknown>;
      assert(typeof row.id === 'string' && row.id.length <= 200 && !ids.has(row.id)); ids.add(row.id);
      if (FINANCE_TABLES.includes(table as FinanceTableName)) validateFinanceRecord(table as FinanceTableName, row);
      else if (table === 'importFingerprints') assert(/^[a-f0-9]{64}$/u.test(row.id as string) && typeof row.transactionId === 'string');
      else if (table === 'recurringOccurrences') assert(typeof row.ruleId === 'string' && typeof row.transactionId === 'string' && validDate(row.date));
      else if (table === 'syncOutbox') { assert(FINANCE_TABLES.includes(row.tableName as FinanceTableName) && ['pending', 'failed', 'conflict'].includes(row.status as string) && Number.isSafeInteger(row.baseVersion) && (row.baseVersion as number) >= 0); validateFinanceRecord(row.tableName as FinanceTableName, row.payload); }
      else if (table === 'conflicts') { assert(FINANCE_TABLES.includes(row.tableName as FinanceTableName)); validateFinanceRecord(row.tableName as FinanceTableName, row.local); validateFinanceRecord(row.tableName as FinanceTableName, row.remote); }
    }
  }
  const accounts = backup.tables.accounts as Account[], transactions = backup.tables.transactions as Transaction[], instruments = backup.tables.instruments as Instrument[];
  const precision = ((backup.tables.settings as { key: string; value: { currencyPrecision?: Record<string, number> } }[]).find(row => row.key === 'finance')?.value)?.currencyPrecision;
  const accountIds = new Set(accounts.map(row => row.id)), transactionIds = new Set(transactions.map(row => row.id)), instrumentIds = new Set(instruments.map(row => row.id)), categoryIds = new Set((backup.tables.categories as { id: string }[]).map(row => row.id));
  const categories = new Map((backup.tables.categories as FinanceTableMap['categories'][]).map(row => [row.id, row]));
  for (const category of categories.values()) {
    const visited = new Set([category.id]); let parentId = category.parentId;
    while (parentId) { const parent = categories.get(parentId); assert(parent && parent.kind === category.kind && !visited.has(parentId), 'Backup category hierarchy is missing a parent or contains a cycle.'); visited.add(parentId); parentId = parent.parentId; }
  }
  const instrumentsById = new Map(instruments.map(row => [row.id, row]));
  for (const price of backup.tables.prices as FinanceTableMap['prices'][]) assert(instrumentsById.get(price.instrumentId)?.currency === price.currency, 'Backup has an orphaned price or a mismatched price currency.');
  for (const lot of backup.tables.investmentLots as FinanceTableMap['investmentLots'][]) assert(accountIds.has(lot.accountId) && instrumentIds.has(lot.instrumentId) && transactionIds.has(lot.transactionId) && instrumentsById.get(lot.instrumentId)?.currency === lot.currency, 'Backup has an orphaned investment lot.');
  for (const budget of backup.tables.budgets as FinanceTableMap['budgets'][]) assert(categoryIds.has(budget.categoryId), 'Backup has an orphaned budget category.');
  for (const rule of backup.tables.recurringRules as FinanceTableMap['recurringRules'][]) {
    const template = { ...rule.template, id: 'preview', date: rule.nextDate } as Transaction; validateFinanceRecord('transactions', template);
    assert(rule.nextDate >= rule.startDate && (!rule.endDate || validDate(rule.endDate) && rule.endDate >= rule.startDate), 'Backup recurring rule dates are invalid.');
    assert(!template.categoryId || categoryIds.has(template.categoryId)); assert(!template.instrumentId || instrumentIds.has(template.instrumentId));
    postingsForTransaction(template, accounts, precision);
  }
  for (const terms of backup.tables.liabilityTerms as FinanceTableMap['liabilityTerms'][]) assert(accountIds.has(terms.accountId), 'Backup has orphaned liability terms.');
  for (const table of ['goals', 'balanceSnapshots'] as const) for (const row of backup.tables[table] as { accountId?: string }[]) assert(!row.accountId || accountIds.has(row.accountId));
  const tags = new Set((backup.tables.tags as { id: string }[]).map(row => row.id));
  for (const row of backup.tables.transactionTags as FinanceTableMap['transactionTags'][]) assert(transactionIds.has(row.transactionId) && tags.has(row.tagId));
  for (const transaction of transactions) {
    assert(accountIds.has(transaction.accountId) && (!transaction.transferAccountId || accountIds.has(transaction.transferAccountId)), 'Backup has an orphaned transaction account.');
    assert(!transaction.instrumentId || instrumentIds.has(transaction.instrumentId), 'Backup has an orphaned investment.');
    assert(!transaction.categoryId || categoryIds.has(transaction.categoryId), 'Backup has an orphaned category.');
    if (alive(transaction)) postingsForTransaction(transaction, accounts, precision);
  }
  const actual = new Map<string, string[]>(), expected = new Map<string, string[]>();
  const digestPosting = (row: Posting) => JSON.stringify([row.accountId, row.date, row.currency, row.delta, row.instrumentId ?? null, row.unitsDelta ?? null]);
  for (const posting of backup.tables.postings as Posting[]) { assert(transactionIds.has(posting.transactionId) && accountIds.has(posting.accountId)); if (alive(posting)) { const values = actual.get(posting.transactionId) ?? []; values.push(digestPosting(posting)); actual.set(posting.transactionId, values); } }
  for (const transaction of transactions.filter(alive)) expected.set(transaction.id, postingsForTransaction(transaction, accounts, precision).map(digestPosting));
  for (const transaction of transactions) assert(JSON.stringify((actual.get(transaction.id) ?? []).sort()) === JSON.stringify((expected.get(transaction.id) ?? []).sort()), 'Backup postings do not match its transaction ledger.');
  const actualTransactions = transactions.filter(alive), latestDate = actualTransactions.map(row => row.date).sort().at(-1);
  calculatePositions(actualTransactions, instruments, [], { currencyPrecision: precision, ...(latestDate ? { asOf: latestDate } : {}) });
  for (const row of backup.tables.importFingerprints as { transactionId: string }[]) assert(transactionIds.has(row.transactionId));
  for (const row of backup.tables.recurringOccurrences as { transactionId: string; ruleId: string }[]) assert(transactionIds.has(row.transactionId) && (backup.tables.recurringRules as { id: string }[]).some(rule => rule.id === row.ruleId));
  return backup;
}

export async function restoreBackup(db: FinanceDatabase, input: unknown, options: { confirmed: boolean }) {
  assert(options?.confirmed === true, 'Restoring replaces local records and requires explicit confirmation.');
  const backup = validateBackup(input);
  await db.transaction('rw', db.tables, async () => {
    for (const table of db.tables) await table.clear();
    for (const table of TABLES) if (backup.tables[table].length) await db.table(table).bulkPut(backup.tables[table]);
    // Restoring a file never authorizes sending its records to a cloud account.
    const now = new Date().toISOString();
    await db.settings.put({ id: 'privacyMode', key: 'privacyMode', value: 'LOCAL_ONLY', ownerId: 'local', deviceId: crypto.randomUUID(), version: 1, createdAt: now, updatedAt: now, deletedAt: null });
    const finance = await db.settings.get('finance');
    if (finance?.value && typeof finance.value === 'object') await db.settings.put({ ...finance, value: { ...finance.value, privacyMode: 'LOCAL_ONLY' } });
    const owners = new Set((backup.tables.accounts as Account[]).map(row => row.ownerId ?? 'local'));
    if (owners.size === 1) await db.syncState.put({ id: 'ownerId', value: [...owners][0] });
  });
  return { restored: Object.values(backup.tables).reduce((total, rows) => total + rows.length, 0) };
}

function base64(bytes: Uint8Array) { let text = ''; for (let start = 0; start < bytes.length; start += 8192) text += String.fromCharCode(...bytes.subarray(start, start + 8192)); return btoa(text); }
function unbase64(text: string) { assert(typeof text === 'string' && text.length <= 350 * 1024 * 1024 && /^[A-Za-z0-9+/]*={0,2}$/u.test(text)); let raw: string; try { raw = atob(text); } catch { throw new Error('Encrypted backup encoding is invalid.'); } return Uint8Array.from(raw, char => char.charCodeAt(0)); }
async function key(password: string, salt: Uint8Array, iterations: number) {
  assert(typeof password === 'string' && password.length >= 8 && password.length <= 1024, 'Use a backup password of at least eight characters.');
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
const additionalData = new TextEncoder().encode('tala-finance-encrypted:v1');
export async function encryptBackup(input: FinanceBackup, password: string): Promise<EncryptedBackup> {
  validateBackup(input); const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12)), iterations = 310000;
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData }, await key(password, salt, iterations), new TextEncoder().encode(JSON.stringify(input)));
  return { format: 'tala-finance-encrypted', version: 1, cipher: 'AES-256-GCM', kdf: 'PBKDF2-SHA256', iterations, salt: base64(salt), iv: base64(iv), ciphertext: base64(new Uint8Array(ciphertext)) };
}
export async function decryptBackup(input: EncryptedBackup, password: string): Promise<FinanceBackup> {
  assert(input?.format === 'tala-finance-encrypted' && input.version === 1 && input.cipher === 'AES-256-GCM' && input.kdf === 'PBKDF2-SHA256' && Number.isSafeInteger(input.iterations) && input.iterations >= 100000 && input.iterations <= 1000000);
  const salt = unbase64(input.salt), iv = unbase64(input.iv), encrypted = unbase64(input.ciphertext); assert(salt.length === 16 && iv.length === 12 && encrypted.length >= 16);
  try { const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource, additionalData }, await key(password, salt, input.iterations), encrypted as BufferSource); return validateBackup(new TextDecoder().decode(decrypted)); }
  catch { throw new Error('The password is incorrect or the encrypted backup was changed.'); }
}
export function csvCell(value: unknown) { let text = String(value ?? ''); if (typeof value === 'string' && (/^[\t\r\n]/u.test(text) || /^\s*[=+\-@]/u.test(text))) text = `'${text}`; return `"${text.replaceAll('"', '""')}"`; }
export async function exportTransactionsCsv(db: FinanceDatabase = financeDb) {
  const rows: unknown[][] = [['id', 'date', 'type', 'amount_minor', 'currency', 'account_id', 'transfer_account_id', 'category_id', 'merchant', 'notes', 'reference']];
  await db.transactions.orderBy('date').each(row => { if (alive(row)) rows.push([row.id, row.date, row.type, row.amount, row.currency, row.accountId, row.transferAccountId ?? '', row.categoryId ?? '', row.merchant ?? '', row.notes ?? '', row.reference ?? '']); });
  return rows.map(row => row.map(csvCell).join(',')).join('\r\n');
}
export function positionsCsv(positions: readonly Record<string, unknown>[]) {
  const fields = ['accountId', 'instrumentId', 'currency', 'units', 'averageCost', 'costBasis', 'marketValue', 'realizedGain', 'unrealizedGain', 'income', 'totalReturn'];
  const headers = fields.map(field => field === 'averageCost' ? 'averageCost_major' : ['costBasis', 'marketValue', 'realizedGain', 'unrealizedGain', 'income', 'totalReturn'].includes(field) ? `${field}_minor` : field);
  return [headers, ...positions.map(position => fields.map(field => position[field]))].map(row => row.map(csvCell).join(',')).join('\r\n');
}
