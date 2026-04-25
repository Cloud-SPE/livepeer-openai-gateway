// withMetrics wraps a PayerDaemonClient so every RPC also emits a
// counter+histogram pair through the Recorder. Mirrors the
// livepeer-service-registry `WithMetrics(c Chain, rec metrics.Recorder) Chain`
// constructor (internal/providers/chain/chain.go) — the wrapper satisfies the
// same interface as the unwrapped client and is allocation-light when the
// recorder is the noop.
//
// The deposit/reserve gauge updates live here because every successful
// `getDepositInfo` call already reads both numbers. The decorator forwards
// them into `setPayerDaemonDepositWei` / `setPayerDaemonReserveWei` so the
// existing health-loop drives the gauge cadence — no new RPCs are issued.
//
// `addNodeCostWei` is emitted on every successful `createPayment` against the
// returned `expectedValueWei`, labeled by the (capability, model, nodeId)
// fields the route handler attached to the input. Errors skip the emission
// (the call/observation pair still fires through `measured`).

import type {
  CreatePaymentInput,
  CreatePaymentOutput,
  DepositInfo,
  PayerDaemonClient,
  StartSessionInput,
  StartSessionOutput,
} from '../payerDaemon.js';
import {
  OUTCOME_ERROR,
  OUTCOME_OK,
  PAYER_DAEMON_CLOSE_SESSION,
  PAYER_DAEMON_CREATE_PAYMENT,
  PAYER_DAEMON_GET_DEPOSIT_INFO,
  PAYER_DAEMON_START_SESSION,
  type PayerDaemonMethod,
  type Recorder,
} from '../metrics/recorder.js';

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
    async startSession(
      input: StartSessionInput,
      signal?: AbortSignal,
    ): Promise<StartSessionOutput> {
      return measured(PAYER_DAEMON_START_SESSION, () => client.startSession(input, signal));
    },

    async createPayment(input: CreatePaymentInput): Promise<CreatePaymentOutput> {
      const output = await measured(PAYER_DAEMON_CREATE_PAYMENT, () =>
        client.createPayment(input),
      );
      recorder.addNodeCostWei(
        input.capability,
        input.model,
        input.nodeId,
        output.expectedValueWei.toString(),
      );
      return output;
    },

    async closeSession(workId: string, signal?: AbortSignal): Promise<void> {
      return measured(PAYER_DAEMON_CLOSE_SESSION, () => client.closeSession(workId, signal));
    },

    async getDepositInfo(signal?: AbortSignal): Promise<DepositInfo> {
      const info = await measured(PAYER_DAEMON_GET_DEPOSIT_INFO, () =>
        client.getDepositInfo(signal),
      );
      // Drive the deposit/reserve gauges off every successful poll so the
      // existing health-loop cadence is the only timing source.
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
