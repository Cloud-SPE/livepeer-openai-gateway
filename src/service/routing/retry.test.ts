import { describe, expect, it } from 'vitest';
import { parseNodesYaml } from '../../config/nodes.js';
import { NodeBook } from '../nodes/nodebook.js';
import { classifyNodeError, runWithRetry, type AttemptResult } from './retry.js';

const yaml = `
nodes:
  - id: node-a
    url: https://a.example
    ethAddress: "0x${'aa'.repeat(20)}"
    supportedModels: ["m"]
    enabled: true
    tierAllowed: ["prepaid"]
    weight: 1
  - id: node-b
    url: https://b.example
    ethAddress: "0x${'bb'.repeat(20)}"
    supportedModels: ["m"]
    enabled: true
    tierAllowed: ["prepaid"]
    weight: 1
  - id: node-c
    url: https://c.example
    ethAddress: "0x${'cc'.repeat(20)}"
    supportedModels: ["m"]
    enabled: true
    tierAllowed: ["prepaid"]
    weight: 1
`;

function mkNodeBook(): NodeBook {
  const nb = new NodeBook();
  nb.replaceAll(parseNodesYaml(yaml));
  return nb;
}

describe('classifyNodeError', () => {
  it('never retries once a token has been delivered', () => {
    expect(classifyNodeError(502, true)).toBe('no_retry');
    expect(classifyNodeError(null, true)).toBe('no_retry');
  });
  it('retries on 5xx pre-first-token', () => {
    expect(classifyNodeError(500, false)).toBe('retry_next_node');
    expect(classifyNodeError(503, false)).toBe('retry_next_node');
  });
  it('retries on null status (transport error) pre-first-token', () => {
    expect(classifyNodeError(null, false)).toBe('retry_next_node');
  });
  it('does not retry on 4xx', () => {
    expect(classifyNodeError(400, false)).toBe('no_retry');
    expect(classifyNodeError(404, false)).toBe('no_retry');
  });
});

describe('runWithRetry', () => {
  it('returns on first success without further attempts', async () => {
    const nb = mkNodeBook();
    let attempts = 0;
    const out = await runWithRetry<number>(
      { nodeBook: nb, model: 'm', tier: 'prepaid', maxAttempts: 3 },
      async () => {
        attempts++;
        return { ok: true, value: 42 };
      },
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.value).toBe(42);
    expect(attempts).toBe(1);
  });

  it('retries retry_next_node failures up to maxAttempts', async () => {
    const nb = mkNodeBook();
    let attempts = 0;
    const out = await runWithRetry<number>(
      { nodeBook: nb, model: 'm', tier: 'prepaid', maxAttempts: 3 },
      async (): Promise<AttemptResult<number>> => {
        attempts++;
        return {
          ok: false,
          error: new Error('node down'),
          disposition: 'retry_next_node',
          firstTokenDelivered: false,
        };
      },
    );
    expect(out.ok).toBe(false);
    expect(attempts).toBe(3);
  });

  it('bails immediately on no_retry disposition', async () => {
    const nb = mkNodeBook();
    let attempts = 0;
    await runWithRetry<number>(
      { nodeBook: nb, model: 'm', tier: 'prepaid', maxAttempts: 5 },
      async (): Promise<AttemptResult<number>> => {
        attempts++;
        return {
          ok: false,
          error: new Error('4xx'),
          disposition: 'no_retry',
          firstTokenDelivered: false,
        };
      },
    );
    expect(attempts).toBe(1);
  });

  it('bails immediately once firstTokenDelivered is true', async () => {
    const nb = mkNodeBook();
    let attempts = 0;
    await runWithRetry<number>(
      { nodeBook: nb, model: 'm', tier: 'prepaid', maxAttempts: 5 },
      async (): Promise<AttemptResult<number>> => {
        attempts++;
        return {
          ok: false,
          error: new Error('mid-stream'),
          disposition: 'retry_next_node',
          firstTokenDelivered: true,
        };
      },
    );
    expect(attempts).toBe(1);
  });

  it('succeeds on the second attempt after the first fails', async () => {
    const nb = mkNodeBook();
    let attempts = 0;
    const out = await runWithRetry<string>(
      { nodeBook: nb, model: 'm', tier: 'prepaid', maxAttempts: 3 },
      async (): Promise<AttemptResult<string>> => {
        attempts++;
        if (attempts === 1) {
          return {
            ok: false,
            error: new Error('transient'),
            disposition: 'retry_next_node',
            firstTokenDelivered: false,
          };
        }
        return { ok: true, value: 'ok' };
      },
    );
    expect(attempts).toBe(2);
    expect(out.ok).toBe(true);
  });
});
