import { randomUUID } from 'node:crypto';
import type {
  CostQuote,
  ReservationHandle,
  UsageReport,
  Wallet,
} from '../../interfaces/index.js';

/**
 * In-memory `Wallet` reference implementation. Map-backed reservation
 * store with no concurrency control, no persistence, no cost limits.
 *
 * **NOT FOR PRODUCTION.** Designed for engine dispatcher unit tests and
 * `examples/minimal-shell/` quickstart. Loses all state on restart;
 * reservations leak if commit/refund are never called.
 *
 * Wallet semantics:
 *   - reserve always returns a non-null handle.
 *   - commit and refund tolerate unknown handles (treat as no-op) since
 *     a real engine flow always reserves before commit/refund.
 *
 * For inspection/assertions in tests, the impl exposes `state()` and
 * `reset()` outside the Wallet contract.
 */
export interface InMemoryReservation {
  id: string;
  callerId: string;
  quote: CostQuote;
  state: 'open' | 'committed' | 'refunded';
  committedAt?: Date;
  usage?: UsageReport;
}

export class InMemoryWallet implements Wallet {
  private readonly reservations = new Map<string, InMemoryReservation>();

  async reserve(callerId: string, quote: CostQuote): Promise<ReservationHandle> {
    const id = randomUUID();
    this.reservations.set(id, { id, callerId, quote, state: 'open' });
    return { id };
  }

  async commit(handle: ReservationHandle, usage: UsageReport): Promise<void> {
    const id = (handle as { id: string }).id;
    const r = this.reservations.get(id);
    if (!r || r.state !== 'open') return;
    r.state = 'committed';
    r.committedAt = new Date();
    r.usage = usage;
  }

  async refund(handle: ReservationHandle): Promise<void> {
    const id = (handle as { id: string }).id;
    const r = this.reservations.get(id);
    if (!r || r.state !== 'open') return;
    r.state = 'refunded';
  }

  /** Inspection helper — not part of the Wallet contract. */
  state(): InMemoryReservation[] {
    return Array.from(this.reservations.values());
  }

  /** Reset between tests — not part of the Wallet contract. */
  reset(): void {
    this.reservations.clear();
  }
}
