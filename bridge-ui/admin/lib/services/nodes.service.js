import { BehaviorSubject } from 'rxjs';
import { api } from '../api.js';

const _nodes = new BehaviorSubject(null);

export const nodesService = {
  nodes$: _nodes.asObservable(),
  get value() { return _nodes.getValue(); },
  set(value) { _nodes.next(value); },

  async refresh() {
    const { nodes } = await api.get('/admin/nodes');
    _nodes.next(nodes);
    return nodes;
  },

  /** @param {string} id */
  async getDetail(id) {
    return api.get(`/admin/nodes/${encodeURIComponent(id)}`);
  },

  /**
   * @param {string} id
   * @param {{ limit?: number, cursor?: string }} [opts]
   */
  async getEvents(id, opts = {}) {
    const qs = new URLSearchParams();
    if (opts.limit) qs.set('limit', String(opts.limit));
    if (opts.cursor) qs.set('cursor', opts.cursor);
    const q = qs.toString();
    return api.get(`/admin/nodes/${encodeURIComponent(id)}/events${q ? `?${q}` : ''}`);
  },

  reset() { _nodes.next(null); },
};
