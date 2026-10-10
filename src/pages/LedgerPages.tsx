import { cloneElement, isValidElement, useEffect, useId, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { Plus, Pencil, Archive, Trash2, ArrowRightLeft, CalendarClock, Check, RotateCcw } from 'lucide-react';
import { financeDb, type RecurringRule, type LiabilityTerms } from '../db/database';
import { financeRepository } from '../db/repository';
import { ACCOUNT_TYPES, TRANSACTION_TYPES, type Account, type Budget, type Transaction, type TransactionType } from '../core/types';
import { toMinor, fromMinor, currencyScale, calculateBudget, calculateAmortization } from '../core/calculations';
import { Money, Empty, Dialog } from '../ui/shared';
import { soundService } from '../ui/soundManager';
import { Button, buttonVariants } from '../components/ui/button';
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import './ledger.css';

const currencies = ['PHP', 'USD', 'HKD', 'JPY', 'GBP', 'CAD', 'AUD', 'EUR', 'SGD'];
const liabilityTypes = new Set(['CREDIT_CARD', 'PERSONAL_LOAN', 'MORTGAGE', 'OTHER_LIABILITY']);
const incomeTypes = new Set<TransactionType>(['INCOME', 'INTEREST', 'DIVIDEND']);
const readable = (value: string) => value.toLowerCase().replaceAll('_', ' ').replace(/\b\w/g, char => char.toUpperCase());
const localDay = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const today = () => localDay();
const monthOf = (date = today()) => date.slice(0, 7);
const monthOffset = (month: string, offset: number) => {
  const [year, number] = month.split('-').map(Number);
  return localDay(new Date(year, number - 1 + offset, 1)).slice(0, 7);
};
const monthEnd = (month: string) => {
  const [year, number] = month.split('-').map(Number);
  return localDay(new Date(year, number, 0));
};
const dateText = (date?: string) => date ? new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : 'Not set';
const errorText = (error: unknown) => error instanceof Error ? error.message : 'The change could not be saved. Please try again.';
const majorInput = (amount: number, currency: string) => String(fromMinor(amount, currency));
const moneyStep = (currency: string) => String(1 / currencyScale(currency));
const requireAmount = (value: string, currency: string, signed = false) => {
  if (!value.trim() || !Number.isFinite(Number(value))) throw new Error('Enter a valid amount.');
  const amount = toMinor(Number(value), currency);
  if (!Number.isSafeInteger(amount) || (signed ? amount === 0 : amount <= 0)) throw new Error(signed ? 'Enter a non-zero adjustment.' : 'Enter an amount greater than zero.');
  return amount;
};

function Field({ label, children, help }: { label: string; children: ReactNode; help?: string }) {
  const id = useId(), labelId = `${id}-label`, helpId = `${id}-help`;
  const control = isValidElement<{ 'aria-labelledby'?: string; 'aria-describedby'?: string }>(children) ? cloneElement(children, { 'aria-labelledby': labelId, 'aria-describedby': help ? helpId : undefined }) : children;
  return <label className="field"><span id={labelId}>{label}</span>{control}{help && <small id={helpId}>{help}</small>}</label>;
}
function ErrorMessage({ message }: { message?: string }) { return message ? <p className="form-error" role="alert">{message}</p> : null; }
function Heading({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return <div className="ledger-heading"><div><span className="eyebrow">YOUR PERSONAL FINANCES</span><h1>{title}</h1><p>{description}</p></div>{action}</div>;
}
function CurrencySelect({ value, onChange, disabled, 'aria-labelledby': labelledBy, 'aria-describedby': describedBy }: { value: string; onChange: (value: string) => void; disabled?: boolean; 'aria-labelledby'?: string; 'aria-describedby'?: string }) {
  return <select value={value} onChange={event => onChange(event.target.value)} disabled={disabled} aria-labelledby={labelledBy} aria-describedby={describedBy}>{[...new Set([value, ...currencies])].filter(Boolean).map(currency => <option key={currency} value={currency}>{currency}</option>)}</select>;
}
function useAccounts() {
  return useLiveQuery(() => financeDb.accounts.filter(account => !account.deletedAt).toArray(), [], []);
}
function useCategories() {
  return useLiveQuery(() => financeDb.categories.filter(category => !category.deletedAt).toArray(), [], []);
}
function useInstitutions() { return useLiveQuery(() => financeDb.institutions.filter(institution => !institution.deletedAt).toArray(), [], []); }

function AccountForm({ account, onClose }: { account?: Account; onClose: () => void }) {
  const institutions = useInstitutions();
  const [entryId] = useState(account?.id || crypto.randomUUID());
  const used = useLiveQuery(() => account ? financeDb.postings.where('accountId').equals(account.id).filter(posting => !posting.deletedAt).count() : 0, [account?.id], 0) > 0;
  const [name, setName] = useState(account?.name || '');
  const [accountType, setAccountType] = useState<Account['accountType']>(account?.accountType || 'SAVINGS');
  const [currency, setCurrency] = useState(account?.currency || 'PHP');
  const [opening, setOpening] = useState(majorInput(account?.openingBalances?.[account?.currency || 'PHP'] ?? account?.openingBalance ?? 0, account?.currency || 'PHP'));
  const [openingDate, setOpeningDate] = useState(account?.openingDate || today());
  const [institution, setInstitution] = useState(account?.institutionId || '');
  const [institutionEdited, setInstitutionEdited] = useState(false);
  useEffect(() => { if (!institutionEdited && account?.institutionId) setInstitution(institutions.find(value => value.id === account.institutionId)?.name || account.institutionId); }, [institutions, account?.institutionId, institutionEdited]);
  const [netWorth, setNetWorth] = useState(account?.includeInNetWorth ?? true);
  const [liquid, setLiquid] = useState(account?.includeInLiquidNetWorth ?? true);
  const [fire, setFire] = useState(account?.includeInFire ?? false);
  const [emergency, setEmergency] = useState(account?.emergency ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const isLiability = liabilityTypes.has(accountType);
  async function save(event: FormEvent) {
    event.preventDefault(); setError(''); setBusy(true);
    try {
      if (!name.trim()) throw new Error('Enter an account name.');
      const openingBalance = toMinor(Number(opening), currency);
      if (!opening.trim() || !Number.isSafeInteger(openingBalance) || (isLiability && openingBalance < 0)) throw new Error('Enter a valid opening balance; an amount owed is positive.');
      let institutionId = institutions.find(value => value.name.toLowerCase() === institution.trim().toLowerCase())?.id;
      if (institution.trim() && !institutionId) { institutionId = crypto.randomUUID(); await financeRepository.save('institutions', { id: institutionId, name: institution.trim() }); }
      await financeRepository.save('accounts', { ...account, id: entryId, name: name.trim(), accountType, currency, openingBalances: { [currency]: openingBalance }, openingBalance, openingDate, institutionId, includeInNetWorth: netWorth, includeInLiquidNetWorth: liquid, includeInFire: fire, emergency, archived: account?.archived || false });
      soundService.play('success');
      onClose();
    } catch (failure) { soundService.play('error'); setError(errorText(failure)); } finally { setBusy(false); }
  }
  return <Dialog title={account ? 'Edit account' : 'Add an account'} onClose={onClose}><form onSubmit={save} className="ledger-form">
    <div className="form-grid"><Field label="Account name"><input autoFocus required maxLength={100} value={name} onChange={event => setName(event.target.value)} placeholder="e.g. BDO savings" /></Field>
      <Field label="Account type" help={used ? 'Keep the original type for an account with ledger entries.' : undefined}><select disabled={used} value={accountType} onChange={event => setAccountType(event.target.value as Account['accountType'])}>{ACCOUNT_TYPES.map(type => <option key={type} value={type}>{type === 'PAGIBIG_MP2' ? 'Pag-IBIG MP2' : ['UITF', 'PERA'].includes(type) ? type : readable(type)}</option>)}</select></Field>
      <Field label="Currency" help={used ? 'Currency stays fixed once an account has ledger entries.' : undefined}><CurrencySelect value={currency} onChange={setCurrency} disabled={used} /></Field>
      <Field label="Institution / provider (optional)"><input value={institution} onChange={event => { setInstitutionEdited(true); setInstitution(event.target.value); }} maxLength={100} placeholder="e.g. BDO, Maya, Pag-IBIG" /></Field>
      <Field label={isLiability ? 'Opening amount owed' : 'Opening balance'} help="Enter the actual balance from your statement."><input type="number" step={moneyStep(currency)} required value={opening} onChange={event => setOpening(event.target.value)} /></Field>
      <Field label="Opening balance date"><input type="date" required value={openingDate} onChange={event => setOpeningDate(event.target.value)} /></Field></div>
    <fieldset className="ledger-checks"><legend>Include this account in</legend>
      <label><input type="checkbox" checked={netWorth} onChange={event => setNetWorth(event.target.checked)} />Total net worth</label>
      <label><input type="checkbox" checked={liquid} onChange={event => setLiquid(event.target.checked)} />Liquid net worth</label>
      <label><input type="checkbox" checked={fire} onChange={event => setFire(event.target.checked)} />FIRE assets</label>
      <label><input type="checkbox" checked={emergency} onChange={event => setEmergency(event.target.checked)} />Emergency fund</label>
    </fieldset><p className="muted ledger-note">Balances are derived from this opening balance and posted transactions. Archived accounts keep their history.</p>
    <ErrorMessage message={error} /><div className="dialog-actions"><button type="button" className="button" onClick={onClose}>Cancel</button><button className="button primary" disabled={busy}>{busy ? 'Saving…' : 'Save account'}</button></div>
  </form></Dialog>;
}

export function AccountsPage() {
  const accounts = useAccounts();
  const institutions = useInstitutions();
  const balances = useLiveQuery(() => financeRepository.accountBalances(), [], {} as Record<string, Record<string, number>>);
  const [editing, setEditing] = useState<Account | 'new' | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [error, setError] = useState('');
  const active = accounts.filter(account => !account.archived);
  const displayed = accounts.filter(account => showArchived || !account.archived);
  async function archive(account: Account) { try { setError(''); soundService.play(account.archived ? 'success' : 'delete'); await financeRepository.save('accounts', { ...account, archived: !account.archived }); } catch (failure) { soundService.play('error'); setError(errorText(failure)); } }
  return <div className="space-y-6 max-w-[1400px] mx-auto p-4 md:p-8"><Heading title="Your accounts" description="A complete view of your cash, investments and liabilities, in their original currencies." action={<Button onClick={() => setEditing('new')}><Plus size={17} className="mr-2" />Add account</Button>} />
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      <Card><CardContent className="p-6">
        <span className="text-sm font-medium text-slate-500">Active accounts</span>
        <strong className="block text-3xl font-bold mt-2">{active.length}</strong>
      </CardContent></Card>
      <Card><CardContent className="p-6">
        <span className="text-sm font-medium text-slate-500">Liquid accounts</span>
        <strong className="block text-3xl font-bold mt-2">{active.filter(account => account.includeInLiquidNetWorth).length}</strong>
      </CardContent></Card>
      <Card><CardContent className="p-6">
        <span className="text-sm font-medium text-slate-500">FIRE eligible</span>
        <strong className="block text-3xl font-bold mt-2">{active.filter(account => account.includeInFire).length}</strong>
      </CardContent></Card>
      <Card><CardContent className="p-6">
        <span className="text-sm font-medium text-slate-500">Liabilities</span>
        <strong className="block text-3xl font-bold mt-2">{active.filter(account => liabilityTypes.has(account.accountType)).length}</strong>
      </CardContent></Card>
    </div>
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 text-sm"><p className="text-slate-500">Balances update as you record transactions, including while offline.</p><label className="flex items-center gap-2 font-medium cursor-pointer"><input type="checkbox" className="rounded border-slate-300 text-primary focus:ring-primary h-4 w-4" checked={showArchived} onChange={event => setShowArchived(event.target.checked)} />Show archived</label></div><ErrorMessage message={error} />
    {!displayed.length ? <Empty title="Start with an account" description="Add your actual bank, wallet, cash or loan balance. No personal balances are prefilled." action={<Button onClick={() => setEditing('new')}>Add your first account</Button>} /> : <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">{displayed.map(account => <Card className={account.archived ? 'opacity-60 grayscale' : ''} key={account.id}>
      <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-2">
        <div>
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">{readable(account.accountType)}</span>
          <CardTitle className="mt-1 text-xl">{account.name}</CardTitle>
          <p className="text-sm text-slate-500 mt-1">{institutions.find(value => value.id === account.institutionId)?.name || account.institutionId || 'Personal account'} Ã‚Â· {account.currency}</p>
        </div>
        <Badge variant={account.archived ? 'secondary' : liabilityTypes.has(account.accountType) ? 'pending' : 'cleared'}>{account.archived ? 'Archived' : liabilityTypes.has(account.accountType) ? 'Amount owed' : 'Asset'}</Badge>
      </CardHeader>
      <CardContent>
        <div className="text-3xl font-bold tracking-tight my-4"><Money amount={balances[account.id]?.[account.currency] ?? account.openingBalances?.[account.currency] ?? account.openingBalance ?? 0} currency={account.currency} /></div>
        <div className="flex flex-wrap gap-2 mt-4">{account.includeInNetWorth && <Badge variant="outline">Net worth</Badge>}{account.includeInLiquidNetWorth && <Badge variant="outline">Liquid</Badge>}{account.includeInFire && <Badge variant="outline">FIRE</Badge>}{account.emergency && <Badge variant="outline">Emergency</Badge>}</div>
      </CardContent>
      <CardFooter className="flex justify-end gap-2 pt-0 mt-4 border-t px-6 py-4">
        <Button variant="outline" size="sm" onClick={() => setEditing(account)}><Pencil size={14} className="mr-1.5" />Edit</Button>
        <Button variant="outline" size="sm" onClick={() => archive(account)}>{account.archived ? <RotateCcw size={14} className="mr-1.5" /> : <Archive size={14} className="mr-1.5" />}{account.archived ? 'Restore' : 'Archive'}</Button>
      </CardFooter>
    </Card>)}</div>}{editing && <AccountForm account={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
  </div>;
}

const transactionHelp: Record<TransactionType, string> = {
  EXPENSE: 'A purchase reduces cash, or increases the amount owed on a credit card. It counts toward spending once.',
  INCOME: 'Record money received into this account.', TRANSFER: 'Move money between accounts. A credit-card payment is a transfer and does not count as spending again.',
  REFUND: 'A refund credits the account and reduces the related categoryÃ¢â‚¬â„¢s spending.', INTEREST: 'Record interest received. For loan interest paid, use Expense and an interest category.',
  DIVIDEND: 'Record an actual dividend or distribution received.', FEE: 'Record a fee charged to the account.',
  INVESTMENT_BUY: 'Record purchased units and the actual trade notional. Buying an investment is not consumption spending.',
  INVESTMENT_SELL: 'Record sold units and the actual sale proceeds.', INVESTMENT_CONTRIBUTION: 'Move money into an investment account without counting it as consumption spending.',
  INVESTMENT_WITHDRAWAL: 'Move money out of an investment account without treating your principal as earned income.',
  BALANCE_ADJUSTMENT: 'A signed change to reconcile the account. Enter a reason in Notes; it does not count as income or spending.',
};

function TransactionForm({ transaction, onClose, initialType, initialDestination, recurringSave }: { transaction?: Transaction; onClose: () => void; initialType?: TransactionType; initialDestination?: string; recurringSave?: (transaction: Transaction) => Promise<void> }) {
  const [entryId] = useState(transaction?.id || crypto.randomUUID());
  const accounts = useAccounts(); const categories = useCategories();
  const instruments = useLiveQuery(() => financeDb.instruments.filter(instrument => !instrument.deletedAt && !instrument.archived).toArray(), [], []);
  const [type, setType] = useState<TransactionType>(transaction?.type || initialType || 'EXPENSE');
  const [accountId, setAccountId] = useState(transaction?.accountId || '');
  const [destination, setDestination] = useState(transaction?.transferAccountId || initialDestination || '');
  const [amount, setAmount] = useState(transaction ? majorInput(transaction.amount, transaction.currency) : '');
  const [transferAmount, setTransferAmount] = useState(transaction?.transferAmount != null ? majorInput(transaction.transferAmount, transaction.transferCurrency || transaction.currency) : '');
  const [principal, setPrincipal] = useState(transaction?.principalAmount != null ? majorInput(transaction.principalAmount, transaction.transferCurrency || transaction.currency) : '');
  const [date, setDate] = useState(transaction?.date || today());
  const [categoryId, setCategoryId] = useState(transaction?.categoryId || '');
  const [merchant, setMerchant] = useState(transaction?.merchant || ''); const [notes, setNotes] = useState(transaction?.notes || '');
  const [tags, setTags] = useState(transaction?.tags?.join(', ') || ''); const [reference, setReference] = useState(transaction?.reference || '');
  const [instrumentId, setInstrumentId] = useState(transaction?.instrumentId || '');
  const [units, setUnits] = useState(transaction?.units != null ? String(transaction.units) : '');
  const [unitPrice, setUnitPrice] = useState(transaction?.unitPrice != null ? String(transaction.unitPrice) : '');
  const [fees, setFees] = useState(transaction?.fees != null ? majorInput(transaction.fees, transaction.currency) : '');
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { if (transaction) return; let mounted = true; financeRepository.getSetting<{ accountId?: string; categoryId?: string }>('ledger:recent-entry', {}).then(recent => { if (!mounted) return; setAccountId(current => current || recent.accountId || ''); if (!initialType || initialType === 'EXPENSE') setCategoryId(current => current || recent.categoryId || ''); }).catch(() => {}); return () => { mounted = false; }; }, [transaction, initialType]);
  const account = accounts.find(item => item.id === accountId); const target = accounts.find(item => item.id === destination);
  const currency = account?.currency || transaction?.currency || 'PHP';
  const transfer = ['TRANSFER', 'INVESTMENT_CONTRIBUTION', 'INVESTMENT_WITHDRAWAL'].includes(type);
  const loanPayment = type === 'TRANSFER' && !!account && !liabilityTypes.has(account.accountType) && !!target && liabilityTypes.has(target.accountType) && target.accountType !== 'CREDIT_CARD';
  const trade = type === 'INVESTMENT_BUY' || type === 'INVESTMENT_SELL';
  const categoryOptions = categories.filter(category => !category.archived && category.kind === (incomeTypes.has(type) ? 'income' : 'expense'));
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      if (!account) throw new Error('Choose an account.');
      const value = requireAmount(amount, currency, type === 'BALANCE_ADJUSTMENT');
      if (transfer && (!target || target.id === accountId)) throw new Error('Choose a different destination account.');
      if (trade && (!instrumentId || !Number.isFinite(Number(units)) || Number(units) <= 0)) throw new Error('Choose an instrument and enter positive trade units.');
      if (type === 'BALANCE_ADJUSTMENT' && !notes.trim()) throw new Error('Describe the reason for this adjustment in Notes.');
      const entry: Transaction = { ...transaction, id: entryId, type, date, accountId, amount: value, currency,
        transferAccountId: transfer ? target?.id : undefined, transferCurrency: transfer ? target?.currency : undefined,
        transferAmount: transfer && target ? target.currency === currency ? value : requireAmount(transferAmount, target.currency) : undefined,
        principalAmount: loanPayment && principal.trim() ? toMinor(Number(principal), target!.currency) : undefined,
        categoryId: transfer ? undefined : categoryId || undefined, merchant: merchant.trim() || undefined, notes: notes.trim() || undefined, reference: reference.trim() || undefined,
        tags: tags.split(',').map(tag => tag.trim()).filter(Boolean), instrumentId: trade ? instrumentId : undefined, units: trade ? Number(units) : undefined,
        unitPrice: trade && unitPrice ? Number(unitPrice) : undefined, fees: trade && fees ? toMinor(Number(fees), currency) : undefined };
      if (recurringSave) await recurringSave(entry); else { await financeRepository.saveTransaction(entry); await financeRepository.setSetting('ledger:recent-entry', { accountId, categoryId: type === 'EXPENSE' ? categoryId : undefined }).catch(() => {}); }
      soundService.play('success');
      onClose();
    } catch (failure) { soundService.play('error'); setError(errorText(failure)); } finally { setBusy(false); }
  }
  return <Dialog title={recurringSave ? 'Recurring transaction details' : transaction ? 'Edit transaction' : 'Add transaction'} onClose={onClose}><form onSubmit={save} className="ledger-form"><div className="form-grid">
    <Field label="Transaction type"><select value={type} onChange={event => { setType(event.target.value as TransactionType); setCategoryId(''); }}>{TRANSACTION_TYPES.map(value => <option key={value} value={value}>{readable(value)}</option>)}</select></Field>
    <Field label={transfer ? 'From account' : 'Account'}><select required value={accountId} onChange={event => setAccountId(event.target.value)}><option value="">Choose an account</option>{accounts.filter(item => !item.archived || item.id === accountId).map(item => <option key={item.id} value={item.id}>{item.name} Ã‚Â· {item.currency}{liabilityTypes.has(item.accountType) ? ' Ã‚Â· liability' : ''}</option>)}</select></Field>
    <Field label={`${type === 'BALANCE_ADJUSTMENT' ? 'Signed adjustment' : 'Amount'} (${currency})`}><input autoFocus type="number" step={moneyStep(currency)} required value={amount} onChange={event => setAmount(event.target.value)} placeholder="0.00" /></Field>
    <Field label="Date"><input required type="date" value={date} onChange={event => setDate(event.target.value)} /></Field>
    {transfer ? <><Field label="To account"><select required value={destination} onChange={event => setDestination(event.target.value)}><option value="">Choose destination</option>{accounts.filter(item => item.id !== accountId && (!item.archived || item.id === destination)).map(item => <option key={item.id} value={item.id}>{item.name} Ã‚Â· {item.currency}{liabilityTypes.has(item.accountType) ? ' Ã‚Â· liability' : ''}</option>)}</select></Field>{target && target.currency !== currency && <Field label={`Actual amount received (${target.currency})`} help="Enter the actual converted amount; no exchange rate is guessed."><input type="number" step={moneyStep(target.currency)} required value={transferAmount} onChange={event => setTransferAmount(event.target.value)} /></Field>}{loanPayment && <Field label={`Declared principal paid (${target!.currency}, optional)`} help="Enter only a principal split supplied by your lender. An unsplit payment is never guessed."><input type="number" step={moneyStep(target!.currency)} min="0" value={principal} onChange={event => setPrincipal(event.target.value)} /></Field>}</> : <Field label="Category"><select value={categoryId} onChange={event => setCategoryId(event.target.value)}><option value="">Uncategorized</option>{categoryOptions.map(category => <option key={category.id} value={category.id}>{category.parentId ? `${categories.find(parent => parent.id === category.parentId)?.name || 'Category'} Ã¢â€ â€™ ` : ''}{category.name}</option>)}</select></Field>}
    {trade && <><Field label="Instrument"><select required value={instrumentId} onChange={event => setInstrumentId(event.target.value)}><option value="">Choose instrument</option>{instruments.map(instrument => <option key={instrument.id} value={instrument.id}>{instrument.name} Ã‚Â· {instrument.currency}</option>)}</select></Field><Field label="Units"><input type="number" step="any" min="0" required value={units} onChange={event => setUnits(event.target.value)} /></Field><Field label={`Unit price (${currency}, optional)`}><input type="number" step="any" min="0" value={unitPrice} onChange={event => setUnitPrice(event.target.value)} /></Field><Field label={`Trade fees (${currency}, optional)`}><input type="number" step={moneyStep(currency)} min="0" value={fees} onChange={event => setFees(event.target.value)} /></Field></>}
    <Field label="Merchant / payer (optional)"><input value={merchant} onChange={event => setMerchant(event.target.value)} maxLength={200} /></Field><Field label="Tags (comma-separated)"><input value={tags} onChange={event => setTags(event.target.value)} maxLength={500} placeholder="e.g. essentials, holiday" /></Field>
    <Field label="Receipt / reference (optional)"><input value={reference} onChange={event => setReference(event.target.value)} maxLength={200} /></Field><Field label="Notes"><textarea value={notes} onChange={event => setNotes(event.target.value)} maxLength={2000} rows={2} required={type === 'BALANCE_ADJUSTMENT'} /></Field>
  </div><p className="ledger-note muted">{transactionHelp[type]}</p>{!categories.filter(category => !category.archived).length && <p className="ledger-note muted">Create categories in Settings to organize income and spending.</p>}
    <ErrorMessage message={error} /><div className="dialog-actions"><button type="button" className="button" onClick={onClose}>Cancel</button><button className="button primary" disabled={busy || !accounts.length}>{busy ? 'SavingÃ¢â‚¬Â¦' : recurringSave ? 'Use these details' : 'Save transaction'}</button></div>
  </form></Dialog>;
}

