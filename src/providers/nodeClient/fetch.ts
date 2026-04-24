import { createParser, type EventSourceMessage } from 'eventsource-parser';
import {
  ChatCompletionResponseSchema,
  NodeHealthResponseSchema,
  NodeQuoteResponseSchema,
  type ChatCompletionCallInput,
  type ChatCompletionCallResult,
  type NodeClient,
  type NodeHealthResponse,
  type NodeQuoteResponse,
  type RawSseEvent,
  type StreamChatCompletionInput,
  type StreamChatCompletionResult,
} from '../nodeClient.js';

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
    async getQuote(url, timeoutMs) {
      const signal = AbortSignal.timeout(timeoutMs);
      const res = await fetch(trimSlash(url) + '/quote', { signal });
      if (!res.ok) {
        throw new Error(`quote HTTP ${res.status}`);
      }
      const body = await res.json();
      return NodeQuoteResponseSchema.parse(body) satisfies NodeQuoteResponse;
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
