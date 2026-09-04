/**
 * THE TEST HOOKS — refusals.
 *
 * `testhooks.ts` is the most dangerous file in this repo: it exists to help
 * a contract test reach an authenticated response, and anything in it that
 * survives to production is an authentication bypass.
 *
 * So its refusals get more test coverage than the feature does. Each layer
 * is asserted independently, because the whole design is that no single
 * mistake is enough to expose it: production must be off, the secret must be
 * set, long enough, and correct, and the SMS provider must be the in-memory
 * console one.
 *
 * The most important test in this file is the last one — that the route is
 * not merely refused in production but absent from the router entirely.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import 'dotenv/config';

import { buildApp } from '../src/app.js';
import { assertTestHooksEnabled, readLastSmsCode } from '../src/testhooks.js';
import {
  ConsoleSmsProvider,
  setSmsProvider,
  AfricasTalkingProvider,
  devVisibleOtp,
  resolveSmsProvider,
} from '../src/notify.js';

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
});

const GOOD_SECRET = 'a'.repeat(32);
const sms = new ConsoleSmsProvider();

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env.NODE_ENV = 'test';
  process.env.TEST_HOOK_SECRET = GOOD_SECRET;
  sms.clear();
  setSmsProvider(sms);
});

afterEach(() => {
  process.env.NODE_ENV = originalEnv.NODE_ENV;
  process.env.TEST_HOOK_SECRET = originalEnv.TEST_HOOK_SECRET;
});

afterAll(async () => {
  setSmsProvider(null);
  await prisma.$disconnect();
});

/** Records a message the way the console provider would. */
async function pretendSent(to: string, body: string) {
  await sms.send({ to, body, purpose: 'LOGIN_MFA' } as never);
}

// =====================================================================

describe('the refusals', () => {
  it('THE PRODUCTION GUARD — refuses outright when NODE_ENV is production', () => {
    process.env.NODE_ENV = 'production';

    // Checked first and on its own, so no later condition can accidentally
    // satisfy it. A correct secret must not help here.
    expect(() => assertTestHooksEnabled(GOOD_SECRET)).toThrow(/not found/i);
  });

  it('refuses in production even when everything else is configured perfectly', () => {
    process.env.NODE_ENV = 'production';
    process.env.TEST_HOOK_SECRET = GOOD_SECRET;
    setSmsProvider(sms);

    expect(() => assertTestHooksEnabled(GOOD_SECRET)).toThrow();
  });

  it('is disabled when no secret is set — absence never means "no check"', () => {
    delete process.env.TEST_HOOK_SECRET;
    // The classic failure: a guard that treats an unset variable as
    // permission because the comparison of two undefineds succeeds.
    expect(() => assertTestHooksEnabled(undefined)).toThrow(/not found/i);
    expect(() => assertTestHooksEnabled('')).toThrow(/not found/i);
  });

  it('refuses to run with a short secret rather than running weakly', () => {
    process.env.TEST_HOOK_SECRET = 'short';
    expect(() => assertTestHooksEnabled('short')).toThrow(/32 characters/i);
  });

  it('refuses when no secret is presented', () => {
    expect(() => assertTestHooksEnabled(undefined)).toThrow(/not found/i);
  });

  it('refuses a wrong secret of the same length', () => {
    expect(() => assertTestHooksEnabled('b'.repeat(32))).toThrow(/not found/i);
  });

  it('refuses a wrong secret of a different length without throwing internally', () => {
    // timingSafeEqual throws on a length mismatch; an unhandled throw here
    // would surface as a 500 and distinguish "wrong length" from "wrong
    // value", which is itself an oracle.
    expect(() => assertTestHooksEnabled('c'.repeat(8))).toThrow(/not found/i);
    expect(() => assertTestHooksEnabled('d'.repeat(64))).toThrow(/not found/i);
  });

  it('accepts only the exact secret', () => {
    expect(() => assertTestHooksEnabled(GOOD_SECRET)).not.toThrow();
  });

  it('answers every refusal as 404, not 403', () => {
    // A 403 confirms the endpoint exists. 404 says nothing, which is what a
    // route that should not be discoverable ought to say.
    delete process.env.TEST_HOOK_SECRET;
    const err = (() => {
      try {
        assertTestHooksEnabled('anything');
      } catch (e) {
        return e as { status: number };
      }
    })();
    expect(err?.status).toBe(404);
  });
});

