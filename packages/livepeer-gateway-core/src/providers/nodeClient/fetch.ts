import { createParser, type EventSourceMessage } from 'eventsource-parser';
import {
  ChatCompletionResponseSchema,
  EmbeddingsResponseSchema,
  ImagesResponseSchema,
  NodeCapabilitiesResponseSchema,
  NodeHealthResponseSchema,
  NodeQuoteResponseSchema,
  NodeQuotesResponseSchema,
  type ChatCompletionCallInput,
  type ChatCompletionCallResult,
  type EmbeddingsCallInput,
  type EmbeddingsCallResult,
  type GetQuoteInput,
  type GetQuotesInput,
  type ImageGenerationCallInput,
  type ImageGenerationCallResult,
  type NodeCapabilitiesResponse,
  type NodeClient,
  type NodeHealthResponse,
  type NodeQuoteResponse,
  type NodeQuotesResponse,
  type RawSseEvent,
  type SpeechCallInput,
  type SpeechCallResult,
  type StreamChatCompletionInput,
  type StreamChatCompletionResult,
  type TranscriptionCallInput,
  type TranscriptionCallResult,
} from '../nodeClient.js';
import { TRANSCRIPTIONS_DURATION_HEADER } from '../../types/transcriptions.js';
import { wireQuoteToDomain } from './wireQuote.js';

