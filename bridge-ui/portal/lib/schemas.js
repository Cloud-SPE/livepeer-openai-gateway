/**
 * Hand-mirrored response validators for /v1/account/*. Field names track the
 * server-side Zod schemas in src/runtime/http/account/. Doc-lint diffs the
 * shapes; keep them in sync.
 */
import {
  array,
  isoDate,
  literal,
  nullable,
  number,
  object,
  optional,
  string,
} from '../../shared/lib/validators.js';

const tier = literal('free', 'prepaid');
const status = literal('active', 'suspended', 'closed');

const account = object({
  id: string(),
  email: string(),
  tier,
  status,
  balance_usd: string(),                    // formatted "12.34"
  reserved_usd: string(),
  free_tokens_remaining: nullable(number()),
  free_tokens_reset_at: nullable(isoDate()),
  created_at: isoDate(),
});

const apiKey = object({
  id: string(),
  label: nullable(string()),
  created_at: isoDate(),
  last_used_at: nullable(isoDate()),
  revoked_at: nullable(isoDate()),
});

const apiKeyList = object({ keys: array(apiKey) });

const apiKeyCreated = object({
  id: string(),
  label: nullable(string()),
  key: string(),
  created_at: isoDate(),
});

const usageRow = object({
  bucket: string(),                         // 'YYYY-MM-DD' or model name or capability
  prompt_tokens: number(),
  completion_tokens: number(),
  requests: number(),
  cost_usd: string(),
  status_breakdown: object({
    success: number(),
    partial: number(),
    failed: number(),
  }),
});

const usage = object({
  rows: array(usageRow),
  totals: object({
    prompt_tokens: number(),
    completion_tokens: number(),
    requests: number(),
    cost_usd: string(),
  }),
});

const topup = object({
  id: string(),
  stripe_session_id: string(),
  amount_usd: string(),
  status: literal('pending', 'succeeded', 'failed', 'refunded', 'disputed'),
  created_at: isoDate(),
  refunded_at: nullable(isoDate()),
  disputed_at: nullable(isoDate()),
});

const topupList = object({
  topups: array(topup),
  next_cursor: nullable(string()),
});

const topupCreated = object({
  url: string(),
  session_id: string(),
});

const limits = object({
  tier,
  max_concurrent: number(),
  requests_per_minute: number(),
  max_tokens_per_request: number(),
  monthly_token_quota: nullable(number()),
});

/**
 * Path → validator dispatcher. createApi calls this with the parsed JSON
 * payload; mismatches throw ValidationError which surfaces as a request error.
 */
export function parseResponse(method, path, body) {
  const p = path.split('?')[0].replace(/\/$/, '');
  const m = method.toUpperCase();

  if (m === 'GET' && p === '/v1/account') return account(body);
  if (m === 'GET' && p === '/v1/account/api-keys') return apiKeyList(body);
  if (m === 'POST' && p === '/v1/account/api-keys') return apiKeyCreated(body);
  if (m === 'DELETE' && p.match(/^\/v1\/account\/api-keys\/[^/]+$/)) return null;
  if (m === 'GET' && p === '/v1/account/usage') return usage(body);
  if (m === 'GET' && p === '/v1/account/topups') return topupList(body);
  if (m === 'GET' && p === '/v1/account/limits') return limits(body);
  if (m === 'POST' && p === '/v1/billing/topup') return topupCreated(body);

  return body; // Pass through for unknown paths during dev.
}

// Exposed for explicit use in services.
export const validators = {
  account,
  apiKey,
  apiKeyList,
  apiKeyCreated,
  usage,
  topup,
  topupList,
  topupCreated,
  limits,
};
