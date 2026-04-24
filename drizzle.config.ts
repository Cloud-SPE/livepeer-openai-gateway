import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/repo/schema.ts',
  out: './migrations',
  dialect: 'postgresql',
  strict: true,
  verbose: true,
});
