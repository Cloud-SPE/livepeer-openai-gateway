import { credentials, Metadata, type ServiceError } from '@grpc/grpc-js';
import type { ServiceRegistryConfig } from '../../config/serviceRegistry.js';
import type {
  NodeRef,
  SelectQuery,
  ServiceRegistryClient,
} from '../serviceRegistry.js';
import type { NodeCapability } from '../../types/node.js';
import { CAPABILITY_STRINGS, capabilityString } from '../../types/capability.js';
import type { Scheduler, ScheduledTask } from '../../service/routing/scheduler.js';
import { ResolverClient as GeneratedResolverClient } from './gen/livepeer/registry/v1/resolver.js';
import type {
  ListKnownRequest,
  ListKnownResult,
  ResolveByAddressRequest,
  ResolveResult,
  SelectRequest,
  SelectResult,
} from './gen/livepeer/registry/v1/resolver.js';
import type { Node as ProtoNode } from './gen/livepeer/registry/v1/types.js';

export class ServiceRegistryUnavailableError extends Error {
  constructor(public readonly code: number | null, message: string) {
    super(`service-registry-daemon unavailable: ${message}`);
    this.name = 'ServiceRegistryUnavailableError';
  }
}

export interface GrpcServiceRegistryDeps {
  config: ServiceRegistryConfig;
  scheduler: Scheduler;
}

export interface GrpcServiceRegistryClient extends ServiceRegistryClient {
  /** Whether the daemon is currently considered healthy. */
  isHealthy(): boolean;
  /** Start the periodic Health() probe loop. */
  startHealthLoop(): void;
  /** Stop the periodic Health() probe loop. */
  stopHealthLoop(): void;
  /** Tear down the underlying gRPC channel. */
  close(): void;
}

/**
 * Real gRPC client for `livepeer-modules-project/service-registry-daemon`.
 * Modelled on `src/providers/payerDaemon/grpc.ts` — same health-probe
 * pattern, same call-deadline handling, same error mapping.
 *
 * Address resolution: `config.address` (TCP host:port) takes precedence
 * over `config.socketPath` (unix domain socket).
 *
 * Per exec-plan 0025.
 */
export function createGrpcServiceRegistryClient(
  deps: GrpcServiceRegistryDeps,
): GrpcServiceRegistryClient {
  const target = deps.config.address ?? `unix://${deps.config.socketPath}`;
  const client = new GeneratedResolverClient(target, credentials.createInsecure());

  let healthy = true;
  let consecutiveFailures = 0;
  let healthTask: ScheduledTask | null = null;
  let healthRunning = false;

  function callDeadline(): { deadline: Date } {
    return { deadline: new Date(Date.now() + deps.config.callTimeoutMs) };
  }

  async function selectInternal(req: SelectRequest): Promise<SelectResult> {
    return new Promise((resolve, reject) => {
      const meta = new Metadata();
      client.select(req, meta, callDeadline(), (err: ServiceError | null, response) => {
        if (err) return reject(mapGrpcError(err));
        if (!response) return reject(new ServiceRegistryUnavailableError(null, 'empty response'));
        resolve(response);
      });
    });
  }

  async function listKnownInternal(req: ListKnownRequest): Promise<ListKnownResult> {
    return new Promise((resolve, reject) => {
      const meta = new Metadata();
      client.listKnown(req, meta, callDeadline(), (err: ServiceError | null, response) => {
        if (err) return reject(mapGrpcError(err));
        if (!response) return reject(new ServiceRegistryUnavailableError(null, 'empty response'));
        resolve(response);
      });
    });
  }

  async function resolveByAddressInternal(req: ResolveByAddressRequest): Promise<ResolveResult> {
    return new Promise((resolve, reject) => {
      const meta = new Metadata();
      client.resolveByAddress(
        req,
        meta,
        callDeadline(),
        (err: ServiceError | null, response) => {
          if (err) return reject(mapGrpcError(err));
          if (!response) return reject(new ServiceRegistryUnavailableError(null, 'empty response'));
          resolve(response);
        },
      );
    });
  }

  async function healthInternal(): Promise<void> {
    return new Promise((resolve, reject) => {
      const meta = new Metadata();
      client.health({}, meta, callDeadline(), (err: ServiceError | null, response) => {
        if (err) return reject(mapGrpcError(err));
        if (!response) return reject(new ServiceRegistryUnavailableError(null, 'empty response'));
        resolve();
      });
    });
  }

  function scheduleHealth(delayMs: number): void {
    healthTask = deps.scheduler.schedule(async () => {
      if (!healthRunning) return;
      try {
        await healthInternal();
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

  return {
    async select(query: SelectQuery): Promise<NodeRef[]> {
      const result = await selectInternal({
        capability: capabilityString(query.capability),
        model: query.model ?? '',
        tier: query.tier ?? '',
        minWeight: 0,
        geoLat: 0,
        geoLon: 0,
        geoWithinKm: 0,
        hasGeo: false,
      });
      const exclude = new Set(query.excludeIds ?? []);
      return result.nodes.filter((n) => !exclude.has(n.id)).map(toNodeRef);
    },

    async listKnown(capability?: NodeCapability): Promise<NodeRef[]> {
      // The daemon's ListKnown returns eth_addresses + freshness only —
      // not full Node detail. To enumerate full Nodes (the engine's
      // quoteRefresher needs URLs to poll), we ResolveByAddress per
      // entry. Periodic invocation amortizes the 1+N RPC overhead.
      const list = await listKnownInternal({});
      const nodes: ProtoNode[] = [];
      for (const entry of list.entries) {
        try {
          const resolved = await resolveByAddressInternal({
            ethAddress: entry.ethAddress,
            allowLegacyFallback: true,
            allowUnsigned: true,
            forceRefresh: false,
          });
          for (const n of resolved.nodes) nodes.push(n);
        } catch {
          // Skip unresolvable entries — surface only what's currently usable.
        }
      }
      const refs = nodes.map(toNodeRef);
      if (capability !== undefined) {
        return refs.filter((r) => r.capabilities.includes(capability));
      }
      return refs;
    },

    isHealthy(): boolean {
      return healthy;
    },

    startHealthLoop(): void {
      if (healthRunning) return;
      healthRunning = true;
      scheduleHealth(0);
    },

    stopHealthLoop(): void {
      healthRunning = false;
      if (healthTask) {
        healthTask.cancel();
        healthTask = null;
      }
    },

    close(): void {
      this.stopHealthLoop();
      client.close();
    },
  };
}

const CANONICAL_TO_SHORT = new Map<string, NodeCapability>(
  Object.entries(CAPABILITY_STRINGS).map(([short, canonical]) => [
    canonical,
    short as NodeCapability,
  ]),
);

function toNodeRef(node: ProtoNode): NodeRef {
  const shortCaps: NodeCapability[] = [];
  for (const cap of node.capabilities) {
    const short = CANONICAL_TO_SHORT.get(cap.name);
    if (short !== undefined) shortCaps.push(short);
  }
  return {
    id: node.id,
    url: node.url,
    capabilities: shortCaps,
    weight: node.weight,
    metadata: node,
  };
}

function mapGrpcError(err: ServiceError): ServiceRegistryUnavailableError {
  return new ServiceRegistryUnavailableError(err.code, err.message);
}
