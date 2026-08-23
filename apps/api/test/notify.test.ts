/**
 * SMS second factor and notifications.
 *
 * SMS is the primary MFA channel for Kenya, not a fallback — authenticator
 * apps assume a smartphone, and a clinical officer at a Level 3 facility
 * may not have one.
 *
 * The tests that matter: message bodies carry no health content, sending
 * never blocks an emergency, and the console provider cannot run in
 * production.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import 'dotenv/config';
import {
  ConsoleSmsProvider,
  setSmsProvider,
  resolveSmsProvider,
  messages,
  maskPhone,
  sendAsync,
  NotifyError,
  type SmsProvider,
  type SmsMessage,
} from '../src/notify.js';
import {
  hashPassword,
  login,
  completeMfa,
  enrolSms,
  confirmSms,
  resendMfaCode,
  OTP_MINUTES,
} from '../src/auth.js';
import { registerAdult } from '../src/identity.js';
import { registerPractitioner, grantAffiliation, checkIn } from '../src/practitioner.js';
import { registerFacility, approveFacility } from '../src/facility.js';
import { breakGlass } from '../src/consent.js';
import { openEncounter, recordDiagnosis } from '../src/clinical.js';
import { encryptField, blindIndex, normalisePhone } from '../src/crypto.js';

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
});
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const ctx = { countyId: '', subcountyId: '' };
let seq = 0;
let sms: ConsoleSmsProvider;

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
    where: { code: '908' },
    create: { code: '908', name: 'Kisumu (notify fixture)' },
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
  sms = new ConsoleSmsProvider();
  setSmsProvider(sms);
});

afterEach(() => setSmsProvider(null));

afterAll(async () => {
  await prisma.$disconnect();
  await owner.end();
});

const PASSWORD = 'correct-horse-battery';

async function makePerson(phone: string) {
  seq++;
  return registerAdult(prisma, {
    nationalId: `200000${String(seq).padStart(3, '0')}`,
    phone,
    givenName: 'Achieng',
    familyName: 'Otieno',
    sexAtBirth: 'FEMALE',
    dateOfBirth: new Date(Date.UTC(1990, 0, 1)),
    countyId: ctx.countyId,
    subcountyId: ctx.subcountyId,
    passwordHash: await hashPassword(PASSWORD),
  });
}

/** A clinician whose second factor is SMS. */
async function makeSmsClinician() {
  seq++;
  const person = await makePerson(`07200000${String(seq).padStart(2, '0')}`);
  const { practitioner } = await registerPractitioner(prisma, {
    personId: person.id,
    cadre: 'DOCTOR',
    countyId: ctx.countyId,
    subcountyId: ctx.subcountyId,
    licenceNumber: `KMPDC/2026/SM${String(seq).padStart(3, '0')}`,
  });

  const phone = `07210000${String(seq).padStart(2, '0')}`;
  const account = await prisma.account.create({
    data: {
      practitionerId: practitioner.id,
      phone: encryptField(phone),
      phoneIndex: blindIndex(phone, normalisePhone),
      passwordHash: await hashPassword(PASSWORD),
      mfaMode: 'NONE',
      status: 'ACTIVE',
    },
  });

  return { practitioner, account, phone, person };
}

/** Pulls the six-digit code out of a sent message. */
function codeFrom(message: SmsMessage | undefined): string {
  const match = message?.body.match(/\b(\d{6})\b/);
  if (!match) throw new Error(`No code in: ${message?.body}`);
  return match[1];
}

// =====================================================================

