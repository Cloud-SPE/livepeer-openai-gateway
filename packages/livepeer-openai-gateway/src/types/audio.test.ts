import { describe, expect, it } from 'vitest';
import {
  SPEECH_MAX_INPUT_CHARS,
  SpeechRequestSchema,
} from '@cloudspe/livepeer-gateway-core/types/speech.js';
import {
  TranscriptionsFormFieldsSchema,
  TranscriptionsResponseFormatSchema,
  TRANSCRIPTIONS_DURATION_HEADER,
  TRANSCRIPTIONS_MAX_FILE_BYTES,
} from '@cloudspe/livepeer-gateway-core/types/transcriptions.js';

describe('SpeechRequestSchema', () => {
  it('accepts a minimal valid request', () => {
    const parsed = SpeechRequestSchema.parse({
      model: 'tts-1',
      input: 'hello world',
      voice: 'alloy',
    });
    expect(parsed.model).toBe('tts-1');
    expect(parsed.input).toBe('hello world');
  });

  it('rejects empty input', () => {
    expect(() =>
      SpeechRequestSchema.parse({ model: 'tts-1', input: '', voice: 'alloy' }),
    ).toThrow();
  });

  it('caps input at 4096 chars (matches OpenAI)', () => {
    const tooLong = 'x'.repeat(SPEECH_MAX_INPUT_CHARS + 1);
    expect(() =>
      SpeechRequestSchema.parse({ model: 'tts-1', input: tooLong, voice: 'alloy' }),
    ).toThrow();
  });

  it('rejects out-of-range speed', () => {
    expect(() =>
      SpeechRequestSchema.parse({
        model: 'tts-1',
        input: 'hi',
        voice: 'alloy',
        speed: 5.0,
      }),
    ).toThrow();
    expect(() =>
      SpeechRequestSchema.parse({
        model: 'tts-1',
        input: 'hi',
        voice: 'alloy',
        speed: 0.1,
      }),
    ).toThrow();
  });

  it('accepts each documented response_format', () => {
    for (const fmt of ['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm'] as const) {
      const parsed = SpeechRequestSchema.parse({
        model: 'tts-1',
        input: 'hi',
        voice: 'alloy',
        response_format: fmt,
      });
      expect(parsed.response_format).toBe(fmt);
    }
  });
});

describe('TranscriptionsFormFieldsSchema', () => {
  it('accepts a minimal model-only payload', () => {
    const parsed = TranscriptionsFormFieldsSchema.parse({ model: 'whisper-1' });
    expect(parsed.model).toBe('whisper-1');
  });

  it('coerces temperature from a string form value', () => {
    // Multipart fields arrive as strings; the schema must coerce.
    const parsed = TranscriptionsFormFieldsSchema.parse({
      model: 'whisper-1',
      temperature: '0.5',
    });
    expect(parsed.temperature).toBe(0.5);
  });

  it('rejects out-of-range temperature', () => {
    expect(() =>
      TranscriptionsFormFieldsSchema.parse({ model: 'whisper-1', temperature: '1.5' }),
    ).toThrow();
  });

  it('accepts each documented response_format', () => {
    for (const fmt of ['json', 'text', 'srt', 'verbose_json', 'vtt'] as const) {
      expect(TranscriptionsResponseFormatSchema.parse(fmt)).toBe(fmt);
    }
  });
});

describe('audio constants', () => {
  it('TRANSCRIPTIONS_DURATION_HEADER is the header name the worker contract obligates', () => {
    expect(TRANSCRIPTIONS_DURATION_HEADER).toBe('x-livepeer-audio-duration-seconds');
  });

  it('TRANSCRIPTIONS_MAX_FILE_BYTES matches OpenAI 25 MiB cap', () => {
    expect(TRANSCRIPTIONS_MAX_FILE_BYTES).toBe(25 * 1024 * 1024);
  });
});
