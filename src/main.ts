import { z } from 'zod';
import { loadAdminConfig } from './config/admin.js';
import { loadAuthConfig } from './config/auth.js';
import { loadDatabaseConfig } from './config/database.js';
import { loadMetricsConfig } from './config/metrics.js';
import { loadPayerDaemonConfig } from './config/payerDaemon.js';
import { loadPricingConfig } from './config/pricing.js';
import { defaultRateLimitConfig } from './config/rateLimit.js';
import { loadRedisConfig } from './config/redis.js';
import { loadStripeConfig } from './config/stripe.js';
import { knownEncodings } from './config/tokenizer.js';
import { createPgDatabase } from './providers/database/pg/index.js';
import { createFastifyServer } from './providers/http/fastify.js';
import { NoopRecorder } from './providers/metrics/noop.js';
import { PrometheusRecorder } from './providers/metrics/prometheus.js';
import type { Recorder } from './providers/metrics/recorder.js';
import { withMetrics as withNodeClientMetrics } from './providers/nodeClient/metered.js';
import { withMetrics as withPayerDaemonMetrics } from './providers/payerDaemon/metered.js';
import { withMetrics as withStripeMetrics } from './providers/stripe/metered.js';
import { createFetchNodeClient } from './providers/nodeClient/fetch.js';
import { createGrpcPayerDaemonClient } from './providers/payerDaemon/grpc.js';
import { createIoRedisClient } from './providers/redis/ioredis.js';
import { createSdkStripeClient } from './providers/stripe/sdk.js';
import { createTiktokenProvider } from './providers/tokenizer/tiktoken.js';
import { createConsoleLogger } from './providers/logger/console.js';
import { makeDb } from './repo/db.js';
import { runMigrations } from './repo/migrate.js';
import { registerAccountRoutes } from './runtime/http/account/routes.js';
import { registerAdminConsoleStatic } from './runtime/http/admin/console/static.js';
import { registerAdminRoutes } from './runtime/http/admin/routes.js';
import { registerTopupRoute } from './runtime/http/billing/topup.js';
import { registerPortalStatic } from './runtime/http/portal/static.js';
import { registerChatCompletionsRoute } from './runtime/http/chat/completions.js';
import { registerEmbeddingsRoute } from './runtime/http/embeddings/index.js';
import { registerImagesGenerationsRoute } from './runtime/http/images/generations.js';
import { registerSpeechRoute } from './runtime/http/audio/speech.js';
import { registerTranscriptionsRoute } from './runtime/http/audio/transcriptions.js';
import { registerHealthzRoute } from './runtime/http/healthz.js';
import { registerStripeWebhookRoute } from './runtime/http/stripe/webhook.js';
import { metricsHook } from './runtime/http/metricsHook.js';
import { createMetricsServer } from './runtime/metrics/server.js';
import { createAdminService } from './service/admin/index.js';
import { createAuthService } from './service/auth/index.js';
import { createAuthResolver } from './service/auth/authResolver.js';
import { createPrepaidQuotaWallet } from './service/billing/wallet.js';
import { createMetricsSampler } from './service/metrics/sampler.js';
import { createPaymentsService } from './service/payments/createPayment.js';
import { createSessionCache } from './service/payments/sessions.js';
import { createNodesLoader } from './service/nodes/loader.js';
import { NodeBook } from './service/nodes/nodebook.js';
import { createNodeBookRegistry } from './service/nodes/nodebookRegistry.js';
import { createQuoteRefresher } from './service/nodes/quoteRefresher.js';
import { CircuitBreaker } from './service/routing/circuitBreaker.js';
import { QuoteCache } from './service/routing/quoteCache.js';
import { realScheduler } from './service/routing/scheduler.js';
import { loadRoutingConfig } from './config/routing.js';
import { createRateLimiter } from './service/rateLimit/index.js';
import { createTokenAuditService } from './service/tokenAudit/index.js';

const MainEnvSchema = z.object({
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(8080),
  NODES_CONFIG_PATH: z.string().default('./nodes.yaml'),
  BRIDGE_AUTO_MIGRATE: z
    .union([z.literal('true'), z.literal('false')])
    .transform((v) => v === 'true')
    .default('true'),
});

