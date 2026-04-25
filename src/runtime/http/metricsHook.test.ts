import { describe, expect, it } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { metricsHook } from './metricsHook.js';
import { CounterRecorder } from '../../providers/metrics/testhelpers.js';
import {
  LABEL_UNSET,
  OUTCOME_2XX,
  OUTCOME_402,
  OUTCOME_429,
  OUTCOME_4XX,
  OUTCOME_5XX,
  type RequestOutcome,
} from '../../providers/metrics/recorder.js';

interface FakeReply {
  statusCode: number;
}

interface CapturedLabels {
  capability: string | null;
  model: string | null;
  tier: string | null;
  outcome: RequestOutcome | null;
}

function makeSpy(rec: CounterRecorder): { rec: CounterRecorder; captured: CapturedLabels } {
  const captured: CapturedLabels = {
    capability: null,
    model: null,
    tier: null,
    outcome: null,
  };
  const original = rec.incRequest.bind(rec);
  rec.incRequest = (
    capability: string,
    model: string,
    tier: string,
    outcome: RequestOutcome,
  ): void => {
    captured.capability = capability;
    captured.model = model;
    captured.tier = tier;
    captured.outcome = outcome;
    original(capability, model, tier, outcome);
  };
  return { rec, captured };
}

async function runHook(
  rec: CounterRecorder,
  req: Partial<FastifyRequest>,
  reply: FakeReply,
): Promise<void> {
  const hooks = metricsHook(rec);
  // Cast: vitest unit test exercises the hook as a plain function pair.
  await hooks.onRequest.call(
    {} as never,
    req as FastifyRequest,
    reply as unknown as FastifyReply,
    () => undefined,
  );
  await hooks.onResponse.call(
    {} as never,
    req as FastifyRequest,
    reply as unknown as FastifyReply,
    () => undefined,
  );
}

describe('metricsHook', () => {
  it('emits 2xx outcome for status 200 and resolves all four labels from the request', async () => {
    const base = new CounterRecorder();
    const { rec, captured } = makeSpy(base);

    const req: Partial<FastifyRequest> = {
      metrics: { capability: 'openai:/v1/chat/completions', model: 'model-small' },
      caller: {
        customer: {
          id: 'cust_1',
          tier: 'prepaid',
        } as never,
        apiKey: {} as never,
      },
    };

    await runHook(rec, req, { statusCode: 200 });

    expect(base.requests).toBe(1);
    expect(base.requestObservations).toBe(1);
    expect(captured).toEqual({
      capability: 'openai:/v1/chat/completions',
      model: 'model-small',
      tier: 'prepaid',
      outcome: OUTCOME_2XX,
    });
  });

  it('buckets 402 separately from generic 4xx', async () => {
    const base = new CounterRecorder();
    const { rec, captured } = makeSpy(base);
    await runHook(rec, {}, { statusCode: 402 });
    expect(captured.outcome).toBe(OUTCOME_402);
  });

  it('buckets 429 separately from generic 4xx', async () => {
    const base = new CounterRecorder();
    const { rec, captured } = makeSpy(base);
    await runHook(rec, {}, { statusCode: 429 });
    expect(captured.outcome).toBe(OUTCOME_429);
  });

  it('buckets other 4xx into the 4xx outcome', async () => {
    const base = new CounterRecorder();
    const { rec, captured } = makeSpy(base);
    await runHook(rec, {}, { statusCode: 404 });
    expect(captured.outcome).toBe(OUTCOME_4XX);
  });

  it('buckets 5xx into the 5xx outcome', async () => {
    const base = new CounterRecorder();
    const { rec, captured } = makeSpy(base);
    await runHook(rec, {}, { statusCode: 503 });
    expect(captured.outcome).toBe(OUTCOME_5XX);
  });

  it('falls back to LABEL_UNSET when capability/model/tier are missing', async () => {
    const base = new CounterRecorder();
    const { rec, captured } = makeSpy(base);

    await runHook(rec, {}, { statusCode: 200 });

    expect(captured.capability).toBe(LABEL_UNSET);
    expect(captured.model).toBe(LABEL_UNSET);
    expect(captured.tier).toBe(LABEL_UNSET);
  });
});
