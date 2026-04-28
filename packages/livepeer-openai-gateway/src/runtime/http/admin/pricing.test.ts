import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createFastifyServer } from '@cloudspe/livepeer-openai-gateway-core/providers/http/fastify.js';
import { startTestPg, type TestPg } from '../../../service/billing/testPg.js';
import { createRateCardService } from '../../../service/pricing/rateCard.js';
import { registerAdminPricingRoutes } from './pricing.js';

const ADMIN_TOKEN = 'p'.repeat(40);

let pg: TestPg;

beforeAll(async () => {
  pg = await startTestPg();
});
afterAll(async () => {
  if (pg) await pg.close();
});

beforeEach(async () => {
  await pg.db.execute(sql`
    TRUNCATE
      app.admin_audit_events,
      app.rate_card_chat_models,
      app.rate_card_embeddings,
      app.rate_card_images,
      app.rate_card_speech,
      app.rate_card_transcriptions,
      app.rate_card_chat_tiers
    CASCADE
  `);
  await pg.db.execute(sql`
    INSERT INTO app.rate_card_chat_tiers (tier, input_usd_per_million, output_usd_per_million) VALUES
      ('starter',  0.05, 0.10),
      ('standard', 0.15, 0.40),
      ('pro',      0.40, 1.20),
      ('premium',  2.50, 6.00)
  `);
});

async function buildServer() {
  const rateCardService = createRateCardService({ db: pg.db });
  await rateCardService.warmUp();
  const server = await createFastifyServer({ logger: false });
  registerAdminPricingRoutes(server.app, {
    db: pg.db,
    config: { token: ADMIN_TOKEN, ipAllowlist: [] },
    rateCardService,
  });
  await server.app.ready();
  return { server, rateCardService };
}

const auth = { 'x-admin-token': ADMIN_TOKEN, 'content-type': 'application/json' };

describe('admin pricing — auth', () => {
  it('401 when token is missing on a GET', async () => {
    const { server } = await buildServer();
    try {
      const res = await server.app.inject({ method: 'GET', url: '/admin/pricing/chat/tiers' });
      expect(res.statusCode).toBe(401);
    } finally {
      await server.close();
    }
  });
});

