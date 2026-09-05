/**
 * PHASE 2 — facilities and capabilities.
 *
 * The tests that matter are the ones about stale capability claims. A
 * registry that is merely present is easy; a registry that stays *true* is
 * the hard part, and it is what stops NHP routing a head injury to a
 * hospital whose CT scanner broke eighteen months ago.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import 'dotenv/config';
import {
  registerFacility,
  approveFacility,
  claimCapability,
  verifyCapability,
  reconfirmCapabilities,
  findFacilities,
  findWithWidening,
  freshnessOf,
  haversineKm,
  KEPH_LEVELS,
} from '../src/facility.js';
import { registerAdult } from '../src/identity.js';
import { registerPractitioner } from '../src/practitioner.js';
import { blindIndex, normalisePhone } from '../src/crypto.js';
import { requireFacilityDirector, requireFacilityScope } from '../src/facility-admin.js';
import { login, hashPassword } from '../src/auth.js';

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
});
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const ctx = {
  kisumuId: '',
  kisumuCentralId: '',
  siayaId: '',
  siayaCentralId: '',
};

async function wipeFacilities() {
  await owner.query('SET session_replication_role = replica');
  for (const t of [
    'condition', 'medication', 'allergy', 'encounter', 'check_in',
    'affiliation', 'facility_director', 'licence', 'practitioner', 'facility_capability', 'facility',
  ]) {
    await owner.query(`DELETE FROM ${t}`);
  }
  await owner.query('SET session_replication_role = origin');
}

/**
 * Seeds exactly what these tests need, rather than depending on a prior
 * `pnpm seed` — the identity suite wipes geography, and a test that only
 * passes in a particular file order is not a test.
 */
beforeAll(async () => {
  for (const [code, name] of [
    ['042', 'Kisumu'],
    ['041', 'Siaya'],
  ] as const) {
    const county = await prisma.county.upsert({
      where: { code },
      create: { code, name },
      update: {},
    });
    const sub =
      (await prisma.subCounty.findFirst({ where: { countyId: county.id } })) ??
      (await prisma.subCounty.create({
        data: { countyId: county.id, name: `${name} Central`, kind: 'HEALTH_ADMIN' },
      }));

    if (code === '042') {
      ctx.kisumuId = county.id;
      ctx.kisumuCentralId = sub.id;
    } else {
      ctx.siayaId = county.id;
      ctx.siayaCentralId = sub.id;
    }
  }

  // The capability vocabulary these tests exercise.
  const caps: Array<[string, string, string, 'SERVICE' | 'DIAGNOSTIC' | 'EQUIPMENT', number]> = [
    ['OPD_GENERAL', 'General outpatient care', 'Huduma za wagonjwa wa nje', 'SERVICE', 2],
    ['XRAY', 'X-ray', 'Picha ya X-ray', 'DIAGNOSTIC', 3],
    ['CT_SCAN', 'CT scan', 'Picha ya CT', 'DIAGNOSTIC', 5],
    ['BLOOD_BANK', 'Blood transfusion services', 'Huduma za damu', 'SERVICE', 4],
    ['THEATRE', 'Operating theatre', 'Chumba cha upasuaji', 'EQUIPMENT', 4],
    ['ICU', 'Intensive care unit', 'Kitengo cha uangalizi maalum', 'SERVICE', 5],
  ];
  for (const [code, labelEn, labelSw, domain, minKephLevel] of caps) {
    await prisma.capability.upsert({
      where: { code },
      create: { code, labelEn, labelSw, domain, minKephLevel },
      update: { minKephLevel },
    });
  }
});

beforeEach(async () => {
  await wipeFacilities();
});

afterAll(async () => {
  await prisma.$disconnect();
  await owner.end();
});

const facilityInput = (over: Partial<Parameters<typeof registerFacility>[1]> = {}) => ({
  name: 'Kisumu County Referral',
  kephLevel: 5,
  ownership: 'PUBLIC_MOH' as const,
  countyId: ctx.kisumuId,
  subcountyId: ctx.kisumuCentralId,
  locality: 'Milimani',
  latitude: -0.0917,
  longitude: 34.768,
  is24Hour: true,
  ...over,
});

/** Backdates a capability claim, to simulate a registry going stale. */
async function ageClaim(facilityId: string, code: string, days: number) {
  await owner.query(
    `UPDATE facility_capability fc
        SET last_confirmed_at = now() - ($3 || ' days')::interval
       FROM capability c
      WHERE fc.capability_id = c.id
        AND fc.facility_id = $1 AND c.code = $2`,
    [facilityId, code, String(days)],
  );
}

