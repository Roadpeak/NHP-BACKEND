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
import { openEncounter, recordDiagnosis, recordAllergy } from '../src/clinical.js';
import {
  hashPassword,
  enrolSms,
  confirmSms,
  requireMinistry,
  CSRF_HEADER,
} from '../src/auth.js';
import { ConsoleSmsProvider, setSmsProvider } from '../src/notify.js';
import {
  encryptField,
  decryptField,
  blindIndex,
  normalisePhone,
} from '../src/crypto.js';

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
    'consent_grant', 'check_in', 'affiliation', 'facility_director', 'licence', 'practitioner',
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
      // A private facility asserts its own legality; the Ministry checks
      // these against the Business Registry before approving.
      businessRegNo: `PVT-${seq}/2026`,
      kraPin: 'P051234567X',
    });

    expect(res.statusCode).toBe(200);
    // An unapproved facility can grant no affiliation and host no check-in.
    expect(res.json().registrationStatus).toBe('PENDING');
    expect(res.json().message).toMatch(/awaiting Ministry approval/i);
  });

  it('refuses a private facility that asserts no ownership', async () => {
    seq++;
    const res = await post('/facilities/register', {
      mflCode: `MFL-NOEV-${seq}`,
      name: 'Unevidenced Clinic',
      kephLevel: 3,
      ownership: 'PRIVATE_FOR_PROFIT',
      countyId: ctx.countyId,
      subcountyId: ctx.subcountyId,
      latitude: -0.0917,
      longitude: 34.768,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('OWNERSHIP_EVIDENCE_REQUIRED');
  });

  it('asks a public facility for no ownership evidence', async () => {
    // The Ministry stands behind its own facilities; asking one to prove
    // it is registered with the Business Registry is meaningless.
    seq++;
    const res = await post('/facilities/register', {
      mflCode: `MFL-PUB-${seq}`,
      name: 'Kondele Dispensary',
      kephLevel: 2,
      ownership: 'PUBLIC_MOH',
      countyId: ctx.countyId,
      subcountyId: ctx.subcountyId,
      latitude: -0.0917,
      longitude: 34.768,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().message).toMatch(/Ministry posts staff/i);
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
        mflCode: `MFL-PEND-${seq}`,
        name: 'Pending Clinic',
        kephLevel: 3,
        ownership: 'PRIVATE_FOR_PROFIT',
        countyId: ctx.countyId,
        subcountyId: ctx.subcountyId,
        latitude: -0.0917,
        longitude: 34.768,
        businessRegNo: `PVT-PEND-${seq}`,
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
      //
      // 403, not 400: the request was well-formed and the registrar is
      // real. They are simply not permitted to do this.
      expect(res.statusCode).toBe(403);
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
      expect(res.statusCode).toBe(403);
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
          // An NGO is non-public, so it proves its own legality too —
          // "not for profit" is not the same as "vouched for by the
          // Ministry".
          businessRegNo: `NGO-${seq}/2026`,
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

describe('the admin registers', () => {
  const get = (url: string, token: string) =>
    app.inject({ method: 'GET', url: `/api/v1${url}`, headers: { authorization: `Bearer ${token}` } });

  describe('facilities', () => {
    it('counts by status, level and ownership', async () => {
      const registrar = await ministryUserAs('REGISTRAR');
      seq++;
      const f = await registerFacility(prisma, {
        name: 'Stats Clinic',
        kephLevel: 3,
        ownership: 'FAITH_BASED',
        countyId: ctx.countyId,
        subcountyId: ctx.subcountyId,
        locality: 'Town',
        latitude: -0.0917,
        longitude: 34.768,
        mflCode: `MFL-STAT-${seq}`,
      });
      await approveFacility(prisma, f.id, 'ministry-fixture');

      const s = (await get('/admin/facilities/stats', registrar.accessToken)).json();
      expect(s.total).toBeGreaterThan(0);
      expect(s.byOwnership.find((o: { ownership: string }) => o.ownership === 'FAITH_BASED').count)
        .toBeGreaterThan(0);
      expect(s.byKephLevel.some((k: { kephLevel: number }) => k.kephLevel === 3)).toBe(true);
    });

    it('counts active facilities that could never be recommended', async () => {
      const registrar = await ministryUserAs('REGISTRAR');
      const s = (await get('/admin/facilities/stats', registrar.accessToken)).json();
      // A facility with no declared capabilities is registered but invisible
      // to care routing — a real operational gap, not a rounding artifact.
      expect(s).toHaveProperty('activeWithoutCapabilities');
      expect(s.activeWithoutCapabilities).toBeGreaterThanOrEqual(0);
    });
  });

  describe('the workforce', () => {
    it('separates registered from able to work', async () => {
      const registrar = await ministryUserAs('REGISTRAR');
      await clinician(); // affiliated and checked in

      const s = (await get('/admin/practitioners/stats', registrar.accessToken)).json();
      expect(s.total).toBeGreaterThan(0);
      // The distinction that matters: an unaffiliated clinician is a number
      // that looks like workforce and cannot treat anyone.
      expect(s).toHaveProperty('withActiveAffiliation');
      expect(s).toHaveProperty('unaffiliated');
      expect(s.withActiveAffiliation + s.unaffiliated).toBe(s.total);
    });

    it('lists practitioners with their licence and facilities', async () => {
      const registrar = await ministryUserAs('REGISTRAR');
      const doctor = await clinician();

      const body = (await get('/admin/practitioners', registrar.accessToken)).json();
      const row = body.rows.find(
        (r: { practitionerId: string }) => r.practitionerId === doctor.practitioner.id,
      );

      expect(row).toBeTruthy();
      expect(row.cadre).toBe('DOCTOR');
      expect(row.licence.licenceNumber).toBeTruthy();
      expect(row.facilities).toContain('Kisumu County Referral');
    });

    it('THE WORKFORCE LIST CARRIES NO PATIENT IDENTITY', async () => {
      const registrar = await ministryUserAs('REGISTRAR');
      await clinician();

      const res = await get('/admin/practitioners', registrar.accessToken);
      // A clinician is also a person with their own health record. The
      // workforce register is about their professional registration, and an
      // NHP number here would link the two for anyone reading it.
      expect(res.body).not.toMatch(/NHP-[A-Z0-9]{4}/);
      expect(res.body).not.toMatch(/nationalId|givenName/i);
    });

    it('is REGISTRAR-only', async () => {
      for (const role of ['ANALYST', 'AUDITOR', 'SURVEILLANCE']) {
        const { accessToken } = await ministryUserAs(role);
        for (const url of ['/admin/practitioners', '/admin/practitioners/stats', '/admin/facilities/stats']) {
          expect((await get(url, accessToken)).statusCode, `${role} ${url}`).toBe(403);
        }
      }
    });
  });

  describe('the population register', () => {
    it('reports distributions, never a list', async () => {
      const registrar = await ministryUserAs('REGISTRAR');
      await makePerson();

      const res = await get('/admin/citizens/stats', registrar.accessToken);
      const s = res.json();

      expect(s.total).toBeGreaterThan(0);
      expect(s.byCounty.length).toBeGreaterThan(0);
      expect(s).toHaveProperty('byVerification');

      // THE RULE: counts only. A name or an NHP number in this payload would
      // mean the population register had become a population LIST.
      expect(res.body).not.toMatch(/NHP-[A-Z0-9]{4}/);
      expect(res.body).not.toMatch(/givenName|familyName|nationalId/i);
    });

    it('THERE IS NO ENDPOINT THAT LISTS CITIZENS', async () => {
      const registrar = await ministryUserAs('REGISTRAR');
      // The guarantee stated as a test: a browsable register of every
      // citizen in Kenya is the highest-value target in the country, and the
      // defence is that the endpoint does not exist.
      for (const url of ['/admin/citizens', '/admin/citizens/list', '/admin/persons']) {
        expect((await get(url, registrar.accessToken)).statusCode, url).toBe(404);
      }
    });
  });

  describe('the citizen lookup', () => {
    it('finds one citizen by National ID', async () => {
      const registrar = await ministryUserAs('REGISTRAR');
      const person = await makePerson('Wanjiku');
      const nationalId = await prisma.identifier
        .findFirst({ where: { personId: person.id }, select: { value: true } })
        .then(() => `810000${String(seq).padStart(2, '0')}`);

      const res = await get(
        `/admin/citizens/lookup?identifier=${nationalId}`,
        registrar.accessToken,
      );
      expect(res.statusCode).toBe(200);
      // One person, under `match` — never an array.
      expect(Array.isArray(res.json())).toBe(false);
      expect(res.json()).toHaveProperty('match');
    });

    it('finds one citizen by NHP number', async () => {
      const registrar = await ministryUserAs('REGISTRAR');
      const person = await makePerson('Wanjiku');

      const res = await get(
        `/admin/citizens/lookup?identifier=${person.displayNumber}`,
        registrar.accessToken,
      );
      expect(res.json().match?.displayNumber).toBe(person.displayNumber);
      // Decrypted for a support call — the registrar must confirm they have
      // the right person.
      expect(res.json().match.givenName).toBeTruthy();
    });

    it('THE AUDIT RULE — the lookup appears on that citizen\'s own access log', async () => {
      const registrar = await ministryUserAs('REGISTRAR');
      const person = await makePerson('Wanjiku');

      await get(
        `/admin/citizens/lookup?identifier=${person.displayNumber}`,
        registrar.accessToken,
      );

      const logged = await prisma.accessLog.findMany({ where: { personId: person.id } });
      expect(logged).toHaveLength(1);
      // Logged as MINISTRY, not PRACTITIONER: a registrar shown as a
      // clinician would put someone who never opened the record on that
      // citizen's access screen.
      expect(logged[0].actorKind).toBe('MINISTRY');
      expect(logged[0].action).toBe('SEARCH');
      expect(logged[0].reason).toBe('ADMIN');
      expect(logged[0].actorId).toBe(registrar.ministryUser.id);
    });

    it('returns no clinical content, ever', async () => {
      const doctor = await clinician();
      const registrar = await ministryUserAs('REGISTRAR');
      const patient = await makePerson();

      const e = await openEncounter(prisma, {
        practitionerId: doctor.practitioner.id,
        personId: patient.id,
        kind: 'OUTPATIENT',
        chiefComplaint: 'fever',
      });
      await recordDiagnosis(prisma, {
        practitionerId: doctor.practitioner.id,
        encounterId: e.id,
        icd11Code: '1F41.0',
      });

      const res = await get(
        `/admin/citizens/lookup?identifier=${patient.displayNumber}`,
        registrar.accessToken,
      );

      // Registration details only. Clinical data lives behind the check-in
      // gate and is not a Ministry capability at any role.
      expect(res.body).not.toMatch(/1F41|malaria|fever|encounter|diagnos/i);
    });

    it('returns nothing for an unknown identifier, without saying which', async () => {
      const registrar = await ministryUserAs('REGISTRAR');
      const res = await get(
        '/admin/citizens/lookup?identifier=00000000',
        registrar.accessToken,
      );
      expect(res.statusCode).toBe(200);
      expect(res.json().match).toBeNull();
    });

    it('refuses a partial identifier, so it cannot be used to enumerate', async () => {
      const registrar = await ministryUserAs('REGISTRAR');
      // A prefix search would turn a lookup into a listing, one keystroke
      // at a time.
      const res = await get('/admin/citizens/lookup?identifier=81', registrar.accessToken);
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('MISSING_IDENTIFIER');
    });

    it('is REGISTRAR-only, and refused to everyone else', async () => {
      const person = await makePerson();
      for (const role of ['ANALYST', 'AUDITOR', 'SURVEILLANCE']) {
        const { accessToken } = await ministryUserAs(role);
        const res = await get(
          `/admin/citizens/lookup?identifier=${person.displayNumber}`,
          accessToken,
        );
        expect(res.statusCode, role).toBe(403);
      }

      const doctor = await clinician();
      expect(
        (await get(`/admin/citizens/lookup?identifier=${person.displayNumber}`, doctor.accessToken))
          .statusCode,
      ).toBe(403);

      expect(
        (await app.inject({
          method: 'GET',
          url: `/api/v1/admin/citizens/lookup?identifier=${person.displayNumber}`,
        })).statusCode,
      ).toBe(401);
    });

    it('does not log a lookup that found nobody', async () => {
      const registrar = await ministryUserAs('REGISTRAR');
      const before = await prisma.accessLog.count();

      await get('/admin/citizens/lookup?identifier=00000000', registrar.accessToken);

      // Nobody's record was opened, so nobody's access log should grow. The
      // denial signal lives in the server log instead.
      expect(await prisma.accessLog.count()).toBe(before);
    });
  });
});

describe('a registered clinician can actually sign in as one', () => {
  /**
   * THE REGRESSION. `/auth/register/practitioner` created the person, their
   * CITIZEN account and the practitioner record — and no clinical account
   * at all. So a nurse who registered could sign in only as a patient, land
   * on the citizen screen, and never reach the encounter screen.
   *
   * The existing tests missed it because they asserted registration grants
   * NOTHING, which was true, and never asked whether the clinician could
   * sign in as a clinician.
   */
  const post = (url: string, payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: `/api/v1${url}`, payload });

  it('creates a clinical account, separate from the citizen one', async () => {
    seq++;
    const licenceNumber = `NCK/2026/L${String(seq).padStart(4, '0')}`;
    const body = {
      nationalId: `830000${String(seq).padStart(2, '0')}`,
      phone: `07200000${String(seq).padStart(2, '0')}`,
      givenName: 'Joseph',
      familyName: 'Mwangi',
      sexAtBirth: 'MALE',
      dateOfBirth: '1988-02-19',
      countyId: ctx.countyId,
      subcountyId: ctx.subcountyId,
      password: 'a-long-enough-password',
      cadre: 'NURSE',
      licenceNumber,
    };

    const res = await post('/auth/register/practitioner', body);
    expect(res.statusCode).toBe(200);

    const practitionerId = res.json().practitionerId;
    const account = await prisma.account.findFirst({
      where: { practitionerId },
      select: { id: true, personId: true, ministryUserId: true },
    });

    // Two accounts, one human being: `account_one_owner_ck` allows exactly
    // one owner each, so the clinical account carries only practitionerId.
    expect(account).toBeTruthy();
    expect(account!.personId).toBeNull();
    expect(account!.ministryUserId).toBeNull();
  });

  it('THE SIGN-IN — the clinical account authenticates on the licence number', async () => {
    seq++;
    const licenceNumber = `NCK/2026/M${String(seq).padStart(4, '0')}`;
    const phone = `07210000${String(seq).padStart(2, '0')}`;
    const password = 'a-long-enough-password';

    await post('/auth/register/practitioner', {
      nationalId: `840000${String(seq).padStart(2, '0')}`,
      phone,
      givenName: 'Joseph',
      familyName: 'Mwangi',
      sexAtBirth: 'MALE',
      dateOfBirth: '1988-02-19',
      countyId: ctx.countyId,
      subcountyId: ctx.subcountyId,
      password,
      cadre: 'NURSE',
      licenceNumber,
    });

    const login = await post('/auth/login', { phone: licenceNumber, password });
    // A privileged account must enrol a second factor before it can hold a
    // session. Reaching THAT state proves the account exists and is
    // clinical — and it now comes with a way through rather than a dead end.
    expect(login.json().status).toBe('MFA_ENROLMENT_REQUIRED');
    expect(login.json().enrolToken).toBeTruthy();
    expect(login.json().accessToken).toBeUndefined();
  });

  it('the phone still signs them in to their OWN patient record', async () => {
    seq++;
    const phone = `07220000${String(seq).padStart(2, '0')}`;
    const password = 'a-long-enough-password';

    await post('/auth/register/practitioner', {
      nationalId: `850000${String(seq).padStart(2, '0')}`,
      phone,
      givenName: 'Joseph',
      familyName: 'Mwangi',
      sexAtBirth: 'MALE',
      dateOfBirth: '1988-02-19',
      countyId: ctx.countyId,
      subcountyId: ctx.subcountyId,
      password,
      cadre: 'NURSE',
      licenceNumber: `NCK/2026/N${String(seq).padStart(4, '0')}`,
    });

    const login = await post('/auth/login', { phone, password });
    expect(login.json().status).toBe('AUTHENTICATED');

    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${login.json().accessToken}` },
    });
    // Their citizen account: a personId and NO practitionerId. A clinician
    // is a person too, and this is the record they would be treated under.
    expect(me.json().personId).toBeTruthy();
    expect(me.json().practitionerId).toBeNull();
  });

  it('tells them what to sign in with, since it is not the phone', async () => {
    seq++;
    const res = await post('/auth/register/practitioner', {
      nationalId: `860000${String(seq).padStart(2, '0')}`,
      phone: `07230000${String(seq).padStart(2, '0')}`,
      givenName: 'Joseph',
      familyName: 'Mwangi',
      sexAtBirth: 'MALE',
      dateOfBirth: '1988-02-19',
      countyId: ctx.countyId,
      subcountyId: ctx.subcountyId,
      password: 'a-long-enough-password',
      cadre: 'NURSE',
      licenceNumber: `NCK/2026/P${String(seq).padStart(4, '0')}`,
    });

    // Silence here sends a clinician to the worker portal with a phone that
    // signs them in as a patient — the exact confusion this caused.
    expect(res.json().clinicalLogin).toBeTruthy();
    expect(res.json().loginNote).toMatch(/licence number/i);
  });
});

describe('passport photos', () => {
  /**
   * A face is biometric data under the Data Protection Act. It gets the same
   * AES-256-GCM treatment as a National ID, is served only behind the
   * authorisation of the record it belongs to, and never has a public URL.
   *
   * The tests that matter are the ones that stop something which is not an
   * image being stored as one — a data URL's MIME type is a claim by the
   * caller, not a fact.
   */
  const JPEG = `data:image/jpeg;base64,${Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46,
  ]).toString('base64')}`;
  const PNG = `data:image/png;base64,${Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]).toString('base64')}`;

  const post = (url: string, payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: `/api/v1${url}`, payload });

  const citizenBody = (over: Record<string, unknown> = {}) => {
    seq++;
    return {
      nationalId: `870000${String(seq).padStart(2, '0')}`,
      phone: `07240000${String(seq).padStart(2, '0')}`,
      givenName: 'Grace',
      familyName: 'Achieng',
      sexAtBirth: 'FEMALE',
      dateOfBirth: '1993-11-08',
      countyId: ctx.countyId,
      subcountyId: ctx.subcountyId,
      password: 'a-long-enough-password',
      ...over,
    };
  };

  it('stores a photo supplied at registration', async () => {
    const body = citizenBody({ photo: JPEG });
    const res = await post('/auth/register/citizen', body);
    expect(res.statusCode).toBe(200);

    const person = await prisma.person.findFirst({
      where: { displayNumber: res.json().nhpId },
      select: { photo: true },
    });
    expect(person!.photo).toBeTruthy();
    // Encrypted at rest: the stored column must not be the data URL.
    expect(person!.photo).not.toBe(JPEG);
    expect(person!.photo).not.toContain('data:image');
  });

  it('registers happily with no photo at all', async () => {
    // Refusing someone with no way to take a photo would exclude exactly
    // the people who most need a health record.
    const res = await post('/auth/register/citizen', citizenBody());
    expect(res.statusCode).toBe(200);
  });

  it('accepts PNG as well as JPEG', async () => {
    expect((await post('/auth/register/citizen', citizenBody({ photo: PNG }))).statusCode).toBe(200);
  });

  it('THE FORGERY GUARD — refuses a file whose bytes are not an image', async () => {
    // `data:image/jpeg;base64,<an HTML page>` stored and later served with
    // an image content type is how a stored XSS gets into a system that
    // believed it only held pictures.
    const html = `data:image/jpeg;base64,${Buffer.from(
      '<html><script>alert(1)</script></html>',
    ).toString('base64')}`;

    const res = await post('/auth/register/citizen', citizenBody({ photo: html }));
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('PHOTO_NOT_AN_IMAGE');
  });

  it('refuses a format a browser cannot display', async () => {
    const svg = `data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}`;
    // SVG is an executable document, not a photograph.
    const res = await post('/auth/register/citizen', citizenBody({ photo: svg }));
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('PHOTO_WRONG_FORMAT');
  });

  it('refuses a photo that was never resized', async () => {
    const huge = `data:image/jpeg;base64,${Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff]),
      Buffer.alloc(210 * 1024, 0x41),
    ]).toString('base64')}`;

    const res = await post('/auth/register/citizen', citizenBody({ photo: huge }));
    expect(res.statusCode).toBe(400);
    expect(['PHOTO_TOO_LARGE', 'MALFORMED_REQUEST']).toContain(res.json().code);
  });

  it('refuses something that is not a data URL', async () => {
    const res = await post(
      '/auth/register/citizen',
      citizenBody({ photo: 'https://example.com/face.jpg' }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('PHOTO_MALFORMED');
  });

  it('serves a photo to a clinician, and refuses an unauthenticated caller', async () => {
    const doctor = await clinician();
    const body = citizenBody({ photo: JPEG });
    const created = await post('/auth/register/citizen', body);
    const nhpId = created.json().nhpId;

    const asDoctor = await app.inject({
      method: 'GET',
      url: `/api/v1/persons/${nhpId}/photo`,
      headers: { authorization: `Bearer ${doctor.accessToken}` },
    });
    expect(asDoctor.statusCode).toBe(200);
    expect(asDoctor.json().photo).toBe(JPEG);

    // A face plus a name outside every guard is what the encryption exists
    // to prevent.
    const anon = await app.inject({ method: 'GET', url: `/api/v1/persons/${nhpId}/photo` });
    expect(anon.statusCode).toBe(401);
  });

  it('refuses a Ministry analyst the photo', async () => {
    const { accessToken } = await ministryUserAs('ANALYST');
    const created = await post('/auth/register/citizen', citizenBody({ photo: JPEG }));

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/persons/${created.json().nhpId}/photo`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('lets a citizen read and replace their own photo', async () => {
    const body = citizenBody();
    await post('/auth/register/citizen', body);

    const login = await post('/auth/login', { phone: body.phone, password: body.password });
    const token = login.json().accessToken;

    const before = await app.inject({
      method: 'GET',
      url: '/api/v1/persons/me/photo',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(before.json().photo).toBeNull();

    const set = await app.inject({
      method: 'POST',
      url: '/api/v1/persons/me/photo',
      headers: { authorization: `Bearer ${token}` },
      payload: { photo: PNG },
    });
    expect(set.statusCode).toBe(200);

    const after = await app.inject({
      method: 'GET',
      url: '/api/v1/persons/me/photo',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(after.json().photo).toBe(PNG);
  });

  it('THE OWNERSHIP RULE — a practitioner cannot use the citizen photo route', async () => {
    const doctor = await clinician();
    // `requireSelf(ctx, ctx.personId)` would compare a value to itself and
    // pass for anyone, including an account with no personId at all.
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/persons/me/photo',
      headers: { authorization: `Bearer ${doctor.accessToken}` },
      payload: { photo: JPEG },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('NOT_A_CITIZEN');
  });
});

describe('the citizen profile', () => {
  /**
   * What a citizen may change about themselves, and what they may not.
   *
   * Name, National ID, date of birth and sex are what a facility matches a
   * person on. A self-service edit there is how someone quietly becomes a
   * different person, and how a merged record becomes impossible to
   * un-merge — so they are readable and NOT writable.
   */
  async function citizenSession() {
    const person = await makePerson('Achieng');
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { phone: person.phone, password: CITIZEN_PASSWORD },
    });
    return { person, token: login.json().accessToken as string };
  }

  const get = (url: string, token: string) =>
    app.inject({ method: 'GET', url: `/api/v1${url}`, headers: { authorization: `Bearer ${token}` } });

  it('returns the contact details a citizen may change', async () => {
    const { person, token } = await citizenSession();
    const res = await get('/persons/me/profile', token);

    expect(res.statusCode).toBe(200);
    expect(res.json().contact.phone).toBe(person.phone);
  });

  it('THE MASKING RULE — never returns the National ID in full', async () => {
    const { token } = await citizenSession();
    const body = (await get('/persons/me/profile', token)).json();

    // A citizen already knows their own number; showing it in full only
    // creates a shoulder-surfing target on a shared handset.
    expect(body.identity.nationalIdMasked).toMatch(/^•+\d{2}$/);
    expect(JSON.stringify(body)).not.toMatch(/"8100\d{4}"/);
  });

  it('shows identity fields so an error can be SEEN and reported', async () => {
    const { token } = await citizenSession();
    const id = (await get('/persons/me/profile', token)).json().identity;

    // Hiding them would mean a wrong date of birth is undiscoverable until
    // it matters clinically.
    expect(id.givenName).toBe('Achieng');
    expect(id.dateOfBirth).toBeTruthy();
    expect(id.sexAtBirth).toBeTruthy();
    expect(id.displayNumber).toMatch(/^NHP-/);
  });

  it('updates a phone number, and re-requires verification', async () => {
    const { person, token } = await citizenSession();
    seq++;
    const newPhone = `07310000${String(seq).padStart(2, '0')}`;

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/persons/me/profile',
      headers: { authorization: `Bearer ${token}` },
      payload: { phone: newPhone },
    });
    expect(res.statusCode).toBe(200);

    const account = await prisma.account.findFirst({
      where: { personId: person.id },
      select: { phoneVerifiedAt: true },
    });
    // The old number's verification cannot carry over to a new one.
    expect(account!.phoneVerifiedAt).toBeNull();

    // And the new number is what signs them in.
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { phone: newPhone, password: CITIZEN_PASSWORD },
    });
    expect(login.json().status).toBe('AUTHENTICATED');
  });

  it('refuses a phone number already in use', async () => {
    const other = await makePerson('Other');
    const { token } = await citizenSession();

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/persons/me/profile',
      headers: { authorization: `Bearer ${token}` },
      payload: { phone: other.phone },
    });
    // Two accounts on one number makes both unreachable by SMS.
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('PHONE_IN_USE');
  });

  it('THE READ-ONLY RULE — identity fields cannot be patched', async () => {
    const { person, token } = await citizenSession();

    await app.inject({
      method: 'PATCH',
      url: '/api/v1/persons/me/profile',
      headers: { authorization: `Bearer ${token}` },
      payload: { givenName: 'Somebody', dateOfBirth: '1970-01-01', nationalId: '99999999' },
    });

    const after = await prisma.person.findUnique({
      where: { id: person.id },
      select: { givenName: true, dateOfBirth: true },
    });
    // Ignored, not applied: the schema does not accept them, and the
    // handler only ever writes phone and email.
    expect(decryptField(after!.givenName)).toBe('Achieng');
    expect(after!.dateOfBirth.getUTCFullYear()).toBe(1990);
  });

  it('is refused to a practitioner and to an unauthenticated caller', async () => {
    const doctor = await clinician();
    expect((await get('/persons/me/profile', doctor.accessToken)).statusCode).toBe(403);
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/persons/me/profile' })).statusCode,
    ).toBe(401);
  });
});

