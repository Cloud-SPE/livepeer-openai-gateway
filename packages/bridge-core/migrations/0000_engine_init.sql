-- @cloud-spe/bridge-core engine schema. Owns the node-pool view +
-- request-level usage records the engine writes per dispatch.
--
-- Per exec-plan 0026 step 7: fresh-install only, no data migration. The
-- `engine.usage_records.caller_id` column is opaque text — the engine
-- treats it as a generic caller identifier handed in by the shell's
-- AuthResolver. There are NO foreign keys from engine.* into any other
-- schema; the shell's app.customers.id happens to match what gets stored
-- here but engine code never resolves the join.

CREATE SCHEMA IF NOT EXISTS engine;

-- ── Enums (engine-owned) ────────────────────────────────────────────────────
CREATE TYPE engine.usage_status AS ENUM ('success', 'partial', 'failed');
CREATE TYPE engine.usage_record_kind AS ENUM (
  'chat',
  'embeddings',
  'images',
  'speech',
  'transcriptions'
);
CREATE TYPE engine.node_health_status AS ENUM (
  'healthy',
  'degraded',
  'circuit_broken'
);
CREATE TYPE engine.node_health_event_kind AS ENUM (
  'circuit_opened',
  'circuit_half_opened',
  'circuit_closed',
  'config_reloaded',
  'eth_address_changed_rejected'
);

-- ── Tables ──────────────────────────────────────────────────────────────────

CREATE TABLE engine.node_health (
  node_id             TEXT        PRIMARY KEY,
  status              engine.node_health_status NOT NULL,
  consecutive_failures INTEGER    NOT NULL DEFAULT 0,
  last_success_at     TIMESTAMPTZ,
  last_failure_at     TIMESTAMPTZ,
  circuit_opened_at   TIMESTAMPTZ,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE engine.node_health_events (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id     TEXT        NOT NULL,
  kind        engine.node_health_event_kind NOT NULL,
  detail      TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX node_health_event_node_time_idx
  ON engine.node_health_events (node_id, occurred_at);

CREATE TABLE engine.usage_records (
  id                          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  caller_id                   TEXT        NOT NULL,        -- opaque shell-supplied identifier
  work_id                     TEXT        NOT NULL,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  kind                        engine.usage_record_kind NOT NULL DEFAULT 'chat',
  model                       TEXT        NOT NULL,
  node_url                    TEXT        NOT NULL,
  prompt_tokens_reported      INTEGER,
  completion_tokens_reported  INTEGER,
  prompt_tokens_local         INTEGER,
  completion_tokens_local     INTEGER,
  image_count                 INTEGER,
  char_count                  INTEGER,
  duration_seconds            INTEGER,
  cost_usd_cents              BIGINT      NOT NULL,
  node_cost_wei               TEXT        NOT NULL,
  status                      engine.usage_status NOT NULL,
  error_code                  TEXT,
  CONSTRAINT usage_record_kind_columns_chk CHECK (
    (kind = 'chat'           AND prompt_tokens_reported IS NOT NULL AND completion_tokens_reported IS NOT NULL) OR
    (kind = 'embeddings'     AND prompt_tokens_reported IS NOT NULL) OR
    (kind = 'images'         AND image_count IS NOT NULL) OR
    (kind = 'speech'         AND char_count IS NOT NULL) OR
    (kind = 'transcriptions' AND duration_seconds IS NOT NULL)
  )
);
CREATE INDEX usage_record_caller_idx
  ON engine.usage_records (caller_id, created_at);
CREATE INDEX usage_record_work_idx
  ON engine.usage_records (work_id);
