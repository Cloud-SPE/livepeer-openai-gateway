// Admin CRUD for the operator-managed rate card (per 0030).
//
// 5 capability surfaces × {GET list, POST upsert, DELETE} = 16 routes.
// Chat additionally has /admin/pricing/chat/tiers for the per-tier
// price edits. All routes gated by adminAuthPreHandler; audit logging
// is automatic via the middleware. After every successful write the
// handler calls rateCardService.invalidate() so subsequent reads on
// this instance see the change immediately (TTL takes care of other
// replicas).

import { z } from 'zod';
import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../../../repo/db.js';
import {
  rateCardChatModels,
  rateCardChatTiers,
  rateCardEmbeddings,
  rateCardImages,
  rateCardSpeech,
  rateCardTranscriptions,
  retailPriceAliases,
  retailPriceCatalog,
} from '../../../repo/schema.js';
import type { AdminAuthDeps } from '../middleware/adminAuth.js';
import { adminAuthPreHandler } from '../middleware/adminAuth.js';
import type { RateCardService } from '../../../service/pricing/rateCard.js';

export interface AdminPricingDeps extends AdminAuthDeps {
  rateCardService: RateCardService;
}

// ── Zod schemas ─────────────────────────────────────────────────────────────

const TierSchema = z.enum(['starter', 'standard', 'pro', 'premium']);
const CapabilitySchema = z.enum(['chat', 'embeddings', 'images', 'speech', 'transcriptions']);
const CustomerTierSchema = z.enum(['free', 'prepaid']);
const RetailPriceKindSchema = z.enum(['default', 'input', 'output']);
const ImageSizeSchema = z.enum(['1024x1024', '1024x1792', '1792x1024']);
const ImageQualitySchema = z.enum(['standard', 'hd']);
const NonNegNumberStr = z.union([z.number().nonnegative(), z.string().regex(/^\d+(\.\d+)?$/)]);

const TierPriceUpdateSchema = z.object({
  input_usd_per_million: NonNegNumberStr,
  output_usd_per_million: NonNegNumberStr,
});

const ChatModelUpsertSchema = z.object({
  model_or_pattern: z.string().min(1).max(256),
  is_pattern: z.boolean(),
  tier: TierSchema,
  sort_order: z.number().int().min(0).max(10000).default(100).optional(),
});

const EmbeddingsUpsertSchema = z.object({
  model_or_pattern: z.string().min(1).max(256),
  is_pattern: z.boolean(),
  usd_per_million_tokens: NonNegNumberStr,
  sort_order: z.number().int().min(0).max(10000).default(100).optional(),
});

const ImagesUpsertSchema = z.object({
  model_or_pattern: z.string().min(1).max(256),
  is_pattern: z.boolean(),
  size: ImageSizeSchema,
  quality: ImageQualitySchema,
  usd_per_image: NonNegNumberStr,
  sort_order: z.number().int().min(0).max(10000).default(100).optional(),
});

const SpeechUpsertSchema = z.object({
  model_or_pattern: z.string().min(1).max(256),
  is_pattern: z.boolean(),
  usd_per_million_chars: NonNegNumberStr,
  sort_order: z.number().int().min(0).max(10000).default(100).optional(),
});

const TranscriptionsUpsertSchema = z.object({
  model_or_pattern: z.string().min(1).max(256),
  is_pattern: z.boolean(),
  usd_per_minute: NonNegNumberStr,
  sort_order: z.number().int().min(0).max(10000).default(100).optional(),
});

const RetailPriceUpsertSchema = z
  .object({
    capability: CapabilitySchema,
    offering: z.string().min(1).max(256),
    customer_tier: CustomerTierSchema,
    price_kind: RetailPriceKindSchema.default('default').optional(),
    unit: z.string().min(1).max(64),
    usd_per_unit: NonNegNumberStr,
  })
  .superRefine((value, ctx) => {
    if (value.capability === 'chat' && value.price_kind === 'default') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'chat retail prices must use price_kind input or output',
        path: ['price_kind'],
      });
    }
    if (value.capability !== 'chat' && value.price_kind && value.price_kind !== 'default') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'non-chat retail prices must use price_kind default',
        path: ['price_kind'],
      });
    }
  });

