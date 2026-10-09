import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const project=fileURLToPath(new URL('../',import.meta.url));
const site=resolve(project,'site');
async function walk(dir){return (await Promise.all((await readdir(dir,{withFileTypes:true})).map(async e=>e.isDirectory()?walk(resolve(dir,e.name)):resolve(dir,e.name)))).flat();}
const files=await walk(site);
for(const file of files){
  const text=await readFile(file,'utf8');
  if(extname(file)==='.json')JSON.parse(text);
  assert.ok(!/(?:EODHD_TOKEN|api_token|api[_-]?key)\s*[:=]\s*["'][A-Za-z0-9_-]{12,}/i.test(text),`Potential embedded credential: ${file}`);
  const references=extname(file)==='.html'?[...text.matchAll(/(?:src|href)=["'](\.\/[^"']+)["']/g)].map(m=>m[1]):extname(file)==='.js'?[...text.matchAll(/(?:from\s*|import\s*)["'](\.[^"']+)["']/g)].map(m=>m[1]):[];
  for(const reference of references){const target=resolve(dirname(file),reference.split(/[?#]/)[0]);assert.ok((await stat(target)).isFile(),`Missing local asset: ${reference}`);}
}
const demo=JSON.parse(await readFile(resolve(site,'data/demo.json'),'utf8'));
assert.equal(demo.mode,'demo');assert.ok(demo.quotes.length>=20);assert.ok(demo.funds.length>=6);
assert.ok(files.every(f=>!f.endsWith('.map')&&!f.includes('.dev.vars')));
console.log(`Checked ${files.length} static files: local assets resolve, JSON parses, sample contract is present, no embedded provider credentials found.`);
console.log('Deploy the site/ directory as-is. There is no build dependency or generated bundle.');
