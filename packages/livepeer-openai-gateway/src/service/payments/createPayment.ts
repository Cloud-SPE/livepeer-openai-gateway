import type { CreatePaymentOutput, PayerDaemonClient } from '../../providers/payerDaemon.js';
import { PayerDaemonNotHealthyError } from '@cloudspe/livepeer-openai-gateway-core/service/payments/errors.js';

export interface CreatePaymentForRequestInput {
  nodeId: string;
  recipientEthAddress: string;
  pricePerWorkUnitWei: bigint;
  workUnits: bigint;
  capability: string;
  model: string;
  signal?: AbortSignal;
}

export interface CreatePaymentForRequestOutput {
  paymentBytes: Uint8Array;
  ticketsCreated: number;
  expectedValueWei: bigint;
}

export interface PaymentsServiceDeps {
  payerDaemon: PayerDaemonClient;
}

export interface PaymentsService {
  createPaymentForRequest(
    input: CreatePaymentForRequestInput,
  ): Promise<CreatePaymentForRequestOutput>;
}

export function createPaymentsService(deps: PaymentsServiceDeps): PaymentsService {
  return {
    async createPaymentForRequest(input): Promise<CreatePaymentForRequestOutput> {
      if (!deps.payerDaemon.isHealthy()) {
        throw new PayerDaemonNotHealthyError();
      }
      const faceValueWei = input.pricePerWorkUnitWei * input.workUnits;
      const out: CreatePaymentOutput = await deps.payerDaemon.createPayment({
        faceValueWei,
        recipientEthAddress: input.recipientEthAddress,
        capability: input.capability,
        model: input.model,
        nodeId: input.nodeId,
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      });
      return {
        paymentBytes: out.paymentBytes,
        ticketsCreated: out.ticketsCreated,
        expectedValueWei: out.expectedValueWei,
      };
    },
  };
}
