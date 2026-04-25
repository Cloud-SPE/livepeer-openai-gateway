import type { CreatePaymentOutput, PayerDaemonClient } from '../../providers/payerDaemon.js';
import type { Quote } from '../../types/node.js';
import type { SessionCache } from './sessions.js';
import { PayerDaemonNotHealthyError, QuoteExpiredError } from './errors.js';

export interface CreatePaymentForRequestInput {
  nodeId: string;
  quote: Quote;
  workUnits: bigint;
  // capability + model are passed through to the PayerDaemon decorator so
  // the per-payment node-cost counter can be labeled correctly. They do not
  // affect the underlying gRPC payload (workId + workUnits only).
  capability: string;
  model: string;
  signal?: AbortSignal;
}

export interface CreatePaymentForRequestOutput {
  workId: string;
  paymentBytes: Uint8Array;
  ticketsCreated: number;
  expectedValueWei: bigint;
}

export interface PaymentsServiceDeps {
  payerDaemon: PayerDaemonClient;
  sessions: SessionCache;
  now?: () => Date;
}

export interface PaymentsService {
  createPaymentForRequest(
    input: CreatePaymentForRequestInput,
  ): Promise<CreatePaymentForRequestOutput>;
}

export function createPaymentsService(deps: PaymentsServiceDeps): PaymentsService {
  const now = deps.now ?? (() => new Date());
  return {
    async createPaymentForRequest(input): Promise<CreatePaymentForRequestOutput> {
      if (!deps.payerDaemon.isHealthy()) {
        throw new PayerDaemonNotHealthyError();
      }
      if (input.quote.expiresAt <= now()) {
        throw new QuoteExpiredError(input.nodeId);
      }
      const workId = await deps.sessions.getOrStart(input.nodeId, input.quote, input.signal);
      const out: CreatePaymentOutput = await deps.payerDaemon.createPayment({
        workId,
        workUnits: input.workUnits,
        capability: input.capability,
        model: input.model,
        nodeId: input.nodeId,
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      });
      return {
        workId,
        paymentBytes: out.paymentBytes,
        ticketsCreated: out.ticketsCreated,
        expectedValueWei: out.expectedValueWei,
      };
    },
  };
}