export function createFetchNodeClient(): NodeClient {
  return {
    async getHealth(url, timeoutMs) {
      const signal = AbortSignal.timeout(timeoutMs);
      const res = await fetch(trimSlash(url) + '/health', { signal });
      if (!res.ok) {
        throw new Error(`health check HTTP ${res.status}`);
      }
      const body = await res.json();
      return NodeHealthResponseSchema.parse(body) satisfies NodeHealthResponse;
    },
    async getCapabilities(url, timeoutMs) {
      const signal = AbortSignal.timeout(timeoutMs);
      const res = await fetch(trimSlash(url) + '/capabilities', { signal });
      if (!res.ok) {
        throw new Error(`capabilities HTTP ${res.status}`);
      }
      const body = await res.json();
      return NodeCapabilitiesResponseSchema.parse(body) satisfies NodeCapabilitiesResponse;
    },
    async getQuote(input: GetQuoteInput): Promise<NodeQuoteResponse> {
      const signal = AbortSignal.timeout(input.timeoutMs);
      const qs = new URLSearchParams({
        sender: input.sender,
        capability: input.capability,
      });
      const res = await fetch(trimSlash(input.url) + '/quote?' + qs.toString(), { signal });
      if (!res.ok) {
        throw new Error(`quote HTTP ${res.status}`);
      }
      const body = await res.json();
      const wire = NodeQuoteResponseSchema.parse(body);
      return wireQuoteToDomain(wire);
    },
    async getQuotes(input: GetQuotesInput): Promise<NodeQuotesResponse> {
      const signal = AbortSignal.timeout(input.timeoutMs);
      const qs = new URLSearchParams({ sender: input.sender });
      const res = await fetch(trimSlash(input.url) + '/quotes?' + qs.toString(), { signal });
      if (!res.ok) {
        throw new Error(`quotes HTTP ${res.status}`);
      }
      const body = await res.json();
      return NodeQuotesResponseSchema.parse(body) satisfies NodeQuotesResponse;
    },

    async createChatCompletion(input: ChatCompletionCallInput): Promise<ChatCompletionCallResult> {
      const timeoutSignal = AbortSignal.timeout(input.timeoutMs);
      const signal = input.signal ? AbortSignal.any([input.signal, timeoutSignal]) : timeoutSignal;
      const res = await fetch(trimSlash(input.url) + '/v1/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'livepeer-payment': input.paymentHeaderB64,
        },
        body: JSON.stringify(input.body),
        signal,
      });
      const rawBody = await res.text();
      if (!res.ok) {
        return { status: res.status, response: null, rawBody };
      }
      const parsed = ChatCompletionResponseSchema.safeParse(JSON.parse(rawBody));
      return {
        status: res.status,
        response: parsed.success ? parsed.data : null,
        rawBody,
      };
    },

    async createEmbeddings(input: EmbeddingsCallInput): Promise<EmbeddingsCallResult> {
      const timeoutSignal = AbortSignal.timeout(input.timeoutMs);
      const signal = input.signal ? AbortSignal.any([input.signal, timeoutSignal]) : timeoutSignal;
      const res = await fetch(trimSlash(input.url) + '/v1/embeddings', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'livepeer-payment': input.paymentHeaderB64,
        },
        body: JSON.stringify(input.body),
        signal,
      });
      const rawBody = await res.text();
      if (!res.ok) {
        return { status: res.status, response: null, rawBody };
      }
      const parsed = EmbeddingsResponseSchema.safeParse(JSON.parse(rawBody));
      return {
        status: res.status,
        response: parsed.success ? parsed.data : null,
        rawBody,
      };
    },

    async createImage(input: ImageGenerationCallInput): Promise<ImageGenerationCallResult> {
      const timeoutSignal = AbortSignal.timeout(input.timeoutMs);
      const signal = input.signal ? AbortSignal.any([input.signal, timeoutSignal]) : timeoutSignal;
      const res = await fetch(trimSlash(input.url) + '/v1/images/generations', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'livepeer-payment': input.paymentHeaderB64,
        },
        body: JSON.stringify(input.body),
        signal,
      });
      const rawBody = await res.text();
      if (!res.ok) {
        return { status: res.status, response: null, rawBody };
      }
      const parsed = ImagesResponseSchema.safeParse(JSON.parse(rawBody));
      return {
        status: res.status,
        response: parsed.success ? parsed.data : null,
        rawBody,
      };
    },

    async createSpeech(input: SpeechCallInput): Promise<SpeechCallResult> {
      const timeoutSignal = AbortSignal.timeout(input.timeoutMs);
      const signal = input.signal ? AbortSignal.any([input.signal, timeoutSignal]) : timeoutSignal;
      const res = await fetch(trimSlash(input.url) + '/v1/audio/speech', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'livepeer-payment': input.paymentHeaderB64,
        },
        body: JSON.stringify(input.body),
        signal,
      });
      if (!res.ok || !res.body) {
        const rawErrorBody = await res.text().catch(() => '');
        return { status: res.status, stream: null, contentType: null, rawErrorBody };
      }
      return {
        status: res.status,
        stream: res.body,
        contentType: res.headers.get('content-type'),
        rawErrorBody: null,
      };
    },

    async createTranscription(input: TranscriptionCallInput): Promise<TranscriptionCallResult> {
      const timeoutSignal = AbortSignal.timeout(input.timeoutMs);
      const signal = input.signal ? AbortSignal.any([input.signal, timeoutSignal]) : timeoutSignal;
      const res = await fetch(trimSlash(input.url) + '/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          'content-type': input.contentType,
          'livepeer-payment': input.paymentHeaderB64,
        },
        body: input.body,
        // Required by Node's fetch when streaming a body via Web ReadableStream.
        // Cast: Node's RequestInit accepts the option but DOM lib types omit it.
        duplex: 'half',
        signal,
      } as RequestInit & { duplex: 'half' });
      const bodyText = await res.text();
      if (!res.ok) {
        return {
          status: res.status,
          contentType: res.headers.get('content-type'),
          bodyText: '',
          reportedDurationSeconds: null,
          rawErrorBody: bodyText,
        };
      }
      const headerVal = res.headers.get(TRANSCRIPTIONS_DURATION_HEADER);
      let reported: number | null = null;
      if (headerVal !== null) {
        const n = Number(headerVal);
        if (Number.isFinite(n) && n > 0) reported = n;
      }
      return {
        status: res.status,
        contentType: res.headers.get('content-type'),
        bodyText,
        reportedDurationSeconds: reported,
        rawErrorBody: null,
      };
    },

    async streamChatCompletion(
      input: StreamChatCompletionInput,
    ): Promise<StreamChatCompletionResult> {
      const timeoutSignal = AbortSignal.timeout(input.timeoutMs);
      const signal = AbortSignal.any([input.signal, timeoutSignal]);
      const res = await fetch(trimSlash(input.url) + '/v1/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          'livepeer-payment': input.paymentHeaderB64,
        },
        body: JSON.stringify(input.body),
        signal,
      });
      if (!res.ok || !res.body) {
        const rawErrorBody = await res.text().catch(() => '');
        return { status: res.status, events: null, rawErrorBody };
      }
      return {
        status: res.status,
        events: streamSseEvents(res.body, input.signal),
        rawErrorBody: null,
      };
    },
  };
}

async function* streamSseEvents(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncIterable<RawSseEvent> {
  const decoder = new TextDecoder();
  const queue: RawSseEvent[] = [];
  const parser = createParser({
    onEvent(ev: EventSourceMessage) {
      queue.push({ data: ev.data });
    },
  });
  const reader = body.getReader();
  const onAbort = (): void => {
    reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', onAbort);
  try {
    while (true) {
      if (signal.aborted) break;
      let value: Uint8Array | undefined;
      let done = false;
      try {
        ({ value, done } = await reader.read());
      } catch {
        break;
      }
      if (done) break;
      if (value) parser.feed(decoder.decode(value, { stream: true }));
      while (queue.length > 0) {
        yield queue.shift()!;
      }
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    try {
      reader.releaseLock();
    } catch {
      /* may already be released after cancel() */
    }
  }
}

function trimSlash(u: string): string {
  return u.endsWith('/') ? u.slice(0, -1) : u;
}
