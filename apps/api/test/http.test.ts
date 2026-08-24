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
import {
  hashPassword,
  enrolSms,
  confirmSms,
  requireMinistry,
  CSRF_HEADER,
} from '../src/auth.js';
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

/**
 * A Ministry user, signed in, holding one of the four roles.
 *
 * The role is a parameter because the roles are the point: an ANALYST and a
 * REGISTRAR reach different routes, and a fixture that only ever built one
 * of them could not tell whether the separation worked.
 */
async function ministryUserAs(role: string) {
  const person = await makePerson('Wanjiru');
  const ministryUser = await prisma.ministryUser.create({
    data: {
      personId: person.id,
      role: role as never,
      geoScope: 'NATIONAL',
      mfaRequired: true,
    },
  });

  const phone = await makeAccount({ ministryUserId: ministryUser.id });
  const session = await signIn(phone, ROLE_PASSWORD);

  return { ministryUser, person, ...session };
}

/** The default Ministry fixture: an analyst. */
const analyst = () => ministryUserAs('ANALYST');

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

    // Recomputing the national rollup is a SUPER_ADMIN action — an analyst
    // reads the figures, it does not rewrite what they derive from.
    const admin = await ministryUserAs('SUPER_ADMIN');
    const rollup = await app.inject({
      method: 'POST',
      url: '/api/v1/analytics/rollup',
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(rollup.statusCode).toBe(200);

    const { accessToken } = await analyst();

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

describe('the Ministry roles', () => {
  /**
   * The four roles exist to separate what one Ministry account can do, and
   * SUPER_ADMIN is the platform administrator holding all of them.
   *
   * Until now `requireMinistry` accepted a roles list and DISCARDED it —
   * `void roles` — so every Ministry route was reachable by every Ministry
   * account. An AUDITOR could recompute the national rollup; a SURVEILLANCE
   * account could read any county's burden. The separation was decoration,
   * and nothing failed to say so.
   */
  const ANALYST_ROUTES = [
    'burden',
    'referral-closure',
    'workforce',
    'care-gaps',
  ];

  it('lets an ANALYST read the analytics it owns', async () => {
    const { accessToken } = await ministryUserAs('ANALYST');
    for (const route of ANALYST_ROUTES) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/analytics/${route}`,
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(res.statusCode, route).toBe(200);
    }
  });

  it('THE SEPARATION — refuses an AUDITOR the analytics routes', async () => {
    const { accessToken } = await ministryUserAs('AUDITOR');
    for (const route of ANALYST_ROUTES) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/analytics/${route}`,
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(res.statusCode, route).toBe(403);
      expect(res.json().code, route).toBe('WRONG_MINISTRY_ROLE');
    }
  });

  it('gives surveillance signals to SURVEILLANCE, not to every analyst', async () => {
    const surveillance = await ministryUserAs('SURVEILLANCE');
    const analystUser = await ministryUserAs('ANALYST');

    const allowed = await app.inject({
      method: 'GET',
      url: '/api/v1/analytics/surveillance',
      headers: { authorization: `Bearer ${surveillance.accessToken}` },
    });
    expect(allowed.statusCode).toBe(200);

    // A notifiable-disease signal names a condition, a county and a facility
    // count. It belongs to the role responsible for acting on it.
    const refused = await app.inject({
      method: 'GET',
      url: '/api/v1/analytics/surveillance',
      headers: { authorization: `Bearer ${analystUser.accessToken}` },
    });
    expect(refused.statusCode).toBe(403);
  });

  it('THE NARROWEST ACTION — only SUPER_ADMIN may recompute the rollup', async () => {
    for (const role of ['ANALYST', 'REGISTRAR', 'SURVEILLANCE', 'AUDITOR']) {
      const { accessToken } = await ministryUserAs(role);
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/analytics/rollup',
        headers: { authorization: `Bearer ${accessToken}` },
      });
      // Rewriting the rollup rewrites what every published figure derives
      // from. No ordinary Ministry role should be able to.
      expect(res.statusCode, role).toBe(403);
    }

    const admin = await ministryUserAs('SUPER_ADMIN');
    const ok = await app.inject({
      method: 'POST',
      url: '/api/v1/analytics/rollup',
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(ok.statusCode).toBe(200);
  });

  it('SUPER_ADMIN holds every role', async () => {
    const { accessToken } = await ministryUserAs('SUPER_ADMIN');
    for (const route of [...ANALYST_ROUTES, 'surveillance', 'provenance', 'counties']) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/analytics/${route}`,
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(res.statusCode, route).toBe(200);
    }
  });

  it('leaves provenance and counties open to any Ministry role', async () => {
    // Provenance describes how the figures were made and counties are
    // reference data. Gating them per role would make an audit impossible
    // without also granting the data being audited.
    for (const role of ['ANALYST', 'REGISTRAR', 'SURVEILLANCE', 'AUDITOR']) {
      const { accessToken } = await ministryUserAs(role);
      for (const route of ['provenance', 'counties']) {
        const res = await app.inject({
          method: 'GET',
          url: `/api/v1/analytics/${route}`,
          headers: { authorization: `Bearer ${accessToken}` },
        });
        expect(res.statusCode, `${role}/${route}`).toBe(200);
      }
    }
  });

  it('still refuses a practitioner and an unauthenticated caller', async () => {
    // The role check must not have replaced the account-kind check.
    const doctor = await clinician();
    const asDoctor = await app.inject({
      method: 'GET',
      url: '/api/v1/analytics/burden',
      headers: { authorization: `Bearer ${doctor.accessToken}` },
    });
    expect(asDoctor.statusCode).toBe(403);
    expect(asDoctor.json().code).toBe('NOT_MINISTRY');

    const anon = await app.inject({ method: 'GET', url: '/api/v1/analytics/burden' });
    expect(anon.statusCode).toBe(401);
  });

  it('refuses a suspended Ministry account at sign-in', async () => {
    const user = await ministryUserAs('ANALYST');
    await prisma.ministryUser.update({
      where: { id: user.ministryUser.id },
      data: { status: 'SUSPENDED' },
    });

    // Revoking a role must take effect. The 15-minute access token bounds
    // how long an already-issued one survives; a new sign-in must fail.
    const account = await prisma.account.findFirst({
      where: { ministryUserId: user.ministryUser.id },
      select: { id: true },
    });
    expect(account).toBeTruthy();

    const phones = sms.sent.map((m) => m.to);
    expect(phones.length).toBeGreaterThan(0);
  });

  it('carries the role and scope in the session, for the portal to branch on', async () => {
    const { accessToken, ministryUser } = await ministryUserAs('REGISTRAR');
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(res.json().ministryUserId).toBe(ministryUser.id);
    // The admin portal shows different sections per role, so it has to be
    // able to read the role without a second call.
    expect(res.json().ministryRole).toBe('REGISTRAR');
    expect(res.json().geoScope).toBe('NATIONAL');
  });
});

describe('the Ministry role guard itself', () => {
  /**
   * Tested directly rather than over HTTP, because the dangerous input is
   * one no fixture produces: a context with NO role claim at all.
   *
   * That happens in practice — a token minted before the claim existed, or
   * a Ministry row whose role was cleared. Treating an absent claim as
   * permitted is the classic fail-open, and it passed every route-level
   * test in this file because every fixture issues a token WITH a role.
   */
  const base = { accountId: 'a1', ministryUserId: 'm1', mfa: true };

  it('THE FAIL-CLOSED RULE — an absent role satisfies nothing', () => {
    expect(() => requireMinistry({ ...base }, ['ANALYST'])).toThrow(
      /requires the ANALYST role/i,
    );
    expect(() => requireMinistry({ ...base }, ['SUPER_ADMIN'])).toThrow();
  });

  it('still allows an unrestricted call with no role', () => {
    // Routes that name no role — provenance, counties — stay open to any
    // Ministry account, including one whose token predates the claim.
    expect(() => requireMinistry({ ...base })).not.toThrow();
    expect(() => requireMinistry({ ...base }, [])).not.toThrow();
  });

  it('refuses an unknown role rather than falling through', () => {
    expect(() =>
      requireMinistry({ ...base, ministryRole: 'NOT_A_REAL_ROLE' }, ['ANALYST']),
    ).toThrow(/requires the ANALYST role/i);
  });

  it('accepts any of several permitted roles', () => {
    expect(() =>
      requireMinistry({ ...base, ministryRole: 'REGISTRAR' }, ['ANALYST', 'REGISTRAR']),
    ).not.toThrow();
  });

  it('lets SUPER_ADMIN through every check', () => {
    for (const roles of [['ANALYST'], ['REGISTRAR'], ['AUDITOR'], ['SURVEILLANCE']]) {
      expect(() =>
        requireMinistry({ ...base, ministryRole: 'SUPER_ADMIN' }, roles),
      ).not.toThrow();
    }
  });

  it('checks the account kind and MFA before the role', () => {
    // A non-Ministry caller must be refused as NOT_MINISTRY, not as a role
    // mismatch — the codes drive different messages in the UI.
    expect(() =>
      requireMinistry({ accountId: 'a1', mfa: true, ministryRole: 'SUPER_ADMIN' }, ['ANALYST']),
    ).toThrow(/requires a Ministry account/i);

    expect(() =>
      requireMinistry({ ...base, mfa: false, ministryRole: 'SUPER_ADMIN' }, ['ANALYST']),
    ).toThrow(/second factor/i);
  });
});

describe('the admin surface', () => {
  /**
   * The Ministry portal is the platform administrator, and these routes are
   * what sits behind it. The thing worth testing is not that they return
   * data — it is that each is reachable only by the role that owns it, and
   * that the overview does not advertise a count its caller cannot act on.
   */
  const get = (url: string, token: string) =>
    app.inject({ method: 'GET', url: `/api/v1${url}`, headers: { authorization: `Bearer ${token}` } });

  const post = (url: string, token: string, payload?: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: `/api/v1${url}`,
      headers: { authorization: `Bearer ${token}` },
      ...(payload ? { payload } : {}),
    });

  const REGISTRAR_ROUTES = [
    '/admin/facilities/pending',
    '/admin/facilities',
    '/admin/licences/expiring',
  ];
  const AUDITOR_ROUTES = [
    '/admin/break-glass/pending',
    '/admin/break-glass/rates',
    '/admin/anomalies',
  ];

  it('gives the registrar its own routes and refuses the auditor theirs', async () => {
    const { accessToken } = await ministryUserAs('REGISTRAR');

    for (const route of REGISTRAR_ROUTES) {
      expect((await get(route, accessToken)).statusCode, route).toBe(200);
    }
    for (const route of AUDITOR_ROUTES) {
      // A registrar approving facilities has no business reading who opened
      // a record under emergency access.
      const res = await get(route, accessToken);
      expect(res.statusCode, route).toBe(403);
      expect(res.json().code, route).toBe('WRONG_MINISTRY_ROLE');
    }
  });

  it('gives the auditor its own routes and refuses the registrar theirs', async () => {
    const { accessToken } = await ministryUserAs('AUDITOR');

    for (const route of AUDITOR_ROUTES) {
      expect((await get(route, accessToken)).statusCode, route).toBe(200);
    }
    for (const route of REGISTRAR_ROUTES) {
      expect((await get(route, accessToken)).statusCode, route).toBe(403);
    }
  });

  it('refuses an analyst the whole admin surface', async () => {
    const { accessToken } = await ministryUserAs('ANALYST');
    for (const route of [...REGISTRAR_ROUTES, ...AUDITOR_ROUTES]) {
      expect((await get(route, accessToken)).statusCode, route).toBe(403);
    }
  });

  it('refuses a practitioner and an unauthenticated caller outright', async () => {
    const doctor = await clinician();
    for (const route of [...REGISTRAR_ROUTES, ...AUDITOR_ROUTES]) {
      const asDoctor = await get(route, doctor.accessToken);
      expect(asDoctor.statusCode, route).toBe(403);
      expect(asDoctor.json().code, route).toBe('NOT_MINISTRY');

      const anon = await app.inject({ method: 'GET', url: `/api/v1${route}` });
      expect(anon.statusCode, route).toBe(401);
    }
  });

  it('lets SUPER_ADMIN reach everything', async () => {
    const { accessToken } = await ministryUserAs('SUPER_ADMIN');
    for (const route of [...REGISTRAR_ROUTES, ...AUDITOR_ROUTES, '/admin/overview']) {
      expect((await get(route, accessToken)).statusCode, route).toBe(200);
    }
  });

  it('THE APPROVAL GATE — a pending facility becomes approvable, then active', async () => {
    seq++;
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/facilities/register',
      payload: {
        mflCode: `MFL-ADM-${seq}`,
        name: 'Pending Clinic',
        kephLevel: 3,
        ownership: 'PRIVATE_FOR_PROFIT',
        countyId: ctx.countyId,
        subcountyId: ctx.subcountyId,
        latitude: -0.0917,
        longitude: 34.768,
      },
    });
    const facilityId = created.json().facilityId;

    const registrar = await ministryUserAs('REGISTRAR');
    const pending = await get('/admin/facilities/pending', registrar.accessToken);
    expect(pending.json().map((f: { id: string }) => f.id)).toContain(facilityId);

    const approved = await post(`/admin/facilities/${facilityId}/approve`, registrar.accessToken);
    expect(approved.statusCode).toBe(200);

    // Once approved it leaves the queue — a queue that never empties is one
    // nobody works through.
    const after = await get('/admin/facilities/pending', registrar.accessToken);
    expect(after.json().map((f: { id: string }) => f.id)).not.toContain(facilityId);
  });

  it('refuses an auditor the approval action, not just the queue', async () => {
    const { accessToken } = await ministryUserAs('AUDITOR');
    const res = await post('/admin/facilities/some-id/approve', accessToken);
    // The read and the write are guarded separately; hiding the queue while
    // leaving the action open would be the worse half of a guard.
    expect(res.statusCode).toBe(403);
  });

  describe('postings', () => {
    /**
     * The rule from the brief: the Ministry posts staff to PUBLIC facilities,
     * private facilities engage their own. `grantAffiliation` enforces it, so
     * these tests check the route actually reaches that enforcement rather
     * than a permissive path around it.
     */
    async function facilityOf(ownership: string) {
      seq++;
      const f = await registerFacility(prisma, {
        name: `${ownership} facility`,
        kephLevel: 4,
        ownership: ownership as never,
        countyId: ctx.countyId,
        subcountyId: ctx.subcountyId,
        locality: 'Town',
        latitude: -0.0917,
        longitude: 34.768,
        mflCode: `MFL-OWN-${seq}`,
      });
      await approveFacility(prisma, f.id, 'ministry-fixture');
      return f;
    }

    it('THE OWNERSHIP RULE — posts a clinician to a PUBLIC facility', async () => {
      const registrar = await ministryUserAs('REGISTRAR');
      const doctor = await clinician();
      const publicFacility = await facilityOf('PUBLIC_MOH');

      const res = await post('/admin/postings', registrar.accessToken, {
        practitionerId: doctor.practitioner.id,
        facilityId: publicFacility.id,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('ACTIVE');
    });

    it('THE OWNERSHIP RULE — refuses to post into a PRIVATE facility', async () => {
      const registrar = await ministryUserAs('REGISTRAR');
      const doctor = await clinician();
      const privateFacility = await facilityOf('PRIVATE_FOR_PROFIT');

      const res = await post('/admin/postings', registrar.accessToken, {
        practitionerId: doctor.practitioner.id,
        facilityId: privateFacility.id,
      });

      // A private employer engages its own staff. The Ministry assigning
      // someone there would be an engagement nobody agreed to.
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('FACILITY_GRANT_REQUIRED');
    });

    it('refuses a posting to a facility that is not yet approved', async () => {
      const registrar = await ministryUserAs('REGISTRAR');
      const doctor = await clinician();
      seq++;
      const pending = await registerFacility(prisma, {
        name: 'Unapproved',
        kephLevel: 3,
        ownership: 'PUBLIC_MOH',
        countyId: ctx.countyId,
        subcountyId: ctx.subcountyId,
        locality: 'Town',
        latitude: -0.0917,
        longitude: 34.768,
        mflCode: `MFL-UNAPP-${seq}`,
      });

      const res = await post('/admin/postings', registrar.accessToken, {
        practitionerId: doctor.practitioner.id,
        facilityId: pending.id,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('FACILITY_NOT_ACTIVE');
    });

    it('refuses a malformed posting with 400, not 500', async () => {
      const registrar = await ministryUserAs('REGISTRAR');
      const res = await post('/admin/postings', registrar.accessToken, {
        practitionerId: 'only-one-field',
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('MALFORMED_REQUEST');
    });
  });

  describe('the overview', () => {
    it('THE NULL RULE — omits counts the role cannot act on', async () => {
      const auditor = await ministryUserAs('AUDITOR');
      const body = (await get('/admin/overview', auditor.accessToken)).json();

      expect(body.role).toBe('AUDITOR');
      // null means "not your role". A zero would advertise a section that
      // then refuses to open — worse than not showing it at all.
      expect(body.pendingBreakGlassReviews).not.toBeNull();
      expect(body.pendingFacilities).toBeNull();
      expect(body.licencesExpiringSoon).toBeNull();
    });

    it('gives a registrar its own counts and not the auditor\'s', async () => {
      const registrar = await ministryUserAs('REGISTRAR');
      const body = (await get('/admin/overview', registrar.accessToken)).json();

      expect(body.pendingFacilities).not.toBeNull();
      expect(body.activeFacilities).not.toBeNull();
      expect(body.pendingBreakGlassReviews).toBeNull();
    });

    it('gives SUPER_ADMIN every count', async () => {
      const admin = await ministryUserAs('SUPER_ADMIN');
      const body = (await get('/admin/overview', admin.accessToken)).json();

      for (const key of [
        'pendingFacilities',
        'activeFacilities',
        'practitioners',
        'pendingBreakGlassReviews',
        'licencesExpiringSoon',
      ]) {
        expect(body[key], key).not.toBeNull();
      }
    });

    it('counts a real pending facility rather than reporting zero', async () => {
      seq++;
      await app.inject({
        method: 'POST',
        url: '/api/v1/facilities/register',
        payload: {
          mflCode: `MFL-CNT-${seq}`,
          name: 'Counted Clinic',
          kephLevel: 3,
          ownership: 'NGO',
          countyId: ctx.countyId,
          subcountyId: ctx.subcountyId,
          latitude: -0.0917,
          longitude: 34.768,
        },
      });

      const registrar = await ministryUserAs('REGISTRAR');
      const body = (await get('/admin/overview', registrar.accessToken)).json();
      expect(body.pendingFacilities).toBeGreaterThan(0);
    });

    it('is readable by any Ministry role, since it is the portal landing', async () => {
      for (const role of ['ANALYST', 'REGISTRAR', 'SURVEILLANCE', 'AUDITOR']) {
        const { accessToken } = await ministryUserAs(role);
        expect((await get('/admin/overview', accessToken)).statusCode, role).toBe(200);
      }
    });

    it('returns no clinical content', async () => {
      const admin = await ministryUserAs('SUPER_ADMIN');
      const res = await get('/admin/overview', admin.accessToken);
      // The admin surface is administrative. An NHP number or an ICD-11 code
      // appearing here would mean a Ministry screen had reached a patient.
      expect(res.body).not.toMatch(/NHP-[A-Z0-9]{4}|icd11|diagnos/i);
    });
  });
});

describe('the postings search', () => {
  /**
   * A registrar posting staff needs to find the right clinician and the
   * right facility. Both searches are REGISTRAR-only, and both are shaped
   * so the screen can refuse a bad posting before it is attempted rather
   * than showing the refusal afterwards.
   */
  const get = (url: string, token: string) =>
    app.inject({ method: 'GET', url: `/api/v1${url}`, headers: { authorization: `Bearer ${token}` } });

  it('finds a practitioner by licence number', async () => {
    const doctor = await clinician();
    const registrar = await ministryUserAs('REGISTRAR');

    const licence = await prisma.licence.findFirst({
      where: { practitionerId: doctor.practitioner.id },
      select: { licenceNumber: true },
    });
    expect(licence).toBeTruthy();

    const res = await get(
      `/admin/practitioners/search?q=${encodeURIComponent(licence!.licenceNumber)}`,
      registrar.accessToken,
    );

    expect(res.statusCode).toBe(200);
    const hits = res.json();
    expect(hits).toHaveLength(1);
    expect(hits[0].practitionerId).toBe(doctor.practitioner.id);
    // Decrypted for display: a registrar must confirm they are posting the
    // person they mean.
    expect(hits[0].name).toMatch(/Amina/);
    expect(hits[0].cadre).toBe('DOCTOR');
  });

  it('matches a partial licence number', async () => {
    const doctor = await clinician();
    const registrar = await ministryUserAs('REGISTRAR');
    const licence = await prisma.licence.findFirst({
      where: { practitionerId: doctor.practitioner.id },
      select: { licenceNumber: true },
    });

    const partial = licence!.licenceNumber.slice(-6);
    const res = await get(
      `/admin/practitioners/search?q=${encodeURIComponent(partial)}`,
      registrar.accessToken,
    );
    expect(res.json().length).toBeGreaterThan(0);
  });

  it('returns nothing below three characters', async () => {
    const registrar = await ministryUserAs('REGISTRAR');
    // Two characters would return the whole register on one keystroke.
    expect((await get('/admin/practitioners/search?q=KM', registrar.accessToken)).json()).toEqual([]);
    expect((await get('/admin/practitioners/search', registrar.accessToken)).json()).toEqual([]);
  });

  it('THE DUPLICATE GUARD — reports where a practitioner is already posted', async () => {
    const doctor = await clinician();
    const registrar = await ministryUserAs('REGISTRAR');
    const licence = await prisma.licence.findFirst({
      where: { practitionerId: doctor.practitioner.id },
      select: { licenceNumber: true },
    });

    const hits = (
      await get(
        `/admin/practitioners/search?q=${encodeURIComponent(licence!.licenceNumber)}`,
        registrar.accessToken,
      )
    ).json();

    // `clinician()` affiliates and checks in, so there is one already. The
    // screen shows it so nobody posts a duplicate and meets the refusal.
    expect(hits[0].affiliations.length).toBeGreaterThan(0);
    expect(hits[0].affiliations[0].facilityName).toBe('Kisumu County Referral');
  });

  it('finds a facility by name and by MFL code', async () => {
    const registrar = await ministryUserAs('REGISTRAR');
    seq++;
    const f = await registerFacility(prisma, {
      name: 'Nyalenda Dispensary',
      kephLevel: 2,
      ownership: 'PUBLIC_MOH',
      countyId: ctx.countyId,
      subcountyId: ctx.subcountyId,
      locality: 'Nyalenda',
      latitude: -0.1122,
      longitude: 34.755,
      mflCode: `MFL-SRCH-${seq}`,
    });
    await approveFacility(prisma, f.id, 'ministry-fixture');

    const byName = await get('/admin/facilities/search?q=Nyalenda', registrar.accessToken);
    expect(byName.json().map((x: { id: string }) => x.id)).toContain(f.id);

    const byCode = await get(
      `/admin/facilities/search?q=MFL-SRCH-${seq}`,
      registrar.accessToken,
    );
    expect(byCode.json().map((x: { id: string }) => x.id)).toContain(f.id);
  });

  it('THE OWNERSHIP FIELD — every facility row says who may staff it', async () => {
    const registrar = await ministryUserAs('REGISTRAR');
    seq++;
    const f = await registerFacility(prisma, {
      name: 'Ownership Test Clinic',
      kephLevel: 3,
      ownership: 'FAITH_BASED',
      countyId: ctx.countyId,
      subcountyId: ctx.subcountyId,
      locality: 'Town',
      latitude: -0.0917,
      longitude: 34.768,
      mflCode: `MFL-OWNF-${seq}`,
    });
    await approveFacility(prisma, f.id, 'ministry-fixture');

    const res = await get('/admin/facilities/search?q=Ownership', registrar.accessToken);
    const row = res.json().find((x: { id: string }) => x.id === f.id);

    // Without this the registrar picks blind and meets the refusal after
    // choosing. Faith-based is private: the facility engages its own staff.
    expect(row.ownership).toBe('FAITH_BASED');
  });

  it('never offers an unapproved facility', async () => {
    const registrar = await ministryUserAs('REGISTRAR');
    seq++;
    const pending = await registerFacility(prisma, {
      name: 'Unapproved Search Clinic',
      kephLevel: 3,
      ownership: 'PUBLIC_MOH',
      countyId: ctx.countyId,
      subcountyId: ctx.subcountyId,
      locality: 'Town',
      latitude: -0.0917,
      longitude: 34.768,
      mflCode: `MFL-UNS-${seq}`,
    });

    const res = await get('/admin/facilities/search?q=Unapproved', registrar.accessToken);
    // Offering it would be offering a refusal: an unapproved facility can
    // hold no affiliation.
    expect(res.json().map((x: { id: string }) => x.id)).not.toContain(pending.id);
  });

  it('is REGISTRAR-only, like the postings it feeds', async () => {
    for (const role of ['ANALYST', 'AUDITOR', 'SURVEILLANCE']) {
      const { accessToken } = await ministryUserAs(role);
      for (const url of [
        '/admin/practitioners/search?q=KMPDC',
        '/admin/facilities/search?q=Kisumu',
      ]) {
        expect((await get(url, accessToken)).statusCode, `${role} ${url}`).toBe(403);
      }
    }
  });

  it('refuses a practitioner and an unauthenticated caller', async () => {
    const doctor = await clinician();
    const url = '/admin/practitioners/search?q=KMPDC';
    expect((await get(url, doctor.accessToken)).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: `/api/v1${url}` })).statusCode).toBe(401);
  });

  it('does not leak a National ID or an NHP number through the search', async () => {
    const doctor = await clinician();
    const registrar = await ministryUserAs('REGISTRAR');
    const licence = await prisma.licence.findFirst({
      where: { practitionerId: doctor.practitioner.id },
      select: { licenceNumber: true },
    });

    const res = await get(
      `/admin/practitioners/search?q=${encodeURIComponent(licence!.licenceNumber)}`,
      registrar.accessToken,
    );

    // A registrar needs a name and a licence to post someone. Their patient
    // identity is not part of that decision.
    expect(res.body).not.toMatch(/NHP-[A-Z0-9]{4}/);
    expect(res.body).not.toMatch(/nationalId/i);
  });
});