const RetailAliasUpsertSchema = z
  .object({
    capability: CapabilitySchema,
    model_or_pattern: z.string().min(1).max(256),
    is_pattern: z.boolean(),
    offering: z.string().min(1).max(256),
    size: z.string().max(32).optional(),
    quality: z.string().max(32).optional(),
    sort_order: z.number().int().min(0).max(10000).default(100).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.capability === 'images') {
      if (!value.size || !ImageSizeSchema.safeParse(value.size).success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'images aliases require a valid size',
          path: ['size'],
        });
      }
      if (!value.quality || !ImageQualitySchema.safeParse(value.quality).success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'images aliases require a valid quality',
          path: ['quality'],
        });
      }
      return;
    }
    if (value.size && value.size !== '') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'size is only valid for images aliases',
        path: ['size'],
      });
    }
    if (value.quality && value.quality !== '') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'quality is only valid for images aliases',
        path: ['quality'],
      });
    }
  });

// ── Helpers ─────────────────────────────────────────────────────────────────

function badRequest(err: z.ZodError): { error: { code: string; type: string; message: string } } {
  return {
    error: {
      code: 'invalid_request',
      type: 'InvalidRequestError',
      message: err.issues.map((i) => i.message).join('; '),
    },
  };
}

function isUniqueViolation(err: unknown): boolean {
  return Boolean(
    err && typeof err === 'object' && 'code' in err && (err as { code?: unknown }).code === '23505',
  );
}

async function asNumber(v: unknown): Promise<string> {
  return typeof v === 'number' ? String(v) : String(v);
}

// ── Route registration ──────────────────────────────────────────────────────

