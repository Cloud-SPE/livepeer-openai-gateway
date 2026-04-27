import type { Logger } from '../../interfaces/index.js';

/**
 * Default `Logger` impl backed by `console.warn` / `console.error`. Uses
 * the existing `[bridge] ...` prefix convention. Operators wanting
 * structured logging (pino, OTEL, etc.) implement the Logger interface
 * directly and pass it in instead.
 */
export interface ConsoleLoggerOptions {
  /** Prefix applied to every line. Defaults to `[bridge]`. */
  prefix?: string;
}

export function createConsoleLogger(options: ConsoleLoggerOptions = {}): Logger {
  const prefix = options.prefix ?? '[bridge]';
  return {
    info(msg, ctx) {
      console.warn(`${prefix} ${msg}`, ctx ?? '');
    },
    warn(msg, ctx) {
      console.warn(`${prefix} ${msg}`, ctx ?? '');
    },
    error(msg, ctxOrErr) {
      if (ctxOrErr instanceof Error) {
        console.error(`${prefix} ${msg}`, ctxOrErr);
      } else {
        console.error(`${prefix} ${msg}`, ctxOrErr ?? '');
      }
    },
  };
}
