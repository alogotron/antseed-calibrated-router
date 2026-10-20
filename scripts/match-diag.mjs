import { CalibratedRouter } from '../dist/index.js';
import { canonicalModelKey } from '@antseed/node/model-identity';
import { readFileSync, writeFileSync } from 'node:fs';
// full modelgrep catalog
const all = []; let off = 0;
for (let i = 0; i < 10; i++) { const r = await fetch(`https://modelgrep.com/api/v1/models?limit=200&offset=${off}`); const j = await r.json(); all.push(...(j.data||[])); if (!j.meta?.has_more) break; off = j.meta.next_offset; }
const aa = all.filter(m => m.benchmarks?.artificial_analysis?.intelligence);
writeFileSync('/tmp/mg_all.json', JSON.stringify(all));
console.log('modelgrep total', all.length, 'with AA intelligence', aa.length);
const r = new CalibratedRouter(); await r.init();
const stats = JSON.parse(readFileSync('/tmp/antstats2.json','utf8'));
const excluded = new Set(['qwen3-coder-30b','mellum-12b']);
const ids = [...new Set(stats.peers.flatMap(p => (p.providers||[]).flatMap(pr => pr.services||[])))].filter(i => !excluded.has(i));
const prof = { difficulty: .5, domain: 'general', promptTokens: 1, outputTokens: 1, signals: [] };
const sc = r.score(ids.map((m,i)=>({id:'c'+i,model:m,pricing:{input:1,cache_read:1,output:1}})), prof);
const unscored = sc.filter(x=>!x.scored).map(x=>x.candidate.model);
console.log('ids', ids.length, 'unscored', unscored.length);
// loose key: lowercase, drop vendor prefix, unify separators, drop common suffixes
const loose = s => s.toLowerCase().split('/').pop().replace(/[:_.\s]/g,'-').replace(/-(fast|free|thinking|high|low|latest|instruct|it|exl\d|fp\d+|awq|gguf|uncensored|abliterated)$/,'').replace(/-+/g,'-');
const aaLoose = new Map(); for (const m of aa) { const k = loose(m.id); if (!aaLoose.has(k)) aaLoose.set(k, m.id); }
const fixable = [], hopeless = [];
for (const u of unscored) { const k = loose(u); (aaLoose.has(k) ? fixable : hopeless).push(aaLoose.has(k) ? `${u} -> ${aaLoose.get(k)}` : u); }
console.log('fixable by loose key', fixable.length); console.log(fixable.slice(0,40).join('\n'));
console.log('--- still unmatched', hopeless.length); console.log(hopeless.slice(0,70).join(', '));
console.log('--- canonicalModelKey samples:', ['claude-opus-4-7','claude-opus-4.7','anthropic/claude-opus-4.7','claude-opus-4.7:fast','GLM-5.3-Flash-EXL3','gemma-4-26b-a4b-it'].map(s=>s+'=>'+canonicalModelKey(s)).join(' | '));
