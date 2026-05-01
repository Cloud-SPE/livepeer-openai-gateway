/* v8 ignore file */

import { BinaryReader, BinaryWriter } from '@bufbuild/protobuf/wire';
import { Client, credentials, Metadata, status as GrpcStatus } from '@grpc/grpc-js';
import type { ServiceRegistryConfig } from '@cloudspe/livepeer-openai-gateway-core/config/serviceRegistry.js';
import type {
  Scheduler,
  ScheduledTask,
} from '@cloudspe/livepeer-openai-gateway-core/service/routing/scheduler.js';
import {
  CAPABILITY_STRINGS,
  capabilityString,
} from '@cloudspe/livepeer-openai-gateway-core/types/capability.js';
import type { NodeCapability } from '@cloudspe/livepeer-openai-gateway-core/types/node.js';
import type {
  NodeRef,
  SelectQuery,
  SelectedRoute,
  ServiceRegistryClient,
} from '../serviceRegistry.js';

export class ServiceRegistryUnavailableError extends Error {
  constructor(
    public readonly code: number | null,
    message: string,
  ) {
    super(`service-registry-daemon unavailable: ${message}`);
    this.name = 'ServiceRegistryUnavailableError';
  }
}

export interface GrpcServiceRegistryDeps {
  config: ServiceRegistryConfig;
  scheduler: Scheduler;
}

export interface GrpcServiceRegistryClient extends ServiceRegistryClient {
  isHealthy(): boolean;
  startHealthLoop(): void;
  stopHealthLoop(): void;
  close(): void;
}

const HEALTH_PATH = '/livepeer.registry.v1.Resolver/Health';
const LIST_KNOWN_PATH = '/livepeer.registry.v1.Resolver/ListKnown';
const RESOLVE_BY_ADDRESS_PATH = '/livepeer.registry.v1.Resolver/ResolveByAddress';
const SELECT_PATH = '/livepeer.registry.v1.Resolver/Select';

interface KnownEntryWire {
  ethAddress: string;
}

interface ListKnownResultWire {
  entries: KnownEntryWire[];
}

interface NodeWire {
  id: string;
  url: string;
  capabilities: Array<{ name: string }>;
  weight: number;
}

interface ResolveResultWire {
  nodes: NodeWire[];
}

