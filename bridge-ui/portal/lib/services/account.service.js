import { BehaviorSubject } from 'rxjs';
import { api } from '../api.js';

const _account = new BehaviorSubject(null);

export const accountService = {
  account$: _account.asObservable(),
  get value() { return _account.getValue(); },
  set(value) { _account.next(value); },
  async refresh() {
    const a = await api.get('/v1/account');
    _account.next(a);
    return a;
  },
  signOut() { _account.next(null); },
};
