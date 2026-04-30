import { BehaviorSubject } from 'rxjs';
import { api } from '../api.js';

const CAPABILITIES = ['chat', 'embeddings', 'images', 'speech', 'transcriptions'];

const priceSubjects = new Map(CAPABILITIES.map((cap) => [cap, new BehaviorSubject(null)]));
const aliasSubjects = new Map(CAPABILITIES.map((cap) => [cap, new BehaviorSubject(null)]));

function subject(map, capability) {
  const out = map.get(capability);
  if (!out) throw new Error(`unknown capability: ${capability}`);
  return out;
}

export const retailPricingService = {
  prices$(capability) {
    return subject(priceSubjects, capability).asObservable();
  },
  aliases$(capability) {
    return subject(aliasSubjects, capability).asObservable();
  },
  getPrices(capability) {
    return subject(priceSubjects, capability).getValue();
  },
  getAliases(capability) {
    return subject(aliasSubjects, capability).getValue();
  },
  async fetchPrices(capability) {
    const out = await api.get(`/admin/pricing/retail/prices/${encodeURIComponent(capability)}`);
    subject(priceSubjects, capability).next(out);
    return out;
  },
  async fetchAliases(capability) {
    const out = await api.get(`/admin/pricing/retail/aliases/${encodeURIComponent(capability)}`);
    subject(aliasSubjects, capability).next(out);
    return out;
  },
  async createPrice(body) {
    const out = await api.post('/admin/pricing/retail/prices', body);
    await this.fetchPrices(body.capability);
    return out;
  },
  async deletePrice(capability, id) {
    await api.del(`/admin/pricing/retail/prices/${encodeURIComponent(id)}`);
    await this.fetchPrices(capability);
  },
  async createAlias(body) {
    const out = await api.post('/admin/pricing/retail/aliases', body);
    await this.fetchAliases(body.capability);
    return out;
  },
  async deleteAlias(capability, id) {
    await api.del(`/admin/pricing/retail/aliases/${encodeURIComponent(id)}`);
    await this.fetchAliases(capability);
  },
  reset() {
    for (const capability of CAPABILITIES) {
      subject(priceSubjects, capability).next(null);
      subject(aliasSubjects, capability).next(null);
    }
  },
};
