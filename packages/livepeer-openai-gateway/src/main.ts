import { z } from 'zod';
import { loadAdminConfig } from './config/admin.js';
import { loadAuthConfig } from './config/auth.js';
import { loadPayerDaemonConfig } from './config/payerDaemon.js';
import { loadDatabaseConfig } from '@cloudspe/livepeer-openai-gateway-core/config/database.js';
import { loadMetricsConfig } from '@cloudspe/livepeer-openai-gateway-core/config/metrics.js';
import {
  createPricingConfigProvider,
  loadPricingEnvConfig,
} from '@cloudspe/livepeer-openai-gateway-core/config/pricing.js';
import { createRateCardService } from './service/pricing/rateCard.js';
import { defaultRateLimitConfig } from '@cloudspe/livepeer-openai-gateway-core/config/rateLimit.js';
import { loadRedisConfig } from '@cloudspe/livepeer-openai-gateway-core/config/redis.js';
import { loadRoutingConfig } from '@cloudspe/livepeer-openai-gateway-core/config/routing.js';
import { loadServiceRegistryConfig } from '@cloudspe/livepeer-openai-gateway-core/config/serviceRegistry.js';
import { loadStripeConfig } from './config/stripe.js';
import { knownEncodings } from '@cloudspe/livepeer-openai-gateway-core/config/tokenizer.js';
import { createPgDatabase } from '@cloudspe/livepeer-openai-gateway-core/providers/database/pg/index.js';
import { createFastifyServer } from '@cloudspe/livepeer-openai-gateway-core/providers/http/fastify.js';
import { NoopRecorder } from '@cloudspe/livepeer-openai-gateway-core/providers/metrics/noop.js';
import { PrometheusRecorder } from '@cloudspe/livepeer-openai-gateway-core/providers/metrics/prometheus.js';
import type { Recorder } from '@cloudspe/livepeer-openai-gateway-core/providers/metrics/recorder.js';
import { withMetrics as withNodeClientMetrics } from '@cloudspe/livepeer-openai-gateway-core/providers/nodeClient/metered.js';
import { withMetrics as withStripeMetrics } from './providers/stripe/metered.js';
import { createFetchNodeClient } from '@cloudspe/livepeer-openai-gateway-core/providers/nodeClient/fetch.js';
import { createIoRedisClient } from '@cloudspe/livepeer-openai-gateway-core/providers/redis/ioredis.js';
import { createSdkStripeClient } from './providers/stripe/sdk.js';
import { createTiktokenProvider } from '@cloudspe/livepeer-openai-gateway-core/providers/tokenizer/tiktoken.js';
import { createConsoleLogger } from '@cloudspe/livepeer-openai-gateway-core/providers/logger/console.js';
import { makeDb } from './repo/db.js';
import { runMigrations } from './repo/migrate.js';
import { registerAccountRoutes } from './runtime/http/account/routes.js';
import { registerAdminConsoleStatic } from './runtime/http/admin/console/static.js';
import { registerAdminRoutes } from './runtime/http/admin/routes.js';
import { registerAdminPricingRoutes } from './runtime/http/admin/pricing.js';
import { registerTopupRoute } from './runtime/http/billing/topup.js';
import { idempotencyOnSend, idempotencyPreHandler } from './runtime/http/middleware/idempotency.js';
import { registerPortalStatic } from './runtime/http/portal/static.js';
import { registerChatCompletionsRoute } from './runtime/http/chat/completions.js';
import { registerEmbeddingsRoute } from './runtime/http/embeddings/index.js';
import { registerImagesGenerationsRoute } from './runtime/http/images/generations.js';
import { registerSpeechRoute } from './runtime/http/audio/speech.js';
import { registerTranscriptionsRoute } from './runtime/http/audio/transcriptions.js';
import { registerHealthzRoute } from '@cloudspe/livepeer-openai-gateway-core/runtime/http/healthz.js';
import { registerStripeWebhookRoute } from './runtime/http/stripe/webhook.js';
import { metricsHook } from '@cloudspe/livepeer-openai-gateway-core/runtime/http/metricsHook.js';
import { createMetricsServer } from '@cloudspe/livepeer-openai-gateway-core/runtime/metrics/server.js';
import { createAdminService } from './service/admin/index.js';
import { createAuthService } from './service/auth/index.js';
import { createAuthResolver } from './service/auth/authResolver.js';
import { createBasicAdminAuthResolver } from '@cloudspe/livepeer-openai-gateway-core/service/admin/basicAuthResolver.js';
import { createEngineAdminService } from '@cloudspe/livepeer-openai-gateway-core/service/admin/engine.js';
import { registerOperatorDashboard } from '@cloudspe/livepeer-openai-gateway-core/dashboard/index.js';
import { createPrepaidQuotaWallet } from './service/billing/wallet.js';
import { createMetricsSampler } from '@cloudspe/livepeer-openai-gateway-core/service/metrics/sampler.js';
import { CircuitBreaker } from '@cloudspe/livepeer-openai-gateway-core/service/routing/circuitBreaker.js';
import { createNodeIndex } from '@cloudspe/livepeer-openai-gateway-core/service/routing/nodeIndex.js';
import { realScheduler } from '@cloudspe/livepeer-openai-gateway-core/service/routing/scheduler.js';
import { createRateLimiter } from '@cloudspe/livepeer-openai-gateway-core/service/rateLimit/index.js';
import { createTokenAuditService } from '@cloudspe/livepeer-openai-gateway-core/service/tokenAudit/index.js';
import { createGrpcPayerDaemonClient } from './providers/payerDaemon/grpc.js';
import { withMetrics as withPayerDaemonMetrics } from './providers/payerDaemon/metered.js';
import { createGrpcServiceRegistryClient } from './providers/serviceRegistry/grpc.js';
import { createPaymentsService } from './service/payments/createPayment.js';

