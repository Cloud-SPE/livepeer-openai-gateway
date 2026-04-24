import type { Pool } from 'pg';

export interface Database {
  readonly pool: Pool;
  end(): Promise<void>;
}

export interface DatabaseConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
  readonly max?: number;
  readonly ssl?: boolean;
}
