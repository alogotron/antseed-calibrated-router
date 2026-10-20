import { randomUUID } from 'node:crypto';
import type { SerializedHttpRequest, SerializedHttpResponse, IrpCandidate, IrpModelEntry, IrpRankRequest } from '@antseed/node';
import {
  IRP_ANY_MODEL,
  IRP_DEFAULT_COST_QUALITY_TRADEOFF,
  IRP_MODELS_PATH,
  IRP_RANK_PATH,
  IRP_PROBLEM_TYPES,
  irpProblemBody,
  validateIrpRankRequest,
} from '@antseed/node';
import { canonicalModelKey } from '@antseed/node/model-identity';
import { analyzeRequest, type RequestProfile } from './difficulty.js';

export const ROUTER_ID = 'alogos-calibrated-router';
export const ROUTER_VERSION = '0.1.0';
export const EXTRA_NAMESPACE = 'alogos.xyz';
export const DEFAULT_SCORES_URL = 'https://modelgrep.com/api/v1/models';
export const DEFAULT_REFRESH_MS = 6 * 60 * 60_000;
/** Cost penalty per tradeoff step (lambda = t * weight); t = 10 ranks purely by cost. */
export const DEFAULT_COST_WEIGHT = 0.04;
/** Skill assumed for models without a benchmark score (conservative prior). */
export const DEFAULT_UNSCORED_SKILL = 0.35;
const LOGISTIC_SLOPE = 8;
const COST_SCALE_USD = 0.001;
const VARIANT_SUFFIX = /[-_.:](?:free|fast|ultrafast|fast-api|highspeed|turbo|preview|mtp|exl\d|fp\d+|nvfp\d|bf16|int\d|awq|gguf|instruct|it|\d{4}|\d{6,8})$/i;
const SCORE_PAGE_SIZE = 200;
const MAX_SCORE_PAGES = 10;
/** Loose-key entries share the skill maps under this prefix (canonical keys are alphanumeric, so no clash). */
const LOOSE_PREFIX = 'loose:';
const LOOSE_SUFFIX = /[-_.:\s](?:uncensored|abliterated|heretic|thinking|reasoning|instruct|it|preview|latest|fast|free|high|low|exl\d|fp\d+|awq|gguf|\d{4}|\d{6,8})$/i;

/**
 * Vendor- and separator-insensitive key with variant suffixes stripped (`gemini/gemini-3.7-flash-high`
 * and `google/gemini-3.7-flash` both give `gemini37flash`). Used only when canonical keys miss.
 * No prefix matching: it mapped e.g. `deepseek-v3` to `deepseek-v3.2`.
 */
export function looseModelKey(id: string): string {
  let name = (id.trim().toLowerCase().split('/').pop() ?? '');
  for (let step = 0; step < 4; step++) {
    const stripped = name.replace(LOOSE_SUFFIX, '');
    if (stripped === name) break;
    name = stripped;
  }
  return name.replace(/[^a-z0-9]/g, '');
}

type ScoredModel = { id?: unknown; benchmarks?: { artificial_analysis?: Record<string, unknown> | null } | null };
export type ScoresPage = { data?: ScoredModel[]; meta?: { has_more?: boolean; next_offset?: number } };
export type Skills = { intelligence: Map<string, number>; coding: Map<string, number> };

export type CalibratedRouterOptions = {
  scoresUrl?: string;
  refreshMs?: number;
  costWeight?: number;
  unscoredSkill?: number;
  fetch?: typeof fetch;
  now?: () => number;
};

export type Scored = {
  candidate: IrpCandidate;
  index: number;
  skill: number;
  scored: boolean;
  quality: number;
  cost: number;
  usage: { input_tokens: number; cache_read_tokens: number; output_tokens: number };
};

/** Canonical keys for a model id, most specific first, then with deployment suffixes removed. */
export function modelKeys(id: string): string[] {
  const keys: string[] = [];
  let name = id.trim();
  for (let step = 0; step < 4 && name; step++) {
    const key = canonicalModelKey(name);
    if (key && !keys.includes(key)) keys.push(key);
    const stripped = name.replace(VARIANT_SUFFIX, '');
    if (stripped === name) break;
    name = stripped;
  }
  return keys;
}

