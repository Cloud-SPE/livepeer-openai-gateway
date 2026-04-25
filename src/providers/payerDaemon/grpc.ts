import { credentials, Metadata } from '@grpc/grpc-js';
import type { PayerDaemonConfig } from '../../config/payerDaemon.js';
import type {
  CreatePaymentInput,
  CreatePaymentOutput,
  DepositInfo,
  PayerDaemonClient as PayerDaemonClientInterface,
  StartSessionInput,
  StartSessionOutput,
} from '../payerDaemon.js';
import type { Scheduler, ScheduledTask } from '../../service/nodes/scheduler.js';
import { PayerDaemonClient as GeneratedClient } from './gen/livepeer/payments/v1/payer_daemon.js';
import { bigEndianBytesToBigint, domainTicketParamsToWire } from './convert.js';
import { mapGrpcError, PayerDaemonUnavailableError } from './errors.js';

export interface GrpcPayerDaemonDeps {
  config: PayerDaemonConfig;
  scheduler: Scheduler;
}

export function createGrpcPayerDaemonClient(deps: GrpcPayerDaemonDeps): PayerDaemonClientInterface {
  const client = new GeneratedClient(
    `unix://${deps.config.socketPath}`,
    credentials.createInsecure(),
  );

  let healthy = true;
  let consecutiveFailures = 0;
  let healthTask: ScheduledTask | null = null;
  let healthRunning = false;

  function callDeadline(signal?: AbortSignal): { deadline: Date; signal: AbortSignal } {
    const timeoutSignal = AbortSignal.timeout(deps.config.callTimeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    return {
      deadline: new Date(Date.now() + deps.config.callTimeoutMs),
      signal: combined,
    };
  }

  function scheduleHealth(delayMs: number): void {
    healthTask = deps.scheduler.schedule(async () => {
      if (!healthRunning) return;
      try {
        await getDepositInfoInternal();
        consecutiveFailures = 0;
        healthy = true;
      } catch {
        consecutiveFailures++;
        if (consecutiveFailures >= deps.config.healthFailureThreshold) {
          healthy = false;
        }
      }
      if (healthRunning) scheduleHealth(deps.config.healthIntervalMs);
    }, delayMs);
  }

  async function getDepositInfoInternal(signal?: AbortSignal): Promise<DepositInfo> {
    return new Promise<DepositInfo>((resolve, reject) => {
      const { deadline } = callDeadline(signal);
      const meta = new Metadata();
      client.getDepositInfo({}, meta, { deadline }, (err, response) => {
        if (err) {
          reject(mapGrpcError(err));
          return;
        }
        if (!response) {
          reject(new PayerDaemonUnavailableError(null, 'empty response'));
          return;
        }
        resolve({
          depositWei: bigEndianBytesToBigint(response.deposit),
          reserveWei: bigEndianBytesToBigint(response.reserve),
          withdrawRound: BigInt(response.withdrawRound ?? 0),
        });
      });
    });
  }

  return {
    async startSession(
      input: StartSessionInput,
      signal?: AbortSignal,
    ): Promise<StartSessionOutput> {
      return new Promise<StartSessionOutput>((resolve, reject) => {
        const { deadline } = callDeadline(signal);
        const meta = new Metadata();
        client.startSession(
          {
            ticketParams: domainTicketParamsToWire(input.ticketParams),
            label: input.label ?? '',
            priceInfo: {
              pricePerUnit: input.priceInfo.pricePerUnit,
              pixelsPerUnit: input.priceInfo.pixelsPerUnit,
              // capability + constraint are uint32/string identifiers used by
              // multi-capability daemons; for the bridge's single-capability
              // session model they're left at their zero values.
              capability: 0,
              constraint: '',
            },
          },
          meta,
          { deadline },
          (err, response) => {
            if (err) {
              reject(mapGrpcError(err));
              return;
            }
            if (!response) {
              reject(new PayerDaemonUnavailableError(null, 'empty response'));
              return;
            }
            resolve({ workId: response.workId });
          },
        );
      });
    },

    async createPayment(input: CreatePaymentInput): Promise<CreatePaymentOutput> {
      return new Promise<CreatePaymentOutput>((resolve, reject) => {
        const { deadline } = callDeadline(input.signal);
        const meta = new Metadata();
        client.createPayment(
          { workId: input.workId, workUnits: input.workUnits },
          meta,
          { deadline },
          (err, response) => {
            if (err) {
              reject(mapGrpcError(err));
              return;
            }
            if (!response) {
              reject(new PayerDaemonUnavailableError(null, 'empty response'));
              return;
            }
            resolve({
              paymentBytes: response.paymentBytes,
              ticketsCreated: response.ticketsCreated,
              expectedValueWei: bigEndianBytesToBigint(response.expectedValue),
            });
          },
        );
      });
    },

    async closeSession(workId: string, signal?: AbortSignal): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        const { deadline } = callDeadline(signal);
        const meta = new Metadata();
        client.closeSession({ workId }, meta, { deadline }, (err) => {
          if (err) {
            reject(mapGrpcError(err));
            return;
          }
          resolve();
        });
      });
    },

    async getDepositInfo(signal?: AbortSignal): Promise<DepositInfo> {
      return getDepositInfoInternal(signal);
    },

    isHealthy() {
      return healthy;
    },

    startHealthLoop() {
      if (healthRunning) return;
      healthRunning = true;
      scheduleHealth(0);
    },

    stopHealthLoop() {
      healthRunning = false;
      if (healthTask) {
        healthTask.cancel();
        healthTask = null;
      }
    },

    async close() {
      healthRunning = false;
      if (healthTask) healthTask.cancel();
      client.close();
    },
  };
}
