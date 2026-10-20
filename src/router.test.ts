import { describe, expect, it } from 'vitest';
import type { IrpCandidate, SerializedHttpRequest } from '@antseed/node';
import { IRP_RANK_PATH } from '@antseed/node';
import { CalibratedRouter, METRICS_PATH, expectedCostUsd, rankScored, successProbability, type ScoresPage } from './router.js';
import { analyzeRequest } from './difficulty.js';
import plugin from './index.js';

const page: ScoresPage = {
  data: [
    { id: 'anthropic/claude-opus-5', benchmarks: { artificial_analysis: { intelligence: 70, coding: 66 } } },
    { id: 'moonshotai/kimi-k3', benchmarks: { artificial_analysis: { intelligence: 60, coding: 55 } } },
    { id: 'qwen/qwen3-coder-30b', benchmarks: { artificial_analysis: { intelligence: 35, coding: 45 } } },
  ],
  meta: { has_more: false },
};

const fakeFetch = (async () => ({ ok: true, status: 200, json: async () => page })) as unknown as typeof fetch;

const candidates: IrpCandidate[] = [
  { id: 'opus@a', model: 'anthropic/claude-opus-5', pricing: { input: 4, cache_read: 0.4, output: 20 } },
  { id: 'kimi@b', model: 'moonshotai/kimi-k3', pricing: { input: 0.3, cache_read: 0.03, output: 1.5 } },
  { id: 'qwen@c', model: 'qwen/qwen3-coder-30b', pricing: { input: 0.01, cache_read: 0, output: 0.04 } },
];

const enc = new TextEncoder();
const dec = new TextDecoder();

async function rank(router: CalibratedRouter, content: string, tradeoff?: number, cands = candidates) {
  const body = { request: { messages: [{ role: 'user', content }] }, routing: { cost_quality_tradeoff: tradeoff, candidates: cands } };
  const response = await router.handleRequest({ requestId: 'r1', method: 'POST', path: '/v1/routing/rank', headers: {}, body: enc.encode(JSON.stringify(body)) });
  return { status: response.statusCode, json: JSON.parse(dec.decode(response.body)) };
}

async function makeRouter() {
  const router = new CalibratedRouter({ fetch: fakeFetch });
  await router.init();
  return router;
}

const HARD = 'Debug this TypeScript race condition step by step and explain the root cause and edge cases:\n```ts\nasync function f() { await Promise.all(jobs) }\n```';
const EASY = 'Hello, translate thanks to French';

describe('difficulty', () => {
  it('scores hard coding above easy chat', () => {
    const hard = analyzeRequest({ messages: [{ role: 'user', content: HARD }] });
    const easy = analyzeRequest({ messages: [{ role: 'user', content: EASY }] });
    expect(hard.domain).toBe('coding');
    expect(easy.domain).toBe('general');
    expect(hard.difficulty).toBeGreaterThan(easy.difficulty);
  });

  it('caps output tokens by max_tokens', () => {
    expect(analyzeRequest({ messages: [{ role: 'user', content: HARD }], max_tokens: 64 }).outputTokens).toBe(64);
  });
});

describe('IRP endpoints', () => {
  it('lists the wildcard model', async () => {
    const router = await makeRouter();
    const response = await router.handleRequest({ requestId: 'm', method: 'GET', path: '/v1/routing/models', headers: {}, body: new Uint8Array() });
    expect(JSON.parse(dec.decode(response.body))).toEqual({ object: 'list', data: [{ id: '*', object: 'model' }] });
  });

  it('rejects malformed bodies with a 400 problem', async () => {
    const router = await makeRouter();
    const response = await router.handleRequest({ requestId: 'x', method: 'POST', path: '/v1/routing/rank', headers: {}, body: enc.encode('{"routing":{}}') });
    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toBe('application/problem+json');
  });

  it('returns only sent candidates, each once, with a conforming shape', async () => {
    const { status, json } = await rank(await makeRouter(), HARD, 5);
    expect(status).toBe(200);
    expect(json.object).toBe('routing.ranking');
    const ids = json.ranked.map((entry: { candidate_id: string }) => entry.candidate_id);
    expect(new Set(ids)).toEqual(new Set(candidates.map(c => c.id)));
    expect(ids.length).toBe(candidates.length);
  });
});

describe('ranking', () => {
  it('sends hard coding to the strongest model at best quality', async () => {
    const { json } = await rank(await makeRouter(), HARD, 0);
    expect(json.ranked[0].candidate_id).toBe('opus@a');
  });

  it('sends easy chat to a cheap model at balanced', async () => {
    const { json } = await rank(await makeRouter(), EASY, 5);
    expect(json.ranked[0].candidate_id).toBe('qwen@c');
  });

  it('ranks cheapest first at tradeoff 10', async () => {
    const { json } = await rank(await makeRouter(), HARD, 10);
    expect(json.ranked[0].candidate_id).toBe('qwen@c');
  });

  it('keeps top-candidate cost non-increasing as tradeoff rises (IRP 3.1)', async () => {
    const router = await makeRouter();
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const models = ['anthropic/claude-opus-5', 'moonshotai/kimi-k3', 'qwen/qwen3-coder-30b', 'unknown/model'];
    for (let trial = 0; trial < 200; trial++) {
      const cands: IrpCandidate[] = Array.from({ length: 2 + Math.floor(rnd() * 6) }, (_, i) => {
        const input = rnd() * 20;
        return { id: `c${i}`, model: models[Math.floor(rnd() * models.length)], pricing: { input, cache_read: input / 10, output: input * (1 + rnd() * 5) } };
      });
      const profile = analyzeRequest({ messages: [{ role: 'user', content: rnd() > 0.5 ? HARD : EASY }] });
      const scored = router.score(cands, profile);
      let previous = Infinity;
      for (let t = 0; t <= 10; t++) {
        const top = rankScored(scored, t)[0];
        expect(top.cost).toBeLessThanOrEqual(previous + 1e-15);
        previous = top.cost;
      }
    }
  });

  it('applies the IRP cost formula and a bounded logistic prior', () => {
    const cost = expectedCostUsd({ input: 15, cache_read: 1.5, output: 75 }, { input_tokens: 18422, cache_read_tokens: 16000, output_tokens: 480 });
    expect(cost).toBeCloseTo(0.0963, 4);
    expect(successProbability(1, 0.05)).toBeGreaterThan(successProbability(0.3, 0.05));
    expect(successProbability(0.5, 0.5)).toBeCloseTo(0.5, 6);
  });
});

