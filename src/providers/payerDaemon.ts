import type { TicketParams } from '../types/node.js';

export interface PriceInfo {
  // Wei per `pixelsPerUnit` units of work. Matches the proto wire field.
  pricePerUnit: bigint;
  pixelsPerUnit: bigint;
}

export interface StartSessionInput {
  ticketParams: TicketParams;
  // Required since payment-daemon v0.8.10 (StartSessionRequest.price_info).
  // Must match the price the worker used at quote time
  // (cap.maxPrice / model_prices[i].price_per_work_unit_wei) — otherwise
  // ProcessPayment 402s with `invalid recipientRand for recipientRandHash`.
  priceInfo: PriceInfo;
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
