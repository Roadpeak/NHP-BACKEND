/**
 * PHASE 9 — hardening.
 *
 * Merge, offline sync, rate limiting and MFA. The merge tests matter most:
 * an incorrect merge attaches one person's history to another and can
 * directly kill someone, so the guarantee that has to hold is
 * REVERSIBILITY.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import 'dotenv/config';
import {
  scoreMatch,
  findDuplicateCandidates,
  proposeMerge,
  executeMerge,
  reverseMerge,
  resolvePerson,
  mergedPersonIds,
  REVIEW_THRESHOLD,
} from '../src/merge.js';
import {
  acceptEnvelope,
  validateEnvelope,
  markApplied,
  markRejected,
  pendingEnvelopes,
  quarantinedEnvelopes,
  deviceSyncHealth,
  checkSearchRateLimit,
  mfaRequired,
  accountsMissingMfa,
  MAX_OFFLINE_DAYS,
  SEARCH_LIMIT_PER_HOUR,
} from '../src/sync.js';
import { registerAdult, searchByIdentifier } from '../src/identity.js';
import { registerFacility, approveFacility } from '../src/facility.js';
import { registerPractitioner, grantAffiliation, checkIn } from '../src/practitioner.js';
import { openEncounter, recordDiagnosis } from '../src/clinical.js';
import { logAccess } from '../src/consent.js';

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
});
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const ctx = { countyId: '', subcountyId: '' };
let seq = 0;

async function wipe() {
  await owner.query('SET session_replication_role = replica');
  for (const t of [
    'sync_envelope', 'counter_referral', 'referral', 'agg_condition_daily',
    'recommendation', 'condition', 'medication', 'allergy', 'encounter',
    'access_log', 'break_glass', 'consent_grant', 'check_in', 'affiliation',
    'licence', 'practitioner', 'merge_request', 'facility_capability',
    'facility', 'guardianship', 'identifier', 'account', 'person',
  ]) {
    await owner.query(`DELETE FROM ${t}`);
  }
  await owner.query('SET session_replication_role = origin');
}

beforeAll(async () => {
  const county = await prisma.county.upsert({
    where: { code: '906' },
    create: { code: '906', name: 'Kisumu (hardening fixture)' },
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

async function makePerson(
  over: {
    givenName?: string;
    familyName?: string;
    dateOfBirth?: Date;
    sexAtBirth?: 'MALE' | 'FEMALE' | 'INTERSEX';
  } = {},
) {
  seq++;
  return registerAdult(prisma, {
    nationalId: `400000${String(seq).padStart(3, '0')}`,
    phone: `07170000${String(seq).padStart(3, '0')}`,
    givenName: over.givenName ?? 'Achieng',
    familyName: over.familyName ?? 'Otieno',
    sexAtBirth: over.sexAtBirth ?? 'FEMALE',
    dateOfBirth: over.dateOfBirth ?? new Date(Date.UTC(1990, 4, 15)),
    countyId: ctx.countyId,
    subcountyId: ctx.subcountyId,
    passwordHash: 'argon2id$dummy',
  });
}

async function makeClinician() {
  const person = await makePerson({ givenName: 'Amina' });
  seq++;
  const { practitioner } = await registerPractitioner(prisma, {
    personId: person.id,
    cadre: 'DOCTOR',
    countyId: ctx.countyId,
    subcountyId: ctx.subcountyId,
    licenceNumber: `KMPDC/2026/H${String(seq).padStart(3, '0')}`,
  });
  const facility = await registerFacility(prisma, {
    name: `Facility ${seq}`,
    kephLevel: 4,
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
  return { practitioner, facility, session };
}

// =====================================================================

describe('duplicate scoring', () => {
  const base = {
    givenName: 'Achieng',
    familyName: 'Otieno',
    dateOfBirth: new Date(Date.UTC(1990, 4, 15)),
    sexAtBirth: 'FEMALE',
    countyId: 'c1',
  };

  it('scores an exact match highly', () => {
    const { score } = scoreMatch(base, { ...base });
    expect(score).toBe(1);
  });

  it('THE DISCONFIRMER — a sex mismatch caps the score below review', () => {
    // Everything else agrees, but two records differing on sex are almost
    // certainly different people. A false merge is far worse than a missed
    // one, so this must not reach a human's queue as a likely match.
    const { score } = scoreMatch(base, { ...base, sexAtBirth: 'MALE' });
    expect(score).toBeLessThan(REVIEW_THRESHOLD);
  });

  it('ignores case and punctuation in names', () => {
    const { score } = scoreMatch(base, { ...base, familyName: "O'TIENO " });
    expect(score).toBe(1);
  });

  it('scores a different date of birth below review', () => {
    const { score } = scoreMatch(base, {
      ...base,
      dateOfBirth: new Date(Date.UTC(1985, 2, 3)),
    });
    expect(score).toBeLessThan(REVIEW_THRESHOLD);
  });

  it('finds candidates blocked on date of birth', async () => {
    await makePerson();
    await makePerson(); // same name and DOB — a duplicate
    await makePerson({ familyName: 'Wanjiru', dateOfBirth: new Date(Date.UTC(1975, 1, 1)) });

    const candidates = await findDuplicateCandidates(prisma);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].score).toBe(1);
  });
});

describe('merge', () => {
  it('THE TWO-APPROVER RULE — one person cannot authorise a merge alone', async () => {
    const a = await makePerson();
    const b = await makePerson();
    const request = await proposeMerge(prisma, {
      survivingPersonId: a.id,
      mergedPersonId: b.id,
      detectedBy: 'AUTOMATIC',
    });

    await expect(
      executeMerge(prisma, {
        mergeRequestId: request.id,
        approvedBy: 'registrar-1',
        secondApprover: 'registrar-1',
      }),
    ).rejects.toThrow(/two DISTINCT approvers/i);
  });

  it('THE REVERSIBILITY GUARANTEE — merge, then undo it completely', async () => {
    const surviving = await makePerson();
    const duplicate = await makePerson();
    const clinician = await makeClinician();

    // The duplicate has clinical history of its own.
    const e = await openEncounter(prisma, {
      practitionerId: clinician.practitioner.id,
      personId: duplicate.id,
      kind: 'OUTPATIENT',
      chiefComplaint: 'fever',
    });
    await recordDiagnosis(prisma, {
      practitionerId: clinician.practitioner.id,
      encounterId: e.id,
      icd11Code: '1F41.0',
    });

    const request = await proposeMerge(prisma, {
      survivingPersonId: surviving.id,
      mergedPersonId: duplicate.id,
      detectedBy: 'FACILITY_REPORT',
    });

    await executeMerge(prisma, {
      mergeRequestId: request.id,
      approvedBy: 'registrar-1',
      secondApprover: 'registrar-2',
    });

    // Nothing was deleted — the losing row still exists, with its history.
    const after = await prisma.person.findUnique({ where: { id: duplicate.id } });
    expect(after).not.toBeNull();
    expect(after?.mergedIntoId).toBe(surviving.id);
    expect(
      await prisma.condition.count({ where: { personId: duplicate.id } }),
    ).toBe(1);

    // Reads resolve to the survivor.
    expect(await resolvePerson(prisma, duplicate.id)).toBe(surviving.id);

    // The duplicate's identifier now finds the surviving record.
    const found = await searchByIdentifier(prisma, `400000${String(seq - 1).padStart(3, '0')}`);
    expect(found.match).not.toBeNull();

    // --- and now undo it ---
    await reverseMerge(prisma, {
      mergeRequestId: request.id,
      reversedBy: 'registrar-3',
      reason: 'Different people — dates of birth coincidentally identical',
    });

    const restored = await prisma.person.findUnique({ where: { id: duplicate.id } });
    expect(restored?.mergedIntoId).toBeNull();
    expect(restored?.lifeStatus).toBe('ALIVE');
    expect(await resolvePerson(prisma, duplicate.id)).toBe(duplicate.id);

    // The history never moved, so it is still exactly where it was.
    expect(
      await prisma.condition.count({ where: { personId: duplicate.id } }),
    ).toBe(1);
  });

  it('gathers both ids so a merged history is not silently lost', async () => {
    const surviving = await makePerson();
    const duplicate = await makePerson();
    const request = await proposeMerge(prisma, {
      survivingPersonId: surviving.id,
      mergedPersonId: duplicate.id,
      detectedBy: 'AUTOMATIC',
    });
    await executeMerge(prisma, {
      mergeRequestId: request.id,
      approvedBy: 'r1',
      secondApprover: 'r2',
    });

    // A naive query on the survivor alone would lose the duplicate's rows —
    // the exact failure a merge is supposed to fix.
    const ids = await mergedPersonIds(prisma, surviving.id);
    expect(ids).toHaveLength(2);
    expect(ids).toContain(duplicate.id);
  });

  it('refuses to merge a record into itself', async () => {
    const a = await makePerson();
    await expect(
      proposeMerge(prisma, {
        survivingPersonId: a.id,
        mergedPersonId: a.id,
        detectedBy: 'AUTOMATIC',
      }),
    ).rejects.toThrow(/into itself/i);
  });

  it('refuses to merge an already-merged record', async () => {
    const a = await makePerson();
    const b = await makePerson();
    const c = await makePerson();

    const first = await proposeMerge(prisma, {
      survivingPersonId: a.id,
      mergedPersonId: b.id,
      detectedBy: 'AUTOMATIC',
    });
    await executeMerge(prisma, {
      mergeRequestId: first.id,
      approvedBy: 'r1',
      secondApprover: 'r2',
    });

    await expect(
      proposeMerge(prisma, {
        survivingPersonId: c.id,
        mergedPersonId: b.id,
        detectedBy: 'AUTOMATIC',
      }),
    ).rejects.toThrow(/already been merged/i);
  });

  it('closes the duplicate account — one person, one login', async () => {
    const surviving = await makePerson();
    const duplicate = await makePerson();
    const request = await proposeMerge(prisma, {
      survivingPersonId: surviving.id,
      mergedPersonId: duplicate.id,
      detectedBy: 'AUTOMATIC',
    });
    await executeMerge(prisma, {
      mergeRequestId: request.id,
      approvedBy: 'r1',
      secondApprover: 'r2',
    });

    const account = await prisma.account.findFirst({
      where: { phoneIndex: { not: '' }, status: 'CLOSED' },
    });
    expect(account).not.toBeNull();
  });
});

describe('offline sync', () => {
  it('THE REPLAY — the same envelope applied twice takes effect once', async () => {
    const clinician = await makeClinician();
    const patient = await makePerson();

    const envelope = {
      idempotencyKey: 'device-1:enc:0001',
      deviceId: 'device-1',
      practitionerId: clinician.practitioner.id,
      facilityId: clinician.facility.id,
      checkInId: clinician.session.id,
      operation: 'CREATE_ENCOUNTER' as const,
      payload: { personId: patient.id, chiefComplaint: 'fever' },
      occurredAt: new Date(),
    };

    const first = await acceptEnvelope(prisma, envelope);
    expect(first.duplicate).toBe(false);

    // Clients replay their queue on every reconnect — this must be a normal
    // outcome, not an error.
    const second = await acceptEnvelope(prisma, envelope);
    expect(second.duplicate).toBe(true);
    expect(second.envelope.id).toBe(first.envelope.id);

    expect(await prisma.syncEnvelope.count()).toBe(1);
  });

  it('preserves when the clinician actually worked, not when it synced', async () => {
    const clinician = await makeClinician();
    const patient = await makePerson();

    const threeHoursAgo = new Date(Date.now() - 3 * 3_600_000);
    const { envelope } = await acceptEnvelope(prisma, {
      idempotencyKey: 'device-1:enc:0002',
      deviceId: 'device-1',
      practitionerId: clinician.practitioner.id,
      facilityId: clinician.facility.id,
      checkInId: clinician.session.id,
      operation: 'CREATE_ENCOUNTER',
      payload: { personId: patient.id },
      occurredAt: threeHoursAgo,
    });

    // Otherwise a week of offline work all appears to have happened at once.
    expect(envelope.occurredAt.getTime()).toBe(threeHoursAgo.getTime());
    expect(envelope.receivedAt.getTime()).toBeGreaterThan(threeHoursAgo.getTime());
  });

  it('quarantines a stale envelope rather than dropping it', async () => {
    const clinician = await makeClinician();
    const { envelope } = await acceptEnvelope(prisma, {
      idempotencyKey: 'device-1:enc:stale',
      deviceId: 'device-1',
      practitionerId: clinician.practitioner.id,
      facilityId: clinician.facility.id,
      checkInId: clinician.session.id,
      operation: 'CREATE_ENCOUNTER',
      payload: {},
      occurredAt: new Date(Date.now() - (MAX_OFFLINE_DAYS + 5) * 86_400_000),
    });

    expect(envelope.status).toBe('CONFLICT');
    expect(envelope.rejectionCode).toBe('STALE_ENVELOPE');
    expect((await quarantinedEnvelopes(prisma)).map((q) => q.id)).toContain(envelope.id);
  });

  it('refuses a future timestamp', async () => {
    const clinician = await makeClinician();
    await expect(
      acceptEnvelope(prisma, {
        idempotencyKey: 'device-1:enc:future',
        deviceId: 'device-1',
        practitionerId: clinician.practitioner.id,
        facilityId: clinician.facility.id,
        checkInId: clinician.session.id,
        operation: 'CREATE_ENCOUNTER',
        payload: {},
        occurredAt: new Date(Date.now() + 86_400_000),
      }),
    ).rejects.toThrow(/future|device clock/i);
  });

  it('THE GATE STILL APPLIES — a late write outside its session is refused', async () => {
    const clinician = await makeClinician();

    // Timestamped before the session even opened.
    const { envelope } = await acceptEnvelope(prisma, {
      idempotencyKey: 'device-1:enc:outside',
      deviceId: 'device-1',
      practitionerId: clinician.practitioner.id,
      facilityId: clinician.facility.id,
      checkInId: clinician.session.id,
      operation: 'CREATE_ENCOUNTER',
      payload: {},
      occurredAt: new Date(clinician.session.startedAt.getTime() - 3_600_000),
    });

    const check = await validateEnvelope(prisma, envelope.id);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.code).toBe('OUTSIDE_SESSION');
  });

  it('refuses an envelope claiming someone else’s session', async () => {
    const a = await makeClinician();
    const b = await makeClinician();

    const { envelope } = await acceptEnvelope(prisma, {
      idempotencyKey: 'device-2:enc:0001',
      deviceId: 'device-2',
      practitionerId: b.practitioner.id,
      facilityId: a.facility.id,
      checkInId: a.session.id, // not theirs
      operation: 'CREATE_ENCOUNTER',
      payload: {},
      occurredAt: new Date(),
    });

    const check = await validateEnvelope(prisma, envelope.id);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.code).toBe('WRONG_PRACTITIONER');
  });

  it('accepts a valid envelope and applies it', async () => {
    const clinician = await makeClinician();
    const patient = await makePerson();

    const { envelope } = await acceptEnvelope(prisma, {
      idempotencyKey: 'device-1:enc:valid',
      deviceId: 'device-1',
      practitionerId: clinician.practitioner.id,
      facilityId: clinician.facility.id,
      checkInId: clinician.session.id,
      operation: 'CREATE_ENCOUNTER',
      payload: { personId: patient.id },
      occurredAt: new Date(),
    });

    expect((await validateEnvelope(prisma, envelope.id)).ok).toBe(true);
    expect((await pendingEnvelopes(prisma)).map((e) => e.id)).toContain(envelope.id);

    const applied = await markApplied(prisma, envelope.id, 'encounter-123');
    expect(applied.status).toBe('APPLIED');
    expect(applied.resultId).toBe('encounter-123');
    expect(await pendingEnvelopes(prisma)).toHaveLength(0);
  });

  it('surfaces a device whose writes keep failing', async () => {
    const clinician = await makeClinician();

    for (let i = 0; i < 3; i++) {
      const { envelope } = await acceptEnvelope(prisma, {
        idempotencyKey: `bad-device:enc:${i}`,
        deviceId: 'bad-device',
        practitionerId: clinician.practitioner.id,
        facilityId: clinician.facility.id,
        checkInId: clinician.session.id,
        operation: 'CREATE_ENCOUNTER',
        payload: {},
        occurredAt: new Date(),
      });
      await markRejected(prisma, envelope.id, 'OUTSIDE_SESSION', 'test');
    }

    const health = await deviceSyncHealth(prisma, new Date(Date.now() - 3_600_000));
    const bad = health.find((h) => h.deviceId === 'bad-device');
    // A facility quietly falling out of the record, visible before anyone
    // notices the data stopped arriving.
    expect(bad?.rejected).toBe(3);
    expect(bad?.failureRatePercent).toBe(100);
  });
});

describe('rate limiting', () => {
  it('counts searches from the audit log, so limit and evidence agree', async () => {
    const clinician = await makeClinician();
    const patient = await makePerson();

    const before = await checkSearchRateLimit(prisma, clinician.practitioner.id);
    expect(before.allowed).toBe(true);
    expect(before.used).toBe(0);

    for (let i = 0; i < 5; i++) {
      await logAccess(prisma, {
        personId: patient.id,
        practitionerId: clinician.practitioner.id,
        checkInId: clinician.session.id,
        facilityId: clinician.facility.id,
        action: 'SEARCH',
        tierReached: 'TIER_2_GENERAL',
        reason: 'ACTIVE_CONSULTATION',
        outcome: 'GRANTED',
        requestId: `rate-${i}`,
      });
    }

    const after = await checkSearchRateLimit(prisma, clinician.practitioner.id);
    expect(after.used).toBe(5);
    expect(after.limit).toBe(SEARCH_LIMIT_PER_HOUR);
    expect(after.allowed).toBe(true);
  });

  it('blocks once the hourly limit is reached', async () => {
    const clinician = await makeClinician();
    const patient = await makePerson();

    for (let i = 0; i < SEARCH_LIMIT_PER_HOUR; i++) {
      await logAccess(prisma, {
        personId: patient.id,
        practitionerId: clinician.practitioner.id,
        checkInId: clinician.session.id,
        facilityId: clinician.facility.id,
        action: 'SEARCH',
        tierReached: 'TIER_2_GENERAL',
        reason: 'ACTIVE_CONSULTATION',
        outcome: 'GRANTED',
        requestId: `limit-${i}`,
      });
    }

    const limited = await checkSearchRateLimit(prisma, clinician.practitioner.id);
    expect(limited.allowed).toBe(false);
    expect(limited.used).toBe(SEARCH_LIMIT_PER_HOUR);
  });
});

describe('MFA', () => {
  it('requires a second factor for clinical accounts', async () => {
    const person = await makePerson();
    seq++;
    const { practitioner } = await registerPractitioner(prisma, {
      personId: person.id,
      cadre: 'DOCTOR',
      countyId: ctx.countyId,
      subcountyId: ctx.subcountyId,
      licenceNumber: `KMPDC/2026/F${String(seq).padStart(3, '0')}`,
    });
    const account = await prisma.account.create({
      data: {
        practitionerId: practitioner.id,
        phone: 'enc:0700000001',
        phoneIndex: `mfa-req-${seq}`,
        passwordHash: 'argon2id$x',
        mfaMode: 'NONE',
        status: 'ACTIVE',
      },
    });

    const result = await mfaRequired(prisma, account.id);
    expect(result.required).toBe(true);
    expect(result.enrolled).toBe(false);
    expect(result.reason).toMatch(/identifiable health data/i);
  });

  it('does not require it of citizens', async () => {
    const person = await makePerson();
    const account = await prisma.account.findFirstOrThrow({
      where: { personId: person.id },
    });

    const result = await mfaRequired(prisma, account.id);
    expect(result.required).toBe(false);
    expect(result.reason).toMatch(/citizen/i);
  });

  it('lists privileged accounts with no second factor', async () => {
    const person = await makePerson();
    seq++;
    const { practitioner } = await registerPractitioner(prisma, {
      personId: person.id,
      cadre: 'DOCTOR',
      countyId: ctx.countyId,
      subcountyId: ctx.subcountyId,
      licenceNumber: `KMPDC/2026/M${String(seq).padStart(3, '0')}`,
    });

    // Attach a practitioner-scoped account, as the auth module would.
    await prisma.account.create({
      data: {
        practitionerId: practitioner.id,
        phone: 'enc:0700000000',
        phoneIndex: `mfa-idx-${seq}`,
        passwordHash: 'argon2id$x',
        mfaMode: 'NONE',
        status: 'ACTIVE',
      },
    });

    const missing = await accountsMissingMfa(prisma);
    // A client that "forgets" to prompt must not reach a national health
    // record — so this list is the enforcement backlog, not a nicety.
    expect(missing.some((m) => m.subjectId === practitioner.id)).toBe(true);
  });
});