function DeleteTransaction({ transaction, onClose }: { transaction: Transaction; onClose: () => void }) {
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  return <Dialog title="Delete this transaction?" onClose={onClose}><p>Delete {readable(transaction.type).toLowerCase()} from {dateText(transaction.date)} for <Money amount={transaction.amount} currency={transaction.currency} />? Account balances, budgets and reports will update.</p><ErrorMessage message={error} /><div className="dialog-actions"><button className="button" onClick={onClose}>Keep transaction</button><button className="button danger" disabled={busy} onClick={async () => { setBusy(true); try { soundService.play('delete'); await financeRepository.deleteTransaction(transaction.id); onClose(); } catch (failure) { soundService.play('error'); setError(errorText(failure)); setBusy(false); } }}>{busy ? 'DeletingÃ¢â‚¬Â¦' : 'Delete transaction'}</button></div></Dialog>;
}

export function TransactionsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const accounts = useAccounts(); const categories = useCategories(); const institutions = useInstitutions();
  const [month, setMonth] = useState(monthOf()); const [accountId, setAccountId] = useState(''); const [categoryId, setCategoryId] = useState('');
  const [type, setType] = useState<TransactionType | ''>(''); const [search, setSearch] = useState(''); const [currency, setCurrency] = useState(''); const [tag, setTag] = useState('');
  const [institutionId, setInstitutionId] = useState('');
  const [editing, setEditing] = useState<Transaction | 'new' | null>(null); const [deleting, setDeleting] = useState<Transaction | null>(null); const [offset, setOffset] = useState(0);
  useEffect(() => { if (searchParams.get('new') === '1') { setEditing('new'); const next = new URLSearchParams(searchParams); next.delete('new'); setSearchParams(next, { replace: true }); } }, [searchParams, setSearchParams]);
  const start = `${month}-01`, end = monthEnd(month), pageSize = 100;
  const result = useLiveQuery(() => financeRepository.listTransactions({ start, end, accountId: accountId || undefined, institutionId: institutionId || undefined, categoryId: categoryId || undefined, type: type || undefined, currency: currency || undefined, tag: tag.trim() || undefined, search: search.trim() || undefined, offset, limit: pageSize }), [start, end, accountId, institutionId, categoryId, type, currency, tag, search, offset], { items: [] as Transaction[], total: 0 });
  const rows = result.items;
  const filter = (change: () => void) => { change(); setOffset(0); };
  return <div className="space-y-6 max-w-[1400px] mx-auto p-4 md:p-8"><Heading title="Your transactions" description="The events behind your balances. Add, find and reconcile entries without an internet connection." action={<Button onClick={() => setEditing('new')}><Plus size={17} className="mr-2" />Add transaction</Button>} />
    {!accounts.length && <Empty title="Add an account first" description="Transactions belong to an account so every balance can be reconciled." action={<a className={buttonVariants({ variant: 'default' })} href="/accounts">Create an account</a>} />}
    <Card><CardContent className="p-0">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 p-6 border-b bg-slate-50/50">
        <Field label="Month"><input type="month" required value={month} onChange={event => event.target.value && filter(() => setMonth(event.target.value))} /></Field>
        <Field label="Search"><input type="search" value={search} onChange={event => filter(() => setSearch(event.target.value))} placeholder="Search your entries" /></Field>
        <Field label="Account"><select value={accountId} onChange={event => filter(() => setAccountId(event.target.value))}><option value="">All accounts</option>{accounts.map(account => <option key={account.id} value={account.id}>{account.name}</option>)}</select></Field>
        <Field label="Category"><select value={categoryId} onChange={event => filter(() => setCategoryId(event.target.value))}><option value="">All categories</option>{categories.map(category => <option key={category.id} value={category.id}>{category.name}{category.archived ? ' (archived)' : ''}</option>)}</select></Field>
        <Field label="Type"><select value={type} onChange={event => filter(() => setType(event.target.value as TransactionType | ''))}><option value="">All types</option>{TRANSACTION_TYPES.map(value => <option key={value} value={value}>{readable(value)}</option>)}</select></Field>
        <Field label="Currency"><select value={currency} onChange={event => filter(() => setCurrency(event.target.value))}><option value="">All currencies</option>{[...new Set(accounts.map(account => account.currency))].map(value => <option key={value}>{value}</option>)}</select></Field>
        <Field label="Tag (exact match)"><input type="search" value={tag} onChange={event => filter(() => setTag(event.target.value))} placeholder="Any tag" /></Field>
        <Field label="Institution"><select value={institutionId} onChange={event => filter(() => setInstitutionId(event.target.value))}><option value="">All institutions</option>{institutions.map(institution => <option key={institution.id} value={institution.id}>{institution.name}</option>)}</select></Field>
      </div><div className="px-6 py-3 text-sm text-slate-500 bg-slate-50/50 border-b">Transfers and card payments move balances without increasing spending. Amounts retain their original currency.</div>
      {!rows.length ? <div className="p-6"><Empty title="No matching transactions" description="Try another filter, or record your first income, purchase or transfer." /></div> : <div className="overflow-x-auto"><table className="w-full text-sm text-left"><caption className="sr-only">Your transactions for {month}. Edit or delete an entry to update the ledger.</caption><thead className="text-xs text-slate-500 uppercase bg-slate-50"><tr>{['Date', 'Description', 'Account', 'Category', 'Type', 'Amount', 'Actions'].map(value => <th scope="col" className="px-6 py-3 font-medium" key={value}>{value}</th>)}</tr></thead><tbody className="divide-y">{rows.map(transaction => <tr className="hover:bg-slate-50/50" key={transaction.id}>
        <td className="px-6 py-4 whitespace-nowrap">{dateText(transaction.date)}</td><td className="px-6 py-4"><strong>{transaction.merchant || transaction.notes || readable(transaction.type)}</strong>{transaction.tags?.length ? <span className="block text-xs text-slate-500 mt-1">{transaction.tags.join(' Ã‚Â· ')}</span> : null}{transaction.reference && <span className="block text-xs text-slate-500 mt-1">Ref: {transaction.reference}</span>}</td>
        <td className="px-6 py-4 whitespace-nowrap">{accounts.find(account => account.id === transaction.accountId)?.name || 'Archived account'}{transaction.transferAccountId && <span className="block text-xs text-slate-500 mt-1">Ã¢â€ â€™ {accounts.find(account => account.id === transaction.transferAccountId)?.name || 'Destination'}</span>}</td>
        <td className="px-6 py-4 whitespace-nowrap text-slate-600">{categories.find(category => category.id === transaction.categoryId)?.name || 'Ã¢â‚¬â€'}</td><td className="px-6 py-4"><Badge variant="secondary">{readable(transaction.type)}</Badge></td><td className="px-6 py-4 text-right whitespace-nowrap"><Money amount={transaction.amount} currency={transaction.currency} />{transaction.transferAmount != null && (transaction.transferCurrency || accounts.find(account => account.id === transaction.transferAccountId)?.currency || transaction.currency) !== transaction.currency && <span className="block text-xs text-slate-500 mt-1">Received <Money amount={transaction.transferAmount} currency={transaction.transferCurrency || accounts.find(account => account.id === transaction.transferAccountId)?.currency || transaction.currency} /></span>}</td>
        <td className="px-6 py-4 whitespace-nowrap"><div className="flex items-center gap-2"><Button variant="ghost" size="sm" aria-label={`Edit ${transaction.merchant || readable(transaction.type)} from ${transaction.date}`} onClick={() => setEditing(transaction)}><Pencil size={15} /></Button><Button variant="ghost" size="sm" className="text-red-600 hover:text-red-700 hover:bg-red-50" aria-label={`Delete ${transaction.merchant || readable(transaction.type)} from ${transaction.date}`} onClick={() => setDeleting(transaction)}><Trash2 size={15} /></Button></div></td>
      </tr>)}</tbody></table></div>}
      <div className="flex items-center justify-between px-6 py-4 border-t text-sm text-slate-500"><span>{rows.length} shown Ã‚Â· {result.total} matching entries</span><div className="flex gap-2"><Button variant="outline" size="sm" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - pageSize))}>Previous</Button><Button variant="outline" size="sm" disabled={offset + pageSize >= result.total} onClick={() => setOffset(offset + pageSize)}>Next</Button></div></div>
    </CardContent></Card>{editing && <TransactionForm transaction={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}{deleting && <DeleteTransaction transaction={deleting} onClose={() => setDeleting(null)} />}
  </div>;
}

