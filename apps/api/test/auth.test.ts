/**
 * Authentication.
 *
 * Security code, so the tests that matter are the refusals: enumeration,
 * token theft, MFA bypass, and lockout. A happy-path login proves almost
 * nothing on its own.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { TOTP, Secret } from 'otpauth';
import 'dotenv/config';
import {
  hashPassword,
  verifyPassword,
  login,
  completeMfa,
  rotateRefreshToken,
  revokeAllSessions,
  issueAccessToken,
  verifyAccessToken,
  contextFromClaims,
  requirePractitioner,
  requireMinistry,
  requireSelf,
  enrolTotp,
  confirmTotp,
  issueOtp,
  verifyOtp,
  generateTotpSecret,
  verifyTotp,
  MAX_FAILED_LOGINS,
  MAX_OTP_ATTEMPTS,
  assertCsrf,
  generateCsrfToken,
  refreshCookieOptions,
  csrfCookieOptions,
  REFRESH_TOKEN_DAYS,
} from '../src/auth.js';
import { registerAdult } from '../src/identity.js';
import { registerFacility, approveFacility } from '../src/facility.js';
import { registerPractitioner, grantAffiliation } from '../src/practitioner.js';
import { blindIndex, normalisePhone, decryptField } from '../src/crypto.js';

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
});
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const ctx = { countyId: '', subcountyId: '' };
let seq = 0;

async function wipe() {
  await owner.query('SET session_replication_role = replica');
  for (const t of [
    'refresh_token', 'otp_challenge', 'sync_envelope', 'counter_referral',
    'referral', 'agg_condition_daily', 'recommendation', 'condition',
    'medication', 'allergy', 'encounter', 'access_log', 'break_glass',
    'consent_grant', 'check_in', 'affiliation', 'licence', 'practitioner',
    'merge_request', 'facility_capability', 'facility', 'guardianship',
    'identifier', 'account', 'person',
  ]) {
    await owner.query(`DELETE FROM ${t}`);
  }
  await owner.query('SET session_replication_role = origin');
}

beforeAll(async () => {
  const county = await prisma.county.upsert({
    where: { code: '907' },
    create: { code: '907', name: 'Kisumu (auth fixture)' },
    update: {},
  });
  const sub =
    (await prisma.subCounty.findFirst({ where: { countyId: county.id } })) ??
    (await prisma.subCounty.create({
      data: { countyId: county.id, name: 'Central', kind: 'HEALTH_ADMIN' },
    }));
  ctx.countyId = county.id;
  ctx.subcountyId = sub.id;
});

beforeEach(async () => {
  await wipe();
});

afterAll(async () => {
  await prisma.$disconnect();
  await owner.end();
});

const PASSWORD = 'correct-horse-battery';

async function makeCitizen(phone?: string) {
  seq++;
  const person = await registerAdult(prisma, {
    nationalId: `300000${String(seq).padStart(3, '0')}`,
    phone: phone ?? `07180000${String(seq).padStart(3, '0')}`,
    givenName: 'Achieng',
    familyName: 'Otieno',
    sexAtBirth: 'FEMALE',
    dateOfBirth: new Date(Date.UTC(1990, 0, 1)),
    countyId: ctx.countyId,
    subcountyId: ctx.subcountyId,
    passwordHash: await hashPassword(PASSWORD),
  });
  const account = await prisma.account.findUniqueOrThrow({
    where: { personId: person.id },
  });
  return { person, account };
}

/** A clinician account, i.e. one that can reach patient data. */
async function makeClinicianAccount(opts: { mfa?: 'NONE' | 'TOTP' } = {}) {
  const { person } = await makeCitizen();
  seq++;
  const { practitioner } = await registerPractitioner(prisma, {
    personId: person.id,
    cadre: 'DOCTOR',
    countyId: ctx.countyId,
    subcountyId: ctx.subcountyId,
    licenceNumber: `KMPDC/2026/AU${String(seq).padStart(3, '0')}`,
  });

  const phone = `07190000${String(seq).padStart(3, '0')}`;
  const account = await prisma.account.create({
    data: {
      practitionerId: practitioner.id,
      phone: (await import('../src/crypto.js')).encryptField(phone),
      phoneIndex: blindIndex(phone, normalisePhone),
      passwordHash: await hashPassword(PASSWORD),
      mfaMode: opts.mfa ?? 'NONE',
      status: 'ACTIVE',
    },
  });

  return { practitioner, account, phone };
}