async function main(): Promise<void> {
  const env = MainEnvSchema.parse(process.env);
  const logger = createConsoleLogger();

  // Config loading — each loader is Zod-validated and throws with a clear
  // message on missing/invalid env. Let those errors bubble out of main().
  const dbConfig = loadDatabaseConfig();
  const redisConfig = loadRedisConfig();
  const authConfig = loadAuthConfig();
  const payerDaemonConfig = loadPayerDaemonConfig();
  const stripeConfig = loadStripeConfig();
  const adminConfig = loadAdminConfig();
  const pricingConfig = loadPricingConfig();
  const rateLimitConfig = defaultRateLimitConfig();
  const metricsConfig = loadMetricsConfig();
  const routingConfig = loadRoutingConfig();

  // Recorder. METRICS_LISTEN unset => Noop everywhere; metrics server is a
  // no-op shell, hook + sampler skip registration. METRICS_LISTEN set =>
  // Prometheus recorder; everything wires the same way for the rest of the
  // process.
  const metricsEnabled = metricsConfig.listen.trim().length > 0;
  const recorder: Recorder = metricsEnabled
    ? new PrometheusRecorder({
        maxSeriesPerMetric: metricsConfig.maxSeriesPerMetric,
        onCapExceeded: (name, observed, cap) => {
          logger.warn(`metric cardinality cap exceeded: name=${name} observed=${observed} cap=${cap}`);
        },
      })
    : new NoopRecorder();
  // Build-info gauge: constant-1 series with version + env labels. Set once.
  const pkgVersion = process.env.BRIDGE_VERSION ?? '0.0.0';
  recorder.setBuildInfo(pkgVersion, process.env.NODE_ENV ?? 'development', process.versions.node);

  // Providers.
  const database = createPgDatabase(dbConfig);
  const db = makeDb(database);
  if (env.BRIDGE_AUTO_MIGRATE) {
    logger.info('running migrations...');
    await runMigrations(db);
    logger.info('migrations complete');
  }

  const redis = createIoRedisClient(redisConfig);
  const scheduler = realScheduler();

  // NodeBook is constructed before the nodeClient decorator because the
  // decorator's resolveNodeId callback closes over it.
  const nodeBook = new NodeBook();

  const rawNodeClient = createFetchNodeClient();
  const nodeClient = withNodeClientMetrics(rawNodeClient, recorder, (url) =>
    nodeBook.findIdByUrl(url),
  );
  const rawPayerDaemon = createGrpcPayerDaemonClient({
    config: payerDaemonConfig,
    scheduler,
  });
  const payerDaemon = withPayerDaemonMetrics(rawPayerDaemon, recorder);
  const rawStripe = createSdkStripeClient({
    secretKey: stripeConfig.secretKey,
    webhookSecret: stripeConfig.webhookSecret,
  });
  const stripe = withStripeMetrics(rawStripe, recorder);
  const tokenizer = createTiktokenProvider();
  tokenizer.preload(knownEncodings());

  // NodeBook population + background refresh.
  createNodesLoader({ db, nodeBook, configPath: env.NODES_CONFIG_PATH }).load();
  const refresher = createQuoteRefresher({
    db,
    nodeBook,
    nodeClient,
    scheduler,
    bridgeEthAddress: payerDaemonConfig.bridgeEthAddress,
    recorder,
  });
  refresher.start();
  // Bootstrap an initial QuoteCache fill once the legacy refresher has
  // had a chance to populate NodeBook. Subsequent ticks re-sync via the
  // setInterval below until task 18 wires the new registry-driven
  // refresher (which writes to QuoteCache directly).
  setTimeout(syncNodeBookQuotesToCache, 1_000);
  const quoteSyncInterval = setInterval(
    syncNodeBookQuotesToCache,
    routingConfig.quoteRefreshSeconds * 1000,
  );
  quoteSyncInterval.unref();
  payerDaemon.startHealthLoop();

  // Services.
  const authService = createAuthService({ db, config: authConfig });
  const authResolver = createAuthResolver({ authService });
  const wallet = createPrepaidQuotaWallet({ db, recorder });
  // ServiceRegistryClient — stage-1 NodeBook-backed wrapper. Stage-2 swaps
  // for a gRPC client to livepeer-modules-project/service-registry-daemon
  // and threads serviceRegistry through dispatchers + quoteRefresher;
  // route handlers don't consume it yet.
  // ServiceRegistryClient — currently NodeBook-backed via the stage-1
  // wrapper; task 18 swaps to createGrpcServiceRegistryClient when the
  // daemon-side wiring + quote-cache sync are mature enough to retire
  // NodeBook entirely. Until then, NodeBook stays as the data source for
  // both this wrapper AND the legacy adminService/metricsSampler.
  const serviceRegistry = createNodeBookRegistry({ nodeBook });
  const circuitBreaker = new CircuitBreaker(routingConfig.circuitBreaker);
  const quoteCache = new QuoteCache();
  // Legacy quoteRefresher writes quotes to NodeBook; sync them into the
  // QuoteCache that dispatchers now read from. After each refresh tick,
  // copy the snapshot in. Out of scope for stage 2: writing the new
  // quoteRefresher in service/routing/quoteRefresher.ts which writes
  // directly to QuoteCache (it exists; main.ts just doesn't use it yet).
  function syncNodeBookQuotesToCache(): void {
    for (const entry of nodeBook.list()) {
      quoteCache.replaceNode(entry.config.id, entry.quotes);
    }
  }
  const sessionCache = createSessionCache({ payerDaemon });
  const paymentsService = createPaymentsService({ payerDaemon, sessions: sessionCache });
  const rateLimiter = createRateLimiter({ redis, config: rateLimitConfig, recorder });
  // The tokenAudit service uses the recorder ALSO as a MetricsSink. Both
  // PrometheusRecorder and NoopRecorder implement BOTH interfaces, but the
  // Recorder type alias here only declares the new surface — narrow back to
  // the concrete class via the dual interface. Phase 2 deletes the legacy
  // emissions; until then both surfaces stay live.
  const recorderAsSink = recorder as unknown as import('./providers/metrics.js').MetricsSink;
  const tokenAudit = createTokenAuditService({ tokenizer, metrics: recorderAsSink, recorder });
  const adminService = createAdminService({ db, payerDaemon, redis, nodeBook });

  // Metrics HTTP server (separate Fastify instance — port + listener distinct
  // from the customer-facing one). Returns a no-op when METRICS_LISTEN is
  // empty, so the call site is unconditional.
  const metricsServer = createMetricsServer({
    listen: metricsConfig.listen,
    recorder,
    logger: {
      info: (msg, ctx) => logger.info(`[metrics] ${msg}`, ctx as Record<string, unknown> | undefined),
      warn: (msg, ctx) => logger.warn(`[metrics] ${msg}`, ctx as Record<string, unknown> | undefined),
    },
  });
  await metricsServer.start();

  // Periodic snapshot sampler. When metrics are off, the sampler still works
  // but its emissions land in NoopRecorder — skip starting it to avoid the
  // pointless DB query every 30s.
  const sampler = createMetricsSampler({
    db,
    nodeBook,
    depositInfoSource: () => null,
    recorder,
    intervalMs: 30_000,
  });
  if (metricsEnabled) sampler.start();

  // HTTP.
  const server = await createFastifyServer({ logger: true });
  // Customer-facing request lifecycle metrics. Skip when metrics are off so
  // the hook doesn't pay for a `performance.now()` per request for nothing.
  if (metricsEnabled) {
    const hooks = metricsHook(recorder);
    server.app.addHook('onRequest', hooks.onRequest);
    server.app.addHook('onResponse', hooks.onResponse);
  }
  registerHealthzRoute(server.app);
  registerChatCompletionsRoute(server.app, {
    db,
    serviceRegistry,
    circuitBreaker,
    quoteCache,
    nodeClient,
    paymentsService,
    authResolver,
    wallet,
    rateLimiter,
    tokenAudit,
    recorder,
    pricing: pricingConfig,
  });
  registerEmbeddingsRoute(server.app, {
    db,
    serviceRegistry,
    circuitBreaker,
    quoteCache,
    nodeClient,
    paymentsService,
    authResolver,
    wallet,
    rateLimiter,
    pricing: pricingConfig,
  });
  registerImagesGenerationsRoute(server.app, {
    db,
    serviceRegistry,
    circuitBreaker,
    quoteCache,
    nodeClient,
    paymentsService,
    authResolver,
    wallet,
    rateLimiter,
    pricing: pricingConfig,
  });
  registerSpeechRoute(server.app, {
    db,
    serviceRegistry,
    circuitBreaker,
    quoteCache,
    nodeClient,
    paymentsService,
    authResolver,
    wallet,
    rateLimiter,
    pricing: pricingConfig,
  });
  await registerTranscriptionsRoute(server.app, {
    db,
    serviceRegistry,
    circuitBreaker,
    quoteCache,
    nodeClient,
    paymentsService,
    authResolver,
    wallet,
    rateLimiter,
    pricing: pricingConfig,
  });
  registerTopupRoute(server.app, { authResolver, stripe, config: stripeConfig });
  registerStripeWebhookRoute(server.app, { db, stripe, recorder });
  registerAccountRoutes(server.app, {
    db,
    authResolver,
    authConfig,
    rateLimitConfig,
  });
  registerAdminRoutes(server.app, {
    db,
    config: adminConfig,
    adminService,
    authConfig,
    nodesConfigPath: env.NODES_CONFIG_PATH,
  });
  await registerPortalStatic(server.app);
  await registerAdminConsoleStatic(server.app);

  // Graceful shutdown.
  void quoteCache;
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} received — shutting down`);
    const hardKillTimer = setTimeout(() => {
      logger.error('graceful shutdown exceeded 30s — force exit');
      process.exit(1);
    }, 30_000);
    hardKillTimer.unref();
    try {
      sampler.stop();
      refresher.stop();
      payerDaemon.stopHealthLoop();
      await server.close();
      await metricsServer.stop();
      await payerDaemon.close();
      await redis.close();
      await database.end();
      tokenizer.close();
      logger.info('shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error('shutdown error', err as Error);
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  const address = await server.listen({ host: env.HOST, port: env.PORT });
  logger.info(`listening on ${address}`);
}

main().catch((err) => {
  // Logger isn't constructed yet on startup-error path — fall back to console.
  console.error('[bridge] fatal startup error', err);
  process.exit(1);
});
