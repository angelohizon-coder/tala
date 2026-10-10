/**
 * financial-engine.mjs
 * Authoritative financial calculation oracle implementing R2 & Financial Acceptance Criteria.
 */

export const CURRENCY_SCALES = {
  PHP: 100,
  USD: 100,
  EUR: 100,
  JPY: 1,
  GBP: 100,
  SGD: 100,
  HKD: 100,
  KWD: 1000,
  BTC: 100000000
};

export function getCurrencyScale(currency) {
  return CURRENCY_SCALES[currency.toUpperCase()] ?? 100;
}

export function toMinor(amount, currency) {
  if (!Number.isFinite(amount)) throw new Error('Amount must be a finite number');
  const scale = getCurrencyScale(currency);
  const minor = Math.round(amount * scale);
  if (!Number.isSafeInteger(minor)) throw new Error('Minor amount exceeds safe integer range');
  return minor;
}

export function fromMinor(minor, currency) {
  if (!Number.isSafeInteger(minor)) throw new Error('Minor amount must be a safe integer');
  const scale = getCurrencyScale(currency);
  return minor / scale;
}

/**
 * Resolves dated exchange rate on or before asOf.
 */
export function getFxRate(from, to, fxRates, asOf = new Date().toISOString()) {
  if (from === to) return 1.0;
  const cutoff = Date.parse(asOf);

  // Filter valid rates
  const valid = fxRates.filter(r => {
    if (r.deletedAt) return false;
    if (r.rate <= 0) return false;
    return Date.parse(r.asOf) <= cutoff;
  });

  // Sort descending by asOf
  valid.sort((a, b) => Date.parse(b.asOf) - Date.parse(a.asOf));

  // Find direct match
  const direct = valid.find(r => r.fromCurrency === from && r.toCurrency === to);
  if (direct) return direct.rate;

  // Find inverse match
  const inverse = valid.find(r => r.fromCurrency === to && r.toCurrency === from);
  if (inverse) return 1.0 / inverse.rate;

  return null;
}

/**
 * Converts money from one currency to another using dated FX rates.
 * Returns null if no rate is available.
 */
export function convertMoney(amountMinor, fromCurrency, toCurrency, fxRates, asOf) {
  if (amountMinor === 0) return 0;
  if (fromCurrency === toCurrency) return amountMinor;

  const rate = getFxRate(fromCurrency, toCurrency, fxRates, asOf);
  if (rate === null) return null;

  const fromScale = getCurrencyScale(fromCurrency);
  const toScale = getCurrencyScale(toCurrency);

  const major = amountMinor / fromScale;
  const convertedMajor = major * rate;
  return Math.round(convertedMajor * toScale);
}

/**
 * Builds ledger balances per account and sub-ledger currency.
 * @returns {Record<string, Record<string, number>>} balances[accountId][currency]
 */
export function buildLedger(accounts, transactions, asOf = new Date().toISOString()) {
  const cutoff = asOf.slice(0, 10);
  const balances = {};

  for (const acc of accounts) {
    balances[acc.id] = {};
    if (acc.openingBalances) {
      for (const [curr, minor] of Object.entries(acc.openingBalances)) {
        balances[acc.id][curr] = minor;
      }
    } else if (acc.openingBalance !== undefined) {
      balances[acc.id][acc.currency] = acc.openingBalance;
    }
  }

  // Filter transactions up to cutoff
  const activeTx = transactions.filter(t => !t.deletedAt && t.date <= cutoff);
  activeTx.sort((a, b) => a.date.localeCompare(b.date));

  for (const tx of activeTx) {
    const accBalances = balances[tx.accountId] || {};
    balances[tx.accountId] = accBalances;

    if (tx.type === 'INCOME' || tx.type === 'DIVIDEND' || tx.type === 'REFUND') {
      accBalances[tx.currency] = (accBalances[tx.currency] || 0) + tx.amount;
    } else if (tx.type === 'EXPENSE' || tx.type === 'FEE') {
      accBalances[tx.currency] = (accBalances[tx.currency] || 0) - tx.amount;
    } else if (tx.type === 'TRANSFER') {
      // Source account debit
      accBalances[tx.currency] = (accBalances[tx.currency] || 0) - tx.amount;

      // Destination account credit
      if (tx.transferAccountId) {
        const destBalances = balances[tx.transferAccountId] || {};
        balances[tx.transferAccountId] = destBalances;
        const destCurrency = tx.transferCurrency || tx.currency;
        const destAmount = tx.transferAmount ?? tx.amount;
        destBalances[destCurrency] = (destBalances[destCurrency] || 0) + destAmount;
      }
    } else if (tx.type === 'BALANCE_ADJUSTMENT') {
      accBalances[tx.currency] = (accBalances[tx.currency] || 0) + tx.amount;
    }
  }

  return balances;
}

/**
 * Calculates portfolio net worth across multi-currency sub-ledgers.
 */
export function calculatePortfolioNetWorth(accounts, transactions, fxRates, baseCurrency = 'PHP', asOf = new Date().toISOString()) {
  const balances = buildLedger(accounts, transactions, asOf);
  const accountValues = [];
  let isComplete = true;
  const issues = [];
  let knownAssets = 0;
  let totalConvertedAssets = 0;

  for (const acc of accounts) {
    if (!acc.includeInNetWorth) continue;
    const subBalances = balances[acc.id] || {};
    let accountConvertedBase = 0;
    let accountHasMissingFx = false;

    for (const [curr, amt] of Object.entries(subBalances)) {
      if (amt === 0) continue;
      const converted = convertMoney(amt, curr, baseCurrency, fxRates, asOf);
      if (converted === null) {
        isComplete = false;
        accountHasMissingFx = true;
        issues.push({ code: 'missing_fx', accountId: acc.id, currency: curr });
      } else {
        accountConvertedBase += converted;
        knownAssets += converted;
      }
    }

    if (!accountHasMissingFx) {
      totalConvertedAssets += accountConvertedBase;
    }

    accountValues.push({
      accountId: acc.id,
      name: acc.name,
      cashBalances: { ...subBalances },
      baseValue: accountHasMissingFx ? null : accountConvertedBase,
      complete: !accountHasMissingFx
    });
  }

  return {
    netWorth: isComplete ? totalConvertedAssets : null,
    assets: isComplete ? totalConvertedAssets : null,
    liabilities: 0,
    knownNetWorth: knownAssets,
    knownAssets,
    complete: isComplete,
    issues,
    accountValues
  };
}

/**
 * Computes cash flow across transactions. Cross-currency transfers yield 0 net cash flow.
 */
export function calculateCashFlow(transactions, accounts, options = {}) {
  const from = options.from || '1970-01-01';
  const to = options.to || '9999-12-31';

  let income = 0;
  let expenses = 0;

  const filtered = transactions.filter(t => !t.deletedAt && t.date >= from && t.date <= to);

  for (const tx of filtered) {
    if (tx.type === 'INCOME' || tx.type === 'DIVIDEND') {
      income += tx.amount;
    } else if (tx.type === 'EXPENSE' || tx.type === 'FEE') {
      expenses += tx.amount;
    }
    // Cross-currency and same-currency transfers contribute ZERO to income and expenses
  }

  return {
    income,
    expenses,
    net: income - expenses,
    complete: true
  };
}
