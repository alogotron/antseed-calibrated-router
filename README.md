# @alogos/antseed-calibrated-router

Difficulty-aware routing provider for [AntSeed](https://antseed.com), implementing the
[Inference Routing Protocol](https://github.com/inference-routing/spec) `irp-suggest` method.

Ranks the candidates a buyer sends by calibrated probability of success against expected cost.
Every decision is recomputable from the values returned in the response.

## Model

For a model with normalised benchmark skill `s` and an estimated request difficulty `d`:

```
P(success) = 1 / (1 + exp(-8 * (s - d)))
```

Candidates are ordered by utility, where `t` is the buyer's `cost_quality_tradeoff` (0-10):

```
U = P(success) - lambda * log10(1 + cost / 0.001)
lambda = t * 0.04          // t = 10 ranks purely by cost
```

Cost is log-compressed so that sub-cent differences do not dominate quality. Skill values come
from a public benchmark table, normalised per metric; models without a score receive a
conservative prior of `0.35` and are marked `scored: false`.

## Difficulty estimation (v0)

A transparent heuristic over the prompt: coding, reasoning and math cues, tool presence, request
length, and easy-task cues each move the estimate by a fixed documented delta. No model call is
made, so the marginal cost of a ranking is zero. Every contributing signal is returned in
`metadata['alogos.xyz'].signals` for audit.

This is a v0 heuristic with hand-set weights. `difficulty.ts` documents that the weights are
intended to be replaced by fitted values once measured routing data exists.

## Neutrality

The router has no preferred-model, preferred-seller, or override field. There is no configuration
that can make the operator's own services rank higher; they are scored like every other candidate.

## Response contract

Ranking responses include, under `metadata['alogos.xyz']`:

| Field | Meaning |
|---|---|
| `difficulty` | Estimated request difficulty, 0-1 |
| `domain` | `coding` or `general` |
| `signals` | The individual deltas that produced `difficulty` |
| `cost_quality_tradeoff` | The `t` value used |

Each candidate carries `extra['alogos.xyz'].skill` and `scored`, so a consumer can verify the
inputs to the ranking rather than trusting the ordering.

## Install

```
npm install @alogos/antseed-calibrated-router
```

Requires `@antseed/node >= 0.2.150` as a peer dependency.

## Verify

```
npm run verify     # typecheck + vitest + build
npm run conformance
```

`conformance` validates generated responses against the official IRP JSON schemas.

## Metrics

Every ranking is recorded. The router keeps a bounded in-memory window and optionally appends one
JSON line per ranking:

```
CALIBRATED_ROUTER_METRICS_SINK=/path/to/rank-metrics.jsonl
```

Record fields: `ts`, `requestId`, `status`, `latencyMs`, `candidates`, `ranked`, `scored`,
`difficulty`, `domain`, `tradeoff`, `topCandidateId`, `topQuality`, `topCostUsd`, `error`.
Malformed and unscorable requests are recorded as failures rather than dropped, so the failure rate
is visible instead of silent.

The snapshot is also available in-process as `router.metrics.snapshot()`.

**Not reachable over the network:** the AntSeed node's P2P mux answers unknown HTTP paths with
`{"error":"not found"}` (`packages/node/src/p2p/connection-manager.ts:1035`) before a plugin sees the
request, so a custom status path cannot be served through the node. Consume the JSONL sink instead.

## Limits

- Difficulty weights are hand-set, not fitted.
- Models absent from the benchmark source receive a flat prior (`0.35`) rather than a measured skill.
- The router does not evaluate whether a response was actually correct; it predicts the
  probability that the chosen model handles the request and leaves settlement to the protocol.

## License

MIT
