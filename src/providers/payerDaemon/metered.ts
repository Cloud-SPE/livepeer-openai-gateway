// withMetrics wraps a PayerDaemonClient so every RPC also emits a
// counter+histogram pair through the Recorder. Mirrors the
// livepeer-service-registry `WithMetrics(c Chain, rec metrics.Recorder) Chain`
// constructor (internal/providers/chain/chain.go) — the wrapper satisfies the
// same interface as the unwrapped client and is allocation-light when the
// recorder is the noop.
//
// Pass A: this file is dormant; the composition root does not yet wrap the
// concrete client. Pass B activates by changing the wiring in main.ts.
//
// The deposit/reserve gauge updates live here because every successful
// `getDepositInfo` call already reads both numbers. The decorator forwards
// them into `setPayerDaemonDepositWei` / `setPayerDaemonReserveWei` so the
// existing health-loop drives the gauge cadence — no new RPCs are issued.
//
// Note: `addNodeCostWei` requires (capability, model, nodeId) in scope, which
// the `createPayment` arguments do not currently surface. Pass B will plumb
// those values through `CreatePaymentInput`; until then the decorator skips
// that emission. This is documented as a known limitation in the Pass A
// rollout report.

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
      // Pass A: (capability, model, nodeId) are not on CreatePaymentInput, so
      // the per-payment node-cost counter is intentionally skipped here. Pass
      // B plumbs those identifiers in and adds the addNodeCostWei call against
      // `output.expectedValueWei`.
      return measured(PAYER_DAEMON_CREATE_PAYMENT, () => client.createPayment(input));
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