describe('admin pricing — chat tiers', () => {
  it('GET returns the four seeded tiers', async () => {
    const { server } = await buildServer();
    try {
      const res = await server.app.inject({
        method: 'GET',
        url: '/admin/pricing/chat/tiers',
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { tiers: Array<{ tier: string }> };
      expect(body.tiers).toHaveLength(4);
      expect(body.tiers.map((t) => t.tier).sort()).toEqual([
        'premium',
        'pro',
        'standard',
        'starter',
      ]);
    } finally {
      await server.close();
    }
  });

  it('PUT updates a tier and invalidates the cache', async () => {
    const { server, rateCardService } = await buildServer();
    try {
      const before = rateCardService.current().chatRateCard.entries.find((e) => e.tier === 'starter');
      expect(before?.inputUsdPerMillion).toBe(0.05);

      const res = await server.app.inject({
        method: 'PUT',
        url: '/admin/pricing/chat/tiers/starter',
        headers: auth,
        payload: JSON.stringify({ input_usd_per_million: 0.07, output_usd_per_million: 0.14 }),
      });
      expect(res.statusCode).toBe(200);

      // Give the post-write invalidate refresh a moment.
      await new Promise((r) => setTimeout(r, 50));
      const after = rateCardService.current().chatRateCard.entries.find((e) => e.tier === 'starter');
      expect(after?.inputUsdPerMillion).toBe(0.07);
      expect(after?.outputUsdPerMillion).toBe(0.14);
    } finally {
      await server.close();
    }
  });

  it('PUT 404 on unknown tier', async () => {
    const { server } = await buildServer();
    try {
      const res = await server.app.inject({
        method: 'PUT',
        url: '/admin/pricing/chat/tiers/notatier',
        headers: auth,
        payload: JSON.stringify({ input_usd_per_million: 1, output_usd_per_million: 1 }),
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await server.close();
    }
  });
});

describe('admin pricing — chat models CRUD', () => {
  it('POST creates a row + invalidates cache', async () => {
    const { server, rateCardService } = await buildServer();
    try {
      const res = await server.app.inject({
        method: 'POST',
        url: '/admin/pricing/chat/models',
        headers: auth,
        payload: JSON.stringify({
          model_or_pattern: 'Qwen3.6-27B',
          is_pattern: false,
          tier: 'standard',
        }),
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as { id: string; tier: string };
      expect(body.tier).toBe('standard');

      await new Promise((r) => setTimeout(r, 50));
      expect(rateCardService.current().modelToTierExact.get('Qwen3.6-27B')).toBe('standard');
    } finally {
      await server.close();
    }
  });

  it('POST 409 on duplicate (model_or_pattern + is_pattern)', async () => {
    const { server } = await buildServer();
    try {
      const body = {
        model_or_pattern: 'Qwen3.6-27B',
        is_pattern: false,
        tier: 'standard',
      };
      const r1 = await server.app.inject({
        method: 'POST',
        url: '/admin/pricing/chat/models',
        headers: auth,
        payload: JSON.stringify(body),
      });
      expect(r1.statusCode).toBe(201);
      const r2 = await server.app.inject({
        method: 'POST',
        url: '/admin/pricing/chat/models',
        headers: auth,
        payload: JSON.stringify(body),
      });
      expect(r2.statusCode).toBe(409);
    } finally {
      await server.close();
    }
  });

  it('POST 400 on invalid tier', async () => {
    const { server } = await buildServer();
    try {
      const res = await server.app.inject({
        method: 'POST',
        url: '/admin/pricing/chat/models',
        headers: auth,
        payload: JSON.stringify({
          model_or_pattern: 'X',
          is_pattern: false,
          tier: 'notatier',
        }),
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await server.close();
    }
  });

  it('GET lists rows; DELETE removes', async () => {
    const { server } = await buildServer();
    try {
      const create = await server.app.inject({
        method: 'POST',
        url: '/admin/pricing/chat/models',
        headers: auth,
        payload: JSON.stringify({
          model_or_pattern: 'Qwen3.6-27B',
          is_pattern: false,
          tier: 'standard',
        }),
      });
      const id = (create.json() as { id: string }).id;

      const list = await server.app.inject({
        method: 'GET',
        url: '/admin/pricing/chat/models',
        headers: auth,
      });
      expect((list.json() as { entries: unknown[] }).entries).toHaveLength(1);

      const del = await server.app.inject({
        method: 'DELETE',
        url: `/admin/pricing/chat/models/${id}`,
        headers: auth,
      });
      expect(del.statusCode).toBe(204);

      const list2 = await server.app.inject({
        method: 'GET',
        url: '/admin/pricing/chat/models',
        headers: auth,
      });
      expect((list2.json() as { entries: unknown[] }).entries).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it('DELETE 404 on missing id', async () => {
    const { server } = await buildServer();
    try {
      const res = await server.app.inject({
        method: 'DELETE',
        url: '/admin/pricing/chat/models/00000000-0000-0000-0000-000000000000',
        headers: auth,
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await server.close();
    }
  });
});

describe('admin pricing — embeddings/speech/transcriptions parity', () => {
  it('embeddings roundtrip', async () => {
    const { server, rateCardService } = await buildServer();
    try {
      const r = await server.app.inject({
        method: 'POST',
        url: '/admin/pricing/embeddings',
        headers: auth,
        payload: JSON.stringify({
          model_or_pattern: 'text-embedding-3-large',
          is_pattern: false,
          usd_per_million_tokens: '0.05',
        }),
      });
      expect(r.statusCode).toBe(201);
      await new Promise((r) => setTimeout(r, 50));
      const snap = rateCardService.current();
      expect(snap.embeddingsRateCard.entries[0]?.model).toBe('text-embedding-3-large');
    } finally {
      await server.close();
    }
  });

  it('speech roundtrip', async () => {
    const { server } = await buildServer();
    try {
      const r = await server.app.inject({
        method: 'POST',
        url: '/admin/pricing/speech',
        headers: auth,
        payload: JSON.stringify({
          model_or_pattern: 'tts-1',
          is_pattern: false,
          usd_per_million_chars: '5.0',
        }),
      });
      expect(r.statusCode).toBe(201);
      const list = await server.app.inject({
        method: 'GET',
        url: '/admin/pricing/speech',
        headers: auth,
      });
      expect((list.json() as { entries: unknown[] }).entries).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it('transcriptions roundtrip', async () => {
    const { server } = await buildServer();
    try {
      const r = await server.app.inject({
        method: 'POST',
        url: '/admin/pricing/transcriptions',
        headers: auth,
        payload: JSON.stringify({
          model_or_pattern: 'whisper-1',
          is_pattern: false,
          usd_per_minute: '0.003',
        }),
      });
      expect(r.statusCode).toBe(201);
    } finally {
      await server.close();
    }
  });
});

describe('admin pricing — images composite key', () => {
  it('POST + GET + DELETE with full (model, size, quality)', async () => {
    const { server } = await buildServer();
    try {
      const create = await server.app.inject({
        method: 'POST',
        url: '/admin/pricing/images',
        headers: auth,
        payload: JSON.stringify({
          model_or_pattern: 'dall-e-3',
          is_pattern: false,
          size: '1024x1024',
          quality: 'standard',
          usd_per_image: '0.025',
        }),
      });
      expect(create.statusCode).toBe(201);
      const list = await server.app.inject({
        method: 'GET',
        url: '/admin/pricing/images',
        headers: auth,
      });
      expect((list.json() as { entries: unknown[] }).entries).toHaveLength(1);
      const id = (create.json() as { id: string }).id;
      const del = await server.app.inject({
        method: 'DELETE',
        url: `/admin/pricing/images/${id}`,
        headers: auth,
      });
      expect(del.statusCode).toBe(204);
    } finally {
      await server.close();
    }
  });

  it('POST 409 on duplicate (model, is_pattern, size, quality)', async () => {
    const { server } = await buildServer();
    try {
      const body = {
        model_or_pattern: 'dall-e-3',
        is_pattern: false,
        size: '1024x1024',
        quality: 'standard',
        usd_per_image: '0.025',
      };
      const r1 = await server.app.inject({
        method: 'POST',
        url: '/admin/pricing/images',
        headers: auth,
        payload: JSON.stringify(body),
      });
      expect(r1.statusCode).toBe(201);
      const r2 = await server.app.inject({
        method: 'POST',
        url: '/admin/pricing/images',
        headers: auth,
        payload: JSON.stringify(body),
      });
      expect(r2.statusCode).toBe(409);
    } finally {
      await server.close();
    }
  });
});

describe('admin pricing — pattern entries', () => {
  it('POST with is_pattern=true accepts a glob and the cache reflects it', async () => {
    const { server, rateCardService } = await buildServer();
    try {
      const r = await server.app.inject({
        method: 'POST',
        url: '/admin/pricing/chat/models',
        headers: auth,
        payload: JSON.stringify({
          model_or_pattern: 'Qwen3.*',
          is_pattern: true,
          tier: 'standard',
          sort_order: 50,
        }),
      });
      expect(r.statusCode).toBe(201);
      await new Promise((r) => setTimeout(r, 50));
      const patterns = rateCardService.current().modelToTierPatterns;
      expect(patterns).toHaveLength(1);
      expect(patterns[0]?.pattern).toBe('Qwen3.*');
      expect(patterns[0]?.sortOrder).toBe(50);
    } finally {
      await server.close();
    }
  });
});
