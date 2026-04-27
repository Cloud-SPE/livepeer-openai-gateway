// Smallest runnable wiring of @cloudspe/livepeer-gateway-core. Boots a
// Fastify app on :8080 that accepts /v1/chat/completions, dispatches
// to the worker pool via the registry-daemon, signs payments via the
// payer-daemon, and uses the in-memory wallet (no real billing —
// every caller starts with a fixed budget that resets on restart).
//
// Auth is a no-op: any Bearer token resolves to a single anonymous
// caller. **Don't run this in production.** Use it to verify your
// worker pool + the two daemons are reachable, then replace the
// AuthResolver + Wallet with real impls.
//
// Required infrastructure (see compose.yaml, which brings all of
// these up together):
//   - Postgres 16 (engine.usage_records insert)
//   - Redis 7 (rate-limit storage)
//   - service-registry-daemon (resolver mode) at /var/run/livepeer/service-registry.sock
//   - payment-daemon (sender mode) at /var/run/livepeer/payment.sock

import Fastify from 'fastify';

import { CircuitBreaker } from '@cloudspe/livepeer-gateway-core/service/routing/circuitBreaker.js';
import { QuoteCache } from '@cloudspe/livepeer-gateway-core/service/routing/quoteCache.js';
import { createNodeIndex } from '@cloudspe/livepeer-gateway-core/service/routing/nodeIndex.js';
import { createQuoteRefresher } from '@cloudspe/livepeer-gateway-core/service/routing/quoteRefresher.js';
import { realScheduler } from '@cloudspe/livepeer-gateway-core/service/routing/scheduler.js';

import { createPaymentsService } from '@cloudspe/livepeer-gateway-core/service/payments/createPayment.js';
import { createSessionCache } from '@cloudspe/livepeer-gateway-core/service/payments/sessions.js';
import { InMemoryWallet } from '@cloudspe/livepeer-gateway-core/service/billing/inMemoryWallet.js';
import { createRateLimiter } from '@cloudspe/livepeer-gateway-core/service/rateLimit/index.js';
import { createTokenAuditService } from '@cloudspe/livepeer-gateway-core/service/tokenAudit/index.js';

import { createPgDatabase } from '@cloudspe/livepeer-gateway-core/providers/database/pg/index.js';
import { createIoRedisClient } from '@cloudspe/livepeer-gateway-core/providers/redis/ioredis.js';
import { createFetchNodeClient } from '@cloudspe/livepeer-gateway-core/providers/nodeClient/fetch.js';
import { withMetrics as withNodeClientMetrics } from '@cloudspe/livepeer-gateway-core/providers/nodeClient/metered.js';
import { createGrpcPayerDaemonClient } from '@cloudspe/livepeer-gateway-core/providers/payerDaemon/grpc.js';
import { withMetrics as withPayerDaemonMetrics } from '@cloudspe/livepeer-gateway-core/providers/payerDaemon/metered.js';
import { createGrpcServiceRegistryClient } from '@cloudspe/livepeer-gateway-core/providers/serviceRegistry/grpc.js';
import { createTiktokenProvider } from '@cloudspe/livepeer-gateway-core/providers/tokenizer/tiktoken.js';
import { NoopRecorder } from '@cloudspe/livepeer-gateway-core/providers/metrics/noop.js';

import { makeDb } from '@cloudspe/livepeer-gateway-core/repo/db.js';
import { runMigrations } from '@cloudspe/livepeer-gateway-core/repo/migrate.js';

import { loadDatabaseConfig } from '@cloudspe/livepeer-gateway-core/config/database.js';
import { loadRedisConfig } from '@cloudspe/livepeer-gateway-core/config/redis.js';
import { loadPayerDaemonConfig } from '@cloudspe/livepeer-gateway-core/config/payerDaemon.js';
import { loadServiceRegistryConfig } from '@cloudspe/livepeer-gateway-core/config/serviceRegistry.js';
import { loadPricingConfig } from '@cloudspe/livepeer-gateway-core/config/pricing.js';
import { loadRoutingConfig } from '@cloudspe/livepeer-gateway-core/config/routing.js';
import { defaultRateLimitConfig } from '@cloudspe/livepeer-gateway-core/config/rateLimit.js';
import { knownEncodings } from '@cloudspe/livepeer-gateway-core/config/tokenizer.js';

import { registerChatCompletionsRoute } from '@cloudspe/livepeer-gateway-core/runtime/http/chat/completions.js';
import { registerHealthzRoute } from '@cloudspe/livepeer-gateway-core/runtime/http/healthz.js';

import type {
  AuthResolver,
  AuthResolverRequest,
  Caller,
} from '@cloudspe/livepeer-gateway-core/interfaces/index.js';
import type { MetricsSink } from '@cloudspe/livepeer-gateway-core/providers/metrics.js';

