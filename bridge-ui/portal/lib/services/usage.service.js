import { BehaviorSubject } from 'rxjs';
import { api } from '../api.js';

const _state = new BehaviorSubject(/** @type {{ loading: boolean, data: unknown, error: string|null }} */({
  loading: false,
  data: null,
  error: null,
}));

export const usageService = {
  state$: _state.asObservable(),
  get value() { return _state.getValue(); },

  /** @param {{ from?: string, to?: string, group_by?: 'day'|'model'|'capability' }} params */
  async query(params = {}) {
    _state.next({ loading: true, data: _state.getValue().data, error: null });
    try {
      const qs = new URLSearchParams();
      if (params.from) qs.set('from', params.from);
      if (params.to) qs.set('to', params.to);
      if (params.group_by) qs.set('group_by', params.group_by);
      const path = qs.toString() ? `/v1/account/usage?${qs}` : '/v1/account/usage';
      const data = await api.get(path);
      _state.next({ loading: false, data, error: null });
      return data;
    } catch (err) {
      _state.next({ loading: false, data: _state.getValue().data, error: err instanceof Error ? err.message : 'failed' });
      throw err;
    }
  },

  reset() { _state.next({ loading: false, data: null, error: null }); },
};
