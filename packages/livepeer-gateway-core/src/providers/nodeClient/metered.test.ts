/* eslint-disable @typescript-eslint/no-unused-vars -- the fake NodeClient
   below intentionally accepts every interface method's parameters by name so
   it satisfies the structural type, even when the body ignores them. */
import { describe, expect, it } from 'vitest';
import { withMetrics } from './metered.js';
import { CounterRecorder } from '../metrics/testhelpers.js';
import type { RequestOutcome } from '../metrics/recorder.js';
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

interface FakeOptions {
  chatStatus?: number;
  embeddingsThrows?: boolean;
  healthThrows?: boolean;
}

function fakeClient(opts: FakeOptions = {}): NodeClient {
  return {
    async getHealth(_url: string, _timeoutMs: number): Promise<NodeHealthResponse> {
      if (opts.healthThrows) throw new Error('connect refused');
      return { status: 'ok', protocol_version: 1, max_concurrent: 4, inflight: 0 };
    },
    async getCapabilities(
      _url: string,
      _timeoutMs: number,
    ): Promise<NodeCapabilitiesResponse> {
      return { protocol_version: 1, capabilities: [] };
    },
    async getQuote(_input: GetQuoteInput): Promise<NodeQuoteResponse> {
      throw new Error('not used in this test');
    },
    async getQuotes(_input: GetQuotesInput): Promise<NodeQuotesResponse> {
      return { quotes: [] };
    },
    async createChatCompletion(
      _input: ChatCompletionCallInput,
    ): Promise<ChatCompletionCallResult> {
      return { status: opts.chatStatus ?? 200, response: null, rawBody: '' };
    },
    async streamChatCompletion(
      _input: StreamChatCompletionInput,
    ): Promise<StreamChatCompletionResult> {
      return { status: 200, events: null, rawErrorBody: null };
    },
    async createEmbeddings(_input: EmbeddingsCallInput): Promise<EmbeddingsCallResult> {
      if (opts.embeddingsThrows) throw new Error('timeout');
      return { status: 200, response: null, rawBody: '' };
    },
    async createImage(_input: ImageGenerationCallInput): Promise<ImageGenerationCallResult> {
      return { status: 200, response: null, rawBody: '' };
    },
    async createSpeech(_input: SpeechCallInput): Promise<SpeechCallResult> {
      return { status: 200, stream: null, contentType: null, rawErrorBody: null };
    },
    async createTranscription(
      _input: TranscriptionCallInput,
    ): Promise<TranscriptionCallResult> {
      return {
        status: 200,
        contentType: null,
        bodyText: '',
        reportedDurationSeconds: null,
        rawErrorBody: null,
      };
    },
  };
}

const baseChatInput: ChatCompletionCallInput = {
  url: 'http://node-1.local',
  body: { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
  paymentHeaderB64: 'YQ==',
  timeoutMs: 1_000,
};

/**
 * Wraps a CounterRecorder to also capture the `(nodeId, outcome)` arguments
 * each `incNodeRequest` call sees. CounterRecorder's own field-level snapshot
 * (`lastRequestOutcome`) only fires for `incRequest` (the inbound-request
 * path), so the node-request decorator tests need this lightweight spy.
 */
function spyNodeRequest(rec: CounterRecorder): {
  rec: CounterRecorder;
  lastNodeId: () => string | null;
  lastOutcome: () => RequestOutcome | null;
} {
  let lastNodeId: string | null = null;
  let lastOutcome: RequestOutcome | null = null;
  const original = rec.incNodeRequest.bind(rec);
  rec.incNodeRequest = (nodeId: string, outcome: RequestOutcome) => {
    lastNodeId = nodeId;
    lastOutcome = outcome;
    original(nodeId, outcome);
  };
  return {
    rec,
    lastNodeId: () => lastNodeId,
    lastOutcome: () => lastOutcome,
  };
}

describe('nodeClient withMetrics', () => {
  it('emits 2xx counter+histogram on a 200 response', async () => {
    const { rec, lastOutcome } = spyNodeRequest(new CounterRecorder());
    const client = withMetrics(fakeClient({ chatStatus: 200 }), rec);

    await client.createChatCompletion(baseChatInput);

    expect(rec.nodeRequests).toBe(1);
    expect(rec.nodeRequestObservations).toBe(1);
    expect(lastOutcome()).toBe('2xx');
  });

  it('buckets 4xx responses into the 4xx outcome', async () => {
    const { rec, lastOutcome } = spyNodeRequest(new CounterRecorder());
    const client = withMetrics(fakeClient({ chatStatus: 402 }), rec);

    await client.createChatCompletion(baseChatInput);

    expect(lastOutcome()).toBe('4xx');
  });

  it('buckets 5xx responses into the 5xx outcome', async () => {
    const { rec, lastOutcome } = spyNodeRequest(new CounterRecorder());
    const client = withMetrics(fakeClient({ chatStatus: 503 }), rec);

    await client.createChatCompletion(baseChatInput);

    expect(lastOutcome()).toBe('5xx');
  });

  it('treats thrown errors (timeout/connect-fail) as 5xx', async () => {
    const { rec, lastOutcome } = spyNodeRequest(new CounterRecorder());
    const client = withMetrics(fakeClient({ embeddingsThrows: true }), rec);

    await expect(
      client.createEmbeddings({
        url: 'http://node-1.local',
        body: { model: 'm', input: 'x' },
        paymentHeaderB64: 'YQ==',
        timeoutMs: 1,
      }),
    ).rejects.toThrow('timeout');

    expect(rec.nodeRequests).toBe(1);
    expect(rec.nodeRequestObservations).toBe(1);
    expect(lastOutcome()).toBe('5xx');
  });

  it('passes nodeId through resolveNodeId callback (visible in label)', async () => {
    const { rec, lastNodeId } = spyNodeRequest(new CounterRecorder());
    const client = withMetrics(
      fakeClient(),
      rec,
      (url) => (url === 'http://node-1.local' ? 'node-alpha' : undefined),
    );

    await client.createChatCompletion(baseChatInput);
    expect(lastNodeId()).toBe('node-alpha');
  });

  it('falls back to LABEL_UNSET when no resolver is provided', async () => {
    const { rec, lastNodeId } = spyNodeRequest(new CounterRecorder());
    const client = withMetrics(fakeClient(), rec);

    await client.createChatCompletion(baseChatInput);
    expect(lastNodeId()).toBe('_unset_');
  });

  it('throwing helpers (getHealth) emit 5xx on failure, 2xx on success', async () => {
    const ok = spyNodeRequest(new CounterRecorder());
    const okClient = withMetrics(fakeClient(), ok.rec);
    await okClient.getHealth('http://node-1.local', 1_000);
    expect(ok.lastOutcome()).toBe('2xx');

    const fail = spyNodeRequest(new CounterRecorder());
    const failClient = withMetrics(fakeClient({ healthThrows: true }), fail.rec);
    await expect(failClient.getHealth('http://node-1.local', 1_000)).rejects.toThrow(
      'connect refused',
    );
    expect(fail.lastOutcome()).toBe('5xx');
  });
});
