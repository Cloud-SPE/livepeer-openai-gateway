CREATE TABLE IF NOT EXISTS "admin_audit_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"target_id" text,
	"payload" text,
	"status_code" integer NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admin_audit_event_actor_time_idx" ON "admin_audit_event" USING btree ("actor","occurred_at");