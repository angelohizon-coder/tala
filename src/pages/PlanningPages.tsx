import { useEffect, useState, type FormEvent } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, BarChart, Bar, Legend } from 'recharts';
import { Plus, RefreshCw, Download, Target } from 'lucide-react';
import { financeDb, type Goal } from '../db/database';
import { financeRepository } from '../db/repository';
import { INSTRUMENT_TYPES, type Category, type FinanceSettings } from '../core/types';
import { toMinor, fromMinor, convertMoney, calculateCashFlow, calculateSavingsRate, calculatePositions, calculateNetWorthFromBalances, categoryDescendants, validDate, isLiability, FinanceValidationError } from '../core/calculations';
import { useFinance, emptyFlow, mergeFlow } from '../ui/useFinance';
import { PageHeading, Money, Field, Dialog, Empty, ErrorMessage, today, download, csvValue, formatMoney } from '../ui/shared';
import { refreshFx } from '../market/providers';
import { runFireSimulationInWorker, type FireSimulationResult } from '../workers/fireSimulation';

const currencies=['PHP','USD','EUR','GBP','JPY','HKD','CAD','AUD','SGD'];
export function FirePage(){
  const data=useFinance(),goals=useLiveQuery(()=>financeDb.goals.filter(g=>!g.deletedAt).toArray(),[]);
  const [edit,setEdit]=useState(false),[goal,setGoal]=useState<Goal|true|null>(null),[error,setError]=useState('');
  const [simulation,setSimulation]=useState<FireSimulationResult|null>(null);
  const [isSimulating,setIsSimulating]=useState(false);

  if(!data)return <div className="loading">Calculating your FIRE journey…</div>;
  const {settings,fire,netWorth}=data,currency=settings.baseCurrency;
  const projectionReady=netWorth.fireAssets!==null&&fire.target!==null;

  useEffect(()=>{
    if(!projectionReady){
      setSimulation(null);
      return;
    }
    let active=true;
    setIsSimulating(true);

    const initialAssets=netWorth.fireAssets??0;
    const annualContribution=(settings.monthlyContribution??0)*12;
    const annualExpenses=settings.annualSpending>0?settings.annualSpending:(fire.target?Math.round(fire.target*settings.withdrawalRate):0);

    runFireSimulationInWorker({
      initialAssets,
      annualContribution,
      annualExpenses,
      expectedReturn:settings.investmentReturnAssumption??0.07,
      returnVolatility:0.16,
      degreesOfFreedom:5,
      expectedInflation:settings.inflationAssumption??0.03,
      inflationVolatility:0.015,
      iterations:5000,
      years:40
    }).then(result=>{
      if(active){
        setSimulation(result);
        setIsSimulating(false);
      }
    }).catch(()=>{
      if(active){
        setIsSimulating(false);
      }
    });

    return ()=>{active=false;};
  },[projectionReady,netWorth.fireAssets,fire.target,settings.monthlyContribution,settings.annualSpending,settings.withdrawalRate,settings.investmentReturnAssumption,settings.inflationAssumption]);

  const currentYear=new Date().getFullYear();
  const trajectories=simulation?.trajectories.map((pt,idx)=>{
    const targetCompounded=(fire.target??0)*Math.pow(1+(settings.inflationAssumption??0.03),idx);
    return {
      year:currentYear+pt.year,
      p10:fromMinor(Math.round(pt.p10),currency),
      p50:fromMinor(Math.round(pt.p50),currency),
      p90:fromMinor(Math.round(pt.p90),currency),
      target:fromMinor(Math.round(targetCompounded),currency)
    };
  })??[];

  const medianTargetYear=trajectories.find(p=>p.target>0&&p.p50>=p.target)?.year;
  const p90TargetYear=trajectories.find(p=>p.target>0&&p.p90>=p.target)?.year;

  const depletionPdfData=simulation?Object.entries(simulation.depletionYearPdf).map(([yrStr,prob])=>({
    year:currentYear+Number(yrStr),
    probability:prob
  })):[];

  async function saveSettings(e:FormEvent<HTMLFormElement>){e.preventDefault();const fd=new FormData(e.currentTarget);try{const rate=Number(fd.get('withdrawal'))/100;if(rate<=0||rate>1)throw new Error('Enter a positive withdrawal assumption.');await financeRepository.setSetting('finance',{...settings,annualSpending:toMinor(Number(fd.get('annual')),currency),withdrawalRate:rate,selectedAnnualSpendingBasis:String(fd.get('basis')),monthlyContribution:toMinor(Number(fd.get('contribution')),currency),investmentReturnAssumption:Number(fd.get('return'))/100,inflationAssumption:Number(fd.get('inflation'))/100});setEdit(false);}catch(e){setError((e as Error).message);}}
  async function saveGoal(e:FormEvent<HTMLFormElement>){e.preventDefault();const fd=new FormData(e.currentTarget);try{const existing=goal!==true&&goal?goal:undefined;await financeRepository.save('goals',{...existing,id:existing?.id||crypto.randomUUID(),name:String(fd.get('name')),currency,target:toMinor(Number(fd.get('target')||0),currency),...(fd.get('percent')?{percentage:Number(fd.get('percent'))/100}:{}),targetDate:String(fd.get('date')||'')||undefined});setGoal(null);}catch(e){setError((e as Error).message);}}
  const templates=[{name:'Emergency fund',percentage:.05},{name:'Coast FI',percentage:.25},{name:'Lean FI',percentage:.7},{name:'Full FI',percentage:1},{name:'Fat FI',percentage:1.5},{name:'Financial freedom',percentage:2}];
  async function useTemplates(){for(const t of templates)await financeRepository.save('goals',{id:crypto.randomUUID(),name:t.name,target:0,currency,percentage:t.percentage});}
  return <><PageHeading eyebrow="YOUR NEXT CHAPTER" title="Freedom, at your own pace" description="Define what enough means for you. All assumptions are visible and editable." action={<button className="button primary" onClick={()=>{setEdit(true);setError('');}}>Edit FIRE plan</button>}/><div className="stat-grid"><div className="stat-card"><span>FIRE TARGET</span><strong><Money amount={fire.target} currency={currency}/></strong><small>{(settings.withdrawalRate*100).toFixed(1)}% withdrawal assumption</small></div><div className="stat-card"><span>FIRE-ELIGIBLE ASSETS</span><strong><Money amount={netWorth.fireAssets} currency={currency}/></strong><small>You choose eligible accounts</small></div><div className="stat-card"><span>YOUR PROGRESS</span><strong>{fire.progress===null?'—':`${(fire.progress*100).toFixed(1)}%`}</strong><small>Gap: <Money amount={fire.gap} currency={currency}/></small></div><div className="stat-card"><span>EMERGENCY FUND</span><strong>{fire.emergencyMonths===null?'—':`${fire.emergencyMonths.toFixed(1)} months`}</strong><small>Essential spending · recorded 12 months</small></div></div><div className="grid-two"><section className="card"><div className="section-title"><div><span className="eyebrow">STOCHASTIC MONTE CARLO (STUDENT'S T, ν = 5)</span><h2>5,000 scenario trajectories</h2></div><Target size={18}/></div><div className="projection-label">{(settings.investmentReturnAssumption*100).toFixed(1)}% assumed return (16% vol) · {(settings.inflationAssumption*100).toFixed(1)}% inflation · <Money amount={settings.monthlyContribution} currency={currency}/> / month. {isSimulating?<span style={{color:'#427c61'}}>Simulating 5,000 iterations in Web Worker…</span>:medianTargetYear?`Median FIRE target year (P50): ${medianTargetYear}${p90TargetYear&&p90TargetYear<medianTargetYear?` (P90 optimistic: ${p90TargetYear})`:''}.`:'No median target reached within 40-year scenario.'}</div>{isSimulating&&!simulation&&<div className="loading" style={{margin:'20px 0'}}>Simulating 5,000 stochastic scenarios via Web Worker…</div>}{projectionReady&&simulation?<><div className="chart-container" style={{marginTop:20}}><ResponsiveContainer width="100%" height="100%"><AreaChart data={trajectories}><CartesianGrid vertical={false} stroke="#eef0f0"/><XAxis dataKey="year" fontSize={10} tickLine={false}/><YAxis fontSize={10} tickFormatter={v=>`${(v/1000000).toFixed(1)}m`} width={45}/><Tooltip formatter={v=>new Intl.NumberFormat('en',{style:'currency',currency}).format(Number(v))}/><Area isAnimationActive={false} type="monotone" dataKey="p90" name="P90 (Optimistic 90th percentile)" stroke="#a38bcc" fill="#f0ebf8" fillOpacity={0.4}/><Area isAnimationActive={false} type="monotone" dataKey="p50" name="P50 (Median 50th percentile)" stroke="#6d549e" strokeWidth={2} fill="#e3dbf2" fillOpacity={0.6}/><Area isAnimationActive={false} type="monotone" dataKey="p10" name="P10 (Conservative 10th percentile)" stroke="#37265a" strokeWidth={1.5} fill="#ffffff" fillOpacity={0.8}/><Area isAnimationActive={false} type="monotone" dataKey="target" name="Inflation-adjusted target" stroke="#7da38b" fill="transparent" strokeDasharray="5 5"/><Legend wrapperStyle={{fontSize:10}}/></AreaChart></ResponsiveContainer></div><div style={{display:'flex',flexWrap:'wrap',gap:8,marginTop:14}}><span className="badge" style={{background:'#e1ede7',color:'#173c34',padding:'3px 8px',borderRadius:4,fontSize:11,fontWeight:600}}>Plan Success Rate: {(simulation.successRate*100).toFixed(1)}%</span><span className="badge" style={{background:'#f2f7f4',color:'#4f5e58',padding:'3px 8px',borderRadius:4,fontSize:11}}>Convergence SE: ±{(simulation.standardError*100).toFixed(2)}% (N = 5,000)</span><span className="badge" style={{background:'#f2f7f4',color:'#4f5e58',padding:'3px 8px',borderRadius:4,fontSize:11}}>Model: Fat-tailed Student's t (ν = 5)</span></div><div style={{marginTop:22,paddingTop:16,borderTop:'1px solid #edf0ec'}}><div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}><div><span className="eyebrow" style={{fontSize:10,letterSpacing:'0.05em'}}>DEPLETION RISK (PDF)</span><h3 style={{fontSize:13,fontWeight:600,color:'#173c34',margin:'2px 0 0 0'}}>Probability density function of portfolio depletion</h3></div><small style={{color:'#4f5e58',fontSize:11}}>{simulation.successRate>=0.999?'0% depletion risk across 40 years':`40-year depletion probability: ${((1-simulation.successRate)*100).toFixed(1)}%`}</small></div><div className="chart-container" style={{height:160}}><ResponsiveContainer width="100%" height="100%"><BarChart data={depletionPdfData}><CartesianGrid vertical={false} stroke="#eef0f0"/><XAxis dataKey="year" fontSize={10} tickLine={false}/><YAxis fontSize={10} tickFormatter={v=>`${(v*100).toFixed(0)}%`} width={35}/><Tooltip formatter={v=>[`${(Number(v)*100).toFixed(2)}%`,'Depletion probability']} labelFormatter={l=>`Year ${l}`}/><Bar isAnimationActive={false} dataKey="probability" name="Depletion probability" fill="#b6a4d7" radius={[2,2,0,0]}/></BarChart></ResponsiveContainer></div></div></>:!projectionReady?<Empty title="Give your future a starting point" description="Set annual spending or use your recorded trailing expenses, then choose a withdrawal assumption."/>:null}<p className="helper">5,000-iteration Monte Carlo simulation executing in a dedicated Web Worker using Student's t-distribution (ν = 5) with Float64Array typed buffers. Accounts for volatility drag, fat tails, and sequence-of-returns risk. It is separate from recorded account balances and is not a financial guarantee.</p></section><section className="card"><div className="section-title"><div><span className="eyebrow">CELEBRATE THE SMALL STEPS</span><h2>Milestone ladder</h2></div><button className="button" onClick={()=>{setGoal(true);setError('');}}><Plus size={12}/>Add goal</button></div>{goals?.length?goals.map(g=>{const goalCurrency=g.percentage!==undefined?currency:g.currency;const amount=g.percentage!==undefined&&fire.target?Math.round(g.percentage*fire.target):g.target;const baseAmount=convertMoney(amount,goalCurrency,currency,data.fxRates,today(),settings.currencyPrecision);return <div className="goal-row" key={g.id}><span className="milestone-dot">{baseAmount!==null&&baseAmount>0&&netWorth.fireAssets!==null&&netWorth.fireAssets>=baseAmount?'✓':'○'}</span><div><strong>{g.name}</strong><small>{g.percentage!==undefined?`${Math.round(g.percentage*100)}% of FIRE target`:g.targetDate||'Your own target'}</small></div><Money amount={amount||null} currency={goalCurrency}/><button className="icon-button" style={{fontSize:16}} aria-label={`Edit ${g.name}`} onClick={()=>setGoal(g)}>✎</button></div>; }):<Empty title="Make your milestones personal" description="Use the suggested ladder or choose your own targets. Percentages and amounts can be edited." action={<button className="button" onClick={useTemplates}>Use suggested milestones</button>}/>}</section></div>{edit&&<Dialog title="Your FIRE assumptions" onClose={()=>setEdit(false)}><form onSubmit={saveSettings}><div className="form-grid"><Field label="Annual spending basis"><select name="basis" defaultValue={settings.selectedAnnualSpendingBasis}><option value="MANUAL">My annual spending target</option><option value="TRAILING_12_MONTHS">Recorded trailing 12-month expenses</option></select></Field><Field label={`Annual spending (${currency})`}><input name="annual" type="number" min="0" step="any" defaultValue={fromMinor(settings.annualSpending,currency)} required/></Field><Field label="Withdrawal assumption (%)"><input name="withdrawal" type="number" min=".1" max="100" step=".1" defaultValue={settings.withdrawalRate*100} required/></Field><Field label={`Monthly contribution (${currency})`}><input name="contribution" type="number" min="0" step="any" defaultValue={fromMinor(settings.monthlyContribution,currency)} required/></Field><Field label="Assumed annual return (%)"><input name="return" type="number" min="-99" max="100" step=".1" defaultValue={settings.investmentReturnAssumption*100} required/></Field><Field label="Assumed inflation (%)"><input name="inflation" type="number" min="-20" max="100" step=".1" defaultValue={settings.inflationAssumption*100} required/></Field></div><p className="helper" style={{marginTop:15}}>Choose FIRE-eligible and emergency-designated accounts on Accounts. Mark essential categories in Settings. A withdrawal rate is your planning assumption.</p><ErrorMessage message={error}/><div className="dialog-actions"><button type="button" className="button" onClick={()=>setEdit(false)}>Cancel</button><button className="button primary">Save plan</button></div></form></Dialog>}{goal&&<Dialog title="Edit milestone" onClose={()=>setGoal(null)}><form onSubmit={saveGoal}><div className="form-grid"><Field label="Goal name"><input name="name" defaultValue={goal===true?'':goal.name} required/></Field><Field label="Percentage of FIRE target (optional)"><input name="percent" type="number" min="0" step=".1" defaultValue={goal===true?'':goal.percentage!==undefined?goal.percentage*100:''}/></Field><Field label={`Fixed target (${currency})`}><input name="target" type="number" min="0" step="any" defaultValue={goal===true?0:fromMinor(goal.target,goal.currency)}/></Field><Field label="Target date (optional)"><input name="date" type="date" defaultValue={goal===true?'':goal.targetDate}/></Field></div><ErrorMessage message={error}/><div className="dialog-actions">{goal!==true&&<button className="button danger" type="button" onClick={async()=>{await financeRepository.remove('goals',goal.id);setGoal(null);}}>Delete goal</button>}<button className="button primary">Save milestone</button></div></form></Dialog>}</>;
}
function reportAdd(left: number, right: number): number {
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) throw new FinanceValidationError('Report total exceeds supported monetary precision.');
  return sum;
}
function reportDates(from: string, to: string): string[] {
  const dates = [from], start = new Date(from + 'T12:00:00Z'), end = new Date(to + 'T12:00:00Z');
  if (end.getUTCFullYear() - start.getUTCFullYear() > 99) throw new Error('Choose a period of less than 100 years.');
  let year = start.getUTCFullYear(), month = start.getUTCMonth();
  for (let index = 0; index < 1200; index++) {
    const last = new Date(Date.UTC(year, month + 1, 0)).toISOString().slice(0, 10);
    if (last >= to) break;
    if (last > from) dates.push(last);
    month++; if (month === 12) { month = 0; year++; }
  }
  if (dates.at(-1) !== to) dates.push(to);
  return dates;
}
export function ReportsPage() {
  const data = useFinance(), defaultEnd = today();
  const presetStart = (months: number) => {
    const date = new Date(defaultEnd + 'T12:00:00'), start = new Date(date.getFullYear(), date.getMonth() - months + 1, 1);
    return start.getFullYear() + '-' + String(start.getMonth() + 1).padStart(2, '0') + '-01';
  };
  const [windowMonths, setWindowMonths] = useState(12);
  const [from, setFrom] = useState(() => presetStart(12)), [to, setTo] = useState(defaultEnd);
  const [accountId, setAccountId] = useState(''), [categoryId, setCategoryId] = useState('');
  const [nativeCurrency, setNativeCurrency] = useState(''), [tag, setTag] = useState(''), [investmentType, setInvestmentType] = useState('');
  const report = useLiveQuery(async () => {
    if (!data) return undefined;
    if (!validDate(from) || !validDate(to) || from > to || to > today()) return { ok: false, error: 'Choose valid dates ending on or before today.' } as const;
    try {
      const dates = reportDates(from, to), settings = data.settings;
      const instruments = await financeDb.instruments.filter(row => !row.deletedAt).toArray();
      const instrumentMap = new Map(instruments.map(row => [row.id, row])), accountMap = new Map(data.accounts.map(row => [row.id, row]));
      const selectedAccounts = data.accounts.filter(row => (!accountId || row.id === accountId) && (!nativeCurrency || row.currency === nativeCurrency));
      const acceptedAccounts = new Set(selectedAccounts.map(row => row.id));
      const categoryIds = categoryId ? categoryDescendants(categoryId, data.categories) : null, normalizedTag = tag.trim().toLowerCase();
      const months = new Map<string, { month: string; flow: ReturnType<typeof emptyFlow>; adjusted: ReturnType<typeof emptyFlow> }>();
      for (const date of dates) {
        const month = date.slice(0, 7);
        if (!months.has(month)) months.set(month, { month, flow: emptyFlow(), adjusted: emptyFlow() });
      }
      const categories = new Map<string, { value: number; complete: boolean }>(), merchants = new Map<string, { value: number; complete: boolean }>();
      const options = { from, to, currency: settings.baseCurrency, fxRates: data.fxRates, currencyPrecision: settings.currencyPrecision };
      let count = 0;
      await financeDb.transactions.where('date').between(from, to, true, true).each(transaction => {
        if (transaction.deletedAt || (accountId && transaction.accountId !== accountId && transaction.transferAccountId !== accountId)
          || (nativeCurrency && transaction.currency !== nativeCurrency) || (categoryIds && !categoryIds.has(transaction.categoryId ?? ''))
          || (normalizedTag && !transaction.tags?.some(value => value.toLowerCase() === normalizedTag))
          || (investmentType && instrumentMap.get(transaction.instrumentId ?? '')?.instrumentType !== investmentType)) return;
        count++;
        const bucket = months.get(transaction.date.slice(0, 7)); if (!bucket) return;
        const flow = calculateCashFlow([transaction], data.accounts, options); mergeFlow(bucket.flow, flow);
        const adjusted = settings.savingsRate?.excludeCategoryIds?.length
          ? calculateCashFlow([transaction], data.accounts, { ...options, excludeCategoryIds: settings.savingsRate.excludeCategoryIds }) : flow;
        mergeFlow(bucket.adjusted, adjusted);
        const sourceAccount = accountMap.get(transaction.accountId);
        if (['EXPENSE', 'FEE', 'REFUND'].includes(transaction.type) || (transaction.type === 'INTEREST' && sourceAccount && isLiability(sourceAccount))) {
          const id = transaction.categoryId ?? 'uncategorized', merchant = transaction.merchant || 'Unspecified';
          const category = categories.get(id) ?? { value: 0, complete: true }, payee = merchants.get(merchant) ?? { value: 0, complete: true };
          category.value = reportAdd(category.value, flow.knownExpenses); category.complete &&= flow.expenses !== null;
          payee.value = reportAdd(payee.value, flow.knownExpenses); payee.complete &&= flow.expenses !== null;
          categories.set(id, category); merchants.set(merchant, payee);
        }
      });
      const rows = [...months.values()].map(bucket => ({ month: bucket.month, income: bucket.flow.income, expenses: bucket.flow.expenses,
        net: bucket.flow.net, rate: calculateSavingsRate(bucket.adjusted, settings.savingsRate).rate }));
      const instrumentIds = instruments.map(row => row.id);
      // Acquisitions before the report period remain necessary to derive the cost basis.
      const [trades, prices] = instrumentIds.length ? await Promise.all([
        financeDb.transactions.where('instrumentId').anyOf(instrumentIds).filter(row => !row.deletedAt && row.date <= to && acceptedAccounts.has(row.accountId)).toArray(),
        financeDb.prices.where('instrumentId').anyOf(instrumentIds).filter(row => !row.deletedAt && Date.parse(row.asOf) <= Date.parse(to + 'T23:59:59.999Z')).toArray(),
      ]) : [[], []];
      const before = new Date(from + 'T00:00:00Z'); before.setUTCDate(before.getUTCDate() - 1);
      const initial = new Map(calculatePositions(trades, instruments, prices, { asOf: before.toISOString().slice(0, 10), currencyPrecision: settings.currencyPrecision })
        .map(position => [JSON.stringify([position.accountId, position.instrumentId]), position]));
      const positions = calculatePositions(trades, instruments, prices, { asOf: to, currencyPrecision: settings.currencyPrecision })
        .filter(position => !investmentType || instrumentMap.get(position.instrumentId)?.instrumentType === investmentType)
        .map(position => {
          const prior = initial.get(JSON.stringify([position.accountId, position.instrumentId]));
          return { ...position, realizedInPeriod: reportAdd(position.realizedGain, -(prior?.realizedGain ?? 0)),
            incomeInPeriod: reportAdd(position.income, -(prior?.income ?? 0)),
            returnInPeriod: position.totalReturn === null || prior?.totalReturn === null ? null : reportAdd(position.totalReturn, -(prior?.totalReturn ?? 0)) };
        });
      const deltas = dates.map(() => (Object.create(null) as Record<string, number>));
      await financeDb.postings.where('date').belowOrEqual(to).each(posting => {
        if (posting.deletedAt || !acceptedAccounts.has(posting.accountId)) return;
        let low = 0, high = dates.length;
        while (low < high) { const middle = Math.floor((low + high) / 2); if (dates[middle] < posting.date) low = middle + 1; else high = middle; }
        if (low < dates.length) deltas[low][posting.accountId] = reportAdd(deltas[low][posting.accountId] ?? 0, posting.delta);
      });
      const cumulative: Record<string, number> = Object.create(null); let endBalances: Record<string, number> = Object.create(null);
      const history = dates.map((date, index) => {
        for (const [id, delta] of Object.entries(deltas[index])) cumulative[id] = reportAdd(cumulative[id] ?? 0, delta);
        const balances: Record<string, number> = Object.create(null);
        for (const account of selectedAccounts) balances[account.id] = reportAdd(account.openingDate <= date ? (account.openingBalance ?? account.openingBalances?.[account.currency] ?? 0) : 0, cumulative[account.id] ?? 0);
        endBalances = balances;
        const holdings = calculatePositions(trades, instruments, prices, { asOf: date, currencyPrecision: settings.currencyPrecision });
        const totals = calculateNetWorthFromBalances(selectedAccounts, balances, holdings, data.fxRates, settings, date);
        return { date, netWorth: totals.netWorth, assets: totals.assets, liabilities: totals.liabilities };
      });
      return { ok: true as const, error: '', rows, count, categories: [...categories.entries()].sort((a, b) => b[1].value - a[1].value),
        merchants: [...merchants.entries()].sort((a, b) => b[1].value - a[1].value).slice(0, 20), positions, history,
        balances: endBalances, selectedAccounts, instruments };
    } catch (failure) { return { ok: false, error: (failure as Error).message } as const; }
  }, [data, from, to, accountId, categoryId, nativeCurrency, tag, investmentType]);
  if (!data) return <div className="loading">Reading reports…</div>;
  const currency = data.settings.baseCurrency, names = new Map(data.categories.map(row => [row.id, row.name]));
  const csv = (headers: string[], rows: unknown[][], name: string) => download([headers, ...rows].map(row => row.map(csvValue).join(',')).join('\r\n'), name, 'text/csv');
  const result = report?.ok ? report : undefined;
  const chartMonths = result?.rows.map(row => ({ ...row, income: row.income === null ? null : fromMinor(row.income, currency),
    expenses: row.expenses === null ? null : fromMinor(row.expenses, currency) })) ?? [];
  const chartHistory = result?.history.map(row => ({ ...row, value: row.netWorth === null ? null : fromMinor(row.netWorth, currency) })) ?? [];
  return <>
    <PageHeading eyebrow="TURN RECORDS INTO PERSPECTIVE" title="Your money tells a story" description="Choose a period and a view. Reports recalculate from your local ledger."
      action={<select aria-label="Report period" value={windowMonths} style={{ width: 150 }} onChange={event => {
        const months = Number(event.target.value); setWindowMonths(months); if (months) { setFrom(presetStart(months)); setTo(defaultEnd); }
      }}>{[1, 3, 6, 12].map(months => <option value={months} key={months}>Last {months} month{months > 1 ? 's' : ''}</option>)}<option value={0}>Custom dates</option></select>} />
    <section className="card page-section"><div className="form-grid">
      <Field label="From date"><input type="date" value={from} max={to} onChange={event => { setFrom(event.target.value); setWindowMonths(0); }} /></Field>
      <Field label="To date"><input type="date" value={to} min={from} max={today()} onChange={event => { setTo(event.target.value); setWindowMonths(0); }} /></Field>
      <Field label="Account"><select value={accountId} onChange={event => setAccountId(event.target.value)}><option value="">All accounts</option>{data.accounts.map(account => <option key={account.id} value={account.id}>{account.name}</option>)}</select></Field>
      <Field label="Category and children"><select value={categoryId} onChange={event => setCategoryId(event.target.value)}><option value="">All categories</option>{data.categories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}</select></Field>
      <Field label="Native currency"><select value={nativeCurrency} onChange={event => setNativeCurrency(event.target.value)}><option value="">All currencies</option>{[...new Set([...currencies, ...data.accounts.map(account => account.currency)])].map(value => <option key={value}>{value}</option>)}</select></Field>
      <Field label="Tag"><input value={tag} onChange={event => setTag(event.target.value)} placeholder="Exact transaction tag" /></Field>
      <Field label="Investment type"><select value={investmentType} onChange={event => setInvestmentType(event.target.value)}><option value="">All activity and holdings</option>{INSTRUMENT_TYPES.map(type => <option key={type} value={type}>{type.replaceAll('_', ' ')}</option>)}</select></Field>
    </div><p className="helper" style={{ marginTop: 15 }}>Cash-flow and spending views use every selected filter. Holdings use account, currency and investment type. Balances and net-worth history use dates, account and native currency.</p></section>
    <ErrorMessage message={report?.error || ''} />{!report && <div className="loading">Recalculating the selected records…</div>}
    {result && <>
      {!result.count && <div className="notice">No transactions match this period and its filters.</div>}
      <div className="grid-two page-section">
        <section className="card"><div className="section-title"><h2>Income versus expenses</h2><button className="button" onClick={() => csv(
          ['Month', 'Income minor', 'Expense minor', 'Currency', 'Complete'], result.rows.map(row => [row.month, row.income, row.expenses, currency, row.income !== null && row.expenses !== null]), 'tala-cashflow.csv'
        )}><Download size={12} />CSV</button></div><div className="chart-container"><ResponsiveContainer width="100%" height="100%"><BarChart data={chartMonths}>
          <CartesianGrid vertical={false} stroke="#edf0ec" /><XAxis dataKey="month" fontSize={10} /><YAxis width={45} fontSize={10} /><Tooltip />
          <Bar isAnimationActive={false} dataKey="income" name="Income" fill="#86ad93" radius={[3, 3, 0, 0]} /><Bar isAnimationActive={false} dataKey="expenses" name="Expenses" fill="#b6a4d7" radius={[3, 3, 0, 0]} /><Legend wrapperStyle={{ fontSize: 10 }} />
        </BarChart></ResponsiveContainer></div>{result.rows.some(row => row.income === null || row.expenses === null) && <p className="helper">Unavailable FX conversions appear as gaps. Add a dated rate to complete them.</p>}</section>
        <section className="card"><div className="section-title"><h2>Net-worth history</h2><button className="button" onClick={() => csv(
          ['Date', 'Net worth minor', 'Assets minor', 'Liabilities minor', 'Currency'], result.history.map(row => [row.date, row.netWorth, row.assets, row.liabilities, currency]), 'tala-net-worth.csv'
        )}><Download size={12} />CSV</button></div>{result.selectedAccounts.length ? <div className="chart-container"><ResponsiveContainer width="100%" height="100%"><AreaChart data={chartHistory}>
          <CartesianGrid vertical={false} stroke="#edf0ec" /><XAxis dataKey="date" fontSize={9} /><YAxis width={45} fontSize={10} /><Tooltip />
          <Area isAnimationActive={false} dataKey="value" name={'Net worth (' + currency + ')'} stroke="#83a28c" fill="#eef5ef" connectNulls={false} />
        </AreaChart></ResponsiveContainer></div> : <Empty title="No accounts in this view" />}<p className="helper">Monthly ledger valuations use original price and FX dates. Missing values stay unavailable.</p></section>
      </div>
      <div className="grid-two page-section">
        <section className="card"><div className="section-title"><h2>Spending by category</h2></div><table className="data-table"><thead><tr><th>Category</th><th>Spending ({currency})</th></tr></thead><tbody>
          {result.categories.map(([id, value]) => <tr key={id}><td>{names.get(id) || 'Uncategorized'}</td><td><Money amount={value.complete ? value.value : null} currency={currency} />{!value.complete && <small>Missing FX · known subtotal {formatMoney(value.value, currency)}</small>}</td></tr>)}
        </tbody></table>{!result.categories.length && <Empty title="No spending in this view" />}</section>
        <section className="card"><div className="section-title"><h2>Savings-rate history</h2></div><table className="data-table"><thead><tr><th>Month</th><th>Cash flow</th><th>Savings rate</th></tr></thead><tbody>
          {result.rows.map(row => <tr key={row.month}><td>{row.month}</td><td><Money amount={row.net} currency={currency} /></td><td>{row.rate === null ? '—' : (row.rate * 100).toFixed(1) + '%'}</td></tr>)}
        </tbody></table><p className="helper" style={{ marginTop: 14 }}>Uses your savings settings. Default: income minus consumption, divided by income. No income or an unknown required split leaves the rate undefined.</p></section>
      </div>
      <section className="card page-section"><div className="section-title"><h2>Investment performance</h2><button className="button" onClick={() => csv(
        ['Account', 'Instrument', 'Units at end', 'Cost basis minor', 'Market value minor', 'Period realized gain minor', 'Period income minor', 'Period return minor', 'Currency', 'Price as of', 'Stale'],
        result.positions.map(position => [position.accountId, position.instrumentId, position.units, position.costBasis, position.marketValue, position.realizedInPeriod, position.incomeInPeriod, position.returnInPeriod, position.currency, position.priceAsOf, position.stale]), 'tala-investments.csv'
      )}><Download size={12} />Investment CSV</button></div><div className="table-scroll"><table className="data-table"><thead><tr><th>Instrument</th><th>Units at end</th><th>Cost basis</th><th>Market value</th><th>Realized in period</th><th>Income in period</th><th>Return in period</th><th>Source date</th></tr></thead><tbody>
        {result.positions.map(position => <tr key={position.accountId + ':' + position.instrumentId}>
          <td>{result.instruments.find(instrument => instrument.id === position.instrumentId)?.name || position.instrumentId}<small>{position.currency} · {data.accounts.find(account => account.id === position.accountId)?.name}</small></td>
          <td>{position.units}</td><td><Money amount={position.costBasis} currency={position.currency} /></td><td><Money amount={position.marketValue} currency={position.currency} /></td>
          <td><Money amount={position.realizedInPeriod} currency={position.currency} /></td><td><Money amount={position.incomeInPeriod} currency={position.currency} /></td>
          <td><Money amount={position.returnInPeriod} currency={position.currency} /></td><td>{position.priceAsOf?.slice(0, 10) || 'No dated market valuation'}{position.stale && <small>Last valid price · stale</small>}</td>
        </tr>)}
      </tbody></table></div>{!result.positions.length && <Empty title="No holdings in this view" />}<p className="helper">Period return includes realized gains, the change in unrealized gains and recorded income. Earlier acquisitions preserve the correct average cost.</p></section>
      <div className="grid-two"><section className="card"><h2>Spending by merchant</h2><table className="data-table"><tbody>{result.merchants.map(([name, value]) => <tr key={name}><td>{name}</td><td><Money amount={value.complete ? value.value : null} currency={currency} /></td></tr>)}</tbody></table>{!result.merchants.length && <Empty title="No merchants in this view" />}</section>
        <section className="card"><h2>Balances at report end</h2><table className="data-table"><tbody>{result.selectedAccounts.map(account => <tr key={account.id}><td>{account.name}<small>{account.currency} · {to}</small></td><td><Money amount={result.balances[account.id]} currency={account.currency} /></td></tr>)}</tbody></table></section></div>
    </>}
  </>;
}
export function SettingsPage(){const data=useFinance(),[category,setCategory]=useState<Category|true|null>(null),[merge,setMerge]=useState(false),[fx,setFx]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);const rates=useLiveQuery(()=>financeDb.fxRates.filter(r=>!r.deletedAt).toArray(),[]),gateway=useLiveQuery(()=>financeRepository.getSetting('marketGateway',''),[]);if(!data)return <div className="loading">Reading settings…</div>;const {settings}=data;
 async function saveCategory(e:FormEvent<HTMLFormElement>){e.preventDefault();const fd=new FormData(e.currentTarget);try{const old=category&&category!==true?category:undefined;await financeRepository.save('categories',{...old,id:old?.id||crypto.randomUUID(),name:String(fd.get('name')),kind:String(fd.get('kind')) as Category['kind'],parentId:String(fd.get('parent')||'')||undefined,color:String(fd.get('color')),essential:fd.has('essential'),archived:fd.has('archived')});setCategory(null);}catch(e){setError((e as Error).message);}}
 async function saveFx(e:FormEvent<HTMLFormElement>){e.preventDefault();const fd=new FormData(e.currentTarget);try{await financeRepository.save('fxRates',{id:crypto.randomUUID(),fromCurrency:String(fd.get('from')),toCurrency:settings.baseCurrency,rate:Number(fd.get('rate')),asOf:String(fd.get('date')),source:String(fd.get('source'))});setFx(false);}catch(e){setError((e as Error).message);}}
 return <><PageHeading eyebrow="MAKE IT WORK FOR YOU" title="Your preferences, your picture" description="Currencies, categories and valuation sources stay editable. Planning assumptions belong on your FIRE journey."/><ErrorMessage message={error}/>{message&&<p className="notice" role="status">{message}</p>}<div className="grid-two page-section"><section className="card"><h2>Financial preferences</h2><div className="setting-list" style={{marginTop:22}}><div className="setting-row"><div><strong>Base currency</strong><p>Foreign balances require a dated conversion rate.</p></div><select aria-label="Base currency" value={settings.baseCurrency} onChange={async e=>{const value=e.target.value;await financeRepository.setSetting('finance',{...settings,baseCurrency:value,annualSpending:0,monthlyContribution:0});setMessage('Base currency changed. Set spending and contribution targets in the new currency. Existing account values keep their own currencies.');}}>{currencies.map(c=><option key={c}>{c}</option>)}</select></div><div className="setting-row"><div><strong>Savings calculation</strong><p>The default excludes transfers and investment purchases.</p></div><span className="badge">Income − spending / income</span></div><label className="checkbox-row"><input type="checkbox" checked={settings.savingsRate?.includeDebtPrincipal||false} onChange={e=>financeRepository.setSetting('finance',{...settings,savingsRate:{...settings.savingsRate,includeDebtPrincipal:e.target.checked}})}/>Include debt principal payments in savings-rate expenses</label><label className="checkbox-row"><input type="checkbox" checked={settings.savingsRate?.includeInvestmentFees||false} onChange={e=>financeRepository.setSetting('finance',{...settings,savingsRate:{...settings.savingsRate,includeInvestmentFees:e.target.checked}})}/>Include investment trade fees in savings-rate expenses</label><p className="helper">Account flags control total, liquid and FIRE-eligible wealth. These preferences do not change recorded transaction amounts.</p></div></section><section className="card"><div className="section-title"><h2>Currency reference rates</h2><button className="button" onClick={()=>{setFx(true);setError('');}}><Plus size={12}/>Manual rate</button></div><button className="button" disabled={busy} onClick={async()=>{setBusy(true);setError('');try{const r=await refreshFx(settings.baseCurrency);setMessage(`Stored ${r.count} free reference rates dated ${r.asOf.slice(0,10)}.`);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}}><RefreshCw size={13}/>Refresh free daily FX</button><p className="helper" style={{margin:'12px 0'}}>Reference source: <a className="source-link" href="https://www.exchangerate-api.com/docs/free" target="_blank" rel="noreferrer">ExchangeRate-API open daily data ↗</a>. Enter bank/BSP statement rates manually when appropriate. This app does not infer transaction-specific FX.</p><div className="table-scroll"><table className="data-table"><thead><tr><th>Pair</th><th>Rate</th><th>As of</th></tr></thead><tbody>{rates?.sort((a,b)=>b.asOf.localeCompare(a.asOf)).slice(0,15).map(r=><tr key={r.id}><td>{r.fromCurrency} → {r.toCurrency}</td><td>{r.rate.toFixed(6)}</td><td>{r.asOf.slice(0,10)}<small>{r.source}</small></td></tr>)}</tbody></table></div></section></div><section className="card page-section"><div className="section-title"><h2>Categories, made personal</h2><div className="toolbar-actions"><button className="button" onClick={()=>setMerge(true)}>Merge categories</button><button className="button primary" onClick={()=>{setCategory(true);setError('');}}><Plus size={12}/>Add category</button></div></div><div className="table-scroll"><table className="data-table"><thead><tr><th>Category</th><th>Parent</th><th>Kind</th><th>Essential</th><th>Status</th><th/></tr></thead><tbody>{data.categories.map(c=><tr key={c.id}><td><i style={{display:'inline-block',width:8,height:8,background:c.color,borderRadius:5,marginRight:8}}/>{c.name}</td><td>{data.categories.find(p=>p.id===c.parentId)?.name||'—'}</td><td>{c.kind}</td><td>{c.essential?'Yes':'No'}</td><td>{c.archived?'Archived':'Active'}</td><td><button className="button" onClick={()=>setCategory(c)}>Edit</button></td></tr>)}</tbody></table></div></section><section className="card"><h2>Market-data gateway</h2><form className="inline-form" style={{marginTop:15}} onSubmit={async e=>{e.preventDefault();try{const value=String(new FormData(e.currentTarget).get('url')||'').trim();if(value){const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash)throw new Error('Use a public HTTPS gateway URL without credentials.');}await financeRepository.setSetting('marketGateway',value);setMessage('Market gateway saved. Only instrument identifiers are sent for quote requests.');}catch(e){setError((e as Error).message);}}}><Field label="Public gateway URL (optional)"><input name="url" type="url" defaultValue={gateway||''} placeholder="https://your-gateway.example"/></Field><button className="button">Save source</button></form><p className="helper" style={{marginTop:12}}>A GitHub Pages site has no server for private API keys. Configure a separate approved gateway for Philippine quotes. The local preview can use the included free adapter; all finance records remain usable without it.</p></section>{category&&<Dialog title="Edit category" onClose={()=>setCategory(null)}><form onSubmit={saveCategory}><div className="form-grid"><Field label="Category name"><input name="name" defaultValue={category===true?'':category.name} required autoFocus/></Field><Field label="Kind"><select name="kind" defaultValue={category===true?'expense':category.kind}><option value="expense">Expense</option><option value="income">Income</option></select></Field><Field label="Parent (optional)"><select name="parent" defaultValue={category===true?'':category.parentId}><option value="">Top-level category</option>{data.categories.filter(c=>category===true||c.id!==category.id).map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></Field><Field label="Color"><input name="color" type="color" defaultValue={category===true?'#8daa8b':category.color}/></Field><label className="checkbox-row"><input name="essential" type="checkbox" defaultChecked={category!==true&&category.essential}/>Essential expense</label><label className="checkbox-row"><input name="archived" type="checkbox" defaultChecked={category!==true&&category.archived}/>Archive category</label></div><ErrorMessage message={error}/><div className="dialog-actions"><button className="button primary">Save category</button></div></form></Dialog>}{merge&&<Dialog title="Merge categories" onClose={()=>setMerge(false)}><form onSubmit={async e=>{e.preventDefault();const fd=new FormData(e.currentTarget),from=String(fd.get('from')),to=String(fd.get('to'));try{if(from===to)throw new Error('Choose two different categories.');await financeDb.transaction('rw',financeDb.tables,async()=>{const records=await financeDb.transactions.where('categoryId').equals(from).filter(t=>!t.deletedAt).toArray();for(const tx of records)await financeRepository.saveTransaction({...tx,categoryId:to});for(const budget of await financeDb.budgets.where('categoryId').equals(from).toArray())await financeRepository.save('budgets',{...budget,categoryId:to});for(const child of await financeDb.categories.where('parentId').equals(from).toArray())await financeRepository.save('categories',{...child,parentId:to});const old=await financeDb.categories.get(from);if(old)await financeRepository.save('categories',{...old,archived:true});});setMerge(false);}catch(e){setError((e as Error).message);}}}><p className="helper">Transactions and budgets will use the destination category; the source category will be archived.</p><div className="form-grid" style={{marginTop:15}}>{['from','to'].map(name=><Field key={name} label={name==='from'?'Merge this category':'Into this category'}><select name={name}>{data.categories.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>)}</div><ErrorMessage message={error}/><div className="dialog-actions"><button className="button primary">Merge records</button></div></form></Dialog>}{fx&&<Dialog title="Add a dated FX rate" onClose={()=>setFx(false)}><form onSubmit={saveFx}><div className="form-grid"><Field label="From currency"><select name="from">{currencies.filter(c=>c!==settings.baseCurrency).map(c=><option key={c}>{c}</option>)}</select></Field><Field label={`1 foreign unit equals how many ${settings.baseCurrency}?`}><input name="rate" type="number" min=".000000001" step="any" required/></Field><Field label="Reference date"><input name="date" type="date" max={today()} defaultValue={today()} required/></Field><Field label="Source / bank / BSP reference"><input name="source" required defaultValue="Manual reference"/></Field></div><ErrorMessage message={error}/><div className="dialog-actions"><button className="button primary">Save reference rate</button></div></form></Dialog>}</>;
}