// =====================================================================

describe('password hashing', () => {
  it('uses argon2id and never stores the plaintext', async () => {
    const hash = await hashPassword(PASSWORD);
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(hash).not.toContain(PASSWORD);
    expect(await verifyPassword(hash, PASSWORD)).toBe(true);
    expect(await verifyPassword(hash, 'wrong')).toBe(false);
  });

  it('produces a different hash for the same password', async () => {
    // Distinct salts: two people with the same password must not be
    // identifiable as such from a database dump.
    expect(await hashPassword(PASSWORD)).not.toBe(await hashPassword(PASSWORD));
  });

  it('refuses a short password', async () => {
    await expect(hashPassword('short')).rejects.toThrow(/at least 10/i);
  });
});

describe('login', () => {
  it('signs a citizen in', async () => {
    const { account } = await makeCitizen('0718000999');
    const result = await login(prisma, { phone: '0718000999', password: PASSWORD });

    expect(result.status).toBe('AUTHENTICATED');
    expect(result.accessToken).toBeTruthy();
    expect(result.refreshToken).toBeTruthy();

    const claims = await verifyAccessToken(result.accessToken!);
    expect(claims.accountId).toBe(account.id);
    expect(claims.practitionerId).toBeUndefined();
  });

  it('THE ENUMERATION DEFENCE — unknown phone and wrong password look identical', async () => {
    await makeCitizen('0718000111');

    const wrongPassword = await login(prisma, {
      phone: '0718000111',
      password: 'not-the-password',
    }).catch((e) => e);
    const unknownPhone = await login(prisma, {
      phone: '0799999999',
      password: PASSWORD,
    }).catch((e) => e);

    // Otherwise this endpoint becomes a directory of who holds an account.
    expect(wrongPassword.code).toBe('INVALID_CREDENTIALS');
    expect(unknownPhone.code).toBe('INVALID_CREDENTIALS');
    expect(wrongPassword.message).toBe(unknownPhone.message);
  });

  it('normalises the phone, so 0712… and +254712… are one account', async () => {
    await makeCitizen('0718000222');
    const result = await login(prisma, {
      phone: '+254718000222',
      password: PASSWORD,
    });
    expect(result.status).toBe('AUTHENTICATED');
  });

  it('locks an account after repeated failures', async () => {
    await makeCitizen('0718000333');

    for (let i = 0; i < MAX_FAILED_LOGINS; i++) {
      await login(prisma, { phone: '0718000333', password: 'wrong' }).catch(() => {});
    }

    // Even the CORRECT password is refused while locked.
    const locked = await login(prisma, {
      phone: '0718000333',
      password: PASSWORD,
    }).catch((e) => e);
    expect(locked.code).toBe('ACCOUNT_LOCKED');
  });

  it('clears the failure count on a successful login', async () => {
    const { account } = await makeCitizen('0718000444');
    await login(prisma, { phone: '0718000444', password: 'wrong' }).catch(() => {});
    await login(prisma, { phone: '0718000444', password: PASSWORD });

    const after = await prisma.account.findUniqueOrThrow({ where: { id: account.id } });
    expect(after.failedAttempts).toBe(0);
  });

  it('refuses a suspended account', async () => {
    const { account } = await makeCitizen('0718000555');
    await prisma.account.update({
      where: { id: account.id },
      data: { status: 'SUSPENDED' },
    });

    const result = await login(prisma, {
      phone: '0718000555',
      password: PASSWORD,
    }).catch((e) => e);
    expect(result.code).toBe('ACCOUNT_INACTIVE');
  });
});

