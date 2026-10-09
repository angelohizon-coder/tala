import { useLiveQuery } from 'dexie-react-hooks';
import { financeDb } from '../db/database';
import { financeRepository } from '../db/repository';
import {
  calculateNetWorthFromBalances, calculateFire, calculateCashFlow, calculateSavingsRate,
  categoryDescendants, FinanceValidationError,
} from '../core/calculations';
import type { CashFlowSummary } from '../core/calculations';
import type { FinanceSettings } from '../core/types';
import { today } from './shared';

export const DEFAULT_FINANCE: FinanceSettings = {
  id: 'finance', baseCurrency: 'PHP', withdrawalRate: .04, selectedAnnualSpendingBasis: 'MANUAL',
  annualSpending: 0, essentialCategoryIds: [], inflationAssumption: .03,
  investmentReturnAssumption: .06, monthlyContribution: 0, privacyMode: 'LOCAL_ONLY',
};
export function emptyFlow(): CashFlowSummary {
  return { income: 0, expenses: 0, net: 0, knownIncome: 0, knownExpenses: 0, complete: true,
    issues: [], byCategory: {}, investmentFees: 0, debtPrincipal: 0 };
}
function addMoney(left: number, right: number): number {
  const total = left + right;
  if (!Number.isSafeInteger(total)) throw new FinanceValidationError('Cash flow exceeds the supported monetary range.');
  return total;
}
export function mergeFlow(total: CashFlowSummary, next: CashFlowSummary) {
  total.knownIncome = addMoney(total.knownIncome, next.knownIncome);
  total.knownExpenses = addMoney(total.knownExpenses, next.knownExpenses);
  for (const key of ['income', 'expenses', 'investmentFees', 'debtPrincipal'] as const) {
    const current = total[key], value = next[key];
    total[key] = current === null || value === null ? null : addMoney(current, value);
  }
  total.net = total.income === null || total.expenses === null ? null : addMoney(total.income, -total.expenses);
  total.complete = total.income !== null && total.expenses !== null;
  if (total.issues.length < 25) total.issues.push(...next.issues.slice(0, 25 - total.issues.length));
}

export function useFinance() {
  return useLiveQuery(async () => {
    const settings = await financeRepository.getSetting<FinanceSettings>('finance', DEFAULT_FINANCE);
    const end = today(), date = new Date(`${end}T12:00:00`);
    const monthDate = (offset: number) => {
      const point = new Date(date.getFullYear(), date.getMonth() + offset, 1);
      return `${point.getFullYear()}-${String(point.getMonth() + 1).padStart(2, '0')}`;
    };
    const start = `${monthDate(-11)}-01`;
    const [accounts, balances, positions, fxRates, categories] = await Promise.all([
      financeDb.accounts.filter(account => !account.deletedAt).toArray(), financeRepository.accountBalances(),
      financeRepository.portfolio(), financeDb.fxRates.filter(rate => !rate.deletedAt).toArray(),
      financeDb.categories.filter(category => !category.deletedAt).toArray(),
    ]);
    const netWorth = calculateNetWorthFromBalances(accounts, balances, positions, fxRates, settings, end);
    const months = new Map<string, { month: string; flow: CashFlowSummary; adjusted: CashFlowSummary; essential: number; essentialComplete: boolean }>();
    for (let index = -11; index <= 0; index++) {
      const month = monthDate(index);
      months.set(month, { month, flow: emptyFlow(), adjusted: emptyFlow(), essential: 0, essentialComplete: true });
    }
    const spending: Record<string, number> = Object.create(null), merchants: Record<string, number> = Object.create(null);
    const essential = new Set<string>();
    for (const id of [...settings.essentialCategoryIds, ...categories.filter(category => category.essential).map(category => category.id)]) {
      for (const child of categoryDescendants(id, categories)) essential.add(child);
    }
    const options = { currency: settings.baseCurrency, fxRates, currencyPrecision: settings.currencyPrecision, to: end };
    let count = 0;
    await financeDb.transactions.where('date').between(start, end, true, true).each(transaction => {
      if (transaction.deletedAt) return;
      const bucket = months.get(transaction.date.slice(0, 7));
      if (!bucket) return;
      count++;
      const flow = calculateCashFlow([transaction], accounts, options);
      mergeFlow(bucket.flow, flow);
      const adjusted = settings.savingsRate?.excludeCategoryIds?.length
        ? calculateCashFlow([transaction], accounts, { ...options, excludeCategoryIds: settings.savingsRate.excludeCategoryIds }) : flow;
      mergeFlow(bucket.adjusted, adjusted);
      for (const [category, amount] of Object.entries(flow.byCategory)) spending[category] = addMoney(spending[category] ?? 0, amount);
      if (Object.keys(flow.byCategory).length) {
        const merchant = transaction.merchant || 'Unspecified';
        merchants[merchant] = addMoney(merchants[merchant] ?? 0, flow.knownExpenses);
      }
      if (essential.has(transaction.categoryId ?? '')) {
        bucket.essential = addMoney(bucket.essential, flow.knownExpenses);
        if (flow.expenses === null) bucket.essentialComplete = false;
      }
    });
    const history = [...months.values()].map(bucket => ({
      month: bucket.month, income: bucket.flow.knownIncome, expenses: bucket.flow.knownExpenses,
      essential: bucket.essential, complete: bucket.flow.complete,
      incomeComplete: bucket.flow.income !== null, expensesComplete: bucket.flow.expenses !== null,
      essentialComplete: bucket.essentialComplete,
      savingsRate: calculateSavingsRate(bucket.adjusted, settings.savingsRate).rate,
      savingsComplete: bucket.adjusted.complete
        && (!settings.savingsRate?.includeInvestmentFees || bucket.adjusted.investmentFees !== null)
        && (!settings.savingsRate?.includeDebtPrincipal || bucket.adjusted.debtPrincipal !== null),
    }));
    const current = history.at(-1)!;
    const active = history.filter(month => month.income > 0 && month.savingsRate !== null);
    const savings = history.every(month => month.savingsComplete) && active.length
      ? active.reduce((sum, month) => sum + month.savingsRate!, 0) / active.length : null;
    const trailingExpenses = history.reduce((sum, month) => addMoney(sum, month.expenses), 0);
    const annual = settings.selectedAnnualSpendingBasis === 'TRAILING_12_MONTHS'
      ? history.every(month => month.expensesComplete) ? trailingExpenses : null : settings.annualSpending;
    const essentialMonthly = history.every(month => month.essentialComplete)
      ? history.reduce((sum, month) => addMoney(sum, month.essential), 0) / 12 : null;
    const fire = calculateFire({
      annualSpending: annual !== null && annual > 0 ? annual : 0, withdrawalRate: settings.withdrawalRate,
      fireAssets: netWorth.fireAssets, essentialMonthlyExpenses: essentialMonthly ?? undefined,
      emergencyAssets: netWorth.emergencyAssets,
    });
    return { settings, accounts, balances, positions, fxRates, categories, netWorth, history, current,
      savings, fire, annual, essentialMonthly, spending, merchants, count };
  }, []);
}
export type FinanceSummary = NonNullable<ReturnType<typeof useFinance>>;
