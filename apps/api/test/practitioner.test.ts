/**
 * PHASE 3 — practitioners, affiliation and check-in.
 *
 * The scenario that matters: a doctor affiliated to two facilities, checked
 * into one, blocked from writing at the other. That is the guarantee the
 * whole attribution model rests on.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import 'dotenv/config';
import {
  registerPractitioner,
  grantAffiliation,
  endAffiliation,
  checkIn,
  currentSession,
  extendSession,
  closeExpiredSessions,
  canWriteClinical,
  licencesExpiringSoon,
  expireLapsedLicences,
  SESSION_HOURS,
  MAX_SESSION_HOURS,
} from '../src/practitioner.js';
import { REGULATOR_FOR_CADRE } from '../src/verification.js';
import { registerAdult } from '../src/identity.js';
import { registerFacility, approveFacility } from '../src/facility.js';

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
});
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const ctx = { countyId: '', subcountyId: '' };
let personSeq = 0;

async function wipe() {
  await owner.query('SET session_replication_role = replica');
  for (const t of [
    'condition', 'medication', 'allergy', 'encounter', 'access_log',
    'check_in', 'affiliation', 'licence', 'practitioner',
    'facility_capability', 'facility', 'guardianship', 'identifier',
    'account', 'person',
  ]) {
    await owner.query(`DELETE FROM ${t}`);
  }
  await owner.query('SET session_replication_role = origin');
}

beforeAll(async () => {
  const county = await prisma.county.upsert({
    where: { code: '901' },
    create: { code: '901', name: 'Kisumu (practitioner fixture)' },
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

/** A fresh adult identity, since each practitioner needs a distinct person. */
async function makePerson(givenName = 'Amina') {
  personSeq++;
  return registerAdult(prisma, {
    nationalId: `900000${String(personSeq).padStart(2, '0')}`,
    phone: `07120000${String(personSeq).padStart(2, '0')}`,
    givenName,
    familyName: 'Wanjiru',
    sexAtBirth: 'FEMALE',
    dateOfBirth: new Date(Date.UTC(1990, 0, 1)),
    countyId: ctx.countyId,
    subcountyId: ctx.subcountyId,
    passwordHash: 'argon2id$dummy',
  });
}

async function makeFacility(
  name: string,
  ownership: 'PUBLIC_MOH' | 'PRIVATE_FOR_PROFIT' = 'PUBLIC_MOH',
) {
  const f = await registerFacility(prisma, {
    name,
    kephLevel: 4,
    ownership,
    countyId: ctx.countyId,
    subcountyId: ctx.subcountyId,
    locality: 'Milimani',
    latitude: -0.0917,
    longitude: 34.768,
  });
  await approveFacility(prisma, f.id, 'ministry-user-1');
  return f;
}

/** A registered, licence-verified doctor. */
async function makeDoctor(licenceNumber = 'KMPDC/2026/0001') {
  const person = await makePerson();
  const result = await registerPractitioner(prisma, {
    personId: person.id,
    cadre: 'DOCTOR',
    countyId: ctx.countyId,
    subcountyId: ctx.subcountyId,
    licenceNumber,
    familyName: 'Wanjiru',
  });
  return result;
}

// =====================================================================

describe('regulator routing', () => {
  it('maps each cadre to the right register', () => {
    expect(REGULATOR_FOR_CADRE.DOCTOR).toBe('KMPDC');
    expect(REGULATOR_FOR_CADRE.NURSE).toBe('NCK');
    expect(REGULATOR_FOR_CADRE.CLINICAL_OFFICER).toBe('COC');
    expect(REGULATOR_FOR_CADRE.PHARMACIST).toBe('PPB');
    // No statutory register — must not be forced to supply one.
    expect(REGULATOR_FOR_CADRE.CHW).toBeNull();
  });

  it('refuses a cadre registered with the wrong body', async () => {
    const person = await makePerson();
    await expect(
      registerPractitioner(prisma, {
        personId: person.id,
        cadre: 'NURSE',
        countyId: ctx.countyId,
        subcountyId: ctx.subcountyId,
        licenceNumber: 'KMPDC/2026/0009',
        regulator: 'KMPDC', // nurses register with NCK
      }),
    ).rejects.toThrow(/registers with NCK/i);
  });
});