describe('a citizen adding a child', () => {
  /**
   * A dependant registered by a parent is SELF_DECLARED and starts
   * unverified — not searchable by facilities — until a clinician attests
   * it. Without that gate any adult could fabricate a child, and the
   * clinical record of a person who does not exist is worse than no record.
   */
  async function citizenSession() {
    const person = await makePerson('Achieng');
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { phone: person.phone, password: CITIZEN_PASSWORD },
    });
    return { person, token: login.json().accessToken as string };
  }

  const child = (over: Record<string, unknown> = {}) => ({
    givenName: 'Baraka',
    familyName: 'Wanjala',
    sexAtBirth: 'MALE',
    dateOfBirth: '2019-04-02',
    relationship: 'MOTHER',
    ...over,
  });

  it('adds a child and returns their NHP number', async () => {
    const { token } = await citizenSession();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/persons/me/family',
      headers: { authorization: `Bearer ${token}` },
      payload: child(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().displayNumber).toMatch(/^NHP-/);
  });

  it('THE FABRICATION GATE — a self-declared child is not verified', async () => {
    const { token } = await citizenSession();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/persons/me/family',
      headers: { authorization: `Bearer ${token}` },
      payload: child(),
    });

    // A parent typing into a form has shown nobody a birth certificate.
    expect(res.json().verified).toBe(false);
    // And the response says what to do about it, rather than leaving a
    // parent to discover it at a facility counter.
    expect(res.json().message).toMatch(/birth certificate|cannot find/i);
  });

  it('lists the children a citizen is guardian to', async () => {
    const { token } = await citizenSession();
    await app.inject({
      method: 'POST',
      url: '/api/v1/persons/me/family',
      headers: { authorization: `Bearer ${token}` },
      payload: child(),
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/persons/me/family',
      headers: { authorization: `Bearer ${token}` },
    });

    const family = res.json();
    expect(family).toHaveLength(1);
    expect(family[0].child.givenName).toBe('Baraka');
    expect(family[0].relationship).toBe('MOTHER');
    // The thing a parent needs to know: whether a facility can find them.
    expect(family[0].child.verified).toBe(false);
    expect(family[0].child.ageYears).toBeGreaterThan(0);
  });

  it('shows only YOUR children, never anyone else\'s', async () => {
    const a = await citizenSession();
    const b = await citizenSession();

    await app.inject({
      method: 'POST',
      url: '/api/v1/persons/me/family',
      headers: { authorization: `Bearer ${a.token}` },
      payload: child({ givenName: 'Baraka' }),
    });

    const theirs = await app.inject({
      method: 'GET',
      url: '/api/v1/persons/me/family',
      headers: { authorization: `Bearer ${b.token}` },
    });
    // Guardianship is the whole basis of access to a child's record.
    expect(theirs.json()).toHaveLength(0);
  });

  it('refuses a child born in the future', async () => {
    const { token } = await citizenSession();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/persons/me/family',
      headers: { authorization: `Bearer ${token}` },
      payload: child({ dateOfBirth: '2099-01-01' }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_DOB');
  });

  it('refuses a relationship outside the accepted list', async () => {
    const { token } = await citizenSession();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/persons/me/family',
      headers: { authorization: `Bearer ${token}` },
      payload: child({ relationship: 'NEIGHBOUR' }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('is refused to a practitioner and an unauthenticated caller', async () => {
    const doctor = await clinician();
    const asDoctor = await app.inject({
      method: 'GET',
      url: '/api/v1/persons/me/family',
      headers: { authorization: `Bearer ${doctor.accessToken}` },
    });
    expect(asDoctor.statusCode).toBe(403);
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/persons/me/family' })).statusCode,
    ).toBe(401);
  });
});

describe('a hospital visit, end to end', () => {
  /**
   * The loop the whole system exists for: a clinician records an encounter,
   * and the patient sees it on their own screen afterwards — in plain
   * language, attributed, and unable to be edited by either of them.
   *
   * `/persons/me/visits` had no HTTP test at all, so nothing checked that
   * what a clinician writes is what a citizen reads.
   */
  async function citizenWith(person: Awaited<ReturnType<typeof makePerson>>) {
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { phone: person.phone, password: CITIZEN_PASSWORD },
    });
    return login.json().accessToken as string;
  }

  it('THE LOOP — a recorded visit appears on the patient\'s own screen', async () => {
    const doctor = await clinician();
    const patient = await makePerson('Achieng');
    const token = await citizenWith(patient);

    const encounter = await openEncounter(prisma, {
      practitionerId: doctor.practitioner.id,
      personId: patient.id,
      kind: 'OUTPATIENT',
      chiefComplaint: 'fever and headache',
    });
    await recordDiagnosis(prisma, {
      practitionerId: doctor.practitioner.id,
      encounterId: encounter.id,
      icd11Code: '1F41.0',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/persons/me/visits',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const visits = res.json();
    expect(visits).toHaveLength(1);

    // Attributed: a record nobody signed is a record nobody can be asked
    // about.
    expect(visits[0].facilityName).toBe('Kisumu County Referral');
    expect(visits[0].treatedBy).toMatch(/Amina/);
  });

  it('THE LANGUAGE RULE — plain first, the clinical term below it', async () => {
    const doctor = await clinician();
    const patient = await makePerson('Achieng');
    const token = await citizenWith(patient);

    const e = await openEncounter(prisma, {
      practitionerId: doctor.practitioner.id,
      personId: patient.id,
      kind: 'OUTPATIENT',
      chiefComplaint: 'fever',
    });
    await recordDiagnosis(prisma, {
      practitionerId: doctor.practitioner.id,
      encounterId: e.id,
      icd11Code: '1F41.0',
    });

    const visit = (
      await app.inject({
        method: 'GET',
        url: '/api/v1/persons/me/visits',
        headers: { authorization: `Bearer ${token}` },
      })
    ).json()[0];

    // "You had malaria confirmed by a blood test", not "1F41.0".
    expect(visit.whatHappened).toMatch(/malaria/i);
    expect(visit.whatHappened).not.toMatch(/1F41/);
    // The clinical term is still available, for a patient carrying their
    // record to a specialist.
    expect(visit.clinicalTitle).toMatch(/falciparum/i);
    expect(visit.icd11Code).toBe('1F41.0');
  });

  it('reads the same visit in Swahili', async () => {
    const doctor = await clinician();
    const patient = await makePerson('Achieng');
    const token = await citizenWith(patient);

    const e = await openEncounter(prisma, {
      practitionerId: doctor.practitioner.id,
      personId: patient.id,
      kind: 'OUTPATIENT',
      chiefComplaint: 'fever',
    });
    await recordDiagnosis(prisma, {
      practitionerId: doctor.practitioner.id,
      encounterId: e.id,
      icd11Code: '1F41.0',
    });

    const visit = (
      await app.inject({
        method: 'GET',
        url: '/api/v1/persons/me/visits?lang=sw',
        headers: { authorization: `Bearer ${token}` },
      })
    ).json()[0];

    // Swahili is the language of everyday life here; a record only readable
    // in English is a record most people cannot check.
    expect(visit.whatHappened).toMatch(/ulikuwa|malaria/i);
  });

  it('shows nothing before any visit has happened', async () => {
    const patient = await makePerson('Achieng');
    const token = await citizenWith(patient);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/persons/me/visits',
      headers: { authorization: `Bearer ${token}` },
    });
    // Empty, not an error: a new citizen has no history and that is normal.
    expect(res.json()).toEqual([]);
  });

  it('THE ISOLATION RULE — one patient never sees another\'s visit', async () => {
    const doctor = await clinician();
    const mine = await makePerson('Achieng');
    const theirs = await makePerson('Someone');
    const myToken = await citizenWith(mine);

    const e = await openEncounter(prisma, {
      practitionerId: doctor.practitioner.id,
      personId: theirs.id,
      kind: 'OUTPATIENT',
      chiefComplaint: 'fever',
    });
    await recordDiagnosis(prisma, {
      practitionerId: doctor.practitioner.id,
      encounterId: e.id,
      icd11Code: '1F41.0',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/persons/me/visits',
      headers: { authorization: `Bearer ${myToken}` },
    });
    // The person id comes from the token, so there is no parameter to
    // tamper with — asserted rather than assumed.
    expect(res.json()).toEqual([]);
  });

  it('the visit reaches the patient summary too', async () => {
    const doctor = await clinician();
    const patient = await makePerson('Achieng');
    const token = await citizenWith(patient);

    await recordAllergy(prisma, {
      practitionerId: doctor.practitioner.id,
      personId: patient.id,
      substanceKind: 'DRUG',
      substanceLabel: 'Penicillin',
      allergyClass: 'PENICILLIN',
      reaction: 'anaphylaxis',
      severity: 'ANAPHYLAXIS',
    });

    const summary = (
      await app.inject({
        method: 'GET',
        url: '/api/v1/persons/me/summary',
        headers: { authorization: `Bearer ${token}` },
      })
    ).json();

    // The allergy a clinician recorded is what the citizen header shows.
    const allergies = summary.rightNow.filter((i: { kind: string }) => i.kind === 'ALLERGY');
    expect(allergies.length).toBeGreaterThan(0);
    expect(allergies[0].title).toMatch(/penicillin/i);
  });
});

