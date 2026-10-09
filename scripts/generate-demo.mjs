/** Deterministic fictional prices. This script never requests market data. */
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const outputDirectory = fileURLToPath(new URL('../site/data/', import.meta.url));
const generatedAt = '2026-10-08T07:00:00Z';
const marketDate = '2026-10-08';
const source = 'Illustrative sample';
const catalog = [
  ['AC', 'Ayala Corporation', 'Conglomerates', 623, 617, 438100],
  ['BDO', 'BDO Unibank', 'Banks', 146.4, 144.7, 2650400],
  ['SM', 'SM Investments Corporation', 'Conglomerates', 874, 880, 469820],
  ['SMPH', 'SM Prime Holdings', 'Property', 28.6, 28.15, 7814000],
  ['ALI', 'Ayala Land', 'Property', 29.35, 29.8, 8629400],
  ['BPI', 'Bank of the Philippine Islands', 'Banks', 127.3, 125.8, 1836200],
  ['MBT', 'Metropolitan Bank & Trust', 'Banks', 72.65, 72.9, 3319000],
  ['JFC', 'Jollibee Foods Corporation', 'Consumer', 242.4, 240.2, 798430],
  ['TEL', 'PLDT', 'Telecommunications', 1335, 1344, 73970],
  ['GLO', 'Globe Telecom', 'Telecommunications', 2170, 2156, 48930],
  ['ICT', 'International Container Terminal Services', 'Industrials', 389.8, 383.6, 1274700],
  ['URC', 'Universal Robina Corporation', 'Consumer', 94.8, 96.15, 961020],
  ['AEV', 'Aboitiz Equity Ventures', 'Conglomerates', 42.8, 42.6, 2196300],
  ['AP', 'Aboitiz Power Corporation', 'Utilities', 38.55, 38.1, 1858900],
  ['MER', 'Manila Electric Company', 'Utilities', 469.6, 472.8, 448200],
  ['CNVRG', 'Converge ICT Solutions', 'Telecommunications', 15.28, 15.02, 3591500],
  ['MONDE', 'Monde Nissin Corporation', 'Consumer', 8.12, 8.28, 12982000],
  ['DMC', 'DMCI Holdings', 'Conglomerates', 11.47, 11.34, 5341800],
  ['LTG', 'LT Group', 'Conglomerates', 10.02, 10.02, 4067600],
  ['FMETF', 'First Metro Philippine Equity Exchange Traded Fund', 'Exchange-traded fund', 110.4, 109.65, 21000],
].map(([symbol, name, sector, value, previousClose, volume]) => ({
  symbol, name, sector, value, previousClose, volume,
  assetType: symbol === 'FMETF' ? 'etf' : 'stock',
}));

const rounded = (value, decimals = 4) => Number(value.toFixed(decimals));
const changeFields = (value, previousClose) => ({
  previousClose,
  change: rounded(value - previousClose),
  changePercent: rounded((value / previousClose - 1) * 100),
});
const quote = ({ symbol, name, assetType, value, previousClose, volume }) => ({
  symbol, name, assetType, currency: 'PHP', value,
  valueType: assetType === 'index' ? 'index_level' : 'last_trade',
  ...changeFields(value, previousClose), volume,
  asOf: generatedAt, marketDate, freshness: 'demo', delayMinutes: null, source,
});
const index = quote({
  symbol: 'PSEI', name: 'Philippine Stock Exchange Index', assetType: 'index',
  value: 6842.37, previousClose: 6799.51, volume: null,
});
const quotes = catalog.map(quote);
const funds = [
  ['sample-equity-growth', 'Sample Equity Growth Fund', 'Equity', 3.4821, 3.4512, 'NAVPS'],
  ['sample-equity-index', 'Sample Philippine Index Fund', 'Equity', 1.9564, 1.9408, 'NAVPU'],
  ['sample-balanced-opportunity', 'Sample Balanced Opportunity Fund', 'Balanced', 2.1547, 2.1601, 'NAVPS'],
  ['sample-balanced-income', 'Sample Balanced Income Fund', 'Balanced', 1.4826, 1.4792, 'NAVPU'],
  ['sample-bond-stability', 'Sample Peso Bond Stability Fund', 'Bond', 1.2748, 1.2729, 'NAVPS'],
  ['sample-bond-income', 'Sample Peso Bond Income Fund', 'Bond', 2.7614, 2.7631, 'NAVPU'],
  ['sample-money-market', 'Sample Peso Money Market Fund', 'Money market', 1.1326, 1.1325, 'NAVPS'],
  ['sample-cash-reserve', 'Sample Cash Reserve Fund', 'Money market', 1.0843, 1.0842, 'NAVPU'],
].map(([id, name, category, value, previousClose, valueType]) => ({
  id, name, category, assetType: 'mutual_fund', currency: 'PHP', value, valueType,
  ...changeFields(value, previousClose),
  valuationDate: '2026-10-07', asOf: '2026-10-07T10:00:00Z',
  freshness: 'demo', source,
}));