function BudgetForm({ budget, onClose }: { budget?: Budget; onClose: () => void }) {
  const categories = useCategories();
  const [categoryId, setCategoryId] = useState(budget?.categoryId || ''); const [periodType, setPeriodType] = useState<Budget['periodType']>(budget?.periodType || 'monthly');
  const [period, setPeriod] = useState(budget?.period || monthOf()); const [currency, setCurrency] = useState(budget?.currency || 'PHP');
  const [amount, setAmount] = useState(budget ? majorInput(budget.amount, budget.currency) : ''); const [children, setChildren] = useState(budget?.includeChildren ?? true);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try { if (!categoryId) throw new Error('Choose an expense category.'); await financeRepository.save('budgets', { ...budget, id: budget?.id || crypto.randomUUID(), categoryId, periodType, period: periodType === 'annual' ? period.slice(0, 4) : period, currency, amount: requireAmount(amount, currency), includeChildren: children }); soundService.play('success'); onClose(); }
    catch (failure) { soundService.play('error'); setError(errorText(failure)); } finally { setBusy(false); }
  }
  return <Dialog title={budget ? 'Edit budget' : 'Create a budget'} onClose={onClose}><form className="ledger-form" onSubmit={save}><div className="form-grid">
    <Field label="Expense category"><select required value={categoryId} onChange={event => setCategoryId(event.target.value)}><option value="">Choose category</option>{categories.filter(category => category.kind === 'expense' && (!category.archived || category.id === categoryId)).map(category => <option key={category.id} value={category.id}>{category.parentId ? `${categories.find(parent => parent.id === category.parentId)?.name || 'Category'} Ã¢â€ â€™ ` : ''}{category.name}</option>)}</select></Field>
    <Field label="Budget period"><select value={periodType} onChange={event => { const value = event.target.value as Budget['periodType']; setPeriodType(value); setPeriod(value === 'annual' ? period.slice(0, 4) : `${period.slice(0, 4)}-${monthOf().slice(-2)}`); }}><option value="monthly">Monthly</option><option value="annual">Annual</option></select></Field>
    <Field label={periodType === 'annual' ? 'Year' : 'Month'}><input type={periodType === 'annual' ? 'number' : 'month'} min={periodType === 'annual' ? '1900' : undefined} max={periodType === 'annual' ? '9999' : undefined} required value={period} onChange={event => setPeriod(event.target.value)} /></Field>
    <Field label="Currency"><CurrencySelect value={currency} onChange={setCurrency} /></Field><Field label={`Budget amount (${currency})`}><input autoFocus type="number" step={moneyStep(currency)} min="0" required value={amount} onChange={event => setAmount(event.target.value)} /></Field>
  </div><label className="inline-check"><input type="checkbox" checked={children} onChange={event => setChildren(event.target.checked)} />Include child categories</label><p className="muted ledger-note">Actual expenses and fees consume the budget; refunds reduce spending. Transfers, card payments and investment purchases are excluded. Currency conversions require a stored FX rate.</p>
    <ErrorMessage message={error} /><div className="dialog-actions"><button className="button" type="button" onClick={onClose}>Cancel</button><button className="button primary" disabled={busy}>{busy ? 'SavingÃ¢â‚¬Â¦' : 'Save budget'}</button></div>
  </form></Dialog>;
}

