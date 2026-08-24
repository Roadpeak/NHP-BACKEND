/**
 * Entry point.
 *
 * Everything the API actually does lives in `app.ts`. This file only starts
 * it — which is the whole point of the split: importing the application must
 * never bind a port or terminate the process, or it cannot be tested.
 *
 *   pnpm serve
 */
import 'dotenv/config';
import { buildApp } from './app.js';

const PORT = Number(process.env.PORT ?? 4000);

// JWT_SECRET is validated on first use, but failing at startup is far
// better than failing on a clinician's first login.
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  console.error(
    'REFUSING TO START: JWT_SECRET is missing or shorter than 32 characters.',
  );
  process.exit(1);
}

const app = await buildApp();

try {
  await app.listen({ port: PORT, host: '0.0.0.0' });
  app.log.info(`NHP API on :${PORT}/api/v1`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
