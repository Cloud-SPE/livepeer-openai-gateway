// Rate-card service: thin wrapper over /admin/pricing/* endpoints with
// rxjs-backed result caches (one BehaviorSubject per capability).
// Mirrors the customers.service.js shape. Per exec-plan 0030.

import { BehaviorSubject } from 'rxjs';
import { api } from '../api.js';

const _chatTiers = new BehaviorSubject(null);
const _chatModels = new BehaviorSubject(null);
const _embeddings = new BehaviorSubject(null);
const _images = new BehaviorSubject(null);
const _speech = new BehaviorSubject(null);
const _transcriptions = new BehaviorSubject(null);

export const rateCardService = {
  // Observables.
  chatTiers$: _chatTiers.asObservable(),
  chatModels$: _chatModels.asObservable(),
  embeddings$: _embeddings.asObservable(),
  images$: _images.asObservable(),
  speech$: _speech.asObservable(),
  transcriptions$: _transcriptions.asObservable(),

  // Snapshot getters.
  get chatTiers()      { return _chatTiers.getValue(); },
  get chatModels()     { return _chatModels.getValue(); },
  get embeddings()     { return _embeddings.getValue(); },
  get images()         { return _images.getValue(); },
  get speech()         { return _speech.getValue(); },
  get transcriptions() { return _transcriptions.getValue(); },

  // ── Chat tier prices ─────────────────────────────────────────────────────

  async fetchChatTiers() {
    const out = await api.get('/admin/pricing/chat/tiers');
    _chatTiers.next(out);
    return out;
  },
  /** @param {string} tier @param {{ input_usd_per_million: string|number, output_usd_per_million: string|number }} body */
  async updateChatTier(tier, body) {
    const out = await api.put(`/admin/pricing/chat/tiers/${encodeURIComponent(tier)}`, body);
    await this.fetchChatTiers();
    return out;
  },

  // ── Chat model rows ──────────────────────────────────────────────────────

  async fetchChatModels() {
    const out = await api.get('/admin/pricing/chat/models');
    _chatModels.next(out);
    return out;
  },
  async createChatModel(body) {
    const out = await api.post('/admin/pricing/chat/models', body);
    await this.fetchChatModels();
    return out;
  },
  async deleteChatModel(id) {
    await api.del(`/admin/pricing/chat/models/${encodeURIComponent(id)}`);
    await this.fetchChatModels();
  },

  // ── Embeddings ───────────────────────────────────────────────────────────

  async fetchEmbeddings() {
    const out = await api.get('/admin/pricing/embeddings');
    _embeddings.next(out);
    return out;
  },
  async createEmbeddings(body) {
    const out = await api.post('/admin/pricing/embeddings', body);
    await this.fetchEmbeddings();
    return out;
  },
  async deleteEmbeddings(id) {
    await api.del(`/admin/pricing/embeddings/${encodeURIComponent(id)}`);
    await this.fetchEmbeddings();
  },

  // ── Images ───────────────────────────────────────────────────────────────

  async fetchImages() {
    const out = await api.get('/admin/pricing/images');
    _images.next(out);
    return out;
  },
  async createImages(body) {
    const out = await api.post('/admin/pricing/images', body);
    await this.fetchImages();
    return out;
  },
  async deleteImages(id) {
    await api.del(`/admin/pricing/images/${encodeURIComponent(id)}`);
    await this.fetchImages();
  },

  // ── Speech ───────────────────────────────────────────────────────────────

  async fetchSpeech() {
    const out = await api.get('/admin/pricing/speech');
    _speech.next(out);
    return out;
  },
  async createSpeech(body) {
    const out = await api.post('/admin/pricing/speech', body);
    await this.fetchSpeech();
    return out;
  },
  async deleteSpeech(id) {
    await api.del(`/admin/pricing/speech/${encodeURIComponent(id)}`);
    await this.fetchSpeech();
  },

  // ── Transcriptions ───────────────────────────────────────────────────────

  async fetchTranscriptions() {
    const out = await api.get('/admin/pricing/transcriptions');
    _transcriptions.next(out);
    return out;
  },
  async createTranscriptions(body) {
    const out = await api.post('/admin/pricing/transcriptions', body);
    await this.fetchTranscriptions();
    return out;
  },
  async deleteTranscriptions(id) {
    await api.del(`/admin/pricing/transcriptions/${encodeURIComponent(id)}`);
    await this.fetchTranscriptions();
  },

  reset() {
    _chatTiers.next(null);
    _chatModels.next(null);
    _embeddings.next(null);
    _images.next(null);
    _speech.next(null);
    _transcriptions.next(null);
  },
};
