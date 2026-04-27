// withMetrics wraps a NodeClient so each upstream HTTP request emits a
// counter+histogram pair through the Recorder. Mirrors the
// service-registry `WithMetrics` pattern.
//
// NodeClient methods take a `url`, not a `nodeId`. The counter/histogram
// are labeled by nodeId, so the decorator accepts an optional
// `resolveNodeId(url)` callback. The composition root supplies a
// NodeIndex-backed lookup keyed by base URL. When the callback is
// absent or returns undefined, the emission falls back to
// LABEL_UNSET — the prom impl already tolerates that label value.
//
// outcome bucketing matches the spec: `2xx` on a successful response (status
// 200–299), `4xx` on 400-class, `5xx` on 500-class, `4xx` for fetch failures
// (timeout / connect-fail / abort) — those map to the same upstream-request
// "client saw the call fail before a response" bucket. This file is dormant
// until Pass B wires it into the composition root.

import type {
  ChatCompletionCallInput,
  ChatCompletionCallResult,
  EmbeddingsCallInput,
  EmbeddingsCallResult,
  GetQuoteInput,
  GetQuotesInput,
  ImageGenerationCallInput,
  ImageGenerationCallResult,
  NodeCapabilitiesResponse,
  NodeClient,
  NodeHealthResponse,
  NodeQuoteResponse,
  NodeQuotesResponse,
  SpeechCallInput,
  SpeechCallResult,
  StreamChatCompletionInput,
  StreamChatCompletionResult,
  TranscriptionCallInput,
  TranscriptionCallResult,
} from '../nodeClient.js';
import {
  LABEL_UNSET,
  OUTCOME_2XX,
  OUTCOME_4XX,
  OUTCOME_5XX,
  type Recorder,
  type RequestOutcome,
} from '../metrics/recorder.js';

/** Optional URL-to-nodeId resolver. The composition root wires a NodeIndex-backed lookup. */
export type ResolveNodeId = (url: string) => string | undefined;

function bucket(status: number): RequestOutcome {
  if (status >= 200 && status < 300) return OUTCOME_2XX;
  if (status >= 400 && status < 500) return OUTCOME_4XX;
  return OUTCOME_5XX;
}

export function withMetrics(
  client: NodeClient,
  recorder: Recorder,
  resolveNodeId?: ResolveNodeId,
): NodeClient {
  function nodeIdFor(url: string): string {
    return resolveNodeId?.(url) ?? LABEL_UNSET;
  }

  async function measureStatus<T>(
    url: string,
    fn: () => Promise<T>,
    statusOf: (result: T) => number,
  ): Promise<T> {
    const start = performance.now();
    const nodeId = nodeIdFor(url);
    try {
      const result = await fn();
      const durationSec = (performance.now() - start) / 1000;
      const outcome = bucket(statusOf(result));
      recorder.incNodeRequest(nodeId, outcome);
      recorder.observeNodeRequest(nodeId, outcome, durationSec);
      return result;
    } catch (err) {
      // Treat connect-fail / timeout / abort as the upstream-failure bucket.
      // 5xx is the closest match: the bridge could not get a response.
      const durationSec = (performance.now() - start) / 1000;
      recorder.incNodeRequest(nodeId, OUTCOME_5XX);
      recorder.observeNodeRequest(nodeId, OUTCOME_5XX, durationSec);
      throw err;
    }
  }

  // For getHealth/getCapabilities/getQuote/getQuotes the underlying client
  // throws on non-2xx, so success ⇒ 2xx and any throw ⇒ 5xx (handled above).
  async function measureThrowing<T>(url: string, fn: () => Promise<T>): Promise<T> {
    const start = performance.now();
    const nodeId = nodeIdFor(url);
    try {
      const result = await fn();
      const durationSec = (performance.now() - start) / 1000;
      recorder.incNodeRequest(nodeId, OUTCOME_2XX);
      recorder.observeNodeRequest(nodeId, OUTCOME_2XX, durationSec);
      return result;
    } catch (err) {
      const durationSec = (performance.now() - start) / 1000;
      recorder.incNodeRequest(nodeId, OUTCOME_5XX);
      recorder.observeNodeRequest(nodeId, OUTCOME_5XX, durationSec);
      throw err;
    }
  }

  return {
    async getHealth(url: string, timeoutMs: number): Promise<NodeHealthResponse> {
      return measureThrowing(url, () => client.getHealth(url, timeoutMs));
    },
    async getCapabilities(url: string, timeoutMs: number): Promise<NodeCapabilitiesResponse> {
      return measureThrowing(url, () => client.getCapabilities(url, timeoutMs));
    },
    async getQuote(input: GetQuoteInput): Promise<NodeQuoteResponse> {
      return measureThrowing(input.url, () => client.getQuote(input));
    },
    async getQuotes(input: GetQuotesInput): Promise<NodeQuotesResponse> {
      return measureThrowing(input.url, () => client.getQuotes(input));
    },
    async createChatCompletion(
      input: ChatCompletionCallInput,
    ): Promise<ChatCompletionCallResult> {
      return measureStatus(
        input.url,
        () => client.createChatCompletion(input),
        (r) => r.status,
      );
    },
    async streamChatCompletion(
      input: StreamChatCompletionInput,
    ): Promise<StreamChatCompletionResult> {
      return measureStatus(
        input.url,
        () => client.streamChatCompletion(input),
        (r) => r.status,
      );
    },
    async createEmbeddings(input: EmbeddingsCallInput): Promise<EmbeddingsCallResult> {
      return measureStatus(input.url, () => client.createEmbeddings(input), (r) => r.status);
    },
    async createImage(input: ImageGenerationCallInput): Promise<ImageGenerationCallResult> {
      return measureStatus(input.url, () => client.createImage(input), (r) => r.status);
    },
    async createSpeech(input: SpeechCallInput): Promise<SpeechCallResult> {
      return measureStatus(input.url, () => client.createSpeech(input), (r) => r.status);
    },
    async createTranscription(
      input: TranscriptionCallInput,
    ): Promise<TranscriptionCallResult> {
      return measureStatus(
        input.url,
        () => client.createTranscription(input),
        (r) => r.status,
      );
    },
  };
}
