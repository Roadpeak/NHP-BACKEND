/**
 * Authentication.
 *
 * Replaces the X-Practitioner-Id header shortcut. What matters here:
 *
 *   - Argon2id for passwords. Not bcrypt, not PBKDF2 — this is a national
 *     health record and the password file is the highest-value target in it.
 *   - Short access tokens, rotating refresh tokens. A stolen refresh token
 *     is usable at most once, and its reuse reveals the theft.
 *   - MFA enforced SERVER-side for clinical and Ministry roles. A client
 *     that "forgets" to prompt must not reach patient data.
 *   - Login failures are indistinguishable. "No such account" and "wrong
 *     password" return the same thing, or the endpoint becomes a directory
 *     of who is registered.
 */
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { TOTP, Secret } from 'otpauth';
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { PrismaClient, type Prisma } from '@prisma/client';
import { blindIndex, encryptField, decryptField, normalisePhone } from './crypto.js';

export type Db = PrismaClient | Prisma.TransactionClient;

export class AuthError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 401,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

/** Short, because a leaked access token cannot be revoked before it expires. */
export const ACCESS_TOKEN_MINUTES = 15;
export const REFRESH_TOKEN_DAYS = 30;
export const OTP_MINUTES = 10;
export const MAX_OTP_ATTEMPTS = 5;
/** Lock after this many failed logins, to blunt credential stuffing. */
export const MAX_FAILED_LOGINS = 5;
export const LOCKOUT_MINUTES = 15;

function secret(): Uint8Array {
  const value = process.env.JWT_SECRET;
  if (!value || value.length < 32) {
    throw new AuthError(
      'JWT_SECRET is missing or shorter than 32 characters. In production ' +
        'this belongs in a KMS.',
      'MISCONFIGURED',
      500,
    );
  }
  return new TextEncoder().encode(value);
}