describe('MFA', () => {
  it('THE ENROLMENT GATE — a clinician with no second factor cannot sign in', async () => {
    const { phone } = await makeClinicianAccount({ mfa: 'NONE' });

    // A client that "forgets" to prompt must not reach patient data, so the
    // refusal is here rather than trusted to the UI.
    const result = await login(prisma, { phone, password: PASSWORD }).catch((e) => e);
    expect(result.code).toBe('MFA_ENROLMENT_REQUIRED');
  });

  it('stops a clinician login at the MFA step', async () => {
    const { account, phone } = await makeClinicianAccount({ mfa: 'TOTP' });
    const secret = generateTotpSecret();
    await prisma.account.update({
      where: { id: account.id },
      data: { mfaSecret: (await import('../src/crypto.js')).encryptField(secret) },
    });

    const result = await login(prisma, { phone, password: PASSWORD });
    expect(result.status).toBe('MFA_REQUIRED');
    // No access token until the second factor lands.
    expect(result.accessToken).toBeUndefined();
    expect(result.mfaToken).toBeTruthy();
  });

  it('completes login with a valid TOTP code', async () => {
    const { account, phone } = await makeClinicianAccount({ mfa: 'TOTP' });
    const secret = generateTotpSecret();
    await prisma.account.update({
      where: { id: account.id },
      data: { mfaSecret: (await import('../src/crypto.js')).encryptField(secret) },
    });

    const first = await login(prisma, { phone, password: PASSWORD });
    const code = new TOTP({ secret: Secret.fromBase32(secret) }).generate();

    const done = await completeMfa(prisma, { mfaToken: first.mfaToken!, code });
    expect(done.status).toBe('AUTHENTICATED');

    const claims = await verifyAccessToken(done.accessToken!);
    expect(claims.mfa).toBe(true);
    expect(claims.practitionerId).toBe(account.practitionerId);
  });

  it('refuses a wrong TOTP code', async () => {
    const { account, phone } = await makeClinicianAccount({ mfa: 'TOTP' });
    await prisma.account.update({
      where: { id: account.id },
      data: {
        mfaSecret: (await import('../src/crypto.js')).encryptField(generateTotpSecret()),
      },
    });

    const first = await login(prisma, { phone, password: PASSWORD });
    const result = await completeMfa(prisma, {
      mfaToken: first.mfaToken!,
      code: '000000',
    }).catch((e) => e);
    expect(result.code).toBe('MFA_INVALID');
  });

  it('enrols TOTP only once a code is confirmed', async () => {
    const { account } = await makeClinicianAccount({ mfa: 'NONE' });
    const { secret } = await enrolTotp(prisma, account.id, 'Dr Test');

    // Half-finished enrolment must not lock someone out of their account.
    const midway = await prisma.account.findUniqueOrThrow({ where: { id: account.id } });
    expect(midway.mfaMode).toBe('NONE');

    const code = new TOTP({ secret: Secret.fromBase32(secret) }).generate();
    await confirmTotp(prisma, account.id, code);

    const after = await prisma.account.findUniqueOrThrow({ where: { id: account.id } });
    expect(after.mfaMode).toBe('TOTP');
    // The secret is encrypted at rest.
    expect(after.mfaSecret).not.toBe(secret);
    expect(decryptField(after.mfaSecret!)).toBe(secret);
  });

  it('validates a TOTP code against its secret', () => {
    const secret = generateTotpSecret();
    const code = new TOTP({ secret: Secret.fromBase32(secret) }).generate();
    expect(verifyTotp(secret, code)).toBe(true);
    expect(verifyTotp(secret, '123456')).toBe(false);
  });
});

