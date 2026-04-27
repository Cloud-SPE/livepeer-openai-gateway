CREATE TABLE IF NOT EXISTS "stripe_webhook_event" (
	"event_id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payload" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "topup" ADD COLUMN "disputed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "topup" ADD COLUMN "refunded_at" timestamp with time zone;