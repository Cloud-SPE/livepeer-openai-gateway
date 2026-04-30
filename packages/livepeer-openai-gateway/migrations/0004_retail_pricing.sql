-- Shell-native v3 retail pricing. This lives alongside the legacy
-- rate-card tables while the installed engine still consumes the old
-- snapshot contract.
--
-- `retail_price_catalog` is the shell-owned source of truth:
--   (capability, offering, customer_tier[, price_kind]) -> usd_per_unit
--
-- `retail_price_aliases` is the temporary compatibility layer that maps
-- today's OpenAI request selectors (model, and for images size/quality)
-- onto an offering. The runtime adapter uses the prepaid rows to
-- synthesize the current engine's legacy rate-card snapshot until the
-- upstream quote-free pricing cut lands.

CREATE TABLE app.retail_price_catalog (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  capability        TEXT NOT NULL
    CHECK (capability IN ('chat','embeddings','images','speech','transcriptions')),
  offering          TEXT NOT NULL,
  customer_tier     TEXT NOT NULL
    CHECK (customer_tier IN ('free','prepaid')),
  price_kind        TEXT NOT NULL DEFAULT 'default'
    CHECK (price_kind IN ('default','input','output')),
  unit              TEXT NOT NULL,
  usd_per_unit      NUMERIC(20, 8) NOT NULL CHECK (usd_per_unit >= 0),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (capability, offering, customer_tier, price_kind)
);

CREATE INDEX retail_price_catalog_capability_idx
  ON app.retail_price_catalog (capability, customer_tier, price_kind, offering);

CREATE TABLE app.retail_price_aliases (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  capability        TEXT NOT NULL
    CHECK (capability IN ('chat','embeddings','images','speech','transcriptions')),
  model_or_pattern  TEXT NOT NULL,
  is_pattern        BOOL NOT NULL,
  offering          TEXT NOT NULL,
  size              TEXT NOT NULL DEFAULT '',
  quality           TEXT NOT NULL DEFAULT '',
  sort_order        INT NOT NULL DEFAULT 100,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (capability, model_or_pattern, is_pattern, size, quality)
);

CREATE INDEX retail_price_aliases_lookup_idx
  ON app.retail_price_aliases (capability, is_pattern, sort_order, model_or_pattern);

-- Seed the new shell-native tables from the legacy rate-card rows so a
-- fresh deploy starts with a coherent admin experience. Until the
-- upstream runtime cut lands, the adapter only consumes the `prepaid`
-- view. The `free` rows are seeded identically for operator editing and
-- future use.

INSERT INTO app.retail_price_catalog (capability, offering, customer_tier, price_kind, unit, usd_per_unit)
SELECT
  'chat',
  m.model_or_pattern,
  tier_name.customer_tier,
  'input',
  'token',
  t.input_usd_per_million / 1000000.0
FROM app.rate_card_chat_models m
JOIN app.rate_card_chat_tiers t
  ON t.tier = m.tier
CROSS JOIN (VALUES ('free'), ('prepaid')) AS tier_name(customer_tier)
WHERE m.is_pattern = false;

INSERT INTO app.retail_price_catalog (capability, offering, customer_tier, price_kind, unit, usd_per_unit)
SELECT
  'chat',
  m.model_or_pattern,
  tier_name.customer_tier,
  'output',
  'token',
  t.output_usd_per_million / 1000000.0
FROM app.rate_card_chat_models m
JOIN app.rate_card_chat_tiers t
  ON t.tier = m.tier
CROSS JOIN (VALUES ('free'), ('prepaid')) AS tier_name(customer_tier)
WHERE m.is_pattern = false;

INSERT INTO app.retail_price_aliases (capability, model_or_pattern, is_pattern, offering, sort_order)
SELECT
  'chat',
  model_or_pattern,
  is_pattern,
  model_or_pattern,
  sort_order
FROM app.rate_card_chat_models;

INSERT INTO app.retail_price_catalog (capability, offering, customer_tier, unit, usd_per_unit)
SELECT
  'embeddings',
  model_or_pattern,
  tier_name.customer_tier,
  'token',
  usd_per_million_tokens / 1000000.0
FROM app.rate_card_embeddings
CROSS JOIN (VALUES ('free'), ('prepaid')) AS tier_name(customer_tier)
WHERE is_pattern = false;

INSERT INTO app.retail_price_aliases (capability, model_or_pattern, is_pattern, offering, sort_order)
SELECT
  'embeddings',
  model_or_pattern,
  is_pattern,
  model_or_pattern,
  sort_order
FROM app.rate_card_embeddings;

INSERT INTO app.retail_price_catalog (capability, offering, customer_tier, unit, usd_per_unit)
SELECT
  'images',
  model_or_pattern || '|' || size || '|' || quality,
  tier_name.customer_tier,
  'image',
  usd_per_image
FROM app.rate_card_images
CROSS JOIN (VALUES ('free'), ('prepaid')) AS tier_name(customer_tier)
WHERE is_pattern = false;

INSERT INTO app.retail_price_aliases (capability, model_or_pattern, is_pattern, offering, size, quality, sort_order)
SELECT
  'images',
  model_or_pattern,
  is_pattern,
  model_or_pattern || '|' || size || '|' || quality,
  size,
  quality,
  sort_order
FROM app.rate_card_images;

INSERT INTO app.retail_price_catalog (capability, offering, customer_tier, unit, usd_per_unit)
SELECT
  'speech',
  model_or_pattern,
  tier_name.customer_tier,
  'character',
  usd_per_million_chars / 1000000.0
FROM app.rate_card_speech
CROSS JOIN (VALUES ('free'), ('prepaid')) AS tier_name(customer_tier)
WHERE is_pattern = false;

INSERT INTO app.retail_price_aliases (capability, model_or_pattern, is_pattern, offering, sort_order)
SELECT
  'speech',
  model_or_pattern,
  is_pattern,
  model_or_pattern,
  sort_order
FROM app.rate_card_speech;

INSERT INTO app.retail_price_catalog (capability, offering, customer_tier, unit, usd_per_unit)
SELECT
  'transcriptions',
  model_or_pattern,
  tier_name.customer_tier,
  'minute',
  usd_per_minute
FROM app.rate_card_transcriptions
CROSS JOIN (VALUES ('free'), ('prepaid')) AS tier_name(customer_tier)
WHERE is_pattern = false;

INSERT INTO app.retail_price_aliases (capability, model_or_pattern, is_pattern, offering, sort_order)
SELECT
  'transcriptions',
  model_or_pattern,
  is_pattern,
  model_or_pattern,
  sort_order
FROM app.rate_card_transcriptions;
