import { describe, expect, it } from 'vitest';
import { loadPayerDaemonConfig } from './payerDaemon.js';

// Canonical test eth address — format-valid, not a real wallet.
const TEST_ETH = '0x1234567890abcdef1234567890abcdef12345678';

describe('loadPayerDaemonConfig', () => {
  it('applies defaults when env is empty (except required BRIDGE_ETH_ADDRESS)', () => {
    const cfg = loadPayerDaemonConfig({ BRIDGE_ETH_ADDRESS: TEST_ETH } as NodeJS.ProcessEnv);
    expect(cfg.socketPath).toBe('/var/run/livepeer/payment.sock');
    expect(cfg.healthIntervalMs).toBe(10_000);
    expect(cfg.healthFailureThreshold).toBe(2);
    expect(cfg.callTimeoutMs).toBe(5_000);
    expect(cfg.bridgeEthAddress).toBe(TEST_ETH);
  });

  it('coerces numeric env values', () => {
    const cfg = loadPayerDaemonConfig({
      PAYER_DAEMON_SOCKET: '/tmp/test.sock',
      PAYER_DAEMON_HEALTH_INTERVAL_MS: '2000',
      PAYER_DAEMON_HEALTH_FAILURE_THRESHOLD: '4',
      PAYER_DAEMON_CALL_TIMEOUT_MS: '1000',
      BRIDGE_ETH_ADDRESS: TEST_ETH,
    } as NodeJS.ProcessEnv);
    expect(cfg.socketPath).toBe('/tmp/test.sock');
    expect(cfg.healthIntervalMs).toBe(2000);
    expect(cfg.healthFailureThreshold).toBe(4);
    expect(cfg.callTimeoutMs).toBe(1000);
  });

  it('rejects a missing BRIDGE_ETH_ADDRESS', () => {
    expect(() => loadPayerDaemonConfig({} as NodeJS.ProcessEnv)).toThrow();
  });

  it('rejects a malformed BRIDGE_ETH_ADDRESS', () => {
    expect(() =>
      loadPayerDaemonConfig({ BRIDGE_ETH_ADDRESS: '0xNOTHEX' } as NodeJS.ProcessEnv),
    ).toThrow();
  });
});
