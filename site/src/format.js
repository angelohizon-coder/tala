const numberFormat = new Intl.NumberFormat('en-PH', { minimumFractionDigits:2, maximumFractionDigits:2 });
export function number(value, digits = 2) {
  if (!Number.isFinite(value)) return '—';
  return digits === 2 ? numberFormat.format(value) : new Intl.NumberFormat('en-PH',{minimumFractionDigits:digits,maximumFractionDigits:digits}).format(value);
}
export function signed(value, digits = 2) { return Number.isFinite(value) ? `${value > 0 ? '+' : value < 0 ? '−' : ''}${number(Math.abs(value), digits)}` : '—'; }
export function percent(value) { return Number.isFinite(value) ? `${signed(value)}%` : '—'; }
export function direction(value) { return Number.isFinite(value) ? value > 0 ? 'up' : value < 0 ? 'down' : 'flat' : 'flat'; }
export function arrow(value) { return Number.isFinite(value) ? value > 0 ? '↗' : value < 0 ? '↘' : '–' : ''; }
export function compact(value) { return Number.isFinite(value) ? new Intl.NumberFormat('en-PH',{notation:'compact',maximumFractionDigits:1}).format(value) : '—'; }
export function currencyNumber(value, currency = 'PHP', digits = 2) {
  if (!Number.isFinite(value)) return '—';
  return `${currency === 'PHP' ? '₱' : currency + ' '}${number(value, digits)}`;
}
export function date(value, options = {}) {
  if (!value) return 'Date unavailable';
  const calendarDate = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const d = new Date(calendarDate ? `${value}T12:00:00Z` : value);
  if (!Number.isFinite(d.getTime())) return 'Date unavailable';
  const formatOptions = {timeZone:'Asia/Manila',day:'2-digit',month:'short',...options};
  if (calendarDate) formatOptions.timeZone = 'UTC';
  try { return new Intl.DateTimeFormat('en-PH', formatOptions).format(d); }
  catch { return new Intl.DateTimeFormat('en-PH', {...formatOptions,timeZone:'UTC'}).format(d); }
}
export function timestamp(value, timeZone = 'Asia/Manila') {
  if (!value || !Number.isFinite(Date.parse(value))) return 'Timestamp unavailable';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return date(value,{year:'numeric'}) + ' · market date';
  if (timeZone === 'Asia/Manila') return date(value,{hour:'2-digit',minute:'2-digit',year:'numeric',hour12:false}) + ' PHT';
  return date(value,{timeZone,hour:'2-digit',minute:'2-digit',year:'numeric',hour12:false,timeZoneName:'short'});
}
export function freshness(quote, { cached = false, now = Date.now() } = {}) {
  if (!quote) return 'Unavailable';
  if (quote.freshness === 'unavailable' || !Number.isFinite(quote.value)) return 'Unavailable';
  if (quote.freshness === 'suspended' || /suspended/i.test(quote.tradingStatus||'')) return cached ? 'Cached suspended snapshot' : 'Suspended snapshot';
  if (quote.freshness === 'demo') return cached ? 'Cached sample' : 'Sample data';
  if (quote.assetType === 'mutual_fund' || quote.freshness === 'daily_nav') return cached ? 'Cached daily NAV' : 'Daily NAV';
  if (quote.freshness === 'snapshot') {
    const age = now - Date.parse(quote.asOf);
    const label = !Number.isFinite(age) || age < -60_000 || age > 72*60*60_000 ? 'Stale snapshot' : 'Market snapshot';
    return cached ? `Cached ${label.toLowerCase()}` : label;
  }
  if (quote.freshness === 'eod') return cached ? 'Cached end of day' : 'End of day';
  if (cached) return 'Cached · stale';
  const age = now - Date.parse(quote.asOf);
  if (!Number.isFinite(age) || age > ((quote.delayMinutes || 0) + 10) * 60_000 || age < -60_000) return 'Stale';
  if (quote.freshness === 'delayed') return `~${quote.delayMinutes || 20} min delayed`;
  return ['realtime','real_time'].includes(quote.freshness) ? 'Real time' : 'Timestamped quote';
}
export function filterPoints(points, range) {
  if (!Array.isArray(points)) return [];
  const valid = points.filter(p => /^\d{4}-\d{2}-\d{2}$/.test(p.date) && Number.isFinite(p.close)).sort((a,b)=>a.date.localeCompare(b.date));
  if (!valid.length) return [];
  const days = { '1w':7, '1m':31, '3m':93, '1y':366 }[range] || 31;
  const cutoff = Date.parse(valid.at(-1).date) - days*86_400_000;
  return valid.filter(p=>Date.parse(p.date) >= cutoff);
}
export function csvCell(value) { return `"${String(value ?? '').replace(/^(?:[\t\r\n]|[ \t\r\n]*[=+@-])/, "'$&").replaceAll('"','""')}"`; }
