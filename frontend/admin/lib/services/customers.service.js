import { BehaviorSubject } from 'rxjs';
import { api } from '../api.js';

const _results = new BehaviorSubject(null); // search results
const _selected = new BehaviorSubject(null); // currently-open customer detail

export const customersService = {
  results$: _results.asObservable(),
  selected$: _selected.asObservable(),
  get results() {
    return _results.getValue();
  },
  get selected() {
    return _selected.getValue();
  },

  /**
   * @param {{ q?: string, tier?: string, status?: string, limit?: number, cursor?: string }} params
   */
  async search(params = {}) {
    const qs = new URLSearchParams();
    if (params.q) qs.set('q', params.q);
    if (params.tier) qs.set('tier', params.tier);
    if (params.status) qs.set('status', params.status);
    qs.set('limit', String(params.limit ?? 50));
    if (params.cursor) qs.set('cursor', params.cursor);
    const out = await api.get(`/admin/customers?${qs}`);
    _results.next(out);
    return out;
  },

  /** @param {string} id */
  async select(id) {
    const detail = await api.get(`/admin/customers/${encodeURIComponent(id)}`);
    _selected.next(detail);
    return detail;
  },

  /** @param {string} id @param {{ stripeSessionId: string, reason: string }} body */
  async refund(id, body) {
    return api.post(`/admin/customers/${encodeURIComponent(id)}/refund`, body);
  },
  /** @param {string} id */
  async suspend(id) {
    return api.post(`/admin/customers/${encodeURIComponent(id)}/suspend`, {});
  },
  /** @param {string} id */
  async unsuspend(id) {
    return api.post(`/admin/customers/${encodeURIComponent(id)}/unsuspend`, {});
  },

  /** @param {string} id */
  async listKeys(id) {
    return api.get(`/admin/customers/${encodeURIComponent(id)}/api-keys`);
  },

  /** @param {string} id @param {string} label */
  async issueKey(id, label) {
    return api.post(`/admin/customers/${encodeURIComponent(id)}/api-keys`, { label });
  },

  /**
   * @param {{
   *   email: string,
   *   tier: 'free' | 'prepaid',
   *   rate_limit_tier?: string,
   *   balance_usd_cents?: string,
   *   quota_monthly_allowance?: string | null,
   * }} input
   */
  async create(input) {
    return api.post('/admin/customers', input);
  },

  reset() {
    _results.next(null);
    _selected.next(null);
  },
};