describe('reading the code', () => {
  it('returns the most recent code sent to a number', async () => {
    await pretendSent('+254733222555', '111111 is your NHP sign-in code.');
    await pretendSent('+254733222555', '222222 is your NHP sign-in code.');

    expect(readLastSmsCode('+254733222555')).toBe('222222');
  });

  it('matches a local number against the E.164 form the provider recorded', async () => {
    await pretendSent('+254733222555', '333333 is your NHP sign-in code.');
    // The caller has the number as the user typed it; the provider stored
    // the normalised one.
    expect(readLastSmsCode('0733222555')).toBe('333333');
  });

  it('does not return another number\'s code', async () => {
    await pretendSent('+254700000001', '444444 is your NHP sign-in code.');
    expect(() => readLastSmsCode('+254700000002')).toThrow(/no code/i);
  });

  it('refuses when a real SMS provider is configured', () => {
    setSmsProvider(new AfricasTalkingProvider('u', 'k'));

    // With a real provider the code went to a real handset and is not in
    // memory. Reaching for it another way — decrypting the account, minting
    // a session — is exactly the bypass this module avoids being.
    expect(() => readLastSmsCode('+254733222555')).toThrow(/not the console one/i);
  });

  it('refuses when nothing has been sent', () => {
    expect(() => readLastSmsCode('+254733222555')).toThrow(/no code/i);
  });

  it('grants nothing the server console did not already show', async () => {
    await pretendSent('+254733222555', '555555 is your NHP sign-in code.');

    // The whole safety argument: this reveals a string already printed to
    // stdout by the same process. Anyone who can call this hook in a dev
    // environment could already read the code from the terminal.
    const printed = sms.sent.at(-1)!.body;
    expect(printed).toContain(readLastSmsCode('+254733222555'));
  });
});

describe('the route', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close();
  });

  it('is reachable with the secret in a development environment', async () => {
    app = await buildApp(prisma);
    await app.ready();
    await pretendSent('+254733222555', '654321 is your NHP sign-in code.');

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/test-hooks/last-sms-code?phone=%2B254733222555',
      headers: { 'x-test-hook-secret': GOOD_SECRET },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().code).toBe('654321');
  });

  it('answers 404 without the secret', async () => {
    app = await buildApp(prisma);
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/test-hooks/last-sms-code?phone=%2B254733222555',
    });

    expect(res.statusCode).toBe(404);
  });

  it('THE ROUTE DOES NOT EXIST IN PRODUCTION', async () => {
    process.env.NODE_ENV = 'production';
    const prodApp = await buildApp(prisma);
    await prodApp.ready();

    const res = await prodApp.inject({
      method: 'GET',
      url: '/api/v1/test-hooks/last-sms-code?phone=%2B254733222555',
      headers: { 'x-test-hook-secret': GOOD_SECRET },
    });

    // Not "refused" — absent. Fastify's own 404 handler answers, because
    // the route was never registered. A misconfigured secret in production
    // therefore cannot expose an endpoint that is not in the router.
    expect(res.statusCode).toBe(404);
    expect(prodApp.hasRoute({ method: 'GET', url: '/api/v1/test-hooks/last-sms-code' })).toBe(
      false,
    );

    await prodApp.close();
  });

  it('still serves the real routes in production', async () => {
    process.env.NODE_ENV = 'production';
    const prodApp = await buildApp(prisma);
    await prodApp.ready();

    // Sanity: the conditional registration must not have removed anything
    // else along with the hook.
    const res = await prodApp.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);

    await prodApp.close();
  });
});

/**
 * THE OTP SHOWN ON SCREEN.
 *
 * A stopgap for a deployment with no SMS gateway: the sign-in code is
 * returned in the login response and rendered above the code field, so a
 * clinician can complete the second factor while the gateway is still being
 * provisioned.
 *
 * It is not an authentication bypass — the code still has to be entered and
 * verified, and it is the same code the console provider already prints to
 * stdout. What it changes is who can read it.
 *
 * The failure that matters is it surviving to production unnoticed, so it
 * is guarded three separate ways and every one is checked here.
 */
describe('the on-screen sign-in code', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env.NODE_ENV = saved.NODE_ENV;
    process.env.NHP_SHOW_OTP = saved.NHP_SHOW_OTP;
  });

  it('is returned when explicitly switched on outside production', () => {
    process.env.NODE_ENV = 'development';
    process.env.NHP_SHOW_OTP = '1';
    expect(devVisibleOtp('123456')).toBe('123456');
  });

  it('NEVER appears in production, even when switched on', () => {
    process.env.NODE_ENV = 'production';
    process.env.NHP_SHOW_OTP = '1';
    expect(devVisibleOtp('123456')).toBeUndefined();
  });

  it('does not default on', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.NHP_SHOW_OTP;
    // A developer running the API locally must not silently get a live
    // sign-in code echoed into every login response.
    expect(devVisibleOtp('123456')).toBeUndefined();
  });

  it('treats any value other than 1 as off', () => {
    process.env.NODE_ENV = 'development';
    for (const v of ['0', 'true', 'yes', '']) {
      process.env.NHP_SHOW_OTP = v;
      expect(devVisibleOtp('123456')).toBeUndefined();
    }
  });

  it('SWITCHES ITSELF OFF once a real SMS provider is configured', () => {
    process.env.NODE_ENV = 'development';
    process.env.NHP_SHOW_OTP = '1';
    const previous = resolveSmsProvider();
    // A real gateway means the code reached a real handset; echoing it into
    // an HTTP response then is a disclosure, not a convenience. This is the
    // guard that means nobody has to remember to turn the flag off.
    setSmsProvider({
      name: 'fake-gateway',
      send: async () => {},
    } as unknown as Parameters<typeof setSmsProvider>[0]);
    try {
      expect(devVisibleOtp('123456')).toBeUndefined();
    } finally {
      setSmsProvider(previous);
    }
  });
});