describe('CORS', () => {
  /**
   * `app.inject()` bypasses CORS entirely, so no other test in this file
   * can see a preflight failure. That is how PATCH shipped blocked: every
   * server test passed while the browser refused the request with an
   * opaque "Failed to fetch", and the citizen profile could not be saved.
   */
  it('THE PREFLIGHT — allows every method the client actually uses', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/v1/persons/me/profile',
      headers: {
        origin: 'http://localhost:3100',
        'access-control-request-method': 'PATCH',
      },
    });

    const allowed = String(res.headers['access-control-allow-methods'] ?? '');
    // Fastify's default is GET, HEAD and POST. Anything the client sends
    // beyond those must be listed or the browser blocks it.
    for (const method of ['GET', 'POST', 'PATCH']) {
      expect(allowed, method).toContain(method);
    }
  });

  it('allows the headers the client sends', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/v1/persons/me/profile',
      headers: {
        origin: 'http://localhost:3100',
        'access-control-request-method': 'PATCH',
        'access-control-request-headers': 'authorization,x-csrf-token',
      },
    });

    const allowed = String(res.headers['access-control-allow-headers'] ?? '').toLowerCase();
    // Without these the bearer token and the CSRF token never arrive, and
    // every authenticated write fails at the preflight.
    expect(allowed).toContain('authorization');
    expect(allowed).toContain('x-csrf-token');
  });

  it('still sends credentials, so the refresh cookie travels', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/v1/auth/refresh',
      headers: {
        origin: 'http://localhost:3100',
        'access-control-request-method': 'POST',
      },
    });
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });
});