describe('practitioner registration', () => {
  it('activates on a verified licence', async () => {
    const { practitioner, licence, verification } = await makeDoctor();
    expect(verification?.outcome).toBe('VERIFIED');
    expect(licence?.status).toBe('ACTIVE');
    expect(practitioner.status).toBe('ACTIVE');
  });

  it('stays PENDING when the register is unreachable', async () => {
    const person = await makePerson();
    const { practitioner, licence } = await registerPractitioner(prisma, {
      personId: person.id,
      cadre: 'DOCTOR',
      countyId: ctx.countyId,
      subcountyId: ctx.subcountyId,
      licenceNumber: 'KMPDC/DOWN/0001',
    });
    // A regulator being down must not block registration outright, but it
    // must not silently activate the account either.
    expect(licence?.status).toBe('PENDING');
    expect(practitioner.status).toBe('PENDING');
  });

  it('suspends an account whose licence is struck off', async () => {
    const person = await makePerson();
    const { practitioner, licence } = await registerPractitioner(prisma, {
      personId: person.id,
      cadre: 'DOCTOR',
      countyId: ctx.countyId,
      subcountyId: ctx.subcountyId,
      licenceNumber: 'KMPDC/STRUCK/0001',
    });
    expect(licence?.status).toBe('SUSPENDED');
    expect(practitioner.status).toBe('PENDING');
  });

  it('requires a licence for a cadre that has a register', async () => {
    const person = await makePerson();
    await expect(
      registerPractitioner(prisma, {
        personId: person.id,
        cadre: 'CLINICAL_OFFICER',
        countyId: ctx.countyId,
        subcountyId: ctx.subcountyId,
      }),
    ).rejects.toThrow(/must supply a COC registration/i);
  });

  it('allows a community health worker with no licence', async () => {
    const person = await makePerson();
    const { practitioner, licence } = await registerPractitioner(prisma, {
      personId: person.id,
      cadre: 'CHW',
      countyId: ctx.countyId,
      subcountyId: ctx.subcountyId,
    });
    expect(licence).toBeNull();
    expect(practitioner.cadre).toBe('CHW');
  });

  it('refuses a licence number already held by someone else', async () => {
    await makeDoctor('KMPDC/2026/SHARED');
    const other = await makePerson('Otieno');
    await expect(
      registerPractitioner(prisma, {
        personId: other.id,
        cadre: 'DOCTOR',
        countyId: ctx.countyId,
        subcountyId: ctx.subcountyId,
        licenceNumber: 'KMPDC/2026/SHARED',
      }),
    ).rejects.toThrow(/already registered to another/i);
  });
});

describe('affiliation authority', () => {
  it('requires the Ministry to staff a public facility', async () => {
    const { practitioner } = await makeDoctor();
    const publicFacility = await makeFacility('Kisumu County Referral', 'PUBLIC_MOH');

    await expect(
      grantAffiliation(prisma, {
        practitionerId: practitioner.id,
        facilityId: publicFacility.id,
        grantedBy: 'facility-admin-1',
        grantedByKind: 'FACILITY',
      }),
    ).rejects.toThrow(/only the Ministry may assign staff/i);

    const ok = await grantAffiliation(prisma, {
      practitionerId: practitioner.id,
      facilityId: publicFacility.id,
      grantedBy: 'ministry-user-1',
      grantedByKind: 'MINISTRY',
    });
    expect(ok.status).toBe('ACTIVE');
  });

  it('lets a private facility grant its own affiliations', async () => {
    const { practitioner } = await makeDoctor();
    const privateFacility = await makeFacility('Aga Khan Kisumu', 'PRIVATE_FOR_PROFIT');

    await expect(
      grantAffiliation(prisma, {
        practitionerId: practitioner.id,
        facilityId: privateFacility.id,
        grantedBy: 'ministry-user-1',
        grantedByKind: 'MINISTRY',
      }),
    ).rejects.toThrow(/facility grants its own/i);

    const ok = await grantAffiliation(prisma, {
      practitionerId: practitioner.id,
      facilityId: privateFacility.id,
      grantedBy: 'facility-admin-1',
      grantedByKind: 'FACILITY',
    });
    expect(ok.status).toBe('ACTIVE');
  });

  it('refuses affiliation to a facility that is not ACTIVE', async () => {
    const { practitioner } = await makeDoctor();
    const pending = await registerFacility(prisma, {
      name: 'Unapproved Clinic',
      kephLevel: 3,
      ownership: 'PRIVATE_FOR_PROFIT',
      countyId: ctx.countyId,
      subcountyId: ctx.subcountyId,
      locality: 'Nyalenda',
      latitude: -0.1,
      longitude: 34.76,
    });

    await expect(
      grantAffiliation(prisma, {
        practitionerId: practitioner.id,
        facilityId: pending.id,
        grantedBy: 'facility-admin-1',
        grantedByKind: 'FACILITY',
      }),
    ).rejects.toThrow(/is PENDING, not ACTIVE/i);
  });
});

