// DB-backed RateCardResolver. Reads the operator-managed rate card from
// app.rate_card_* tables (per exec-plan 0030 schema), materializes a
// RateCardSnapshot the engine consumes, and refreshes on a TTL or
// explicit invalidate(). Caller (admin routes) calls invalidate() after
// every DB write so changes appear immediately on this instance.
//
// Schema design lives in migrations/0001_rate_card.sql. All five
// capabilities use the same shape: model_or_pattern + is_pattern
// discriminator + sort_order for pattern resolution. Chat additionally
// has a tier-prices table.

import { asc, eq } from 'drizzle-orm';
import type { Db } from '../../repo/db.js';
import {
  rateCardChatModels,
  rateCardChatTiers,
  rateCardEmbeddings,
  rateCardImages,
  rateCardSpeech,
  rateCardTranscriptions,
  retailPriceAliases,
  retailPriceCatalog,
} from '../../repo/schema.js';
import type {
  ChatModelTierPattern,
  EmbeddingsRatePattern,
  ImagesRatePattern,
  RateCardResolver,
  RateCardSnapshot,
  SpeechRatePattern,
  TranscriptionsRatePattern,
} from '@cloudspe/livepeer-openai-gateway-core/interfaces/rateCardResolver.js';
import type {
  ChatRateCardEntry,
  EmbeddingsRateCardEntry,
  ImageQuality,
  ImageSize,
  ImagesRateCardEntry,
  PricingTier,
  SpeechRateCardEntry,
  TranscriptionsRateCardEntry,
} from '@cloudspe/livepeer-openai-gateway-core/types/pricing.js';

export interface RateCardServiceDeps {
  db: Db;
  /** Cache TTL in ms. After this, the next current() call may trigger a
   * background refresh. Default 60s. Set to 0 to disable TTL refresh
   * (cache-bust-on-write only). */
  ttlMs?: number;
}

export interface RateCardService extends RateCardResolver {
  /** Force a full reload from DB on the next current() call. Called by
   * admin write routes after any insert/update/delete. */
  invalidate(): void;
  /** Eagerly load the snapshot (e.g. at process startup so the first
   * request doesn't pay the load latency). */
  warmUp(): Promise<void>;
}

const DEFAULT_TTL_MS = 60_000;
const TIER_VALUES: ReadonlyArray<PricingTier> = ['starter', 'standard', 'pro', 'premium'];
const CUSTOMER_TIER_PREPAID = 'prepaid';
const QUALITY_VALUES: ReadonlyArray<ImageQuality> = ['standard', 'hd'];
const SIZE_VALUES: ReadonlyArray<ImageSize> = ['1024x1024', '1024x1792', '1792x1024'];
const CHAT_PRICE_KINDS = ['input', 'output'] as const;

