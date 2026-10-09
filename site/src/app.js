import { MarketApi, requestJson, validateApiUrl, normalizeStockSymbol } from './api.js';
import { readStorage, writeStorage, saveCache } from './cache.js';
import { number, percent, signed, direction, arrow, compact, date, timestamp, freshness, csvCell, currencyNumber } from './format.js';
import { drawChart, sparkline } from './chart.js';
import { DEFAULT_CONNECTION } from './config.js';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const SETTINGS='psedash:settings:v3',WATCH='psedash:watchlist:v1',PINNED='psedash:instruments:v1';
const MARKET_KEY='psedash:market:v1';
const markets={PH:{name:'Philippines',currency:'PHP',timeZone:'Asia/Manila',example:'AREIT, DNL, SPNEC'},US:{name:'United States',currency:'USD',timeZone:'America/New_York',example:'AAPL, MSFT, NVDA'},HK:{name:'Hong Kong',currency:'HKD',timeZone:'Asia/Hong_Kong',example:'0700, 9988'},JP:{name:'Japan',currency:'JPY',timeZone:'Asia/Tokyo',example:'7203, 6758'},GB:{name:'United Kingdom',currency:'GBP',timeZone:'Europe/London',example:'VOD, HSBA'},CA:{name:'Canada',currency:'CAD',timeZone:'America/Toronto',example:'SHOP, RY'},AU:{name:'Australia',currency:'AUD',timeZone:'Australia/Sydney',example:'BHP, CBA'}};
let selectedMarket=readStorage(MARKET_KEY,'PH');if(!markets[selectedMarket]&&selectedMarket!=='ALL')selectedMarket='PH';
const marketSeeds=new Map(),marketErrors=new Map(),marketSources=new Map();
const quoteMutations=new Map();let quoteRevision=0;
const validStoredSymbol=s=>typeof s==='string'&&/^(?:(?:US|HK|JP|GB|CA|AU):)?[A-Z0-9][A-Z0-9.-]{0,14}$/.test(s);
const defaults={...DEFAULT_CONNECTION};
const legacySettings=readStorage('psedash:settings:v1');
const previousSettings=readStorage('psedash:settings:v2');
const savedSettings=readStorage(SETTINGS,['gateway','demo'].includes(previousSettings?.mode)?previousSettings:legacySettings?.mode==='gateway'?legacySettings:defaults);
let settings={...defaults,...savedSettings};
if(!['unconfigured','demo','gateway'].includes(settings.mode))settings={...defaults};
if(settings.mode==='gateway'){try{settings.apiBase=validateApiUrl(settings.apiBase);}catch{settings={...defaults};}}
let api=new MarketApi(settings),catalog=[],seedCatalog=[],snapshot=null,cached=false,selected='PSEI',range='1m',view='overview',tableView='stocks',sort={key:'symbol',order:1},points=[],historyInfo=null;
let pinned=readStorage(PINNED,[]);if(!Array.isArray(pinned))pinned=[];
pinned=pinned.filter(q=>q&&validStoredSymbol(q.symbol)&&['stock','etf'].includes(q.assetType)).slice(0,100);
let watchlist=readStorage(WATCH,['BDO','AC','ICT','JFC','SM']);
if(!Array.isArray(watchlist))watchlist=['BDO','AC','ICT','JFC','SM'];
watchlist=[...new Set(watchlist.filter(s=>validStoredSymbol(s)&&s!=='PSEI'))].slice(0,100);
let timer,toastTimer,inFlight=false,version=0,historyVersion=0,delay=60_000,searchIndex=-1,searchMatches=[];
let resizeTimer,addSearchTimer,addSearchVersion=0,mainSearchTimer,mainSearchVersion=0,marketVersion=0,queuedRefresh=false,localAvailable=false,freeAvailable=false,freeApiBase='',freeSource='PSE EDGE';
const names={overview:'Overview',stocks:'Stocks',funds:'Mutual funds',etfs:'ETFs',watchlist:'My watchlist'};
const viewTitles={overview:['Your market, in focus','A clearer view of stocks, funds, and everything in between.'],stocks:['A closer look at stocks','Follow the companies shaping the Philippine market.'],funds:['A longer perspective','Compare daily fund valuations, one banking day at a time.'],etfs:['One fund. A broader view','Explore exchange-traded prices and separately valued NAVs.'],watchlist:['Your own perspective','The instruments you follow, saved in this browser.']};
function node(tag,cls,text){const el=document.createElement(tag);if(cls)el.className=cls;if(text!==undefined)el.textContent=text;return el;}
function icon(name){const el=document.createElementNS('http://www.w3.org/2000/svg','svg');el.setAttribute('class','icon');el.setAttribute('aria-hidden','true');const use=document.createElementNS(el.namespaceURI,'use');use.setAttribute('href',`#i-${name}`);el.append(use);return el;}
function toast(message){$('#toast').textContent=message;$('#toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').hidden=true,3200);}
function syncNavigation(){const sidebar=$('.sidebar');sidebar.inert=matchMedia('(max-width:760px)').matches&&!sidebar.classList.contains('is-open');}
function setNavOpen(open){const restore=!open&&matchMedia('(max-width:760px)').matches&&$('.sidebar').contains(document.activeElement);$('.sidebar').classList.toggle('is-open',open);$('#menu-toggle').setAttribute('aria-expanded',open);syncNavigation();if(restore)$('#menu-toggle').focus();}
function marketOf(q){const symbol=typeof q==='string'?q:q?.symbol;return markets[q?.market]?q.market:symbol?.includes(':')?symbol.split(':')[0]:'PH';}
function marketMeta(q){return markets[marketOf(q)]||markets.PH;}
function inSelectedMarket(q){return selectedMarket==='ALL'?watchlist.includes(q.symbol):marketOf(q)===selectedMarket;}
function quoteTime(q){return q?.timestampPrecision==='date'?date(q.marketDate||q.asOf,{year:'numeric'})+' · market date':timestamp(q?.asOf,q?.timeZone||marketMeta(q).timeZone);}
function stockSearchQuery(query,market){return query.trim().replace(new RegExp(`^${market}:`,'i'),'');}
function mergeCatalog(items){catalog=[...new Map([...catalog,...items].map(q=>[q.symbol,q])).values()];}
function requestedInstruments(){const activeSeeds=selectedMarket==='PH'||selectedMarket==='ALL'?[]:marketSeeds.get(selectedMarket)||[];const merged=new Map([...seedCatalog,...activeSeeds,...pinned,...watchlist.map(symbol=>catalog.find(q=>q.symbol===symbol)||{symbol,name:symbol,market:marketOf(symbol),assetType:'stock',currency:marketMeta(symbol).currency,timeZone:marketMeta(symbol).timeZone,verified:false})].map(q=>[q.symbol,catalog.find(i=>i.symbol===q.symbol)||q]));return [...merged.values()];}
function quoteInstruments(){return requestedInstruments().filter(q=>{const market=marketOf(q);if(market!=='PH')return selectedMarket==='ALL'||market===selectedMarket;return settings.mode!=='gateway'||!api.instruments||api.instruments.instruments.some(i=>i.symbol===q.symbol);});}
function placeholder(q){return {...q,currency:q.currency||marketMeta(q).currency,timeZone:q.timeZone||marketMeta(q).timeZone,value:null,valueType:'last_trade',previousClose:null,change:null,changePercent:null,volume:null,asOf:null,marketDate:null,freshness:'unavailable',source:settings.mode==='unconfigured'?'Data not connected':settings.mode==='demo'?'No sample quote':'No quote available'};}
function allInstruments(){const merged=new Map([...requestedInstruments().map(placeholder),...(snapshot?.quotes || [])].map(q=>[q.symbol,q]));return [...merged.values(),...(snapshot?.funds || []).map(f=>({...f,assetType:'mutual_fund',symbol:f.id}))];}
function instrument(id){return id===null?{symbol:'',name:'Add or select a stock to view its price and history',market:selectedMarket==='ALL'?'PH':selectedMarket,assetType:'market',currency:markets[selectedMarket]?.currency,value:null}:id==='PSEI' ? snapshot?.index || {symbol:'PSEI',name:'Philippine Stock Exchange Index',market:'PH',assetType:'index',valueType:'index_level'} : allInstruments().find(q=>q.symbol===id) || catalog.find(q=>q.symbol===id) || null;}
function isFund(q){return q?.assetType==='mutual_fund';}
function valueLabel(q){const currency=q?.currency||marketMeta(q).currency;return isFund(q) ? `${q.valueType} · ${currency}` : q?.assetType==='index' ? 'Index points' : ['daily_close','close'].includes(q?.valueType)||q?.freshness==='eod'?`Daily close · ${currency}`:['snapshot','suspended'].includes(q?.freshness)||/suspended/i.test(q?.tradingStatus||'')?`Last available · ${currency}`:`Last traded · ${currency}`;}
function isFreeConnection(){return settings.mode==='gateway'&&!!freeApiBase&&settings.apiBase===freeApiBase;}
function currentFreeSource(){if(selectedMarket==='PH')return snapshot?.index?.source||snapshot?.quotes?.find(q=>marketOf(q)==='PH'&&q.source)?.source||api.instruments?.source||freeSource;const sources=[...new Set((snapshot?.quotes||[]).filter(inSelectedMarket).map(q=>q.source).filter(Boolean))];return sources.join(' / ')||(selected!==null&&marketOf(instrument(selected))===selectedMarket?historyInfo?.source:null)||'International public source';}
function freeCoverageNote(){if(!['PH','ALL'].includes(selectedMarket))return '';const coverage=snapshot?.coverage||api.instruments?.coverage;return coverage?.type==='mirror'&&Number.isInteger(coverage.count)?`Mirror coverage: ${coverage.count} listed Philippine stocks. Symbols outside this fallback remain unavailable.`:'';}
function freeStockUnavailable(symbol){return `The free source has no quote for ${symbol}. ${freeCoverageNote()||'Try another data source for this symbol.'}`;}
function renderFreeReference(){const quote=selectedMarket==='PH'?snapshot?.index||snapshot?.quotes?.find(q=>marketOf(q)==='PH'&&q.sourceUrl):snapshot?.quotes?.find(q=>inSelectedMarket(q)&&q.sourceUrl),link=$('#free-source-reference a'),original=$('#free-original-source');let sourceUrl=selectedMarket==='PH'?'https://edge.pse.com.ph/':'https://finance.yahoo.com/',originalUrl='https://edge.pse.com.ph/';try{const url=new URL(quote?.sourceUrl||sourceUrl);if(url.protocol==='https:'&&['edge.pse.com.ph','raw.githubusercontent.com','github.com','maxgfr.github.io','finance.yahoo.com','query1.finance.yahoo.com','query2.finance.yahoo.com'].includes(url.hostname))sourceUrl=url.href;}catch{}try{const url=new URL(quote?.originalSourceUrl||originalUrl);if(url.protocol==='https:'&&url.hostname==='edge.pse.com.ph')originalUrl=url.href;}catch{}link.href=sourceUrl;link.textContent=`${quote?.source||currentFreeSource()} source ↗`;original.querySelector('a').href=originalUrl;original.hidden=marketOf(quote)!=='PH'||!quote?.originalSourceUrl||sourceUrl.startsWith('https://edge.pse.com.ph/');}
function money(q){return q?.assetType==='index'?number(q.value):currencyNumber(q?.value,q?.currency||marketMeta(q).currency,isFund(q)?4:2);}
function paintChange(el,value,text){el.classList.remove('up','down','flat');el.classList.add(direction(value));el.textContent=text;}
function renderMarketContext(){const label=selectedMarket==='ALL'?'All saved markets':markets[selectedMarket].name;$('#market-select').value=selectedMarket;$('.country-tag').textContent=selectedMarket;$('#market-currency').textContent=selectedMarket==='ALL'?'Local currencies':markets[selectedMarket].currency;$('#market-eyebrow').textContent=selectedMarket==='PH'?'THE PHILIPPINE MARKET, AT A GLANCE':`${label.toUpperCase()}, IN FOCUS`;$('#market-time-zone').textContent=selectedMarket==='PH'?'Philippine source times · PHT':'Source times use each exchange’s local time';$('#footer-market').textContent=`Your perspective on ${selectedMarket==='ALL'?'global':label} markets.`;document.title=`Tala — ${label} market dashboard`;$('#search-input').placeholder=selectedMarket==='PH'?'Search a symbol or fund…':'Search a symbol or company…';renderMarketState();}
function renderMarketState(){const label=selectedMarket==='ALL'?'All saved markets':markets[selectedMarket].name,available=(snapshot?.quotes||[]).filter(q=>inSelectedMarket(q)&&Number.isFinite(q.value));let text=selectedMarket==='ALL'?'Saved stocks across exchanges · Original currencies · Change % compares each source session.':`${label} · ${markets[selectedMarket].currency} · Original prices; timestamps use the exchange’s local time.`;if(marketErrors.has(selectedMarket))text=`${label} source unavailable. ${marketErrors.get(selectedMarket)} Prices remain unavailable where no quote was returned.`;else if(selectedMarket!=='PH'&&settings.mode==='demo')text='The fictional sample covers Philippine instruments only. International prices remain unavailable.';else if(selectedMarket!=='PH'&&selectedMarket!=='ALL'&&settings.mode==='gateway'&&!available.length)text=`${label} · No quotes are available from this connection yet. Add a ticker to request its actual source price.`;$('#market-state').textContent=text;}
function firstMarketInstrument(){return allInstruments().find(q=>inSelectedMarket(q)&&!isFund(q))?.symbol||null;}
async function changeMarket(next){if(!markets[next]&&next!=='ALL')return;const token=++marketVersion;selectedMarket=next;writeStorage(MARKET_KEY,next);selected=next==='PH'?'PSEI':firstMarketInstrument();points=[];historyInfo=null;historyVersion++;$('#table-filter').value='';renderMarketContext();renderSummary();renderRadar();renderTable();updateDetail();renderHistory();closeSearch();$('#market-state').textContent=`Loading ${next==='ALL'?'saved markets':markets[next].name} source…`;await loadCatalog(next==='ALL'?'PH':next);if(token!==marketVersion)return;if(selected===null)selected=firstMarketInstrument();updateDetail();if(inFlight)queuedRefresh=true;else await refresh();}
function renderStatus(error){
  const demo=settings.mode==='demo';
  $('#free-source-reference').hidden=!isFreeConnection();
  if(isFreeConnection())renderFreeReference();
  $('#connect-data').hidden=settings.mode==='demo'||settings.mode==='gateway'&&!error;
  if(settings.mode==='unconfigured'){$('#data-banner').classList.remove('is-error','is-warning');$('#market-status').textContent='Prices not connected. Add stocks now, then connect a provider to load real quotes and history.';$('#footer-notice').textContent='No market values are fabricated. Prices remain unavailable until a data provider is connected.';return;}
  $('#data-banner').classList.toggle('is-warning',cached);$('#data-banner').classList.remove('is-error');
  let message=demo ? `Sample data · Fictional snapshot as of ${date(snapshot.marketDate,{year:'numeric'})}. Explore the dashboard; these are not market quotes.` : `Provider quotes · Original currencies and exchange-local timestamps. ${snapshot.issues?.length ? snapshot.issues.join(' · ')+'. ' : ''}Refresh every 60 seconds.`;
  if(isFreeConnection()){const times=[...(selectedMarket==='PH'?[snapshot.index]:[]),...snapshot.quotes.filter(inSelectedMarket)].filter(q=>Number.isFinite(q?.value)&&Number.isFinite(Date.parse(q.asOf))).sort((a,b)=>Date.parse(a.asOf)-Date.parse(b.asOf)),latest=times.at(-1),dateOnly=latest?.timestampPrecision==='date'||/^\d{4}-\d{2}-\d{2}$/.test(latest?.asOf||'');message=`${currentFreeSource()} ${times.length&&times.every(q=>q.freshness==='eod')?'end-of-day prices':'market snapshots'}${latest?` · Latest ${dateOnly?'market date':'source time'} ${quoteTime(latest)}`:'. Values currently unavailable'}. ${freeCoverageNote()} Original currencies and exchange timestamps are shown per instrument. Mutual funds and ETF NAV are not supplied by this source.${snapshot.issues?.length&&selectedMarket!=='PH'?` ${snapshot.issues.join(' · ')}.`:''}`;}
  if(cached)message=`${navigator.onLine ? (error?.status===429?'Rate limited':'Update failed') : 'Offline'} · cached ${demo?'sample data':isFreeConnection()?`${currentFreeSource()} snapshots`:'quotes'}. Original source timestamps are preserved.${isFreeConnection()?` ${freeCoverageNote()}`:''}${error?.status===429 ? ` Retrying in ${error.retryAfter||60} seconds.`:''}`;
  $('#market-status').textContent=message;
  $('#footer-notice').textContent=demo ? 'Sample values, fund names and historical series are fictional. Sample timestamps use Asia/Manila. For dashboard exploration only.' : isFreeConnection()?`Source: ${currentFreeSource()}. ${freeCoverageNote()} These are market snapshots with original currencies and exchange-local timestamps, not a real-time feed. Mutual-fund and ETF NAV values are unavailable from this connection.`:'Quotes retain their provider’s source, currency and exchange timestamp. Daily fund NAV and ETF NAV have separate valuation dates. For information only; not investment advice.';
  renderMarketState();
}
function renderSummary(){
  const idx=snapshot.index;
  $('#index-value').replaceChildren(document.createTextNode(number(idx?.value)),node('span',null,'PTS'));
  $('#index-badge').textContent=freshness(idx,{cached});
  const change=$('#index-change');change.className=`change-pill ${direction(idx?.changePercent)}`;change.textContent=`${arrow(idx?.changePercent)} ${signed(idx?.change)} (${percent(idx?.changePercent)})`;
  $('#index-date').textContent=idx?.asOf||idx?.marketDate ? `As of ${date(idx.asOf||idx.marketDate)} · ${idx.source}` : 'Source unavailable';
  const followed=(snapshot.quotes || []).filter(q=>watchlist.includes(q.symbol)&&inSelectedMarket(q)&&Number.isFinite(q.changePercent));
  const avg=followed.length ? followed.reduce((a,q)=>a+q.changePercent,0)/followed.length : null;
  paintChange($('#watch-average'),avg,percent(avg));$('#watch-summary').textContent=`Average source-session change · ${followed.length} ${followed.length===1?'security':'securities'}`;
  $('#watch-count').textContent=watchlist.length;
  const stocks=snapshot.quotes.filter(q=>q.assetType==='stock'&&inSelectedMarket(q)&&Number.isFinite(q.value)),adv=stocks.filter(q=>q.change>0).length,dec=stocks.filter(q=>q.change<0).length;
  $('#advancers').textContent=stocks.length?adv:'—';$('#decliners').textContent=stocks.length?dec:'—';$('#breadth-fill').style.width=`${adv+dec?adv/(adv+dec)*100:50}%`;
  $('#breadth-label').textContent=stocks.length?`Advancing / declining · ${stocks.length} covered stocks`:'Awaiting actual market quotes';
  $('.breadth-bar').hidden=!stocks.length;
  const dates=snapshot.funds.map(f=>f.valuationDate).filter(Boolean).sort();
  $('#fund-date').textContent=dates.length ? date(dates.at(-1),{year:'numeric'}) : 'Unavailable';
  $('#fund-count').textContent=`Daily NAV · ${snapshot.funds.length} Philippine funds`;
  $('#stocks-count').textContent=allInstruments().filter(q=>q.assetType==='stock'&&inSelectedMarket(q)).length;
  $$('.nav-item[data-view="etfs"] .nav-small').forEach(n=>n.textContent=allInstruments().filter(q=>q.assetType==='etf').length);
}
function renderRadar(){
  const list=$('#radar-list');list.replaceChildren();
  const rows=watchlist.map(instrument).filter(q=>q&&inSelectedMarket(q)).slice(0,5);
  if(!rows.length)list.append(node('p','radar-empty','Star a stock or ETF to keep it on your radar. Your picks stay in this browser.'));
  rows.forEach((q,i)=>{const btn=node('button','radar-row');btn.dataset.select=q.symbol;btn.setAttribute('aria-label',`View ${q.symbol} history`);btn.append(node('span',`instrument-avatar avatar-${i%4}`,q.symbol.slice(0,2)));const name=node('span','radar-instrument');name.append(node('strong','radar-symbol',q.symbol),node('span','radar-name',q.name));const value=node('span','radar-price');value.append(node('strong',null,money(q)),node('span',direction(q.changePercent),`${arrow(q.changePercent)} ${percent(q.changePercent)}`));btn.append(name,value);list.append(btn);});
}
function tableRows(){
  const all=allInstruments().filter(inSelectedMarket);let rows=tableView==='funds'?all.filter(isFund):tableView==='etfs'?all.filter(q=>q.assetType==='etf'):tableView==='watchlist'?all.filter(q=>watchlist.includes(q.symbol)):all.filter(q=>q.assetType==='stock');
  const query=$('#table-filter').value.trim().toLowerCase();if(query)rows=rows.filter(q=>`${q.symbol} ${q.name} ${q.category||''}`.toLowerCase().includes(query));
  const key=selectedMarket==='ALL'&&['value','change'].includes(sort.key)?'symbol':sort.key;return rows.sort((a,b)=>{let av=a[key],bv=b[key];if(av==null)return bv==null?0:1;if(bv==null)return-1;return sort.order*(typeof av==='number'&&typeof bv==='number'?av-bv:String(av).localeCompare(String(bv)));});
}
function header(text,key,numeric=false){const th=node('th',numeric?'numeric':null);th.scope='col';if(key){const btn=node('button',null,text);btn.dataset.sort=key;btn.append(node('span','sort-indicator',sort.key===key?(sort.order===1?'↑':'↓'):'↕'));th.append(btn);if(sort.key===key)th.setAttribute('aria-sort',sort.order===1?'ascending':'descending');}else th.textContent=text;return th;}
function renderTable(){
  if(!snapshot)return;
  $$('.table-tabs button').forEach(btn=>{const active=btn.dataset.tableView===tableView;btn.classList.toggle('active',active);btn.setAttribute('aria-pressed',active);});
  const funds=tableView==='funds',tr=node('tr');
  tr.append(header(funds?'Fund / category':'Instrument','symbol'),header(funds?'NAVPS / NAVPU':'Last price',selectedMarket==='ALL'?null:'value',true),header('Change',selectedMarket==='ALL'?null:'change',true),header('Change %','changePercent',true),header(funds?'Valuation date':'Volume',funds?'valuationDate':'volume',!funds),header(funds?'Source / freshness':'1M trend'),header(funds?'History':'Exchange time / source'),header(funds?'':'Save'));
  $('#instrument-head').replaceChildren(tr);const tbody=$('#instrument-table tbody');tbody.replaceChildren();const rows=tableRows();
  rows.forEach((q,i)=>{const row=node('tr',q.symbol===selected?'is-selected':'');const cell=node('td');const group=node('div','instrument-cell');group.append(node('span',`instrument-avatar avatar-${i%4}`,funds?'MF':q.symbol.slice(0,2)));const select=node('button','instrument-select');select.dataset.select=q.symbol;select.append(node('strong',null,funds?q.name:q.symbol),node('span',null,funds?q.category:q.name));select.setAttribute('aria-label',`View ${q.name} history`);group.append(select);cell.append(group);
    const price=node('td','numeric quote-price');price.append(node('span','quote-currency',funds?`${q.valueType} · ${q.currency||'PHP'}`:q.currency||marketMeta(q).currency),document.createTextNode(number(q.value,funds?4:2)));
    const change=node('td',`numeric cell-change ${direction(q.change)}`,`${arrow(q.change)} ${signed(q.change,funds?4:2)}`),pct=node('td',`numeric cell-change ${direction(q.changePercent)}`,percent(q.changePercent));
    const col5=node('td',funds?'cell-date':'numeric cell-volume',funds?date(q.valuationDate,{year:'numeric'}):compact(q.volume));
    const col6=node('td');const col7=node('td','cell-date');const last=node('td','numeric');
    if(funds){col6.append(node('span','cell-date',q.source),node('span','cell-source',freshness(q,{cached})));const h=node('button','text-link','View');h.dataset.select=q.symbol;h.append(icon('arrow'));col7.append(h);}
    else{const series=snapshot.mode==='demo'?snapshot.histories?.[q.symbol]:selected===q.symbol&&range==='1m'?points:[];if(series?.length>1)col6.append(sparkline(series,q.changePercent));else{col6.append(node('span','cell-volume','—'));col6.title='Select this instrument and its 1M range to load history.';}col7.append(node('span',null,q.asOf?quoteTime(q):'Time unavailable'),node('span','cell-source',q.source));const f=freshness(q,{cached});col7.append(node('span',`freshness-tag ${/stale|Cached|Unavailable|suspended/i.test(f)?'warning':''}`,f));const star=node('button',`star-button ${watchlist.includes(q.symbol)?'saved':''}`);star.dataset.watch=q.symbol;star.setAttribute('aria-label',`${watchlist.includes(q.symbol)?'Remove':'Add'} ${q.symbol} ${watchlist.includes(q.symbol)?'from':'to'} watchlist`);star.setAttribute('aria-pressed',watchlist.includes(q.symbol));star.append(icon('star'));last.append(star);}
    row.append(cell,price,change,pct,col5,col6,col7,last);tbody.append(row);
  });
  if(!rows.length){const row=node('tr'),cell=node('td','empty-cell',tableView==='watchlist'?'Your watchlist is empty. Star a stock or ETF to get started.':funds&&isFreeConnection()?`${freeSource} does not provide mutual-fund NAVs. Connect another source to compare funds.`:'No instruments found. Try another filter or check the data connection.');cell.colSpan=8;row.append(cell);tbody.append(row);}
  $('#table-count').textContent=`${rows.length} ${funds?'funds':'instruments'} · ${names[tableView]} · ${selectedMarket==='ALL'?'All saved markets':markets[selectedMarket].name}`;
  $('#table-data-note').textContent=settings.mode==='unconfigured'?'Prices unavailable · connect a provider':settings.mode==='demo'?'Sample mode explicitly selected':isFreeConnection()?`${currentFreeSource()} snapshots · ${freeCoverageNote()||'original source timestamps'}`:funds?'Daily NAV · actual valuation dates':'Provider quotes · original timestamps';
  $('#export-csv').disabled=!rows.length;
}
function updateDetail(){
  const q=instrument(selected);if(!q)return;
  $('#detail-symbol').textContent=q.assetType==='market'?(selectedMarket==='ALL'?'Your markets':markets[selectedMarket].name):isFund(q)?'Fund NAV':q.symbol==='PSEI'?'PSEi':q.symbol;
  $('#detail-symbol').dataset.detailSymbol=q.symbol;
  $('#detail-name').textContent=q.name;
  $('#detail-category').textContent=q.assetType==='market'?'SELECT AN INSTRUMENT':isFund(q)?'DAILY FUND VALUATION':q.assetType==='etf'?'ETF PERFORMANCE':q.assetType==='index'?'PHILIPPINE INDEX PERFORMANCE':`${q.exchange||markets[marketOf(q)]?.name||'STOCK'} PERFORMANCE`;
  $('#detail-value').textContent=money(q);
  paintChange($('#detail-change'),q.changePercent,`${arrow(q.changePercent)} ${percent(q.changePercent)}`);
  $('#detail-value-type').textContent=valueLabel(q);
  $('#detail-asof').textContent=q.asOf?`${freshness(q,{cached})} · ${q.freshness==='suspended'||/suspended/i.test(q.tradingStatus||'')?'Page as of ':''}${quoteTime(q)} · ${q.source}`:'Source timestamp unavailable';
  const watch=$('#detail-watch');watch.hidden=isFund(q)||['index','market'].includes(q.assetType);watch.dataset.watch=q.symbol;watch.classList.toggle('saved',watchlist.includes(q.symbol));watch.setAttribute('aria-pressed',watchlist.includes(q.symbol));watch.setAttribute('aria-label',`${watchlist.includes(q.symbol)?'Remove':'Add'} ${q.symbol} ${watchlist.includes(q.symbol)?'from':'to'} watchlist`);
  const etf=$('#etf-nav-detail');etf.hidden=q.assetType!=='etf';etf.replaceChildren();
  if(q.assetType==='etf'){const nav=snapshot.etfs.find(e=>e.quote?.symbol===q.symbol)?.nav;etf.append(document.createTextNode(nav?.valueType||'NAV / iNAV'),node('strong',null,nav?currencyNumber(nav.value,nav.currency||q.currency||marketMeta(q).currency,4):'Unavailable'));etf.append(node('small',null,nav?`Valuation ${date(nav.valuationDate,{year:'numeric'})} · ${quoteTime(nav)} · ${nav.source}`:isFreeConnection()?`${currentFreeSource()} provides exchange-traded prices; ETF NAV and iNAV are not supplied.`:'Connect an approved NAV source to view a separately timestamped valuation.'));}
}
function renderHistory(){
  const q=instrument(selected);if(!q)return;
  drawChart($('#history-chart'),points,{label:q.name,digits:isFund(q)?4:2});
  $('#chart-empty').hidden=!!points.length;
  $('#history-label').textContent=`${isFund(q)?q.valueType:historyInfo?.freshness==='snapshot'?'Recorded snapshot':'Daily close'}${q.assetType==='index'?' · index points':` · ${q.currency||marketMeta(q).currency}`} · ${historyInfo?.source||'Unavailable'}${historyInfo?.cached?' · cached':''}`;
  $('#history-date-heading').textContent='Exchange session date';$('#history-value-heading').textContent=q.assetType==='index'?'Index points':`${isFund(q)?q.valueType:'Value'} (${q.currency||marketMeta(q).currency})`;
  $('#history-point-count').textContent=`${points.length} observations`;
  const tbody=$('#history-table tbody');tbody.replaceChildren();[...points].reverse().forEach(point=>{const tr=node('tr');tr.append(node('td',null,date(point.date,{year:'numeric'})),node('td',null,number(point.close,isFund(q)?4:2)),node('td',null,historyInfo?.source||'Unavailable'));tbody.append(tr);});
  $('#history-table caption').textContent=`Historical ${valueLabel(q)} values for ${q.name}. ${historyInfo?.source||'No source'}.`;
}
async function loadHistory(){
  const token=++historyVersion,currentVersion=version,id=selected,currentRange=range;
  points=[];historyInfo=null;renderHistory();$('#chart-empty').textContent='Loading history…';
  if(id===null){$('#chart-empty').textContent='Add or select a stock in this market to view its price and available history.';return;}
  try{const data=await api.history(id,currentRange,isFund(instrument(id)));if(token!==historyVersion||currentVersion!==version)return;points=(data.points||[]).filter(p=>p&&Number.isFinite(p.close)&&/^\d{4}-\d{2}-\d{2}$/.test(p.date));historyInfo=data;$('#chart-empty').textContent=settings.mode==='unconfigured'?'Connect a data provider to load actual price history.':'No historical data is available for this instrument.';renderHistory();if(settings.mode==='gateway')renderTable();}
  catch{if(token!==historyVersion||currentVersion!==version)return;$('#chart-empty').textContent=isFreeConnection()&&freeCoverageNote()?'This free fallback supplies price snapshots. Historical charts are unavailable.':'Historical data unavailable. Check your connection or try another instrument.';renderHistory();}
}
async function selectInstrument(id){selected=id;const token=version;updateDetail();renderTable();const q=instrument(id);if(settings.mode==='gateway'&&q&&!isFund(q)&&!['index','market'].includes(q.assetType)&&!Number.isFinite(q.value)){try{const quote=await api.quote(id);if(token!==version||selected!==id)return;if(!Number.isFinite(quote?.value))throw new Error('No actual price is available from this source.');snapshot.quotes=snapshot.quotes.filter(item=>item.symbol!==id);snapshot.quotes.push(quote);quoteMutations.set(id,++quoteRevision);saveCache(api.cacheKey,snapshot);marketErrors.delete(marketOf(q));renderStatus();renderSummary();renderRadar();renderTable();updateDetail();}catch(error){if(token===version&&selected===id){marketErrors.set(marketOf(q),error.message);renderMarketState();}}}await loadHistory();}
function toggleWatch(symbol){
  const removing=watchlist.includes(symbol);watchlist=removing?watchlist.filter(s=>s!==symbol):[...watchlist,symbol];
  const saved=writeStorage(WATCH,watchlist);renderSummary();renderRadar();renderTable();updateDetail();toast(`${symbol} ${removing?'removed from':'added to'} your watchlist.${saved?'':' Browser storage is unavailable; saved for this session.'}`);
  const target=$(`#instrument-table [data-watch="${symbol}"]`);if(target)target.focus({preventScroll:true});
}
function updateAddMarket(){const market=$('#add-stock-market').value;$('#add-stock-input').placeholder=`e.g. ${markets[market].example}`;$('#add-stock-input-label').textContent=`${markets[market].name} symbol or company name`;$('#add-stock-help').textContent=settings.mode!=='gateway'?'Save a ticker now. Its price stays unavailable until a real source is connected. International prices are not part of the Philippine sample.':market==='PH'&&isFreeConnection()?`Search the available ${currentFreeSource()} catalog. ${freeCoverageNote()} Adding a covered stock loads its timestamped quote.`:`Search ${markets[market].name} companies or enter an exchange ticker. The source must return an actual quote before a connected stock is added. Prices remain in the source currency.`;}
function openAddStock(){const dialog=$('#add-stock-dialog');$('#add-stock-market').value=selectedMarket==='ALL'?'PH':selectedMarket;$('#add-stock-input').value='';$('#add-stock-error').hidden=true;$('#add-stock-results').replaceChildren();updateAddMarket();dialog.showModal();$('#add-stock-input').focus();}
async function searchAddStocks(){
  const token=++addSearchVersion,query=$('#add-stock-input').value.trim(),market=$('#add-stock-market').value,list=$('#add-stock-results');list.replaceChildren();$('#add-stock-error').hidden=true;if(!query)return;
  let pool=catalog.filter(q=>marketOf(q)===market);
  if(settings.mode==='gateway'){
    try{const data=await api.catalog(stockSearchQuery(query,market),market);if(token!==addSearchVersion)return;pool=data.instruments;mergeCatalog(pool);}
    catch{if(token!==addSearchVersion)return;$('#add-stock-error').textContent=market==='PH'?'The provider catalog is unavailable. Check your data connection before adding this symbol.':'Company search is unavailable. You can still enter an exact ticker below; it will be saved only if the source returns its actual quote.';$('#add-stock-error').hidden=false;if(market==='PH')return;}
  }
  pool.filter(q=>`${q.symbol} ${q.name}`.toLowerCase().includes(query.toLowerCase())).slice(0,12).forEach(q=>{const li=node('li'),button=node('button','add-result');button.type='button';button.dataset.addSymbol=q.symbol;button.append(node('strong',null,q.symbol),node('span',null,q.name),icon('star'));li.append(button);list.append(li);});
  if(!list.children.length)list.append(node('li','add-search-empty',settings.mode==='gateway'?'No matching symbol in the provider catalog.':'This symbol is outside the starter list. You can save it below and verify it after connecting.'));
}
async function addStock(raw){
  if($('#add-stock-submit').disabled)return;
  $('#add-stock-error').hidden=true;const currentVersion=version;
  try{
    const symbol=normalizeStockSymbol(raw,$('#add-stock-market').value),market=marketOf(symbol);let meta=catalog.find(q=>q.symbol===symbol)||{symbol,name:symbol,market,assetType:'stock',currency:markets[market].currency,timeZone:markets[market].timeZone,verified:false};
    if(!requestedInstruments().some(q=>q.symbol===symbol)&&requestedInstruments().length>=100)throw new Error('You can track up to 100 instruments.');
    const submit=$('#add-stock-submit');submit.disabled=true;let quote=null;
    try{
      if(settings.mode==='gateway'){let found;try{const data=await api.catalog(stockSearchQuery(symbol,market),market);found=data.instruments.find(q=>q.symbol===symbol);}catch(error){if(market==='PH')throw error;}if(market==='PH'&&!found)throw new Error(isFreeConnection()?freeStockUnavailable(symbol):'This symbol is not listed in your provider’s PSE catalog.');quote=await api.quote(symbol);if(!quote||quote.symbol!==symbol||!Number.isFinite(quote.value)||!quote.source||!Number.isFinite(Date.parse(quote.asOf)))throw new Error('No actual timestamped quote is available for this symbol.');meta={...meta,...found,symbol:quote.symbol,name:quote.name||found?.name||symbol,market,assetType:quote.assetType||'stock',currency:quote.currency,timeZone:quote.timeZone||markets[market].timeZone,exchange:quote.exchange||found?.exchange,ticker:quote.ticker||found?.ticker,verified:true};}
      else if(settings.mode==='demo')quote=await api.quote(symbol);
      if(currentVersion!==version)return;
      if(!seedCatalog.some(q=>q.symbol===symbol)){pinned=pinned.filter(q=>q.symbol!==symbol);pinned.push(meta);writeStorage(PINNED,pinned);}
      mergeCatalog([meta]);
      if(!watchlist.includes(symbol)){watchlist.push(symbol);writeStorage(WATCH,watchlist);}
      if(quote){snapshot.quotes=snapshot.quotes.filter(q=>q.symbol!==symbol);snapshot.quotes.push(quote);quoteMutations.set(symbol,++quoteRevision);saveCache(api.cacheKey,snapshot);}if(inFlight)queuedRefresh=true;
      if(selectedMarket!=='ALL'&&selectedMarket!==market){selectedMarket=market;writeStorage(MARKET_KEY,market);renderMarketContext();}marketErrors.delete(market);renderStatus();
      $('#add-stock-dialog').close();renderSummary();renderRadar();tableView='watchlist';renderTable();await selectInstrument(symbol);
      toast(quote?`${symbol} added with a timestamped ${quote.source} quote.`:`${symbol} saved. Price awaits a real data connection.`);
    }finally{submit.disabled=false;}
  }catch(error){$('#add-stock-error').textContent=isFreeConnection()&&error.code==='coverage_unavailable'?freeStockUnavailable($('#add-stock-input').value.trim().toUpperCase()):error.message;$('#add-stock-error').hidden=false;}
}
function setView(next){
  if(!names[next])return;view=next;tableView=next==='overview'?'stocks':next;
  $$('#main-nav [data-view]').forEach(btn=>{const active=btn.dataset.view===next;btn.classList.toggle('active',active);if(active)btn.setAttribute('aria-current','page');else btn.removeAttribute('aria-current');});
  $('#breadcrumb').textContent=names[next];$('#page-title').replaceChildren(document.createTextNode(viewTitles[next][0]),node('span',null,'.'));$('#page-subtitle').textContent=viewTitles[next][1];$('#explore-title').textContent=next==='overview'?'Explore the market':next==='funds'?'Daily fund valuations':next==='watchlist'?'Your saved instruments':`Explore ${names[next].toLowerCase()}`;
  $('#table-filter').value='';renderTable();setNavOpen(false);
  if(snapshot){const candidates=allInstruments().filter(inSelectedMarket);const first=next==='overview'&&selectedMarket==='PH'?'PSEI':next==='funds'?candidates.find(isFund)?.symbol:next==='etfs'?candidates.find(q=>q.assetType==='etf')?.symbol:next==='watchlist'?watchlist.find(s=>{const q=instrument(s);return q&&inSelectedMarket(q);}):candidates.find(q=>q.assetType==='stock')?.symbol;selectInstrument(first||null);}
}
function schedule(ms){clearTimeout(timer);if(settings.mode==='gateway'&&ms!==null)timer=setTimeout(refresh,ms);}
async function refresh(){
  if(inFlight)return;
  if(document.visibilityState==='hidden'){schedule(5*60_000);return;}
  const refreshVersion=version,requested=quoteInstruments(),activeAtStart=selectedMarket,revisionAtStart=quoteRevision,retained=(snapshot?.quotes||[]).filter(q=>marketOf(q)!=='PH'&&activeAtStart!=='ALL'&&marketOf(q)!==activeAtStart);inFlight=true;$('#refresh-data').disabled=true;
  try{const result=await api.snapshot(requested);if(refreshVersion!==version)return;const resolvedDuringRefresh=(snapshot?.quotes||[]).filter(q=>(quoteMutations.get(q.symbol)||0)>revisionAtStart);snapshot={...result.data,quotes:[...new Map([...retained,...result.data.quotes,...resolvedDuringRefresh].map(q=>[q.symbol,q])).values()]};cached=result.cached;const unverified=requestedInstruments().filter(q=>marketOf(q)==='PH').length-requested.filter(q=>marketOf(q)==='PH').length;if(unverified>0)snapshot.issues=[...(snapshot.issues||[]),`${unverified} saved Philippine symbols not in provider catalog`];if(!result.cached)marketErrors.delete(activeAtStart);renderStatus(result.error);renderSummary();renderRadar();renderTable();updateDetail();if(!historyInfo||points.length===0)await loadHistory();delay=result.error?.retryAfter?result.error.retryAfter*1000:result.cached?Math.min((delay||60_000)*2,600_000):60_000;if([401,403].includes(result.error?.status)||['service_configuration','license_required','origin_forbidden','invalid_request'].includes(result.error?.code))delay=null;}
  catch(error){if(refreshVersion!==version)return;const resolvedDuringRefresh=(snapshot?.quotes||[]).filter(q=>(quoteMutations.get(q.symbol)||0)>revisionAtStart);snapshot={mode:settings.mode,index:null,quotes:[...new Map([...retained,...resolvedDuringRefresh].map(q=>[q.symbol,q])).values()],funds:[],etfs:[],issues:[]};cached=false;points=[];historyInfo=null;marketErrors.set(activeAtStart,error.message);$('#data-banner').classList.add('is-error');$('#market-status').textContent=`${navigator.onLine?error.message:'Offline. No valid cached data is available.'} Connect a provider to load actual prices.`;$('#connect-data').hidden=false;renderSummary();renderRadar();renderTable();updateDetail();renderHistory();$('#chart-empty').textContent='Price history is unavailable from the current connection.';delay=[401,403].includes(error.status)||['service_configuration','license_required','origin_forbidden','invalid_request'].includes(error.code)?null:error.retryAfter?error.retryAfter*1000:Math.min((delay||60_000)*2,600_000);}
  finally{if(refreshVersion===version){inFlight=false;$('#refresh-data').disabled=false;renderMarketState();if(queuedRefresh){queuedRefresh=false;refresh();}else schedule(delay);}}
}
function closeSearch(){mainSearchVersion++;clearTimeout(mainSearchTimer);searchIndex=-1;$('#search-results').hidden=true;$('#search-input').setAttribute('aria-expanded','false');$('#search-input').removeAttribute('aria-activedescendant');}
function showSearch(){
  const query=$('#search-input').value.trim().toLowerCase(),list=$('#search-results');list.replaceChildren();searchIndex=-1;
  if(!query){searchMatches=[];closeSearch();return;}
  const merged=new Map([...catalog,...allInstruments()].map(q=>[q.symbol,q]));if(snapshot?.index)merged.set('PSEI',snapshot.index);
  searchMatches=[...merged.values()].filter(q=>inSelectedMarket(q)&&`${q.symbol} ${q.name}`.toLowerCase().includes(query)).slice(0,8);
  if(!searchMatches.length){const li=node('li','search-empty','No instruments found');li.setAttribute('role','presentation');list.append(li);}
  searchMatches.forEach((q,i)=>{const li=node('li');li.id=`search-option-${i}`;li.setAttribute('role','option');li.setAttribute('aria-selected','false');li.dataset.result=q.symbol;const text=node('span');text.append(node('strong',null,isFund(q)?'FUND':q.symbol),node('small',null,q.name));li.append(text,node('small',null,q.assetType==='etf'?`ETF · ${marketOf(q)}`:isFund(q)?q.category:q.exchange||marketOf(q)));list.append(li);});
  list.hidden=false;$('#search-input').setAttribute('aria-expanded','true');
}
async function searchProvider(){const query=$('#search-input').value.trim(),market=selectedMarket,token=++mainSearchVersion;if(!query||market==='PH'||market==='ALL'||settings.mode!=='gateway')return;const prefix=query.toUpperCase().split(':');if(prefix.length>1&&markets[prefix[0]]&&prefix[0]!==market){$('#search-results').replaceChildren(node('li','search-empty',`Choose ${markets[prefix[0]].name} in the market selector to search this ticker.`));return;}try{const data=await api.catalog(stockSearchQuery(query,market),market);if(token!==mainSearchVersion||market!==selectedMarket||query!==$('#search-input').value.trim())return;mergeCatalog(data.instruments);showSearch();}catch{if(token!==mainSearchVersion||market!==selectedMarket||!$('#search-input').value.trim())return;if(!searchMatches.length){$('#search-results').replaceChildren(node('li','search-empty','Company search unavailable. Use Add stock to request an exact ticker.'));$('#search-results').hidden=false;}}}
function searchSelect(id){closeSearch();searchMatches=[];mainSearchVersion++;$('#search-input').value='';const q=catalog.find(item=>item.symbol===id);if(q&&!requestedInstruments().some(item=>item.symbol===id)&&['stock','etf'].includes(q.assetType)){openAddStock();$('#add-stock-market').value=marketOf(id);updateAddMarket();$('#add-stock-input').value=id;addStock(id);}else selectInstrument(id);}
function exportCsv(){
  const rows=tableRows(),funds=tableView==='funds';
  const headings=['Symbol or fund ID','Name','Market','Exchange','Asset type','Currency','Value','Value type','Previous close','Change','Change percent','Volume','As of','Exchange time zone','Valuation date','Source','Freshness'];
  const csv=[headings,...rows.map(q=>[q.symbol,q.name,marketOf(q),q.exchange,q.assetType,q.currency,q.value,q.valueType,q.previousClose,q.change,q.changePercent,q.volume,q.asOf,q.timeZone||marketMeta(q).timeZone,q.valuationDate||q.marketDate,q.source,freshness(q,{cached})])].map(row=>row.map(csvCell).join(',')).join('\r\n');
  const url=URL.createObjectURL(new Blob(['\uFEFF'+csv],{type:'text/csv;charset=utf-8'}));const a=node('a');a.href=url;a.download=`tala-${tableView}-${snapshot.marketDate||new Date().toISOString().slice(0,10)}.csv`;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);toast(`Exported ${rows.length} ${funds?'funds':'instruments'} with source timestamps.`);
}
function openSettings(){const dialog=$('#settings-dialog');$('#connection-mode').value=isFreeConnection()?'free':settings.mode;$('#api-url').value=settings.apiBase;$('#settings-error').hidden=true;$('#local-token').value='';$('#local-use').checked=false;updateSettingsMode();dialog.showModal();}
function updateSettingsMode(){const mode=$('#connection-mode').value,gateway=mode==='gateway',local=mode==='local';$('#api-url').disabled=!gateway;$('#api-url').required=gateway;$('#local-setup').hidden=!local;$('#free-data-help').hidden=mode!=='free';$('#local-token').required=local;$('#local-use').required=local;}
async function applySettings(next){
  settings=next;writeStorage(SETTINGS,settings);version++;historyVersion++;clearTimeout(timer);inFlight=false;queuedRefresh=false;api=new MarketApi(settings);snapshot={mode:settings.mode,index:null,quotes:[],funds:[],etfs:[],marketDate:null};points=[];historyInfo=null;cached=false;selected=selectedMarket==='PH'?'PSEI':firstMarketInstrument();catalog=[...seedCatalog,...pinned];marketErrors.clear();marketSeeds.clear();marketSources.clear();
  $('#free-source-reference').hidden=!isFreeConnection();
  $('#settings-dialog').close();$('#market-status').textContent='Loading your data connection…';$('#data-banner').classList.remove('is-error','is-warning');
  renderSummary();renderRadar();renderTable();updateDetail();renderHistory();
  $('#index-badge').textContent='Loading';$('#detail-asof').textContent='Loading';$('#etf-nav-detail').hidden=true;$('#export-csv').disabled=true;$('#footer-notice').textContent='Source and freshness labels accompany actual values. Unavailable prices remain blank.';
  await loadCatalog('PH');if(!['PH','ALL'].includes(selectedMarket))await loadCatalog(selectedMarket);await refresh();toast(settings.mode==='unconfigured'?'Data disconnected. Your saved stocks are kept.':'Data connection saved.');
}
async function loadCatalog(market='PH'){if(settings.mode!=='gateway')return;const token=version;try{const data=await api.catalog('',market);if(token!==version)return;mergeCatalog(data.instruments);marketSources.set(market,data.source);if(market!=='PH')marketSeeds.set(market,data.instruments.slice(0,6));pinned=pinned.map(q=>{const match=catalog.find(i=>i.symbol===q.symbol);return match?{...match,...q,verified:q.verified===true||match.verified===true}:q;});writeStorage(PINNED,pinned);marketErrors.delete(market);showSearch();}catch(error){if(token===version)marketErrors.set(market,error.message);}}
$('#settings-form').addEventListener('submit',async event=>{
  event.preventDefault();let next={mode:$('#connection-mode').value,apiBase:''};
  try{
    if(next.mode==='unconfigured')next.autoConnect=false;
    if(next.mode==='free'){if(!freeAvailable||!freeApiBase)throw new Error('Free PSE EDGE data is available through the local dashboard server.');next={mode:'gateway',apiBase:freeApiBase};}
    if(next.mode==='gateway'&&$('#connection-mode').value!=='free')next.apiBase=validateApiUrl($('#api-url').value.trim());
    if(next.mode==='local'){
      if(!localAvailable||!$('#local-use').checked)throw new Error('Local setup is available only on this computer and requires confirmation of personal use.');
      const token=$('#local-token').value;
      const response=await fetch(new URL('/api/config',location.origin),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token,personalUse:true})});
      $('#local-token').value='';
      if(!response.ok)throw new Error('Could not save the local provider connection. Check your API key and local server.');
      next={mode:'gateway',apiBase:new URL('/api',location.origin).href};
    }
  }
  catch(error){$('#settings-error').textContent=error.message;$('#settings-error').hidden=false;return;}
  await applySettings(next);
});
document.addEventListener('click',event=>{
  const button=event.target.closest('button');if(button){if(button.dataset.addSymbol)addStock(button.dataset.addSymbol);else if(button.dataset.view)setView(button.dataset.view);else if(button.dataset.tableView){tableView=button.dataset.tableView;$('#table-filter').value='';renderTable();}else if(button.dataset.watch)toggleWatch(button.dataset.watch);else if(button.dataset.select)selectInstrument(button.dataset.select);else if(button.dataset.range){range=button.dataset.range;$$('#chart-range button').forEach(b=>{const active=b===button;b.classList.toggle('active',active);b.setAttribute('aria-pressed',active);});loadHistory();}else if(button.dataset.sort){sort={key:button.dataset.sort,order:sort.key===button.dataset.sort?-sort.order:1};renderTable();}else if(button.hasAttribute('data-close-dialog'))button.closest('dialog').close();}
  const option=event.target.closest('[data-result]');if(option)searchSelect(option.dataset.result);else if(!event.target.closest('.search-wrap'))closeSearch();
  if($('.sidebar').classList.contains('is-open')&&!event.target.closest('.sidebar')&&!event.target.closest('#menu-toggle'))setNavOpen(false);
});
$('#search-input').addEventListener('input',()=>{mainSearchVersion++;showSearch();clearTimeout(mainSearchTimer);mainSearchTimer=setTimeout(searchProvider,250);});
$('#search-input').addEventListener('keydown',event=>{
  if(event.key==='Escape'){closeSearch();return;}
  if(['ArrowDown','ArrowUp'].includes(event.key)&&searchMatches.length){event.preventDefault();if($('#search-results').hidden)showSearch();if(!searchMatches.length)return;searchIndex=searchIndex<0?(event.key==='ArrowDown'?0:searchMatches.length-1):(searchIndex+(event.key==='ArrowDown'?1:-1)+searchMatches.length)%searchMatches.length;$$('#search-results [role=option]').forEach((li,i)=>li.setAttribute('aria-selected',i===searchIndex));$('#search-input').setAttribute('aria-activedescendant',`search-option-${searchIndex}`);$(`#search-option-${searchIndex}`)?.scrollIntoView({block:'nearest'});}
  if(event.key==='Enter'&&searchIndex>=0){event.preventDefault();searchSelect(searchMatches[searchIndex].symbol);}
});
document.addEventListener('keydown',event=>{if(event.key==='/'&&!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)&&!$('dialog[open]')){event.preventDefault();$('#search-input').focus();}if(event.key==='Escape'){const open=$('.sidebar').classList.contains('is-open');setNavOpen(false);if(open)$('#menu-toggle').focus();closeSearch();}});
$('#table-filter').addEventListener('input',renderTable);
$('#export-csv').addEventListener('click',exportCsv);
$('#refresh-data').addEventListener('click',refresh);
$('#settings-open').addEventListener('click',openSettings);
$('#connect-data').addEventListener('click',openSettings);
$('#add-stock-open').addEventListener('click',openAddStock);
$('#topbar-add-stock').addEventListener('click',openAddStock);
$('#add-stock-form').addEventListener('submit',event=>{event.preventDefault();addStock($('#add-stock-input').value);});
$('#add-stock-input').addEventListener('input',()=>{addSearchVersion++;clearTimeout(addSearchTimer);const prefix=$('#add-stock-input').value.trim().toUpperCase().split(':')[0];if(markets[prefix]&&prefix!=='PH'&&$('#add-stock-input').value.includes(':')){$('#add-stock-market').value=prefix;updateAddMarket();}addSearchTimer=setTimeout(searchAddStocks,200);});
$('#add-stock-market').addEventListener('change',()=>{addSearchVersion++;clearTimeout(addSearchTimer);$('#add-stock-results').replaceChildren();$('#add-stock-error').hidden=true;updateAddMarket();searchAddStocks();});
$('#market-select').addEventListener('change',()=>{mainSearchVersion++;clearTimeout(mainSearchTimer);changeMarket($('#market-select').value);});
$('#connection-mode').addEventListener('change',updateSettingsMode);
for(const id of ['guide-open','footer-guide'])$(`#${id}`).addEventListener('click',()=>$('#guide-dialog').showModal());
$('#menu-toggle').addEventListener('click',()=>setNavOpen(!$('.sidebar').classList.contains('is-open')));
$$('dialog').forEach(dialog=>{dialog.addEventListener('keydown',event=>{if(event.key==='Escape'&&!event.isComposing){event.preventDefault();dialog.close();}});dialog.addEventListener('click',event=>{if(event.target===dialog){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close();}});});
window.addEventListener('offline',()=>{if(snapshot){cached=true;renderStatus();renderSummary();renderTable();updateDetail();}});
window.addEventListener('online',refresh);
window.addEventListener('resize',()=>{syncNavigation();clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{if(snapshot&&points.length)renderHistory();},150);});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&settings.mode==='gateway'){clearTimeout(timer);refresh();}});
syncNavigation();
renderMarketContext();
$('#today-date').textContent=date(new Date().toISOString(),{year:'numeric'});
try{seedCatalog=await requestJson(new URL('../data/catalog.json',import.meta.url));catalog=[...seedCatalog,...pinned];snapshot={mode:settings.mode,index:null,quotes:[],funds:[],etfs:[]};renderSummary();renderRadar();renderTable();updateDetail();renderHistory();
  if(['localhost','127.0.0.1','[::1]'].includes(location.hostname)){try{const status=await requestJson(new URL('/api/status',location.origin));localAvailable=status.provider==='EODHD';const publicBase=new URL(status.freeApiBase||'/api/public',location.origin);freeAvailable=status.freeAvailable===true&&publicBase.origin===location.origin&&publicBase.pathname==='/api/public';if(freeAvailable){freeApiBase=publicBase.href;freeSource=typeof status.freeSource==='string'?status.freeSource:'PSE EDGE';}if(settings.mode==='unconfigured'&&settings.autoConnect!==false&&(status.configured||freeAvailable)){settings={mode:'gateway',apiBase:status.configured?new URL('/api',location.origin).href:freeApiBase};writeStorage(SETTINGS,settings);api=new MarketApi(settings);}}catch{}}
  $('#local-mode-option').hidden=!localAvailable;$('#free-mode-option').hidden=!freeAvailable;await loadCatalog('PH');if(!['PH','ALL'].includes(selectedMarket))await loadCatalog(selectedMarket);if(selectedMarket!=='PH')selected=firstMarketInstrument();renderMarketContext();await refresh();}
catch{$('#market-status').textContent='The instrument catalog could not be loaded. Reload the page when your connection is available.';$('#data-banner').classList.add('is-error');}