describe('check-in', () => {
  it('THE CORE SCENARIO — affiliated to two facilities, may write at one', async () => {
    const { practitioner } = await makeDoctor();
    const referral = await makeFacility('Kisumu County Referral');
    const healthCentre = await makeFacility('Migosi Health Centre');

    for (const f of [referral, healthCentre]) {
      await grantAffiliation(prisma, {
        practitionerId: practitioner.id,
        facilityId: f.id,
        grantedBy: 'ministry-user-1',
        grantedByKind: 'MINISTRY',
      });
    }

    const { session } = await checkIn(prisma, {
      practitionerId: practitioner.id,
      facilityId: referral.id,
    });
    expect(session.facilityId).toBe(referral.id);

    // Cleared to write — at the facility they checked into.
    const gate = await canWriteClinical(prisma, practitioner.id);
    expect(gate.allowed).toBe(true);
    if (gate.allowed) expect(gate.facilityId).toBe(referral.id);

    // And the database refuses a row that claims the OTHER facility, even
    // though the doctor is legitimately affiliated to it.
    await expect(
      prisma.encounter.create({
        data: {
          personId: (await makePerson('Patient')).id,
          checkInId: session.id,
          recordedBy: practitioner.id,
          facilityId: healthCentre.id, // not where they are checked in
          licenceNumber: 'KMPDC/2026/0001',
          kind: 'OUTPATIENT',
          startedAt: new Date(),
          chiefComplaint: 'fever',
        },
      }),
    ).rejects.toThrow(/claims facility/i);
  });

  it('refuses check-in without an affiliation', async () => {
    const { practitioner } = await makeDoctor();
    const facility = await makeFacility('Somewhere Else');

    await expect(
      checkIn(prisma, { practitionerId: practitioner.id, facilityId: facility.id }),
    ).rejects.toThrow(/not affiliated|cannot be self-declared/i);
  });

  it('refuses a second session while one is open elsewhere', async () => {
    const { practitioner } = await makeDoctor();
    const a = await makeFacility('Facility A');
    const b = await makeFacility('Facility B');
    for (const f of [a, b]) {
      await grantAffiliation(prisma, {
        practitionerId: practitioner.id,
        facilityId: f.id,
        grantedBy: 'ministry-user-1',
        grantedByKind: 'MINISTRY',
      });
    }

    await checkIn(prisma, { practitionerId: practitioner.id, facilityId: a.id });
    await expect(
      checkIn(prisma, { practitionerId: practitioner.id, facilityId: b.id }),
    ).rejects.toThrow(/still checked in at Facility A/i);
  });

  it('refuses check-in on a suspended account', async () => {
    const person = await makePerson();
    const { practitioner } = await registerPractitioner(prisma, {
      personId: person.id,
      cadre: 'DOCTOR',
      countyId: ctx.countyId,
      subcountyId: ctx.subcountyId,
      licenceNumber: 'KMPDC/SUSPENDED/0001',
    });
    const facility = await makeFacility('Kisumu County Referral');

    // The affiliation can exist, but the account cannot open a session.
    await prisma.affiliation.create({
      data: {
        practitionerId: practitioner.id,
        facilityId: facility.id,
        grantedBy: 'ministry-user-1',
        grantedByKind: 'MINISTRY',
        status: 'ACTIVE',
      },
    });

    await expect(
      checkIn(prisma, { practitionerId: practitioner.id, facilityId: facility.id }),
    ).rejects.toThrow(/is PENDING, not ACTIVE/i);
  });

  it('sets a session window of SESSION_HOURS', async () => {
    const { practitioner } = await makeDoctor();
    const facility = await makeFacility('Kisumu County Referral');
    await grantAffiliation(prisma, {
      practitionerId: practitioner.id,
      facilityId: facility.id,
      grantedBy: 'ministry-user-1',
      grantedByKind: 'MINISTRY',
    });

    const now = new Date();
    const { session } = await checkIn(
      prisma,
      { practitionerId: practitioner.id, facilityId: facility.id },
      now,
    );
    const hours = (session.expiresAt.getTime() - session.startedAt.getTime()) / 3_600_000;
    expect(hours).toBeCloseTo(SESSION_HOURS, 1);
  });

  it('reports time remaining and warns near expiry', async () => {
    const { practitioner } = await makeDoctor();
    const facility = await makeFacility('Kisumu County Referral');
    await grantAffiliation(prisma, {
      practitionerId: practitioner.id,
      facilityId: facility.id,
      grantedBy: 'ministry-user-1',
      grantedByKind: 'MINISTRY',
    });

    const start = new Date();
    await checkIn(prisma, { practitionerId: practitioner.id, facilityId: facility.id }, start);

    const fresh = await currentSession(prisma, practitioner.id, start);
    expect(fresh?.expiringSoon).toBe(false);

    // Ten minutes before expiry.
    const nearEnd = new Date(start.getTime() + (SESSION_HOURS * 60 - 10) * 60_000);
    const late = await currentSession(prisma, practitioner.id, nearEnd);
    expect(late?.minutesRemaining).toBe(10);
    expect(late?.expiringSoon).toBe(true);
  });

  it('extends only in the final hour', async () => {
    const { practitioner } = await makeDoctor();
    const facility = await makeFacility('Kisumu County Referral');
    await grantAffiliation(prisma, {
      practitionerId: practitioner.id,
      facilityId: facility.id,
      grantedBy: 'ministry-user-1',
      grantedByKind: 'MINISTRY',
    });

    const start = new Date();
    await checkIn(prisma, { practitionerId: practitioner.id, facilityId: facility.id }, start);

    // Too early — otherwise nobody would ever check out.
    await expect(extendSession(prisma, practitioner.id, start)).rejects.toThrow(
      /only available in the final hour/i,
    );

    const nearEnd = new Date(start.getTime() + (SESSION_HOURS * 60 - 30) * 60_000);
    const extended = await extendSession(prisma, practitioner.id, nearEnd);

    // The extension buys more time...
    expect(extended.expiresAt.getTime()).toBeGreaterThan(
      start.getTime() + SESSION_HOURS * 3_600_000,
    );
    // ...but is clamped to the 24-hour ceiling from check-in, so rolling
    // extensions cannot turn a shift into a permanent session.
    expect(extended.expiresAt.getTime()).toBe(
      start.getTime() + MAX_SESSION_HOURS * 3_600_000,
    );
  });

  it('refuses to extend a session that has hit the 24-hour ceiling', async () => {
    const { practitioner } = await makeDoctor();
    const facility = await makeFacility('Kisumu County Referral');
    await grantAffiliation(prisma, {
      practitionerId: practitioner.id,
      facilityId: facility.id,
      grantedBy: 'ministry-user-1',
      grantedByKind: 'MINISTRY',
    });

    const start = new Date();
    await checkIn(prisma, { practitionerId: practitioner.id, facilityId: facility.id }, start);

    // Top up once, near the end of the first window. This clamps the
    // session to exactly the 24-hour ceiling.
    const firstTopUp = new Date(start.getTime() + (SESSION_HOURS - 0.5) * 3_600_000);
    const clamped = await extendSession(prisma, practitioner.id, firstTopUp);
    expect(clamped.expiresAt.getTime()).toBe(
      start.getTime() + MAX_SESSION_HOURS * 3_600_000,
    );

    // A second top-up an hour later buys nothing — the session is already
    // at its ceiling, so the clamp is a no-op rather than a rolling renewal.
    const secondTopUp = new Date(start.getTime() + (MAX_SESSION_HOURS - 0.5) * 3_600_000);
    const stillClamped = await extendSession(prisma, practitioner.id, secondTopUp);
    expect(stillClamped.expiresAt.getTime()).toBe(
      start.getTime() + MAX_SESSION_HOURS * 3_600_000,
    );

    // Once the ceiling has actually passed there is no session left to
    // extend at all — the clinician must check out and start a new shift.
    const pastCeiling = new Date(start.getTime() + (MAX_SESSION_HOURS + 1) * 3_600_000);
    await expect(extendSession(prisma, practitioner.id, pastCeiling)).rejects.toThrow(
      /no open session/i,
    );
  });

  it('closes sessions nobody checked out of', async () => {
    const { practitioner } = await makeDoctor();
    const facility = await makeFacility('Kisumu County Referral');
    await grantAffiliation(prisma, {
      practitionerId: practitioner.id,
      facilityId: facility.id,
      grantedBy: 'ministry-user-1',
      grantedByKind: 'MINISTRY',
    });

    const start = new Date(Date.now() - 20 * 3_600_000);
    await checkIn(prisma, { practitionerId: practitioner.id, facilityId: facility.id }, start);

    const result = await closeExpiredSessions(prisma);
    expect(result.closed).toBe(1);
    expect(await currentSession(prisma, practitioner.id)).toBeNull();
  });

  it('closes the open session when an affiliation is revoked', async () => {
    const { practitioner } = await makeDoctor();
    const facility = await makeFacility('Kisumu County Referral');
    const aff = await grantAffiliation(prisma, {
      practitionerId: practitioner.id,
      facilityId: facility.id,
      grantedBy: 'ministry-user-1',
      grantedByKind: 'MINISTRY',
    });

    await checkIn(prisma, { practitionerId: practitioner.id, facilityId: facility.id });
    expect(await currentSession(prisma, practitioner.id)).not.toBeNull();

    // A revoked affiliation must not leave a live session behind it.
    await endAffiliation(prisma, aff.id);
    expect(await currentSession(prisma, practitioner.id)).toBeNull();
  });
});

