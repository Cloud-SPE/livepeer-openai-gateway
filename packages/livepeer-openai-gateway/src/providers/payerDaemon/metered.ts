/* v8 ignore file */

import type {
  CreatePaymentInput,
  CreatePaymentOutput,
  DepositInfo,
  PayerDaemonClient,
} from '../payerDaemon.js';
import {
  OUTCOME_ERROR,
  OUTCOME_OK,
  PAYER_DAEMON_CREATE_PAYMENT,
  PAYER_DAEMON_GET_DEPOSIT_INFO,
  type PayerDaemonMethod,
  type Recorder,
} from '@cloudspe/livepeer-openai-gateway-core/providers/metrics/recorder.js';

export function withMetrics(client: PayerDaemonClient, recorder: Recorder): PayerDaemonClient {
  async function measured<T>(method: PayerDaemonMethod, fn: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try {
      const result = await fn();
      const durationSec = (performance.now() - start) / 1000;
      recorder.incPayerDaemonCall(method, OUTCOME_OK);
      recorder.observePayerDaemonCall(method, durationSec);
      return result;
    } catch (err) {
      const durationSec = (performance.now() - start) / 1000;
      recorder.incPayerDaemonCall(method, OUTCOME_ERROR);
      recorder.observePayerDaemonCall(method, durationSec);
      throw err;
    }
  }

  return {
    async createPayment(input: CreatePaymentInput): Promise<CreatePaymentOutput> {
      const output = await measured(PAYER_DAEMON_CREATE_PAYMENT, () => client.createPayment(input));
      recorder.addNodeCostWei(
        input.capability,
        input.model,
        input.nodeId,
        output.expectedValueWei.toString(),
      );
      return output;
    },

    async getDepositInfo(signal?: AbortSignal): Promise<DepositInfo> {
      const info = await measured(PAYER_DAEMON_GET_DEPOSIT_INFO, () =>
        client.getDepositInfo(signal),
      );
      recorder.setPayerDaemonDepositWei(info.depositWei.toString());
      recorder.setPayerDaemonReserveWei(info.reserveWei.toString());
      return info;
    },

    isHealthy() {
      return client.isHealthy();
    },
    startHealthLoop() {
      client.startHealthLoop();
    },
    stopHealthLoop() {
      client.stopHealthLoop();
    },
    async close() {
      await client.close();
    },
  };
}
