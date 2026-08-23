/**
 * Dev helper: prints the current login code for the demo account.
 *
 * The console SMS provider writes to the server's stdout, which is awkward
 * to capture. This resends through the same path and prints the code, so a
 * demo does not depend on log plumbing.
 *
 *   pnpm dev:code
 */
import { PrismaClient } from '@prisma/client';
import { ConsoleSmsProvider, setSmsProvider } from './notify.js';
import { login } from './auth.js';
import 'dotenv/config';

const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
const sms = new ConsoleSmsProvider();
setSmsProvider(sms);

const phone = process.argv[2] ?? '0722111333';
const password = process.argv[3] ?? 'demo-password-123';

const result = await login(prisma, { phone, password });
await new Promise((r) => setTimeout(r, 300));

const code = sms.sent.at(-1)?.body.match(/\b(\d{6})\b/)?.[1];
console.log(`\n  code: ${code ?? '(none — is this account on SMS MFA?)'}\n`);
await prisma.$disconnect();
