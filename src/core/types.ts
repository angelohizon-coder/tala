/** Monetary balances and transaction amounts are integer minor units. Prices are major units. */
export type Currency = string;
export type Money = number;
export type DateOnly = string;

export interface Entity {
  id: string;
  createdAt?: string;
  updatedAt?: string;
  version?: number;
  ownerId?: string;
  deviceId?: string;
  deletedAt?: string | null;
}

export const ACCOUNT_TYPES = [
  'CASH', 'CHECKING', 'SAVINGS', 'EWALLET', 'TIME_DEPOSIT', 'BROKERAGE', 'UITF',
  'MUTUAL_FUND', 'PERA', 'PAGIBIG_MP2', 'RETIREMENT', 'PROPERTY', 'OTHER_ASSET',
  'CREDIT_CARD', 'PERSONAL_LOAN', 'MORTGAGE', 'OTHER_LIABILITY',
] as const;
export type AccountType = typeof ACCOUNT_TYPES[number];
export interface Account extends Entity {
  name: string;
  institutionId?: string;
  accountType: AccountType;
  /** Primary/default currency for the account */
  currency: Currency;
  /** Initial cash balances by currency */
  openingBalances?: Record<Currency, Money>;
  openingDate: DateOnly;
  includeInNetWorth: boolean;
  includeInLiquidNetWorth: boolean;
  includeInFire: boolean;
  emergency: boolean;
  archived: boolean;
  /** Legacy singular balance, kept for backwards compatibility during migration */
  openingBalance?: Money;
}

export const TRANSACTION_TYPES = [
  'EXPENSE', 'INCOME', 'TRANSFER', 'REFUND', 'INTEREST', 'DIVIDEND', 'FEE',
  'INVESTMENT_BUY', 'INVESTMENT_SELL', 'INVESTMENT_CONTRIBUTION',
  'INVESTMENT_WITHDRAWAL', 'BALANCE_ADJUSTMENT',
] as const;
export type TransactionType = typeof TRANSACTION_TYPES[number];
export interface Transaction extends Entity {
  type: TransactionType;
  date: DateOnly;
  /** Positive amount, except signed BALANCE_ADJUSTMENT. Trade notional excludes fees. */
  amount: Money;
  currency: Currency;
  accountId: string;
  transferAccountId?: string;
  /** Explicit destination amount for a cross-currency transfer, in its minor units. */
  transferAmount?: Money;
  transferCurrency?: Currency;
  /** Explicit principal split of a loan payment, in destination currency minor units. */
  principalAmount?: Money;
  categoryId?: string;
  instrumentId?: string;
  units?: number;
  /** Native currency MAJOR units; optional when the actual notional is known. */
  unitPrice?: number;
  fees?: Money;
  merchant?: string;
  notes?: string;
  reference?: string;
  tags?: string[];
}
export interface Posting extends Entity {
  transactionId: string;
  accountId: string;
  date: DateOnly;
  currency: Currency;
  /** Signed change in natural balance: assets held / liabilities owed. */
  delta: Money;
  instrumentId?: string;
  unitsDelta?: number;
}

export interface Category extends Entity {
  name: string;
  parentId?: string;
  kind: 'expense' | 'income';
  color: string;
  essential: boolean;
  archived: boolean;
}
export const INSTRUMENT_TYPES = [
  'PSE_STOCK', 'PSE_REIT', 'PSE_ETF', 'UITF', 'MUTUAL_FUND', 'PERA', 'PAGIBIG_MP2',
  'TIME_DEPOSIT', 'BOND', 'FOREIGN_STOCK', 'FOREIGN_ETF', 'CRYPTO', 'PROPERTY', 'OTHER',
] as const;
export type InstrumentType = typeof INSTRUMENT_TYPES[number];
export type ValuationMethod = 'LIVE_MARKET' | 'DAILY_NAV' | 'MANUAL_PRICE' | 'FIXED_PRINCIPAL' | 'COMPOUNDING' | 'MANUAL_VALUE';
export interface Instrument extends Entity {
  name: string;
  symbol?: string;
  instrumentType: InstrumentType;
  currency: Currency;
  valuationMethod: ValuationMethod;
  provider?: string;
  sourceSymbol?: string;
  /** Optional full-position manual value, in instrument currency MINOR units. */
  manualValue?: Money;
  /** Statement date/timestamp for the declared value; preserves historical cutoffs. */
  manualValueAsOf?: string;
  /** User-entered projection assumptions; never silently substituted for actual prices. */
  principal?: Money;
  startDate?: DateOnly;
  maturityDate?: DateOnly;
  annualRate?: number;
  withholdingRate?: number;
  compoundsPerYear?: number;
  archived?: boolean;
}
export interface Price extends Entity {
  instrumentId: string;
  /** Major units per holding unit; MANUAL_VALUE uses the full statement total instead. */
  value: number;
  currency: Currency;
  asOf: string;
  fetchedAt: string;
  source: string;
  sourceSymbol?: string;
  staleAfter: string;
  status: 'fresh' | 'stale' | 'manual' | 'error';
}
export interface FxRate extends Entity {
  fromCurrency: Currency;
  toCurrency: Currency;
  /** Number of destination MAJOR units per one source MAJOR unit. */
  rate: number;
  asOf: string;
  source: string;
  fetchedAt?: string;
}
export interface Budget extends Entity {
  categoryId: string;
  period: string;
  periodType: 'monthly' | 'annual';
  amount: Money;
  currency: Currency;
  includeChildren?: boolean;
}
export interface FireMilestone extends Entity {
  name: string;
  percentage?: number;
  target?: Money;
}
export interface FinanceSettings extends Entity {
  baseCurrency: Currency;
  /** Fraction, e.g. 0.04; an explicit user-editable assumption. */
  withdrawalRate: number;
  selectedAnnualSpendingBasis: 'MANUAL' | 'TRAILING_12_MONTHS';
  annualSpending: Money;
  essentialCategoryIds: string[];
  inflationAssumption: number;
  investmentReturnAssumption: number;
  monthlyContribution: Money;
  currencyPrecision?: Record<string, number>;
  savingsRate?: SavingsRateOptions;
  privacyMode?: 'LOCAL_ONLY' | 'CLOUD_SYNC';
}
export interface SavingsRateOptions {
  includeInvestmentFees?: boolean;
  /** Include explicitly split non-card loan principal in savings-rate expenses. */
  includeDebtPrincipal?: boolean;
  excludeCategoryIds?: string[];
}
export interface FinanceData {
  accounts: readonly Account[];
  transactions: readonly Transaction[];
  instruments: readonly Instrument[];
  prices: readonly Price[];
  fxRates: readonly FxRate[];
  categories?: readonly Category[];
  budgets?: readonly Budget[];
}
export interface CalculationIssue {
  code: 'missing_price' | 'missing_fx' | 'missing_instrument' | 'unclassified_principal' | 'projection_unavailable';
  accountId?: string;
  instrumentId?: string;
  currency?: Currency;
  transactionId?: string;
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
  missingFx?: Currency[];
}

