/* v8 ignore file */

export interface CreatePaymentInput {
  faceValueWei: bigint;
  recipientEthAddress: string;
  capability: string;
  model: string;
  nodeId: string;
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
  createPayment(input: CreatePaymentInput): Promise<CreatePaymentOutput>;
  getDepositInfo(signal?: AbortSignal): Promise<DepositInfo>;
  isHealthy(): boolean;
  startHealthLoop(): void;
  stopHealthLoop(): void;
  close(): Promise<void>;
}