/** Artificial Analysis indices from modelgrep pages, normalised to 0..1 by the best model per metric. */
export function parseSkills(pages: ScoresPage[]): Skills {
  const skills: Skills = { intelligence: new Map(), coding: new Map() };
  for (const metric of ['intelligence', 'coding'] as const) {
    const raw = new Map<string, number>();
    for (const page of pages) {
      for (const model of page.data ?? []) {
        const value = model.benchmarks?.artificial_analysis?.[metric];
        if (typeof model.id !== 'string' || typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue;
        const key = canonicalModelKey(model.id.replace(/:free$/, ''));
        if (key && !raw.has(key)) raw.set(key, value);
        const loose = looseModelKey(model.id);
        if (loose && !raw.has(LOOSE_PREFIX + loose)) raw.set(LOOSE_PREFIX + loose, value);
      }
    }
    const best = Math.max(0, ...raw.values());
    if (best > 0) for (const [key, value] of raw) skills[metric].set(key, value / best);
  }
  return skills;
}

/** Prior probability that a model of `skill` handles a request of `difficulty` (logistic, 0..1). */
export function successProbability(skill: number, difficulty: number): number {
  return 1 / (1 + Math.exp(-LOGISTIC_SLOPE * (skill - difficulty)));
}

/** IRP §3.4 cost formula; prices are USD per 1M tokens. */
export function expectedCostUsd(pricing: IrpCandidate['pricing'], usage: Scored['usage']): number {
  const uncached = Math.max(0, usage.input_tokens - usage.cache_read_tokens);
  return (uncached * pricing.input + usage.cache_read_tokens * pricing.cache_read + usage.output_tokens * pricing.output) / 1_000_000;
}

/**
 * Orders candidates by utility = quality - lambda * log10(1 + cost / scale), lambda = t * weight,
 * ties to the cheaper candidate. For a fixed request this keeps the top candidate's expected cost
 * non-increasing as t rises (IRP §3.1 monotonicity); t = 10 is pure cheapest-first.
 */
export function rankScored(items: Scored[], tradeoff: number, costWeight = DEFAULT_COST_WEIGHT): Scored[] {
  const lambda = tradeoff >= 10 ? Infinity : tradeoff * costWeight;
  const penalty = (cost: number): number => Math.log10(1 + cost / COST_SCALE_USD);
  return [...items].sort((a, b) => {
    if (lambda === Infinity) return a.cost - b.cost || b.quality - a.quality || a.index - b.index;
    const ua = a.quality - lambda * penalty(a.cost);
    const ub = b.quality - lambda * penalty(b.cost);
    return ub - ua || a.cost - b.cost || a.index - b.index;
  });
}

const round = (value: number, digits: number): number => Math.round(value * 10 ** digits) / 10 ** digits;

function json(requestId: string, statusCode: number, value: unknown): SerializedHttpResponse {
  return { requestId, statusCode, headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify(value)) };
}

function problem(requestId: string, statusCode: number, type: string, title: string, detail: string): SerializedHttpResponse {
  return { requestId, statusCode, headers: { 'content-type': 'application/problem+json' }, body: irpProblemBody(statusCode, type, title, detail) };
}

/**
 * Suggest-only IRP router that estimates each request's difficulty and ranks every candidate the
 * buyer sent (paid and free) by calibrated success probability against expected cost. Neutral by
 * design: no seller or model overrides, so the operator's own services get no preference.
 */