// =====================================================================

describe('facility registration', () => {
  it('registers as PENDING — a facility cannot activate itself', async () => {
    const f = await registerFacility(prisma, facilityInput());
    expect(f.registrationStatus).toBe('PENDING');

    const approved = await approveFacility(prisma, f.id, 'ministry-user-1');
    expect(approved.registrationStatus).toBe('ACTIVE');
  });

  it('refuses KEPH level 1 — community units have no facility', async () => {
    await expect(
      registerFacility(prisma, facilityInput({ kephLevel: 1 })),
    ).rejects.toThrow(/not registrable/i);
    expect(KEPH_LEVELS[1]).toBeUndefined();
  });

  it('refuses coordinates outside Kenya', async () => {
    // Latitude and longitude transposed — a common data-entry error.
    await expect(
      registerFacility(prisma, facilityInput({ latitude: 34.768, longitude: -0.0917 })),
    ).rejects.toThrow(/outside Kenya|transposed/i);
  });

  it('refuses a duplicate MFL code', async () => {
    await registerFacility(prisma, facilityInput({ mflCode: 'MFL-1001' }));
    await expect(
      registerFacility(prisma, facilityInput({ mflCode: 'MFL-1001', name: 'Other' })),
    ).rejects.toThrow(/already registered/i);
  });

  it('refuses a subcounty that belongs to a different county', async () => {
    await expect(
      registerFacility(
        prisma,
        facilityInput({ countyId: ctx.kisumuId, subcountyId: ctx.siayaCentralId }),
      ),
    ).rejects.toThrow(/does not belong/i);
  });
});

describe('capability claims', () => {
  it('refuses free-text capabilities', async () => {
    const f = await registerFacility(prisma, facilityInput());
    await expect(
      claimCapability(prisma, { facilityId: f.id, capabilityCode: 'CT scanner' }),
    ).rejects.toThrow(/Unknown capability|controlled vocabulary/i);
  });

  it('refuses a capability above the facility level', async () => {
    // A dispensary claiming an ICU is a data-entry error that would send
    // critically ill patients to a building with no oxygen.
    const dispensary = await registerFacility(
      prisma,
      facilityInput({ name: 'Nyalenda Dispensary', kephLevel: 2 }),
    );
    await expect(
      claimCapability(prisma, { facilityId: dispensary.id, capabilityCode: 'ICU' }),
    ).rejects.toThrow(/requires at least level/i);
  });

  it('accepts a capability within the facility level', async () => {
    const f = await registerFacility(prisma, facilityInput());
    const claim = await claimCapability(prisma, {
      facilityId: f.id,
      capabilityCode: 'CT_SCAN',
    });
    expect(claim.status).toBe('CLAIMED');
    expect(claim.lastConfirmedAt).toBeInstanceOf(Date);
  });

  it('lifts a claim to VERIFIED on Ministry verification', async () => {
    const f = await registerFacility(prisma, facilityInput());
    await claimCapability(prisma, { facilityId: f.id, capabilityCode: 'CT_SCAN' });
    const verified = await verifyCapability(prisma, f.id, 'CT_SCAN', 'ministry-user-1');
    expect(verified.status).toBe('VERIFIED');
    expect(verified.verifiedBy).toBe('ministry-user-1');
  });
});