const MainEnvSchema = z.object({
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(8080),
  BRIDGE_AUTO_MIGRATE: z
    .union([z.literal('true'), z.literal('false')])
    .transform((v) => v === 'true')
    .default('true'),
  BRIDGE_DASHBOARD_ENABLED: z
    .union([z.literal('true'), z.literal('false')])
    .transform((v) => v === 'true')
    .default('false'),
  BRIDGE_OPS_USER: z.string().optional(),
  BRIDGE_OPS_PASS: z.string().optional(),
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
  const pricingEnvConfig = loadPricingEnvConfig();
  const rateLimitConfig = defaultRateLimitConfig();
  const metricsConfig = loadMetricsConfig();
  const routingConfig = loadRoutingConfig();
  const serviceRegistryConfig = loadServiceRegistryConfig();

  // Recorder. METRICS_LISTEN unset => Noop everywhere; metrics server is a
  // no-op shell, hook + sampler skip registration. METRICS_LISTEN set =>
  // Prometheus recorder; everything wires the same way for the rest of the
  // process.
  const metricsEnabled = metricsConfig.listen.trim().length > 0;
  const recorder: Recorder = metricsEnabled
    ? new PrometheusRecorder({
        maxSeriesPerMetric: metricsConfig.maxSeriesPerMetric,
        onCapExceeded: (name, observed, cap) => {
          logger.warn(
            `metric cardinality cap exceeded: name=${name} observed=${observed} cap=${cap}`,
          );
        },
      })
    : new NoopRecorder();
  // Build-info gauges: constant-1 series with version + env labels.
  // Engine surface (livepeer_bridge_engine_build_info) and shell surface
  // (cloudspe_app_build_info) both get set from the same pkg version
  // here — the shell process is one binary embedding both layers.
  const pkgVersion = process.env.BRIDGE_VERSION ?? '0.0.0';
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  recorder.setBuildInfo(pkgVersion, nodeEnv, process.versions.node);
  recorder.setShellBuildInfo(pkgVersion, nodeEnv, process.versions.node);

  // Providers.
  const database = createPgDatabase(dbConfig);
  const db = makeDb(database);
  if (env.BRIDGE_AUTO_MIGRATE) {
    logger.info('running migrations...');
    await runMigrations(db);
    logger.info('migrations complete');
  }

  // Rate-card service — DB-backed RateCardResolver (per 0030). warmUp
  // loads the seeded snapshot eagerly so the first chat / embeddings /
  // etc. request doesn't pay the DB-load latency. Admin write routes
  // call rateCardService.invalidate() after every insert/update/delete
  // so subsequent reads see the change.
  const rateCardService = createRateCardService({ db });
  await rateCardService.warmUp();
  const pricingConfig = createPricingConfigProvider(rateCardService, pricingEnvConfig);

  const redis = createIoRedisClient(redisConfig);
  const scheduler = realScheduler();

  // Registry-daemon gRPC client + node-id index. The index is populated
  // once at startup from listKnown(); the metered nodeClient resolves
  // outbound URLs to ids via this index. v1 is start-time-static — node
  // membership churn surfaces only via process restart.
  const serviceRegistry = createGrpcServiceRegistryClient({
    config: serviceRegistryConfig,
    scheduler,
  });
  const nodeIndex = createNodeIndex();

  const rawNodeClient = createFetchNodeClient();
  const nodeClient = withNodeClientMetrics(rawNodeClient, recorder, (url) =>
    nodeIndex.findIdByUrl(url),
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

  serviceRegistry.startHealthLoop();
  payerDaemon.startHealthLoop();

  // Initial node-pool enumeration. A failure here is non-fatal — the
  // pool stays empty until a successful enumeration, which the caller
  // can trigger via process restart.
  try {
    const initial = await serviceRegistry.listKnown();
    nodeIndex.replaceAll(initial);
    logger.info(`registry: enumerated ${initial.length} known nodes`);
  } catch (err) {
    logger.warn('registry: initial listKnown failed; node pool starts empty', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Routing primitives.
  const circuitBreaker = new CircuitBreaker(routingConfig.circuitBreaker);

  // Services.
  const authService = createAuthService({ db, config: authConfig });
  const authResolver = createAuthResolver({ authService });
  const wallet = createPrepaidQuotaWallet({ db, recorder });
  const paymentsService = createPaymentsService({ payerDaemon });
  const rateLimiter = createRateLimiter({ redis, config: rateLimitConfig, recorder });
  // The tokenAudit service uses the recorder ALSO as a MetricsSink. Both
  // PrometheusRecorder and NoopRecorder implement BOTH interfaces, but the
  // Recorder type alias here only declares the new surface — narrow back to
  // the concrete class via the dual interface. Phase 2 deletes the legacy
  // emissions; until then both surfaces stay live.
  const recorderAsSink =
    recorder as unknown as import('@cloudspe/livepeer-openai-gateway-core/providers/metrics.js').MetricsSink;
  const tokenAudit = createTokenAuditService({ tokenizer, metrics: recorderAsSink, recorder });
  const adminService = createAdminService({
    db,
    payerDaemon,
    redis,
    nodeIndex,
    circuitBreaker,
  });

  // Metrics HTTP server (separate Fastify instance — port + listener distinct
  // from the customer-facing one). Returns a no-op when METRICS_LISTEN is
  // empty, so the call site is unconditional.
  const metricsServer = createMetricsServer({
    listen: metricsConfig.listen,
    recorder,
    logger: {
      info: (msg, ctx) =>
        logger.info(`[metrics] ${msg}`, ctx as Record<string, unknown> | undefined),
      warn: (msg, ctx) =>
        logger.warn(`[metrics] ${msg}`, ctx as Record<string, unknown> | undefined),
    },
  });
  await metricsServer.start();

  // Periodic snapshot sampler. When metrics are off, the sampler still works
  // but its emissions land in NoopRecorder — skip starting it to avoid the
  // pointless DB query every 30s.
  const sampler = createMetricsSampler({
    db,
    nodeIndex,
    circuitBreaker,
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
  server.app.addHook('preHandler', idempotencyPreHandler({ db, authService }));
  server.app.addHook('onSend', idempotencyOnSend({ db, authService }));
  registerHealthzRoute(server.app);
  registerChatCompletionsRoute(server.app, {
    db,
    serviceRegistry,
    nodeIndex,
    circuitBreaker,
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
    nodeIndex,
    circuitBreaker,
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
    nodeIndex,
    circuitBreaker,
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
    nodeIndex,
    circuitBreaker,
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
    nodeIndex,
    circuitBreaker,
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
    serviceRegistry,
  });
  registerAdminPricingRoutes(server.app, {
    db,
    config: adminConfig,
    rateCardService,
  });
  await registerPortalStatic(server.app);
  await registerAdminConsoleStatic(server.app);

  // Engine's optional read-only operator dashboard. Off by default; the
  // shell ships its own richer admin SPA at /admin/console. OSS adopters
  // who don't have a token-issuing shell wire BRIDGE_DASHBOARD_ENABLED=
  // true + BRIDGE_OPS_USER/PASS for HTTP basic auth.
  if (env.BRIDGE_DASHBOARD_ENABLED) {
    if (!env.BRIDGE_OPS_USER || !env.BRIDGE_OPS_PASS) {
      throw new Error('BRIDGE_DASHBOARD_ENABLED=true requires BRIDGE_OPS_USER and BRIDGE_OPS_PASS');
    }
    registerOperatorDashboard(server.app, {
      adminAuthResolver: createBasicAdminAuthResolver({
        user: env.BRIDGE_OPS_USER,
        pass: env.BRIDGE_OPS_PASS,
      }),
      engineAdminService: createEngineAdminService({
        db,
        payerDaemon: payerDaemon as unknown as Parameters<
          typeof createEngineAdminService
        >[0]['payerDaemon'],
        redis,
        nodeIndex,
        circuitBreaker,
      }),
      buildInfo: {
        version: pkgVersion,
        nodeVersion: process.versions.node,
        environment: process.env.NODE_ENV ?? 'development',
      },
    });
  }

  // Graceful shutdown.
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
      payerDaemon.stopHealthLoop();
      serviceRegistry.close();
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