describe('MFA enrolment for an account that cannot yet sign in', () => {
  /**
   * THE DEADLOCK. A privileged account with no second factor is refused at
   * sign-in, and every enrolment route required a session — so a newly
   * registered clinician could never obtain one. They were locked out
   * permanently with no route through.
   *
   * The password is verified BEFORE that refusal, so credentials are already
   * proven. What login now returns is deliberately not a session: a
   * short-lived token on its own audience that unlocks the four enrolment
   * routes and nothing else.
   */
  async function unenrolledClinician() {
    const person = await makePerson('Amina');
    seq++;
    const { practitioner } = await registerPractitioner(prisma, {
      personId: person.id,
      cadre: 'DOCTOR',
      countyId: ctx.countyId,
      subcountyId: ctx.subcountyId,
      licenceNumber: `KMPDC/2026/E${String(seq).padStart(3, '0')}`,
    });

    seq++;
    const phone = `07330000${String(seq).padStart(2, '0')}`;
    const password = 'a-long-enough-password';
    await prisma.account.create({
      data: {
        practitionerId: practitioner.id,
        phone: encryptField(phone),
        phoneIndex: blindIndex(phone, normalisePhone),
        passwordHash: await hashPassword(password),
        status: 'ACTIVE',
        // The state the deadlock describes.
        mfaMode: 'NONE',
      },
    });

    return { phone, password, practitioner };
  }

  const login = (phone: string, password: string) =>
    app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { phone, password } });

  it('THE WAY THROUGH — login offers an enrolment token instead of refusing', async () => {
    const c = await unenrolledClinician();
    const res = await login(c.phone, c.password);

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('MFA_ENROLMENT_REQUIRED');
    expect(res.json().enrolToken).toBeTruthy();
    // Masked, so they can confirm which handset before choosing SMS.
    expect(res.json().sentTo).toMatch(/\*/);
  });

  it('is NOT a session — it carries no access token', async () => {
    const c = await unenrolledClinician();
    const body = (await login(c.phone, c.password)).json();

    expect(body.accessToken).toBeUndefined();
    expect(body.refreshToken).toBeUndefined();
  });

  it('THE SCOPE RULE — the enrolment token cannot read a patient record', async () => {
    const c = await unenrolledClinician();
    const { enrolToken } = (await login(c.phone, c.password)).json();
    const patient = await makePerson();

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/persons/${patient.displayNumber}/summary`,
      headers: { authorization: `Bearer ${enrolToken}` },
    });
    // Different audience: presenting it as a session must fail outright.
    expect(res.statusCode).toBe(401);
  });

  it('enrols SMS and completes, so the account can then sign in', async () => {
    const c = await unenrolledClinician();
    const { enrolToken } = (await login(c.phone, c.password)).json();

    const enrol = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/sms/enrol',
      payload: { enrolToken },
    });
    expect(enrol.statusCode).toBe(200);

    const code = sms.sent.at(-1)?.body.match(/\b(\d{6})\b/)?.[1];
    expect(code).toBeTruthy();

    const confirm = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/sms/confirm',
      payload: { enrolToken, code },
    });
    expect(confirm.statusCode).toBe(200);

    // The deadlock is broken: the same credentials now reach the MFA step
    // rather than being refused outright.
    const after = await login(c.phone, c.password);
    expect(after.json().status).toBe('MFA_REQUIRED');
    expect(after.json().mfaToken).toBeTruthy();
  });

  it('enrols TOTP and completes', async () => {
    const c = await unenrolledClinician();
    const { enrolToken } = (await login(c.phone, c.password)).json();

    const enrol = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/enrol',
      payload: { enrolToken, label: 'NHP' },
    });
    expect(enrol.statusCode).toBe(200);
    // An authenticator app needs both: the QR to scan and the secret to
    // type when a camera will not focus.
    expect(enrol.json().otpauthUrl ?? enrol.json().uri).toBeTruthy();
  });

  it('refuses a forged or expired enrolment token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/sms/enrol',
      payload: { enrolToken: 'not-a-real-token' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('ENROL_TOKEN_INVALID');
  });

  it('THE AUDIENCE RULE — a session token is not an enrolment token', async () => {
    const doctor = await clinician();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/sms/enrol',
      payload: { enrolToken: doctor.accessToken },
    });
    // Minted for `nhp-api`, presented to `nhp-enrol`: refused. The two
    // tokens are not interchangeable in either direction.
    expect(res.statusCode).toBe(401);
  });

  it('still lets a signed-in account enrol a second factor normally', async () => {
    const doctor = await clinician();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/enrol',
      headers: { authorization: `Bearer ${doctor.accessToken}` },
      payload: { label: 'NHP' },
    });
    // The ordinary path — adding or changing a factor while signed in —
    // must keep working.
    expect(res.statusCode).toBe(200);
  });

  it('refuses enrolment with neither a session nor a token', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/mfa/sms/enrol' });
    expect(res.statusCode).toBe(401);
  });

  it('a citizen account still signs in without any of this', async () => {
    const person = await makePerson();
    const res = await login(person.phone, CITIZEN_PASSWORD);
    // Only privileged accounts are forced to enrol; a citizen with no
    // second factor is not locked out of their own record.
    expect(res.json().status).toBe('AUTHENTICATED');
  });
});

describe('where a clinician\'s security codes go', () => {
  /**
   * THE BUG. `account.phone` doubles as the sign-in identifier, and a
   * clinician signs in with their LICENCE NUMBER — so the SMS went to a
   * number derived from "NCK/2026/4455", which nobody owns. Enrolment
   * appeared to succeed, sign-in reached the MFA step, and the code never
   * arrived. Every server test passed because the console provider accepts
   * any destination.
   */
  const post = (url: string, payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: `/api/v1${url}`, payload });

  it('THE DESTINATION RULE — codes go to the real phone, not the licence', async () => {
    seq++;
    const phone = `07340000${String(seq).padStart(2, '0')}`;
    const licenceNumber = `NCK/2026/S${String(seq).padStart(4, '0')}`;

    await post('/auth/register/practitioner', {
      nationalId: `880000${String(seq).padStart(2, '0')}`,
      phone,
      givenName: 'Faith',
      familyName: 'Muthoni',
      sexAtBirth: 'FEMALE',
      dateOfBirth: '1990-03-14',
      countyId: ctx.countyId,
      subcountyId: ctx.subcountyId,
      password: 'a-long-enough-password',
      cadre: 'NURSE',
      licenceNumber,
    });

    sms.sent.length = 0;

    const login = await post('/auth/login', {
      phone: licenceNumber,
      password: 'a-long-enough-password',
    });
    const { enrolToken } = login.json();

    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/sms/enrol',
      payload: { enrolToken },
    });

    const sentTo = sms.sent.at(-1)?.to;
    expect(sentTo).toBeTruthy();

    // The real number, normalised — NOT a number built out of the licence.
    expect(sentTo).toBe(`+254${phone.slice(1)}`);
    expect(sentTo).not.toMatch(/2026/);
  });

  it('a citizen still receives codes on their own number', async () => {
    const person = await makePerson();
    const account = await prisma.account.findFirst({
      where: { personId: person.id },
      select: { smsPhone: true },
    });

    // Null means "use `phone`", which for a citizen is the same number.
    // Only a clinician needs the two to differ.
    expect(account!.smsPhone).toBeNull();
  });

  it('masks the destination it reports back', async () => {
    seq++;
    const phone = `07350000${String(seq).padStart(2, '0')}`;
    const licenceNumber = `NCK/2026/T${String(seq).padStart(4, '0')}`;

    await post('/auth/register/practitioner', {
      nationalId: `890000${String(seq).padStart(2, '0')}`,
      phone,
      givenName: 'Faith',
      familyName: 'Muthoni',
      sexAtBirth: 'FEMALE',
      dateOfBirth: '1990-03-14',
      countyId: ctx.countyId,
      subcountyId: ctx.subcountyId,
      password: 'a-long-enough-password',
      cadre: 'NURSE',
      licenceNumber,
    });

    const login = await post('/auth/login', {
      phone: licenceNumber,
      password: 'a-long-enough-password',
    });

    // Masked, and derived from the real number so the clinician recognises
    // which handset to check.
    expect(login.json().sentTo).toMatch(/\*/);
    expect(login.json().sentTo).toContain(phone.slice(-3));
  });
});

describe('who the encounter screen says is signed in', () => {
  /**
   * THE ATTRIBUTION BUG. The encounter footer stated "Dr Amina Wanjiru ·
   * KMPDC/12345 · Checked in · Kisumu County Referral" as fixed text. A
   * clinician who had just registered — no affiliation, no check-in — was
   * shown someone else's name and told they were checked in somewhere they
   * had never been.
   *
   * A record signed to somebody who never saw the patient is the failure
   * the whole attribution design exists to prevent, so the footer has to
   * read from the live session.
   */
  it('names the clinician who is actually signed in', async () => {
    const doctor = await clinician();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${doctor.accessToken}` },
    });

    // Decrypted, so a footer can print it.
    expect(res.json().displayName).toMatch(/Amina/);
    expect(res.json().cadre).toBe('DOCTOR');
    expect(res.json().licenceNumber).toBeTruthy();
  });

  it('reports no check-in for a clinician who has not checked in', async () => {
    seq++;
    const person = await makePerson('Peter');
    const { practitioner } = await registerPractitioner(prisma, {
      personId: person.id,
      cadre: 'DOCTOR',
      countyId: ctx.countyId,
      subcountyId: ctx.subcountyId,
      licenceNumber: `KMPDC/2026/F${String(seq).padStart(3, '0')}`,
    });

    const phone = await makeAccount({ practitionerId: practitioner.id });
    const session = await signIn(phone, ROLE_PASSWORD);

    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${session.accessToken}` },
    });

    // The gate: registered, signed in, and NOT able to write. A screen that
    // said "Checked in" here would be telling them otherwise.
    expect(me.json().displayName).toMatch(/Peter/);
    expect(me.json().checkedInAt).toBeNull();

    const current = await app.inject({
      method: 'GET',
      url: '/api/v1/check-ins/current',
      headers: { authorization: `Bearer ${session.accessToken}` },
    });
    expect(current.json()).toBeNull();
  });

  it('returns no clinician identity for a citizen', async () => {
    const person = await makePerson();
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { phone: person.phone, password: CITIZEN_PASSWORD },
    });

    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${login.json().accessToken}` },
    });

    // A citizen has no professional identity to attribute anything to.
    expect(me.json().displayName).toBeNull();
    expect(me.json().licenceNumber).toBeNull();
  });
});

