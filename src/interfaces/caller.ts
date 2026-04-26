import type { NodeCapability } from '../types/node.js';

/**
 * Generic caller identity threaded through the engine. The engine treats
 * `id` and `tier` as opaque strings — the shell's AuthResolver impl decides
 * what they mean. `metadata` carries shell-specific context (e.g. the full
 * customer row) and must NOT be inspected by engine code.
 *
 * Locked-in by exec-plan 0024.
 */
export interface Caller {
  id: string;
  tier: string;
  metadata?: unknown;
}

/**
 * Cost description handed to a Wallet at reserve-time. Carries both cents
 * and wei so any wallet impl can pick its preferred unit (USD-prepaid reads
 * `cents`, crypto reads `wei`, free-tier reads `estimatedTokens`).
 */
export interface CostQuote {
  cents: bigint;
  wei: bigint;
  estimatedTokens: number;
  model: string;
  capability: NodeCapability;
  callerTier: string;
}

/**
 * Actuals reported back to a Wallet at commit-time. Same multi-unit shape
 * as CostQuote — wallet impls pick the unit they care about.
 */
export interface UsageReport {
  cents: bigint;
  wei: bigint;
  actualTokens: number;
  model: string;
  capability: NodeCapability;
}

/**
 * Opaque handle returned by Wallet.reserve and consumed by commit/refund.
 * The Wallet impl decides the shape; the engine treats it as `unknown` and
 * passes it through verbatim.
 */
export type ReservationHandle = unknown;