function RecurringForm({ rule, onClose }: { rule?: RecurringRule; onClose: () => void }) {
  const accounts = useAccounts(); const categories = useCategories();
  const template = rule?.template;
  const [name, setName] = useState(rule?.name || ''); const [frequency, setFrequency] = useState<RecurringRule['frequency'] | 'custom'>(rule?.monthlyDay ? 'custom' : rule?.frequency || 'monthly');
  const [startDate, setStartDate] = useState(rule?.startDate || today()); const [nextDate, setNextDate] = useState(rule?.nextDate || today()); const [endDate, setEndDate] = useState(rule?.endDate || '');
  const [monthlyDay, setMonthlyDay] = useState(rule?.monthlyDay || Number(today().slice(-2))); const [type, setType] = useState<TransactionType>(template?.type || 'EXPENSE');
  const [accountId, setAccountId] = useState(template?.accountId || ''); const [destination, setDestination] = useState(template?.transferAccountId || '');
  const account = accounts.find(value => value.id === accountId), target = accounts.find(value => value.id === destination), currency = account?.currency || template?.currency || 'PHP';
  const [amount, setAmount] = useState(template ? majorInput(template.amount, template.currency) : ''); const [received, setReceived] = useState(template?.transferAmount != null ? majorInput(template.transferAmount, template.transferCurrency || template.currency) : '');
  const [categoryId, setCategoryId] = useState(template?.categoryId || ''); const [notes, setNotes] = useState(template?.notes || ''); const [active, setActive] = useState(rule?.active ?? true);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const transfer = ['TRANSFER', 'INVESTMENT_CONTRIBUTION', 'INVESTMENT_WITHDRAWAL'].includes(type);
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      if (!name.trim() || !account) throw new Error('Enter a name and choose an account.');
      if (nextDate < startDate || endDate && endDate < nextDate) throw new Error('The next occurrence must fall within the ruleÃ¢â‚¬â„¢s start and end dates.');
      if (transfer && (!target || target.id === accountId)) throw new Error('Choose a different destination account.');
      if (type === 'BALANCE_ADJUSTMENT' && !notes.trim()) throw new Error('Describe the reason for this adjustment in Notes.');
      const value = requireAmount(amount, currency, type === 'BALANCE_ADJUSTMENT');
      await financeRepository.save('recurringRules', { ...rule, id: rule?.id || crypto.randomUUID(), name: name.trim(), frequency: frequency === 'custom' ? 'monthly' : frequency,
        startDate, nextDate, endDate: endDate || undefined, monthlyDay: frequency === 'custom' ? monthlyDay : undefined, active,
        template: { ...template, type, accountId, amount: value, currency, transferAccountId: transfer ? target?.id : undefined, transferCurrency: transfer ? target?.currency : undefined,
          transferAmount: transfer && target ? target.currency === currency ? value : requireAmount(received, target.currency) : undefined, categoryId: transfer ? undefined : categoryId || undefined, notes: notes.trim() || undefined } });
      soundService.play('success');
      onClose();
    } catch (failure) { soundService.play('error'); setError(errorText(failure)); } finally { setBusy(false); }
  }
  return <Dialog title={rule ? 'Edit recurring rule' : 'Create a recurring rule'} onClose={onClose}><form className="ledger-form" onSubmit={save}><div className="form-grid">
    <Field label="Rule name"><input autoFocus required value={name} onChange={event => setName(event.target.value)} maxLength={100} placeholder="e.g. Salary, rent, card payment" /></Field>
    <Field label="Frequency"><select value={frequency} onChange={event => setFrequency(event.target.value as typeof frequency)}><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="custom">Monthly on a chosen day</option><option value="quarterly">Quarterly</option><option value="annual">Annual</option></select></Field>
    {frequency === 'custom' && <Field label="Day of month" help="Short months use their last valid day."><input type="number" required min={1} max={31} value={monthlyDay} onChange={event => setMonthlyDay(Number(event.target.value))} /></Field>}
    <Field label="Start date"><input type="date" required value={startDate} onChange={event => setStartDate(event.target.value)} /></Field><Field label="Next occurrence"><input type="date" required value={nextDate} onChange={event => setNextDate(event.target.value)} /></Field><Field label="End date (optional)"><input type="date" value={endDate} onChange={event => setEndDate(event.target.value)} /></Field>
    <Field label="Transaction type"><select value={type} onChange={event => { setType(event.target.value as TransactionType); setCategoryId(''); }}>{TRANSACTION_TYPES.filter(value => value !== 'INVESTMENT_BUY' && value !== 'INVESTMENT_SELL').map(value => <option key={value} value={value}>{readable(value)}</option>)}</select></Field>
    <Field label={transfer ? 'From account' : 'Account'}><select required value={accountId} onChange={event => setAccountId(event.target.value)}><option value="">Choose account</option>{accounts.filter(value => !value.archived || value.id === accountId).map(value => <option key={value.id} value={value.id}>{value.name} Ã‚Â· {value.currency}</option>)}</select></Field>
    <Field label={`Amount (${currency})`}><input type="number" step={moneyStep(currency)} required value={amount} onChange={event => setAmount(event.target.value)} /></Field>
    {transfer ? <><Field label="To account"><select required value={destination} onChange={event => setDestination(event.target.value)}><option value="">Choose destination</option>{accounts.filter(value => value.id !== accountId && (!value.archived || value.id === destination)).map(value => <option key={value.id} value={value.id}>{value.name} Ã‚Â· {value.currency}</option>)}</select></Field>{target && target.currency !== currency && <Field label={`Actual received (${target.currency})`}><input type="number" step={moneyStep(target.currency)} required value={received} onChange={event => setReceived(event.target.value)} /></Field>}</> : <Field label="Category"><select value={categoryId} onChange={event => setCategoryId(event.target.value)}><option value="">Uncategorized</option>{categories.filter(value => !value.archived && value.kind === (incomeTypes.has(type) ? 'income' : 'expense')).map(value => <option key={value.id} value={value.id}>{value.name}</option>)}</select></Field>}
    <Field label="Notes"><textarea value={notes} onChange={event => setNotes(event.target.value)} maxLength={2000} rows={2} required={type === 'BALANCE_ADJUSTMENT'} /></Field>
  </div><p className="ledger-note muted">{transactionHelp[type]}</p><label className="inline-check"><input type="checkbox" checked={active} onChange={event => setActive(event.target.checked)} />Rule is active</label><p className="ledger-note muted">A rule is a reminder, not an actual transaction. You confirm each occurrence before it affects your finances. Confirmations are recorded once per rule and date.</p><ErrorMessage message={error} />
    <div className="dialog-actions"><button className="button" type="button" onClick={onClose}>Cancel</button><button className="button primary" disabled={busy || !accounts.length}>{busy ? 'SavingÃ¢â‚¬Â¦' : 'Save rule'}</button></div>
  </form></Dialog>;
}

