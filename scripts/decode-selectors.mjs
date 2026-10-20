import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { id } from 'ethers';
const root = '/a0/usr/projects/ant-inference/_research/antseed-main/packages/contracts';
const want = new Set(['0x7e273289', '0x88617315']);
const files = [];
const walk = d => { for (const f of readdirSync(d)) { const p = join(d, f); if (f === 'lib' || f === 'node_modules' || f === 'out' || f === 'cache') continue; const s = statSync(p); if (s.isDirectory()) walk(p); else if (f.endsWith('.sol')) files.push(p); } };
walk(root);
const norm = params => params.split(',').map(x => x.trim()).filter(Boolean).map(x => x.split(/\s+/)[0].replace(/\bIERC20\b|\bI[A-Z]\w*\b/, 'address').replace(/^uint$/, 'uint256').replace(/^int$/, 'int256')).join(',');
const seen = new Map();
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(/\b(error|function)\s+(\w+)\s*\(([^)]*)\)/g)) {
    const sig = `${m[2]}(${norm(m[3])})`;
    const sel = id(sig).slice(0, 10);
    if (want.has(sel)) seen.set(sel + ' ' + m[1] + ' ' + sig, f.replace(root + '/', ''));
  }
}
for (const [k, v] of seen) console.log(k, '<-', v);
if (!seen.size) console.log('no match found');