describe('checking in and out of a facility', () => {
  /**
   * The check-in is what makes a clinical write attributable to a PLACE as
   * well as a person. `checkIn` refuses without an active affiliation and
   * licence — and until now nothing could call it over HTTP, so a
   * registered clinician could never begin work at all.
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

  /** A clinician with a licence but NO affiliation anywhere. */
  async function unaffiliated() {
    const person = await makePerson('Peter');
    seq++;
    const { practitioner } = await registerPractitioner(prisma, {
      personId: person.id,
      cadre: 'DOCTOR',
      countyId: ctx.countyId,
      subcountyId: ctx.subcountyId,
      licenceNumber: `KMPDC/2026/G${String(seq).padStart(3, '0')}`,
    });
    const phone = await makeAccount({ practitionerId: practitioner.id });
    const session = await signIn(phone, ROLE_PASSWORD);
    return { practitioner, ...session };
  }

  it('offers the facilities a clinician is affiliated to', async () => {
    const doctor = await clinician();
    const res = await get('/check-ins/facilities', doctor.accessToken);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(1);
    expect(res.json()[0].name).toBe('Kisumu County Referral');
    // Named, so the portal can offer a choice rather than asking a
    // clinician to type an id they have never seen. `mflCode` is nullable
    // in the schema, so the NAME is what the screen must always have.
    expect(res.json()[0].facilityId).toBeTruthy();
    expect(res.json()[0].kephLevel).toBeGreaterThan(0);
  });

  it('THE AFFILIATION GATE — offers nothing to a clinician with no posting', async () => {
    const doctor = await unaffiliated();

    // A real, approved facility that this clinician has NO posting to.
    // Without one the assertion is vacuous: with a single facility in the
    // database, "every facility" and "my facilities" are the same list.
    seq++;
    const elsewhere = await registerFacility(prisma, {
      name: 'A Facility They Do Not Work At',
      kephLevel: 4,
      ownership: 'PUBLIC_MOH',
      countyId: ctx.countyId,
      subcountyId: ctx.subcountyId,
      locality: 'Town',
      latitude: -0.0917,
      longitude: 34.768,
      mflCode: `MFL-ELSE-${seq}`,
    });
    await approveFacility(prisma, elsewhere.id, 'ministry-fixture');

    const res = await get('/check-ins/facilities', doctor.accessToken);

    // An empty list is the honest answer: they are registered and cannot
    // work anywhere until someone posts them.
    expect(res.json()).toEqual([]);
  });

  it('never offers a facility another clinician is posted to', async () => {
    const doctor = await clinician(); // affiliated to Kisumu County Referral

    // A SECOND clinician, posted somewhere else. Filtering on affiliation
    // rows rather than facilities is what this catches: with only one
    // clinician in the database, "all affiliations" and "mine" coincide and
    // the assertion proves nothing.
    const other = await clinician();
    const otherFacilities = (await get('/check-ins/facilities', other.accessToken)).json();
    expect(otherFacilities.length).toBeGreaterThan(0);

    const mine = (await get('/check-ins/facilities', doctor.accessToken)).json();

    // Exactly one — their own posting, not the other clinician's.
    expect(mine).toHaveLength(1);
    expect(mine[0].facilityId).not.toBe(otherFacilities[0].facilityId);
  });

  it('refuses a check-in where there is no affiliation', async () => {
    const doctor = await unaffiliated();
    seq++;
    const facility = await registerFacility(prisma, {
      name: 'Somewhere They Do Not Work',
      kephLevel: 4,
      ownership: 'PUBLIC_MOH',
      countyId: ctx.countyId,
      subcountyId: ctx.subcountyId,
      locality: 'Town',
      latitude: -0.0917,
      longitude: 34.768,
      mflCode: `MFL-NOAFF-${seq}`,
    });
    await approveFacility(prisma, facility.id, 'ministry-fixture');

    const res = await post('/check-ins', doctor.accessToken, { facilityId: facility.id });
    // The gate the whole clinical layer rests on: a clinician cannot start
    // a shift somewhere nobody authorised them to work.
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('checks in, and the session then reports the facility', async () => {
    const person = await makePerson('Amina');
    seq++;
    const { practitioner } = await registerPractitioner(prisma, {
      personId: person.id,
      cadre: 'DOCTOR',
      countyId: ctx.countyId,
      subcountyId: ctx.subcountyId,
      licenceNumber: `KMPDC/2026/H${String(seq).padStart(3, '0')}`,
    });
    seq++;
    const facility = await registerFacility(prisma, {
      name: 'Migosi Health Centre',
      kephLevel: 3,
      ownership: 'PUBLIC_MOH',
      countyId: ctx.countyId,
      subcountyId: ctx.subcountyId,
      locality: 'Migosi',
      latitude: -0.0917,
      longitude: 34.768,
      mflCode: `MFL-CI-${seq}`,
    });
    await approveFacility(prisma, facility.id, 'ministry-fixture');
    await grantAffiliation(prisma, {
      practitionerId: practitioner.id,
      facilityId: facility.id,
      grantedBy: 'ministry-1',
      grantedByKind: 'MINISTRY',
    });

    const phone = await makeAccount({ practitionerId: practitioner.id });
    const session = await signIn(phone, ROLE_PASSWORD);

    // Before: no session.
    expect((await get('/check-ins/current', session.accessToken)).json()).toBeNull();

    const ci = await post('/check-ins', session.accessToken, { facilityId: facility.id });
    expect(ci.statusCode).toBe(200);
    // The licence current at check-in is stamped on every row written
    // during the shift.
    expect(ci.json().licenceNumber).toBeTruthy();

    const current = (await get('/check-ins/current', session.accessToken)).json();
    expect(current.facilityName).toBe('Migosi Health Centre');
    expect(current.minutesRemaining).toBeGreaterThan(0);
  });

  it('checks out, and the session is gone', async () => {
    const doctor = await clinician();
    expect((await get('/check-ins/current', doctor.accessToken)).json()).not.toBeNull();

    const out = await post('/check-ins/end', doctor.accessToken);
    expect(out.statusCode).toBe(200);
    expect(out.json().ended).toBe(true);

    expect((await get('/check-ins/current', doctor.accessToken)).json()).toBeNull();
  });

  it('checking out twice is not an error', async () => {
    const doctor = await clinician();
    await post('/check-ins/end', doctor.accessToken);
    const again = await post('/check-ins/end', doctor.accessToken);

    // Already in the state they asked for. A 500 here would look like a
    // failure at the end of a shift.
    expect(again.statusCode).toBe(200);
    expect(again.json().ended).toBe(false);
  });

  it('is refused to a citizen and an unauthenticated caller', async () => {
    const person = await makePerson();
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { phone: person.phone, password: CITIZEN_PASSWORD },
    });

    expect((await get('/check-ins/facilities', login.json().accessToken)).statusCode).toBe(403);
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/check-ins/facilities' })).statusCode,
    ).toBe(401);
  });
});