describe('capability freshness', () => {
  it('classifies claims by age', () => {
    const days = (n: number) => new Date(Date.now() - n * 86_400_000);
    expect(freshnessOf(days(10))).toBe('FRESH');
    expect(freshnessOf(days(120))).toBe('STALE');
    expect(freshnessOf(days(400))).toBe('EXPIRED');
  });

  it('THE STALE SCANNER — an expired claim stops matching', async () => {
    const f = await registerFacility(prisma, facilityInput());
    await approveFacility(prisma, f.id, 'ministry-user-1');
    await claimCapability(prisma, { facilityId: f.id, capabilityCode: 'CT_SCAN' });

    // Fresh: it matches.
    expect(
      await findFacilities(prisma, { requiredCapabilities: ['CT_SCAN'] }),
    ).toHaveLength(1);

    // Stale (120 days): still matches, but flagged and downranked.
    await ageClaim(f.id, 'CT_SCAN', 120);
    const stale = await findFacilities(prisma, { requiredCapabilities: ['CT_SCAN'] });
    expect(stale).toHaveLength(1);
    expect(stale[0].staleClaims).toContain('CT_SCAN');
    expect(stale[0].confidence).toBe('LOW');

    // Expired (400 days): the scanner has been broken for over a year and
    // nobody said so. It must stop matching entirely.
    await ageClaim(f.id, 'CT_SCAN', 400);
    expect(
      await findFacilities(prisma, { requiredCapabilities: ['CT_SCAN'] }),
    ).toHaveLength(0);
  });

  it('reconfirmation refreshes claims and suspends what was dropped', async () => {
    const f = await registerFacility(prisma, facilityInput());
    await approveFacility(prisma, f.id, 'ministry-user-1');
    await claimCapability(prisma, { facilityId: f.id, capabilityCode: 'CT_SCAN' });
    await claimCapability(prisma, { facilityId: f.id, capabilityCode: 'XRAY' });
    await ageClaim(f.id, 'CT_SCAN', 200);
    await ageClaim(f.id, 'XRAY', 200);

    // The quarterly return lists X-ray but not CT — the scanner is gone.
    const result = await reconfirmCapabilities(prisma, f.id, ['XRAY']);
    expect(result.confirmed).toBe(1);
    expect(result.suspended).toBe(1);

    expect(await findFacilities(prisma, { requiredCapabilities: ['XRAY'] })).toHaveLength(1);
    expect(await findFacilities(prisma, { requiredCapabilities: ['CT_SCAN'] })).toHaveLength(0);
  });
});

describe('facility search', () => {
  async function buildNetwork() {
    // A dispensary, a health centre and a referral hospital in Kisumu,
    // plus a referral hospital in neighbouring Siaya.
    const dispensary = await registerFacility(
      prisma,
      facilityInput({
        name: 'Nyalenda Dispensary',
        kephLevel: 2,
        latitude: -0.12,
        longitude: 34.76,
        is24Hour: false,
      }),
    );
    const centre = await registerFacility(
      prisma,
      facilityInput({
        name: 'Migosi Health Centre',
        kephLevel: 3,
        latitude: -0.1,
        longitude: 34.77,
        is24Hour: false,
      }),
    );
    const referral = await registerFacility(prisma, facilityInput({ kephLevel: 5 }));
    const siaya = await registerFacility(
      prisma,
      facilityInput({
        name: 'Siaya County Referral',
        kephLevel: 5,
        countyId: ctx.siayaId,
        subcountyId: ctx.siayaCentralId,
        latitude: 0.0607,
        longitude: 34.288,
      }),
    );

    for (const f of [dispensary, centre, referral, siaya]) {
      await approveFacility(prisma, f.id, 'ministry-user-1');
      await claimCapability(prisma, { facilityId: f.id, capabilityCode: 'OPD_GENERAL' });
    }
    for (const f of [centre, referral, siaya]) {
      await claimCapability(prisma, { facilityId: f.id, capabilityCode: 'XRAY' });
    }
    for (const f of [referral, siaya]) {
      await claimCapability(prisma, { facilityId: f.id, capabilityCode: 'CT_SCAN' });
      await claimCapability(prisma, { facilityId: f.id, capabilityCode: 'BLOOD_BANK' });
      await claimCapability(prisma, { facilityId: f.id, capabilityCode: 'THEATRE' });
    }

    return { dispensary, centre, referral, siaya };
  }

  it('requires ALL capabilities, not any', async () => {
    const { centre } = await buildNetwork();
    // The health centre has X-ray but no theatre, so it is not a match.
    const matches = await findFacilities(prisma, {
      requiredCapabilities: ['XRAY', 'THEATRE'],
    });
    expect(matches.map((m) => m.id)).not.toContain(centre.id);
    expect(matches).toHaveLength(2); // both referral hospitals
  });

  it('does NOT send simple cases to the biggest hospital', async () => {
    const { dispensary } = await buildNetwork();
    // Everything can do general outpatient care; the nearest lowest-level
    // facility should win, not the Level 5 referral.
    const matches = await findFacilities(prisma, {
      requiredCapabilities: ['OPD_GENERAL'],
      near: { latitude: -0.12, longitude: 34.76 },
    });
    expect(matches[0].id).toBe(dispensary.id);
    expect(matches[0].kephLevel).toBe(2);
  });

  it('ranks by distance among equally capable facilities', async () => {
    const { referral } = await buildNetwork();
    // From Kisumu, the Kisumu referral is far closer than Siaya's.
    const matches = await findFacilities(prisma, {
      requiredCapabilities: ['CT_SCAN', 'THEATRE'],
      near: { latitude: -0.0917, longitude: 34.768 },
    });
    expect(matches[0].id).toBe(referral.id);
    expect(matches[0].distanceKm).toBeLessThan(matches[1].distanceKm!);
  });

  it('prefers a fresh claim over a nearer stale one', async () => {
    const { referral, siaya } = await buildNetwork();
    // The near hospital's CT claim has gone stale; the far one is fresh.
    await ageClaim(referral.id, 'CT_SCAN', 150);

    const matches = await findFacilities(prisma, {
      requiredCapabilities: ['CT_SCAN'],
      near: { latitude: -0.0917, longitude: 34.768 },
    });
    expect(matches[0].id).toBe(siaya.id);
    expect(matches[0].confidence).toBe('MEDIUM');
    expect(matches[1].confidence).toBe('LOW');
  });

  it('excludes facilities that are not ACTIVE', async () => {
    const pending = await registerFacility(prisma, facilityInput({ name: 'Not Approved' }));
    await claimCapability(prisma, { facilityId: pending.id, capabilityCode: 'OPD_GENERAL' });

    const matches = await findFacilities(prisma, {
      requiredCapabilities: ['OPD_GENERAL'],
    });
    expect(matches.map((m) => m.id)).not.toContain(pending.id);
  });

  it('filters to facilities open now when asked', async () => {
    const { dispensary, referral } = await buildNetwork();
    const matches = await findFacilities(prisma, {
      requiredCapabilities: ['OPD_GENERAL'],
      openNow: true,
    });
    expect(matches.map((m) => m.id)).toContain(referral.id);
    expect(matches.map((m) => m.id)).not.toContain(dispensary.id);
  });
});