describe('message content', () => {
  it('THE PRIVACY RULE — no message carries health content', () => {
    const mfa = messages.mfaCode('123456', 10);
    const bg = messages.breakGlass('Kisumu County Referral', new Date());
    const consent = messages.consentRequest('Migosi Health Centre', '654321');

    // Phones are shared in many Kenyan households, and a lock-screen
    // preview is visible to whoever is holding the handset.
    for (const body of [mfa, bg, consent]) {
      expect(body).not.toMatch(/diagnos|malaria|HIV|pregnan|allerg|condition/i);
    }
  });

  it('warns that NHP never asks for the code', () => {
    // The single most effective defence against a phishing call.
    expect(messages.mfaCode('123456', 10)).toMatch(/never ask you for this code/i);
  });

  it('gives a break-glass alert enough to act on, and no more', () => {
    const body = messages.breakGlass('Kisumu County Referral', new Date('2026-08-24T14:30:00Z'));
    expect(body).toMatch(/emergency access/i);
    expect(body).toMatch(/Kisumu County Referral/);
    expect(body).toMatch(/2026-08-24 14:30/);
    // A way to challenge it.
    expect(body).toMatch(/147/);
    // But not why they were there.
    expect(body).not.toMatch(/because|diagnos|treat/i);
  });

  it('masks phone numbers for logs', () => {
    expect(maskPhone('+254712345678')).toBe('+2547***678');
    expect(maskPhone('123')).toBe('***');
  });
});

describe('provider selection', () => {
  it('refuses the console provider in production', () => {
    setSmsProvider(null);
    const original = process.env.NODE_ENV;
    const user = process.env.AT_USERNAME;
    const key = process.env.AT_API_KEY;
    delete process.env.AT_USERNAME;
    delete process.env.AT_API_KEY;
    process.env.NODE_ENV = 'production';

    // A code printed to a log instead of sent means a clinician never
    // receives it — and a patient is never told about an emergency access.
    expect(() => resolveSmsProvider()).toThrow(NotifyError);
    expect(() => resolveSmsProvider()).toThrow(/never run in production/i);

    process.env.NODE_ENV = original;
    if (user) process.env.AT_USERNAME = user;
    if (key) process.env.AT_API_KEY = key;
    setSmsProvider(null);
  });

  it('uses the console provider in development', () => {
    setSmsProvider(null);
    expect(resolveSmsProvider().name).toBe('CONSOLE');
    setSmsProvider(null);
  });

  it('does not throw when a send fails', async () => {
    // A gateway outage must not take down the caller.
    const failing: SmsProvider = {
      name: 'FAILING',
      async send() {
        throw new Error('gateway on fire');
      },
    };
    setSmsProvider(failing);

    expect(() =>
      sendAsync({ to: '+254712345678', body: 'test', purpose: 'MFA' }),
    ).not.toThrow();
    await new Promise((r) => setTimeout(r, 20));
  });
});