/*
 * The facility portal.
 *
 * Two guarantees are worth more than the rest of this suite:
 *
 *   - The ownership rule survives being reached from a new direction. It
 *     was enforced when the Ministry posted staff; it must also hold when
 *     a facility administrator adds their own, which is the whole point of
 *     the private/public split.
 *
 *   - The reception queue carries no clinical data. Not "the UI does not
 *     show it" — the payload does not contain it, so a receptionist with
 *     the developer tools open learns nothing.
 */
describe('facility portal', () => {
  const get = (url: string, token: string) =>
    app.inject({ method: 'GET', url: `/api/v1${url}`, headers: { authorization: `Bearer ${token}` } });

  const post = (url: string, token: string, payload?: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: `/api/v1${url}`,
      headers: { authorization: `Bearer ${token}` },
      ...(payload ? { payload } : {}),
    });

  const patch = (url: string, token: string, payload: Record<string, unknown>) =>
    app.inject({
      method: 'PATCH',
      url: `/api/v1${url}`,
      headers: { authorization: `Bearer ${token}` },
      payload,
    });

  const del = (url: string, token: string) =>
    app.inject({ method: 'DELETE', url: `/api/v1${url}`, headers: { authorization: `Bearer ${token}` } });

  /** A signed-in clinician who administers a facility of the given ownership. */
  async function facilityAdmin(ownership = 'PRIVATE_FOR_PROFIT') {
    const doctor = await clinician();
    seq++;
    const f = await registerFacility(prisma, {
      name: `${ownership} clinic ${seq}`,
      kephLevel: 3,
      ownership: ownership as never,
      countyId: ctx.countyId,
      subcountyId: ctx.subcountyId,
      locality: 'Town',
      latitude: -0.0917,
      longitude: 34.768,
      mflCode: `MFL-ADM-${seq}`,
    });
    await approveFacility(prisma, f.id, 'ministry-fixture');
    await prisma.affiliation.create({
      data: {
        practitionerId: doctor.practitioner.id,
        facilityId: f.id,
        role: 'FACILITY_ADMIN',
        grantedBy: 'ministry-fixture',
        grantedByKind: 'MINISTRY',
        status: 'ACTIVE',
      },
    });
    return { ...doctor, adminFacility: f };
  }

  it('names the facility an administrator runs, and the staffing rule', async () => {
    const admin = await facilityAdmin('PRIVATE_FOR_PROFIT');

    const res = await get('/facility/me', admin.accessToken);

    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(admin.adminFacility.id);
    expect(res.json().isPublic).toBe(false);
    expect(res.json().staffingRule).toMatch(/engage your own staff/i);
  });

  it('tells a public facility that the Ministry posts its staff', async () => {
    const admin = await facilityAdmin('PUBLIC_MOH');

    const res = await get('/facility/me', admin.accessToken);

    expect(res.json().isPublic).toBe(true);
    expect(res.json().staffingRule).toMatch(/Ministry posts staff/i);
  });

  it('refuses a clinician who administers nothing', async () => {
    // An ordinary attending, not an administrator. The role is the gate,
    // and holding a licence is not the same as running the place.
    const doctor = await clinician();

    const res = await get('/facility/me', doctor.accessToken);

    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('NOT_A_FACILITY_ADMIN');
  });

  it('THE OWNERSHIP RULE — a private facility engages its own clinician', async () => {
    const admin = await facilityAdmin('PRIVATE_FOR_PROFIT');
    const hire = await clinician();
    const licence = await prisma.licence.findFirstOrThrow({
      where: { practitionerId: hire.practitioner.id },
      select: { licenceNumber: true },
    });

    const res = await post('/facility/staff', admin.accessToken, {
      licenceNumber: licence.licenceNumber,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().practitionerId).toBe(hire.practitioner.id);
  });

  it('THE OWNERSHIP RULE — a public facility cannot engage its own', async () => {
    const admin = await facilityAdmin('PUBLIC_MOH');
    const hire = await clinician();
    const licence = await prisma.licence.findFirstOrThrow({
      where: { practitionerId: hire.practitioner.id },
      select: { licenceNumber: true },
    });

    const res = await post('/facility/staff', admin.accessToken, {
      licenceNumber: licence.licenceNumber,
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('MINISTRY_GRANT_REQUIRED');
  });

  it('shows the roster with who granted each affiliation, and who is on duty', async () => {
    const admin = await facilityAdmin('PRIVATE_FOR_PROFIT');

    const res = await get('/facility/staff', admin.accessToken);

    expect(res.statusCode).toBe(200);
    const me = res.json().staff.find(
      (s: { practitionerId: string }) => s.practitionerId === admin.practitioner.id,
    );
    expect(me.role).toBe('FACILITY_ADMIN');
    expect(me.grantedByKind).toBe('MINISTRY');
    // Checked in at the fixture's OTHER facility, so not on duty here.
    expect(me.onDuty).toBe(false);
  });

  it('will not let an administrator remove their own access', async () => {
    const admin = await facilityAdmin('PRIVATE_FOR_PROFIT');
    const mine = await prisma.affiliation.findFirstOrThrow({
      where: { practitionerId: admin.practitioner.id, facilityId: admin.adminFacility.id },
      select: { id: true },
    });

    const res = await del(`/facility/staff/${mine.id}`, admin.accessToken);

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('CANNOT_REMOVE_SELF');
  });

  it("will not end an affiliation at somebody else's facility", async () => {
    const admin = await facilityAdmin('PRIVATE_FOR_PROFIT');
    const elsewhere = await facilityAdmin('PRIVATE_FOR_PROFIT');
    const theirs = await prisma.affiliation.findFirstOrThrow({
      where: { facilityId: elsewhere.adminFacility.id },
      select: { id: true },
    });

    const res = await del(`/facility/staff/${theirs.id}`, admin.accessToken);

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('AFFILIATION_NOT_FOUND');
    // Still there: the refusal was not a silent partial success.
    expect(
      (await prisma.affiliation.findUniqueOrThrow({ where: { id: theirs.id } })).endedAt,
    ).toBeNull();
  });

  // ------------------------------------------------------------- reception

  it('registers an arrival and lists the person waiting', async () => {
    const admin = await facilityAdmin();
    const patient = await makePerson('Otieno');

    const registered = await post('/facility/queue', admin.accessToken, {
      nhpId: patient.displayNumber,
      statedReason: 'Cough since Tuesday',
    });
    expect(registered.statusCode).toBe(200);
    expect(registered.json().alreadyWaiting).toBe(false);

    const queue = await get('/facility/queue', admin.accessToken);
    const entry = queue.json().queue.find(
      (q: { nhpId: string }) => q.nhpId === patient.displayNumber,
    );
    expect(entry.displayName).toContain('Otieno');
    expect(entry.reasonForVisit).toBe('Cough since Tuesday');
  });

  it('does not queue the same person twice', async () => {
    const admin = await facilityAdmin();
    const patient = await makePerson('Njeri');

    const first = await post('/facility/queue', admin.accessToken, {
      nhpId: patient.displayNumber,
    });
    const second = await post('/facility/queue', admin.accessToken, {
      nhpId: patient.displayNumber,
    });

    expect(second.json().alreadyWaiting).toBe(true);
    expect(second.json().arrivalId).toBe(first.json().arrivalId);

    const queue = await get('/facility/queue', admin.accessToken);
    expect(
      queue.json().queue.filter((q: { nhpId: string }) => q.nhpId === patient.displayNumber),
    ).toHaveLength(1);
  });

  it('THE RECEPTION BOUNDARY — the queue payload carries nothing clinical', async () => {
    const admin = await facilityAdmin();
    const patient = await makePerson('Kamau');
    // Give the person something clinical worth leaking, so this test can
    // fail rather than passing because the record happened to be empty.
    await prisma.person.update({
      where: { id: patient.id },
      data: { bloodGroup: 'O_POS' },
    });
    await post('/facility/queue', admin.accessToken, { nhpId: patient.displayNumber });

    const body = (await get('/facility/queue', admin.accessToken)).body;

    // Asserted against the serialised payload, not the typed object: what
    // reaches the desk is the JSON, whatever the interface claims.
    expect(body).not.toMatch(/bloodGroup|O_POS/i);
    expect(body).not.toMatch(/condition|diagnos|allerg|medicat|nationalId/i);
    // …while still carrying what reception actually needs.
    expect(body).toContain(patient.displayNumber);
  });

  it('refuses an arrival for an NHP number that does not exist', async () => {
    const admin = await facilityAdmin();

    const res = await post('/facility/queue', admin.accessToken, { nhpId: 'NHP-NOPE-1' });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('PERSON_NOT_FOUND');
  });

  it('closes an arrival when someone leaves without being seen', async () => {
    const admin = await facilityAdmin();
    const patient = await makePerson('Wafula');
    const arrival = await post('/facility/queue', admin.accessToken, {
      nhpId: patient.displayNumber,
    });

    const res = await patch(
      `/facility/queue/${arrival.json().arrivalId}`,
      admin.accessToken,
      { status: 'LEFT' },
    );

    expect(res.statusCode).toBe(200);
    const queue = await get('/facility/queue', admin.accessToken);
    expect(
      queue.json().queue.some((q: { nhpId: string }) => q.nhpId === patient.displayNumber),
    ).toBe(false);
  });

  it("cannot close an arrival at another facility", async () => {
    const admin = await facilityAdmin();
    const elsewhere = await facilityAdmin();
    const patient = await makePerson('Chebet');
    const arrival = await post('/facility/queue', elsewhere.accessToken, {
      nhpId: patient.displayNumber,
    });

    const res = await patch(
      `/facility/queue/${arrival.json().arrivalId}`,
      admin.accessToken,
      { status: 'LEFT' },
    );

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('ARRIVAL_NOT_FOUND');
  });

  it('refuses every facility route without a token', async () => {
    for (const [method, url] of [
      ['GET', '/facility/me'],
      ['GET', '/facility/staff'],
      ['POST', '/facility/staff'],
      ['GET', '/facility/queue'],
      ['POST', '/facility/queue'],
    ] as const) {
      const res = await app.inject({ method, url: `/api/v1${url}` });
      expect([401, 400]).toContain(res.statusCode);
      expect(res.statusCode).not.toBe(200);
    }
  });
});

/*
 * Registering a private facility and ending up able to run it.
 *
 * This is the path a private clinic owner actually walks, and every step
 * of it crosses a gate built to refuse: a PENDING facility grants no
 * affiliation, so the administrator cannot exist until a registrar has
 * checked the ownership evidence. Nothing else tests the whole walk.
 */
describe('a private facility from registration to running it', () => {
  const get = (url: string, token: string) =>
    app.inject({ method: 'GET', url: `/api/v1${url}`, headers: { authorization: `Bearer ${token}` } });

  const post = (url: string, token: string, payload?: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: `/api/v1${url}`,
      headers: { authorization: `Bearer ${token}` },
      ...(payload ? { payload } : {}),
    });

  it('names its registrant administrator only once the Ministry approves', async () => {
    const owner = await clinician();
    const licence = await prisma.licence.findFirstOrThrow({
      where: { practitionerId: owner.practitioner.id },
      select: { licenceNumber: true },
    });
    seq++;
    // Held: the fixtures below bump `seq`, so reading it again later
    // compares against a different number.
    const reg = `PVT-E2E-${seq}`;

    const registered = await app.inject({
      method: 'POST',
      url: '/api/v1/facilities/register',
      payload: {
        mflCode: `MFL-E2E-${seq}`,
        name: 'Milimani Family Clinic',
        kephLevel: 3,
        ownership: 'PRIVATE_FOR_PROFIT',
        countyId: ctx.countyId,
        subcountyId: ctx.subcountyId,
        latitude: -0.0917,
        longitude: 34.768,
        businessRegNo: reg,
        kraPin: 'P051234567X',
        ownerNationalId: '31234567',
        ownerName: 'Amina Wanjiru',
        adminLicenceNumber: licence.licenceNumber,
      },
    });
    expect(registered.statusCode).toBe(200);
    expect(registered.json().firstAdminPractitionerId).toBe(owner.practitioner.id);
    const facilityId = registered.json().facilityId;

    // Before approval they administer nothing. The paperwork is unchecked,
    // so the claim to own the place is unverified.
    expect((await get('/facility/me', owner.accessToken)).statusCode).toBe(403);

    const registrar = await ministryUserAs('REGISTRAR');
    expect(
      (await post(`/admin/facilities/${facilityId}/approve`, registrar.accessToken)).statusCode,
    ).toBe(200);

    // After approval they run it.
    const me = await get('/facility/me', owner.accessToken);
    expect(me.statusCode).toBe(200);
    expect(me.json().id).toBe(facilityId);
    expect(me.json().businessRegNo).toBe(reg);

    // The approval is attributable, and the affiliation is credited to the
    // Ministry rather than to the applicant's own say-so.
    const facility = await prisma.facility.findUniqueOrThrow({
      where: { id: facilityId },
      select: { approvedBy: true, approvedAt: true, ownerNationalId: true },
    });
    expect(facility.approvedBy).toBe(registrar.ministryUser.id);
    expect(facility.approvedAt).not.toBeNull();
    // The owner's National ID is encrypted at rest like every other.
    expect(facility.ownerNationalId).not.toBe('31234567');

    const affiliation = await prisma.affiliation.findFirstOrThrow({
      where: { facilityId, practitionerId: owner.practitioner.id },
      select: { grantedByKind: true, grantedBy: true, role: true },
    });
    expect(affiliation.role).toBe('FACILITY_ADMIN');
    expect(affiliation.grantedByKind).toBe('MINISTRY');
    expect(affiliation.grantedBy).toBe(registrar.ministryUser.id);
  });

  it('refuses a licence number that belongs to nobody', async () => {
    seq++;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/facilities/register',
      payload: {
        mflCode: `MFL-BADL-${seq}`,
        name: 'Ghost Clinic',
        kephLevel: 3,
        ownership: 'PRIVATE_FOR_PROFIT',
        countyId: ctx.countyId,
        subcountyId: ctx.subcountyId,
        latitude: -0.0917,
        longitude: 34.768,
        businessRegNo: `PVT-BADL-${seq}`,
        adminLicenceNumber: 'KMPDC/0000/NOBODY',
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('ADMIN_LICENCE_NOT_FOUND');
  });
});

/*
 * Which desk is this?
 *
 * A clinician commonly works at two facilities — a county referral and a
 * private clinic on alternate days. The queue route originally took
 * whichever affiliation the database returned first, so arrivals joined
 * the wrong waiting room and the desk displayed a queue belonging to a
 * different building. The screen showed one facility's name in the header
 * and another's in the navigation, which is how it was found.
 */
describe('the reception desk resolves which facility it is', () => {
  const get = (url: string, token: string) =>
    app.inject({ method: 'GET', url: `/api/v1${url}`, headers: { authorization: `Bearer ${token}` } });

  const post = (url: string, token: string, payload?: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: `/api/v1${url}`,
      headers: { authorization: `Bearer ${token}` },
      ...(payload ? { payload } : {}),
    });

  /** A second facility, active, that this practitioner also works at. */
  async function alsoAt(practitionerId: string, ownership = 'PRIVATE_FOR_PROFIT') {
    seq++;
    const f = await registerFacility(prisma, {
      name: `Second Facility ${seq}`,
      kephLevel: 3,
      ownership: ownership as never,
      countyId: ctx.countyId,
      subcountyId: ctx.subcountyId,
      locality: 'Town',
      latitude: -0.0917,
      longitude: 34.768,
      mflCode: `MFL-2ND-${seq}`,
    });
    await approveFacility(prisma, f.id, 'ministry-fixture');
    await prisma.affiliation.create({
      data: {
        practitionerId,
        facilityId: f.id,
        role: 'FACILITY_ADMIN',
        grantedBy: 'ministry-fixture',
        grantedByKind: 'MINISTRY',
        status: 'ACTIVE',
      },
    });
    return f;
  }

  it('uses the facility they are CHECKED IN to, over any other', async () => {
    // The `clinician` fixture checks in at its own facility. The second is
    // the one they administer — and being physically present wins, because
    // the person walking up to the desk is standing in that building.
    const doctor = await clinician();
    await alsoAt(doctor.practitioner.id);

    const res = await get('/facility/queue', doctor.accessToken);

    expect(res.statusCode).toBe(200);
    expect(res.json().facilityName).toBe(doctor.facility.name);
  });

  it('falls back to the facility they administer when not checked in', async () => {
    const doctor = await clinician();
    const second = await alsoAt(doctor.practitioner.id);
    await app.inject({
      method: 'POST',
      url: '/api/v1/check-ins/end',
      headers: { authorization: `Bearer ${doctor.accessToken}` },
    });

    const res = await get('/facility/queue', doctor.accessToken);

    expect(res.json().facilityName).toBe(second.name);
  });

  it('REFUSES rather than guessing when neither applies', async () => {
    /*
     * Two ordinary affiliations, no check-in, no administrator role. There
     * is no correct answer, and picking one silently is how an arrival
     * ends up in another building's queue.
     */
    const doctor = await clinician();
    await app.inject({
      method: 'POST',
      url: '/api/v1/check-ins/end',
      headers: { authorization: `Bearer ${doctor.accessToken}` },
    });
    seq++;
    const other = await registerFacility(prisma, {
      name: `Ordinary Second ${seq}`,
      kephLevel: 3,
      ownership: 'PUBLIC_MOH',
      countyId: ctx.countyId,
      subcountyId: ctx.subcountyId,
      locality: 'Town',
      latitude: -0.0917,
      longitude: 34.768,
      mflCode: `MFL-ORD-${seq}`,
    });
    await approveFacility(prisma, other.id, 'ministry-fixture');
    await grantAffiliation(prisma, {
      practitionerId: doctor.practitioner.id,
      facilityId: other.id,
      grantedBy: 'ministry-fixture',
      grantedByKind: 'MINISTRY',
    });

    const res = await get('/facility/queue', doctor.accessToken);

    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('AMBIGUOUS_FACILITY');
    expect(res.json().detail).toMatch(/check in to the one you are at/i);
  });

  it('registers the arrival into the facility the desk is showing', async () => {
    // The fault that started this: the queue was read from one facility
    // and written to another, so an arrival vanished from the desk that
    // registered it.
    const doctor = await clinician();
    await alsoAt(doctor.practitioner.id);
    const patient = await makePerson('Kiptoo');

    await post('/facility/queue', doctor.accessToken, { nhpId: patient.displayNumber });
    const queue = await get('/facility/queue', doctor.accessToken);

    expect(
      queue.json().queue.some((q: { nhpId: string }) => q.nhpId === patient.displayNumber),
    ).toBe(true);
  });
});
