/**
 * Test-only hooks.
 *
 * This module exists so contract tests can reach an AUTHENTICATED response.
 * That makes it, by construction, the most dangerous file in the codebase:
 * anything here that survives to production is an authentication bypass.
 *
 * So it is built to fail closed, and to be several separate accidents away
 * from being reachable rather than one:
 *
 *   1. It is NOT an MFA bypass. There is no path here that skips the second
 *      factor, mints a token, or accepts a wrong code. It only reveals a
 *      code the ConsoleSmsProvider already holds in memory — the same code
 *      already printed to the development console, where anyone running the
 *      server can read it. It grants no capability that `pnpm serve` did
 *      not already grant to whoever can see its stdout.
 *
 *   2. It refuses when NODE_ENV is production, unconditionally, before
 *      looking at anything else.
 *
 *   3. It requires TEST_HOOK_SECRET to be set AND at least 32 characters
 *      AND presented on the request. An unset secret disables the hook; it
 *      does not default to open.
 *
 *   4. It refuses unless the live SMS provider is the console one. If a
 *      real Africa's Talking provider is configured, there is nothing in
 *      memory to reveal and the hook refuses rather than reaching for the
 *      account another way.
 *
 * `assertTestHooksEnabled` is exported separately from the reader so the
 * refusals can be tested directly, without a route in the way.
 */
import { timingSafeEqual } from 'node:crypto';
import { ConsoleSmsProvider, resolveSmsProvider } from './notify.js';
import { AuthError } from './auth.js';

/** Refuses unless every condition for the hook to exist is met. */
export function assertTestHooksEnabled(presentedSecret: string | undefined): void {
  // Production first, and on its own. Everything below is a detail; this is
  // the line that must never be reached past.
  if (process.env.NODE_ENV === 'production') {
    throw new AuthError('Not found', 'NOT_FOUND', 404);
  }

  const secret = process.env.TEST_HOOK_SECRET;

  // An unset secret disables the hook. It must never mean "no check".
  if (!secret) {
    throw new AuthError('Not found', 'NOT_FOUND', 404);
  }

  // A short secret is a guessable one, and this endpoint hands out a live
  // sign-in code. Refuse rather than run weakly configured.
  if (secret.length < 32) {
    throw new AuthError(
      'TEST_HOOK_SECRET is shorter than 32 characters; the test hooks refuse to run.',
      'TEST_HOOK_MISCONFIGURED',
      500,
    );
  }

  if (!presentedSecret) {
    throw new AuthError('Not found', 'NOT_FOUND', 404);
  }

  // Constant-time, and length-checked first because timingSafeEqual throws
  // on a length mismatch — which would itself be an oracle.
  const a = Buffer.from(presentedSecret);
  const b = Buffer.from(secret);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new AuthError('Not found', 'NOT_FOUND', 404);
  }
}

/**
 * Returns the most recent sign-in code sent to a number.
 *
 * Reads it out of the ConsoleSmsProvider's in-memory record — the same
 * message it already printed to stdout. Nothing is decrypted, no account is
 * looked up, and no session is issued.
 */
export function readLastSmsCode(phone: string): string {
  const provider = resolveSmsProvider();

  if (!(provider instanceof ConsoleSmsProvider)) {
    // A real provider means real SMS to a real handset. There is nothing in
    // memory to read, and reaching for the code another way would be the
    // bypass this module is written to avoid.
    throw new AuthError(
      'The configured SMS provider is not the console one; there is no code to reveal.',
      'TEST_HOOK_UNAVAILABLE',
      409,
    );
  }

  // `sent` holds every message; find the newest to this number in either
  // the local or E.164 form the provider may have recorded.
  const normalised = phone.replace(/^0/, '+254');
  const message = [...provider.sent]
    .reverse()
    .find((m) => m.to === phone || m.to === normalised);

  if (!message) {
    throw new AuthError('No code has been sent to that number', 'NO_CODE_SENT', 404);
  }

  const code = message.body.match(/\b(\d{6})\b/)?.[1];
  if (!code) {
    throw new AuthError('No code found in the last message', 'NO_CODE_SENT', 404);
  }

  return code;
}
