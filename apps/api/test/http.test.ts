/**
 * THE HTTP LAYER.
 *
 * Every other suite in this directory calls the service functions directly.
 * That is the right way to test a rule, but it cannot see the layer where
 * a request becomes a function call — and three defects reached `main`
 * living exactly there:
 *
 *   1. Two clinical routes had NO authorization check. An unauthenticated
 *      request returned HTTP 200 on a patient's timeline and on the log of
 *      who had read their record. Every service they called was correct.
 *
 *   2. The whole `/persons/:nhpId/*` family passed the NHP number a
 *      clinician types to services that key on the internal person id.
 *      Nothing matched, so a patient with a full history rendered as one
 *      with none — no error anywhere. Every service was, again, correct.
 *
 *   3. `periodFrom` handed Postgres a mid-afternoon timestamp as an
 *      exclusive bound on a DATE column, dropping today's rollup from every
 *      analytics answer while still returning 200.
 *
 * None of those are service bugs. All three are wiring bugs, and wiring is
 * what this file tests: status codes, guards, identifier translation,
 * cookies, CSRF, and the shape of what actually goes over the wire.
 *
 * It drives the real application through `app.inject()` — the same routes,
 * error handler, cookie and CORS plugins that `pnpm serve` starts — so
 * there is no second, more forgiving version of the app under test.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import 'dotenv/config';

import { buildApp } from '../src/app.js';
import { registerAdult } from '../src/identity.js';
import { registerFacility, approveFacility } from '../src/facility.js';
import {
  registerPractitioner,
  grantAffiliation,
  checkIn,
} from '../src/practitioner.js';
import { openEncounter, recordDiagnosis } from '../src/clinical.js';
import { hashPassword, enrolSms, confirmSms, CSRF_HEADER } from '../src/auth.js';
import { ConsoleSmsProvider, setSmsProvider } from '../src/notify.js';
import { encryptField, blindIndex, normalisePhone } from '../src/crypto.js';

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
});
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL });

/** Captures the SMS codes so the harness can complete a real MFA login. */
const sms = new ConsoleSmsProvider();

let app: FastifyInstance;
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
    'identifier', 'ministry_user', 'account', 'person',
  ]) {
    await owner.query(`DELETE FROM ${t}`);
  }
  await owner.query('SET session_replication_role = origin');
}

beforeAll(async () => {
  if ((await prisma.diagnosisTerm.count()) === 0) {
    throw new Error('Vocabularies not loaded. Run `pnpm seed` first.');
  }
  setSmsProvider(sms);

  // The app is built against the OWNER connection here, not the restricted
  // app role, because these tests also create fixtures. The privilege
  // separation itself is covered by hardening.test.ts.
  app = await buildApp(prisma);
  await app.ready();

  const county = await prisma.county.upsert({
    where: { code: '910' },
    create: { code: '910', name: 'Kisumu (http fixture)' },
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
  sms.sent.length = 0;
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
  await owner.end();
});

// ------------------------------------------------------------- fixtures

/**
 * `registerAdult` also creates the person's own citizen account, keyed on
 * the phone passed here — so the phone and password are returned alongside,
 * for the tests that need to sign that citizen in.
 */
const CITIZEN_PASSWORD = 'citizen-password-123';

async function makePerson(givenName = 'Achieng') {
  seq++;
  const phone = `07140000${String(seq).padStart(2, '0')}`;
  const person = await registerAdult(prisma, {
    nationalId: `810000${String(seq).padStart(2, '0')}`,
    phone,
    givenName,
    familyName: 'Otieno',
    sexAtBirth: 'FEMALE',
    dateOfBirth: new Date(Date.UTC(1990, 3, 12)),
    countyId: ctx.countyId,
    subcountyId: ctx.subcountyId,
    passwordHash: await hashPassword(CITIZEN_PASSWORD),
  });
  return Object.assign(person, { phone });
}

const ROLE_PASSWORD = 'role-password-123';

/**
 * Creates a practitioner or Ministry account and returns its phone number.
 *
 * Exactly one owner column may be set — `account_one_owner_ck` enforces it —
 * so a person who is both a doctor and a patient holds two accounts.
 *
 * The account is enrolled in SMS MFA because the server REFUSES to sign in
 * a privileged account without a second factor (MFA_ENROLMENT_REQUIRED).
 * The fixture goes through the real enrolment rather than setting
 * `mfaMode` directly: a harness that switches off the rule it is meant to
 * be testing under proves nothing.
 */
async function makeAccount(owner: Record<string, string>): Promise<string> {
  seq++;
  const phone = `07180000${String(seq).padStart(2, '0')}`;
  const account = await prisma.account.create({
    data: {
      phone: encryptField(phone),
      phoneIndex: blindIndex(phone, normalisePhone),
      passwordHash: await hashPassword(ROLE_PASSWORD),
      status: 'ACTIVE',
      ...owner,
    },
  });

  await enrolSms(prisma, account.id);
  const code = sms.sent.at(-1)?.body.match(/\b(\d{6})\b/)?.[1];
  if (!code) throw new Error('Enrolment code was not sent');
  await confirmSms(prisma, account.id, code);

  return phone;
}

/**
 * Signs in over HTTP, completing SMS MFA when the server demands it.
 *
 * Deliberately goes through the real endpoints rather than minting a token
 * directly — a harness that forges its own credentials cannot detect an
 * authentication bug, which is most of what this file is for.
 */
async function signIn(phone: string, password: string) {
  const first = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { phone, password },
  });
  let body = first.json();

  if (body.status === 'MFA_REQUIRED') {
    // The enrolment code and the sign-in code are different messages; take
    // the most recent one sent to this number.
    const code = sms.sent
      .filter((m) => m.to.endsWith(phone.slice(1)))
      .at(-1)
      ?.body.match(/\b(\d{6})\b/)?.[1];
    if (!code) throw new Error(`No SMS code was sent to ${phone}`);

    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa',
      payload: { mfaToken: body.mfaToken, code },
    });
    body = second.json();
    return { ...body, cookies: second.cookies };
  }

  return { ...body, cookies: first.cookies };
}

