/** Local operator import only. No network requests or website extraction. */
import { readFile, open, rename, unlink, mkdir } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const REQUIRED_FIELDS = ['id', 'name', 'category', 'currency', 'value', 'valueType', 'valuationDate', 'asOf'];
const ALLOWED_FIELDS = new Set([...REQUIRED_FIELDS, 'previousClose']);
const CATEGORY_NAMES = new Map(['Equity', 'Balanced', 'Bond', 'Money market'].map(value => [value.toLowerCase(), value]));
const DEMO_PATHS = ['demo.json', 'funds.json', 'catalog.json'].map(name => resolve(fileURLToPath(new URL(`../site/data/${name}`, import.meta.url))).toLowerCase());

function textField(value, name, maximum = 240) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximum || /[\u0000-\u001f]/u.test(value)) {
    throw new Error(`${name} must be a nonempty text string of at most ${maximum} characters.`);
  }
  return value.trim();
}

function positiveNumber(value, name) {
  if (value === null || value === undefined || typeof value === 'boolean'
    || (typeof value !== 'number' && typeof value !== 'string')
    || (typeof value === 'string' && (!value.trim() || !/^(?:\d+(?:\.\d*)?|\.\d+)$/u.test(value.trim())))) {
    throw new Error(`${name} must be a positive finite number; missing values cannot become zero.`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive finite number.`);
  return parsed;
}

function dateOnly(value, name) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw new Error(`${name} must be a YYYY-MM-DD calendar date.`);
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error(`${name} is not a valid calendar date.`);
  return value;
}

export function manilaDate(value) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(value);
}

function timestamp(value, name) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) {
    throw new Error(`${name} must be an ISO timestamp with an explicit timezone.`);
  }
  dateOnly(value.slice(0, 10), name);
  const match = value.match(/T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-](\d{2}):(\d{2}))$/u);
  if (Number(match[1]) > 23 || Number(match[2]) > 59 || Number(match[3]) > 59
    || (match[4] !== 'Z' && (Number(match[5]) > 14 || Number(match[6]) > 59 || (Number(match[5]) === 14 && Number(match[6]) !== 0)))) {
    throw new Error(`${name} is not a valid ISO timestamp.`);
  }
  const result = new Date(value);
  if (!Number.isFinite(result.getTime())) throw new Error(`${name} is not a valid ISO timestamp.`);
  return result;
}

/** RFC-4180-style commas, escaped quotes, CRLF and multiline quoted fields. */
export function parseCsv(input) {
  if (typeof input !== 'string') throw new Error('CSV input must be text.');
  const content = input.replace(/^\uFEFF/u, '');
  const rows = [];
  let row = [], field = '', quoted = false, closedQuote = false;
  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    if (quoted) {
      if (char === '"' && content[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') { quoted = false; closedQuote = true; }
      else field += char;
      continue;
    }
    if (char === '"') {
      if (field || closedQuote) throw new Error('Invalid CSV quote in an unquoted field.');
      quoted = true;
    } else if (char === ',') { row.push(field); field = ''; closedQuote = false; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && content[i + 1] === '\n') i++;
      row.push(field);
      if (row.some(value => value.trim())) rows.push(row);
      row = []; field = ''; closedQuote = false;
    } else {
      if (closedQuote) throw new Error('Unexpected text after a closing CSV quote.');
      field += char;
    }
  }
  if (quoted) throw new Error('Unterminated quoted CSV field.');
  row.push(field);
  if (row.some(value => value.trim())) rows.push(row);
  if (rows.length < 2) throw new Error('CSV must contain a header and at least one fund row.');
  const headers = rows.shift().map(value => value.trim());
  if (headers.some(value => !value) || new Set(headers).size !== headers.length) throw new Error('CSV headers must be nonempty and unique.');
  if (headers.some(value => !ALLOWED_FIELDS.has(value))) throw new Error('CSV contains unexpected columns; verify the source schema.');
  if (REQUIRED_FIELDS.some(value => !headers.includes(value))) throw new Error(`CSV is missing required columns: ${REQUIRED_FIELDS.filter(value => !headers.includes(value)).join(', ')}.`);
  return rows.map((cells, index) => {
    if (cells.length !== headers.length) throw new Error(`CSV row ${index + 2} has ${cells.length} cells; expected ${headers.length}.`);
    return Object.fromEntries(headers.map((header, column) => [header, cells[column]]));
  });
}

export function parseFundInput(input, format) {
  if (format === '.csv' || format === 'csv') return parseCsv(input);
  if (format !== '.json' && format !== 'json') throw new Error('Input must be a .csv or .json file.');
  let result;
  try { result = JSON.parse(input); } catch { throw new Error('Input is not valid JSON.'); }
  return Array.isArray(result) ? result : result?.funds;
}

export function normalizeFundImport(rows, options) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('Import must contain at least one fund row.');
  if (!options || options.approvedForPublicDisplay !== true) throw new Error('Public display approval must be explicitly acknowledged.');
  const sourceName = textField(options.sourceName, 'sourceName');
  const permissionReference = textField(options.permissionReference, 'permissionReference', 500);
  const sourceUrl = textField(options.sourceUrl, 'sourceUrl', 1000);
  let parsedUrl;
  try { parsedUrl = new URL(sourceUrl); } catch { throw new Error('sourceUrl must be an HTTPS source URL.'); }
  if (parsedUrl.protocol !== 'https:' || parsedUrl.username || parsedUrl.password || !parsedUrl.hostname) throw new Error('sourceUrl must be an HTTPS source URL without credentials.');
  if (!Number.isSafeInteger(options.expectedCount) || options.expectedCount < 1 || options.expectedCount !== rows.length) {
    throw new Error(`Row count mismatch: received ${rows.length}; specify the independently verified positive expectedCount.`);
  }
  const now = options.now === undefined ? new Date() : new Date(options.now);
  if (!Number.isFinite(now.getTime())) throw new Error('Invalid import clock.');
  const today = manilaDate(now);
  const ids = new Set();
  const funds = rows.map((raw, index) => {
    const label = `Fund row ${index + 1}`;
    if (!raw || Array.isArray(raw) || typeof raw !== 'object') throw new Error(`${label} must be an object.`);
    if (Object.keys(raw).some(key => !ALLOWED_FIELDS.has(key))) throw new Error(`${label} contains unexpected fields; verify the source schema.`);
    for (const key of REQUIRED_FIELDS) if (raw[key] === null || raw[key] === undefined) throw new Error(`${label}: missing required ${key}.`);
    const id = textField(raw.id, `${label} id`, 80);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id)) throw new Error(`${label} id must be a lowercase slug.`);
    if (ids.has(id)) throw new Error(`Duplicate fund id: ${id}.`);
    ids.add(id);
    const name = textField(raw.name, `${label} name`);
    const category = CATEGORY_NAMES.get(textField(raw.category, `${label} category`).toLowerCase());
    if (!category) throw new Error(`${label} category must be Equity, Balanced, Bond or Money market.`);
    if (raw.currency !== 'PHP') throw new Error(`${label} currency must be PHP.`);
    if (!['NAVPS', 'NAVPU'].includes(raw.valueType)) throw new Error(`${label} valueType must be NAVPS or NAVPU.`);
    const value = positiveNumber(raw.value, `${label} value`);
    const valuationDate = dateOnly(raw.valuationDate, `${label} valuationDate`);
    const asOfDate = timestamp(raw.asOf, `${label} asOf`);
    if (asOfDate.getTime() > now.getTime()) throw new Error(`${label} asOf is in the future.`);
    if (valuationDate > today || valuationDate > manilaDate(asOfDate)) throw new Error(`${label} valuationDate is in the future relative to the Manila import/asOf date.`);
    const previousClose = raw.previousClose === undefined || raw.previousClose === null
      ? null : positiveNumber(raw.previousClose, `${label} previousClose`);
    const change = previousClose === null ? null : Number((value - previousClose).toFixed(8));
    const changePercent = previousClose === null ? null : Number(((value / previousClose - 1) * 100).toFixed(8));
    if (change !== null && (!Number.isFinite(change) || !Number.isFinite(changePercent))) throw new Error(`${label} comparison exceeds the numeric range.`);
    return {
      id, name, category, assetType: 'mutual_fund', currency: 'PHP', value, valueType: raw.valueType,
      previousClose, change, changePercent, valuationDate,
      asOf: raw.asOf, freshness: 'daily_nav', source: sourceName,
    };
  });
  return {
    mode: 'approved_import', generatedAt: now.toISOString(), source: sourceName,
    provenance: { sourceName, sourceUrl, permissionReference, approvedForPublicDisplay: true },
    funds,
  };
}

export async function writeFundImport(outputPath, payload) {
  if (typeof outputPath !== 'string' || !outputPath.trim()) throw new Error('An explicit output path is required.');
  const destination = resolve(outputPath);
  if (extname(destination).toLowerCase() !== '.json') throw new Error('Output must be a .json file.');
  if (DEMO_PATHS.includes(destination.toLowerCase())) throw new Error('Bundled demo data cannot be overwritten. Choose a separate approved-fund output file.');
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, destination);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  return destination;
}

const help = `Import an operator-supplied local CSV/JSON from a source approved for public display.
No fetching or scraping is performed. This acknowledgment records an operator decision;
the program cannot determine whether a license actually grants those rights.

Usage:
  node scripts/import-funds.mjs --input <local.csv|json> --output <approved-funds.json>
    --source-name <name> --source-url <https://source.example/nav>
    --permission-reference <agreement or permission reference>
    --approved-for-public-display --expected-count <verified number of rows>

Required row fields: id,name,category,currency,value,valueType,valuationDate,asOf
Optional: previousClose (null/absent means unknown change, never zero)
Category: Equity | Balanced | Bond | Money market; currency: PHP
Value type: NAVPS | NAVPU; valuationDate: YYYY-MM-DD; asOf: ISO timestamp with zone
JSON: array of row objects or {"funds":[row objects]}; CSV: same column names
All NAVs must be positive finite numbers. Future dates/times, duplicate IDs,
unknown columns and row-count mismatches fail the entire import.
Output is atomic and requires an explicit path. Bundled sample JSON is protected.
To enable approved data, publish the separate output and configure the data service;
the fictional site/data/funds.json is never a production fallback.
`;

export async function runCli(args = process.argv.slice(2)) {
  if (args.includes('--help') || args.includes('-h')) { console.log(help); return; }
  const allowed = new Set(['input', 'output', 'source-name', 'source-url', 'permission-reference', 'expected-count']);
  const flags = {};
  let approvedForPublicDisplay = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--approved-for-public-display') {
      if (approvedForPublicDisplay) throw new Error('Duplicate approval flag.');
      approvedForPublicDisplay = true; continue;
    }
    const key = args[i].startsWith('--') ? args[i].slice(2) : '';
    if (!allowed.has(key) || Object.hasOwn(flags, key)) throw new Error(`Unknown or duplicate argument: ${args[i]}. Use --help.`);
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${key}.`);
    flags[key] = value;
  }
  for (const key of allowed) if (!flags[key]) throw new Error(`Required --${key} is missing. Use --help.`);
  if (!/^\d+$/u.test(flags['expected-count'])) throw new Error('--expected-count must be a positive integer.');
  const inputPath = resolve(flags.input), outputPath = resolve(flags.output);
  if (inputPath.toLowerCase() === outputPath.toLowerCase()) throw new Error('Input and output must be different files.');
  const input = await readFile(inputPath, 'utf8');
  const rows = parseFundInput(input, extname(inputPath).toLowerCase());
  const payload = normalizeFundImport(rows, {
    sourceName: flags['source-name'], sourceUrl: flags['source-url'],
    permissionReference: flags['permission-reference'], approvedForPublicDisplay,
    expectedCount: Number(flags['expected-count']),
  });
  const destination = await writeFundImport(outputPath, payload);
  console.log(`Validated ${payload.funds.length} approved-source fund rows. Wrote ${destination}. Valuation dates preserved.`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runCli().catch(error => { console.error(`Fund import rejected: ${error.message}`); process.exitCode = 1; });
}
