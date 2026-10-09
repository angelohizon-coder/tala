import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv, parseFundInput, normalizeFundImport, writeFundImport, manilaDate } from '../scripts/import-funds.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const readData = name => readFile(new URL(`../site/data/${name}`, import.meta.url), 'utf8').then(JSON.parse);
const row = () => ({
  id: 'approved-equity', name: 'Operator Test Fund', category: 'Equity', currency: 'PHP',
  value: 1.2456, valueType: 'NAVPS', previousClose: 1.2312,
  valuationDate: '2026-10-08', asOf: '2026-10-09T07:00:00+08:00',
});
const options = (count = 1) => ({
  sourceName: 'Approved test manager', sourceUrl: 'https://example.com/nav',
  permissionReference: 'Test public-display agreement', approvedForPublicDisplay: true,
  expectedCount: count, now: '2026-10-09T00:00:00Z',
});

test('fictional dataset is complete, internally consistent and explicitly labeled', async () => {
  const [demo, catalog, funds] = await Promise.all(['demo.json', 'catalog.json', 'funds.json'].map(readData));
  assert.equal(demo.mode, 'demo');
  assert.match(demo.notice, /fictional/);
  assert.equal(catalog.length, 20);
  assert.equal(demo.quotes.length, 20);
  assert.equal(demo.funds.length, 8);
  assert.equal(new Set(catalog.map(item => item.symbol)).size, 20);
  assert.deepEqual(new Set(catalog.map(item => item.symbol)), new Set(demo.quotes.map(item => item.symbol)));
  assert.equal(funds.mode, 'demo');
  assert.equal(funds.provenance.approvedForPublicDisplay, false);
  assert.deepEqual(funds.funds, demo.funds);
  const instruments = [demo.index, ...demo.quotes, ...demo.funds];
  for (const item of instruments) {
    assert.equal(item.currency, 'PHP');
    assert.equal(item.freshness, 'demo');
    assert.equal(item.source, 'Illustrative sample');
    assert.ok(item.value > 0);
    assert.ok(Math.abs(item.change - (item.value - item.previousClose)) < 0.00011);
    assert.ok(Math.abs(item.changePercent - (item.value / item.previousClose - 1) * 100) < 0.00011);
    if (item.id) assert.match(item.name, /^Sample /);
    const history = demo.histories[item.symbol ?? item.id];
    assert.ok(history.length > 250 && history.length < 265);
    assert.equal(history.at(-1).close, item.value);
    assert.equal(history.at(-2).close, item.previousClose);
    assert.ok(Math.abs(history.at(-1).close - history.at(-2).close - item.change) < 0.00011);
    assert.equal(history.at(-1).date, item.valuationDate ?? item.marketDate);
    let previousDate = '';
    for (const point of history) {
      assert.ok(point.date > previousDate);
      assert.ok(point.close > 0);
      assert.ok(![0, 6].includes(new Date(`${point.date}T12:00:00Z`).getUTCDay()));
      previousDate = point.date;
    }
  }
  assert.notEqual(demo.etfs[0].quote.asOf, demo.etfs[0].nav.asOf);
  assert.notEqual(demo.etfs[0].quote.value, demo.etfs[0].nav.value);
  assert.deepEqual(demo.etfs[0].quote, demo.quotes.find(item => item.symbol === 'FMETF'));
});

test('valid import preserves valuation date, provenance and independently timestamped NAV', () => {
  const result = normalizeFundImport([row()], options());
  assert.equal(result.mode, 'approved_import');
  assert.equal(result.provenance.approvedForPublicDisplay, true);
  assert.equal(result.funds[0].valuationDate, '2026-10-08');
  assert.equal(result.funds[0].asOf, row().asOf);
  assert.equal(result.funds[0].freshness, 'daily_nav');
  assert.equal(result.funds[0].source, 'Approved test manager');
});

test('absent previous close stays unknown and never becomes a zero price/change', () => {
  for (const previousClose of [null, undefined]) {
    const fund = normalizeFundImport([{ ...row(), previousClose }], options()).funds[0];
    assert.equal(fund.previousClose, null);
    assert.equal(fund.change, null);
    assert.equal(fund.changePercent, null);
  }
});

test('invalid or missing NAV cannot publish zero, NaN or coerced values', () => {
  for (const value of [null, undefined, '', ' ', 0, -1, false, true, Infinity, NaN, 'NaN', '1,234', '1x', [], {}, '0x10']) {
    assert.throws(() => normalizeFundImport([{ ...row(), value }], options()), /value/);
  }
  assert.equal(normalizeFundImport([{ ...row(), value: '1.2345' }], options()).funds[0].value, 1.2345);
});

