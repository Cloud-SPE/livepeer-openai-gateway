import { BehaviorSubject } from 'rxjs';
import { api } from '../api.js';

const _state = new BehaviorSubject(null);

export const configService = {
  state$: _state.asObservable(),
  get value() {
    return _state.getValue();
  },

  async refresh() {
    const out = await api.get('/admin/config/nodes');
    _state.next(out);
    return out;
  },

  reset() {
    _state.next(null);
  },
};