describe('licence lifecycle', () => {
  it('blocks clinical writes once a licence expires', async () => {
    const { practitioner, licence } = await makeDoctor();
    const facility = await makeFacility('Kisumu County Referral');
    await grantAffiliation(prisma, {
      practitionerId: practitioner.id,
      facilityId: facility.id,
      grantedBy: 'ministry-user-1',
      grantedByKind: 'MINISTRY',
    });
    await checkIn(prisma, { practitionerId: practitioner.id, facilityId: facility.id });

    expect((await canWriteClinical(prisma, practitioner.id)).allowed).toBe(true);

    // The licence lapses mid-session.
    await prisma.licence.update({
      where: { id: licence!.id },
      data: { expiresOn: new Date(Date.now() - 86_400_000) },
    });
    await expireLapsedLicences(prisma);

    const gate = await canWriteClinical(prisma, practitioner.id);
    expect(gate.allowed).toBe(false);
    if (!gate.allowed) expect(gate.code).toBe('NO_ACTIVE_LICENCE');
  });

  it('lists licences expiring soon, with days remaining', async () => {
    const { licence } = await makeDoctor();
    await prisma.licence.update({
      where: { id: licence!.id },
      data: { expiresOn: new Date(Date.now() + 10 * 86_400_000) },
    });

    const soon = await licencesExpiringSoon(prisma, 30);
    expect(soon).toHaveLength(1);
    expect(soon[0].daysRemaining).toBeGreaterThanOrEqual(9);
    expect(soon[0].daysRemaining).toBeLessThanOrEqual(10);
  });

  it('ignores licences that are still comfortably valid', async () => {
    await makeDoctor();
    expect(await licencesExpiringSoon(prisma, 30)).toHaveLength(0);
  });
});

