import { Link } from 'react-router-dom';
import { useEffect } from 'react';
import { ArrowUpRight, Wallet, Target, TrendingUp, ArrowDownLeft, ChevronRight, ShieldCheck, Plus } from 'lucide-react';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid, PieChart, Pie, Cell } from 'recharts';
import { useLiveQuery } from 'dexie-react-hooks';
import { financeDb } from '../db/database';
import { financeRepository } from '../db/repository';
import { useFinance } from '../ui/useFinance';
import { Money, PageHeading, formatMoney, minorToMajor, today } from '../ui/shared';
import { EmptyState } from '../components/EmptyState';
import { TrendIndicator } from '../components/TrendIndicator';

const colors=['#74948c','#b7a4dc','#d9b76c','#7db1bd','#abb99c','#e1a19e'];

export function Overview(){
  const data=useFinance();
  const goals=useLiveQuery(()=>financeDb.goals.filter(s=>!s.deletedAt).toArray(),[]);

  useEffect(()=>{
    if(!data?.accounts.length||!data.netWorth.complete||data.netWorth.netWorth===null)return;
    const {netWorth,settings}=data;
    const id=`snapshot:${today()}:${settings.baseCurrency}`;
    void financeDb.balanceSnapshots.get(id).then(old=>{
      if(old?.netWorth===netWorth.netWorth&&old?.assets===netWorth.assets&&old?.liabilities===netWorth.liabilities)return;
      return financeRepository.save('balanceSnapshots',{
        id,
        date:today(),
        netWorth:netWorth.netWorth!,
        assets:netWorth.assets!,
        liabilities:netWorth.liabilities!,
        currency:settings.baseCurrency,
        notes:'Recorded local ledger valuation'
      });
    }).catch(()=>{});
  },[data?.netWorth.netWorth,data?.netWorth.assets,data?.netWorth.liabilities,data?.netWorth.complete,data?.settings.baseCurrency,data?.accounts.length]);

  if(!data)return <div className="loading">Opening your local financial ledger…</div>;
  const {settings,netWorth,fire,accounts,current,savings}=data,currency=settings.baseCurrency,hasAccounts=accounts.length>0;
  const allocation=netWorth.accountValues.filter(a=>(a.baseValue||0)>0&&!['CREDIT_CARD','PERSONAL_LOAN','MORTGAGE','OTHER_LIABILITY'].includes(accounts.find(acc=>acc.id===a.accountId)?.accountType||'')).map(a=>({name:accounts.find(acc=>acc.id===a.accountId)?.name||'Account',value:a.baseValue||0}));
  const recent=data.history.map(p=>({...p,income:p.incomeComplete?minorToMajor(p.income,currency):null,expenses:p.expensesComplete?minorToMajor(p.expenses,currency):null}));

  return (
    <>
      <PageHeading
        eyebrow="YOUR FINANCIAL HOME"
        title="A little clarity. A bigger future"
        description="Your money, your milestones, your pace."
        action={
          <div style={{ display: 'flex', gap: '15px', alignItems: 'center' }}>
            <select aria-label="Base currency" value={currency} onChange={async e=>{const value=e.target.value;await financeRepository.setSetting('finance',{...settings,baseCurrency:value});}} style={{ padding: '4px 8px', borderRadius: '4px', border: '1px solid #d1d5db', background: 'transparent' }}>
              {['PHP','USD','EUR','GBP','JPY','HKD','CAD','AUD','SGD'].map(c=><option key={c}>{c}</option>)}
            </select>
            <span className="date-label">
              {new Date(today()+'T12:00:00').toLocaleDateString('en-PH',{day:'numeric',month:'long',year:'numeric'})}
              <small>Saved on this device</small>
            </span>
          </div>
        }
      />
      {!hasAccounts && (
        <div className="welcome-banner">
          <div>
            <strong>Start with what you own and what you owe.</strong>
            <p>Add an account, then record income, expenses and transfers. Every card updates from your local ledger.</p>
          </div>
          <Link
            className="button primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-tala-green focus-visible:ring-offset-2"
            to="/accounts"
          >
            <Plus size={16}/>Add your first account
          </Link>
        </div>
      )}
      {!netWorth.complete && (
        <div className="notice warning">
          Some valuations need a price or currency rate. Totals stay incomplete until those values are supplied.{' '}
          <Link to="/investments" className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-tala-green">
            Review investments
          </Link>
        </div>
      )}
      <div className="metric-grid">
        <article className="metric-card worth-card">
          <div className="metric-label">TOTAL NET WORTH<Wallet size={18}/></div>
          <strong className="metric-value"><Money amount={hasAccounts?netWorth.netWorth:null} currency={currency}/></strong>
          <div className="metric-foot"><span>Assets minus liabilities</span><ArrowUpRight size={17}/></div>
          <div className="card-watermark">✳</div>
        </article>
        <article className="metric-card">
          <div className="metric-label">FIRE TARGET<Target size={18}/></div>
          <strong className="metric-value"><Money amount={fire.target} currency={currency}/></strong>
          <div className="metric-foot">{data.annual?`${(settings.withdrawalRate*100).toFixed(1)}% withdrawal assumption`:'Set your annual spending'}</div>
          <Link to="/fire" className="metric-link focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-tala-green">
            Make it your own<ChevronRight size={14}/>
          </Link>
        </article>
        <article className="metric-card fire-card">
          <div className="metric-label">FIRE PROGRESS<TrendingUp size={18}/></div>
          <strong className="metric-value">{fire.progress===null?'—':`${(fire.progress*100).toFixed(1)}%`}</strong>
          <div className="progress-track"><span style={{width:`${Math.min(100,Math.max(0,(fire.progress||0)*100))}%`}}/></div>
          <div className="metric-foot">Eligible assets toward your target</div>
        </article>
        <article className="metric-card savings-card">
          <div className="metric-label">AVERAGE SAVINGS RATE<ArrowDownLeft size={18}/></div>
          <strong className="metric-value">{savings===null?'—':`${(savings*100).toFixed(1)}%`}</strong>
          <div className="metric-foot">Months with income · trailing 12 months</div>
          <div className="small-note">Income − spending / income</div>
        </article>
      </div>
      <div className="mini-stat-row">
        <div><span>Assets</span><strong><Money amount={hasAccounts?netWorth.assets:null} currency={currency}/></strong></div>
        <div><span>Liabilities</span><strong><Money amount={hasAccounts?netWorth.liabilities:null} currency={currency}/></strong></div>
        <div>
          <span>This month’s cash flow</span>
          <strong>
            <TrendIndicator
              value={data.count && current.complete ? current.income - current.expenses : null}
              currency={currency}
            />
          </strong>
        </div>
        <div><span>Emergency runway</span><strong>{fire.emergencyMonths===null?'—':`${fire.emergencyMonths.toFixed(1)} months`}</strong></div>
      </div>
      <div className="dashboard-grid">
        <section className="card">
          <div className="section-title">
            <div><span className="eyebrow">A STEADIER PERSPECTIVE</span><h2>Your cash flow</h2></div>
            <Link to="/reports" className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-tala-green">
              View reports<ArrowUpRight size={15}/>
            </Link>
          </div>
          <div className="chart-key">
            <span><i style={{background:'#1f664a'}}/>Income</span>
            <span><i style={{background:'#6d549e'}}/>Expenses</span>
            <small>Transfers excluded</small>
          </div>
          {data.count ? (
            <div className="chart-container">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={recent}>
                  <defs>
                    <linearGradient id="incomeFade" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#1f664a" stopOpacity={0.25}/>
                      <stop offset="100%" stopColor="#1f664a" stopOpacity={0}/>
                    </linearGradient>
                  </defs>
                  <CartesianGrid vertical={false} stroke="#eceef0"/>
                  <XAxis dataKey="month" tickFormatter={v=>new Date(v+'-15').toLocaleDateString('en',{month:'short'})} tickLine={false} axisLine={false} fontSize={11}/>
                  <YAxis tickFormatter={v=>v>=1000?`${(v/1000).toLocaleString()}k`:v} tickLine={false} axisLine={false} fontSize={11} width={45}/>
                  <Tooltip formatter={(v)=>new Intl.NumberFormat('en',{style:'currency',currency}).format(Number(v))}/>
                  <Area isAnimationActive={false} dataKey="income" name="Income" stroke="#1f664a" fill="url(#incomeFade)" strokeWidth={2}/>
                  <Area isAnimationActive={false} dataKey="expenses" name="Expenses" stroke="#6d549e" fill="transparent" strokeWidth={2}/>
                </AreaChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <EmptyState
              view="transactions"
              action={
                <Link
                  to="/transactions?new=1"
                  className="text-link focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-tala-green focus-visible:ring-offset-2"
                >
                  Record a transaction <ArrowUpRight size={15}/>
                </Link>
              }
            />
          )}
        </section>
        <section className="card">
          <div className="section-title">
            <div><span className="eyebrow">EVERY PIECE HAS A PLACE</span><h2>Asset allocation</h2></div>
            <Link to="/investments" className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-tala-green">
              <ArrowUpRight size={17}/>
            </Link>
          </div>
          {allocation.length ? (
            <>
              <div className="allocation-chart">
                <ResponsiveContainer width="100%" height={180}>
                  <PieChart>
                    <Pie isAnimationActive={false} data={allocation} dataKey="value" innerRadius={58} outerRadius={78} strokeWidth={4}>
                      {allocation.map((_,i)=><Cell key={i} fill={colors[i%colors.length]}/>)}
                    </Pie>
                    <Tooltip formatter={v=>formatMoney(Number(v),currency)}/>
                  </PieChart>
                </ResponsiveContainer>
                <span><small>Total assets</small><strong><Money amount={netWorth.assets} currency={currency}/></strong></span>
              </div>
              <div className="allocation-legend">
                {allocation.slice(0,6).map((a,i)=>(
                  <div key={a.name}>
                    <i style={{background:colors[i%colors.length]}}/>
                    <span>{a.name}</span>
                    <strong>{(a.value/allocation.reduce((s,p)=>s+p.value,0)*100).toFixed(1)}%</strong>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <EmptyState
              view="investments"
              title="A place for every asset"
              description="Cash, investments, MP2, retirement accounts and property can all belong in your financial picture."
            />
          )}
        </section>
        <section className="card milestone-card">
          <div className="section-title">
            <div><span className="eyebrow">ONE STEP AT A TIME</span><h2>Your milestone ladder</h2></div>
            <Link to="/fire" className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-tala-green">
              Edit goals<ArrowUpRight size={15}/>
            </Link>
          </div>
          {goals?.length ? (
            <div className="milestones">
              {goals.map((goal,i)=>{
                const target=goal.percentage===undefined?goal.target:fire.target!==null?Math.round(fire.target*goal.percentage):null;
                const goalCurrency=goal.percentage===undefined?goal.currency:currency;
                const achieved=goalCurrency===currency&&target!==null&&netWorth.fireAssets!==null&&netWorth.fireAssets>=target;
                return (
                  <div key={goal.id} className={achieved?'achieved':''}>
                    <span className="milestone-dot">{achieved?'✓':i+1}</span>
                    <div>
                      <strong>{goal.name}</strong>
                      <small>{goal.percentage===undefined?'Your chosen milestone':`${Math.round(goal.percentage*100)}% of your FIRE target`}</small>
                    </div>
                    <Money amount={target} currency={goalCurrency}/>
                  </div>
                );
              })}
            </div>
          ) : (
            <EmptyState
              view="fire"
              title="Your next milestone is yours to choose"
              description="Add a target or start with editable FIRE milestone templates."
              action={
                <Link
                  to="/fire"
                  className="text-link focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-tala-green focus-visible:ring-offset-2"
                >
                  Set your milestones
                </Link>
              }
            />
          )}
        </section>
        <section className="card">
          <div className="section-title">
            <div><span className="eyebrow">THE ACCOUNTS BEHIND THE NUMBERS</span><h2>Your financial foundation</h2></div>
            <Link to="/accounts" className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-tala-green">
              All accounts<ArrowUpRight size={15}/>
            </Link>
          </div>
          {accounts.length ? (
            <div className="account-preview">
              {accounts.filter(a=>!a.archived).slice(0,5).map((a,i)=>(
                <Link
                  key={a.id}
                  to="/accounts"
                  className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-tala-green"
                >
                  <span className="account-avatar" style={{background:colors[i%colors.length]+'25',color:colors[i%colors.length]}}>
                    {a.name.slice(0,2).toUpperCase()}
                  </span>
                  <div>
                    <strong>{a.name}</strong>
                    <small>{a.accountType.replaceAll('_',' ')} · {a.currency}</small>
                  </div>
                  <Money
                    amount={data.balances[a.id]?.[a.currency] ?? a.openingBalances?.[a.currency] ?? a.openingBalance ?? 0}
                    currency={a.currency}
                  />
                </Link>
              ))}
            </div>
          ) : (
            <EmptyState
              view="accounts"
              title="Keep your whole picture together"
              description="Add bank accounts, e-wallets, investments and debts. You choose what counts toward FIRE."
              action={
                <Link
                  to="/accounts"
                  className="text-link focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-tala-green focus-visible:ring-offset-2"
                >
                  Add your first account
                </Link>
              }
            />
          )}
          <div className="privacy-note">
            <ShieldCheck size={16}/>
            <p>Your ledger stays on this device. Cloud sync is optional, and remains off until you enable it.</p>
          </div>
        </section>
      </div>
    </>
  );
}