describe('cross-county widening', () => {
  it('widens from subcounty to county to national', async () => {
    // Only Siaya has a CT scanner.
    const siaya = await registerFacility(
      prisma,
      facilityInput({
        name: 'Siaya County Referral',
        kephLevel: 5,
        countyId: ctx.siayaId,
        subcountyId: ctx.siayaCentralId,
        latitude: 0.0607,
        longitude: 34.288,
      }),
    );
    await approveFacility(prisma, siaya.id, 'ministry-user-1');
    await claimCapability(prisma, { facilityId: siaya.id, capabilityCode: 'CT_SCAN' });

    const local = await registerFacility(
      prisma,
      facilityInput({ name: 'Migosi Health Centre', kephLevel: 3 }),
    );
    await approveFacility(prisma, local.id, 'ministry-user-1');
    await claimCapability(prisma, { facilityId: local.id, capabilityCode: 'OPD_GENERAL' });

    // A patient in Kisumu needing a CT: nothing local, nothing in county,
    // so the search reaches nationally and finds Siaya.
    const result = await findWithWidening(prisma, {
      countyId: ctx.kisumuId,
      subcountyId: ctx.kisumuCentralId,
      requiredCapabilities: ['CT_SCAN'],
    });

    expect(result.scope).toBe('NATIONAL');
    expect(result.matches[0].id).toBe(siaya.id);
  });

  it('stops at subcounty when something local qualifies', async () => {
    const local = await registerFacility(prisma, facilityInput({ kephLevel: 3 }));
    await approveFacility(prisma, local.id, 'ministry-user-1');
    await claimCapability(prisma, { facilityId: local.id, capabilityCode: 'OPD_GENERAL' });

    const result = await findWithWidening(prisma, {
      countyId: ctx.kisumuId,
      subcountyId: ctx.kisumuCentralId,
      requiredCapabilities: ['OPD_GENERAL'],
    });

    expect(result.scope).toBe('SUBCOUNTY');
  });
});

describe('distance', () => {
  it('computes a plausible Kisumu-to-Siaya distance', () => {
    const km = haversineKm(
      { latitude: -0.0917, longitude: 34.768 },
      { latitude: 0.0607, longitude: 34.288 },
    );
    // Roughly 56km by road; great-circle is a little under.
    expect(km).toBeGreaterThan(40);
    expect(km).toBeLessThan(70);
  });
});

/**
 * THE FACILITY'S OWN CONTACT DETAILS.
 *
 * Not the registrant's. A Ministry registrar has to be able to ask about
 * the ownership evidence before approving, and a referral has to reach the
 * place it names — neither is served by the personal number of whoever
 * filled in the form.
 *
 * The service accepted `phone` and the HTTP route dropped it, so the field
 * existed in the schema, was never collected, and nothing failed.
 */
