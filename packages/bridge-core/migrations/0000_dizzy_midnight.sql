DO $$ BEGIN
 CREATE TYPE "public"."customer_status" AS ENUM('active', 'suspended', 'closed');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."customer_tier" AS ENUM('free', 'prepaid');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."reservation_kind" AS ENUM('prepaid', 'free');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."reservation_state" AS ENUM('open', 'committed', 'refunded');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."topup_status" AS ENUM('pending', 'succeeded', 'failed', 'refunded');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."usage_status" AS ENUM('success', 'partial', 'failed');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "customer" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"api_key_hash" text NOT NULL,
	"tier" "customer_tier" NOT NULL,
	"status" "customer_status" DEFAULT 'active' NOT NULL,
	"rate_limit_tier" text DEFAULT 'default' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"balance_usd_cents" bigint DEFAULT 0 NOT NULL,
	"reserved_usd_cents" bigint DEFAULT 0 NOT NULL,
	"quota_tokens_remaining" bigint,
	"quota_monthly_allowance" bigint,
	"quota_reserved_tokens" bigint DEFAULT 0 NOT NULL,
	"quota_reset_at" timestamp with time zone,
	CONSTRAINT "customer_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reservation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"work_id" text NOT NULL,
	"kind" "reservation_kind" NOT NULL,
	"amount_usd_cents" bigint,
	"amount_tokens" bigint,
	"state" "reservation_state" DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "reservation_work_id_unique" UNIQUE("work_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "topup" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"stripe_session_id" text NOT NULL,
	"amount_usd_cents" bigint NOT NULL,
	"status" "topup_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "topup_stripe_session_id_unique" UNIQUE("stripe_session_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "usage_record" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"work_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"model" text NOT NULL,
	"node_url" text NOT NULL,
	"prompt_tokens_reported" integer NOT NULL,
	"completion_tokens_reported" integer NOT NULL,
	"prompt_tokens_local" integer,
	"completion_tokens_local" integer,
	"cost_usd_cents" bigint NOT NULL,
	"node_cost_wei" text NOT NULL,
	"status" "usage_status" NOT NULL,
	"error_code" text
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reservation" ADD CONSTRAINT "reservation_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "topup" ADD CONSTRAINT "topup_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "usage_record" ADD CONSTRAINT "usage_record_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_api_key_hash_idx" ON "customer" USING btree ("api_key_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reservation_customer_idx" ON "reservation" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "topup_customer_idx" ON "topup" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_record_customer_idx" ON "usage_record" USING btree ("customer_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_record_work_idx" ON "usage_record" USING btree ("work_id");