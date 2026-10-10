import Dexie, { type Table } from 'dexie';
import type { Account, Transaction, Posting, Category, Instrument, Price, FxRate, Budget, Entity } from '../core/types';

export type AccountEntity = Account;
export type CategoryEntity = Category;
export type TransactionEntity = Transaction;

export interface NamedEntity extends Entity { name: string; color?: string; }
export interface TransactionTag extends Entity { transactionId: string; tagId: string; }
export interface InvestmentLot extends Entity { accountId: string; instrumentId: string; transactionId: string; date: string; units: number; costBasis: number; currency: string; realizedGain?: number; }
export interface RecurringRule extends Entity {
  name: string; frequency: 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'annual';
  startDate: string; nextDate: string; monthlyDay?: number; endDate?: string; active: boolean;
  template: Omit<Transaction, keyof Entity | 'date'> & { date?: string };
}
export interface LiabilityTerms extends Entity { accountId: string; annualInterestRate: number; minimumPayment: number; dueDay?: number; termMonths?: number; startDate?: string; principal?: number; }
export interface Goal extends Entity { name: string; target: number; currency: string; accountId?: string; targetDate?: string; percentage?: number; }
export interface BalanceSnapshot extends Entity { accountId?: string; date: string; balance?: number; netWorth?: number; assets?: number; liabilities?: number; currency: string; notes?: string; }
export interface Setting extends Entity { key: string; value: unknown; }
export interface SyncState { id: string; value: unknown; }
export interface ImportFingerprint { id: string; transactionId: string; createdAt: string; }
export interface RecurringOccurrence { id: string; ruleId: string; date: string; transactionId: string; createdAt: string; }
export interface StoredMetadata { id: string; ownerId: string; createdAt: string; updatedAt: string; version: number; deletedAt: string | null; deviceId: string; }
export type SyncedEntity = Entity & StoredMetadata & Record<string, unknown>;
export interface OutboxEntry { id: string; tableName: FinanceTableName; entityId: string; ownerId: string; baseVersion: number; payload: SyncedEntity; status: 'pending' | 'failed' | 'conflict'; attempts: number; createdAt: string; error?: string; }
export interface Conflict { id: string; tableName: FinanceTableName; entityId: string; ownerId: string; local: SyncedEntity; remote: SyncedEntity; createdAt: string; resolvedAt?: string; }
export interface FinanceTableMap {
  accounts: Account; institutions: NamedEntity; transactions: Transaction; postings: Posting;
  categories: Category; tags: NamedEntity; transactionTags: TransactionTag; instruments: Instrument;
  investmentLots: InvestmentLot; prices: Price; fxRates: FxRate; budgets: Budget; recurringRules: RecurringRule;
  goals: Goal; liabilityTerms: LiabilityTerms; balanceSnapshots: BalanceSnapshot; settings: Setting;
}
export type FinanceTableName = keyof FinanceTableMap;
export const FINANCE_TABLES: FinanceTableName[] = ['accounts', 'institutions', 'transactions', 'postings', 'categories', 'tags', 'transactionTags', 'instruments', 'investmentLots', 'prices', 'fxRates', 'budgets', 'recurringRules', 'goals', 'liabilityTerms', 'balanceSnapshots', 'settings'];
export const BACKUP_TABLES = [...FINANCE_TABLES, 'importFingerprints', 'recurringOccurrences'] as const;
export const DATABASE_SCHEMA_VERSION = 2;

const common = 'id, ownerId, updatedAt, deletedAt';
const schema = {
  accounts: `${common}, accountType, currency, archived, institutionId`, institutions: `${common}, name`,
  transactions: `${common}, date, accountId, categoryId, type, currency, instrumentId, merchant, *tags, [accountId+date], [categoryId+date], [type+date], [accountId+instrumentId], [accountId+instrumentId+date]`,
  postings: `${common}, transactionId, accountId, date, instrumentId, [accountId+date]`,
  categories: `${common}, parentId, kind, archived`, tags: `${common}, name`, transactionTags: `${common}, transactionId, tagId`,
  instruments: `${common}, symbol, sourceSymbol, instrumentType, currency`, investmentLots: `${common}, accountId, instrumentId, transactionId, [accountId+instrumentId]`,
  prices: `${common}, instrumentId, asOf, [instrumentId+asOf]`, fxRates: `${common}, [fromCurrency+toCurrency], asOf`,
  budgets: `${common}, categoryId, period, [categoryId+period]`, recurringRules: `${common}, nextDate, active`,
  goals: `${common}, accountId`, liabilityTerms: `${common}, accountId`, balanceSnapshots: `${common}, accountId, date, [accountId+date]`,
  settings: `${common}, &key`, syncOutbox: 'id, ownerId, entityId, tableName, status, createdAt, [tableName+entityId]', syncState: 'id',
};
export class FinanceDatabase extends Dexie {
  accounts!: Table<Account, string>; institutions!: Table<NamedEntity, string>; transactions!: Table<Transaction, string>;
  postings!: Table<Posting, string>; categories!: Table<Category, string>; tags!: Table<NamedEntity, string>; transactionTags!: Table<TransactionTag, string>;
  instruments!: Table<Instrument, string>; investmentLots!: Table<InvestmentLot, string>; prices!: Table<Price, string>; fxRates!: Table<FxRate, string>;
  budgets!: Table<Budget, string>; recurringRules!: Table<RecurringRule, string>; goals!: Table<Goal, string>; liabilityTerms!: Table<LiabilityTerms, string>;
  balanceSnapshots!: Table<BalanceSnapshot, string>; settings!: Table<Setting, string>; syncOutbox!: Table<OutboxEntry, string>; syncState!: Table<SyncState, string>;
  importFingerprints!: Table<ImportFingerprint, string>; recurringOccurrences!: Table<RecurringOccurrence, string>; conflicts!: Table<Conflict, string>;
  constructor(name = 'tala-finance') {
    super(name);
    this.version(1).stores(schema);
    this.version(2).stores({ ...schema, importFingerprints: 'id, transactionId', recurringOccurrences: 'id, ruleId, date, transactionId', conflicts: 'id, ownerId, entityId, tableName, createdAt, resolvedAt' }).upgrade(async transaction => {
      const stamp = new Date().toISOString();
      for (const table of FINANCE_TABLES) await transaction.table(table).toCollection().modify(record => {
        record.ownerId ??= 'local'; record.createdAt ??= stamp; record.updatedAt ??= stamp;
        record.version ??= 1; record.deletedAt ??= null; record.deviceId ??= 'migration-v2';
      });
    });
  }
}
export const financeDb = new FinanceDatabase();
