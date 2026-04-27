DO $$ BEGIN
 CREATE TYPE "public"."usage_record_kind" AS ENUM('chat', 'embeddings', 'images');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "usage_record" ALTER COLUMN "prompt_tokens_reported" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_record" ALTER COLUMN "completion_tokens_reported" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_record" ADD COLUMN "kind" "usage_record_kind" DEFAULT 'chat' NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_record" ADD COLUMN "image_count" integer;--> statement-breakpoint
ALTER TABLE "usage_record" ADD CONSTRAINT "usage_record_kind_columns_chk" CHECK (
  (
    "kind" = 'chat' AND "prompt_tokens_reported" IS NOT NULL AND "completion_tokens_reported" IS NOT NULL
  ) OR (
    "kind" = 'embeddings' AND "prompt_tokens_reported" IS NOT NULL
  ) OR (
    "kind" = 'images' AND "image_count" IS NOT NULL
  )
);