describe('SMS second factor', () => {
  it('THE ENROLMENT PROOF — sends a code and waits for confirmation', async () => {
    const { account, phone } = await makeSmsClinician();

    const result = await enrolSms(prisma, account.id);
    expect(result.sentTo).toMatch(/\*\*\*/);
    expect(result.expiresInMinutes).toBe(OTP_MINUTES);

    // Not enrolled until a code comes back: enabling SMS against a phone
    // that cannot receive would lock the clinician out of their account.
    const midway = await prisma.account.findUniqueOrThrow({ where: { id: account.id } });
    expect(midway.mfaMode).toBe('NONE');

    const code = codeFrom(sms.lastTo(normalisePhone(phone)));
    await confirmSms(prisma, account.id, code);

    const after = await prisma.account.findUniqueOrThrow({ where: { id: account.id } });
    expect(after.mfaMode).toBe('SMS');
  });

  it('refuses enrolment when the gateway cannot reach the handset', async () => {
    const { account } = await makeSmsClinician();
    setSmsProvider({
      name: 'DEAD',
      async send() {
        return { accepted: false, error: 'unreachable' };
      },
    });

    // Awaited here, unlike login: the clinician must find out NOW, not at
    // their next sign-in when they are locked out.
    await expect(enrolSms(prisma, account.id)).rejects.toThrow(/Could not send a code/i);

    const after = await prisma.account.findUniqueOrThrow({ where: { id: account.id } });
    expect(after.mfaMode).toBe('NONE');
  });

  it('refuses a wrong confirmation code', async () => {
    const { account } = await makeSmsClinician();
    await enrolSms(prisma, account.id);
    await expect(confirmSms(prisma, account.id, '000000')).rejects.toThrow(/not correct/i);
  });

  it('THE LOGIN FLOW — sends a code and completes the sign-in', async () => {
    const { account, phone } = await makeSmsClinician();
    await enrolSms(prisma, account.id);
    await confirmSms(prisma, account.id, codeFrom(sms.lastTo(normalisePhone(phone))));
    sms.clear();

    const first = await login(prisma, { phone, password: PASSWORD });
    expect(first.status).toBe('MFA_REQUIRED');
    expect(first.mfaMode).toBe('SMS');
    // Masked, so the clinician knows which handset without the response
    // disclosing a full number.
    expect(first.sentTo).toMatch(/\*\*\*/);
    expect(first.accessToken).toBeUndefined();

    // Give the async send a moment to land.
    await new Promise((r) => setTimeout(r, 30));
    const code = codeFrom(sms.lastTo(normalisePhone(phone)));

    const done = await completeMfa(prisma, { mfaToken: first.mfaToken!, code });
    expect(done.status).toBe('AUTHENTICATED');
    expect(done.accessToken).toBeTruthy();
  });

  it('does not send a code for a TOTP account', async () => {
    const { account, phone } = await makeSmsClinician();
    await prisma.account.update({
      where: { id: account.id },
      data: { mfaMode: 'TOTP', mfaSecret: encryptField('JBSWY3DPEHPK3PXP') },
    });

    const result = await login(prisma, { phone, password: PASSWORD });
    expect(result.mfaMode).toBe('TOTP');
    expect(result.sentTo).toBeUndefined();
    await new Promise((r) => setTimeout(r, 30));
    expect(sms.sent.filter((m) => m.purpose === 'MFA')).toHaveLength(0);
  });

  it('resends a code, invalidating the previous one', async () => {
    const { account, phone } = await makeSmsClinician();
    await enrolSms(prisma, account.id);
    await confirmSms(prisma, account.id, codeFrom(sms.lastTo(normalisePhone(phone))));
    sms.clear();

    const first = await login(prisma, { phone, password: PASSWORD });
    await new Promise((r) => setTimeout(r, 30));
    const firstCode = codeFrom(sms.lastTo(normalisePhone(phone)));

    await resendMfaCode(prisma, first.mfaToken!);
    await new Promise((r) => setTimeout(r, 30));
    const secondCode = codeFrom(sms.lastTo(normalisePhone(phone)));
    expect(secondCode).not.toBe(firstCode);

    // The old code is dead — otherwise every resend widens the window.
    await expect(
      completeMfa(prisma, { mfaToken: first.mfaToken!, code: firstCode }),
    ).rejects.toThrow(/not correct/i);

    const done = await completeMfa(prisma, { mfaToken: first.mfaToken!, code: secondCode });
    expect(done.status).toBe('AUTHENTICATED');
  });

  it('refuses a resend for a TOTP account', async () => {
    const { account, phone } = await makeSmsClinician();
    await prisma.account.update({
      where: { id: account.id },
      data: { mfaMode: 'TOTP', mfaSecret: encryptField('JBSWY3DPEHPK3PXP') },
    });
    const first = await login(prisma, { phone, password: PASSWORD });
    await expect(resendMfaCode(prisma, first.mfaToken!)).rejects.toThrow(
      /authenticator app/i,
    );
  });
});

