import { BehaviorSubject } from 'rxjs';
import { api } from '../api.js';

const _state = new BehaviorSubject(null);

export const reservationsService = {
  state$: _state.asObservable(),
  get value() {
    return _state.getValue();
  },

  /** @param {{ state?: 'open'|'committed'|'refunded', limit?: number, cursor?: string }} params */
  async search(params = {}) {
    const qs = new URLSearchParams();
    qs.set('state', params.state ?? 'open');
    qs.set('limit', String(params.limit ?? 100));
    if (params.cursor) qs.set('cursor', params.cursor);
    const out = await api.get(`/admin/reservations?${qs}`);
    _state.next(out);
    return out;
  },

  reset() {
    _state.next(null);
  },
};