describe('facility contact details', () => {
  it('records the phone and email the facility was registered with', async () => {
    const f = await registerFacility(prisma, {
      mflCode: `MFL-CONTACT-${Date.now()}`,
      name: 'Contactable Health Centre',
      kephLevel: 3,
      ownership: 'PRIVATE_FOR_PROFIT',
      countyId: ctx.kisumuId,
      subcountyId: ctx.kisumuCentralId,
      locality: 'Ngara',
      latitude: -1.2795,
      longitude: 36.8305,
      phone: '0733111222',
      email: 'admin@contactable.example',
    });

    const saved = await prisma.facility.findUniqueOrThrow({
      where: { id: f.id },
      select: { phone: true, email: true },
    });
    expect(saved.phone).toBe('0733111222');
    expect(saved.email).toBe('admin@contactable.example');
  });

  it('leaves them null rather than empty strings when not given', async () => {
    const f = await registerFacility(prisma, {
      mflCode: `MFL-NOCONTACT-${Date.now()}`,
      name: 'Quiet Dispensary',
      kephLevel: 2,
      ownership: 'PUBLIC_MOH',
      countyId: ctx.kisumuId,
      subcountyId: ctx.kisumuCentralId,
      locality: 'Ngara',
      latitude: -1.2795,
      longitude: 36.8305,
    });

    const saved = await prisma.facility.findUniqueOrThrow({
      where: { id: f.id },
      select: { phone: true, email: true },
    });
    expect(saved.phone).toBeNull();
    expect(saved.email).toBeNull();
  });
});

/**
 * DIRECTORS WHO ARE NOT CLINICIANS.
 *
 * A private hospital in Kenya is usually owned by a businessperson. The
 * system used to require a KMPDC licence to register a facility you own,
 * which excluded the people who actually own most private hospitals.
 *
 * A director is a Person — so they already have an account, a password they
 * chose and a second factor, and authentication needed no new owner kind.
 * What they must NOT have is any route to a clinical record.
 */