export function createRateCardService(deps: RateCardServiceDeps): RateCardService {
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
  let snapshot: RateCardSnapshot | null = null;
  let loadedAt = 0;
  let inflight: Promise<RateCardSnapshot> | null = null;

  async function loadFromDb(): Promise<RateCardSnapshot> {
    const retailRows = await deps.db
      .select()
      .from(retailPriceCatalog)
      .where(eq(retailPriceCatalog.customerTier, CUSTOMER_TIER_PREPAID))
      .orderBy(
        asc(retailPriceCatalog.capability),
        asc(retailPriceCatalog.offering),
        asc(retailPriceCatalog.priceKind),
      );
    if (retailRows.length > 0) {
      const aliasRows = await deps.db
        .select()
        .from(retailPriceAliases)
        .orderBy(
          asc(retailPriceAliases.capability),
          asc(retailPriceAliases.isPattern),
          asc(retailPriceAliases.sortOrder),
          asc(retailPriceAliases.modelOrPattern),
        );
      return retailRowsToSnapshot(retailRows, aliasRows);
    }

    const [tiers, chatModels, embeddings, images, speech, transcriptions] = await Promise.all([
      deps.db.select().from(rateCardChatTiers).orderBy(asc(rateCardChatTiers.tier)),
      deps.db
        .select()
        .from(rateCardChatModels)
        .orderBy(asc(rateCardChatModels.sortOrder), asc(rateCardChatModels.modelOrPattern)),
      deps.db
        .select()
        .from(rateCardEmbeddings)
        .orderBy(asc(rateCardEmbeddings.sortOrder), asc(rateCardEmbeddings.modelOrPattern)),
      deps.db
        .select()
        .from(rateCardImages)
        .orderBy(asc(rateCardImages.sortOrder), asc(rateCardImages.modelOrPattern)),
      deps.db
        .select()
        .from(rateCardSpeech)
        .orderBy(asc(rateCardSpeech.sortOrder), asc(rateCardSpeech.modelOrPattern)),
      deps.db
        .select()
        .from(rateCardTranscriptions)
        .orderBy(asc(rateCardTranscriptions.sortOrder), asc(rateCardTranscriptions.modelOrPattern)),
    ]);

    return {
      chatRateCard: {
        version: 'operator-managed',
        effectiveAt: new Date(),
        entries: TIER_VALUES.map((tier): ChatRateCardEntry => {
          const row = tiers.find((t) => t.tier === tier);
          if (!row) {
            // Shouldn't happen post-seed, but be defensive — engine
            // requires exactly 4 entries.
            return { tier, inputUsdPerMillion: 0, outputUsdPerMillion: 0 };
          }
          return {
            tier,
            inputUsdPerMillion: Number(row.inputUsdPerMillion),
            outputUsdPerMillion: Number(row.outputUsdPerMillion),
          };
        }),
      },
      embeddingsRateCard: {
        version: 'operator-managed',
        effectiveAt: new Date(),
        entries: embeddings
          .filter((r) => !r.isPattern)
          .map(
            (r): EmbeddingsRateCardEntry => ({
              model: r.modelOrPattern,
              usdPerMillionTokens: Number(r.usdPerMillionTokens),
            }),
          ),
      },
      imagesRateCard: {
        version: 'operator-managed',
        effectiveAt: new Date(),
        entries: images
          .filter((r) => !r.isPattern && isValidSize(r.size) && isValidQuality(r.quality))
          .map(
            (r): ImagesRateCardEntry => ({
              model: r.modelOrPattern,
              size: r.size as ImageSize,
              quality: r.quality as ImageQuality,
              usdPerImage: Number(r.usdPerImage),
            }),
          ),
      },
      speechRateCard: {
        version: 'operator-managed',
        effectiveAt: new Date(),
        entries: speech
          .filter((r) => !r.isPattern)
          .map(
            (r): SpeechRateCardEntry => ({
              model: r.modelOrPattern,
              usdPerMillionChars: Number(r.usdPerMillionChars),
            }),
          ),
      },
      transcriptionsRateCard: {
        version: 'operator-managed',
        effectiveAt: new Date(),
        entries: transcriptions
          .filter((r) => !r.isPattern)
          .map(
            (r): TranscriptionsRateCardEntry => ({
              model: r.modelOrPattern,
              usdPerMinute: Number(r.usdPerMinute),
            }),
          ),
      },
      modelToTierExact: new Map(
        chatModels
          .filter((r) => !r.isPattern && TIER_VALUES.includes(r.tier as PricingTier))
          .map((r) => [r.modelOrPattern, r.tier as PricingTier] as const),
      ),
      modelToTierPatterns: chatModels
        .filter((r) => r.isPattern && TIER_VALUES.includes(r.tier as PricingTier))
        .map(
          (r): ChatModelTierPattern => ({
            pattern: r.modelOrPattern,
            tier: r.tier as PricingTier,
            sortOrder: r.sortOrder,
          }),
        ),
      embeddingsPatterns: embeddings
        .filter((r) => r.isPattern)
        .map(
          (r): EmbeddingsRatePattern => ({
            pattern: r.modelOrPattern,
            entry: {
              model: r.modelOrPattern,
              usdPerMillionTokens: Number(r.usdPerMillionTokens),
            },
            sortOrder: r.sortOrder,
          }),
        ),
      imagesPatterns: images
        .filter((r) => r.isPattern && isValidSize(r.size) && isValidQuality(r.quality))
        .map(
          (r): ImagesRatePattern => ({
            pattern: r.modelOrPattern,
            size: r.size as ImageSize,
            quality: r.quality as ImageQuality,
            entry: {
              model: r.modelOrPattern,
              size: r.size as ImageSize,
              quality: r.quality as ImageQuality,
              usdPerImage: Number(r.usdPerImage),
            },
            sortOrder: r.sortOrder,
          }),
        ),
      speechPatterns: speech
        .filter((r) => r.isPattern)
        .map(
          (r): SpeechRatePattern => ({
            pattern: r.modelOrPattern,
            entry: {
              model: r.modelOrPattern,
              usdPerMillionChars: Number(r.usdPerMillionChars),
            },
            sortOrder: r.sortOrder,
          }),
        ),
      transcriptionsPatterns: transcriptions
        .filter((r) => r.isPattern)
        .map(
          (r): TranscriptionsRatePattern => ({
            pattern: r.modelOrPattern,
            entry: {
              model: r.modelOrPattern,
              usdPerMinute: Number(r.usdPerMinute),
            },
            sortOrder: r.sortOrder,
          }),
        ),
    };
  }

  async function refresh(): Promise<RateCardSnapshot> {
    if (inflight) return inflight;
    inflight = loadFromDb();
    try {
      snapshot = await inflight;
      loadedAt = Date.now();
      return snapshot;
    } finally {
      inflight = null;
    }
  }

  return {
    current(): RateCardSnapshot {
      // Hot path: synchronous read of the cached snapshot. If the cache
      // is empty (process just started without warmUp), kick off a
      // background load and throw — the request fails fast, the next
      // one (post-load) succeeds. Operators should call warmUp() at boot.
      if (!snapshot) {
        void refresh();
        throw new Error(
          'rate card not loaded — call warmUp() at process startup before serving requests',
        );
      }
      // Background TTL refresh (fire-and-forget, no await on hot path).
      if (ttlMs > 0 && Date.now() - loadedAt > ttlMs && !inflight) {
        void refresh();
      }
      return snapshot;
    },

    invalidate(): void {
      loadedAt = 0; // forces a reload on next current() through TTL check
      void refresh(); // also kick off an immediate background load
    },

    async warmUp(): Promise<void> {
      await refresh();
    },
  };
}