function weekdays(endingDate) {
  const end = new Date(`${endingDate}T12:00:00Z`);
  const start = new Date(end);
  start.setUTCFullYear(start.getUTCFullYear() - 1);
  const dates = [];
  for (let date = new Date(start); date <= end; date.setUTCDate(date.getUTCDate() + 1)) {
    if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6) dates.push(date.toISOString().slice(0, 10));
  }
  return dates;
}

function history(id, endingValue, previousClose, endingDate, decimals = 4, category = '') {
  const dates = weekdays(endingDate);
  const seed = [...id].reduce((total, character) => (total * 31 + character.charCodeAt(0)) >>> 0, 17);
  let randomState = seed || 1;
  const random = () => {
    randomState ^= randomState << 13;
    randomState ^= randomState >>> 17;
    randomState ^= randomState << 5;
    return (randomState >>> 0) / 4294967296;
  };
  const phase = (seed % 97) / 13;
  const moneyMarket = category === 'Money market';
  const bond = category === 'Bond';
  const balanced = category === 'Balanced';
  const indexLike = id === 'PSEI' || id === 'FMETF';
  const annualDrift = moneyMarket ? 0.026 : bond ? 0.04 : indexLike ? 0.115 : ((seed % 37) - 12) / 100;
  const dailyNoise = moneyMarket ? 0.000025 : bond ? 0.00075 : balanced ? 0.0038 : indexLike ? 0.0072 : 0.011;
  const cycleDrift = moneyMarket ? 0 : bond ? 0.0001 : 0.0008;
  // A seeded weekday random walk produces different short and long movements.
  // Bridge the walk to the prior close, then append the quoted final session.
  const priorIndex = dates.length - 2;
  const logarithms = [0];
  for (let i = 1; i <= priorIndex; i++) {
    const t = i / priorIndex;
    const noise = (random() + random() + random() - 1.5) * dailyNoise;
    const cycle = Math.sin(t * Math.PI * (4 + seed % 3) + phase) * cycleDrift;
    logarithms.push(logarithms[i - 1] + annualDrift / priorIndex + noise + cycle);
  }
  const bridgeAdjustment = annualDrift - logarithms[priorIndex];
  const values = dates.slice(0, -1).map((date, i) => ({
    date,
    close: rounded(previousClose * Math.exp(logarithms[i] + bridgeAdjustment * i / priorIndex - annualDrift), decimals),
  }));
  values[priorIndex].close = previousClose;
  values.push({ date: dates.at(-1), close: endingValue });
  return values;
}

const histories = Object.fromEntries([
  [index.symbol, history(index.symbol, index.value, index.previousClose, marketDate, 2)],
  ...quotes.map(item => [item.symbol, history(item.symbol, item.value, item.previousClose, marketDate, 2)]),
  ...funds.map(item => [item.id, history(item.id, item.value, item.previousClose, item.valuationDate, 4, item.category)]),
]);
const etfs = [{
  quote: quotes.find(item => item.symbol === 'FMETF'),
  nav: {
    value: 111.0834, valueType: 'iNAV', asOf: '2026-10-08T06:45:00Z',
    valuationDate: marketDate, source,
  },
}];
const notice = 'All prices, NAVs, changes, volumes and histories are fictional illustrative samples. They are not actual market observations.';
const demo = { mode: 'demo', generatedAt, marketDate, notice, index, quotes, funds, etfs, histories };
const fundEnvelope = {
  mode: 'demo', generatedAt, source, notice,
  provenance: { sourceName: source, sourceUrl: null, permissionReference: null, approvedForPublicDisplay: false },
  funds,
};
await mkdir(outputDirectory, { recursive: true });
await Promise.all([
  writeFile(new URL('../site/data/catalog.json', import.meta.url), `${JSON.stringify(catalog.map(({ symbol, name, assetType, sector }) => ({ symbol, name, assetType, sector })), null, 2)}\n`),
  writeFile(new URL('../site/data/demo.json', import.meta.url), `${JSON.stringify(demo, null, 2)}\n`),
  writeFile(new URL('../site/data/funds.json', import.meta.url), `${JSON.stringify(fundEnvelope, null, 2)}\n`),
]);
console.log('Generated fictional demo fixtures: 20 quotes, 8 sample funds, 29 deterministic histories.');