describe('break-glass notification', () => {
  it('THE PATIENT IS TOLD — an emergency access buzzes their phone', async () => {
    // A clinician with an open session.
    seq++;
    const docPerson = await makePerson(`07220000${String(seq).padStart(2, '0')}`);
    const { practitioner } = await registerPractitioner(prisma, {
      personId: docPerson.id,
      cadre: 'DOCTOR',
      countyId: ctx.countyId,
      subcountyId: ctx.subcountyId,
      licenceNumber: `KMPDC/2026/BG${String(seq).padStart(3, '0')}`,
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
    const { session } = await checkIn(prisma, {
      practitionerId: practitioner.id,
      facilityId: facility.id,
    });

    seq++;
    const patientPhone = `07230000${String(seq).padStart(2, '0')}`;
    const patient = await makePerson(patientPhone);

    // Give them a restricted record worth breaking glass for.
    const encounter = await openEncounter(prisma, {
      practitionerId: practitioner.id,
      personId: patient.id,
      kind: 'OUTPATIENT',
      chiefComplaint: 'review',
    });
    await recordDiagnosis(prisma, {
      practitionerId: practitioner.id,
      encounterId: encounter.id,
      icd11Code: '1C62.Z',
    });
    sms.clear();

    await breakGlass(prisma, {
      personId: patient.id,
      practitionerId: practitioner.id,
      checkInId: session.id,
      facilityId: facility.id,
      reasonCode: 'UNCONSCIOUS',
      justification: 'Patient brought in unconscious after RTA, no next of kin present',
      categories: ['HIV'],
    });

    await new Promise((r) => setTimeout(r, 50));

    const alert = sms.lastTo(normalisePhone(patientPhone));
    expect(alert).toBeDefined();
    expect(alert!.purpose).toBe('BREAK_GLASS');
    expect(alert!.body).toMatch(/emergency access/i);
    expect(alert!.body).toMatch(/Kisumu County Referral/);
    // It must NOT say what was opened.
    expect(alert!.body).not.toMatch(/HIV|1C62/i);
  });

  it('grants access even when the gateway is down', async () => {
    setSmsProvider({
      name: 'DEAD',
      async send() {
        throw new Error('gateway unreachable');
      },
    });

    seq++;
    const docPerson = await makePerson(`07240000${String(seq).padStart(2, '0')}`);
    const { practitioner } = await registerPractitioner(prisma, {
      personId: docPerson.id,
      cadre: 'DOCTOR',
      countyId: ctx.countyId,
      subcountyId: ctx.subcountyId,
      licenceNumber: `KMPDC/2026/DN${String(seq).padStart(3, '0')}`,
    });
    const facility = await registerFacility(prisma, {
      name: 'Migosi Health Centre',
      kephLevel: 4,
      ownership: 'PUBLIC_MOH',
      countyId: ctx.countyId,
      subcountyId: ctx.subcountyId,
      locality: 'Migosi',
      latitude: -0.1,
      longitude: 34.77,
    });
    await approveFacility(prisma, facility.id, 'ministry-1');
    await grantAffiliation(prisma, {
      practitionerId: practitioner.id,
      facilityId: facility.id,
      grantedBy: 'ministry-1',
      grantedByKind: 'MINISTRY',
    });
    const { session } = await checkIn(prisma, {
      practitionerId: practitioner.id,
      facilityId: facility.id,
    });

    seq++;
    const patient = await makePerson(`07250000${String(seq).padStart(2, '0')}`);

    // A clinician treating an unconscious patient must not wait on an SMS
    // gateway. The unsent alert is caught by unnotifiedBreakGlass() instead.
    const event = await breakGlass(prisma, {
      personId: patient.id,
      practitionerId: practitioner.id,
      checkInId: session.id,
      facilityId: facility.id,
      reasonCode: 'LIFE_THREATENING',
      justification: 'Severe bleeding, needs transfusion history immediately',
      categories: ['HIV'],
    });

    expect(event.id).toBeTruthy();
    expect(event.patientNotifiedAt).toBeNull();
    await new Promise((r) => setTimeout(r, 30));
  });
});