function retailRowsToSnapshot(
  priceRows: Array<typeof retailPriceCatalog.$inferSelect>,
  aliasRows: Array<typeof retailPriceAliases.$inferSelect>,
): RateCardSnapshot {
  const effectiveAt = new Date();
  const chatPrepaid = priceRows.filter((r) => r.capability === 'chat');
  const chatPriceByOffering = new Map<
    string,
    Partial<Record<(typeof CHAT_PRICE_KINDS)[number], number>>
  >();
  for (const row of chatPrepaid) {
    if (!CHAT_PRICE_KINDS.includes(row.priceKind as (typeof CHAT_PRICE_KINDS)[number])) continue;
    const current = chatPriceByOffering.get(row.offering) ?? {};
    current[row.priceKind as (typeof CHAT_PRICE_KINDS)[number]] = unitToPerMillion(
      Number(row.usdPerUnit),
    );
    chatPriceByOffering.set(row.offering, current);
  }

  const chatPairs = Array.from(chatPriceByOffering.entries()).map(([offering, pair]) => {
    return {
      offering,
      input: pair.input ?? 0,
      output: pair.output ?? 0,
    };
  });
  const distinctPairs = Array.from(
    new Map(chatPairs.map((p) => [`${p.input}:${p.output}`, { input: p.input, output: p.output }])).values(),
  ).sort((a, b) => a.input + a.output - (b.input + b.output));
  if (distinctPairs.length > TIER_VALUES.length) {
    throw new Error(
      `retail chat pricing defines ${distinctPairs.length} distinct prepaid price pairs, but the current engine adapter supports at most ${TIER_VALUES.length}`,
    );
  }
  const pairToTier = new Map(
    distinctPairs.map((pair, index) => [`${pair.input}:${pair.output}`, TIER_VALUES[index] as PricingTier]),
  );

  const chatEntries: ChatRateCardEntry[] = TIER_VALUES.map((tier, index) => {
    const pair = distinctPairs[index];
    return {
      tier,
      inputUsdPerMillion: pair?.input ?? 0,
      outputUsdPerMillion: pair?.output ?? 0,
    };
  });

  const chatAliases = aliasRows.filter((r) => r.capability === 'chat');
  const modelToTierExact = new Map<string, PricingTier>();
  const modelToTierPatterns: ChatModelTierPattern[] = [];
  for (const row of chatAliases) {
    const pair = chatPriceByOffering.get(row.offering);
    if (!pair) continue;
    const tier = pairToTier.get(`${pair.input ?? 0}:${pair.output ?? 0}`);
    if (!tier) continue;
    if (row.isPattern) {
      modelToTierPatterns.push({
        pattern: row.modelOrPattern,
        tier,
        sortOrder: row.sortOrder,
      });
      continue;
    }
    modelToTierExact.set(row.modelOrPattern, tier);
  }

  return {
    chatRateCard: {
      version: 'operator-managed',
      effectiveAt,
      entries: chatEntries,
    },
    embeddingsRateCard: {
      version: 'operator-managed',
      effectiveAt,
      entries: capabilityExactEntries(priceRows, aliasRows, 'embeddings').map((entry) => ({
        model: entry.model,
        usdPerMillionTokens: unitToPerMillion(entry.usdPerUnit),
      })),
    },
    imagesRateCard: {
      version: 'operator-managed',
      effectiveAt,
      entries: capabilityExactEntries(priceRows, aliasRows, 'images')
        .filter((entry) => isValidSize(entry.size) && isValidQuality(entry.quality))
        .map((entry) => ({
          model: entry.model,
          size: entry.size as ImageSize,
          quality: entry.quality as ImageQuality,
          usdPerImage: entry.usdPerUnit,
        })),
    },
    speechRateCard: {
      version: 'operator-managed',
      effectiveAt,
      entries: capabilityExactEntries(priceRows, aliasRows, 'speech').map((entry) => ({
        model: entry.model,
        usdPerMillionChars: unitToPerMillion(entry.usdPerUnit),
      })),
    },
    transcriptionsRateCard: {
      version: 'operator-managed',
      effectiveAt,
      entries: capabilityExactEntries(priceRows, aliasRows, 'transcriptions').map((entry) => ({
        model: entry.model,
        usdPerMinute: entry.usdPerUnit,
      })),
    },
    modelToTierExact,
    modelToTierPatterns,
    embeddingsPatterns: capabilityPatternEntries(priceRows, aliasRows, 'embeddings').map((entry) => ({
      pattern: entry.pattern,
      entry: {
        model: entry.pattern,
        usdPerMillionTokens: unitToPerMillion(entry.usdPerUnit),
      },
      sortOrder: entry.sortOrder,
    })),
    imagesPatterns: capabilityPatternEntries(priceRows, aliasRows, 'images')
      .filter((entry) => isValidSize(entry.size) && isValidQuality(entry.quality))
      .map((entry) => ({
        pattern: entry.pattern,
        size: entry.size as ImageSize,
        quality: entry.quality as ImageQuality,
        entry: {
          model: entry.pattern,
          size: entry.size as ImageSize,
          quality: entry.quality as ImageQuality,
          usdPerImage: entry.usdPerUnit,
        },
        sortOrder: entry.sortOrder,
      })),
    speechPatterns: capabilityPatternEntries(priceRows, aliasRows, 'speech').map((entry) => ({
      pattern: entry.pattern,
      entry: {
        model: entry.pattern,
        usdPerMillionChars: unitToPerMillion(entry.usdPerUnit),
      },
      sortOrder: entry.sortOrder,
    })),
    transcriptionsPatterns: capabilityPatternEntries(
      priceRows,
      aliasRows,
      'transcriptions',
    ).map((entry) => ({
      pattern: entry.pattern,
      entry: {
        model: entry.pattern,
        usdPerMinute: entry.usdPerUnit,
      },
      sortOrder: entry.sortOrder,
    })),
  };
}