/** Argon2id at parameters suited to a server, not a phone. */
const ARGON_OPTIONS = {
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(plain: string): Promise<string> {
  if (plain.length < 10) {
    throw new AuthError(
      'A password must be at least 10 characters',
      'PASSWORD_TOO_SHORT',
      400,
    );
  }
  return argonHash(plain, ARGON_OPTIONS);
}

export async function verifyPassword(hashValue: string, plain: string): Promise<boolean> {
  try {
    return await argonVerify(hashValue, plain);
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ tokens

export interface AccessClaims extends JWTPayload {
  sub: string;
  accountId: string;
  /** Present only for clinical accounts. */
  practitionerId?: string;
  ministryUserId?: string;
  personId?: string;
  /** Whether a second factor was actually presented in this session. */
  mfa: boolean;
}

export async function issueAccessToken(claims: Omit<AccessClaims, 'iat' | 'exp'>) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setIssuer('nhp')
    .setAudience('nhp-api')
    .setExpirationTime(`${ACCESS_TOKEN_MINUTES}m`)
    .sign(secret());
}

export async function verifyAccessToken(token: string): Promise<AccessClaims> {
  try {
    const { payload } = await jwtVerify(token, secret(), {
      issuer: 'nhp',
      audience: 'nhp-api',
    });
    return payload as AccessClaims;
  } catch {
    throw new AuthError('Invalid or expired session', 'INVALID_TOKEN');
  }
}

/** Refresh tokens are stored hashed — a database dump yields no sessions. */
function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

async function issueRefreshToken(
  db: Db,
  accountId: string,
  familyId: string,
  deviceHint?: string,
) {
  const raw = randomBytes(32).toString('base64url');
  await db.refreshToken.create({
    data: {
      accountId,
      tokenHash: hashToken(raw),
      familyId,
      deviceHint: deviceHint ?? null,
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_DAYS * 86_400_000),
    },
  });
  return raw;
}

/**
 * Rotates a refresh token.
 *
 * If a token that has already been used comes back, someone is replaying a
 * stolen one — so the entire family is revoked, logging out the thief AND
 * the legitimate user. Being logged out is the correct outcome: it is the
 * only signal the real user gets that their session was compromised.
 */
export async function rotateRefreshToken(
  db: Db,
  rawToken: string,
  deviceHint?: string,
): Promise<{ accessToken: string; refreshToken: string }> {
  const existing = await db.refreshToken.findUnique({
    where: { tokenHash: hashToken(rawToken) },
    include: { account: true },
  });

  if (!existing) throw new AuthError('Invalid session', 'INVALID_REFRESH');

  if (existing.usedAt || existing.revokedAt) {
    await db.refreshToken.updateMany({
      where: { familyId: existing.familyId, revokedAt: null },
      data: { revokedAt: new Date(), revokedFor: 'TOKEN_REUSE_DETECTED' },
    });
    throw new AuthError(
      'This session was already used elsewhere. All sessions on this device ' +
        'have been ended as a precaution.',
      'TOKEN_REUSE',
    );
  }

  if (existing.expiresAt <= new Date()) {
    throw new AuthError('Session expired, sign in again', 'REFRESH_EXPIRED');
  }
  if (existing.account.status !== 'ACTIVE') {
    throw new AuthError('This account is not active', 'ACCOUNT_INACTIVE', 403);
  }

  await db.refreshToken.update({
    where: { id: existing.id },
    data: { usedAt: new Date() },
  });

  const account = existing.account;
  const accessToken = await issueAccessToken({
    sub: account.id,
    accountId: account.id,
    practitionerId: account.practitionerId ?? undefined,
    ministryUserId: account.ministryUserId ?? undefined,
    personId: account.personId ?? undefined,
    // MFA state does not survive a refresh for privileged accounts: a
    // long-lived refresh token must not silently confer a second factor.
    mfa: account.mfaMode === 'NONE',
  });

  const refreshToken = await issueRefreshToken(
    db,
    account.id,
    existing.familyId,
    deviceHint,
  );

  return { accessToken, refreshToken };
}

export async function revokeAllSessions(db: Db, accountId: string, reason: string) {
  const result = await db.refreshToken.updateMany({
    where: { accountId, revokedAt: null },
    data: { revokedAt: new Date(), revokedFor: reason },
  });
  return { revoked: result.count };
}

// -------------------------------------------------------------------- OTP

export function generateOtp(): string {
  return String(randomInt(100_000, 1_000_000));
}

/**
 * Issues a one-time code.
 *
 * Returns the code so a caller can hand it to the SMS gateway. It is never
 * stored in the clear and never logged.
 */
export async function issueOtp(
  db: Db,
  input: { phone: string; purpose: 'REGISTER' | 'LOGIN_MFA' | 'RESET' | 'CONSENT'; accountId?: string },
) {
  const phoneIndex = blindIndex(input.phone, normalisePhone);
  const code = generateOtp();

  // One live challenge per phone and purpose, so requesting a new code
  // invalidates the old one rather than widening the guessing window.
  await db.otpChallenge.updateMany({
    where: { phoneIndex, purpose: input.purpose, consumedAt: null },
    data: { consumedAt: new Date() },
  });

  await db.otpChallenge.create({
    data: {
      accountId: input.accountId ?? null,
      phoneIndex,
      codeHash: await argonHash(code, ARGON_OPTIONS),
      purpose: input.purpose,
      expiresAt: new Date(Date.now() + OTP_MINUTES * 60_000),
    },
  });

  return { code, expiresInMinutes: OTP_MINUTES };
}

export async function verifyOtp(
  db: Db,
  input: { phone: string; code: string; purpose: string },
): Promise<{ accountId: string | null }> {
  const phoneIndex = blindIndex(input.phone, normalisePhone);

  const challenge = await db.otpChallenge.findFirst({
    where: {
      phoneIndex,
      purpose: input.purpose,
      consumedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { issuedAt: 'desc' },
  });

  if (!challenge) throw new AuthError('That code has expired', 'OTP_EXPIRED');

  if (challenge.attempts >= MAX_OTP_ATTEMPTS) {
    await db.otpChallenge.update({
      where: { id: challenge.id },
      data: { consumedAt: new Date() },
    });
    throw new AuthError('Too many attempts. Request a new code.', 'OTP_ATTEMPTS_EXCEEDED');
  }

  const ok = await argonVerify(challenge.codeHash, input.code).catch(() => false);

  if (!ok) {
    await db.otpChallenge.update({
      where: { id: challenge.id },
      data: { attempts: { increment: 1 } },
    });
    throw new AuthError('That code is not correct', 'OTP_INVALID');
  }

  await db.otpChallenge.update({
    where: { id: challenge.id },
    data: { consumedAt: new Date() },
  });

  return { accountId: challenge.accountId };
}

// -------------------------------------------------------------- TOTP (MFA)

export function generateTotpSecret(): string {
  return new Secret({ size: 20 }).base32;
}

export function totpUri(secretBase32: string, label: string): string {
  return new TOTP({
    issuer: 'NHP Kenya',
    label,
    secret: Secret.fromBase32(secretBase32),
  }).toString();
}

export function verifyTotp(secretBase32: string, code: string): boolean {
  const totp = new TOTP({ secret: Secret.fromBase32(secretBase32) });
  // A one-step window: clock drift is real, but a wider window meaningfully
  // extends how long a shoulder-surfed code stays usable.
  return totp.validate({ token: code, window: 1 }) !== null;
}

// ------------------------------------------------------------------- login

export interface LoginResult {
  status: 'AUTHENTICATED' | 'MFA_REQUIRED';
  accessToken?: string;
  refreshToken?: string;
  /** Present when MFA is required — proves the password step passed. */
  mfaToken?: string;
  mfaMode?: 'SMS' | 'TOTP';
}

/**
 * Password login.
 *
 * Failures are deliberately indistinguishable: a wrong password and an
 * unknown phone number produce the same error, or this endpoint becomes a
 * way to discover who holds an account.
 */
export async function login(
  db: Db,
  input: { phone: string; password: string; deviceHint?: string },
): Promise<LoginResult> {
  const phoneIndex = blindIndex(input.phone, normalisePhone);
  const account = await db.account.findUnique({ where: { phoneIndex } });

  const GENERIC = new AuthError(
    'That phone number and password do not match',
    'INVALID_CREDENTIALS',
  );

  if (!account) {
    // Burn comparable time so absence is not detectable by response timing.
    await argonVerify(
      '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHR2YWx1ZQ$0000000000000000000000000000000000000000000',
      input.password,
    ).catch(() => false);
    throw GENERIC;
  }

  if (account.lockedUntil && account.lockedUntil > new Date()) {
    throw new AuthError(
      `Too many failed attempts. Try again after ${account.lockedUntil.toISOString()}.`,
      'ACCOUNT_LOCKED',
      429,
    );
  }
  if (account.status !== 'ACTIVE') {
    throw new AuthError('This account is not active', 'ACCOUNT_INACTIVE', 403);
  }

  const ok = await verifyPassword(account.passwordHash, input.password);

  if (!ok) {
    const attempts = account.failedAttempts + 1;
    await db.account.update({
      where: { id: account.id },
      data: {
        failedAttempts: attempts,
        lockedUntil:
          attempts >= MAX_FAILED_LOGINS
            ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000)
            : null,
      },
    });
    throw GENERIC;
  }

  await db.account.update({
    where: { id: account.id },
    data: { failedAttempts: 0, lockedUntil: null, lastLoginAt: new Date() },
  });

  const privileged = Boolean(account.practitionerId || account.ministryUserId);

  // MFA is mandatory for anyone who can reach identifiable health data, and
  // enforced here rather than trusted to the client.
  if (privileged && account.mfaMode !== 'NONE') {
    const mfaToken = await new SignJWT({ accountId: account.id, stage: 'MFA' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setIssuer('nhp')
      .setAudience('nhp-mfa')
      .setExpirationTime('5m')
      .sign(secret());

    return {
      status: 'MFA_REQUIRED',
      mfaToken,
      mfaMode: account.mfaMode as 'SMS' | 'TOTP',
    };
  }

  if (privileged && account.mfaMode === 'NONE') {
    throw new AuthError(
      'This account can reach patient data and has no second factor. ' +
        'Enrol in MFA before signing in.',
      'MFA_ENROLMENT_REQUIRED',
      403,
    );
  }

  return issueSession(db, account, input.deviceHint, false);
}

async function issueSession(
  db: Db,
  account: {
    id: string;
    practitionerId: string | null;
    ministryUserId: string | null;
    personId: string | null;
  },
  deviceHint: string | undefined,
  mfaSatisfied: boolean,
): Promise<LoginResult> {
  const familyId = randomBytes(16).toString('hex');

  const accessToken = await issueAccessToken({
    sub: account.id,
    accountId: account.id,
    practitionerId: account.practitionerId ?? undefined,
    ministryUserId: account.ministryUserId ?? undefined,
    personId: account.personId ?? undefined,
    mfa: mfaSatisfied,
  });

  const refreshToken = await issueRefreshToken(db, account.id, familyId, deviceHint);
  return { status: 'AUTHENTICATED', accessToken, refreshToken };
}

/** Completes login for an account that requires a second factor. */
export async function completeMfa(
  db: Db,
  input: { mfaToken: string; code: string; deviceHint?: string },
): Promise<LoginResult> {
  let accountId: string;
  try {
    const { payload } = await jwtVerify(input.mfaToken, secret(), {
      issuer: 'nhp',
      audience: 'nhp-mfa',
    });
    if (payload.stage !== 'MFA') throw new Error('wrong stage');
    accountId = payload.accountId as string;
  } catch {
    throw new AuthError('That sign-in attempt expired. Start again.', 'MFA_TOKEN_INVALID');
  }

  const account = await db.account.findUnique({ where: { id: accountId } });
  if (!account) throw new AuthError('Invalid session', 'INVALID_TOKEN');

  let ok = false;
  if (account.mfaMode === 'TOTP' && account.mfaSecret) {
    ok = verifyTotp(decryptField(account.mfaSecret), input.code);
  } else if (account.mfaMode === 'SMS') {
    ok = await verifyOtp(db, {
      phone: decryptField(account.phone),
      code: input.code,
      purpose: 'LOGIN_MFA',
    })
      .then(() => true)
      .catch(() => false);
  }

  if (!ok) throw new AuthError('That code is not correct', 'MFA_INVALID');

  return issueSession(db, account, input.deviceHint, true);
}

export async function enrolTotp(db: Db, accountId: string, label: string) {
  const account = await db.account.findUnique({ where: { id: accountId } });
  if (!account) throw new AuthError('Account not found', 'ACCOUNT_NOT_FOUND', 404);

  const secretBase32 = generateTotpSecret();
  await db.account.update({
    where: { id: accountId },
    data: { mfaSecret: encryptField(secretBase32) },
  });

  // mfaMode flips to TOTP only after a code is confirmed, so a half-finished
  // enrolment cannot lock someone out of their own account.
  return { secret: secretBase32, uri: totpUri(secretBase32, label) };
}

export async function confirmTotp(db: Db, accountId: string, code: string) {
  const account = await db.account.findUnique({ where: { id: accountId } });
  if (!account?.mfaSecret) {
    throw new AuthError('Start enrolment first', 'MFA_NOT_STARTED', 400);
  }
  if (!verifyTotp(decryptField(account.mfaSecret), code)) {
    throw new AuthError('That code is not correct', 'MFA_INVALID');
  }

  await db.account.update({ where: { id: accountId }, data: { mfaMode: 'TOTP' } });
  return { enrolled: true };
}

// ------------------------------------------------------------- CSRF

/**
 * Double-submit CSRF token.
 *
 * A refresh cookie is sent by the browser automatically, so any page on any
 * origin could trigger a refresh and — if the response were readable —
 * harvest a session. SameSite=Strict blocks the common cases, but it is one
 * browser setting away from failing, so the refresh endpoint also demands a
 * token that JavaScript must read from a readable cookie and echo in a
 * header. A cross-origin page can cause the cookie to be SENT; it cannot
 * READ it.
 */
export const CSRF_COOKIE = 'nhp_csrf';
export const CSRF_HEADER = 'x-csrf-token';

export function generateCsrfToken(): string {
  return randomBytes(32).toString('base64url');
}

export function assertCsrf(cookieValue?: string, headerValue?: string): void {
  if (!cookieValue || !headerValue) {
    throw new AuthError('Missing CSRF token', 'CSRF_MISSING', 403);
  }
  const a = Buffer.from(cookieValue);
  const b = Buffer.from(headerValue);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new AuthError('CSRF token mismatch', 'CSRF_INVALID', 403);
  }
}

/**
 * Cookie options for the refresh token.
 *
 * httpOnly so no script can read it, Strict so it is not sent from another
 * origin at all, and Path-scoped to the refresh endpoint so it is not
 * attached to every ordinary API call.
 */
export function refreshCookieOptions(secure: boolean) {
  return {
    httpOnly: true,
    secure,
    sameSite: 'strict' as const,
    path: '/api/v1/auth',
    maxAge: REFRESH_TOKEN_DAYS * 24 * 60 * 60,
  };
}

/** The CSRF cookie is deliberately readable — the page must echo it back. */
export function csrfCookieOptions(secure: boolean) {
  return {
    httpOnly: false,
    secure,
    sameSite: 'strict' as const,
    path: '/',
    maxAge: REFRESH_TOKEN_DAYS * 24 * 60 * 60,
  };
}

// ------------------------------------------------------------------ guards

export interface AuthContext {
  accountId: string;
  practitionerId?: string;
  ministryUserId?: string;
  personId?: string;
  mfa: boolean;
}

export function contextFromClaims(claims: AccessClaims): AuthContext {
  return {
    accountId: claims.accountId,
    practitionerId: claims.practitionerId,
    ministryUserId: claims.ministryUserId,
    personId: claims.personId,
    mfa: claims.mfa,
  };
}

/**
 * Requires a clinical identity with a satisfied second factor.
 *
 * Both halves matter: a citizen token must not reach clinical routes, and a
 * privileged token that never presented its second factor must not either.
 */
export function requirePractitioner(ctx: AuthContext): string {
  if (!ctx.practitionerId) {
    throw new AuthError('This endpoint requires a clinical account', 'NOT_A_PRACTITIONER', 403);
  }
  if (!ctx.mfa) {
    throw new AuthError(
      'Your second factor has not been presented in this session',
      'MFA_REQUIRED',
      403,
    );
  }
  return ctx.practitionerId;
}

export function requireMinistry(ctx: AuthContext, roles?: string[]): string {
  if (!ctx.ministryUserId) {
    throw new AuthError('This endpoint requires a Ministry account', 'NOT_MINISTRY', 403);
  }
  if (!ctx.mfa) {
    throw new AuthError('Ministry accounts require a second factor', 'MFA_REQUIRED', 403);
  }
  void roles;
  return ctx.ministryUserId;
}

/**
 * A citizen may only read their own record.
 *
 * Comparison is timing-safe, since ids are guessable in shape and an
 * attacker with many attempts could otherwise probe for near-misses.
 */
export function requireSelf(ctx: AuthContext, personId: string): string {
  const a = Buffer.from(ctx.personId ?? '');
  const b = Buffer.from(personId);
  const same = a.length === b.length && timingSafeEqual(a, b);
  if (!same) {
    throw new AuthError('That is not your record', 'NOT_YOUR_RECORD', 403);
  }
  return personId;
}
