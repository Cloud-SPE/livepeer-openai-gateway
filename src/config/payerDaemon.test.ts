import { describe, expect, it } from 'vitest';
import { loadPayerDaemonConfig } from './payerDaemon.js';

describe('loadPayerDaemonConfig', () => {
  it('applies defaults when env is empty', () => {
    const cfg = loadPayerDaemonConfig({} as NodeJS.ProcessEnv);
    expect(cfg.socketPath).toBe('/var/run/livepeer-payment-daemon.sock');
    expect(cfg.healthIntervalMs).toBe(10_000);
    expect(cfg.healthFailureThreshold).toBe(2);
    expect(cfg.callTimeoutMs).toBe(5_000);
  });

  it('coerces numeric env values', () => {
    const cfg = loadPayerDaemonConfig({
      PAYER_DAEMON_SOCKET: '/tmp/test.sock',
      PAYER_DAEMON_HEALTH_INTERVAL_MS: '2000',
      PAYER_DAEMON_HEALTH_FAILURE_THRESHOLD: '4',
      PAYER_DAEMON_CALL_TIMEOUT_MS: '1000',
    } as NodeJS.ProcessEnv);
    expect(cfg.socketPath).toBe('/tmp/test.sock');
    expect(cfg.healthIntervalMs).toBe(2000);
    expect(cfg.healthFailureThreshold).toBe(4);
    expect(cfg.callTimeoutMs).toBe(1000);
  });
});