describe('refresh tokens', () => {
  it('rotates on every use', async () => {
    await makeCitizen('0718000666');
    const first = await login(prisma, { phone: '0718000666', password: PASSWORD });

    const second = await rotateRefreshToken(prisma, first.refreshToken!);
    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(second.accessToken).toBeTruthy();
  });

  it('THE THEFT SIGNAL — replaying a used token revokes the whole family', async () => {
    await makeCitizen('0718000777');
    const first = await login(prisma, { phone: '0718000777', password: PASSWORD });

    const second = await rotateRefreshToken(prisma, first.refreshToken!);

    // Someone replays the original — it was stolen.
    const replay = await rotateRefreshToken(prisma, first.refreshToken!).catch((e) => e);
    expect(replay.code).toBe('TOKEN_REUSE');

    // The thief's rotated token is dead too. Logging the real user out is
    // the correct outcome: it is the only signal they get.
    const afterTheft = await rotateRefreshToken(prisma, second.refreshToken!).catch(
      (e) => e,
    );
    expect(afterTheft.code).toBe('TOKEN_REUSE');
  });

  it('stores tokens hashed — a database dump yields no sessions', async () => {
    await makeCitizen('0718000888');
    const result = await login(prisma, { phone: '0718000888', password: PASSWORD });

    const rows = await prisma.refreshToken.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].tokenHash).not.toBe(result.refreshToken);
    expect(rows[0].tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses an unknown token', async () => {
    const result = await rotateRefreshToken(prisma, 'not-a-real-token').catch((e) => e);
    expect(result.code).toBe('INVALID_REFRESH');
  });

  it('does not restore MFA state on refresh for a privileged account', async () => {
    const { account, phone } = await makeClinicianAccount({ mfa: 'TOTP' });
    const secret = generateTotpSecret();
    await prisma.account.update({
      where: { id: account.id },
      data: { mfaSecret: (await import('../src/crypto.js')).encryptField(secret) },
    });

    const first = await login(prisma, { phone, password: PASSWORD });
    const code = new TOTP({ secret: Secret.fromBase32(secret) }).generate();
    const session = await completeMfa(prisma, { mfaToken: first.mfaToken!, code });

    const refreshed = await rotateRefreshToken(prisma, session.refreshToken!);
    const claims = await verifyAccessToken(refreshed.accessToken!);

    // A 30-day refresh token must not silently confer a second factor.
    expect(claims.mfa).toBe(false);
  });

  it('revokes every session on logout', async () => {
    const { account } = await makeCitizen('0718000999');
    const a = await login(prisma, { phone: '0718000999', password: PASSWORD });
    const b = await login(prisma, { phone: '0718000999', password: PASSWORD });

    await revokeAllSessions(prisma, account.id, 'USER_LOGOUT');

    for (const session of [a, b]) {
      const result = await rotateRefreshToken(prisma, session.refreshToken!).catch(
        (e) => e,
      );
      expect(result.code).toBe('TOKEN_REUSE');
    }
  });
});

describe('OTP', () => {
  it('issues and verifies a code', async () => {
    const { code } = await issueOtp(prisma, { phone: '0718001111', purpose: 'REGISTER' });
    expect(code).toMatch(/^\d{6}$/);

    const result = await verifyOtp(prisma, {
      phone: '0718001111',
      code,
      purpose: 'REGISTER',
    });
    expect(result).toBeDefined();
  });

  it('stores the code hashed', async () => {
    const { code } = await issueOtp(prisma, { phone: '0718002222', purpose: 'REGISTER' });
    const challenge = await prisma.otpChallenge.findFirstOrThrow();
    expect(challenge.codeHash).not.toContain(code);
  });

  it('consumes a code, so it cannot be replayed', async () => {
    const { code } = await issueOtp(prisma, { phone: '0718003333', purpose: 'REGISTER' });
    await verifyOtp(prisma, { phone: '0718003333', code, purpose: 'REGISTER' });

    const replay = await verifyOtp(prisma, {
      phone: '0718003333',
      code,
      purpose: 'REGISTER',
    }).catch((e) => e);
    expect(replay.code).toBe('OTP_EXPIRED');
  });

  it('gives up after repeated wrong guesses', async () => {
    await issueOtp(prisma, { phone: '0718004444', purpose: 'REGISTER' });

    for (let i = 0; i < MAX_OTP_ATTEMPTS; i++) {
      await verifyOtp(prisma, {
        phone: '0718004444',
        code: '000000',
        purpose: 'REGISTER',
      }).catch(() => {});
    }

    const result = await verifyOtp(prisma, {
      phone: '0718004444',
      code: '000000',
      purpose: 'REGISTER',
    }).catch((e) => e);
    expect(result.code).toBe('OTP_ATTEMPTS_EXCEEDED');
  });

  it('invalidates the previous code when a new one is requested', async () => {
    const first = await issueOtp(prisma, { phone: '0718005555', purpose: 'REGISTER' });
    await issueOtp(prisma, { phone: '0718005555', purpose: 'REGISTER' });

    // Otherwise every resend widens the guessing window.
    const stale = await verifyOtp(prisma, {
      phone: '0718005555',
      code: first.code,
      purpose: 'REGISTER',
    }).catch((e) => e);
    expect(stale.code).toBe('OTP_INVALID');
  });
});