describe('a facility director who holds no licence', () => {
  async function makeDirector(nationalId: string) {
    const person = await registerAdult(prisma, {
      nationalId,
      phone: `07${nationalId.slice(0, 8)}`,
      givenName: 'Grace',
      familyName: 'Owner',
      sexAtBirth: 'FEMALE',
      dateOfBirth: new Date(Date.UTC(1975, 3, 2)),
      countyId: ctx.kisumuId,
      subcountyId: ctx.kisumuCentralId,
      passwordHash: 'argon2id$test',
    });
    return person;
  }

  it('becomes a real director only once the Ministry approves', async () => {
    const person = await makeDirector(`61${Date.now().toString().slice(-6)}`);
    const f = await registerFacility(prisma, {
      mflCode: `MFL-DIR-${Date.now()}`,
      name: 'Owner-run Nursing Home',
      kephLevel: 3,
      ownership: 'PRIVATE_FOR_PROFIT',
      countyId: ctx.kisumuId,
      subcountyId: ctx.kisumuCentralId,
      locality: 'Milimani',
      latitude: -0.0917,
      longitude: 34.768,
    });
    await prisma.facility.update({
      where: { id: f.id },
      data: { pendingDirectorPersonId: person.id },
    });

    // Nobody administers a facility the Ministry has not verified.
    expect(
      await prisma.facilityDirector.findFirst({ where: { facilityId: f.id } }),
    ).toBeNull();

    await approveFacility(prisma, f.id, 'ministry-test');

    const director = await prisma.facilityDirector.findFirstOrThrow({
      where: { facilityId: f.id },
    });
    expect(director.personId).toBe(person.id);
    expect(director.status).toBe('ACTIVE');
    // Attributed to the registrar, not the applicant: the applicant named
    // themselves, the Ministry is what made it true.
    expect(director.appointedBy).toBe('ministry-test');
    expect(director.appointedByKind).toBe('MINISTRY');
  });

  it('THE SAFETY PROPERTY — reaches the facility surface, never a clinical one', async () => {
    const person = await makeDirector(`62${Date.now().toString().slice(-6)}`);
    const f = await registerFacility(prisma, {
      mflCode: `MFL-SAFE-${Date.now()}`,
      name: 'Directed Clinic',
      kephLevel: 3,
      ownership: 'PRIVATE_FOR_PROFIT',
      countyId: ctx.kisumuId,
      subcountyId: ctx.kisumuCentralId,
      locality: 'Milimani',
      latitude: -0.0917,
      longitude: 34.768,
    });
    await prisma.facility.update({
      where: { id: f.id },
      data: { pendingDirectorPersonId: person.id },
    });
    await approveFacility(prisma, f.id, 'ministry-test');

    // The administrative surface opens.
    const scope = await requireFacilityDirector(prisma, person.id);
    expect(scope.facilityId).toBe(f.id);
    expect(scope.actorPersonId).toBe(person.id);

    // And there is no practitioner behind them at all, which is what every
    // clinical write demands. A director can run a roster and a reception
    // desk and still cannot record a single clinical row.
    const practitioner = await prisma.practitioner.findFirst({
      where: { personId: person.id },
    });
    expect(practitioner).toBeNull();
  });

  it('is refused while the facility is still PENDING', async () => {
    const person = await makeDirector(`63${Date.now().toString().slice(-6)}`);
    const f = await registerFacility(prisma, {
      mflCode: `MFL-PEND-${Date.now()}`,
      name: 'Unapproved Clinic',
      kephLevel: 3,
      ownership: 'PRIVATE_FOR_PROFIT',
      countyId: ctx.kisumuId,
      subcountyId: ctx.kisumuCentralId,
      locality: 'Milimani',
      latitude: -0.0917,
      longitude: 34.768,
    });
    await prisma.facilityDirector.create({
      data: {
        facilityId: f.id,
        personId: person.id,
        status: 'ACTIVE',
        appointedBy: 'test',
        appointedByKind: 'SELF',
      },
    });

    await expect(requireFacilityDirector(prisma, person.id)).rejects.toThrow(
      /cannot be administered until the Ministry approves/i,
    );
  });

  it('is refused once the directorship has ended', async () => {
    const person = await makeDirector(`64${Date.now().toString().slice(-6)}`);
    const f = await registerFacility(prisma, {
      mflCode: `MFL-END-${Date.now()}`,
      name: 'Former Clinic',
      kephLevel: 3,
      ownership: 'PRIVATE_FOR_PROFIT',
      countyId: ctx.kisumuId,
      subcountyId: ctx.kisumuCentralId,
      locality: 'Milimani',
      latitude: -0.0917,
      longitude: 34.768,
    });
    await approveFacility(prisma, f.id, 'ministry-test');
    await prisma.facilityDirector.create({
      data: {
        facilityId: f.id,
        personId: person.id,
        status: 'ENDED',
        endedAt: new Date(),
        appointedBy: 'test',
        appointedByKind: 'SELF',
      },
    });

    // A director who has left keeps their account and loses the facility —
    // which is the whole reason the facility has no password of its own.
    await expect(requireFacilityDirector(prisma, person.id)).rejects.toThrow(
      /does not direct a facility/i,
    );
  });
});

/**
 * A DIRECTOR IS PRIVILEGED.
 *
 * They hold no clinical licence, but they reach the reception queue — which
 * carries patient names, ages and photographs. Treating them as an ordinary
 * citizen left the facility surface reachable with a password alone.
 */
describe('a director must hold a second factor', () => {
  it('is required to enrol one, unlike a plain citizen', async () => {
    const nationalId = `65${Date.now().toString().slice(-6)}`;
    const person = await registerAdult(prisma, {
      nationalId,
      phone: `07${nationalId.slice(0, 8)}`,
      givenName: 'Mary',
      familyName: 'Director',
      sexAtBirth: 'FEMALE',
      dateOfBirth: new Date(Date.UTC(1972, 1, 9)),
      countyId: ctx.kisumuId,
      subcountyId: ctx.kisumuCentralId,
      passwordHash: await hashPassword('director-pass-123'),
    });

    const f = await registerFacility(prisma, {
      mflCode: `MFL-MFA-${Date.now()}`,
      name: 'Second Factor Clinic',
      kephLevel: 3,
      ownership: 'PRIVATE_FOR_PROFIT',
      countyId: ctx.kisumuId,
      subcountyId: ctx.kisumuCentralId,
      locality: 'Milimani',
      latitude: -0.0917,
      longitude: 34.768,
    });
    await approveFacility(prisma, f.id, 'ministry-test');

    // Before the directorship they are an ordinary citizen: no second
    // factor demanded, which is right — requiring one to read your own
    // record would exclude the people it is meant to serve.
    const asCitizen = await login(prisma, {
      phone: `07${nationalId.slice(0, 8)}`,
      password: 'director-pass-123',
    });
    expect(asCitizen.status).toBe('AUTHENTICATED');

    await prisma.facilityDirector.create({
      data: {
        facilityId: f.id,
        personId: person.id,
        status: 'ACTIVE',
        appointedBy: 'ministry-test',
        appointedByKind: 'MINISTRY',
      },
    });

    // The same account, now directing a facility, must enrol one.
    const asDirector = await login(prisma, {
      phone: `07${nationalId.slice(0, 8)}`,
      password: 'director-pass-123',
    });
    expect(asDirector.status).toBe('MFA_ENROLMENT_REQUIRED');
  });
});

