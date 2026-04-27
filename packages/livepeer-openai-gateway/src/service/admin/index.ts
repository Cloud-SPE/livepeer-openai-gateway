import type { Db } from '../../repo/db.js';
import type { PayerDaemonClient } from '@cloudspe/livepeer-openai-gateway-core/providers/payerDaemon.js';
import type { RedisClient } from '@cloudspe/livepeer-openai-gateway-core/providers/redis.js';
import type { CircuitBreaker } from '@cloudspe/livepeer-openai-gateway-core/service/routing/circuitBreaker.js';
import type { NodeIndex } from '@cloudspe/livepeer-openai-gateway-core/service/routing/nodeIndex.js';
import {
  createEngineAdminService,
  type EngineAdminService,
  type HealthReport,
  type NodeSummary,
  type NodeDetail,
  type EscrowReport,
} from '@cloudspe/livepeer-openai-gateway-core/service/admin/engine.js';
import {
  createShellAdminService,
  type ShellAdminService,
  type CustomerDetail,
} from './shell.js';

/**
 * Composed AdminService = engine half ⨁ shell half. Stage 2 splits
 * the implementation into engine.ts + shell.ts internally; the public
 * facade stays back-compat with the pre-split surface so route handlers
 * + tests don't need to change.
 *
 * Stage 3's repo split:
 *   - engine package exports `createEngineAdminService` from
 *     `service/admin/engine.ts` (this file goes away in the engine).
 *   - shell composes its own AdminService = engine ⨁ shell halves and
 *     exposes a single facade that's identical in shape to today's.
 */
export interface AdminService extends EngineAdminService, ShellAdminService {}

export interface AdminServiceDeps {
  db: Db;
  payerDaemon: PayerDaemonClient;
  redis?: RedisClient;
  nodeIndex: NodeIndex;
  circuitBreaker: CircuitBreaker;
}

export function createAdminService(deps: AdminServiceDeps): AdminService {
  const engine = createEngineAdminService(deps);
  const shell = createShellAdminService({ db: deps.db });
  return { ...engine, ...shell };
}

export type {
  HealthReport,
  NodeSummary,
  NodeDetail,
  EscrowReport,
  EngineAdminService,
  CustomerDetail,
  ShellAdminService,
};
