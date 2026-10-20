import { readFileSync } from 'node:fs';
import { CalibratedRouter } from '../dist/index.js';
const all = JSON.parse(readFileSync('/tmp/mg_all.json','utf8'));
const aa = all.filter(m => m.benchmarks?.artificial_analysis?.intelligence);
const norm = s => s.toLowerCase().split('/').pop().replace(/[^a-z0-9]/g,'');
const strip = s => norm(s.replace(/[-_.:](fast|free|thinking|high|low|latest|instruct|it|exl\d|fp\d+|awq|gguf|uncensored|abliterated|heretic|preview|non-reasoning|reasoning)$/i,''));
const aaN = aa.map(m => ({ id: m.id, n: strip(m.id) }));
const anyN = new Set(all.map(m => strip(m.id)));
const r = new CalibratedRouter(); await r.init();
const stats = JSON.parse(readFileSync('/tmp/antstats2.json','utf8'));
const ex = new Set(['qwen3-coder-30b','mellum-12b']);
const ids = [...new Set(stats.peers.flatMap(p => (p.providers||[]).flatMap(pr => pr.services||[])))].filter(i => !ex.has(i));
const prof = { difficulty:.5, domain:'general', promptTokens:1, outputTokens:1, signals:[] };
const un = r.score(ids.map((m,i)=>({id:'c'+i,model:m,pricing:{input:1,cache_read:1,output:1}})), prof).filter(x=>!x.scored).map(x=>x.candidate.model);
let exact=0, prefix=0, inCatalogNoAA=0, absent=0; const pre=[];
for (const u of un) {
  const n = strip(u);
  if (aaN.some(a => a.n === n)) exact++;
  else { const hit = aaN.find(a => a.n.startsWith(n) && a.n.length - n.length <= 8); if (hit) { prefix++; pre.push(`${u} -> ${hit.id}`); } else if (anyN.has(n)) inCatalogNoAA++; else absent++; }
}
console.log({ unscored: un.length, exactAfterStrip: exact, prefixMatch: prefix, inModelgrepButNoAAScore: inCatalogNoAA, absentFromModelgrep: absent });
console.log('prefix samples:\n' + pre.slice(0,25).join('\n'));