/**
 * A CLINICIAN WHO OWNS A CLINIC KEEPS ONE LOGIN.
 *
 * A clinician holds two accounts: a citizen one keyed on their phone, and a
 * clinical one keyed on their licence. Only the first carries a personId.
 * A directorship hangs off the Person, so it was invisible to the clinical
 * session — the doctor could sign in with the account they actually use and
 * be refused their own facility.
 */
/** A registered practitioner with a verified licence, and the Person behind them. */
async function makeDoctor(licenceNumber: string) {
  const nationalId = `7${Date.now().toString().slice(-7)}`;
  const person = await registerAdult(prisma, {
    nationalId,
    phone: `07${nationalId.slice(0, 8)}`,
    givenName: 'Owner',
    familyName: 'Clinician',
    sexAtBirth: 'FEMALE',
    dateOfBirth: new Date(Date.UTC(1980, 0, 1)),
    countyId: ctx.kisumuId,
    subcountyId: ctx.kisumuCentralId,
    passwordHash: 'argon2id$test',
  });
  const { practitioner } = await registerPractitioner(prisma, {
    personId: person.id,
    cadre: 'DOCTOR',
    countyId: ctx.kisumuId,
    subcountyId: ctx.kisumuCentralId,
    licenceNumber,
    familyName: 'Clinician',
  });
  return { person, practitioner };
}

describe('a director who is also a clinician', () => {
  it('reaches the facility from the clinical session, which carries no personId', async () => {
    const { practitioner } = await makeDoctor(`KMPDC/LINK/${Date.now()}`);
    const f = await registerFacility(prisma, {
      mflCode: `MFL-BOTH-${Date.now()}`,
      name: 'Owner-Clinician Clinic',
      kephLevel: 3,
      ownership: 'PRIVATE_FOR_PROFIT',
      countyId: ctx.kisumuId,
      subcountyId: ctx.kisumuCentralId,
      locality: 'Milimani',
      latitude: -0.0917,
      longitude: 34.768,
    });
    // Linked through the Person behind the practitioner, which is what the
    // registration flow records when a licence is given.
    await prisma.facility.update({
      where: { id: f.id },
      data: { pendingDirectorPersonId: practitioner.personId },
    });
    await approveFacility(prisma, f.id, 'ministry-test');

    // The clinical token: a practitionerId and NO personId at all.
    const scope = await requireFacilityScope(prisma, {
      practitionerId: practitioner.id,
    });
    expect(scope.facilityId).toBe(f.id);
  });

  it('still refuses a clinician who directs nothing', async () => {
    const { practitioner } = await makeDoctor(`KMPDC/NONE/${Date.now()}`);
    // The refusal must survive the fall-through, or every practitioner who
    // administers nothing gets a confusing director-shaped error instead.
    await expect(
      requireFacilityScope(prisma, { practitionerId: practitioner.id }),
    ).rejects.toThrow(/does not administer a facility/i);
  });
});

/**
 * THE FACILITY'S PHONE IS NOT A LOGIN.
 *
 * The registration form asks for two numbers — the clinic's line and the
 * owner's own — and two phone fields on one page invites the reading that
 * one of them signs the facility in. Nothing does: the facility has no
 * credential at all, by design, because a shared one walks out with
 * whoever leaves and makes every action attributable to a building.
 */
