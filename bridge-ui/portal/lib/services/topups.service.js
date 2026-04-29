import { BehaviorSubject, interval, Subscription } from 'rxjs';
import { api } from '../api.js';

const _topups = new BehaviorSubject(/** @type {Array<unknown>|null} */ (null));

export const topupsService = {
  topups$: _topups.asObservable(),
  get value() {
    return _topups.getValue();
  },

  async refresh() {
    const { topups } = await api.get('/v1/account/topups');
    _topups.next(topups);
    return topups;
  },

  /** @param {number} amountUsdCents */
  async startCheckout(amountUsdCents) {
    return api.post('/v1/billing/topup', { amount_usd_cents: amountUsdCents });
  },

  /**
   * Poll until the topup with the given Stripe session id is settled (succeeded/failed/refunded).
   * @param {string} sessionId
   * @param {number} timeoutMs
   * @returns {Promise<unknown>} the settled topup, or null on timeout
   */
  async pollUntilSettled(sessionId, timeoutMs = 60_000) {
    const start = Date.now();
    return new Promise((resolve) => {
      let sub = new Subscription();
      const finish = (value) => {
        sub.unsubscribe();
        resolve(value);
      };
      sub = interval(2000).subscribe(async () => {
        if (Date.now() - start > timeoutMs) return finish(null);
        try {
          const { topups } = await api.get('/v1/account/topups');
          _topups.next(topups);
          const t = topups.find((x) => x.stripe_session_id === sessionId);
          if (t && t.status !== 'pending') finish(t);
        } catch {
          /* keep polling */
        }
      });
    });
  },

  reset() {
    _topups.next(null);
  },
};
