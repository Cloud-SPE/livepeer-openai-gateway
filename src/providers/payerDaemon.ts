import type { TicketParams } from '../types/node.js';

export interface StartSessionInput {
  ticketParams: TicketParams;
  label?: string;
}

export interface StartSessionOutput {
  workId: string;
}

export interface CreatePaymentInput {
  workId: string;
  workUnits: bigint;
  signal?: AbortSignal;
}

export interface CreatePaymentOutput {
  paymentBytes: Uint8Array;
  ticketsCreated: number;
  expectedValueWei: bigint;
}

export interface DepositInfo {
  depositWei: bigint;
  reserveWei: bigint;
  withdrawRound: bigint;
}

export interface PayerDaemonClient {
  startSession(input: StartSessionInput, signal?: AbortSignal): Promise<StartSessionOutput>;
  createPayment(input: CreatePaymentInput): Promise<CreatePaymentOutput>;
  closeSession(workId: string, signal?: AbortSignal): Promise<void>;
  getDepositInfo(signal?: AbortSignal): Promise<DepositInfo>;
  isHealthy(): boolean;
  startHealthLoop(): void;
  stopHealthLoop(): void;
  close(): Promise<void>;
}
