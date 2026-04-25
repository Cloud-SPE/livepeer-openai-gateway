import type { TokenizerProvider } from '../../providers/tokenizer.js';
import type { MetricsSink } from '../../providers/metrics.js';
import type { Recorder } from '../../providers/metrics/recorder.js';
import type { Message } from '../../types/openai.js';
import { resolveEncodingForModel } from '../../config/tokenizer.js';

export interface TokenAuditService {
  countPromptTokens(model: string, messages: readonly Message[]): number | null;
  countCompletionText(model: string, text: string): number | null;
  emitDrift(input: EmitDriftInput): void;
}

export interface EmitDriftInput {
  model: string;
  nodeId: string;
  localPromptTokens: number;
  reportedPromptTokens: number;
  localCompletionTokens: number;
  reportedCompletionTokens: number;
}

export interface TokenAuditDeps {
  tokenizer: TokenizerProvider;
  metrics: MetricsSink;
  /**
   * Optional new-style Recorder. When present, emitDrift ALSO emits the
   * prefixed names (`livepeer_bridge_token_*`) alongside the legacy
   * MetricsSink emissions. Phase 2 deletes the legacy emissions and the
   * `metrics` MetricsSink dep — see `tokens-drift-unprefixed-names-removal`
   * in the tech-debt tracker.
   */
  recorder?: Recorder;
}

export function createTokenAuditService(deps: TokenAuditDeps): TokenAuditService {
  return {
    countPromptTokens(model, messages) {
      const encoding = resolveEncodingForModel(model);
      if (!encoding) return null;
      let total = 0;
      for (const m of messages) {
        // OpenAI chat messages carry per-message overhead tokens beyond the
        // raw content (role, delimiters). At v1 we observe content tokens
        // only; overhead is consistent within a model and doesn't affect
        // drift comparison on the same basis.
        total += deps.tokenizer.count(encoding, m.content);
      }
      return total;
    },
    countCompletionText(model, text) {
      const encoding = resolveEncodingForModel(model);
      if (!encoding) return null;
      return deps.tokenizer.count(encoding, text);
    },
    emitDrift(input) {
      emitOne(deps.metrics, input, 'prompt', input.localPromptTokens, input.reportedPromptTokens);
      emitOne(
        deps.metrics,
        input,
        'completion',
        input.localCompletionTokens,
        input.reportedCompletionTokens,
      );
      if (deps.recorder) {
        emitOnePrefixed(
          deps.recorder,
          input,
          'prompt',
          input.localPromptTokens,
          input.reportedPromptTokens,
        );
        emitOnePrefixed(
          deps.recorder,
          input,
          'completion',
          input.localCompletionTokens,
          input.reportedCompletionTokens,
        );
      }
    },
  };
}

export function computeDriftPercent(local: number, reported: number): number {
  if (local === 0 && reported === 0) return 0;
  if (local === 0) return Number.POSITIVE_INFINITY;
  return ((reported - local) / local) * 100;
}

function emitOne(
  metrics: MetricsSink,
  input: EmitDriftInput,
  direction: 'prompt' | 'completion',
  local: number,
  reported: number,
): void {
  metrics.histogram(
    'tokens_drift_percent',
    { node_id: input.nodeId, model: input.model, direction },
    computeDriftPercent(local, reported),
  );
  metrics.gauge(
    'tokens_local_count',
    { node_id: input.nodeId, model: input.model, direction },
    local,
  );
  metrics.gauge(
    'tokens_reported_count',
    { node_id: input.nodeId, model: input.model, direction },
    reported,
  );
}

function emitOnePrefixed(
  recorder: Recorder,
  input: EmitDriftInput,
  direction: 'prompt' | 'completion',
  local: number,
  reported: number,
): void {
  recorder.observeTokenDriftPercent(
    input.nodeId,
    input.model,
    direction,
    computeDriftPercent(local, reported),
  );
  recorder.addTokenCountLocal(input.nodeId, input.model, direction, local);
  recorder.addTokenCountReported(input.nodeId, input.model, direction, reported);
}
