import type { AntseedProviderPlugin, Provider } from '@antseed/node';
import { IRP_SUGGEST_PROTOCOL } from '@antseed/node';
import { CalibratedRouter, DEFAULT_COST_WEIGHT, DEFAULT_REFRESH_MS, DEFAULT_SCORES_URL } from './router.js';

export * from './router.js';
export * from './difficulty.js';

const DEFAULT_SERVICE = 'calibrated-router';

const csv = (raw: string | undefined): string[] =>
  [...new Set((raw ?? '').split(',').map(entry => entry.trim()).filter(Boolean))];

function nonNegative(raw: string | undefined, fallback: number, key: string): number {
  const value = Number(raw ?? fallback);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${key} must be a non-negative number`);
  return value;
}

/** Difficulty-aware IRP routing provider: one `irp-suggest` service answered in-process. */
const plugin: AntseedProviderPlugin = {
  name: 'calibrated-router',
  displayName: 'Calibrated Router',
  version: '0.1.0',
  type: 'provider',
  description: 'IRP routing service ranking candidates by per-request difficulty vs benchmark skill and expected cost',
  configSchema: [
    { key: 'ANTSEED_ALLOWED_SERVICES', label: 'Routing Service', type: 'string[]', required: false, default: DEFAULT_SERVICE, description: 'Routing service id (exactly one)' },
    { key: 'CALIBRATED_ROUTER_PRICE_USD', label: 'Price per Ranking', type: 'number', required: false, default: 0, description: 'USD charged per ranking; 0 makes routing free' },
    { key: 'CALIBRATED_ROUTER_COST_WEIGHT', label: 'Cost Weight', type: 'number', required: false, default: DEFAULT_COST_WEIGHT, description: 'Cost penalty per tradeoff step' },
    { key: 'CALIBRATED_ROUTER_SCORES_URL', label: 'Model Scores URL', type: 'string', required: false, default: DEFAULT_SCORES_URL, description: 'modelgrep-compatible scores; empty ranks at the unscored prior' },
    { key: 'CALIBRATED_ROUTER_REFRESH_SECONDS', label: 'Refresh Interval', type: 'number', required: false, default: DEFAULT_REFRESH_MS / 1000, description: 'How often to refresh model scores' },
    { key: 'ANTSEED_MAX_CONCURRENCY', label: 'Max Concurrency', type: 'number', required: false, default: 50, description: 'Max concurrent ranking requests' },
  ],

  createProvider(config: Record<string, string>): Provider {
    const services = csv(config['ANTSEED_ALLOWED_SERVICES']);
    if (services.length > 1) throw new Error('calibrated-router offers exactly one routing service');
    const service = services[0] ?? DEFAULT_SERVICE;
    const priceUsd = nonNegative(config['CALIBRATED_ROUTER_PRICE_USD'], 0, 'CALIBRATED_ROUTER_PRICE_USD');
    const costWeight = nonNegative(config['CALIBRATED_ROUTER_COST_WEIGHT'], DEFAULT_COST_WEIGHT, 'CALIBRATED_ROUTER_COST_WEIGHT');
    const refreshSeconds = nonNegative(config['CALIBRATED_ROUTER_REFRESH_SECONDS'], DEFAULT_REFRESH_MS / 1000, 'CALIBRATED_ROUTER_REFRESH_SECONDS');
    if (refreshSeconds === 0) throw new Error('CALIBRATED_ROUTER_REFRESH_SECONDS must be positive');
    const maxConcurrency = Number.parseInt(config['ANTSEED_MAX_CONCURRENCY'] ?? '50', 10);
    if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1) throw new Error('ANTSEED_MAX_CONCURRENCY must be a positive integer');

    const router = new CalibratedRouter({
      costWeight,
      scoresUrl: config['CALIBRATED_ROUTER_SCORES_URL']?.trim() ?? DEFAULT_SCORES_URL,
      refreshMs: refreshSeconds * 1000,
    });
    let active = 0;

    return {
      name: 'calibrated-router',
      services: [service],
      pricing: { defaults: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } },
      serviceApiProtocols: { [service]: [IRP_SUGGEST_PROTOCOL] },
      serviceUnitBillingModels: {
        [service]: { [IRP_SUGGEST_PROTOCOL]: { version: 1, components: [{ unit: 'completed_requests', priceUsd }] } },
      },
      maxConcurrency,
      init: () => router.init(),
      getCapacity: () => ({ current: active, max: maxConcurrency }),
      async handleRequest(request) {
        active++;
        try {
          return await router.handleRequest(request);
        } finally {
          active--;
        }
      },
    };
  },
};

export default plugin;