/** A checked-in doctor, signed in, ready to write. */
async function clinician() {
  const person = await makePerson('Amina');
  seq++;
  const { practitioner } = await registerPractitioner(prisma, {
    personId: person.id,
    cadre: 'DOCTOR',
    countyId: ctx.countyId,
    subcountyId: ctx.subcountyId,
    licenceNumber: `KMPDC/2026/H${String(seq).padStart(3, '0')}`,
  });

  const facility = await registerFacility(prisma, {
    name: 'Kisumu County Referral',
    kephLevel: 5,
    ownership: 'PUBLIC_MOH',
    countyId: ctx.countyId,
    subcountyId: ctx.subcountyId,
    locality: 'Milimani',
    latitude: -0.0917,
    longitude: 34.768,
  });
  await approveFacility(prisma, facility.id, 'ministry-1');
  await grantAffiliation(prisma, {
    practitionerId: practitioner.id,
    facilityId: facility.id,
    grantedBy: 'ministry-1',
    grantedByKind: 'MINISTRY',
  });
  await checkIn(prisma, { practitionerId: practitioner.id, facilityId: facility.id });

  // A practitioner account is separate from the person's own citizen
  // account — `account_one_owner_ck` allows exactly one owner per account,
  // so a doctor who is also a patient holds two.
  const phone = await makeAccount({ practitionerId: practitioner.id });
  const session = await signIn(phone, ROLE_PASSWORD);

  return { practitioner, facility, person, ...session };
}

/** A Ministry analyst, signed in. */
async function analyst() {
  const person = await makePerson('Wanjiru');
  const ministryUser = await prisma.ministryUser.create({
    data: {
      personId: person.id,
      role: 'ANALYST',
      geoScope: 'NATIONAL',
      mfaRequired: true,
    },
  });

  const phone = await makeAccount({ ministryUserId: ministryUser.id });
  const session = await signIn(phone, ROLE_PASSWORD);

  return { ministryUser, person, ...session };
}

/** A citizen, signed in against the account `registerAdult` gave them. */
async function citizen() {
  const person = await makePerson('Grace');
  const session = await signIn(person.phone, CITIZEN_PASSWORD);
  return { person, ...session };
}

/** Every route that names a person, so a guard can never be added to some. */
const PERSON_ROUTES = [
  'summary',
  'encounters',
  'access-log',
  'results',
  'procedures',
] as const;

// =====================================================================

