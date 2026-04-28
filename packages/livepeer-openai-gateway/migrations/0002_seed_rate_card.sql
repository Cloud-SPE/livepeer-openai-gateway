-- Seed the rate card with the engine's V1 (2026-04-25) defaults so a
-- fresh deploy doesn't black-hole every chat / embeddings / images /
-- speech / transcription request. Operators edit these via the admin
-- SPA at /admin/console/#/rate-card.
--
-- Idempotent via the migration tracker (public.bridge_schema_migrations);
-- this seed file runs exactly once on first deploy of 0030.

-- Tier prices (chat).
INSERT INTO app.rate_card_chat_tiers (tier, input_usd_per_million, output_usd_per_million) VALUES
  ('starter',  0.05, 0.10),
  ('standard', 0.15, 0.40),
  ('pro',      0.40, 1.20),
  ('premium',  2.50, 6.00);

-- Chat model→tier (exact entries that shipped with the engine).
INSERT INTO app.rate_card_chat_models (model_or_pattern, is_pattern, tier, sort_order) VALUES
  ('model-small',   false, 'starter',  100),
  ('model-medium',  false, 'standard', 100),
  ('model-large',   false, 'pro',      100),
  ('model-premium', false, 'premium',  100),
  ('gemma4:26b',    false, 'starter',  100);

-- Embeddings.
INSERT INTO app.rate_card_embeddings (model_or_pattern, is_pattern, usd_per_million_tokens, sort_order) VALUES
  ('text-embedding-3-small', false, 0.005, 100),
  ('text-embedding-3-large', false, 0.050, 100),
  ('text-embedding-bge-m3',  false, 0.005, 100);

-- Images: dall-e-3 across all (size, quality), sdxl 1024x1024 standard.
INSERT INTO app.rate_card_images (model_or_pattern, is_pattern, size, quality, usd_per_image, sort_order) VALUES
  ('dall-e-3', false, '1024x1024', 'standard', 0.025, 100),
  ('dall-e-3', false, '1024x1024', 'hd',       0.050, 100),
  ('dall-e-3', false, '1024x1792', 'standard', 0.040, 100),
  ('dall-e-3', false, '1024x1792', 'hd',       0.075, 100),
  ('dall-e-3', false, '1792x1024', 'standard', 0.040, 100),
  ('dall-e-3', false, '1792x1024', 'hd',       0.075, 100),
  ('sdxl',     false, '1024x1024', 'standard', 0.002, 100);

-- Speech.
INSERT INTO app.rate_card_speech (model_or_pattern, is_pattern, usd_per_million_chars, sort_order) VALUES
  ('tts-1',    false,  5.00, 100),
  ('tts-1-hd', false, 12.00, 100),
  ('kokoro',   false,  1.00, 100);

-- Transcriptions.
INSERT INTO app.rate_card_transcriptions (model_or_pattern, is_pattern, usd_per_minute, sort_order) VALUES
  ('whisper-1', false, 0.003, 100);
