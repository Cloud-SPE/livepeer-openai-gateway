import { BehaviorSubject } from 'rxjs';
import { api } from '../api.js';

const _state = new BehaviorSubject(null);

export const topupsService = {
  state$: _state.asObservable(),
  get value() { return _state.getValue(); },

  /**
   * @param {{
   *   customer_id?: string, status?: 'pending'|'succeeded'|'failed'|'refunded',
   *   from?: string, to?: string, limit?: number, cursor?: string,
   * }} params
   */
  async search(params = {}) {
    const qs = new URLSearchParams();
    if (params.customer_id) qs.set('customer_id', params.customer_id);
    if (params.status) qs.set('status', params.status);
    if (params.from) qs.set('from', params.from);
    if (params.to) qs.set('to', params.to);
    qs.set('limit', String(params.limit ?? 100));
    if (params.cursor) qs.set('cursor', params.cursor);
    const out = await api.get(`/admin/topups?${qs}`);
    _state.next(out);
    return out;
  },

  reset() { _state.next(null); },
};