describe('the facility contact number', () => {
  it('creates no account, so it can never be signed in with', async () => {
    const contactNumber = `0733${Date.now().toString().slice(-6)}`;
    const f = await registerFacility(prisma, {
      mflCode: `MFL-PHONE-${Date.now()}`,
      name: 'Contactable Clinic',
      kephLevel: 3,
      ownership: 'PRIVATE_FOR_PROFIT',
      countyId: ctx.kisumuId,
      subcountyId: ctx.kisumuCentralId,
      locality: 'Milimani',
      latitude: -0.0917,
      longitude: 34.768,
      phone: contactNumber,
    });

    // Stored, because a registrar has to ring it and a referral has to
    // reach the place.
    const saved = await prisma.facility.findUniqueOrThrow({
      where: { id: f.id },
      select: { phone: true },
    });
    expect(saved.phone).toBe(contactNumber);

    // And attached to nothing that could authenticate.
    const account = await prisma.account.findFirst({
      where: { phoneIndex: blindIndex(contactNumber, normalisePhone) },
    });
    expect(account).toBeNull();
  });
});

/**
 * MORE THAN ONE NAMED DIRECTOR.
 *
 * A facility with a single director stops working the day that person
 * leaves — which is the real problem a shared facility password appears to
 * solve, and solves badly: a shared credential cannot be revoked for one
 * person, and makes every action attributable to a building rather than a
 * human.
 *
 * A second named director solves it properly. The clinic keeps running,
 * and every action still has somebody's name on it.
 */
describe('appointing a second director', () => {
  async function facilityWithDirector() {
    const nationalId = `81${Date.now().toString().slice(-6)}`;
    const first = await registerAdult(prisma, {
      nationalId,
      phone: `07${nationalId.slice(0, 8)}`,
      givenName: 'First',
      familyName: 'Director',
      sexAtBirth: 'FEMALE',
      dateOfBirth: new Date(Date.UTC(1970, 0, 1)),
      countyId: ctx.kisumuId,
      subcountyId: ctx.kisumuCentralId,
      passwordHash: 'argon2id$test',
    });
    const f = await registerFacility(prisma, {
      mflCode: `MFL-TWO-${Date.now()}`,
      name: 'Two Director Clinic',
      kephLevel: 3,
      ownership: 'PRIVATE_FOR_PROFIT',
      countyId: ctx.kisumuId,
      subcountyId: ctx.kisumuCentralId,
      locality: 'Milimani',
      latitude: -0.0917,
      longitude: 34.768,
    });
    await prisma.facility.update({
      where: { id: f.id },
      data: { pendingDirectorPersonId: first.id },
    });
    await approveFacility(prisma, f.id, 'ministry-test');
    return { facility: f, first };
  }

  it('lets the facility keep running when a director is replaced', async () => {
    const { facility, first } = await facilityWithDirector();
    const secondId = `82${Date.now().toString().slice(-6)}`;
    const second = await registerAdult(prisma, {
      nationalId: secondId,
      phone: `07${secondId.slice(0, 8)}`,
      givenName: 'Second',
      familyName: 'Director',
      sexAtBirth: 'MALE',
      dateOfBirth: new Date(Date.UTC(1971, 0, 1)),
      countyId: ctx.kisumuId,
      subcountyId: ctx.kisumuCentralId,
      passwordHash: 'argon2id$test',
    });

    await prisma.facilityDirector.create({
      data: {
        facilityId: facility.id,
        personId: second.id,
        status: 'ACTIVE',
        appointedBy: first.id,
        appointedByKind: 'SELF',
      },
    });

    // The first leaves. The clinic still has somebody who can run it, and
    // no password changed hands to make that true.
    await prisma.facilityDirector.updateMany({
      where: { facilityId: facility.id, personId: first.id },
      data: { status: 'ENDED', endedAt: new Date() },
    });

    const scope = await requireFacilityDirector(prisma, second.id);
    expect(scope.facilityId).toBe(facility.id);
    await expect(requireFacilityDirector(prisma, first.id)).rejects.toThrow(
      /does not direct a facility/i,
    );
  });

  it('re-appointing someone who left reinstates them', async () => {
    const { facility, first } = await facilityWithDirector();
    await prisma.facilityDirector.updateMany({
      where: { facilityId: facility.id, personId: first.id },
      data: { status: 'ENDED', endedAt: new Date() },
    });

    // Upsert, not create: the unique (facility, person) pair would
    // otherwise make a returning director impossible to reinstate.
    await prisma.facilityDirector.upsert({
      where: { facilityId_personId: { facilityId: facility.id, personId: first.id } },
      create: {
        facilityId: facility.id,
        personId: first.id,
        status: 'ACTIVE',
        appointedBy: 'test',
        appointedByKind: 'SELF',
      },
      update: { status: 'ACTIVE', endedAt: null },
    });

    const scope = await requireFacilityDirector(prisma, first.id);
    expect(scope.facilityId).toBe(facility.id);
  });
});
