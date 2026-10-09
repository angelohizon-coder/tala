import { saveCache, loadCache } from './cache.js';
import { filterPoints } from './format.js';

export class DataError extends Error {
  constructor(message,status = 0,retryAfter = null,code = null) { super(message); this.status=status; this.retryAfter=retryAfter; this.code=code; }
}
export function validateApiUrl(raw) {
  const u = new URL(raw);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(u.hostname))) throw new Error('Use an HTTPS gateway URL.');
  if (u.username || u.password || u.search || u.hash) throw new Error('Use the gateway base URL without credentials, a query, or a fragment.');
  return u.href.replace(/\/$/,'');
}
export function normalizeStockSymbol(raw, market='PH') {
  if (typeof raw !== 'string') throw new Error('Enter a stock symbol.');
  let symbol=raw.trim().toUpperCase();
  const qualified=/^(PH|US|HK|JP|GB|CA|AU):(.+)$/.exec(symbol);
  if(qualified){market=qualified[1];symbol=qualified[2];}
  const suffix={PH:'.PSE',US:'',HK:'.HK',JP:'.T',GB:'.L',CA:'.TO',AU:'.AX'}[market];
  if(suffix===undefined)throw new Error('Choose a supported stock market.');
  if(suffix&&symbol.endsWith(suffix))symbol=symbol.slice(0,-suffix.length);
  if(market==='HK'&&/^\d{1,5}$/.test(symbol))symbol=symbol.padStart(4,'0');
  if (!/^[A-Z0-9][A-Z0-9.-]{0,14}$/.test(symbol) || /\.\.|--|[.-]$/.test(symbol) || symbol==='PSEI' || (market==='HK'&&!/^\d{4,5}$/.test(symbol))) throw new Error('Enter a valid stock symbol for the selected market.');
  return market==='PH'?symbol:`${market}:${symbol}`;
}
export async function requestJson(url, signal) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort(); else signal?.addEventListener('abort',abort,{once:true});
  const timer = setTimeout(abort,10_000);
  try {
    const response = await fetch(url,{signal:controller.signal,headers:{Accept:'application/json'}});
    if (!response.ok) {
      let retryAfter = Number(response.headers.get('Retry-After'));
      if (!Number.isFinite(retryAfter) || retryAfter <= 0) retryAfter = null;
      let code=null;
      try{const body=await response.json();if(['service_configuration','license_required','origin_forbidden','invalid_request','coverage_unavailable','source_unavailable','source_timeout','unknown_symbol','rate_limited','stale_source','unit_unavailable'].includes(body.error?.code))code=body.error.code;}catch{}
      throw new DataError(response.status === 429 ? 'Data service rate limit reached.' : [401,403].includes(response.status)||['service_configuration','license_required'].includes(code) ? 'Data service configuration error.' : 'Data service unavailable.',response.status,retryAfter ? Math.min(600,retryAfter) : null,code);
    }
    try { return await response.json(); }
    catch { throw new DataError('Data service returned an invalid response.'); }
  } catch (error) {
    if (error.name === 'AbortError') throw new DataError('Data request timed out.');
    throw error;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort',abort); }
}
export class MarketApi {
  constructor(settings) { this.settings = settings; this.demo = null; this.instruments=null; this.catalogs=new Map(); this.cacheKey = `psedash:cache:${settings.mode}:${settings.apiBase || ''}`; }
  async catalog(query='',market='PH') {
    if(this.settings.mode!=='gateway')return {instruments:[],source:null,asOf:null};
    if(!['PH','US','HK','JP','GB','CA','AU'].includes(market))throw new DataError('Choose a supported market.');
    const q=query.trim().toLowerCase(),remote=market!=='PH'&&q!=='';
    const mapKey=remote?`${market}:${q}`:market;
    const key=`${this.cacheKey}:catalog${market==='PH'?'':`:${mapKey}`}`;
    const filtered=data=>remote?data:{...data,instruments:data.instruments.filter(i=>`${i.symbol} ${i.name}`.toLowerCase().includes(q))};
    if(this.catalogs.has(mapKey))return filtered(this.catalogs.get(mapKey));
    try{
      const params=market==='PH'?'':`?market=${market}${remote?`&q=${encodeURIComponent(query.trim())}`:''}`;
      const data=await requestJson(validateApiUrl(this.settings.apiBase)+'/catalog'+params);
      if(!Array.isArray(data.instruments)||data.instruments.some(i=>!i||typeof i.symbol!=='string'||typeof i.name!=='string'||!['stock','etf'].includes(i.assetType)||i.currency!==({PH:'PHP',US:'USD',HK:'HKD',JP:'JPY',GB:'GBP',CA:'CAD',AU:'AUD'}[market])||normalizeStockSymbol(i.symbol)!==i.symbol||(i.symbol.includes(':')?i.symbol.split(':')[0]:'PH')!==market||(i.market&&i.market!==market)))throw new DataError('The provider stock catalog is invalid.');
      if(market==='PH')this.instruments=data;
      if(this.catalogs.size>=80)this.catalogs.delete(this.catalogs.keys().next().value);
      this.catalogs.set(mapKey,data);saveCache(key,data);return filtered(data);
    }catch(error){const cached=loadCache(key,remote?600_000:86_400_000);if(cached?.data?.instruments){const data={...cached.data,cached:true};if(market==='PH')this.instruments=data;this.catalogs.set(mapKey,data);return filtered(data);}throw error;}
  }
  async quote(symbol) {
    const normalized=normalizeStockSymbol(symbol);
    if(this.settings.mode!=='gateway')return this.demo?.quotes?.find(q=>q.symbol===normalized)||null;
    const data=await requestJson(validateApiUrl(this.settings.apiBase)+`/quotes?symbols=${encodeURIComponent(normalized)}`);
    const quote=data.quotes?.find(q=>q.symbol===normalized);
    if(!quote||!Number.isFinite(quote.value))throw new DataError('No quote is available for this stock.',0,null,data.issues?.find(i=>i.symbol===normalized)?.code||null);
    return quote;
  }
  async snapshot(catalog) {
    if(this.settings.mode==='unconfigured')return {data:{mode:'unconfigured',index:null,quotes:[],funds:[],etfs:[],generatedAt:null},cached:false};
    try {
      if (!navigator.onLine) throw new DataError('Offline');
      let data;
      if (this.settings.mode === 'demo') {
        data = await requestJson(new URL('../data/demo.json',import.meta.url));
        if (data.mode !== 'demo' || !Array.isArray(data.quotes) || !data.index) throw new DataError('Sample dataset is invalid.');
        this.demo = data;
      } else {
        const base = validateApiUrl(this.settings.apiBase);
        const symbols=[...new Set(catalog.map(q=>normalizeStockSymbol(q.symbol)))];
        const quoteRequest=(async()=>{const quotes=[],issues=[];let generatedAt=null,coverage=null,lastError=null;for(let offset=0;offset<symbols.length;offset+=20){const requested=symbols.slice(offset,offset+20);try{const batch=await requestJson(base+`/quotes?symbols=${encodeURIComponent(requested.join(','))}`);if(!Array.isArray(batch.quotes))throw new DataError('Invalid quote response.');quotes.push(...batch.quotes);generatedAt=batch.generatedAt||generatedAt;coverage=batch.coverage||coverage;issues.push(...(batch.issues||[]).map(i=>typeof i==='string'?i:`${i.symbol}: ${i.message||'Quote unavailable'}`));}catch(error){lastError=error;issues.push(...requested.map(s=>`${s}: ${error.message}`));}}if(symbols.length&&!quotes.length&&lastError)throw lastError;return{quotes,generatedAt,coverage,issues};})();
        const responses = await Promise.allSettled([quoteRequest,...['/index/PSEI','/funds','/etf/FMETF'].map(p=>requestJson(base+p))]);
        if (responses[0].status !== 'fulfilled' || !Array.isArray(responses[0].value.quotes)) throw responses[0].reason || new DataError('Invalid quote response.');
        const validFunds=Array.isArray(responses[2].value?.funds);
        data = { mode:'gateway',generatedAt:responses[0].value.generatedAt,coverage:responses[0].value.coverage||this.instruments?.coverage||null,quotes:responses[0].value.quotes,index:responses[1].value?.quote || null,funds:validFunds ? responses[2].value.funds : [],etfs:responses[3].value?.quote ? [responses[3].value] : [],issues:[...responses[0].value.issues,...responses.slice(1).flatMap((r,i)=>r.status==='rejected' || (i===1&&!validFunds) || (i===0&&!r.value?.quote) || (i===2&&!r.value?.nav) ? [`${['PSEi','Fund NAVs','ETF NAV'][i]} unavailable`] : [])] };
      }
      saveCache(this.cacheKey,data);
      return { data,cached:false };
    } catch (error) {
      const cached = loadCache(this.cacheKey);
      if (cached) { if (cached.data.mode === 'demo') this.demo=cached.data; return {data:cached.data,cached:true,error}; }
      throw error;
    }
  }
  async history(id, range, isFund = false) {
    if(this.settings.mode==='unconfigured')return {symbol:id,points:[],source:null,freshness:'unavailable'};
    if (this.settings.mode === 'demo') return {symbol:id,points:filterPoints(this.demo?.histories?.[id] || [],range),source:'Illustrative sample',freshness:'demo'};
    const path = isFund ? `/funds/${encodeURIComponent(id)}/history` : `/history/${encodeURIComponent(id)}`;
    const key = `${this.cacheKey}:history:${id}:${range}`;
    try {
      const data = await requestJson(validateApiUrl(this.settings.apiBase)+path+`?range=${range}`);
      if (!Array.isArray(data.points)) throw new DataError('Invalid history response.');
      saveCache(key,data); return data;
    } catch (error) {
      const cached=loadCache(key,86_400_000);
      if (cached) return {...cached.data,cached:true};
      throw error;
    }
  }
}
