-- 0006_audio_endpoints
--
-- Adds the speech + transcriptions metering columns and extends the
-- usage_record_kind enum + check constraint so /v1/audio/* routes can
-- write usage rows.
--
-- The CHECK constraint compares `kind::text` (not the enum directly)
-- so the freshly-added enum values can be referenced inside the same
-- migration transaction. Without the cast, PostgreSQL refuses the
-- constraint with `55P04 — new enum values must be committed before
-- they can be used`. The cast keeps the literal as text and the
-- comparison is by-string, which is semantically identical.

ALTER TYPE "usage_record_kind" ADD VALUE IF NOT EXISTS 'speech';--> statement-breakpoint
ALTER TYPE "usage_record_kind" ADD VALUE IF NOT EXISTS 'transcriptions';--> statement-breakpoint

ALTER TABLE "usage_record" ADD COLUMN IF NOT EXISTS "char_count" integer;--> statement-breakpoint
ALTER TABLE "usage_record" ADD COLUMN IF NOT EXISTS "duration_seconds" integer;--> statement-breakpoint

ALTER TABLE "usage_record" DROP CONSTRAINT IF EXISTS "usage_record_kind_columns_chk";--> statement-breakpoint
ALTER TABLE "usage_record" ADD CONSTRAINT "usage_record_kind_columns_chk" CHECK (
  (
    "kind"::text = 'chat' AND "prompt_tokens_reported" IS NOT NULL AND "completion_tokens_reported" IS NOT NULL
  ) OR (
    "kind"::text = 'embeddings' AND "prompt_tokens_reported" IS NOT NULL
  ) OR (
    "kind"::text = 'images' AND "image_count" IS NOT NULL
  ) OR (
    "kind"::text = 'speech' AND "char_count" IS NOT NULL
  ) OR (
    "kind"::text = 'transcriptions' AND "duration_seconds" IS NOT NULL
  )
);
