import type { FastifyInstance } from 'fastify';

export interface HttpServer {
  readonly app: FastifyInstance;
  listen(opts: { host: string; port: number }): Promise<string>;
  close(): Promise<void>;
}

export interface HttpServerConfig {
  readonly logger?: boolean;
  readonly bodyLimit?: number;
}
