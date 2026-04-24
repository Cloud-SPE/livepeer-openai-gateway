import {
  NodeHealthResponseSchema,
  NodeQuoteResponseSchema,
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
  };
}

function trimSlash(u: string): string {
  return u.endsWith('/') ? u.slice(0, -1) : u;
}
