import {
  ChatCompletionResponseSchema,
  NodeHealthResponseSchema,
  NodeQuoteResponseSchema,
  type ChatCompletionCallInput,
  type ChatCompletionCallResult,
  type NodeClient,
  type NodeHealthResponse,
  type NodeQuoteResponse,
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
  };
}

function trimSlash(u: string): string {
  return u.endsWith('/') ? u.slice(0, -1) : u;
}