describe('the guards', () => {
  it('refuses a citizen token on a clinical route', async () => {
    const { account } = await makeCitizen();
    const token = await issueAccessToken({
      sub: account.id,
      accountId: account.id,
      personId: account.personId!,
      mfa: true,
    });
    const ctx = contextFromClaims(await verifyAccessToken(token));

    expect(() => requirePractitioner(ctx)).toThrow(/clinical account/i);
    expect(() => requireMinistry(ctx)).toThrow(/Ministry account/i);
  });

  it('THE MFA GATE — a clinical token without a second factor is refused', async () => {
    const { practitioner, account } = await makeClinicianAccount({ mfa: 'TOTP' });
    const token = await issueAccessToken({
      sub: account.id,
      accountId: account.id,
      practitionerId: practitioner.id,
      mfa: false,
    });
    const ctx = contextFromClaims(await verifyAccessToken(token));

    // Holding a clinical identity is not enough; the factor must have been
    // presented in THIS session.
    expect(() => requirePractitioner(ctx)).toThrow(/second factor/i);
  });

  it('lets a citizen read only their own record', async () => {
    const { account, person } = await makeCitizen();
    const other = await makeCitizen();
    const ctx = contextFromClaims(
      await verifyAccessToken(
        await issueAccessToken({
          sub: account.id,
          accountId: account.id,
          personId: person.id,
          mfa: true,
        }),
      ),
    );

    expect(requireSelf(ctx, person.id)).toBe(person.id);
    expect(() => requireSelf(ctx, other.person.id)).toThrow(/not your record/i);
  });

  it('rejects a tampered token', async () => {
    const { account } = await makeCitizen();
    const token = await issueAccessToken({
      sub: account.id,
      accountId: account.id,
      mfa: true,
    });

    const [header, payload, signature] = token.split('.');
    const forged = `${header}.${Buffer.from(
      JSON.stringify({ accountId: 'someone-else', mfa: true }),
    ).toString('base64url')}.${signature}`;

    await expect(verifyAccessToken(forged)).rejects.toThrow(/invalid or expired/i);
  });

  it('rejects a token signed with the wrong secret', async () => {
    const original = process.env.JWT_SECRET;
    const token = await issueAccessToken({ sub: 'a', accountId: 'a', mfa: true });

    process.env.JWT_SECRET = 'a-completely-different-secret-value-here';
    await expect(verifyAccessToken(token)).rejects.toThrow(/invalid or expired/i);
    process.env.JWT_SECRET = original;
  });
});


describe('CSRF and cookie policy', () => {
  it('accepts a matching double-submit token', () => {
    const token = generateCsrfToken();
    expect(() => assertCsrf(token, token)).not.toThrow();
  });

  it('THE CSRF DEFENCE — refuses a mismatched or absent token', () => {
    const token = generateCsrfToken();

    // A cross-origin page can make the browser SEND the cookie; it cannot
    // READ it, so it cannot produce the matching header.
    expect(() => assertCsrf(token, generateCsrfToken())).toThrow(/mismatch/i);
    expect(() => assertCsrf(token, undefined)).toThrow(/missing/i);
    expect(() => assertCsrf(undefined, token)).toThrow(/missing/i);
    expect(() => assertCsrf(undefined, undefined)).toThrow(/missing/i);
  });

  it('generates unguessable tokens', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => generateCsrfToken()));
    expect(tokens.size).toBe(50);
    // 32 bytes base64url.
    expect(generateCsrfToken().length).toBeGreaterThanOrEqual(43);
  });

  it('makes the refresh cookie unreadable by script', () => {
    const opts = refreshCookieOptions(true);
    // The whole point: an injected script must not be able to read it.
    expect(opts.httpOnly).toBe(true);
    expect(opts.sameSite).toBe('strict');
    expect(opts.secure).toBe(true);
    // Scoped, so it is not attached to every ordinary API call.
    expect(opts.path).toBe('/api/v1/auth');
    expect(opts.maxAge).toBe(REFRESH_TOKEN_DAYS * 24 * 60 * 60);
  });

  it('makes the CSRF cookie readable, because the page must echo it', () => {
    const opts = csrfCookieOptions(true);
    expect(opts.httpOnly).toBe(false);
    expect(opts.sameSite).toBe('strict');
    expect(opts.path).toBe('/');
  });

  it('allows insecure cookies only in development', () => {
    expect(refreshCookieOptions(false).secure).toBe(false);
    expect(refreshCookieOptions(true).secure).toBe(true);
  });
});
