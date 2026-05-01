import { describe, expect, it, vi } from 'vitest';
import { createPaymentsService } from './createPayment.js';
import type { PayerDaemonClient } from '../../providers/payerDaemon.js';

function stubPayerDaemon(): PayerDaemonClient {
  return {
    async createPayment() {
      return {
        paymentBytes: new Uint8Array([1, 2, 3]),
        ticketsCreated: 1,
        expectedValueWei: 123n,
      };
    },
    async getDepositInfo() {
      return { depositWei: 0n, reserveWei: 0n, withdrawRound: 0n };
    },
    isHealthy() {
      return true;
    },
    startHealthLoop() {},
    stopHealthLoop() {},
    async close() {},
  };
}

describe('createPaymentsService', () => {
  it('passes capability and offering to the payer daemon', async () => {
    const payerDaemon = stubPayerDaemon();
    const createPayment = vi.spyOn(payerDaemon, 'createPayment');
    const service = createPaymentsService({ payerDaemon });

    await service.createPaymentForRequest({
      nodeId: 'node-1',
      recipientEthAddress: '0x1111111111111111111111111111111111111111',
      pricePerWorkUnitWei: 25n,
      workUnits: 4n,
      capability: 'openai:/v1/chat/completions',
      offering: 'Qwen3.6-27B',
    });

    expect(createPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        faceValueWei: 100n,
        capability: 'openai:/v1/chat/completions',
        offering: 'Qwen3.6-27B',
      }),
    );
  });
});
