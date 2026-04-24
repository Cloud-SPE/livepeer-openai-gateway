/**
 * Test-only helpers for fake-node fixtures used across the bridge's
 * integration tests. Matches the openai-worker-node wire format as of
 * worker commit 2b5cd2a (see exec-plan 0018-worker-wire-format-alignment).
 *
 * NOT production code. Only imported from *.test.ts files.
 */

export interface FakeQuoteOverrides {
  /** Decimal-wei string; default '1000'. */
  pricePerWorkUnitWei?: string;
  /** Defaults to 'model-small' to match the existing test node configs. */
  model?: string;
  /** 0x-prefixed 40-hex; defaults to 0xaa*20 (matches fixtures). */
  recipient?: string;
}

/** Bridge-test canonical sender ETH address. 0x-prefixed 40-hex. */
export const TEST_BRIDGE_ETH = '0x1234567890abcdef1234567890abcdef12345678';

/** Builds a /health response body matching the worker's current shape. */
export function fakeHealthResponse(overrides: {
  status?: 'ok' | 'degraded';
  maxConcurrent?: number;
  inflight?: number;
} = {}): Record<string, unknown> {
  return {
    status: overrides.status ?? 'ok',
    protocol_version: 1,
    max_concurrent: overrides.maxConcurrent ?? 32,
    inflight: overrides.inflight ?? 0,
  };
}

/** Builds a /quote response body matching the worker's current shape. */
export function fakeQuoteResponse(overrides: FakeQuoteOverrides = {}): Record<string, unknown> {
  const recipient = overrides.recipient ?? '0x' + 'aa'.repeat(20);
  const model = overrides.model ?? 'model-small';
  const price = overrides.pricePerWorkUnitWei ?? '1000';
  return {
    ticket_params: {
      recipient,
      face_value_wei: '0x' + (1_000_000_000).toString(16), // 1e9 wei
      win_prob: '0x64',
      recipient_rand_hash: '0x' + 'de'.repeat(32),
      seed: '0x' + 'be'.repeat(32),
      expiration_block: '0x3e8',
      expiration_params: {
        creation_round: 42,
        creation_round_block_hash: '0x' + 'ca'.repeat(32),
      },
    },
    model_prices: [
      {
        model,
        price_per_work_unit_wei: price,
      },
    ],
  };
}

/** Builds a /capabilities response body matching the worker's current shape. */
export function fakeCapabilitiesResponse(overrides: {
  capabilities?: Array<{ capability: string; workUnit: string; model: string; priceWei?: string }>;
} = {}): Record<string, unknown> {
  const entries =
    overrides.capabilities ??
    [
      {
        capability: 'openai:/v1/chat/completions',
        workUnit: 'token',
        model: 'model-small',
        priceWei: '1000',
      },
    ];
  return {
    protocol_version: 1,
    capabilities: entries.map((c) => ({
      capability: c.capability,
      work_unit: c.workUnit,
      models: [{ model: c.model, price_per_work_unit_wei: c.priceWei ?? '1000' }],
    })),
  };
}
