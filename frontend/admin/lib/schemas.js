/**
 * Hand-mirrored validators for /admin/* responses. Doc-lint diffs the field
 * names against the server-side Zod schemas.
 */
import {
  array,
  boolean,
  integer,
  isoDate,
  literal,
  nullable,
  number,
  object,
  optional,
  string,
} from '../../shared/lib/validators.js';

const tier = literal('free', 'prepaid');
const customerStatus = literal('active', 'suspended', 'closed');

const health = object({
  ok: boolean(),
  payerDaemonHealthy: boolean(),
  dbOk: boolean(),
  redisOk: boolean(),
  nodeCount: number(),
  nodesHealthy: number(),
});

const node = object({
  id: string(),
  url: string(),
  enabled: boolean(),
  status: literal('healthy', 'degraded', 'circuit_broken'),
  tierAllowed: array(tier),
  supportedModels: array(string()),
  recognizedCapabilities: array(string()),
  eligibleCapabilities: array(string()),
  eligibility: literal('eligible', 'ineligible', 'unknown'),
  ineligibleReason: nullable(
    literal('no_recognized_capabilities', 'not_in_live_registry', 'registry_unavailable'),
  ),
  weight: number(),
});
const nodeList = object({ nodes: array(node) });

const nodeEvent = object({
  id: string(),
  node_id: string(),
  kind: string(),
  detail: nullable(string()),
  occurred_at: isoDate(),
});
const nodeEventsList = object({
  events: array(nodeEvent),
  next_cursor: nullable(string()),
});

const customerSummary = object({
  id: string(),
  email: string(),
  tier,
  status: customerStatus,
  balance_usd_cents: string(),
  created_at: isoDate(),
});
const customersList = object({
  customers: array(customerSummary),
  next_cursor: nullable(string()),
});

const customerDetail = object({
  id: string(),
  email: string(),
  tier,
  status: customerStatus,
  balanceUsdCents: string(),
  reservedUsdCents: string(),
  quotaTokensRemaining: nullable(string()),
  quotaMonthlyAllowance: nullable(string()),
  rateLimitTier: string(),
  createdAt: isoDate(),
  topups: array(
    object({
      stripeSessionId: string(),
      amountUsdCents: string(),
      status: string(),
      createdAt: isoDate(),
      refundedAt: nullable(isoDate()),
      disputedAt: nullable(isoDate()),
    }),
  ),
  recentUsage: array(
    object({
      workId: string(),
      model: string(),
      costUsdCents: string(),
      status: string(),
      createdAt: isoDate(),
    }),
  ),
});

const adminApiKey = object({
  id: string(),
  label: nullable(string()),
  created_at: isoDate(),
  last_used_at: nullable(isoDate()),
  revoked_at: nullable(isoDate()),
});
const adminApiKeyList = object({ keys: array(adminApiKey) });
const adminApiKeyCreated = object({
  id: string(),
  label: nullable(string()),
  key: string(),
  created_at: isoDate(),
});

const auditEvent = object({
  id: string(),
  actor: string(),
  action: string(),
  target_id: nullable(string()),
  status_code: integer(),
  occurred_at: isoDate(),
});
const auditList = object({
  events: array(auditEvent),
  next_cursor: nullable(string()),
});

const reservation = object({
  id: string(),
  customer_id: string(),
  work_id: string(),
  kind: literal('prepaid', 'free'),
  amount_usd_cents: nullable(string()),
  amount_tokens: nullable(string()),
  state: literal('open', 'committed', 'refunded'),
  created_at: isoDate(),
  age_seconds: number(),
});
const reservationsList = object({
  reservations: array(reservation),
  next_cursor: nullable(string()),
});

const adminTopup = object({
  id: string(),
  customer_id: string(),
  stripe_session_id: string(),
  amount_usd_cents: string(),
  status: literal('pending', 'succeeded', 'failed', 'refunded'),
  created_at: isoDate(),
  refunded_at: nullable(isoDate()),
  disputed_at: nullable(isoDate()),
});
const adminTopupsList = object({
  topups: array(adminTopup),
  next_cursor: nullable(string()),
});

const escrow = object({
  depositWei: string(),
  reserveWei: string(),
  withdrawRound: string(),
  source: literal('payer_daemon'),
});

const nodesConfigView = object({
  path: string(),
  sha256: string(),
  mtime: isoDate(),
  size_bytes: number(),
  contents: string(),
  loaded_nodes: array(node),
});

export function parseResponse(method, path, body) {
  const p = path.split('?')[0].replace(/\/$/, '');
  const m = method.toUpperCase();

  if (m === 'GET' && p === '/admin/health') return health(body);
  if (m === 'GET' && p === '/admin/nodes') return nodeList(body);
  if (m === 'GET' && p.match(/^\/admin\/nodes\/[^/]+\/events$/)) return nodeEventsList(body);
  if (m === 'GET' && p.match(/^\/admin\/nodes\/[^/]+$/)) return body; // node detail shape returned by adminService is rich; pass through
  if (m === 'GET' && p === '/admin/customers') return customersList(body);
  if (m === 'POST' && p === '/admin/customers') return customerDetail(body);
  if (m === 'GET' && p.match(/^\/admin\/customers\/[^/]+\/api-keys$/)) return adminApiKeyList(body);
  if (m === 'POST' && p.match(/^\/admin\/customers\/[^/]+\/api-keys$/))
    return adminApiKeyCreated(body);
  if (m === 'GET' && p.match(/^\/admin\/customers\/[^/]+$/)) return customerDetail(body);
  if (m === 'POST' && p.match(/^\/admin\/customers\/[^/]+\/(refund|suspend|unsuspend)$/))
    return body;
  if (m === 'GET' && p === '/admin/audit') return auditList(body);
  if (m === 'GET' && p === '/admin/reservations') return reservationsList(body);
  if (m === 'GET' && p === '/admin/topups') return adminTopupsList(body);
  if (m === 'GET' && p === '/admin/escrow') return escrow(body);
  if (m === 'GET' && p === '/admin/config/nodes') return nodesConfigView(body);
  // 0030: rate-card surfaces. Pass-through validation — the backend
  // enforces shape via zod and the SPA handles whatever JSON comes back.
  if (p.startsWith('/admin/pricing/')) return body;

  return body;
}

export const validators = {
  health,
  nodeList,
  nodeEventsList,
  customersList,
  customerDetail,
  adminApiKeyList,
  adminApiKeyCreated,
  auditList,
  reservationsList,
  adminTopupsList,
  escrow,
  nodesConfigView,
};