export function createGrpcServiceRegistryClient(
  deps: GrpcServiceRegistryDeps,
): GrpcServiceRegistryClient {
  const target = deps.config.address ?? `unix://${deps.config.socketPath}`;
  const client = new Client(target, credentials.createInsecure());

  let healthy = true;
  let consecutiveFailures = 0;
  let healthTask: ScheduledTask | null = null;
  let healthRunning = false;

  function callDeadline(): { deadline: Date } {
    return { deadline: new Date(Date.now() + deps.config.callTimeoutMs) };
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

  async function healthInternal(): Promise<void> {
    return new Promise((resolve, reject) => {
      client.makeUnaryRequest(
        HEALTH_PATH,
        () => Buffer.alloc(0),
        () => undefined,
        {},
        new Metadata(),
        callDeadline(),
        (err) => {
          if (err) return reject(mapGrpcError(err));
          resolve();
        },
      );
    });
  }

  async function listKnownInternal(): Promise<ListKnownResultWire> {
    return new Promise((resolve, reject) => {
      client.makeUnaryRequest(
        LIST_KNOWN_PATH,
        () => Buffer.alloc(0),
        deserializeListKnownResult,
        {},
        new Metadata(),
        callDeadline(),
        (err, response?: ListKnownResultWire) => {
          if (err) return reject(mapGrpcError(err));
          if (!response) return reject(new ServiceRegistryUnavailableError(null, 'empty response'));
          resolve(response);
        },
      );
    });
  }

  async function resolveByAddressInternal(ethAddress: string): Promise<ResolveResultWire> {
    return new Promise((resolve, reject) => {
      client.makeUnaryRequest(
        RESOLVE_BY_ADDRESS_PATH,
        serializeResolveByAddressRequest,
        deserializeResolveResult,
        {
          ethAddress,
          allowLegacyFallback: false,
          allowUnsigned: false,
          forceRefresh: false,
        },
        new Metadata(),
        callDeadline(),
        (err, response?: ResolveResultWire) => {
          if (err) return reject(mapGrpcError(err));
          if (!response) return reject(new ServiceRegistryUnavailableError(null, 'empty response'));
          resolve(response);
        },
      );
    });
  }

  async function selectInternal(query: SelectQuery): Promise<SelectedRoute> {
    return new Promise((resolve, reject) => {
      client.makeUnaryRequest(
        SELECT_PATH,
        serializeSelectRequest,
        deserializeSelectResult,
        {
          capability: capabilityString(query.capability),
          offering: query.offering,
          tier: query.tier ?? '',
          minWeight: 0,
        },
        new Metadata(),
        callDeadline(),
        (err, response?: SelectedRoute | null) => {
          if (err) return reject(mapGrpcError(err));
          if (!response) {
            return reject(
              new ServiceRegistryUnavailableError(
                GrpcStatus.NOT_FOUND,
                `not_found: no route for capability="${capabilityString(query.capability)}" offering="${query.offering}"`,
              ),
            );
          }
          resolve(response);
        },
      );
    });
  }

  return {
    async select(query: SelectQuery): Promise<SelectedRoute> {
      return selectInternal(query);
    },

    async listKnown(capability?: NodeCapability): Promise<NodeRef[]> {
      const list = await listKnownInternal();
      const nodes: NodeWire[] = [];
      for (const entry of list.entries) {
        try {
          const resolved = await resolveByAddressInternal(entry.ethAddress);
          for (const node of resolved.nodes) nodes.push(node);
        } catch {
          // Drop unresolved entries from the shell cache/probe view.
        }
      }
      const refs = nodes.map(toNodeRef);
      if (capability !== undefined) {
        return refs.filter((ref) => ref.capabilities.includes(capability));
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

function toNodeRef(node: NodeWire): NodeRef {
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

function serializeResolveByAddressRequest(message: {
  ethAddress: string;
  allowLegacyFallback: boolean;
  allowUnsigned: boolean;
  forceRefresh: boolean;
}): Buffer {
  const writer = new BinaryWriter();
  if (message.ethAddress !== '') writer.uint32(10).string(message.ethAddress);
  if (message.allowLegacyFallback) writer.uint32(16).bool(message.allowLegacyFallback);
  if (message.allowUnsigned) writer.uint32(24).bool(message.allowUnsigned);
  if (message.forceRefresh) writer.uint32(32).bool(message.forceRefresh);
  return Buffer.from(writer.finish());
}

function serializeSelectRequest(message: {
  capability: string;
  offering: string;
  tier: string;
  minWeight: number;
}): Buffer {
  const writer = new BinaryWriter();
  if (message.capability !== '') writer.uint32(10).string(message.capability);
  if (message.offering !== '') writer.uint32(18).string(message.offering);
  if (message.tier !== '') writer.uint32(26).string(message.tier);
  if (message.minWeight !== 0) writer.uint32(32).int32(message.minWeight);
  return Buffer.from(writer.finish());
}

function deserializeListKnownResult(bytes: Buffer): ListKnownResultWire {
  const reader = new BinaryReader(bytes);
  const message: ListKnownResultWire = { entries: [] };
  while (reader.pos < reader.len) {
    const tag = reader.uint32();
    if (tag >>> 3 === 1) {
      message.entries.push(decodeKnownEntry(reader, reader.uint32()));
      continue;
    }
    if ((tag & 7) === 4 || tag === 0) break;
    reader.skip(tag & 7);
  }
  return message;
}

function decodeKnownEntry(reader: BinaryReader, length: number): KnownEntryWire {
  const end = reader.pos + length;
  const message: KnownEntryWire = { ethAddress: '' };
  while (reader.pos < end) {
    const tag = reader.uint32();
    if (tag >>> 3 === 1) {
      message.ethAddress = reader.string();
      continue;
    }
    if ((tag & 7) === 4 || tag === 0) break;
    reader.skip(tag & 7);
  }
  return message;
}

function deserializeResolveResult(bytes: Buffer): ResolveResultWire {
  const reader = new BinaryReader(bytes);
  const message: ResolveResultWire = { nodes: [] };
  while (reader.pos < reader.len) {
    const tag = reader.uint32();
    if (tag >>> 3 === 4) {
      message.nodes.push(decodeNode(reader, reader.uint32()));
      continue;
    }
    if ((tag & 7) === 4 || tag === 0) break;
    reader.skip(tag & 7);
  }
  return message;
}

function decodeNode(reader: BinaryReader, length: number): NodeWire {
  const end = reader.pos + length;
  const message: NodeWire = { id: '', url: '', capabilities: [], weight: 0 };
  while (reader.pos < end) {
    const tag = reader.uint32();
    switch (tag >>> 3) {
      case 1:
        message.id = reader.string();
        break;
      case 2:
        message.url = reader.string();
        break;
      case 5:
        message.capabilities.push(decodeCapability(reader, reader.uint32()));
        break;
      case 11:
        message.weight = reader.int32();
        break;
      default:
        if ((tag & 7) === 4 || tag === 0) return message;
        reader.skip(tag & 7);
    }
  }
  return message;
}

function decodeCapability(reader: BinaryReader, length: number): { name: string } {
  const end = reader.pos + length;
  let name = '';
  while (reader.pos < end) {
    const tag = reader.uint32();
    if (tag >>> 3 === 1) {
      name = reader.string();
      continue;
    }
    if ((tag & 7) === 4 || tag === 0) break;
    reader.skip(tag & 7);
  }
  return { name };
}

function deserializeSelectResult(bytes: Buffer): SelectedRoute | null {
  const reader = new BinaryReader(bytes);
  while (reader.pos < reader.len) {
    const tag = reader.uint32();
    if (tag >>> 3 === 1) {
      return decodeSelectedRoute(reader, reader.uint32());
    }
    if ((tag & 7) === 4 || tag === 0) break;
    reader.skip(tag & 7);
  }
  return null;
}

function decodeSelectedRoute(reader: BinaryReader, length: number): SelectedRoute {
  const end = reader.pos + length;
  const route: SelectedRoute = {
    workerUrl: '',
    ethAddress: '',
    capability: '',
    offering: '',
    pricePerWorkUnitWei: 0n,
    workUnit: '',
  };
  while (reader.pos < end) {
    const tag = reader.uint32();
    switch (tag >>> 3) {
      case 1:
        route.workerUrl = reader.string();
        break;
      case 2:
        route.ethAddress = reader.string();
        break;
      case 3:
        route.capability = reader.string();
        break;
      case 4:
        route.offering = reader.string();
        break;
      case 5:
        route.pricePerWorkUnitWei = BigInt(reader.string());
        break;
      case 6:
        route.workUnit = reader.string();
        break;
      case 7:
        route.extraJson = reader.bytes();
        break;
      case 8:
        route.constraintsJson = reader.bytes();
        break;
      default:
        if ((tag & 7) === 4 || tag === 0) return route;
        reader.skip(tag & 7);
    }
  }
  return route;
}

function mapGrpcError(err: { code?: number; message?: string }): ServiceRegistryUnavailableError {
  return new ServiceRegistryUnavailableError(err.code ?? null, err.message ?? String(err));
}
