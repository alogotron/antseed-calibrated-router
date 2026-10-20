// Validates the built router's real responses against the official IRP JSON Schemas
// (_research/irp-spec/schemas) plus the SPEC rules JSON Schema cannot express.
// Usage: npm run build && node scripts/conformance.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { CalibratedRouter } from '../dist/index.js';

// Clone https://github.com/inference-routing/spec and point IRP_SPEC_DIR at it; the fallback is the
// operator's local mirror layout.
const specRoot = process.env.IRP_SPEC_DIR
  ? join(process.env.IRP_SPEC_DIR, '/')
  : new URL('../../_research/irp-spec/', import.meta.url).pathname;
const require = createRequire(join(specRoot, 'package.json'));
const Ajv2020 = require('ajv/dist/2020.js').default ?? require('ajv/dist/2020.js');
const read = (p) => JSON.parse(readFileSync(join(specRoot, p), 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
for (const file of readdirSync(join(specRoot, 'schemas'))) ajv.addSchema(read(`schemas/${file}`));

let failed = 0;
const ok = (msg) => console.log(`✓ ${msg}`);
const fail = (msg) => { failed++; console.error(`✗ ${msg}`); };
function check(schemaId, value, label) {
  const validate = ajv.getSchema(schemaId);
  if (validate(value)) ok(`${label} ⊨ ${schemaId}`);
  else fail(`${label} ⊭ ${schemaId}\n  ${ajv.errorsText(validate.errors, { separator: '\n  ' })}`);
}

const page = { data: [
  { id: 'anthropic/claude-opus-5.5', benchmarks: { artificial_analysis: { intelligence: 70, coding: 66 } } },
  { id: 'moonshotai/kimi-k3', benchmarks: { artificial_analysis: { intelligence: 60, coding: 55 } } },
  { id: 'deepseek/deepseek-v4-flash', benchmarks: { artificial_analysis: { intelligence: 45, coding: 44 } } },
], meta: { has_more: false } };
const fakeFetch = async () => ({ ok: true, status: 200, json: async () => page });
const router = new CalibratedRouter({ fetch: fakeFetch });
await router.init();

const enc = new TextEncoder();
const dec = new TextDecoder();
const call = async (method, path, body) => {
  const res = await router.handleRequest({ requestId: 'c', method, path, headers: {}, body: body === undefined ? new Uint8Array() : enc.encode(typeof body === 'string' ? body : JSON.stringify(body)) });
  return { status: res.statusCode, type: res.headers['content-type'], json: JSON.parse(dec.decode(res.body)) };
};

// 1. Models endpoint
const models = await call('GET', '/v1/routing/models');
check('models.schema.json', models.json, 'GET /v1/routing/models');

// 2. Rank requests: official example + AntSeed-style candidate ids/names + edge cases
const cands = [
  { id: 'openai:claude-opus-5-5@' + 'a'.repeat(40), model: 'claude-opus-5-5', pricing: { input: 0.2, cache_read: 0.2, output: 1 } },
  { id: 'openai:kimi-k3@' + 'b'.repeat(40), model: 'kimi-k3', pricing: { input: 0.3, cache_read: 0.3, output: 1.5 }, expected_usage: { cache_read_tokens: 50 } },
  { id: 'openai:deepseek-v4-flash@' + 'c'.repeat(40), model: 'deepseek-v4-flash', pricing: { input: 0.07, cache_read: 0.07, output: 0.14 } },
  { id: 'openai:mystery-model@' + 'd'.repeat(40), model: 'mystery-model', pricing: { input: 0, cache_read: 0, output: 0 } },
];
const requests = [
  ['official example', read('examples/rank-request.json')],
  ['hard coding, t=0', { request: { messages: [{ role: 'user', content: 'Debug this race condition step by step:\n```ts\nawait Promise.all(jobs)\n```' }], tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }], max_tokens: 4096 }, routing: { cost_quality_tradeoff: 0, candidates: cands } }],
  ['easy chat, default t', { request: { messages: [{ role: 'user', content: 'thanks!' }] }, routing: { candidates: cands } }],
  ['multipart content, t=10', { request: { messages: [{ role: 'system', content: 'x' }, { role: 'user', content: [{ type: 'text', text: 'Summarize this' }] }] }, routing: { cost_quality_tradeoff: 10, candidates: cands } }],
  ['single candidate', { request: { messages: [{ role: 'user', content: 'hi' }] }, routing: { candidates: [cands[3]] } }],
];

for (const [label, body] of requests) {
  check('rank-request.schema.json', body, `request: ${label}`);
  const res = await call('POST', '/v1/routing/rank', body);
  if (res.status !== 200) { fail(`${label}: status ${res.status}`); continue; }
  check('rank-response.schema.json', res.json, `response: ${label}`);
  const byId = new Map(body.routing.candidates.map((c) => [c.id, c]));
  const ids = res.json.ranked.map((r) => r.candidate_id);
  if (new Set(ids).size !== ids.length) fail(`${label}: duplicate candidate_id`);
  if (!ids.length) fail(`${label}: empty ranked (must be 422)`);
  for (const e of res.json.ranked) {
    const c = byId.get(e.candidate_id);
    if (!c) { fail(`${label}: unknown candidate_id ${e.candidate_id}`); continue; }
    if (e.expected_usage && e.expected_cost_usd !== undefined) {
      const u = e.expected_usage, p = c.pricing;
      const cost = ((u.input_tokens - u.cache_read_tokens) * p.input + u.cache_read_tokens * p.cache_read + u.output_tokens * p.output) / 1e6;
      if (Math.abs(cost - e.expected_cost_usd) > 0.00005) fail(`${label}: ${e.candidate_id} cost ${e.expected_cost_usd} != ${cost}`);
      if (u.cache_read_tokens > u.input_tokens) fail(`${label}: cache_read_tokens > input_tokens`);
    }
  }
  ok(`${label}: cross-rules (ids ⊆ sent, unique, non-empty, cost formula)`);
}

// 3. Errors must be RFC 9457 problems matching problem.schema.json
for (const [label, method, path, body, status] of [
  ['malformed body', 'POST', '/v1/routing/rank', '{"routing":{}}', 400],
  ['invalid JSON', 'POST', '/v1/routing/rank', '{not json', 400],
  ['duplicate candidate id', 'POST', '/v1/routing/rank', { request: { messages: [{ role: 'user', content: 'x' }] }, routing: { candidates: [cands[0], cands[0]] } }, 400],
  ['unknown path', 'GET', '/v1/nope', undefined, 404],
]) {
  const res = await call(method, path, body);
  if (res.status !== status) fail(`${label}: status ${res.status}, want ${status}`);
  if (res.type !== 'application/problem+json') fail(`${label}: content-type ${res.type}`);
  if (status === 404) {
    // Outside IRP's paths: the IRP problem schema covers only 400/402/422/503. Require RFC 9457 shape
    // (type, title, status) — same behavior as AntSeed's shipped free-model-router.
    const p = res.json;
    if (typeof p.type === 'string' && typeof p.title === 'string' && p.status === 404) ok(`error: ${label} is an RFC 9457 problem (out of IRP scope)`);
    else fail(`error: ${label} is not an RFC 9457 problem`);
    continue;
  }
  check('problem.schema.json', res.json, `error: ${label}`);
}

console.log(failed ? `\n${failed} conformance failure(s)` : '\nAll conformance checks passed.');
process.exit(failed ? 1 : 0);
