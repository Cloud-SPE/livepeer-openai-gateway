-- Operator-managed rate card. Per exec-plan 0030.
--
-- Six tables:
--   - rate_card_chat_tiers: tier prices for chat (the only tiered capability)
--   - rate_card_chat_models: model→tier (exact OR glob pattern)
--   - rate_card_embeddings: model→USD/M tokens (exact OR pattern)
--   - rate_card_images: (model, size, quality)→USD/image (exact OR pattern;
--     pattern matches model only — size + quality stay exact)
--   - rate_card_speech: model→USD/M chars (exact OR pattern)
--   - rate_card_transcriptions: model→USD/minute (exact OR pattern)
--
-- Pattern resolution at read time: exact match → patterns by sort_order
-- ascending → null. Caller (engine) throws ModelNotFoundError on null.

CREATE TABLE app.rate_card_chat_tiers (
  tier                    TEXT PRIMARY KEY
    CHECK (tier IN ('starter', 'standard', 'pro', 'premium')),
  input_usd_per_million   NUMERIC(20, 8) NOT NULL CHECK (input_usd_per_million  >= 0),
  output_usd_per_million  NUMERIC(20, 8) NOT NULL CHECK (output_usd_per_million >= 0),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE app.rate_card_chat_models (
  id                  UUID  PRIMARY KEY DEFAULT gen_random_uuid(),
  model_or_pattern    TEXT  NOT NULL,
  is_pattern          BOOL  NOT NULL,
  tier                TEXT  NOT NULL
    REFERENCES app.rate_card_chat_tiers(tier)
    ON UPDATE CASCADE,
  sort_order          INT   NOT NULL DEFAULT 100,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (model_or_pattern, is_pattern)
);
CREATE INDEX rate_card_chat_models_exact_idx
  ON app.rate_card_chat_models (model_or_pattern) WHERE is_pattern = false;
CREATE INDEX rate_card_chat_models_patterns_idx
  ON app.rate_card_chat_models (sort_order) WHERE is_pattern = true;

CREATE TABLE app.rate_card_embeddings (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  model_or_pattern         TEXT NOT NULL,
  is_pattern               BOOL NOT NULL,
  usd_per_million_tokens   NUMERIC(20, 8) NOT NULL CHECK (usd_per_million_tokens >= 0),
  sort_order               INT  NOT NULL DEFAULT 100,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (model_or_pattern, is_pattern)
);

CREATE TABLE app.rate_card_images (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  model_or_pattern  TEXT NOT NULL,
  is_pattern        BOOL NOT NULL,
  size              TEXT NOT NULL,
  quality           TEXT NOT NULL CHECK (quality IN ('standard','hd')),
  usd_per_image     NUMERIC(20, 8) NOT NULL CHECK (usd_per_image >= 0),
  sort_order        INT  NOT NULL DEFAULT 100,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (model_or_pattern, is_pattern, size, quality)
);

CREATE TABLE app.rate_card_speech (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  model_or_pattern         TEXT NOT NULL,
  is_pattern               BOOL NOT NULL,
  usd_per_million_chars    NUMERIC(20, 8) NOT NULL CHECK (usd_per_million_chars >= 0),
  sort_order               INT  NOT NULL DEFAULT 100,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (model_or_pattern, is_pattern)
);

CREATE TABLE app.rate_card_transcriptions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  model_or_pattern  TEXT NOT NULL,
  is_pattern        BOOL NOT NULL,
  usd_per_minute    NUMERIC(20, 8) NOT NULL CHECK (usd_per_minute >= 0),
  sort_order        INT  NOT NULL DEFAULT 100,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (model_or_pattern, is_pattern)
);