// ── Adapters: the bare minimum ──────────────────────────────────────────────

// No-op AuthResolver. Any Bearer token resolves to a single anonymous
// caller. Production callers MUST replace this with a real auth flow.
const noopAuthResolver: AuthResolver = {
  async resolve(req: AuthResolverRequest): Promise<Caller | null> {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return null;
    return {
      id: 'anonymous',
      tier: 'free',
      rateLimitTier: 'free',
    };
  },
};

// In-memory wallet. Records reservations in process memory but does
// NOT enforce balance / quota — every reserve() succeeds. Resets on
// restart. Designed for the quickstart and engine unit tests.
// Production callers MUST replace this with a real Wallet impl that
// gates on actual balance / quota / postpaid policy.
const wallet = new InMemoryWallet();

// ── Engine wiring ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const recorder = new NoopRecorder();
  const recorderAsSink = recorder as unknown as MetricsSink;
  const scheduler = realScheduler();

  // Database + migrations.
  const dbConfig = loadDatabaseConfig();
  const database = createPgDatabase(dbConfig);
  const db = makeDb(database);
  console.warn('[minimal-shell] running migrations...');
  await runMigrations(db);

  // Redis (rate limiter).
  const redisConfig = loadRedisConfig();
  const redis = createIoRedisClient(redisConfig);
  const rateLimiter = createRateLimiter({
    redis,
    config: defaultRateLimitConfig(),
    recorder,
  });

  // Tokenizer + token audit.
  const tokenizer = createTiktokenProvider();
  tokenizer.preload(knownEncodings());
  const tokenAudit = createTokenAuditService({
    tokenizer,
    metrics: recorderAsSink,
    recorder,
  });

  // Payer daemon (gRPC sidecar).
  const payerDaemonConfig = loadPayerDaemonConfig();
  const payerDaemon = withPayerDaemonMetrics(
    createGrpcPayerDaemonClient({ config: payerDaemonConfig, scheduler }),
    recorder,
  );
  payerDaemon.startHealthLoop();

  // Service registry (gRPC sidecar).
  const serviceRegistryConfig = loadServiceRegistryConfig();
  const serviceRegistry = createGrpcServiceRegistryClient({
    config: serviceRegistryConfig,
    scheduler,
  });
  serviceRegistry.startHealthLoop();

  // Node index + node client.
  const nodeIndex = createNodeIndex();
  const nodeClient = withNodeClientMetrics(
    createFetchNodeClient(),
    recorder,
    (url) => nodeIndex.findIdByUrl(url),
  );

  // Initial node-pool enumeration.
  try {
    const initial = await serviceRegistry.listKnown();
    nodeIndex.replaceAll(initial);
    console.warn(`[minimal-shell] enumerated ${initial.length} known nodes`);
  } catch (err) {
    console.warn('[minimal-shell] initial listKnown failed; pool starts empty', err);
  }

  // Routing primitives + quote refresher.
  const routingConfig = loadRoutingConfig();
  const circuitBreaker = new CircuitBreaker(routingConfig.circuitBreaker);
  const quoteCache = new QuoteCache();
  const refresher = createQuoteRefresher({
    db,
    serviceRegistry,
    nodeClient,
    circuitBreaker,
    quoteCache,
    scheduler,
    config: routingConfig,
    bridgeEthAddress: payerDaemonConfig.bridgeEthAddress,
    recorder,
  });
  await refresher.start();

  // Payments service.
  const sessionCache = createSessionCache({ payerDaemon });
  const paymentsService = createPaymentsService({ payerDaemon, sessions: sessionCache });
  const pricing = loadPricingConfig();

  // HTTP.
  const app = Fastify({ logger: true });
  registerHealthzRoute(app);
  registerChatCompletionsRoute(app, {
    db,
    serviceRegistry,
    circuitBreaker,
    quoteCache,
    nodeClient,
    paymentsService,
    authResolver: noopAuthResolver,
    wallet,
    rateLimiter,
    tokenAudit,
    recorder,
    pricing,
  });

  const address = await app.listen({ host: '0.0.0.0', port: 8080 });
  console.warn(`[minimal-shell] listening on ${address}`);
  console.warn('[minimal-shell] try:');
  console.warn(
    "  curl -sS http://localhost:8080/v1/chat/completions -H 'authorization: Bearer demo' -H 'content-type: application/json' -d '{\"model\":\"llama-3.3-70b\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}'",
  );

  // Graceful shutdown.
  const shutdown = async (signal: string): Promise<void> => {
    console.warn(`[minimal-shell] ${signal} received`);
    refresher.stop();
    payerDaemon.stopHealthLoop();
    serviceRegistry.close();
    await app.close();
    await payerDaemon.close();
    await redis.close();
    await database.end();
    tokenizer.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[minimal-shell] fatal', err);
  process.exit(1);
});