export function registerAdminPricingRoutes(app: FastifyInstance, deps: AdminPricingDeps): void {
  const preHandler = adminAuthPreHandler(deps);
  const db: Db = deps.db;

  // ─── Shell-native retail pricing (v3 prep) ───────────────────────────────

  app.get('/admin/pricing/retail/prices/:capability', { preHandler }, async (req, reply) => {
    const capabilityParsed = CapabilitySchema.safeParse(
      (req.params as { capability?: string }).capability,
    );
    if (!capabilityParsed.success) {
      await reply.code(400).send(badRequest(capabilityParsed.error));
      return;
    }
    const rows = await db
      .select()
      .from(retailPriceCatalog)
      .where(eq(retailPriceCatalog.capability, capabilityParsed.data))
      .orderBy(
        asc(retailPriceCatalog.customerTier),
        asc(retailPriceCatalog.offering),
        asc(retailPriceCatalog.priceKind),
      );
    return { entries: rows.map(serializeRetailPrice) };
  });

  app.post('/admin/pricing/retail/prices', { preHandler }, async (req, reply) => {
    const parsed = RetailPriceUpsertSchema.safeParse(req.body);
    if (!parsed.success) {
      await reply.code(400).send(badRequest(parsed.error));
      return;
    }
    try {
      const [row] = await db
        .insert(retailPriceCatalog)
        .values({
          capability: parsed.data.capability,
          offering: parsed.data.offering,
          customerTier: parsed.data.customer_tier,
          priceKind: parsed.data.price_kind ?? 'default',
          unit: parsed.data.unit,
          usdPerUnit: await asNumber(parsed.data.usd_per_unit),
        })
        .returning();
      if (!row) throw new Error('insert returned no row');
      deps.rateCardService.invalidate();
      await reply.code(201).send(serializeRetailPrice(row));
    } catch (err) {
      if (isUniqueViolation(err)) {
        await reply.code(409).send({
          error: { code: 'duplicate', type: 'DuplicateEntry', message: 'duplicate retail price' },
        });
        return;
      }
      throw err;
    }
  });

  app.delete<{ Params: { id: string } }>(
    '/admin/pricing/retail/prices/:id',
    { preHandler },
    async (req, reply) => {
      const result = await db
        .delete(retailPriceCatalog)
        .where(eq(retailPriceCatalog.id, req.params.id))
        .returning();
      if (result.length === 0) {
        await reply.code(404).send({
          error: { code: 'not_found', type: 'NotFound', message: req.params.id },
        });
        return;
      }
      deps.rateCardService.invalidate();
      await reply.code(204).send();
    },
  );

  app.get('/admin/pricing/retail/aliases/:capability', { preHandler }, async (req, reply) => {
    const capabilityParsed = CapabilitySchema.safeParse(
      (req.params as { capability?: string }).capability,
    );
    if (!capabilityParsed.success) {
      await reply.code(400).send(badRequest(capabilityParsed.error));
      return;
    }
    const rows = await db
      .select()
      .from(retailPriceAliases)
      .where(eq(retailPriceAliases.capability, capabilityParsed.data))
      .orderBy(
        asc(retailPriceAliases.isPattern),
        asc(retailPriceAliases.sortOrder),
        asc(retailPriceAliases.modelOrPattern),
      );
    return { entries: rows.map(serializeRetailAlias) };
  });

  app.post('/admin/pricing/retail/aliases', { preHandler }, async (req, reply) => {
    const parsed = RetailAliasUpsertSchema.safeParse(req.body);
    if (!parsed.success) {
      await reply.code(400).send(badRequest(parsed.error));
      return;
    }
    try {
      const [row] = await db
        .insert(retailPriceAliases)
        .values({
          capability: parsed.data.capability,
          modelOrPattern: parsed.data.model_or_pattern,
          isPattern: parsed.data.is_pattern,
          offering: parsed.data.offering,
          size: parsed.data.size ?? '',
          quality: parsed.data.quality ?? '',
          sortOrder: parsed.data.sort_order ?? 100,
        })
        .returning();
      if (!row) throw new Error('insert returned no row');
      deps.rateCardService.invalidate();
      await reply.code(201).send(serializeRetailAlias(row));
    } catch (err) {
      if (isUniqueViolation(err)) {
        await reply.code(409).send({
          error: { code: 'duplicate', type: 'DuplicateEntry', message: 'duplicate retail alias' },
        });
        return;
      }
      throw err;
    }
  });

  app.delete<{ Params: { id: string } }>(
    '/admin/pricing/retail/aliases/:id',
    { preHandler },
    async (req, reply) => {
      const result = await db
        .delete(retailPriceAliases)
        .where(eq(retailPriceAliases.id, req.params.id))
        .returning();
      if (result.length === 0) {
        await reply.code(404).send({
          error: { code: 'not_found', type: 'NotFound', message: req.params.id },
        });
        return;
      }
      deps.rateCardService.invalidate();
      await reply.code(204).send();
    },
  );

  // ─── Chat — tier prices ───────────────────────────────────────────────────

  app.get('/admin/pricing/chat/tiers', { preHandler }, async () => {
    const rows = await db.select().from(rateCardChatTiers).orderBy(asc(rateCardChatTiers.tier));
    return {
      tiers: rows.map((r) => ({
        tier: r.tier,
        input_usd_per_million: r.inputUsdPerMillion,
        output_usd_per_million: r.outputUsdPerMillion,
        updated_at: r.updatedAt.toISOString(),
      })),
    };
  });

  app.put<{ Params: { tier: string } }>(
    '/admin/pricing/chat/tiers/:tier',
    { preHandler },
    async (req, reply) => {
      const tierParsed = TierSchema.safeParse(req.params.tier);
      if (!tierParsed.success) {
        await reply.code(400).send(badRequest(tierParsed.error));
        return;
      }
      const bodyParsed = TierPriceUpdateSchema.safeParse(req.body);
      if (!bodyParsed.success) {
        await reply.code(400).send(badRequest(bodyParsed.error));
        return;
      }
      const result = await db
        .update(rateCardChatTiers)
        .set({
          inputUsdPerMillion: await asNumber(bodyParsed.data.input_usd_per_million),
          outputUsdPerMillion: await asNumber(bodyParsed.data.output_usd_per_million),
          updatedAt: new Date(),
        })
        .where(eq(rateCardChatTiers.tier, tierParsed.data))
        .returning();
      if (result.length === 0) {
        await reply.code(404).send({
          error: { code: 'not_found', type: 'NotFound', message: `tier ${tierParsed.data}` },
        });
        return;
      }
      deps.rateCardService.invalidate();
      const row = result[0]!;
      return {
        tier: row.tier,
        input_usd_per_million: row.inputUsdPerMillion,
        output_usd_per_million: row.outputUsdPerMillion,
        updated_at: row.updatedAt.toISOString(),
      };
    },
  );

  // ─── Chat — model rows ────────────────────────────────────────────────────

  app.get('/admin/pricing/chat/models', { preHandler }, async () => {
    const rows = await db
      .select()
      .from(rateCardChatModels)
      .orderBy(
        asc(rateCardChatModels.isPattern),
        asc(rateCardChatModels.sortOrder),
        asc(rateCardChatModels.modelOrPattern),
      );
    return { entries: rows.map(serializeChatModel) };
  });

  app.post('/admin/pricing/chat/models', { preHandler }, async (req, reply) => {
    const parsed = ChatModelUpsertSchema.safeParse(req.body);
    if (!parsed.success) {
      await reply.code(400).send(badRequest(parsed.error));
      return;
    }
    try {
      const [row] = await db
        .insert(rateCardChatModels)
        .values({
          modelOrPattern: parsed.data.model_or_pattern,
          isPattern: parsed.data.is_pattern,
          tier: parsed.data.tier,
          sortOrder: parsed.data.sort_order ?? 100,
        })
        .returning();
      if (!row) throw new Error('insert returned no row');
      deps.rateCardService.invalidate();
      await reply.code(201).send(serializeChatModel(row));
    } catch (err) {
      if (isUniqueViolation(err)) {
        await reply.code(409).send({
          error: {
            code: 'duplicate',
            type: 'DuplicateEntry',
            message: 'an entry with this model_or_pattern + is_pattern already exists',
          },
        });
        return;
      }
      throw err;
    }
  });

  app.delete<{ Params: { id: string } }>(
    '/admin/pricing/chat/models/:id',
    { preHandler },
    async (req, reply) => {
      const idParsed = z.string().uuid().safeParse(req.params.id);
      if (!idParsed.success) {
        await reply.code(400).send({
          error: { code: 'invalid_request', type: 'InvalidRequestError', message: 'invalid id' },
        });
        return;
      }
      const result = await db
        .delete(rateCardChatModels)
        .where(eq(rateCardChatModels.id, idParsed.data))
        .returning();
      if (result.length === 0) {
        await reply.code(404).send({
          error: { code: 'not_found', type: 'NotFound', message: `model entry ${idParsed.data}` },
        });
        return;
      }
      deps.rateCardService.invalidate();
      await reply.code(204).send();
    },
  );

  // ─── Embeddings ──────────────────────────────────────────────────────────

  app.get('/admin/pricing/embeddings', { preHandler }, async () => {
    const rows = await db
      .select()
      .from(rateCardEmbeddings)
      .orderBy(asc(rateCardEmbeddings.isPattern), asc(rateCardEmbeddings.sortOrder));
    return { entries: rows.map(serializeEmbeddings) };
  });

  app.post('/admin/pricing/embeddings', { preHandler }, async (req, reply) => {
    const parsed = EmbeddingsUpsertSchema.safeParse(req.body);
    if (!parsed.success) {
      await reply.code(400).send(badRequest(parsed.error));
      return;
    }
    try {
      const [row] = await db
        .insert(rateCardEmbeddings)
        .values({
          modelOrPattern: parsed.data.model_or_pattern,
          isPattern: parsed.data.is_pattern,
          usdPerMillionTokens: await asNumber(parsed.data.usd_per_million_tokens),
          sortOrder: parsed.data.sort_order ?? 100,
        })
        .returning();
      if (!row) throw new Error('insert returned no row');
      deps.rateCardService.invalidate();
      await reply.code(201).send(serializeEmbeddings(row));
    } catch (err) {
      if (isUniqueViolation(err)) {
        await reply.code(409).send({
          error: { code: 'duplicate', type: 'DuplicateEntry', message: 'duplicate' },
        });
        return;
      }
      throw err;
    }
  });

  app.delete<{ Params: { id: string } }>(
    '/admin/pricing/embeddings/:id',
    { preHandler },
    async (req, reply) => {
      const result = await db
        .delete(rateCardEmbeddings)
        .where(eq(rateCardEmbeddings.id, req.params.id))
        .returning();
      if (result.length === 0) {
        await reply.code(404).send({
          error: { code: 'not_found', type: 'NotFound', message: req.params.id },
        });
        return;
      }
      deps.rateCardService.invalidate();
      await reply.code(204).send();
    },
  );

  // ─── Images ───────────────────────────────────────────────────────────────

  app.get('/admin/pricing/images', { preHandler }, async () => {
    const rows = await db
      .select()
      .from(rateCardImages)
      .orderBy(asc(rateCardImages.isPattern), asc(rateCardImages.sortOrder));
    return { entries: rows.map(serializeImages) };
  });

  app.post('/admin/pricing/images', { preHandler }, async (req, reply) => {
    const parsed = ImagesUpsertSchema.safeParse(req.body);
    if (!parsed.success) {
      await reply.code(400).send(badRequest(parsed.error));
      return;
    }
    try {
      const [row] = await db
        .insert(rateCardImages)
        .values({
          modelOrPattern: parsed.data.model_or_pattern,
          isPattern: parsed.data.is_pattern,
          size: parsed.data.size,
          quality: parsed.data.quality,
          usdPerImage: await asNumber(parsed.data.usd_per_image),
          sortOrder: parsed.data.sort_order ?? 100,
        })
        .returning();
      if (!row) throw new Error('insert returned no row');
      deps.rateCardService.invalidate();
      await reply.code(201).send(serializeImages(row));
    } catch (err) {
      if (isUniqueViolation(err)) {
        await reply.code(409).send({
          error: { code: 'duplicate', type: 'DuplicateEntry', message: 'duplicate' },
        });
        return;
      }
      throw err;
    }
  });

  app.delete<{ Params: { id: string } }>(
    '/admin/pricing/images/:id',
    { preHandler },
    async (req, reply) => {
      const result = await db
        .delete(rateCardImages)
        .where(eq(rateCardImages.id, req.params.id))
        .returning();
      if (result.length === 0) {
        await reply.code(404).send({
          error: { code: 'not_found', type: 'NotFound', message: req.params.id },
        });
        return;
      }
      deps.rateCardService.invalidate();
      await reply.code(204).send();
    },
  );

  // ─── Speech ──────────────────────────────────────────────────────────────

  app.get('/admin/pricing/speech', { preHandler }, async () => {
    const rows = await db
      .select()
      .from(rateCardSpeech)
      .orderBy(asc(rateCardSpeech.isPattern), asc(rateCardSpeech.sortOrder));
    return { entries: rows.map(serializeSpeech) };
  });

  app.post('/admin/pricing/speech', { preHandler }, async (req, reply) => {
    const parsed = SpeechUpsertSchema.safeParse(req.body);
    if (!parsed.success) {
      await reply.code(400).send(badRequest(parsed.error));
      return;
    }
    try {
      const [row] = await db
        .insert(rateCardSpeech)
        .values({
          modelOrPattern: parsed.data.model_or_pattern,
          isPattern: parsed.data.is_pattern,
          usdPerMillionChars: await asNumber(parsed.data.usd_per_million_chars),
          sortOrder: parsed.data.sort_order ?? 100,
        })
        .returning();
      if (!row) throw new Error('insert returned no row');
      deps.rateCardService.invalidate();
      await reply.code(201).send(serializeSpeech(row));
    } catch (err) {
      if (isUniqueViolation(err)) {
        await reply.code(409).send({
          error: { code: 'duplicate', type: 'DuplicateEntry', message: 'duplicate' },
        });
        return;
      }
      throw err;
    }
  });

  app.delete<{ Params: { id: string } }>(
    '/admin/pricing/speech/:id',
    { preHandler },
    async (req, reply) => {
      const result = await db
        .delete(rateCardSpeech)
        .where(eq(rateCardSpeech.id, req.params.id))
        .returning();
      if (result.length === 0) {
        await reply.code(404).send({
          error: { code: 'not_found', type: 'NotFound', message: req.params.id },
        });
        return;
      }
      deps.rateCardService.invalidate();
      await reply.code(204).send();
    },
  );

  // ─── Transcriptions ──────────────────────────────────────────────────────

  app.get('/admin/pricing/transcriptions', { preHandler }, async () => {
    const rows = await db
      .select()
      .from(rateCardTranscriptions)
      .orderBy(asc(rateCardTranscriptions.isPattern), asc(rateCardTranscriptions.sortOrder));
    return { entries: rows.map(serializeTranscriptions) };
  });

  app.post('/admin/pricing/transcriptions', { preHandler }, async (req, reply) => {
    const parsed = TranscriptionsUpsertSchema.safeParse(req.body);
    if (!parsed.success) {
      await reply.code(400).send(badRequest(parsed.error));
      return;
    }
    try {
      const [row] = await db
        .insert(rateCardTranscriptions)
        .values({
          modelOrPattern: parsed.data.model_or_pattern,
          isPattern: parsed.data.is_pattern,
          usdPerMinute: await asNumber(parsed.data.usd_per_minute),
          sortOrder: parsed.data.sort_order ?? 100,
        })
        .returning();
      if (!row) throw new Error('insert returned no row');
      deps.rateCardService.invalidate();
      await reply.code(201).send(serializeTranscriptions(row));
    } catch (err) {
      if (isUniqueViolation(err)) {
        await reply.code(409).send({
          error: { code: 'duplicate', type: 'DuplicateEntry', message: 'duplicate' },
        });
        return;
      }
      throw err;
    }
  });

  app.delete<{ Params: { id: string } }>(
    '/admin/pricing/transcriptions/:id',
    { preHandler },
    async (req, reply) => {
      const result = await db
        .delete(rateCardTranscriptions)
        .where(eq(rateCardTranscriptions.id, req.params.id))
        .returning();
      if (result.length === 0) {
        await reply.code(404).send({
          error: { code: 'not_found', type: 'NotFound', message: req.params.id },
        });
        return;
      }
      deps.rateCardService.invalidate();
      await reply.code(204).send();
    },
  );
}

