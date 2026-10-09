import { createFreePse } from './free-pse.mjs';
import { setDefaultResultOrder } from 'node:dns';
setDefaultResultOrder('ipv4first');

if (process.argv.includes('--parquet-global')) {
  const { readFile, writeFile } = await import('node:fs/promises');
  const { asyncBufferFromUrl, parquetMetadataAsync, parquetReadObjects } = await import('hyparquet');
  const { compressors } = await import('hyparquet-compressors');
  const base = 'https://maxgfr.github.io/crible/data/';
  const checkedFetch = async (url, options={}) => {
    const headers = new Headers(options.headers); headers.set('Accept-Encoding','identity');
    const response = await fetch(url, {...options,headers});
    console.log(options.method||'GET',String(url).split('/').at(-1),headers.get('Range'),response.status,response.headers.get('Content-Range'),response.headers.get('Content-Length'),response.headers.get('Content-Encoding'));
    return response;
  };
  const file = await asyncBufferFromUrl({ url: base+'universe.parquet', fetch:checkedFetch, requestInit: { signal: AbortSignal.timeout(15000) } });
  const metadata = await parquetMetadataAsync(file);
  console.log('Universe schema:', metadata.schema.map(s=>s.name));
  const records = await parquetReadObjects({file,metadata,compressors,columns:['symbol','name','currency','country','exchange','delisted'],filter:{symbol:{$in:['AAPL','MSFT','NVDA','0700.HK','7203.T','VOD.L','SHOP.TO','BHP.AX']}}});
  console.log(JSON.stringify(records, (_,v)=>typeof v==='bigint'?Number(v):v));
  await writeFile('artifacts/global-universe-records.json',JSON.stringify(records));
  const manifest = JSON.parse(await readFile('artifacts/crible-manifest.json','utf8'));
  for (const ticker of ['AAPL','0700.HK','7203.T','VOD.L','SHOP.TO','BHP.AX']) {
    const shard = manifest.prices.shards.find(s=>ticker>=s.min_symbol&&ticker<=s.max_symbol);
    const prices = await asyncBufferFromUrl({url:base+shard.file,byteLength:shard.bytes,fetch:checkedFetch,requestInit:{signal:AbortSignal.timeout(20000)}});
    const bars = await parquetReadObjects({file:prices,compressors,columns:['symbol','date','close','volume','source'],filter:{symbol:{$eq:ticker}}});
    console.log(ticker, JSON.stringify(bars.slice(-3),(_,v)=>typeof v==='bigint'?Number(v):v), 'bars:',bars.length);
    await writeFile(`artifacts/global-${ticker.replaceAll('.','-')}.json`,JSON.stringify(bars,(_,v)=>typeof v==='bigint'?Number(v):v));
  }
  process.exit();
}

if (process.argv.includes('--global-probe')) {
  const targets = [
    ['Yahoo US', 'https://query1.finance.yahoo.com/v8/finance/chart/AAPL?range=5d&interval=1d'],
    ['Yahoo HK', 'https://query2.finance.yahoo.com/v8/finance/chart/0700.HK?range=5d&interval=1d'],
    ['Stooq US', 'https://stooq.com/q/l/?s=aapl.us&f=sd2t2ohlcv&h&e=csv'],
    ['Crible mirror', 'https://api.github.com/repos/maxgfr/crible/releases/tags/data-latest'],
  ];
  await Promise.all(targets.map(async ([label, url]) => {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(12000), headers: { 'User-Agent': 'Tala-dashboard-source-check' } });
      const body = await response.text();
      console.log(`${label}: HTTP ${response.status} ${body.slice(0, 700)}`);
      if (label === 'Crible mirror' && response.ok) {
        const data = JSON.parse(body);
        console.log(JSON.stringify({ updated: data.published_at, assets: data.assets?.map(a => ({ name: a.name, size: a.size, url: a.browser_download_url })) }));
      }
    } catch (error) { console.log(`${label}: ${error.name} ${error.message}; ${error.cause?.code || ''} ${error.cause?.message || ''}`); }
  }));
  process.exit();
}

// Live, read-only verification of the free source. No account or API key.
if (process.argv.includes('--mirror-only')) {
  const response = await fetch('https://raw.githubusercontent.com/zhameersheraz/ph-stocks/main/stocks.json', { signal: AbortSignal.timeout(8000) });
  const data = await response.json();
  console.log(`Mirror connectivity: HTTP ${response.status}, ${data.stocks?.length} stocks, collected ${data.generated_utc} UTC`);
  process.exit(response.ok ? 0 : 1);
}
const source = createFreePse({ mirrorFallback: true, timeoutMs: 4000 });
for (const path of ['/catalog', '/quotes?symbols=BDO,AC', '/index/PSEI']) {
  const response = await source.handle(new Request(`http://127.0.0.1${path}`));
  const data = await response.json();
  if (!response.ok) {
    console.error(`${path}: HTTP ${response.status}, ${data.error?.code}`);
    process.exitCode = 1;
    continue;
  }
  if (data.instruments) console.log(`${data.source}: ${data.instruments.length} covered stocks`);
  for (const quote of data.quotes || (data.quote ? [data.quote] : [])) {
    console.log(`${quote.symbol}: ${quote.value} ${quote.currency}; as of ${quote.asOf}; ${quote.source}`);
  }
}
