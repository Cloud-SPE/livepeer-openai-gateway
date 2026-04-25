// metricsHook produces a pair of Fastify lifecycle hooks (onRequest +
// onResponse) that emit one (counter, histogram) pair per inbound request via
// Recorder. Pass A: this file is created but NOT registered against the
// customer-facing Fastify instance — Pass B does that wiring in main.ts.
//
// Label sourcing:
//   - capability: route handlers populate `request.metrics.capability` (e.g.
//     `openai:/v1/chat/completions`). Pass B amends each handler.
//   - model: same — handlers populate `request.metrics.model` after parsing
//     the request body.
//   - tier: read from `request.caller.customer.tier` set by the auth
//     pre-handler. Defaults to LABEL_UNSET for non-customer routes.
//   - outcome: derived from `reply.statusCode` via the bucket() helper.
//     402 and 429 are split out from the broader 4xx bucket because both are
//     load-bearing (402 = payment required → top-up funnel; 429 = rate-limit
//     → tier upgrade signal).
//
// Defensive: if any field is missing the hook still emits but with
// LABEL_UNSET as the value. The prom impl tolerates that label.

import type { FastifyReply, FastifyRequest, onRequestAsyncHookHandler, onResponseAsyncHookHandler } from 'fastify';
import {
  LABEL_UNSET,
  OUTCOME_2XX,
  OUTCOME_402,
  OUTCOME_429,
  OUTCOME_4XX,
  OUTCOME_5XX,
  type Recorder,
  type RequestOutcome,
} from '../../providers/metrics/recorder.js';

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Per-request metric labels. Set by route handlers after parsing the
     * request body. The metrics hook reads these in `onResponse` to emit the
     * inbound-request counter+histogram pair. Both fields default to
     * LABEL_UNSET when unset.
     */
    metrics?: {
      capability?: string;
      model?: string;
    };
    /** High-resolution start time for end-to-end inbound latency. */
    metricsStartTime?: number;
  }
}

export interface MetricsHooks {
  onRequest: onRequestAsyncHookHandler;
  onResponse: onResponseAsyncHookHandler;
}

export function metricsHook(recorder: Recorder): MetricsHooks {
  return {
    async onRequest(req: FastifyRequest): Promise<void> {
      req.metricsStartTime = performance.now();
    },
    async onResponse(req: FastifyRequest, reply: FastifyReply): Promise<void> {
      const start = req.metricsStartTime ?? performance.now();
      const durationSec = (performance.now() - start) / 1000;

      const capability = req.metrics?.capability ?? LABEL_UNSET;
      const model = req.metrics?.model ?? LABEL_UNSET;
      const tier = req.caller?.customer.tier ?? LABEL_UNSET;
      const outcome = bucketStatus(reply.statusCode);

      recorder.incRequest(capability, model, tier, outcome);
      recorder.observeRequest(capability, model, tier, outcome, durationSec);
    },
  };
}

function bucketStatus(status: number): RequestOutcome {
  if (status === 402) return OUTCOME_402;
  if (status === 429) return OUTCOME_429;
  if (status >= 200 && status < 300) return OUTCOME_2XX;
  if (status >= 400 && status < 500) return OUTCOME_4XX;
  return OUTCOME_5XX;
}
