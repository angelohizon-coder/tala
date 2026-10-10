import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { ShoppingBag, TrendingDown, Calendar, Tag, ArrowRight } from 'lucide-react';
import { financeDb } from '../db/database';
import { financeRepository } from '../db/repository';
import { fromMinor, convertMoney } from '../core/calculations';
import { type Transaction } from '../core/types';
import { Money, Empty, formatMoney } from '../ui/shared';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';

// Only these types classify as "expenses" (spending that reduces cash / adds to amount owed)
// Transfers, debt payments, investment purchases are excluded to avoid double-counting.
const EXPENSE_TYPES = new Set<Transaction['type']>(['EXPENSE', 'FEE', 'REFUND']);

const localDay = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const monthOf = (date = localDay()) => date.slice(0, 7);
const readable = (v: string) => v.toLowerCase().replaceAll('_', ' ').replace(/\b\w/g, c => c.toUpperCase());

function monthLabel(month: string) {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

export function ExpensesPage() {
  const [selectedMonth, setSelectedMonth] = useState(monthOf());
  const [selectedCategory, setSelectedCategory] = useState('');

  const categories = useLiveQuery(
    () => financeDb.categories.filter(c => !c.deletedAt && c.kind === 'expense').toArray(),
    [], []
  );
  const accounts = useLiveQuery(
    () => financeDb.accounts.filter(a => !a.deletedAt).toArray(),
    [], []
  );
  const settings = useLiveQuery(
    () => financeRepository.getSetting<{ baseCurrency: string }>('finance'),
    [], undefined
  );
  const fxRates = useLiveQuery(
    () => financeDb.fxRates.filter(r => !r.deletedAt).toArray(),
    [], []
  );

  const baseCurrency = settings?.baseCurrency || 'PHP';
  const start = `${selectedMonth}-01`;
  // Last day of selected month
  const [y, m] = selectedMonth.split('-').map(Number);
  const end = new Date(y, m, 0).toISOString().slice(0, 10);

  // Fetch only expense-classified transactions for the selected month
  const expenses = useLiveQuery(async () => {
    const rows = await financeDb.transactions
      .where('date').between(start, end, true, true)
      .filter(t => !t.deletedAt && EXPENSE_TYPES.has(t.type))
      .toArray();
    // Further filter: exclude postings from liability accounts acting as source
    // (those are already tracked on the Debts page)
    const liabilityAccountIds = new Set(
      accounts
        .filter(a => ['CREDIT_CARD', 'PERSONAL_LOAN', 'MORTGAGE', 'OTHER_LIABILITY'].includes(a.accountType))
        .map(a => a.id)
    );
    return rows.filter(t => !liabilityAccountIds.has(t.accountId) || t.type === 'REFUND');
  }, [start, end, accounts], []);

  // Monthly totals for the current month (last 6 months for trend)
  const monthlyTrend = useLiveQuery(async () => {
    const months: { month: string; total: number | null }[] = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(y, m - 1 - i, 1);
      const mo = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const s = `${mo}-01`;
      const e2 = new Date(d.getFullYear(), d.getMonth() + 1, 0).toISOString().slice(0, 10);
      const rows = await financeDb.transactions
        .where('date').between(s, e2, true, true)
        .filter(t => !t.deletedAt && EXPENSE_TYPES.has(t.type))
        .toArray();
      let total: number | null = 0;
      for (const t of rows) {
        const sign = t.type === 'REFUND' ? -1 : 1;
        const converted = convertMoney(t.amount * sign, t.currency, baseCurrency, fxRates ?? [], localDay(), undefined);
        if (converted === null) { total = null; break; }
        total += converted;
      }
      months.push({ month: mo, total });
    }
    return months;
  }, [y, m, baseCurrency, fxRates], []);

  // Category summaries
  const categorySummaries = useMemo(() => {
    if (!expenses || !categories) return [];
    const map = new Map<string, { name: string; color: string; amount: number; txCount: number }>();
    for (const t of expenses) {
      const catId = t.categoryId || '__uncategorized__';
      const cat = categories.find(c => c.id === catId);
      const existing = map.get(catId) ?? { name: cat?.name || 'Uncategorized', color: cat?.color || '#aaa', amount: 0, txCount: 0 };
      const sign = t.type === 'REFUND' ? -1 : 1;
      existing.amount += t.amount * sign;
      existing.txCount += 1;
      map.set(catId, existing);
    }
    return [...map.entries()]
      .map(([id, data]) => ({ id, ...data }))
      .sort((a, b) => b.amount - a.amount);
  }, [expenses, categories]);

  const filtered = useMemo(() => {
    if (!selectedCategory) return expenses ?? [];
    return (expenses ?? []).filter(t => (t.categoryId || '__uncategorized__') === selectedCategory);
  }, [expenses, selectedCategory]);

  const totalSpent = useMemo(() => {
    if (!expenses) return null;
    let total = 0;
    for (const t of expenses) {
      const sign = t.type === 'REFUND' ? -1 : 1;
      const converted = convertMoney(t.amount * sign, t.currency, baseCurrency, fxRates ?? [], localDay(), undefined);
      if (converted === null) return null;
      total += converted;
    }
    return total;
  }, [expenses, baseCurrency, fxRates]);

  const categoryName = (id: string) => {
    if (id === '__uncategorized__') return 'Uncategorized';
    return categories.find(c => c.id === id)?.name || 'Category';
  };

  const accountName = (id: string) =>
    accounts.find(a => a.id === id)?.name || 'Account';

  const dateText = (d: string) =>
    new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

  // Build last 6 months options
  const monthOptions = Array.from({ length: 12 }, (_, i) => {
    const d = new Date(y, m - 1 - i, 1);
    const mo = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    return mo;
  }).reverse();

  return (
    <div className="space-y-6 max-w-[1400px] mx-auto p-4 md:p-8">
      {/* Heading */}
      <div className="ledger-heading">
        <div>
          <span className="eyebrow">YOUR PERSONAL FINANCES</span>
          <h1>Expenses</h1>
          <p>Purchases, fees and refunds — without transfers or debt payments counted twice.</p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-end">
        <label className="field" style={{ minWidth: 160 }}>
          <span>Month</span>
          <select value={selectedMonth} onChange={e => { setSelectedMonth(e.target.value); setSelectedCategory(''); }}>
            {monthOptions.map(mo => (
              <option key={mo} value={mo}>{monthLabel(mo)}</option>
            ))}
          </select>
        </label>
        <label className="field" style={{ minWidth: 180 }}>
          <span>Category</span>
          <select value={selectedCategory} onChange={e => setSelectedCategory(e.target.value)}>
            <option value="">All categories</option>
            {categorySummaries.map(s => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </label>
      </div>

      {/* Top stats */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-5">
            <div className="flex items-center gap-2 text-slate-500 text-xs font-semibold uppercase tracking-wider mb-2">
              <TrendingDown size={14} /> Total spent
            </div>
            <strong className="block text-2xl font-bold">
              <Money amount={totalSpent} currency={baseCurrency} />
            </strong>
            <small className="text-slate-500">{monthLabel(selectedMonth)}</small>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-5">
            <div className="flex items-center gap-2 text-slate-500 text-xs font-semibold uppercase tracking-wider mb-2">
              <ShoppingBag size={14} /> Transactions
            </div>
            <strong className="block text-2xl font-bold">{expenses?.length ?? 0}</strong>
            <small className="text-slate-500">Expenses &amp; fees this month</small>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-5">
            <div className="flex items-center gap-2 text-slate-500 text-xs font-semibold uppercase tracking-wider mb-2">
              <Tag size={14} /> Categories used
            </div>
            <strong className="block text-2xl font-bold">{categorySummaries.length}</strong>
            <small className="text-slate-500">Unique categories</small>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-5">
            <div className="flex items-center gap-2 text-slate-500 text-xs font-semibold uppercase tracking-wider mb-2">
              <Calendar size={14} /> Refunds
            </div>
            <strong className="block text-2xl font-bold">
              {expenses?.filter(t => t.type === 'REFUND').length ?? 0}
            </strong>
            <small className="text-slate-500">Credited back this month</small>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Category breakdown */}
        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle className="text-base">By category</CardTitle>
          </CardHeader>
          <CardContent>
            {!categorySummaries.length ? (
              <Empty title="No expenses yet" description="Record purchases, fees or refunds to see them here." />
            ) : (
              <div className="space-y-3">
                {categorySummaries.map(s => {
                  const pct = totalSpent && totalSpent > 0 ? Math.min(100, (s.amount / totalSpent) * 100) : 0;
                  return (
                    <button
                      key={s.id}
                      className={`w-full text-left rounded-lg p-3 transition-colors ${selectedCategory === s.id ? 'bg-slate-100 ring-1 ring-slate-300' : 'hover:bg-slate-50'}`}
                      onClick={() => setSelectedCategory(s.id === selectedCategory ? '' : s.id)}
                    >
                      <div className="flex items-center justify-between gap-2 mb-1">
                        <span className="flex items-center gap-2 text-sm font-medium">
                          <i style={{ display: 'inline-block', width: 8, height: 8, background: s.color, borderRadius: 4 }} />
                          {s.name}
                        </span>
                        <span className="text-sm font-semibold">
                          <Money amount={s.amount} currency={baseCurrency} />
                        </span>
                      </div>
                      <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
                        <div className="h-full bg-[#6d549e] rounded-full" style={{ width: `${pct}%` }} />
                      </div>
                      <div className="flex justify-between mt-1 text-xs text-slate-500">
                        <span>{s.txCount} transaction{s.txCount !== 1 ? 's' : ''}</span>
                        <span>{pct.toFixed(1)}%</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Transaction list */}
        <Card className="lg:col-span-2">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-base">
              {selectedCategory ? (
                <span className="flex items-center gap-1">
                  <button className="text-slate-500 hover:text-slate-700 text-sm" onClick={() => setSelectedCategory('')}>
                    All
                  </button>
                  <ArrowRight size={12} className="text-slate-400" />
                  {categoryName(selectedCategory)}
                </span>
              ) : 'All expense transactions'}
            </CardTitle>
            <Badge variant="secondary">{filtered.length}</Badge>
          </CardHeader>
          <CardContent className="p-0">
            {!filtered.length ? (
              <div className="p-6">
                <Empty title="No transactions" description="Adjust the filter or record expenses in Transactions." />
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm text-left">
                  <caption className="sr-only">Expense transactions for {selectedMonth}</caption>
                  <thead className="text-xs text-slate-500 uppercase bg-slate-50">
                    <tr>
                      {['Date', 'Description', 'Account', 'Category', 'Amount'].map(h => (
                        <th key={h} scope="col" className="px-4 py-3 font-medium">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {filtered.map(t => (
                      <tr key={t.id} className="hover:bg-slate-50/50">
                        <td className="px-4 py-3 whitespace-nowrap text-slate-600">{dateText(t.date)}</td>
                        <td className="px-4 py-3">
                          <strong className="text-sm">{t.merchant || t.notes || readable(t.type)}</strong>
                          {t.tags?.length ? (
                            <span className="block text-xs text-slate-500 mt-0.5">{t.tags.join(' · ')}</span>
                          ) : null}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-slate-600 text-xs">{accountName(t.accountId)}</td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          {t.categoryId ? (
                            <Badge variant="outline" className="text-xs">
                              {categoryName(t.categoryId)}
                            </Badge>
                          ) : (
                            <span className="text-slate-400 text-xs">Uncategorized</span>
                          )}
                        </td>
                        <td className={`px-4 py-3 text-right whitespace-nowrap font-semibold ${t.type === 'REFUND' ? 'text-green-700' : ''}`}>
                          {t.type === 'REFUND' ? '−' : ''}
                          <Money amount={t.amount} currency={t.currency} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* 6-month trend */}
      {monthlyTrend && monthlyTrend.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Monthly spending trend</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-3 sm:grid-cols-6 gap-3">
              {monthlyTrend.map(item => (
                <button
                  key={item.month}
                  className={`rounded-lg p-3 text-center border transition-colors ${item.month === selectedMonth ? 'border-[#6d549e] bg-[#f4f0fa]' : 'border-transparent bg-slate-50 hover:bg-slate-100'}`}
                  onClick={() => { setSelectedMonth(item.month); setSelectedCategory(''); }}
                >
                  <div className="text-xs text-slate-500 mb-1">{item.month.slice(5)}/{item.month.slice(2, 4)}</div>
                  <div className="text-sm font-semibold">
                    {item.total === null ? '—' : formatMoney(item.total, baseCurrency)}
                  </div>
                </button>
              ))}
            </div>
            <p className="text-xs text-slate-500 mt-3">
              Expenses and fees only. Transfers, debt payments and investment purchases are excluded to prevent double-counting.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