describe('the write gate', () => {
  it('explains why a write is blocked, rather than surfacing a DB error', async () => {
    const { practitioner } = await makeDoctor();

    const gate = await canWriteClinical(prisma, practitioner.id);
    expect(gate.allowed).toBe(false);
    if (!gate.allowed) {
      expect(gate.code).toBe('NO_OPEN_SESSION');
      expect(gate.reason).toMatch(/check in to a facility/i);
    }
  });

  it('agrees with the database — a cleared write actually succeeds', async () => {
    const { practitioner } = await makeDoctor();
    const facility = await makeFacility('Kisumu County Referral');
    await grantAffiliation(prisma, {
      practitionerId: practitioner.id,
      facilityId: facility.id,
      grantedBy: 'ministry-user-1',
      grantedByKind: 'MINISTRY',
    });
    await checkIn(prisma, { practitionerId: practitioner.id, facilityId: facility.id });

    const gate = await canWriteClinical(prisma, practitioner.id);
    expect(gate.allowed).toBe(true);
    if (!gate.allowed) return;

    const patient = await makePerson('Patient');
    const encounter = await prisma.encounter.create({
      data: {
        personId: patient.id,
        checkInId: gate.checkInId,
        recordedBy: practitioner.id,
        facilityId: gate.facilityId,
        licenceNumber: gate.licenceNumber,
        kind: 'OUTPATIENT',
        startedAt: new Date(),
        chiefComplaint: 'fever',
      },
    });
    expect(encounter.id).toBeTruthy();
  });
});
