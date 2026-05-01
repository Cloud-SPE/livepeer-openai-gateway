/* v8 ignore file */

import { BinaryReader, BinaryWriter } from '@bufbuild/protobuf/wire';
import { Client, credentials, Metadata } from '@grpc/grpc-js';
import type { PayerDaemonConfig } from '../../config/payerDaemon.js';
import type {
  CreatePaymentInput,
  CreatePaymentOutput,
  DepositInfo,
  PayerDaemonClient as PayerDaemonClientInterface,
} from '../payerDaemon.js';
import type {
  Scheduler,
  ScheduledTask,
} from '@cloudspe/livepeer-openai-gateway-core/service/routing/scheduler.js';
import { bigintToBigEndianBytes, bigEndianBytesToBigint, hexToBytes } from './convert.js';
import { mapGrpcError, PayerDaemonUnavailableError } from './errors.js';

export interface GrpcPayerDaemonDeps {
  config: PayerDaemonConfig;
  scheduler: Scheduler;
}

const CREATE_PAYMENT_PATH = '/livepeer.payments.v1.PayerDaemon/CreatePayment';
const GET_DEPOSIT_INFO_PATH = '/livepeer.payments.v1.PayerDaemon/GetDepositInfo';

interface CreatePaymentRequestWire {
  faceValue: Uint8Array;
  recipient: Uint8Array;
}

interface CreatePaymentResponseWire {
  paymentBytes: Uint8Array;
  ticketsCreated: number;
  expectedValue: Uint8Array;
}

interface GetDepositInfoResponseWire {
  deposit: Uint8Array;
  reserve: Uint8Array;
  withdrawRound: bigint;
}

export function createGrpcPayerDaemonClient(deps: GrpcPayerDaemonDeps): PayerDaemonClientInterface {
  const client = new Client(`unix://${deps.config.socketPath}`, credentials.createInsecure());

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
    return new Promise((resolve, reject) => {
      const { deadline } = callDeadline(signal);
      client.makeUnaryRequest(
        GET_DEPOSIT_INFO_PATH,
        () => Buffer.alloc(0),
        deserializeGetDepositInfoResponse,
        {},
        new Metadata(),
        { deadline },
        (err, response?: GetDepositInfoResponseWire) => {
          if (err) return reject(mapGrpcError(err));
          if (!response) return reject(new PayerDaemonUnavailableError(null, 'empty response'));
          resolve({
            depositWei: bigEndianBytesToBigint(response.deposit),
            reserveWei: bigEndianBytesToBigint(response.reserve),
            withdrawRound: response.withdrawRound,
          });
        },
      );
    });
  }

  return {
    async createPayment(input: CreatePaymentInput): Promise<CreatePaymentOutput> {
      return new Promise((resolve, reject) => {
        const { deadline } = callDeadline(input.signal);
        client.makeUnaryRequest(
          CREATE_PAYMENT_PATH,
          serializeCreatePaymentRequest,
          deserializeCreatePaymentResponse,
          {
            faceValue: bigintToBigEndianBytes(input.faceValueWei),
            recipient: hexToBytes(input.recipientEthAddress),
          } satisfies CreatePaymentRequestWire,
          new Metadata(),
          { deadline },
          (err, response?: CreatePaymentResponseWire) => {
            if (err) return reject(mapGrpcError(err));
            if (!response) return reject(new PayerDaemonUnavailableError(null, 'empty response'));
            resolve({
              paymentBytes: response.paymentBytes,
              ticketsCreated: response.ticketsCreated,
              expectedValueWei: bigEndianBytesToBigint(response.expectedValue),
            });
          },
        );
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

function serializeCreatePaymentRequest(message: CreatePaymentRequestWire): Buffer {
  const writer = new BinaryWriter();
  if (message.faceValue.length > 0) writer.uint32(10).bytes(message.faceValue);
  if (message.recipient.length > 0) writer.uint32(18).bytes(message.recipient);
  return Buffer.from(writer.finish());
}

function deserializeCreatePaymentResponse(bytes: Buffer): CreatePaymentResponseWire {
  const reader = new BinaryReader(bytes);
  const message: CreatePaymentResponseWire = {
    paymentBytes: new Uint8Array(),
    ticketsCreated: 0,
    expectedValue: new Uint8Array(),
  };
  while (reader.pos < reader.len) {
    const tag = reader.uint32();
    switch (tag >>> 3) {
      case 1:
        message.paymentBytes = reader.bytes();
        break;
      case 2:
        message.ticketsCreated = reader.int32();
        break;
      case 3:
        message.expectedValue = reader.bytes();
        break;
      default:
        if ((tag & 7) === 4 || tag === 0) return message;
        reader.skip(tag & 7);
    }
  }
  return message;
}

function deserializeGetDepositInfoResponse(bytes: Buffer): GetDepositInfoResponseWire {
  const reader = new BinaryReader(bytes);
  const message: GetDepositInfoResponseWire = {
    deposit: new Uint8Array(),
    reserve: new Uint8Array(),
    withdrawRound: 0n,
  };
  while (reader.pos < reader.len) {
    const tag = reader.uint32();
    switch (tag >>> 3) {
      case 1:
        message.deposit = reader.bytes();
        break;
      case 2:
        message.reserve = reader.bytes();
        break;
      case 3:
        message.withdrawRound = BigInt(reader.int64());
        break;
      default:
        if ((tag & 7) === 4 || tag === 0) return message;
        reader.skip(tag & 7);
    }
  }
  return message;
}