// ── Row → API serializers ───────────────────────────────────────────────────

function serializeChatModel(r: typeof rateCardChatModels.$inferSelect) {
  return {
    id: r.id,
    model_or_pattern: r.modelOrPattern,
    is_pattern: r.isPattern,
    tier: r.tier,
    sort_order: r.sortOrder,
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
  };
}

function serializeEmbeddings(r: typeof rateCardEmbeddings.$inferSelect) {
  return {
    id: r.id,
    model_or_pattern: r.modelOrPattern,
    is_pattern: r.isPattern,
    usd_per_million_tokens: r.usdPerMillionTokens,
    sort_order: r.sortOrder,
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
  };
}

function serializeImages(r: typeof rateCardImages.$inferSelect) {
  return {
    id: r.id,
    model_or_pattern: r.modelOrPattern,
    is_pattern: r.isPattern,
    size: r.size,
    quality: r.quality,
    usd_per_image: r.usdPerImage,
    sort_order: r.sortOrder,
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
  };
}

function serializeSpeech(r: typeof rateCardSpeech.$inferSelect) {
  return {
    id: r.id,
    model_or_pattern: r.modelOrPattern,
    is_pattern: r.isPattern,
    usd_per_million_chars: r.usdPerMillionChars,
    sort_order: r.sortOrder,
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
  };
}

function serializeTranscriptions(r: typeof rateCardTranscriptions.$inferSelect) {
  return {
    id: r.id,
    model_or_pattern: r.modelOrPattern,
    is_pattern: r.isPattern,
    usd_per_minute: r.usdPerMinute,
    sort_order: r.sortOrder,
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
  };
}

function serializeRetailPrice(r: typeof retailPriceCatalog.$inferSelect) {
  return {
    id: r.id,
    capability: r.capability,
    offering: r.offering,
    customer_tier: r.customerTier,
    price_kind: r.priceKind,
    unit: r.unit,
    usd_per_unit: r.usdPerUnit,
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
  };
}

function serializeRetailAlias(r: typeof retailPriceAliases.$inferSelect) {
  return {
    id: r.id,
    capability: r.capability,
    model_or_pattern: r.modelOrPattern,
    is_pattern: r.isPattern,
    offering: r.offering,
    size: r.size,
    quality: r.quality,
    sort_order: r.sortOrder,
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
  };
}
