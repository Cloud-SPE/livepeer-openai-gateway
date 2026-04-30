import { BehaviorSubject } from 'rxjs';
import { api } from '../api.js';

const _keys = new BehaviorSubject(/** @type {Array<unknown>|null} */ (null));

export const keysService = {
  keys$: _keys.asObservable(),
  get value() {
    return _keys.getValue();
  },

  async refresh() {
    const { keys } = await api.get('/v1/account/api-keys');
    _keys.next(keys);
    return keys;
  },

  /** @param {string} label */
  async create(label) {
    const created = await api.post('/v1/account/api-keys', { label });
    // Optimistic prepend; refresh will reconcile the timestamp formatting.
    const optimistic = {
      id: created.id,
      label: created.label,
      created_at: created.created_at,
      last_used_at: null,
      revoked_at: null,
    };
    _keys.next([optimistic, ...(_keys.getValue() ?? [])]);
    return created;
  },

  /** @param {string} id */
  async revoke(id) {
    const previous = _keys.getValue() ?? [];
    // Optimistic mark
    _keys.next(
      previous.map((k) => (k.id === id ? { ...k, revoked_at: new Date().toISOString() } : k)),
    );
    try {
      await api.del(`/v1/account/api-keys/${id}`);
    } catch (err) {
      _keys.next(previous);
      throw err;
    }
  },

  reset() {
    _keys.next(null);
  },
};
