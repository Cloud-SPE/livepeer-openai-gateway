export interface RedisConfig {
  readonly host: string;
  readonly port: number;
  readonly password?: string;
  readonly db?: number;
}

export interface RedisClient {
  eval(script: string, keys: string[], args: (string | number)[]): Promise<unknown>;
  incr(key: string): Promise<number>;
  decr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  ping(): Promise<string>;
  close(): Promise<void>;
}
