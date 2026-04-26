import { describe, expect, it } from 'vitest';
import { loadServiceRegistryConfig } from './serviceRegistry.js';

describe('loadServiceRegistryConfig', () => {
  it('returns defaults when env is unset', () => {
    const cfg = loadServiceRegistryConfig({});
    expect(cfg.socketPath).toBe('/var/run/livepeer/service-registry.sock');
    expect(cfg.address).toBeNull();
    expect(cfg.healthIntervalMs).toBe(10_000);
    expect(cfg.healthFailureThreshold).toBe(2);
    expect(cfg.callTimeoutMs).toBe(5_000);
  });

  it('honors SERVICE_REGISTRY_ADDRESS when set', () => {
    const cfg = loadServiceRegistryConfig({
      SERVICE_REGISTRY_ADDRESS: 'registry.local:9000',
    });
    expect(cfg.address).toBe('registry.local:9000');
  });

  it('honors timing overrides', () => {
    const cfg = loadServiceRegistryConfig({
      SERVICE_REGISTRY_HEALTH_INTERVAL_MS: '15000',
      SERVICE_REGISTRY_HEALTH_FAILURE_THRESHOLD: '5',
      SERVICE_REGISTRY_CALL_TIMEOUT_MS: '8000',
    });
    expect(cfg.healthIntervalMs).toBe(15_000);
    expect(cfg.healthFailureThreshold).toBe(5);
    expect(cfg.callTimeoutMs).toBe(8_000);
  });

  it('rejects non-positive timing', () => {
    expect(() =>
      loadServiceRegistryConfig({ SERVICE_REGISTRY_HEALTH_INTERVAL_MS: '0' }),
    ).toThrow();
    expect(() =>
      loadServiceRegistryConfig({ SERVICE_REGISTRY_CALL_TIMEOUT_MS: '-1' }),
    ).toThrow();
  });
});
