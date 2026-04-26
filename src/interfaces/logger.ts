/**
 * Minimal operator-overridable logger. The engine ships a console-backed
 * default. Operators with structured logging stacks (pino, winston, OTEL)
 * implement this and pass it in.
 *
 * `error` accepts either a context object or an Error to keep call sites
 * ergonomic without forcing a wrapper at every site.
 */
export interface Logger {
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown> | Error): void;
}
