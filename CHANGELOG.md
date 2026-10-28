# Changelog

This project follows [Semantic Versioning](https://semver.org). From 1.0.0, the stable public API is:

- the default plugin export, its `configSchema` keys and the provider it creates;
- named exports from the package root (`@alogos/antseed-calibrated-router`);
- the ranking response contract under `extra['alogos.xyz']` (fields `difficulty`, `domain`, `signals`, `cost_quality_tradeoff`, per-candidate `skill` and `scored`);
- the metrics JSONL record fields.

Difficulty weights, the unscored prior and benchmark normalisation are model parameters, not API. They may change in minor releases, and every change is listed here.

## 1.0.0 - 2026-10-20

### Changed

- **Breaking:** added a package `exports` map. Only the package root and `./package.json` are importable; deep imports such as `dist/router.js` no longer resolve.
- Declared `engines.node >= 20.0.0`, matching `@antseed/node`.
- `plugin.version` and `router.version` in ranking responses now read the single `ROUTER_VERSION` constant. Before this release they reported `0.1.0` while the package was `0.1.1`.

### Fixed

- A failed model-score fetch no longer pins every ranking to the unscored prior for the full refresh interval (6 h by default). The router now retries after `FAILED_REFRESH_RETRY_MS` (60 s) and keeps the last good scores until then.
- `handleRequest` never throws. Unexpected internal errors return an IRP `urn:irp:problem:unavailable` problem (HTTP 503) with a `Retry-After` header and no internal detail in the body.
- The metrics `byTopCandidate` map is capped at `MAX_TOP_CANDIDATE_KEYS` (256) distinct ids. Later ids are counted under `(other)`, because candidate ids are buyer-supplied and were previously unbounded.

### Added

- `prepublishOnly` runs `verify` and `conformance`, so a failing build cannot be published.
- Regression tests for the retry schedule, the 503 catch-all, the metrics bound, and version consistency across `package.json`, the plugin and the router.

## 0.1.1

- Metrics recording with a JSONL sink, the MIT license, and the IRP conformance script.

## 0.1.0

- Initial IRP `irp-suggest` routing provider.
