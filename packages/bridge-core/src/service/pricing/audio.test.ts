import { describe, expect, it } from 'vitest';
import { defaultPricingConfig } from '../../config/pricing.js';
import {
  computeSpeechActualCost,
  computeTranscriptionsActualCost,
  estimateSpeechReservation,
  estimateTranscriptionsReservation,
} from './index.js';

const cfg = defaultPricingConfig();

describe('estimateSpeechReservation', () => {
  it('round-trips estimate equals commit (no over-debit drift)', () => {
    const est = estimateSpeechReservation(1000, 'tts-1', cfg);
    const actual = computeSpeechActualCost(1000, 'tts-1', cfg);
    // Char count is deterministic at the boundary, so estimate and
    // commit must agree exactly.
    expect(est.estCents).toBe(actual.actualCents);
  });

  it('1M chars on tts-1 = $5 (500 cents) at v2 rate', () => {
    // V2 rate: tts-1 at $5/1M. Cents = chars × $/1M × 100.
    const est = estimateSpeechReservation(1_000_000, 'tts-1', cfg);
    expect(est.estCents).toBe(500n);
  });

  it('1M chars on tts-1-hd = $12 (1200 cents) at v2 rate', () => {
    const est = estimateSpeechReservation(1_000_000, 'tts-1-hd', cfg);
    expect(est.estCents).toBe(1200n);
  });

  it('rounds up sub-cent fractions', () => {
    // 1 char on tts-1 (v2 = $5/1M): 5e-6 USD → 5e-4 cents → ceil 1.
    const est = estimateSpeechReservation(1, 'tts-1', cfg);
    expect(est.estCents).toBe(1n);
  });

  it('rejects unknown models with a descriptive error', () => {
    expect(() => estimateSpeechReservation(100, 'bogus-tts', cfg)).toThrow(
      /no speech rate card entry/,
    );
  });

  it('clamps negative char counts to 0', () => {
    const est = estimateSpeechReservation(-10, 'tts-1', cfg);
    expect(est.charCount).toBe(0);
  });
});

describe('estimateTranscriptionsReservation', () => {
  it('whisper-1: 60 seconds reserved costs 1 cent (rate × 1 min)', () => {
    // 60 s × $0.003/min (v2) = $0.003 → 0.30 cents → ceil 1.
    const est = estimateTranscriptionsReservation(8_000 * 60, 'whisper-1', cfg);
    expect(est.estimatedSeconds).toBe(60);
    expect(est.estCents).toBe(1n);
  });

  it('caps reservation at 60 minutes regardless of file size', () => {
    // 1 GB at 64 kbps → ~140 000 s; should clamp to 3600.
    const est = estimateTranscriptionsReservation(1024 * 1024 * 1024, 'whisper-1', cfg);
    expect(est.estimatedSeconds).toBe(60 * 60);
  });

  it('reservation never under-counts a 1-byte file', () => {
    const est = estimateTranscriptionsReservation(1, 'whisper-1', cfg);
    expect(est.estimatedSeconds).toBeGreaterThanOrEqual(1);
  });

  it('actual cost commits at the reported duration', () => {
    const actual = computeTranscriptionsActualCost(120, 'whisper-1', cfg);
    // 2 min × $0.003 (v2) = $0.006 = 0.6 cents → ceil 1.
    expect(actual.actualCents).toBe(1n);
  });

  it('rounds reported duration up to the nearest second', () => {
    const a = computeTranscriptionsActualCost(60.1, 'whisper-1', cfg);
    const b = computeTranscriptionsActualCost(61, 'whisper-1', cfg);
    // Both 60.1s and 61s should ceil to 61s for billing.
    expect(a.actualCents).toBe(b.actualCents);
  });

  it('rejects unknown models', () => {
    expect(() => estimateTranscriptionsReservation(1000, 'bogus-stt', cfg)).toThrow(
      /no transcriptions rate card entry/,
    );
  });
});
