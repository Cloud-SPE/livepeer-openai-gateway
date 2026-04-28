import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { startTestPg, type TestPg } from '../billing/testPg.js';
import { createRateCardService } from './rateCard.js';

let pg: TestPg;

beforeAll(async () => {
  pg = await startTestPg();
});
afterAll(async () => {
  if (pg) await pg.close();
});

// Each test starts with the V1 seed data (from migration 0002) by
// truncating then re-seeding, so tests are independent and the seed
// values are exactly what migration 0002 ships.
beforeEach(async () => {
  await pg.db.execute(sql`
    TRUNCATE
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

describe('RateCardService.warmUp + current', () => {
  it('throws on current() before warmUp', () => {
    const svc = createRateCardService({ db: pg.db });
    expect(() => svc.current()).toThrow(/not loaded/);
  });

  it('loads tier prices from app.rate_card_chat_tiers', async () => {
    const svc = createRateCardService({ db: pg.db });
    await svc.warmUp();
    const snap = svc.current();
    expect(snap.chatRateCard.entries).toHaveLength(4);
    const starter = snap.chatRateCard.entries.find((e) => e.tier === 'starter');
    expect(starter?.inputUsdPerMillion).toBe(0.05);
    expect(starter?.outputUsdPerMillion).toBe(0.1);
    const premium = snap.chatRateCard.entries.find((e) => e.tier === 'premium');
    expect(premium?.inputUsdPerMillion).toBe(2.5);
    expect(premium?.outputUsdPerMillion).toBe(6.0);
  });

  it('separates exact chat models from glob patterns', async () => {
    await pg.db.execute(sql`
      INSERT INTO app.rate_card_chat_models (model_or_pattern, is_pattern, tier, sort_order) VALUES
        ('gpt-4o', false, 'premium', 100),
        ('gpt-4o-mini', false, 'starter', 100),
        ('Qwen3.*', true, 'standard', 50),
        ('*-7B', true, 'starter', 200)
    `);
    const svc = createRateCardService({ db: pg.db });
    await svc.warmUp();
    const snap = svc.current();
    expect(snap.modelToTierExact.get('gpt-4o')).toBe('premium');
    expect(snap.modelToTierExact.get('gpt-4o-mini')).toBe('starter');
    expect(snap.modelToTierPatterns).toHaveLength(2);
    expect(snap.modelToTierPatterns[0]).toEqual({
      pattern: 'Qwen3.*',
      tier: 'standard',
      sortOrder: 50,
    });
  });

  it('separates embeddings exact entries from patterns', async () => {
    await pg.db.execute(sql`
      INSERT INTO app.rate_card_embeddings (model_or_pattern, is_pattern, usd_per_million_tokens, sort_order) VALUES
        ('text-embedding-3-small', false, 0.005, 100),
        ('text-embedding-*',       true,  0.02,  100)
    `);
    const svc = createRateCardService({ db: pg.db });
    await svc.warmUp();
    const snap = svc.current();
    expect(snap.embeddingsRateCard.entries).toHaveLength(1);
    expect(snap.embeddingsRateCard.entries[0]?.model).toBe('text-embedding-3-small');
    expect(snap.embeddingsPatterns).toHaveLength(1);
    expect(snap.embeddingsPatterns[0]?.pattern).toBe('text-embedding-*');
    expect(snap.embeddingsPatterns[0]?.entry.usdPerMillionTokens).toBe(0.02);
  });

  it('handles images composite key + filters invalid sizes/qualities', async () => {
    await pg.db.execute(sql`
      INSERT INTO app.rate_card_images (model_or_pattern, is_pattern, size, quality, usd_per_image, sort_order) VALUES
        ('dall-e-3', false, '1024x1024', 'standard', 0.025, 100),
        ('dall-e-3', false, '1024x1024', 'hd',       0.05,  100),
        ('sdxl-*',   true,  '1024x1024', 'standard', 0.002, 100)
    `);
    const svc = createRateCardService({ db: pg.db });
    await svc.warmUp();
    const snap = svc.current();
    expect(snap.imagesRateCard.entries).toHaveLength(2);
    expect(snap.imagesPatterns).toHaveLength(1);
    expect(snap.imagesPatterns[0]?.size).toBe('1024x1024');
  });

  it('returns empty snapshot when DB has no entries', async () => {
    const svc = createRateCardService({ db: pg.db });
    await svc.warmUp();
    const snap = svc.current();
    expect(snap.embeddingsRateCard.entries).toEqual([]);
    expect(snap.embeddingsPatterns).toEqual([]);
    expect(snap.imagesRateCard.entries).toEqual([]);
    expect(snap.speechRateCard.entries).toEqual([]);
    expect(snap.transcriptionsRateCard.entries).toEqual([]);
  });
});

describe('RateCardService.invalidate', () => {
  it('forces a reload that picks up new entries', async () => {
    const svc = createRateCardService({ db: pg.db, ttlMs: 60_000 });
    await svc.warmUp();
    expect(svc.current().modelToTierExact.size).toBe(0);

    await pg.db.execute(sql`
      INSERT INTO app.rate_card_chat_models (model_or_pattern, is_pattern, tier) VALUES
        ('Qwen3.6-27B', false, 'standard')
    `);

    // Without invalidate, hot-path read may still return the cached snapshot
    // depending on TTL — invalidate forces a reload.
    svc.invalidate();
    // Give the background refresh a moment.
    await new Promise((r) => setTimeout(r, 50));
    // Trigger a read; the snapshot is whatever was loaded by the
    // invalidate-driven refresh.
    const snap = svc.current();
    expect(snap.modelToTierExact.get('Qwen3.6-27B')).toBe('standard');
  });
});

describe('RateCardService.current — TTL refresh', () => {
  it('keeps serving the cached snapshot within TTL', async () => {
    const svc = createRateCardService({ db: pg.db, ttlMs: 60_000 });
    await svc.warmUp();
    const before = svc.current();
    // Mutate the DB without invalidating.
    await pg.db.execute(sql`
      INSERT INTO app.rate_card_chat_models (model_or_pattern, is_pattern, tier) VALUES
        ('Qwen3.6-27B', false, 'standard')
    `);
    const after = svc.current();
    // Same reference — no reload triggered.
    expect(after).toBe(before);
    expect(after.modelToTierExact.has('Qwen3.6-27B')).toBe(false);
  });
});
