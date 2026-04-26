import { BehaviorSubject } from 'rxjs';
import { api } from '../api.js';

const _health = new BehaviorSubject(null);

export const healthService = {
  health$: _health.asObservable(),
  get value() { return _health.getValue(); },
  set(value) { _health.next(value); },
  async refresh() {
    const v = await api.get('/admin/health');
    _health.next(v);
    return v;
  },
  reset() { _health.next(null); },
};