function capabilityExactEntries(
  priceRows: Array<typeof retailPriceCatalog.$inferSelect>,
  aliasRows: Array<typeof retailPriceAliases.$inferSelect>,
  capability: 'embeddings' | 'images' | 'speech' | 'transcriptions',
): Array<{ model: string; usdPerUnit: number; size: string; quality: string }> {
  const priceByOffering = new Map(
    priceRows
      .filter((r) => r.capability === capability && r.priceKind === 'default')
      .map((r) => [r.offering, Number(r.usdPerUnit)] as const),
  );
  return aliasRows
    .filter((r) => r.capability === capability && !r.isPattern)
    .flatMap((r) => {
      const usdPerUnit = priceByOffering.get(r.offering);
      if (usdPerUnit === undefined) return [];
      return [{ model: r.modelOrPattern, usdPerUnit, size: r.size, quality: r.quality }];
    });
}

function capabilityPatternEntries(
  priceRows: Array<typeof retailPriceCatalog.$inferSelect>,
  aliasRows: Array<typeof retailPriceAliases.$inferSelect>,
  capability: 'embeddings' | 'images' | 'speech' | 'transcriptions',
): Array<{ pattern: string; usdPerUnit: number; size: string; quality: string; sortOrder: number }> {
  const priceByOffering = new Map(
    priceRows
      .filter((r) => r.capability === capability && r.priceKind === 'default')
      .map((r) => [r.offering, Number(r.usdPerUnit)] as const),
  );
  return aliasRows
    .filter((r) => r.capability === capability && r.isPattern)
    .flatMap((r) => {
      const usdPerUnit = priceByOffering.get(r.offering);
      if (usdPerUnit === undefined) return [];
      return [
        {
          pattern: r.modelOrPattern,
          usdPerUnit,
          size: r.size,
          quality: r.quality,
          sortOrder: r.sortOrder,
        },
      ];
    });
}

function unitToPerMillion(v: number): number {
  return v * 1_000_000;
}

function isValidSize(s: string): s is ImageSize {
  return SIZE_VALUES.includes(s as ImageSize);
}

function isValidQuality(s: string): s is ImageQuality {
  return QUALITY_VALUES.includes(s as ImageQuality);
}
