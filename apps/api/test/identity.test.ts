/**
 * PHASE 1 — identity.
 *
 * The test that matters most is "clinical history survives promotion". If
 * that one ever fails, the nhp_id spine is broken and every other guarantee
 * in the system rests on sand.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import 'dotenv/config';
import {
  registerAdult,
  registerDependant,
  addGuardian,
  searchByIdentifier,
  flagDueForPromotion,
  promoteToAdult,
  finalisePromotions,
  ageAt,
} from '../src/identity.js';
import { encryptField, decryptField } from '../src/crypto.js';

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
});
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const ctx = { countyId: '', subcountyId: '', facilityId: '' };

/** A date exactly n years (and optionally m days) before now. */
function yearsAgo(years: number, extraDays = 0): Date {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - years);
  d.setUTCDate(d.getUTCDate() - extraDays);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

async function wipe() {
  await owner.query('SET session_replication_role = replica');
  for (const t of [
    'condition', 'medication', 'allergy', 'encounter', 'access_log',
    'break_glass', 'consent_grant', 'check_in', 'affiliation', 'facility_director', 'licence',
    'practitioner', 'facility_capability', 'facility', 'guardianship',
    'identifier', 'account', 'merge_request', 'agg_condition_daily',
    'person', 'ward', 'subcounty', 'county',
  ]) {
    await owner.query(`DELETE FROM ${t}`);
  }
  await owner.query('SET session_replication_role = origin');
}

beforeAll(async () => {
  await wipe();
});

beforeEach(async () => {
  await wipe();
  const county = await prisma.county.create({
    // A code the facility suite does not use, so the suites cannot collide.
    data: { code: '900', name: 'Kisumu (identity fixture)' },
  });
  const sub = await prisma.subCounty.create({
    data: { countyId: county.id, name: 'Kisumu Central', kind: 'HEALTH_ADMIN' },
  });
  ctx.countyId = county.id;
  ctx.subcountyId = sub.id;
});

afterAll(async () => {
  await prisma.$disconnect();
  await owner.end();
});

const adultInput = (overrides: Partial<Parameters<typeof registerAdult>[1]> = {}) => ({
  nationalId: '39104882',
  phone: '0712345678',
  givenName: "Achieng'",
  familyName: 'Otieno',
  sexAtBirth: 'FEMALE' as const,
  dateOfBirth: yearsAgo(34),
  countyId: ctx.countyId,
  subcountyId: ctx.subcountyId,
  passwordHash: 'argon2id$dummy',
  ...overrides,
});

// =====================================================================