describe('loose model matching', () => {
  it('normalises vendor, separators and variant suffixes', async () => {
    const { looseModelKey } = await import('./router.js');
    expect(looseModelKey('gemini/gemini-3.7-flash-high')).toBe(looseModelKey('google/gemini-3.7-flash'));
    expect(looseModelKey('vikey/qwen3.8-27b-uncensored')).toBe(looseModelKey('qwen/qwen3.8-27b'));
    expect(looseModelKey('mercury-2-5')).not.toBe(looseModelKey('inception/mercury-2.5x'));
  });

  it('scores a variant name via the fallback but never by prefix', async () => {
    const scored = { data: [
      { id: 'google/gemini-3.7-flash', benchmarks: { artificial_analysis: { intelligence: 50 } } },
      { id: 'deepseek/deepseek-v3.2', benchmarks: { artificial_analysis: { intelligence: 40 } } },
    ], meta: { has_more: false } };
    const router = new CalibratedRouter({ fetch: (async () => ({ ok: true, status: 200, json: async () => scored })) as unknown as typeof fetch });
    await router.init();
    const profile = analyzeRequest({ messages: [{ role: 'user', content: 'hi' }] });
    const [variant, prefixOnly] = router.score([
      { id: 'a', model: 'gemini/gemini-3.7-flash-high', pricing: { input: 1, cache_read: 1, output: 1 } },
      { id: 'b', model: 'deepseek-v3', pricing: { input: 1, cache_read: 1, output: 1 } },
    ], profile);
    expect(variant.scored).toBe(true);
    expect(prefixOnly.scored).toBe(false);
  });
});

describe('plugin', () => {
  it('advertises one irp-suggest service with unit billing', () => {
    const provider = plugin.createProvider({ CALIBRATED_ROUTER_PRICE_USD: '0.0005', CALIBRATED_ROUTER_SCORES_URL: '' });
    expect(provider.services).toEqual(['calibrated-router']);
    expect(provider.serviceApiProtocols).toEqual({ 'calibrated-router': ['irp-suggest'] });
    expect(JSON.stringify(provider.serviceUnitBillingModels)).toContain('0.0005');
  });

  it('refuses two routing services', () => {
    expect(() => plugin.createProvider({ ANTSEED_ALLOWED_SERVICES: 'a,b' })).toThrow();
  });
});

describe('operational metrics', () => {
  const scores = { data: [{ id: 'openai/gpt-5', benchmarks: { artificial_analysis: { intelligence: 80 } } }], meta: { has_more: false } };
  const makeRouter = (): CalibratedRouter => new CalibratedRouter({ fetch: (async () => ({ ok: true, status: 200, json: async () => scores })) as unknown as typeof fetch, now: () => 1_000 });

  const rankRequest = (id: string): SerializedHttpRequest => ({
    requestId: id,
    method: 'POST',
    path: IRP_RANK_PATH,
    headers: {},
    body: new TextEncoder().encode(JSON.stringify({
      request: { model: 'any', messages: [{ role: 'user', content: 'write a python function' }] },
      routing: { candidates: [{ id: 'c1', model: 'openai/gpt-5', pricing: { input: 1, cache_read: 1, output: 2 } }], cost_quality_tradeoff: 5 },
    })),
  });

  it('records a successful ranking with its top candidate', async () => {
    const router = makeRouter();
    await router.init();
    await router.handleRequest(rankRequest('r1'));
    const snap = router.metrics.snapshot();
    expect(snap.ranks.ok).toBe(1);
    expect(snap.ranks.failed).toBe(0);
    expect(snap.ranks.byTopCandidate).toEqual({ c1: 1 });
    expect(snap.ranks.scoredRatio).toBe(1);
  });

  it('records malformed requests as failures rather than dropping them', async () => {
    const router = makeRouter();
    await router.handleRequest({ requestId: 'bad', method: 'POST', path: IRP_RANK_PATH, headers: {}, body: new TextEncoder().encode('{}') });
    const snap = router.metrics.snapshot();
    expect(snap.ranks.failed).toBe(1);
    expect(snap.ranks.ok).toBe(0);
    expect(snap.requests.byStatus['400']).toBe(1);
  });

  it('serves a read-only snapshot without request content', async () => {
    const router = makeRouter();
    await router.init();
    await router.handleRequest(rankRequest('r2'));
    const response = await router.handleRequest({ requestId: 'm1', method: 'GET', path: METRICS_PATH, headers: {}, body: new Uint8Array() });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(new TextDecoder().decode(response.body));
    expect(body.ranks.ok).toBe(1);
    expect(JSON.stringify(body)).not.toContain('python function');
  });
});
