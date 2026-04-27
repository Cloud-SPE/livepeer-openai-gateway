// Re-export the engine's schema-agnostic Db handle. Shell-side queries
// build off the SQL builder + locally-imported schema tables; the
// underlying Drizzle handle is the same shape regardless of which
// package's schema it ultimately touches.
export { type Db, makeDb } from '@cloudspe/livepeer-openai-gateway-core/repo/db.js';
