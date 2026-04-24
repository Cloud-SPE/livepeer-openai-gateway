DO $$ BEGIN
 CREATE TYPE "public"."node_health_event_kind" AS ENUM('circuit_opened', 'circuit_half_opened', 'circuit_closed', 'config_reloaded', 'eth_address_changed_rejected');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."node_health_status" AS ENUM('healthy', 'degraded', 'circuit_broken');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "node_health" (
	"node_id" text PRIMARY KEY NOT NULL,
	"status" "node_health_status" NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_success_at" timestamp with time zone,
	"last_failure_at" timestamp with time zone,
	"circuit_opened_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "node_health_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" text NOT NULL,
	"kind" "node_health_event_kind" NOT NULL,
	"detail" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "node_health_event_node_time_idx" ON "node_health_event" USING btree ("node_id","occurred_at");