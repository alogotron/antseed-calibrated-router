/**
 * Operational metrics for the routing service.
 *
 * The router's public claim is auditability, so its own behaviour has to be observable too: how many
 * rankings it served, what it picked, how long it took, and what it rejected. Metrics are held in a
 * bounded in-memory window and optionally appended as JSON lines for durable analysis.
 */
import { appendFile } from 'node:fs/promises';

export type RankRecord = {
  ts: number;
  requestId: string;
  status: number;
  latencyMs: number;
  candidates: number;
  ranked: number;
  /** Candidates that had a real benchmark score (not the unscored prior). */
  scored: number;
  difficulty: number;
  domain: string;
  tradeoff: number;
  topCandidateId: string | null;
  topQuality: number | null;
  topCostUsd: number | null;
  error: string | null;
};

export type MetricsSnapshot = {
  startedAt: number;
  uptimeMs: number;
  requests: { total: number; byStatus: Record<string, number>; models: number; notFound: number };
  ranks: {
    total: number;
    ok: number;
    failed: number;
    candidatesMean: number;
    scoredRatio: number;
    difficultyMean: number;
    byTopCandidate: Record<string, number>;
  };
  latencyMs: { p50: number; p95: number; max: number };
  recent: RankRecord[];
  durableSink: string | null;
};

const percentile = (sorted: number[], fraction: number): number =>
  sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]!;

const mean = (values: number[]): number =>
  values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;

const round = (value: number, digits: number): number => Math.round(value * 10 ** digits) / 10 ** digits;

/** Bounded collector: counters plus a rolling window of rank records. */
export class RouterMetrics {
  private readonly startedAt = Date.now();
  private readonly records: RankRecord[] = [];
  private readonly latencies: number[] = [];
  private readonly byStatus: Record<string, number> = {};
  private readonly byTopCandidate: Record<string, number> = {};
  private totalRequests = 0;
  private modelListings = 0;
  private notFound = 0;
  private okRanks = 0;
  private failedRanks = 0;
  private written = Promise.resolve();

  constructor(
    private readonly sinkPath: string | null = null,
    private readonly window = 500,
  ) {}

  request(status: number): void {
    this.totalRequests += 1;
    const key = String(status);
    this.byStatus[key] = (this.byStatus[key] ?? 0) + 1;
  }

  modelsListed(): void {
    this.modelListings += 1;
  }

  notFoundRequest(): void {
    this.notFound += 1;
  }

  rank(record: Omit<RankRecord, 'ts'>): void {
    const full: RankRecord = { ts: Date.now(), ...record };
    if (record.status === 200) this.okRanks += 1;
    else this.failedRanks += 1;
    this.latencies.push(full.latencyMs);
    if (this.latencies.length > this.window) this.latencies.shift();
    this.records.push(full);
    if (this.records.length > this.window) this.records.shift();
    if (full.topCandidateId) {
      this.byTopCandidate[full.topCandidateId] = (this.byTopCandidate[full.topCandidateId] ?? 0) + 1;
    }
    this.persist(full);
  }

  snapshot(): MetricsSnapshot {
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const withCandidates = this.records.filter(record => record.status === 200);
    const scoredRatios = withCandidates.map(record => (record.candidates === 0 ? 0 : record.scored / record.candidates));
    return {
      startedAt: this.startedAt,
      uptimeMs: Date.now() - this.startedAt,
      requests: { total: this.totalRequests, byStatus: { ...this.byStatus }, models: this.modelListings, notFound: this.notFound },
      ranks: {
        total: this.okRanks + this.failedRanks,
        ok: this.okRanks,
        failed: this.failedRanks,
        candidatesMean: round(mean(withCandidates.map(record => record.candidates)), 2),
        scoredRatio: round(mean(scoredRatios), 3),
        difficultyMean: round(mean(withCandidates.map(record => record.difficulty)), 3),
        byTopCandidate: { ...this.byTopCandidate },
      },
      latencyMs: { p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), max: sorted.at(-1) ?? 0 },
      recent: [...this.records].slice(-20),
      durableSink: this.sinkPath,
    };
  }

  /** JSONL append; failures never affect request handling. */
  private persist(record: RankRecord): void {
    if (!this.sinkPath) return;
    this.written = this.written
      .then(() => appendFile(this.sinkPath!, `${JSON.stringify(record)}\n`))
      .catch(() => undefined);
  }

  /** Resolves once queued writes have settled (used by tests). */
  async flush(): Promise<void> {
    await this.written;
  }
}