export class CalibratedRouter {
  private skills: Skills = { intelligence: new Map(), coding: new Map() };
  private loadedAt = -Infinity;
  private refreshing: Promise<void> | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: CalibratedRouterOptions = {}) {
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async init(): Promise<void> {
    await this.refresh();
  }

  listModels(): IrpModelEntry[] {
    return [{ id: IRP_ANY_MODEL }];
  }

  async handleRequest(request: SerializedHttpRequest): Promise<SerializedHttpResponse> {
    const path = request.path.split('?')[0];
    if (request.method === 'GET' && path === IRP_MODELS_PATH) {
      return json(request.requestId, 200, { object: 'list', data: this.listModels().map(entry => ({ ...entry, object: 'model' })) });
    }
    if (request.method === 'POST' && path === IRP_RANK_PATH) return this.rank(request);
    return problem(request.requestId, 404, IRP_PROBLEM_TYPES.invalidRequest, 'Not found', `${request.method} ${path} is not a routing endpoint.`);
  }

  /** Score candidates for one request profile (exported for offline evaluation). */
  score(candidates: IrpCandidate[], profile: RequestProfile): Scored[] {
    const unscored = this.options.unscoredSkill ?? DEFAULT_UNSCORED_SKILL;
    return candidates.map((candidate, index) => {
      const found = this.skillOf(candidate.model, profile.domain);
      const skill = found ?? unscored;
      const cacheRead = Math.min(candidate.expected_usage?.cache_read_tokens ?? 0, profile.promptTokens);
      const usage = { input_tokens: profile.promptTokens, cache_read_tokens: cacheRead, output_tokens: profile.outputTokens };
      return {
        candidate,
        index,
        skill,
        scored: found !== undefined,
        quality: successProbability(skill, profile.difficulty),
        cost: expectedCostUsd(candidate.pricing, usage),
        usage,
      };
    });
  }

  private async rank(request: SerializedHttpRequest): Promise<SerializedHttpResponse> {
    let body: IrpRankRequest;
    try {
      const raw: unknown = JSON.parse(new TextDecoder().decode(request.body));
      validateIrpRankRequest(raw);
      body = raw;
    } catch (error) {
      return problem(request.requestId, 400, IRP_PROBLEM_TYPES.invalidRequest, 'Invalid request', error instanceof Error ? error.message : String(error));
    }
    await this.refreshIfStale();
    const profile = analyzeRequest(body.request as unknown as Record<string, unknown>);
    const tradeoff = body.routing.cost_quality_tradeoff ?? IRP_DEFAULT_COST_QUALITY_TRADEOFF;
    const ranked = rankScored(this.score(body.routing.candidates, profile), tradeoff, this.options.costWeight ?? DEFAULT_COST_WEIGHT);
    if (!ranked.length) {
      return problem(request.requestId, 422, IRP_PROBLEM_TYPES.noScorableCandidate, 'No scorable candidate', 'No candidate could be scored.');
    }
    return json(request.requestId, 200, {
      id: `rank_${randomUUID()}`,
      object: 'routing.ranking',
      created: Math.floor(this.now() / 1000),
      router: { id: ROUTER_ID, version: ROUTER_VERSION },
      ranked: ranked.map(item => ({
        candidate_id: item.candidate.id,
        expected_quality: round(item.quality, 4),
        expected_cost_usd: round(item.cost, 8),
        expected_usage: item.usage,
        extra: { [EXTRA_NAMESPACE]: { skill: round(item.skill, 3), scored: item.scored } },
      })),
      extra: {
        [EXTRA_NAMESPACE]: { difficulty: profile.difficulty, domain: profile.domain, signals: profile.signals, cost_quality_tradeoff: tradeoff },
      },
    });
  }

  private skillOf(model: string, domain: RequestProfile['domain']): number | undefined {
    const keys = modelKeys(model);
    const loose = LOOSE_PREFIX + looseModelKey(model);
    const metrics = domain === 'coding' ? [this.skills.coding, this.skills.intelligence] : [this.skills.intelligence];
    for (const metric of metrics) {
      for (const key of keys) {
        const value = metric.get(key);
        if (value !== undefined) return value;
      }
      const fallback = metric.get(loose);
      if (fallback !== undefined) return fallback;
    }
    return undefined;
  }

  private async refreshIfStale(): Promise<void> {
    if (this.now() - this.loadedAt >= (this.options.refreshMs ?? DEFAULT_REFRESH_MS)) await this.refresh();
  }

  /** A failed fetch keeps the last good skills (or ranks everything at the unscored prior). */
  private refresh(): Promise<void> {
    this.refreshing ??= (async () => {
      const skills = await this.fetchSkills().catch(() => null);
      if (skills) this.skills = skills;
      this.loadedAt = this.now();
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  private async fetchSkills(): Promise<Skills | null> {
    const base = this.options.scoresUrl ?? DEFAULT_SCORES_URL;
    if (!base) return null;
    const pages: ScoresPage[] = [];
    let offset = 0;
    for (let page = 0; page < MAX_SCORE_PAGES; page++) {
      const url = new URL(base);
      url.searchParams.set('limit', String(SCORE_PAGE_SIZE));
      url.searchParams.set('offset', String(offset));
      const response = await this.fetchImpl(url.toString(), { signal: AbortSignal.timeout(10_000), headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
      const result = await response.json() as ScoresPage;
      pages.push(result);
      if (!result.meta?.has_more || typeof result.meta.next_offset !== 'number' || result.meta.next_offset <= offset) break;
      offset = result.meta.next_offset;
    }
    return parseSkills(pages);
  }
}