function RecurringSection() {
  const accounts = useAccounts();
  const rules = useLiveQuery(() => financeDb.recurringRules.orderBy('nextDate').filter(rule => !rule.deletedAt).toArray(), [], []);
  const [editing, setEditing] = useState<RecurringRule | 'new' | null>(null); const [removing, setRemoving] = useState<RecurringRule | null>(null); const [confirming, setConfirming] = useState<RecurringRule | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const week = localDay(new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate() + 7));
  const dueStatus = (rule: RecurringRule) => !rule.active ? 'Paused' : rule.endDate && rule.nextDate > rule.endDate ? 'Ended' : rule.nextDate < today() ? 'Overdue' : rule.nextDate === today() ? 'Due today' : rule.nextDate <= week ? 'Due this week' : 'Upcoming';
  return <section className="card recurring-section"><div className="ledger-card-heading"><div><span className="eyebrow">PLAN WITHOUT DOUBLE COUNTING</span><h2>Recurring transactions</h2><p className="muted">Confirm salary, bills, contributions and loan payments when they actually happen.</p></div><button className="button" onClick={() => setEditing('new')}><CalendarClock size={16} />Add rule</button></div>
    <ErrorMessage message={error} />{!rules.length ? <Empty title="No recurring rules yet" description="Add regular payments and income. Reminders never post themselves." /> : <div className="recurring-list">{rules.map(rule => <div className="recurring-row" key={rule.id}>
      <div><strong>{rule.name}</strong><small>{readable(rule.frequency)}{rule.monthlyDay ? ` Ã‚Â· day ${rule.monthlyDay}` : ''} Ã‚Â· {accounts.find(account => account.id === rule.template.accountId)?.name || 'Account unavailable'}</small></div>
      <div><Money amount={rule.template.amount} currency={rule.template.currency} /><small>{dateText(rule.nextDate)}</small></div><span className={`badge ${dueStatus(rule) === 'Overdue' ? 'warning' : dueStatus(rule) === 'Due today' ? 'teal' : ''}`}>{dueStatus(rule)}</span>
      <div className="row-actions"><button className="button small" disabled={['Paused', 'Ended'].includes(dueStatus(rule))} onClick={() => { setError(''); setConfirming(rule); }}><Check size={14} />Confirm</button><button className="button icon small" aria-label={`Edit ${rule.name} recurring rule`} onClick={() => setEditing(rule)}><Pencil size={14} /></button><button className="button icon small" aria-label={`Remove ${rule.name} recurring rule`} onClick={() => setRemoving(rule)}><Trash2 size={14} /></button></div>
    </div>)}</div>}
    {editing && <RecurringForm rule={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
    {confirming && <Dialog title="Confirm this occurrence" onClose={() => !busy && setConfirming(null)}><p>Record <strong>{confirming.name}</strong> on {dateText(confirming.nextDate)} for <Money amount={confirming.template.amount} currency={confirming.template.currency} />? This creates one actual transaction.</p><p className="muted">Only confirm when the payment or income has happened. You can edit the resulting entry in Transactions.</p><ErrorMessage message={error} /><div className="dialog-actions"><button className="button" disabled={busy} onClick={() => setConfirming(null)}>Cancel</button><button className="button primary" disabled={busy} onClick={async () => { setBusy(true); setError(''); try { await financeRepository.confirmRecurring(confirming.id, confirming.nextDate); soundService.play('success'); setConfirming(null); } catch (failure) { soundService.play('error'); setError(errorText(failure)); } finally { setBusy(false); } }}>{busy ? 'RecordingÃ¢â‚¬Â¦' : 'Record occurrence'}</button></div></Dialog>}
    {removing && <Dialog title="Remove recurring rule?" onClose={() => !busy && setRemoving(null)}><p>Remove <strong>{removing.name}</strong>? Previously confirmed transactions stay in your ledger.</p><ErrorMessage message={error} /><div className="dialog-actions"><button className="button" disabled={busy} onClick={() => setRemoving(null)}>Keep rule</button><button className="button danger" disabled={busy} onClick={async () => { setBusy(true); try { soundService.play('delete'); await financeRepository.remove('recurringRules', removing.id); setRemoving(null); } catch (failure) { soundService.play('error'); setError(errorText(failure)); } finally { setBusy(false); } }}>Remove rule</button></div></Dialog>}
  </section>;
}

export function BudgetsPage() {
  const accounts = useAccounts(); const categories = useCategories();
  const budgets = useLiveQuery(() => financeDb.budgets.filter(budget => !budget.deletedAt).toArray(), [], []);
  const fxRates = useLiveQuery(() => financeDb.fxRates.filter(rate => !rate.deletedAt).toArray(), [], []);
  const [year, setYear] = useState(today().slice(0, 4)); const [editing, setEditing] = useState<Budget | 'new' | null>(null); const [removing, setRemoving] = useState<Budget | null>(null);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const displayed = useMemo(() => budgets.filter(budget => budget.period.startsWith(year)).sort((a, b) => b.period.localeCompare(a.period)), [budgets, year]);
  const start = `${Number(year) - 1}-01-01`, end = `${year}-12-31`;
  const summaries = useLiveQuery(async () => {
    const transactions = await financeDb.transactions.where('date').between(start, end, true, true).filter(transaction => !transaction.deletedAt).toArray();
    return displayed.map(budget => {
      const summary = calculateBudget(budget, transactions, accounts, categories, fxRates, today());
      const anchor = budget.periodType === 'monthly' ? budget.period : budget.period === today().slice(0, 4) ? monthOf() : `${budget.period}-12`;
      const monthResults = new Map<string, number | null>();
      const monthly = (month: string) => { if (!monthResults.has(month)) monthResults.set(month, calculateBudget({ ...budget, periodType: 'monthly', period: month, amount: 0 }, transactions, accounts, categories, fxRates, today()).spent); return monthResults.get(month)!; };
      const previous = monthly(monthOffset(anchor, -1)), current = monthly(anchor);
      const average = (months: number) => { const amounts = Array.from({ length: months }, (_, index) => monthly(monthOffset(anchor, -index - 1))); return amounts.some(value => value == null) ? null : Math.round(amounts.reduce<number>((sum, value) => sum + (value || 0), 0) / months); };
      return { budget, summary, previous, difference: previous == null || current == null ? null : current - previous, average3: average(3), average12: average(12) };
    });
  }, [start, end, displayed, accounts, categories, fxRates], []);
  return <div className="page-section ledger-page"><Heading title="Budgets & recurring" description="Give your spending a plan, then compare it with the expenses actually recorded." action={<button className="button primary" onClick={() => setEditing('new')}><Plus size={17} />Create budget</button>} />
    <div className="ledger-toolbar"><Field label="Budget year"><input className="year-input" type="number" min={1900} max={9999} value={year} onChange={event => /^\d{4}$/.test(event.target.value) && setYear(event.target.value)} /></Field><p className="muted">Projections use spending so far at the same pace; future spending can differ.</p></div>
    {!categories.some(category => category.kind === 'expense' && !category.archived) && <p className="ledger-note muted">Create expense categories in <a href="#/settings">Settings</a> before adding a category budget.</p>}
    {!summaries.length ? <Empty title="No budgets for this year" description="Create a monthly or annual category target. Your actual transactions supply the spending values." /> : <div className="budget-grid">{summaries.map(({ budget, summary, difference, average3, average12 }) => <article className="card budget-card" key={budget.id}>
      <div className="ledger-card-heading"><div><span className="eyebrow">{budget.periodType === 'annual' ? 'ANNUAL TARGET' : 'MONTHLY BUDGET'} Ã‚Â· {budget.period}</span><h2>{categories.find(category => category.id === budget.categoryId)?.name || 'Category unavailable'}</h2></div><div className="row-actions"><button className="button icon small" aria-label="Edit budget" onClick={() => setEditing(budget)}><Pencil size={14} /></button><button className="button icon small" aria-label="Remove budget" onClick={() => setRemoving(budget)}><Trash2 size={14} /></button></div></div>
      <div className="budget-main"><div><span>Spent</span><strong><Money amount={summary.spent} currency={budget.currency} /></strong></div><div><span>Budget</span><strong><Money amount={budget.amount} currency={budget.currency} /></strong></div></div>
      {summary.percentUsed != null && <progress max={100} value={Math.max(0, Math.min(100, summary.percentUsed))} aria-label="Budget percentage consumed" />}<p className={summary.remaining != null && summary.remaining < 0 ? 'negative' : 'muted'}>{summary.percentUsed == null ? 'Percentage unavailable' : `${summary.percentUsed.toFixed(1)}% used`} Ã‚Â· Remaining <Money amount={summary.remaining} currency={budget.currency} /></p>
      <dl className="ledger-metrics"><div><dt>Projected {budget.periodType === 'annual' ? 'year-end' : 'month-end'}</dt><dd><Money amount={summary.projectedSpend} currency={budget.currency} /></dd></div><div><dt>Current month vs. prior</dt><dd><Money amount={difference} currency={budget.currency} /></dd></div><div><dt>Previous 3-month average</dt><dd><Money amount={average3} currency={budget.currency} /></dd></div><div><dt>Previous 12-month average</dt><dd><Money amount={average12} currency={budget.currency} /></dd></div></dl>
      {!summary.complete && <p className="form-error">Some expenses need a currency conversion. Spending and remaining amounts are unavailable until a valid FX rate is entered.</p>}<small className="muted">{budget.includeChildren ? 'Includes child categories.' : 'This category only.'} Averages include zero-spending months.</small>
    </article>)}</div>}
    <RecurringSection />{editing && <BudgetForm budget={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
    {removing && <Dialog title="Remove budget?" onClose={() => !busy && setRemoving(null)}><p>Remove this {removing.period} budget? Your transactions and historical spending remain unchanged.</p><ErrorMessage message={error} /><div className="dialog-actions"><button className="button" disabled={busy} onClick={() => setRemoving(null)}>Keep budget</button><button className="button danger" disabled={busy} onClick={async () => { setBusy(true); try { soundService.play('delete'); await financeRepository.remove('budgets', removing.id); setRemoving(null); } catch (failure) { soundService.play('error'); setError(errorText(failure)); } finally { setBusy(false); } }}>Remove budget</button></div></Dialog>}
  </div>;
}

function DebtTermsForm({ account, terms, onClose }: { account: Account; terms?: LiabilityTerms; onClose: () => void }) {
  const [principal, setPrincipal] = useState(terms?.principal != null ? majorInput(terms.principal, account.currency) : '');
  const [rate, setRate] = useState(terms ? String(terms.annualInterestRate * 100) : '');
  const [minimum, setMinimum] = useState(terms ? majorInput(terms.minimumPayment, account.currency) : '');
  const [dueDay, setDueDay] = useState(terms?.dueDay != null ? String(terms.dueDay) : ''); const [months, setMonths] = useState(terms?.termMonths != null ? String(terms.termMonths) : '');
  const [startDate, setStartDate] = useState(terms?.startDate || account.openingDate); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const annualInterestRate = Number(rate) / 100, minimumPayment = toMinor(Number(minimum), account.currency);
      if (!rate.trim() || !Number.isFinite(annualInterestRate) || annualInterestRate < 0 || annualInterestRate > 10) throw new Error('Enter the annual interest rate, including 0 for an interest-free debt.');
      if (!minimum.trim() || !Number.isSafeInteger(minimumPayment) || minimumPayment < 0) throw new Error('Enter a valid minimum payment.');
      if (months && (!Number.isInteger(Number(months)) || Number(months) < 1 || Number(months) > 600)) throw new Error('Use a projection term from 1 to 600 months.');
      await financeRepository.save('liabilityTerms', { ...terms, id: terms?.id || crypto.randomUUID(), accountId: account.id, annualInterestRate, minimumPayment,
        dueDay: dueDay ? Number(dueDay) : undefined, termMonths: months ? Number(months) : undefined, startDate,
        principal: principal ? requireAmount(principal, account.currency) : undefined });
      soundService.play('success');
      onClose();
    } catch (failure) { soundService.play('error'); setError(errorText(failure)); } finally { setBusy(false); }
  }
  return <Dialog title={`Debt terms Ã‚Â· ${account.name}`} onClose={onClose}><form className="ledger-form" onSubmit={save}><div className="form-grid">
    <Field label={`Original principal (${account.currency}, optional)`} help="Reference information; the current balance comes from your ledger."><input type="number" step={moneyStep(account.currency)} min="0" value={principal} onChange={event => setPrincipal(event.target.value)} /></Field>
    <Field label="Annual interest rate (%)"><input autoFocus type="number" step="any" min="0" max="1000" required value={rate} onChange={event => setRate(event.target.value)} /></Field>
    <Field label={`Minimum payment (${account.currency})`}><input type="number" step={moneyStep(account.currency)} min="0" required value={minimum} onChange={event => setMinimum(event.target.value)} /></Field>
    <Field label="Monthly due day (optional)"><input type="number" min="1" max="31" value={dueDay} onChange={event => setDueDay(event.target.value)} /></Field>
    <Field label="Projection term (months, optional)" help="A hypothetical fixed-payment plan from your current balance."><input type="number" min="1" max="600" value={months} onChange={event => setMonths(event.target.value)} /></Field>
    <Field label="Debt start date"><input type="date" required value={startDate} onChange={event => setStartDate(event.target.value)} /></Field>
  </div><p className="muted ledger-note">Changing these terms does not post payments, create interest charges or overwrite your actual balance. Record actual charges and repayments in Transactions.</p><ErrorMessage message={error} />
    <div className="dialog-actions"><button type="button" className="button" onClick={onClose}>Cancel</button><button className="button primary" disabled={busy}>{busy ? 'SavingÃ¢â‚¬Â¦' : 'Save debt terms'}</button></div>
  </form></Dialog>;
}

function DebtProjection({ balance, terms, currency }: { balance: number; terms: LiabilityTerms; currency: string }) {
  let result: ReturnType<typeof calculateAmortization> | null = null;
  let error = '';
  try { if (terms.termMonths && balance > 0) result = calculateAmortization(balance, terms.annualInterestRate, terms.termMonths); }
  catch (failure) { error = errorText(failure); }
  if (error) return <p className="form-error">Projection unavailable: {error}</p>;
  if (!result) return <p className="muted ledger-note">{balance <= 0 ? 'No outstanding balance to project.' : 'Add a projection term to compare a fixed monthly repayment plan.'}</p>;
  const projectedMonth = monthOffset(monthOf(), terms.termMonths!);
  return <section className="debt-projection"><span className="badge purple">Projection Ã‚Â· assumptions</span>
    <dl className="ledger-metrics"><div><dt>Fixed monthly payment</dt><dd><Money amount={result.monthlyPayment} currency={currency} /></dd></div><div><dt>Projected interest</dt><dd><Money amount={result.totalInterest} currency={currency} /></dd></div><div><dt>Projected total paid</dt><dd><Money amount={result.totalPaid} currency={currency} /></dd></div><div><dt>Illustrative payoff month</dt><dd>{dateText(`${projectedMonth}-01`)}</dd></div></dl>
    <p className="muted ledger-note">Assumes {terms.termMonths} on-time monthly payments at {(terms.annualInterestRate * 100).toLocaleString()}% annual interest, with no new borrowing, fees or rate changes. These are estimates, separate from recorded balances.</p>
    <details><summary>View projected amortization</summary><div className="table-scroll"><table className="data-table compact"><caption className="sr-only">Projected monthly repayments in {currency}, not actual transactions</caption><thead><tr><th scope="col">Month</th><th scope="col">Payment</th><th scope="col">Principal</th><th scope="col">Interest</th><th scope="col">Balance</th></tr></thead><tbody>{result.schedule.map(row => <tr key={row.month}><td>{row.month}</td><td><Money amount={row.payment} currency={currency} /></td><td><Money amount={row.principal} currency={currency} /></td><td><Money amount={row.interest} currency={currency} /></td><td><Money amount={row.balance} currency={currency} /></td></tr>)}</tbody></table></div></details>
  </section>;
}

export function DebtsPage() {
  const accounts = useAccounts(); const debts = accounts.filter(account => !account.archived && liabilityTypes.has(account.accountType));
  const terms = useLiveQuery(() => financeDb.liabilityTerms.filter(term => !term.deletedAt).toArray(), [], []);
  const balances = useLiveQuery(() => financeRepository.accountBalances(), [], {} as Record<string, Record<string, number>>);
  const debtIds = debts.map(account => account.id).sort().join('|');
  const recorded = useLiveQuery(async () => {
    const ids = new Set<string>();
    const accountIds = new Set(debtIds.split('|').filter(Boolean));
    const categoryNames = new Map((await financeDb.categories.filter(category => !category.deletedAt).toArray()).map(category => [category.id, category.name]));
    for (const accountId of accountIds) await financeDb.postings.where('accountId').equals(accountId).filter(posting => !posting.deletedAt && posting.date <= today()).each(posting => { ids.add(posting.transactionId); });
    const totals: Record<string, { repayments: number; interest: number; principal: number; splitCount: number; unsplitCount: number }> = {};
    const empty = () => ({ repayments: 0, interest: 0, principal: 0, splitCount: 0, unsplitCount: 0 });
    const transactionIds = [...ids];
    for (let offset = 0; offset < transactionIds.length; offset += 500) {
      for (const transaction of await financeDb.transactions.bulkGet(transactionIds.slice(offset, offset + 500))) {
        if (!transaction || transaction.deletedAt || transaction.date > today()) continue;
        if (transaction.type === 'TRANSFER' && transaction.transferAccountId && accountIds.has(transaction.transferAccountId)) {
          const total = totals[transaction.transferAccountId] ||= empty();
          total.repayments += transaction.transferAmount ?? transaction.amount;
          if (transaction.principalAmount !== undefined) { total.principal += transaction.principalAmount; total.splitCount++; }
          else total.unsplitCount++;
        }
        if (accountIds.has(transaction.accountId) && ['EXPENSE', 'FEE', 'REFUND'].includes(transaction.type) && (/\binterest\b/i.test(categoryNames.get(transaction.categoryId || '') || '') || transaction.tags?.some(tag => tag.toLowerCase() === 'interest'))) {
          const total = totals[transaction.accountId] ||= empty();
          total.interest += transaction.type === 'REFUND' ? -transaction.amount : transaction.amount;
        }
      }
    }
    return totals;
  }, [debtIds], {} as Record<string, { repayments: number; interest: number; principal: number; splitCount: number; unsplitCount: number }>);
  const [editing, setEditing] = useState<Account | null>(null); const [paying, setPaying] = useState<Account | null>(null);
  const currencyGroups = [...new Set(debts.map(account => account.currency))].map(currency => ({ currency, balance: debts.filter(account => account.currency === currency).reduce((sum, account) => sum + Math.max(0, balances[account.id]?.[account.currency] ?? account.openingBalances?.[account.currency] ?? account.openingBalance ?? 0), 0) }));
  return <div className="page-section ledger-page"><Heading title="Debts & repayment" description="Track what you actually owe, then explore repayment projections using your own terms." action={<a className="button primary" href="#/accounts"><Plus size={17} />Add a liability account</a>} />
    {!debts.length ? <Empty title="No liability accounts yet" description="Add a credit card, personal loan, mortgage or other liability with its actual opening amount owed." action={<a className="button primary" href="#/accounts">Add your debt account</a>} /> : <>
      <div className="stat-grid">{currencyGroups.map(group => <article className="stat-card" key={group.currency}><span>Outstanding debt Ã‚Â· {group.currency}</span><strong><Money amount={group.balance} currency={group.currency} /></strong><small>Original currency Ã‚Â· actual ledger balances</small></article>)}</div>
      <p className="muted ledger-note">Card and loan payments are transfers. Record interest charged as a separate expense; the application does not guess how an unsplit payment divides into principal and interest.</p>
      <div className="debt-grid">{debts.map(account => {
        const term = terms.find(value => value.accountId === account.id), balance = balances[account.id]?.[account.currency] ?? account.openingBalances?.[account.currency] ?? account.openingBalance ?? 0;
        const payments = recorded[account.id]?.repayments || 0, interest = recorded[account.id]?.interest || 0;
        return <article className="card debt-card" key={account.id}><div className="ledger-card-heading"><div><span className="eyebrow">{readable(account.accountType)}</span><h2>{account.name}</h2></div><span className="badge">Actual balance</span></div>
          <div className="account-balance"><Money amount={balance} currency={account.currency} /></div>{balance < 0 && <p className="muted">Credit balance; no amount is currently owed.</p>}
          <dl className="ledger-metrics"><div><dt>Recorded repayments</dt><dd><Money amount={payments} currency={account.currency} /></dd></div><div><dt>Interest charged to this account</dt><dd><Money amount={interest} currency={account.currency} /></dd></div>
            {account.accountType !== 'CREDIT_CARD' && <div><dt>Explicitly recorded principal paid</dt><dd><Money amount={recorded[account.id]?.splitCount ? recorded[account.id].principal : null} currency={account.currency} />{recorded[account.id]?.unsplitCount ? <small>Excludes {recorded[account.id].unsplitCount} unsplit payment(s)</small> : null}</dd></div>}
            <div><dt>Original principal</dt><dd><Money amount={term?.principal} currency={account.currency} /></dd></div><div><dt>Configured minimum payment</dt><dd><Money amount={term?.minimumPayment} currency={account.currency} /></dd></div><div><dt>Annual interest rate</dt><dd>{term ? `${(term.annualInterestRate * 100).toLocaleString()}%` : 'Not entered'}</dd></div><div><dt>Monthly due day</dt><dd>{term?.dueDay ? `Day ${term.dueDay}` : 'Not entered'}</dd></div></dl>
          <small className="muted">Interest totals include only expenses or refunds explicitly categorized or tagged Ã¢â‚¬Å“interestÃ¢â‚¬Â on this account.</small>
          <div className="ledger-card-actions"><button className="button" onClick={() => setEditing(account)}><Pencil size={15} />{term ? 'Edit terms' : 'Enter debt terms'}</button><button className="button primary" onClick={() => setPaying(account)}><ArrowRightLeft size={15} />Record payment</button></div>
          {term && <DebtProjection balance={balance} terms={term} currency={account.currency} />}
        </article>;
      })}</div>
    </>}{editing && <DebtTermsForm account={editing} terms={terms.find(value => value.accountId === editing.id)} onClose={() => setEditing(null)} />}{paying && <TransactionForm initialType="TRANSFER" initialDestination={paying.id} onClose={() => setPaying(null)} />}
  </div>;
}