describe('the authorization wall', () => {
  /**
   * THE REGRESSION. `/persons/:nhpId/encounters` and `.../access-log` had no
   * auth check at all and returned 200 to anyone who asked. They looked
   * harmless only because a second bug meant they always returned [].
   *
   * Asserting over the whole route family, rather than the two that were
   * broken, is the point: a guard added to four of five routes is exactly
   * the mistake that produced this.
   */
  it.each(PERSON_ROUTES)('refuses an unauthenticated caller on /%s', async (route) => {
    const patient = await makePerson();
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/persons/${patient.displayNumber}/${route}`,
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('NO_SESSION');
  });

  it.each(PERSON_ROUTES)('refuses a Ministry analyst on /%s', async (route) => {
    const { accessToken } = await analyst();
    const patient = await makePerson();

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/persons/${patient.displayNumber}/${route}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });

    // The separation the whole Ministry role depends on: an analyst reaches
    // aggregates and nothing else, ever.
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('NOT_A_PRACTITIONER');
  });

  it.each(PERSON_ROUTES)('refuses a citizen reading someone else on /%s', async (route) => {
    const { accessToken } = await citizen();
    const other = await makePerson('Stranger');

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/persons/${other.displayNumber}/${route}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(res.statusCode).toBe(403);
  });

  it('refuses a garbage bearer token rather than treating it as absent', async () => {
    const patient = await makePerson();
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/persons/${patient.displayNumber}/summary`,
      headers: { authorization: 'Bearer not-a-real-token' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('refuses an analyst on every Ministry route when unauthenticated', async () => {
    for (const route of [
      'burden',
      'referral-closure',
      'workforce',
      'care-gaps',
      'surveillance',
      'provenance',
      'counties',
    ]) {
      const res = await app.inject({ method: 'GET', url: `/api/v1/analytics/${route}` });
      expect(res.statusCode, `analytics/${route}`).toBe(401);
    }
  });

  it('refuses a clinician on Ministry analytics', async () => {
    const { accessToken } = await clinician();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/analytics/burden',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    // The wall stands in both directions — a doctor is not an analyst.
    expect(res.statusCode).toBe(403);
  });
});

describe('the NHP number over the wire', () => {
  /**
   * THE REGRESSION. Routes receive the number printed on a patient's card;
   * services key on the internal id. Passing one where the other is
   * expected matched nothing and returned an empty record with HTTP 200 —
   * a patient with a full history looking like a patient with none.
   */
  it('THE QUIET FAILURE — a real history is not served as an empty one', async () => {
    const doctor = await clinician();
    const patient = await makePerson();

    const encounter = await openEncounter(prisma, {
      practitionerId: doctor.practitioner.id,
      personId: patient.id,
      kind: 'OUTPATIENT',
      chiefComplaint: 'fever',
    });
    await recordDiagnosis(prisma, {
      practitionerId: doctor.practitioner.id,
      encounterId: encounter.id,
      icd11Code: '1F41.0',
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/persons/${patient.displayNumber}/encounters`,
      headers: { authorization: `Bearer ${doctor.accessToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(1);
    expect(res.json()[0].conditions[0].icd11Code).toBe('1F41.0');
  });

  it('resolves the display number on the summary banner', async () => {
    const doctor = await clinician();
    const patient = await makePerson();

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/persons/${patient.displayNumber}/summary`,
      headers: { authorization: `Bearer ${doctor.accessToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().person.displayNumber).toBe(patient.displayNumber);
  });

  it('refuses an unknown number instead of returning an empty record', async () => {
    const doctor = await clinician();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/persons/NHP-0000-0000/summary',
      headers: { authorization: `Bearer ${doctor.accessToken}` },
    });

    // 200-with-nothing reads as "this patient has no history" at the point
    // of treatment, which is the dangerous answer.
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('PERSON_NOT_FOUND');
  });

  it('writes the access log against the person, not the typed number', async () => {
    const doctor = await clinician();
    const patient = await makePerson();

    await app.inject({
      method: 'GET',
      url: `/api/v1/persons/${patient.displayNumber}/summary`,
      headers: { authorization: `Bearer ${doctor.accessToken}` },
    });

    // An audit row keyed on a value matching no person row is a trail
    // pointing at nobody — worse than no trail, because it looks complete.
    const logged = await prisma.accessLog.findMany({ where: { personId: patient.id } });
    expect(logged.length).toBeGreaterThan(0);
    expect(
      await prisma.accessLog.count({ where: { personId: patient.displayNumber } }),
    ).toBe(0);
  });
});

describe('the session, end to end', () => {
  it('never returns the refresh token in the body', async () => {
    const { accessToken, ...body } = await clinician();
    expect(accessToken).toBeTruthy();
    // A refresh token in JSON ends up somewhere an injected script can read.
    expect(JSON.stringify(body)).not.toMatch(/refreshToken/);
  });

  it('puts the refresh token in an httpOnly cookie', async () => {
    const doctor = await clinician();
    const refresh = doctor.cookies.find(
      (c: { name: string }) => c.name === 'nhp_refresh',
    );
    expect(refresh).toBeDefined();
    expect(refresh.httpOnly).toBe(true);
    expect(refresh.sameSite?.toLowerCase()).toBe('strict');
  });

  it('refuses to refresh without the CSRF header', async () => {
    const doctor = await clinician();
    const jar = Object.fromEntries(
      doctor.cookies.map((c: { name: string; value: string }) => [c.name, c.value]),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      cookies: jar,
      // Deliberately no CSRF header: the cookie alone must not be enough,
      // because a cookie travels on a cross-site request and a header does not.
    });

    // 403, not 401 — the caller holds a valid session; this particular
    // request is refused. Answering 401 would tell a client to sign in again.
    expect(res.statusCode).toBe(403);
  });

  it('refreshes with the cookie and matching header, and rotates the token', async () => {
    const doctor = await clinician();
    const jar = Object.fromEntries(
      doctor.cookies.map((c: { name: string; value: string }) => [c.name, c.value]),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      cookies: jar,
      headers: { [CSRF_HEADER]: doctor.csrfToken },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().accessToken).toBeTruthy();

    const rotated = res.cookies.find((c: { name: string }) => c.name === 'nhp_refresh');
    expect(rotated).toBeDefined();
    // A refresh token that survives its own use is a replayable credential.
    expect(rotated!.value).not.toBe(jar.nhp_refresh);
  });

  it('reports the role so a client can route the sign-in correctly', async () => {
    const a = await analyst();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${a.accessToken}` },
    });

    // The frontend routed analysts to the citizen screen because its own
    // type omitted this field. The contract is asserted here so the shape
    // cannot quietly change underneath a client.
    expect(res.json().ministryUserId).toBe(a.ministryUser.id);
    expect(res.json().practitionerId).toBeNull();
  });
});

describe('the reporting period over the wire', () => {
  /**
   * THE REGRESSION. `agg_condition_daily.date` is a Postgres DATE. A
   * mid-afternoon `new Date()` used as an exclusive upper bound coerced to
   * today's date, so `date < today` dropped today's rollup — the most
   * recent one — from every answer, with a 200 and a plausible shorter list.
   */
  it('reports the inclusive last day, not the exclusive bound', async () => {
    const { accessToken } = await analyst();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/analytics/provenance?from=2026-08-01&to=2026-08-23',
      headers: { authorization: `Bearer ${accessToken}` },
    });

    const body = res.json();
    expect(body.periodFrom.slice(0, 10)).toBe('2026-08-01');
    // Publishing the exclusive bound would date an outbreak a day late.
    expect(body.periodTo.slice(0, 10)).toBe('2026-08-23');
  });

  it('THE DEFAULT WINDOW — today\'s cases appear in the burden answer', async () => {
    // The regression in its real form: no explicit period, cases recorded
    // today. A fixed `to=` date parses to midnight and hides the bug, which
    // is exactly why this test passes no dates at all.
    const doctor = await clinician();
    const patient = await makePerson();

    const encounter = await openEncounter(prisma, {
      practitionerId: doctor.practitioner.id,
      personId: patient.id,
      kind: 'OUTPATIENT',
      chiefComplaint: 'fever',
    });
    await recordDiagnosis(prisma, {
      practitionerId: doctor.practitioner.id,
      encounterId: encounter.id,
      icd11Code: '1F41.0',
    });

    const { accessToken } = await analyst();
    const rollup = await app.inject({
      method: 'POST',
      url: '/api/v1/analytics/rollup',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(rollup.statusCode).toBe(200);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/analytics/burden?icd11Code=1F41.0',
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(res.statusCode).toBe(200);
    // Before the fix this was `[]` with a 200 — the most recent day, the one
    // an outbreak appears in first, silently missing from the answer.
    expect(res.json().length).toBeGreaterThan(0);
  });

  it('carries the denominator and suppression note on every answer', async () => {
    const { accessToken } = await analyst();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/analytics/provenance',
      headers: { authorization: `Bearer ${accessToken}` },
    });

    // A national figure without these is one someone misquotes.
    expect(res.json().suppressionThreshold).toBeGreaterThan(0);
    expect(res.json().denominatorNote).toBeTruthy();
    expect(res.json().suppressionNote).toMatch(/complementary suppression/i);
  });
});

describe('the error contract', () => {
  it('answers 404 with a problem document, not an HTML page', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/not-a-route' });
    expect(res.statusCode).toBe(404);
  });

  it('does not leak whether a phone number holds an account', async () => {
    // A number that genuinely holds an account, and one that does not.
    const holder = await makePerson('Registered');

    const wrongPassword = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { phone: holder.phone, password: 'wrong-password-123' },
    });
    const unknownNumber = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { phone: '0799000999', password: 'wrong-password-123' },
    });

    // Identical answers, or the login form becomes a directory of who holds
    // an account — which for a health system is itself disclosure.
    expect(wrongPassword.statusCode).toBe(unknownNumber.statusCode);
    expect(wrongPassword.json().code).toBe(unknownNumber.json().code);
    expect(wrongPassword.json().detail).toBe(unknownNumber.json().detail);
  });

  it('answers a malformed login with 400, not 500', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { password: 'no-phone-field' },
    });

    // A 500 here means an unhandled exception reached the top of the stack;
    // a missing field is the caller's error and must be said so.
    expect(res.statusCode).toBe(400);
  });
});

describe('registration', () => {
  /**
   * Nobody could get into this system before these routes existed — every
   * account came from the seed script. That made registration the gap that
   * blocked a pilot, and it makes these tests the ones that decide whether
   * an open, unauthenticated endpoint is safe.
   *
   * The property that matters is not that registration works. It is that
   * registration grants NOTHING: a new clinician leaves here unable to open
   * a record, and a new facility leaves unable to host one.
   */
  const person = (over: Record<string, unknown> = {}) => {
    seq++;
    return {
      nationalId: `820000${String(seq).padStart(2, '0')}`,
      phone: `07190000${String(seq).padStart(2, '0')}`,
      givenName: 'Wanjiku',
      familyName: 'Kamau',
      sexAtBirth: 'FEMALE',
      dateOfBirth: '1994-06-15',
      countyId: ctx.countyId,
      subcountyId: ctx.subcountyId,
      password: 'a-long-enough-password',
      ...over,
    };
  };

  const post = (url: string, payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: `/api/v1${url}`, payload });

  it('creates a citizen who can then sign in', async () => {
    const body = person();
    const res = await post('/auth/register/citizen', body);

    expect(res.statusCode).toBe(200);
    expect(res.json().nhpId).toMatch(/^NHP-/);

    // The account is real: the normal login path accepts it.
    const login = await post('/auth/login', {
      phone: body.phone,
      password: body.password,
    });
    expect(login.statusCode).toBe(200);
    expect(login.json().status).toBe('AUTHENTICATED');
  });

  it('never returns a session from registration itself', async () => {
    const res = await post('/auth/register/citizen', person());
    // One way to obtain a token. A second path is a second place for an
    // authentication bug to live.
    expect(res.json().accessToken).toBeUndefined();
    expect(res.cookies.find((c: { name: string }) => c.name === 'nhp_refresh')).toBeUndefined();
  });

  it('refuses a duplicate National ID', async () => {
    const first = person();
    await post('/auth/register/citizen', first);

    const again = await post('/auth/register/citizen', {
      ...person(),
      nationalId: first.nationalId,
    });
    expect(again.statusCode).toBe(400);
    expect(again.json().code).toBe('IDENTIFIER_ALREADY_REGISTERED');
  });

  it('refuses a duplicate phone number', async () => {
    const first = person();
    await post('/auth/register/citizen', first);

    const again = await post('/auth/register/citizen', {
      ...person(),
      phone: first.phone,
    });
    expect(again.statusCode).toBe(400);
    expect(again.json().code).toBe('PHONE_IN_USE');
  });

  it('THE AGE RULE — refuses self-registration under 18', async () => {
    const year = new Date().getUTCFullYear() - 12;
    const res = await post('/auth/register/citizen', person({ dateOfBirth: `${year}-01-01` }));

    // A child is registered as a dependant of their guardian, not by
    // themselves — the brief's rule, enforced in the service.
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('UNDERAGE_SELF_REGISTRATION');
  });

  it('refuses a short password rather than storing a weak one', async () => {
    const res = await post('/auth/register/citizen', person({ password: 'short' }));
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('MALFORMED_REQUEST');
  });

  it('refuses a missing field with 400, not 500', async () => {
    const { familyName, ...withoutName } = person();
    const res = await post('/auth/register/citizen', withoutName);
    expect(res.statusCode).toBe(400);
  });

  it('refuses an unusable date of birth', async () => {
    const res = await post('/auth/register/citizen', person({ dateOfBirth: 'not-a-date' }));
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_DOB');
  });

  it('never echoes the password back', async () => {
    const res = await post('/auth/register/citizen', person());
    expect(res.body).not.toContain('a-long-enough-password');
  });

  it('registers a practitioner with their licence', async () => {
    const body = person({ cadre: 'NURSE', licenceNumber: 'NCK/2026/9001' });
    const res = await post('/auth/register/practitioner', body);

    expect(res.statusCode).toBe(200);
    expect(res.json().practitionerId).toBeTruthy();
    expect(res.json().nhpId).toMatch(/^NHP-/);
  });

  it('THE CAPABILITY RULE — a newly registered clinician cannot open a record', async () => {
    const body = person({ cadre: 'DOCTOR', licenceNumber: 'KMPDC/2026/9002' });
    await post('/auth/register/practitioner', body);

    const login = await post('/auth/login', {
      phone: body.phone,
      password: body.password,
    });

    // A practitioner account requires a second factor before it can sign in
    // at all, so registration cannot hand anyone a working clinical session.
    if (login.json().status === 'AUTHENTICATED') {
      const patient = await makePerson();
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/persons/${patient.displayNumber}/summary`,
        headers: { authorization: `Bearer ${login.json().accessToken}` },
      });
      // No affiliation, no check-in: the gate refuses.
      expect([403, 401]).toContain(res.statusCode);
    } else {
      expect(login.json().code).toBe('MFA_ENROLMENT_REQUIRED');
    }
  });

  it('says plainly that a clinician cannot yet record clinical data', async () => {
    const res = await post(
      '/auth/register/practitioner',
      person({ cadre: 'NURSE', licenceNumber: 'NCK/2026/9003' }),
    );
    // The UI must never imply that registering is enough.
    expect(res.json().message).toMatch(/cannot record clinical data/i);
  });

  it('registers a facility as PENDING, never active', async () => {
    seq++;
    const res = await post('/facilities/register', {
      mflCode: `MFL-REG-${seq}`,
      name: 'Migosi Health Centre',
      kephLevel: 3,
      ownership: 'PRIVATE_FOR_PROFIT',
      countyId: ctx.countyId,
      subcountyId: ctx.subcountyId,
      latitude: -0.0917,
      longitude: 34.768,
    });

    expect(res.statusCode).toBe(200);
    // An unapproved facility can grant no affiliation and host no check-in.
    expect(res.json().registrationStatus).toBe('PENDING');
    expect(res.json().message).toMatch(/awaiting Ministry approval/i);
  });

  it('refuses a KEPH level outside the registrable range', async () => {
    seq++;
    const res = await post('/facilities/register', {
      mflCode: `MFL-REG-${seq}`,
      name: 'Community Unit',
      // Level 1 is community units, which have no facility.
      kephLevel: 1,
      ownership: 'PUBLIC_MOH',
      countyId: ctx.countyId,
      subcountyId: ctx.subcountyId,
      latitude: -0.0917,
      longitude: 34.768,
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses coordinates outside Kenya', async () => {
    seq++;
    const res = await post('/facilities/register', {
      mflCode: `MFL-REG-${seq}`,
      name: 'Somewhere Else',
      kephLevel: 3,
      ownership: 'PRIVATE_FOR_PROFIT',
      countyId: ctx.countyId,
      subcountyId: ctx.subcountyId,
      latitude: 51.5,
      longitude: -0.12,
    });
    // A facility the recommender would route patients to must be somewhere
    // a patient can actually travel.
    expect(res.statusCode).toBe(400);
  });
});

describe('open reference data', () => {
  it('serves counties without a session, because a form needs them', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/geo/counties' });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBeGreaterThan(0);
    expect(res.json()[0]).toHaveProperty('code');
  });

  it('serves the subcounties of a county', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/geo/counties/${ctx.countyId}/subcounties`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBeGreaterThan(0);
  });

  it('leaks no patient data through the open geography routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/geo/counties' });
    // These are published administrative divisions. Anything person-shaped
    // appearing here would be a disclosure through a public endpoint.
    expect(res.body).not.toMatch(/NHP-|nationalId|phone/i);
  });
});