describe('adult registration', () => {
  it('registers with National ID and phone; email stays optional', async () => {
    const person = await registerAdult(prisma, adultInput());

    expect(person.displayNumber).toMatch(/^NHP-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(person.maturity).toBe('ADULT');
    expect(person.account?.email).toBeNull();

    // Names and identifiers are encrypted, not stored in the clear.
    expect(person.givenName).not.toBe("Achieng'");
    expect(decryptField(person.givenName)).toBe("Achieng'");
    expect(person.identifiers[0].value).not.toBe('39104882');
  });

  it('refuses a second registration with the same National ID', async () => {
    await registerAdult(prisma, adultInput());
    await expect(
      registerAdult(prisma, adultInput({ phone: '0722000000' })),
    ).rejects.toThrow(/already registered/i);
  });

  it('treats formatted National IDs as the same identity', async () => {
    await registerAdult(prisma, adultInput());
    // " 39-104-882 " must normalise to the same blind index.
    await expect(
      registerAdult(prisma, adultInput({ nationalId: ' 39-104-882 ', phone: '0722000000' })),
    ).rejects.toThrow(/already registered/i);
  });

  it('treats 0712…, +254712… and 254712… as the same phone', async () => {
    await registerAdult(prisma, adultInput());
    await expect(
      registerAdult(prisma, adultInput({ nationalId: '11111111', phone: '+254712345678' })),
    ).rejects.toThrow(/phone number is already in use/i);
  });

  it('refuses self-registration by someone under 18', async () => {
    await expect(
      registerAdult(prisma, adultInput({ dateOfBirth: yearsAgo(15) })),
    ).rejects.toThrow(/requires age 18/i);
  });
});

describe('dependants and guardianship', () => {
  it('registers a child under a guardian', async () => {
    const guardian = await registerAdult(prisma, adultInput());
    const child = await registerDependant(prisma, {
      guardianPersonId: guardian.id,
      relationship: 'MOTHER',
      evidence: 'BIRTH_CERT',
      birthCertNumber: '0431221',
      givenName: 'Baraka',
      familyName: 'Otieno',
      sexAtBirth: 'MALE',
      dateOfBirth: yearsAgo(6),
      registeredBy: guardian.id,
    });

    expect(child.maturity).toBe('DEPENDANT');
    // Documented evidence is trusted immediately.
    expect(child.verificationState).toBe('VERIFIED');
    // Children inherit the guardian's geography.
    expect(child.countyId).toBe(guardian.countyId);

    const account = await prisma.account.findUnique({ where: { personId: child.id } });
    expect(account).toBeNull(); // a dependant has no credentials
  });

  it('holds a self-declared dependant as PENDING until reviewed', async () => {
    const guardian = await registerAdult(prisma, adultInput());
    const child = await registerDependant(prisma, {
      guardianPersonId: guardian.id,
      relationship: 'FATHER',
      evidence: 'SELF_DECLARED',
      givenName: 'Unverified',
      familyName: 'Child',
      sexAtBirth: 'MALE',
      dateOfBirth: yearsAgo(4),
      registeredBy: guardian.id,
    });
    expect(child.verificationState).toBe('PENDING');
  });

  it('refuses to register an over-18 as a dependant', async () => {
    const guardian = await registerAdult(prisma, adultInput());
    await expect(
      registerDependant(prisma, {
        guardianPersonId: guardian.id,
        relationship: 'MOTHER',
        evidence: 'BIRTH_CERT',
        givenName: 'Adult',
        familyName: 'Child',
        sexAtBirth: 'FEMALE',
        dateOfBirth: yearsAgo(19),
        registeredBy: guardian.id,
      }),
    ).rejects.toThrow(/must be under 18/i);
  });

  it('supports two guardians — searching either ID finds the child', async () => {
    const mother = await registerAdult(prisma, adultInput());
    const father = await registerAdult(
      prisma,
      adultInput({ nationalId: '22222222', phone: '0722000000', givenName: 'Otieno' }),
    );

    const child = await registerDependant(prisma, {
      guardianPersonId: mother.id,
      relationship: 'MOTHER',
      evidence: 'BIRTH_CERT',
      givenName: 'Baraka',
      familyName: 'Otieno',
      sexAtBirth: 'MALE',
      dateOfBirth: yearsAgo(6),
      registeredBy: mother.id,
    });

    await addGuardian(prisma, {
      dependantId: child.id,
      guardianPersonId: father.id,
      relationship: 'FATHER',
      evidence: 'BIRTH_CERT',
      establishedBy: father.id,
    });

    const viaMother = await searchByIdentifier(prisma, '39104882');
    const viaFather = await searchByIdentifier(prisma, '22222222');

    expect(viaMother.dependants.map((d) => d.id)).toContain(child.id);
    expect(viaFather.dependants.map((d) => d.id)).toContain(child.id);
  });
});

describe('search by identifier', () => {
  it('returns the person and their dependants', async () => {
    const guardian = await registerAdult(prisma, adultInput());
    await registerDependant(prisma, {
      guardianPersonId: guardian.id,
      relationship: 'MOTHER',
      evidence: 'BIRTH_CERT',
      givenName: 'Baraka',
      familyName: 'Otieno',
      sexAtBirth: 'MALE',
      dateOfBirth: yearsAgo(6),
      registeredBy: guardian.id,
    });

    const result = await searchByIdentifier(prisma, '39104882');
    expect(result.match?.givenName).toBe("Achieng'");
    expect(result.dependants).toHaveLength(1);
    expect(result.dependants[0].givenName).toBe('Baraka');
    expect(result.dependants[0].age).toBe(6);
  });

  it('returns nothing for an unknown identifier', async () => {
    const result = await searchByIdentifier(prisma, '00000000');
    expect(result.match).toBeNull();
    expect(result.dependants).toEqual([]);
  });

  it('follows a merge pointer to the surviving record', async () => {
    const surviving = await registerAdult(prisma, adultInput());
    const losing = await registerAdult(
      prisma,
      adultInput({ nationalId: '55555555', phone: '0733000000', givenName: 'Duplicate' }),
    );

    await prisma.person.update({
      where: { id: losing.id },
      data: { mergedIntoId: surviving.id },
    });

    // The stale identifier still resolves — to the surviving person.
    const result = await searchByIdentifier(prisma, '55555555');
    expect(result.match?.id).toBe(surviving.id);
    expect(result.match?.givenName).toBe("Achieng'");
  });
});

describe('promotion at 18', () => {
  it('flags dependants who have turned 18', async () => {
    const guardian = await registerAdult(prisma, adultInput());

    // Registered while still 17, now just past their birthday.
    const nearlyAdult = await prisma.person.create({
      data: {
        displayNumber: 'NHP-TEST-AAAA',
        givenName: encryptField('Almost'),
        familyName: encryptField('Adult'),
        sexAtBirth: 'MALE',
        dateOfBirth: yearsAgo(18, 1),
        countyId: ctx.countyId,
        subcountyId: ctx.subcountyId,
        maturity: 'DEPENDANT',
        registeredBy: guardian.id,
        registrationRoute: 'GUARDIAN',
      },
    });

    const young = await registerDependant(prisma, {
      guardianPersonId: guardian.id,
      relationship: 'MOTHER',
      evidence: 'BIRTH_CERT',
      givenName: 'Still',
      familyName: 'Young',
      sexAtBirth: 'FEMALE',
      dateOfBirth: yearsAgo(10),
      registeredBy: guardian.id,
    });

    const result = await flagDueForPromotion(prisma);
    expect(result.ids).toContain(nearlyAdult.id);
    expect(result.ids).not.toContain(young.id);

    const after = await prisma.person.findUnique({ where: { id: nearlyAdult.id } });
    expect(after?.maturity).toBe('PENDING_PROMOTION');
  });

  it('keeps the record reachable during the grace period', async () => {
    const guardian = await registerAdult(prisma, adultInput());
    await prisma.person.create({
      data: {
        displayNumber: 'NHP-TEST-BBBB',
        givenName: encryptField('Grace'),
        familyName: encryptField('Period'),
        sexAtBirth: 'FEMALE',
        dateOfBirth: yearsAgo(18, 5),
        countyId: ctx.countyId,
        subcountyId: ctx.subcountyId,
        maturity: 'DEPENDANT',
        registeredBy: guardian.id,
        registrationRoute: 'GUARDIAN',
        asDependant: {
          create: {
            guardianId: guardian.id,
            relationship: 'MOTHER',
            isPrimary: true,
            establishedBy: guardian.id,
            evidence: 'BIRTH_CERT',
            status: 'ACTIVE',
          },
        },
      },
    });

    await flagDueForPromotion(prisma);

    // Flagged, but care must not be interrupted — still findable.
    const result = await searchByIdentifier(prisma, '39104882');
    expect(result.dependants).toHaveLength(1);
    expect(result.dependants[0].maturity).toBe('PENDING_PROMOTION');
  });

  it('THE CRITICAL TEST — clinical history survives promotion untouched', async () => {
    const guardian = await registerAdult(prisma, adultInput());

    const child = await prisma.person.create({
      data: {
        displayNumber: 'NHP-TEST-CCCC',
        givenName: encryptField('Baraka'),
        familyName: encryptField('Otieno'),
        sexAtBirth: 'MALE',
        dateOfBirth: yearsAgo(18, 2),
        countyId: ctx.countyId,
        subcountyId: ctx.subcountyId,
        maturity: 'DEPENDANT',
        registeredBy: guardian.id,
        registrationRoute: 'GUARDIAN',
        asDependant: {
          create: {
            guardianId: guardian.id,
            relationship: 'MOTHER',
            isPrimary: true,
            establishedBy: guardian.id,
            evidence: 'BIRTH_CERT',
            status: 'ACTIVE',
          },
        },
      },
    });

    // Give the child a clinical record, exactly as a facility would during
    // childhood — through the real Phase 0 check-in gate, with a valid
    // licence. Bypassing the trigger here would weaken the test.
    const facility = await prisma.facility.create({
      data: {
        mflCode: 'MFL-P1',
        name: 'Kisumu County Referral',
        kephLevel: 4,
        ownership: 'PUBLIC_MOH',
        countyId: ctx.countyId,
        subcountyId: ctx.subcountyId,
        locality: 'Milimani',
        latitude: -0.0917,
        longitude: 34.768,
        registrationStatus: 'ACTIVE',
      },
    });
    const pracPerson = await registerAdult(
      prisma,
      adultInput({ nationalId: '77777777', phone: '0744000000', givenName: 'Amina' }),
    );
    const prac = await prisma.practitioner.create({
      data: {
        personId: pracPerson.id,
        cadre: 'DOCTOR',
        countyId: ctx.countyId,
        subcountyId: ctx.subcountyId,
        status: 'ACTIVE',
      },
    });
    await prisma.licence.create({
      data: {
        practitionerId: prac.id,
        regulator: 'KMPDC',
        licenceNumber: 'KMPDC/TEST/1',
        issuedOn: new Date(Date.UTC(2020, 0, 1)),
        expiresOn: new Date(Date.UTC(2030, 0, 1)),
        status: 'ACTIVE',
      },
    });
    const aff = await prisma.affiliation.create({
      data: {
        practitionerId: prac.id,
        facilityId: facility.id,
        grantedBy: 'ministry',
        grantedByKind: 'MINISTRY',
        status: 'ACTIVE',
      },
    });
    const checkIn = await prisma.checkIn.create({
      data: {
        practitionerId: prac.id,
        facilityId: facility.id,
        affiliationId: aff.id,
        expiresAt: new Date(Date.now() + 8 * 3600_000),
      },
    });
    const encounter = await prisma.encounter.create({
      data: {
        personId: child.id,
        checkInId: checkIn.id,
        recordedBy: prac.id,
        facilityId: facility.id,
        licenceNumber: 'KMPDC/TEST/1',
        kind: 'OUTPATIENT',
        startedAt: new Date(),
        chiefComplaint: 'fever',
      },
    });
    const condition = await prisma.condition.create({
      data: {
        personId: child.id,
        checkInId: checkIn.id,
        recordedBy: prac.id,
        facilityId: facility.id,
        licenceNumber: 'KMPDC/TEST/1',
        encounterId: encounter.id,
        icd11Code: '1F41.0',
        icd11Title: 'Plasmodium falciparum malaria',
        icd11Chapter: '01',
        clinicalStatus: 'CONFIRMED',
        kephLevel: 4,
      },
    });
    // --- promote ---
    await flagDueForPromotion(prisma);
    const promoted = await promoteToAdult(prisma, {
      personId: child.id,
      nationalId: '88888888',
      phone: '0755000000',
      passwordHash: 'argon2id$their-own',
    });

    // The person id is unchanged. This is the whole point.
    expect(promoted.id).toBe(child.id);
    expect(promoted.maturity).toBe('ADULT');

    // Every clinical row still points at the same person.
    const encounters = await prisma.encounter.findMany({ where: { personId: child.id } });
    const conditions = await prisma.condition.findMany({ where: { personId: child.id } });
    expect(encounters).toHaveLength(1);
    expect(encounters[0].id).toBe(encounter.id);
    expect(conditions).toHaveLength(1);
    expect(conditions[0].id).toBe(condition.id);
    expect(conditions[0].icd11Code).toBe('1F41.0');

    // They now have their own credentials...
    const account = await prisma.account.findUnique({ where: { personId: child.id } });
    expect(account).not.toBeNull();

    // ...and their own National ID resolves to the same record.
    const bySelf = await searchByIdentifier(prisma, '88888888');
    expect(bySelf.match?.id).toBe(child.id);

    // Guardian authority has ended: the mother's ID no longer lists them.
    const byGuardian = await searchByIdentifier(prisma, '39104882');
    expect(byGuardian.dependants.map((d) => d.id)).not.toContain(child.id);
  });

  it('refuses promotion before 18', async () => {
    const guardian = await registerAdult(prisma, adultInput());
    const child = await registerDependant(prisma, {
      guardianPersonId: guardian.id,
      relationship: 'MOTHER',
      evidence: 'BIRTH_CERT',
      givenName: 'Too',
      familyName: 'Young',
      sexAtBirth: 'MALE',
      dateOfBirth: yearsAgo(12),
      registeredBy: guardian.id,
    });

    await expect(
      promoteToAdult(prisma, {
        personId: child.id,
        nationalId: '99999999',
        phone: '0766000000',
        passwordHash: 'x',
      }),
    ).rejects.toThrow(/requires age 18/i);
  });

  it('refuses promotion onto a National ID that belongs to someone else', async () => {
    const guardian = await registerAdult(prisma, adultInput());
    const child = await prisma.person.create({
      data: {
        displayNumber: 'NHP-TEST-DDDD',
        givenName: encryptField('Clash'),
        familyName: encryptField('Case'),
        sexAtBirth: 'MALE',
        dateOfBirth: yearsAgo(18, 3),
        countyId: ctx.countyId,
        subcountyId: ctx.subcountyId,
        maturity: 'PENDING_PROMOTION',
        registeredBy: guardian.id,
        registrationRoute: 'GUARDIAN',
      },
    });

    await expect(
      promoteToAdult(prisma, {
        personId: child.id,
        nationalId: '39104882', // the guardian's own ID
        phone: '0777000000',
        passwordHash: 'x',
      }),
    ).rejects.toThrow(/already registered to someone else/i);
  });

  it('closes guardian access when the grace period expires', async () => {
    const guardian = await registerAdult(prisma, adultInput());
    await prisma.person.create({
      data: {
        displayNumber: 'NHP-TEST-EEEE',
        givenName: encryptField('Never'),
        familyName: encryptField('Claimed'),
        sexAtBirth: 'FEMALE',
        dateOfBirth: yearsAgo(18, 200), // well past a 90-day grace
        countyId: ctx.countyId,
        subcountyId: ctx.subcountyId,
        maturity: 'PENDING_PROMOTION',
        registeredBy: guardian.id,
        registrationRoute: 'GUARDIAN',
        asDependant: {
          create: {
            guardianId: guardian.id,
            relationship: 'MOTHER',
            isPrimary: true,
            establishedBy: guardian.id,
            evidence: 'BIRTH_CERT',
            status: 'ACTIVE',
          },
        },
      },
    });

    // Before: still visible to the guardian.
    expect((await searchByIdentifier(prisma, '39104882')).dependants).toHaveLength(1);

    const result = await finalisePromotions(prisma, 90);
    expect(result.closed).toBe(1);

    // After: an adult's record is not their parent's to read.
    expect((await searchByIdentifier(prisma, '39104882')).dependants).toHaveLength(0);
  });
});

describe('age arithmetic', () => {
  it('does not count a birthday that has not happened yet', () => {
    const now = new Date(Date.UTC(2026, 7, 23));
    expect(ageAt(new Date(Date.UTC(2008, 7, 24)), now)).toBe(17); // tomorrow
    expect(ageAt(new Date(Date.UTC(2008, 7, 23)), now)).toBe(18); // today
    expect(ageAt(new Date(Date.UTC(2008, 7, 22)), now)).toBe(18); // yesterday
  });
});