test('future NAV and timezone-less/invalid timestamps fail while Manila calendar dates work', () => {
  assert.equal(manilaDate(new Date('2026-10-08T18:00:00Z')), '2026-10-09');
  assert.throws(() => normalizeFundImport([{ ...row(), valuationDate: '2026-10-10' }], options()), /future/);
  assert.throws(() => normalizeFundImport([{ ...row(), valuationDate: '2026-10-09', asOf: '2026-10-08T15:59:00Z' }], options()), /future/);
  assert.throws(() => normalizeFundImport([{ ...row(), asOf: '2026-10-09T00:00:01Z' }], options()), /future/);
  for (const asOf of ['2026-10-09T00:00:00', '2026-02-30T00:00:00Z', '2026-10-09T24:00:00Z', '2026-10-09T00:00:00+15:00']) {
    assert.throws(() => normalizeFundImport([{ ...row(), asOf }], options()), /asOf/);
  }
  assert.throws(() => normalizeFundImport([{ ...row(), valuationDate: '2026-02-30' }], options()), /calendar/);
  const valid = normalizeFundImport([{ ...row(), valuationDate: '2026-10-09', asOf: '2026-10-08T18:00:00Z' }], options());
  assert.equal(valid.funds[0].valuationDate, '2026-10-09');
});

test('empty rows, unknown fields, duplicates and count mismatches reject the whole import', () => {
  assert.throws(() => normalizeFundImport([], options()), /at least one/);
  assert.throws(() => normalizeFundImport([row(), row()], options(2)), /Duplicate/);
  assert.throws(() => normalizeFundImport([row()], options(2)), /count/);
  assert.throws(() => normalizeFundImport([{ ...row(), unexpected: 1 }], options()), /unexpected/);
  assert.throws(() => normalizeFundImport([{ ...row(), currency: 'USD' }], options()), /PHP/);
  assert.throws(() => normalizeFundImport([{ ...row(), category: 'Crypto' }], options()), /category/);
  for (const field of ['id', 'name', 'category', 'currency', 'valueType', 'valuationDate', 'asOf']) {
    assert.throws(() => normalizeFundImport([{ ...row(), [field]: null }], options()), /missing/);
  }
});

test('publication approval and source provenance must be explicit and valid', () => {
  for (const field of ['sourceName', 'sourceUrl', 'permissionReference']) {
    assert.throws(() => normalizeFundImport([row()], { ...options(), [field]: null }), new RegExp(field));
  }
  assert.throws(() => normalizeFundImport([row()], { ...options(), approvedForPublicDisplay: false }), /approval/);
  assert.throws(() => normalizeFundImport([row()], { ...options(), sourceUrl: 'http://example.com/nav' }), /HTTPS/);
  assert.throws(() => normalizeFundImport([row()], { ...options(), sourceUrl: 'https://username:password@example.com/nav' }), /credentials/);
});

test('CSV supports quoted commas and escaped quotes while malformed/schema-changed CSV fails', () => {
  const header = 'id,name,category,currency,value,valueType,valuationDate,asOf,previousClose';
  const csv = `${header}\r\napproved-equity,"Manager, ""Growth"" Fund",Equity,PHP,1.2345,NAVPS,2026-10-08,2026-10-09T07:00:00+08:00,1.23\r\n`;
  const parsed = parseCsv(csv);
  assert.equal(parsed[0].name, 'Manager, "Growth" Fund');
  assert.equal(normalizeFundImport(parsed, options()).funds[0].value, 1.2345);
  assert.throws(() => parseCsv(`${header}\nx,"broken`), /Unterminated/);
  assert.throws(() => parseCsv(`${header}\nx,"name"oops,Equity,PHP,1.2,NAVPS,2026-10-08,2026-10-09T07:00:00+08:00,1.1`), /closing/);
  assert.throws(() => parseCsv('id,id\na,b'), /unique/);
  assert.throws(() => parseCsv(`${header}\na,b`), /cells/);
  assert.throws(() => parseCsv(`${header},new-column\na,b,c,d,e,f,g,h,i,j`), /unexpected/);
  assert.throws(() => parseCsv(header), /at least one/);
});

test('JSON arrays and envelopes parse; malformed/empty inputs are rejected before publishing', () => {
  assert.deepEqual(parseFundInput(JSON.stringify([row()]), '.json'), [row()]);
  assert.deepEqual(parseFundInput(JSON.stringify({ funds: [row()] }), '.json'), [row()]);
  assert.throws(() => parseFundInput('{bad', '.json'), /valid JSON/);
  assert.throws(() => parseFundInput('<html>missing</html>', '.html'), /csv or .json/);
  for (const value of ['null', '{}', '{"funds":null}', '[]']) {
    assert.throws(() => normalizeFundImport(parseFundInput(value, '.json'), options()), /at least one/);
  }
});

test('atomic publication writes only an explicit separate file and leaves no temporary files', async () => {
  const directory = await mkdtemp(join(project, 'tests', 'fund-import-'));
  try {
    const destination = join(directory, 'approved.json');
    const payload = normalizeFundImport([row()], options());
    assert.equal(await writeFundImport(destination, payload), resolve(destination));
    assert.deepEqual(JSON.parse(await readFile(destination, 'utf8')), payload);
    assert.deepEqual(await readdir(directory), ['approved.json']);
    await assert.rejects(writeFundImport('', payload), /explicit/);
    await assert.rejects(writeFundImport(join(directory, 'output.csv'), payload), /json/);
    await assert.rejects(writeFundImport(join(project, 'site', 'data', 'funds.json'), payload), /demo/);
  } finally {
    const resolved = resolve(directory);
    assert.equal(dirnameForCheck(resolved), resolve(project, 'tests'));
    await rm(resolved, { recursive: true, force: true });
  }
});

function dirnameForCheck(path) { return resolve(path, '..'); }
