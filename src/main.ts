import { z } from 'zod';
import { loadAdminConfig } from './config/admin.js';
import { loadAuthConfig } from './config/auth.js';
import { loadDatabaseConfig } from './config/database.js';
import { loadPayerDaemonConfig } from './config/payerDaemon.js';
import { loadPricingConfig } from './config/pricing.js';
import { defaultRateLimitConfig } from './config/rateLimit.js';
import { loadRedisConfig } from './config/redis.js';
import { loadStripeConfig } from './config/stripe.js';
import { knownEncodings } from './config/tokenizer.js';
import { createPgDatabase } from './providers/database/pg/index.js';
import { createFastifyServer } from './providers/http/fastify.js';
import { createNoopMetricsSink } from './providers/metrics/noop.js';
import { createFetchNodeClient } from './providers/nodeClient/fetch.js';
import { createGrpcPayerDaemonClient } from './providers/payerDaemon/grpc.js';
import { createIoRedisClient } from './providers/redis/ioredis.js';
import { createSdkStripeClient } from './providers/stripe/sdk.js';
import { createTiktokenProvider } from './providers/tokenizer/tiktoken.js';
import { makeDb } from './repo/db.js';
import { runMigrations } from './repo/migrate.js';
import { registerAdminRoutes } from './runtime/http/admin/routes.js';
import { registerTopupRoute } from './runtime/http/billing/topup.js';
import { registerChatCompletionsRoute } from './runtime/http/chat/completions.js';
import { registerEmbeddingsRoute } from './runtime/http/embeddings/index.js';
import { registerImagesGenerationsRoute } from './runtime/http/images/generations.js';
import { registerHealthzRoute } from './runtime/http/healthz.js';
import { registerStripeWebhookRoute } from './runtime/http/stripe/webhook.js';
import { createAdminService } from './service/admin/index.js';
import { createAuthService } from './service/auth/index.js';
import { createPaymentsService } from './service/payments/createPayment.js';
import { createSessionCache } from './service/payments/sessions.js';
import { createNodesLoader } from './service/nodes/loader.js';
import { NodeBook } from './service/nodes/nodebook.js';
import { createQuoteRefresher } from './service/nodes/quoteRefresher.js';
import { realScheduler } from './service/nodes/scheduler.js';
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

  // Providers.
  const database = createPgDatabase(dbConfig);
  const db = makeDb(database);
  if (env.BRIDGE_AUTO_MIGRATE) {
    console.warn('[bridge] running migrations...');
    await runMigrations(db);
    console.warn('[bridge] migrations complete');
  }

  const redis = createIoRedisClient(redisConfig);
  const nodeClient = createFetchNodeClient();
  const scheduler = realScheduler();
  const payerDaemon = createGrpcPayerDaemonClient({ config: payerDaemonConfig, scheduler });
  const stripe = createSdkStripeClient({
    secretKey: stripeConfig.secretKey,
    webhookSecret: stripeConfig.webhookSecret,
  });
  const tokenizer = createTiktokenProvider();
  tokenizer.preload(knownEncodings());
  const metrics = createNoopMetricsSink();

  // NodeBook + background refresh.
  const nodeBook = new NodeBook();
  createNodesLoader({ db, nodeBook, configPath: env.NODES_CONFIG_PATH }).load();
  const refresher = createQuoteRefresher({
    db,
    nodeBook,
    nodeClient,
    scheduler,
    bridgeEthAddress: payerDaemonConfig.bridgeEthAddress,
  });
  refresher.start();
  payerDaemon.startHealthLoop();

  // Services.
  const authService = createAuthService({ db, config: authConfig });
  const sessionCache = createSessionCache({ payerDaemon });
  const paymentsService = createPaymentsService({ payerDaemon, sessions: sessionCache });
  const rateLimiter = createRateLimiter({ redis, config: rateLimitConfig });
  const tokenAudit = createTokenAuditService({ tokenizer, metrics });
  const adminService = createAdminService({ db, payerDaemon, redis, nodeBook });

  // HTTP.
  const server = await createFastifyServer({ logger: true });
  registerHealthzRoute(server.app);
  registerChatCompletionsRoute(server.app, {
    db,
    nodeBook,
    nodeClient,
    paymentsService,
    authService,
    rateLimiter,
    tokenAudit,
    pricing: pricingConfig,
  });
  registerEmbeddingsRoute(server.app, {
    db,
    nodeBook,
    nodeClient,
    paymentsService,
    authService,
    rateLimiter,
    pricing: pricingConfig,
  });
  registerImagesGenerationsRoute(server.app, {
    db,
    nodeBook,
    nodeClient,
    paymentsService,
    authService,
    rateLimiter,
    pricing: pricingConfig,
  });
  registerTopupRoute(server.app, { authService, stripe, config: stripeConfig });
  registerStripeWebhookRoute(server.app, { db, stripe });
  registerAdminRoutes(server.app, { db, config: adminConfig, adminService });

  // Graceful shutdown.
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.warn(`[bridge] ${signal} received — shutting down`);
    const hardKillTimer = setTimeout(() => {
      console.error('[bridge] graceful shutdown exceeded 30s — force exit');
      process.exit(1);
    }, 30_000);
    hardKillTimer.unref();
    try {
      refresher.stop();
      payerDaemon.stopHealthLoop();
      await server.close();
      await payerDaemon.close();
      await redis.close();
      await database.end();
      tokenizer.close();
      console.warn('[bridge] shutdown complete');
      process.exit(0);
    } catch (err) {
      console.error('[bridge] shutdown error', err);
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  const address = await server.listen({ host: env.HOST, port: env.PORT });
  console.warn(`[bridge] listening on ${address}`);
}

main().catch((err) => {
  console.error('[bridge] fatal startup error', err);
  process.exit(1);
});
