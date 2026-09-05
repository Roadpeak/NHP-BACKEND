/**
 * PHASE 5 — consent, tiered access and break-glass.
 *
 * The scenario from the blueprint: a restricted record correctly withheld,
 * then break-glass opened and the patient's phone buzzing. Plus the rule
 * that is easiest to get wrong — a clinician must be told restricted records
 * EXIST without being shown them, or they never know to ask the patient.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import 'dotenv/config';
import {
  grantConsent,
  revokeConsent,
  evaluateAccess,
  filteredRecord,
  breakGlass,
  markPatientNotified,
  unnotifiedBreakGlass,
  reviewBreakGlass,
  pendingBreakGlassReviews,
  breakGlassRateByFacility,
  accessHistory,
  logAccess,
  denialAnomalies,
  categoryForCode,
  generateConsentOtp,
  BREAK_GLASS_HOURS,
} from '../src/consent.js';
import { registerAdult } from '../src/identity.js';
import { registerFacility, approveFacility } from '../src/facility.js';
import { registerPractitioner, grantAffiliation, checkIn } from '../src/practitioner.js';
import { openEncounter, recordDiagnosis } from '../src/clinical.js';

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
});
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const ctx = { countyId: '', subcountyId: '' };
let seq = 0;

async function wipe() {
  await owner.query('SET session_replication_role = replica');
  for (const t of [
    'condition', 'medication', 'allergy', 'encounter', 'access_log',
    'break_glass', 'consent_grant', 'check_in', 'affiliation', 'facility_director', 'licence',
    'practitioner', 'facility_capability', 'facility', 'guardianship',
    'identifier', 'account', 'person',
  ]) {
    await owner.query(`DELETE FROM ${t}`);
  }
  await owner.query('SET session_replication_role = origin');
}

beforeAll(async () => {
  if ((await prisma.diagnosisTerm.count()) === 0) {
    throw new Error('Vocabularies not loaded. Run `pnpm seed` first.');
  }
  const county = await prisma.county.upsert({
    where: { code: '903' },
    create: { code: '903', name: 'Kisumu (consent fixture)' },
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

async function makePerson(givenName = 'Achieng') {
  seq++;
  return registerAdult(prisma, {
    nationalId: `700000${String(seq).padStart(2, '0')}`,
    phone: `07140000${String(seq).padStart(2, '0')}`,
    givenName,
    familyName: 'Otieno',
    sexAtBirth: 'FEMALE',
    dateOfBirth: new Date(Date.UTC(1992, 4, 15)),
    countyId: ctx.countyId,
    subcountyId: ctx.subcountyId,
    passwordHash: 'argon2id$dummy',
  });
}

async function makeClinician(facilityName = 'Kisumu County Referral') {
  const person = await makePerson('Amina');
  seq++;
  const { practitioner } = await registerPractitioner(prisma, {
    personId: person.id,
    cadre: 'DOCTOR',
    countyId: ctx.countyId,
    subcountyId: ctx.subcountyId,
    licenceNumber: `KMPDC/2026/S${String(seq).padStart(3, '0')}`,
  });

  const facility = await registerFacility(prisma, {
    name: facilityName,
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

  return { practitioner, facility, session, personId: person.id };
}

/** Gives a patient an HIV diagnosis — a Tier 3 record. */
async function giveRestrictedRecord(practitionerId: string, patientId: string) {
  const e = await openEncounter(prisma, {
    practitionerId,
    personId: patientId,
    kind: 'OUTPATIENT',
    chiefComplaint: 'routine review',
  });
  return recordDiagnosis(prisma, {
    practitionerId,
    encounterId: e.id,
    icd11Code: '1C62.Z',
  });
}

// =====================================================================

describe('category mapping', () => {
  it('maps restricted codes to their category', () => {
    expect(categoryForCode('1C62.Z')).toBe('HIV');
    expect(categoryForCode('6A70.Z')).toBe('MENTAL_HEALTH');
    expect(categoryForCode('6C40.Z')).toBe('SUBSTANCE_USE');
    // An ordinary diagnosis has no restricted category.
    expect(categoryForCode('1F41.0')).toBeNull();
  });

  it('generates a six-digit consent OTP', () => {
    expect(generateConsentOtp()).toMatch(/^\d{6}$/);
  });
});

describe('tiered access', () => {
  it('THE WITHHOLDING RULE — hides content but reveals that it exists', async () => {
    const clinician = await makeClinician();
    const patient = await makePerson('Patient');
    await giveRestrictedRecord(clinician.practitioner.id, patient.id);

    // Give them an ordinary diagnosis too, so we can prove Tier 2 is fine.
    const e = await openEncounter(prisma, {
      practitionerId: clinician.practitioner.id,
      personId: patient.id,
      kind: 'OUTPATIENT',
      chiefComplaint: 'fever',
    });
    await recordDiagnosis(prisma, {
      practitionerId: clinician.practitioner.id,
      encounterId: e.id,
      icd11Code: '1F41.0',
    });

    const view = await filteredRecord(prisma, {
      personId: patient.id,
      practitionerId: clinician.practitioner.id,
      facilityId: clinician.facility.id,
      checkInId: clinician.session.id,
    });

    // Tier 2 is visible.
    expect(view.conditions.map((c) => c.icd11Code)).toContain('1F41.0');
    // Tier 3 content is NOT.
    expect(view.conditions.map((c) => c.icd11Code)).not.toContain('1C62.Z');
    // But the clinician knows to ask — this is the whole clinical purpose.
    expect(view.restrictedRecordsExist).toBe(true);
    expect(view.withheldCategories).toContain('HIV');
  });

  it('never gates Tier 1 — allergies are always visible', async () => {
    const clinician = await makeClinician();
    const patient = await makePerson('Patient');

    await prisma.allergy.create({
      data: {
        personId: patient.id,
        checkInId: clinician.session.id,
        recordedBy: clinician.practitioner.id,
        facilityId: clinician.facility.id,
        licenceNumber: (await prisma.licence.findFirstOrThrow({
          where: { practitionerId: clinician.practitioner.id },
        })).licenceNumber,
        sensitivity: 'TIER_1_EMERGENCY',
        substanceKind: 'DRUG',
        substanceLabel: 'Penicillin',
        reaction: 'anaphylaxis',
        severity: 'ANAPHYLAXIS',
        certainty: 'CONFIRMED',
      },
    });

    const view = await filteredRecord(prisma, {
      personId: patient.id,
      practitionerId: clinician.practitioner.id,
      facilityId: clinician.facility.id,
      checkInId: clinician.session.id,
    });
    expect(view.allergies).toHaveLength(1);
    expect(view.access.tier1).toBe(true);
  });

  it('reports no restricted records when the patient has none', async () => {
    const clinician = await makeClinician();
    const patient = await makePerson('Patient');

    const view = await filteredRecord(prisma, {
      personId: patient.id,
      practitionerId: clinician.practitioner.id,
      facilityId: clinician.facility.id,
      checkInId: clinician.session.id,
    });
    expect(view.restrictedRecordsExist).toBe(false);
    expect(view.withheldCategories).toEqual([]);
  });
});

describe('consent', () => {
  it('unlocks Tier 3 when the patient consents', async () => {
    const clinician = await makeClinician();
    const patient = await makePerson('Patient');
    await giveRestrictedRecord(clinician.practitioner.id, patient.id);

    const before = await filteredRecord(prisma, {
      personId: patient.id,
      practitionerId: clinician.practitioner.id,
      facilityId: clinician.facility.id,
      checkInId: clinician.session.id,
    });
    expect(before.conditions.map((c) => c.icd11Code)).not.toContain('1C62.Z');

    await grantConsent(prisma, {
      personId: patient.id,
      facilityId: clinician.facility.id,
      scope: 'ALL_TIER_3',
      grantedBy: 'PATIENT',
      method: 'IN_PERSON_OTP',
    });

    const after = await filteredRecord(prisma, {
      personId: patient.id,
      practitionerId: clinician.practitioner.id,
      facilityId: clinician.facility.id,
      checkInId: clinician.session.id,
    });
    expect(after.conditions.map((c) => c.icd11Code)).toContain('1C62.Z');
    expect(after.access.basis).toBe('CONSENT');
    expect(after.restrictedRecordsExist).toBe(false);
  });

  it('scopes a CATEGORY grant to that category alone', async () => {
    const clinician = await makeClinician();
    const patient = await makePerson('Patient');
    await giveRestrictedRecord(clinician.practitioner.id, patient.id); // HIV

    const e = await openEncounter(prisma, {
      practitionerId: clinician.practitioner.id,
      personId: patient.id,
      kind: 'OUTPATIENT',
      chiefComplaint: 'low mood',
    });
    await recordDiagnosis(prisma, {
      practitionerId: clinician.practitioner.id,
      encounterId: e.id,
      icd11Code: '6A70.Z', // depression
    });

    // Someone may disclose mental health to a clinician and not HIV.
    await grantConsent(prisma, {
      personId: patient.id,
      facilityId: clinician.facility.id,
      scope: 'CATEGORY',
      category: 'MENTAL_HEALTH',
      grantedBy: 'PATIENT',
      method: 'IN_PERSON_OTP',
    });

    const view = await filteredRecord(prisma, {
      personId: patient.id,
      practitionerId: clinician.practitioner.id,
      facilityId: clinician.facility.id,
      checkInId: clinician.session.id,
    });
    const codes = view.conditions.map((c) => c.icd11Code);
    expect(codes).toContain('6A70.Z');
    expect(codes).not.toContain('1C62.Z');
    expect(view.withheldCategories).toEqual(['HIV']);
  });

  it('stops granting access once revoked', async () => {
    const clinician = await makeClinician();
    const patient = await makePerson('Patient');
    await giveRestrictedRecord(clinician.practitioner.id, patient.id);

    const grant = await grantConsent(prisma, {
      personId: patient.id,
      facilityId: clinician.facility.id,
      scope: 'ALL_TIER_3',
      grantedBy: 'PATIENT',
      method: 'PORTAL',
    });
    await revokeConsent(prisma, grant.id, patient.id);

    const view = await filteredRecord(prisma, {
      personId: patient.id,
      practitionerId: clinician.practitioner.id,
      facilityId: clinician.facility.id,
      checkInId: clinician.session.id,
    });
    expect(view.conditions.map((c) => c.icd11Code)).not.toContain('1C62.Z');
  });

  it('expires on its own', async () => {
    const clinician = await makeClinician();
    const patient = await makePerson('Patient');
    await giveRestrictedRecord(clinician.practitioner.id, patient.id);

    await grantConsent(prisma, {
      personId: patient.id,
      facilityId: clinician.facility.id,
      scope: 'ALL_TIER_3',
      grantedBy: 'PATIENT',
      method: 'IN_PERSON_OTP',
      hours: 1,
    });

    const later = new Date(Date.now() + 2 * 3_600_000);
    const decision = await evaluateAccess(
      prisma,
      {
        personId: patient.id,
        practitionerId: clinician.practitioner.id,
        facilityId: clinician.facility.id,
        checkInId: clinician.session.id,
      },
      later,
    );
    expect(decision.tier3).toBe(false);
  });

  it('refuses a grant with no target', async () => {
    const patient = await makePerson('Patient');
    await expect(
      grantConsent(prisma, {
        personId: patient.id,
        scope: 'ALL_TIER_3',
        grantedBy: 'PATIENT',
        method: 'PORTAL',
      }),
    ).rejects.toThrow(/must name a facility or a practitioner/i);
  });

  it('refuses a perpetual grant', async () => {
    const clinician = await makeClinician();
    const patient = await makePerson('Patient');
    await expect(
      grantConsent(prisma, {
        personId: patient.id,
        facilityId: clinician.facility.id,
        scope: 'ALL_TIER_3',
        grantedBy: 'PATIENT',
        method: 'PORTAL',
        hours: 24 * 400,
      }),
    ).rejects.toThrow(/must expire within/i);
  });

  it('refuses revocation by someone other than the patient', async () => {
    const clinician = await makeClinician();
    const patient = await makePerson('Patient');
    const other = await makePerson('Someone Else');

    const grant = await grantConsent(prisma, {
      personId: patient.id,
      facilityId: clinician.facility.id,
      scope: 'ALL_TIER_3',
      grantedBy: 'PATIENT',
      method: 'PORTAL',
    });

    await expect(revokeConsent(prisma, grant.id, other.id)).rejects.toThrow(
      /belongs to someone else/i,
    );
  });
});

describe('break-glass', () => {
  it('THE EMERGENCY PATH — grants immediately and queues for review', async () => {
    const clinician = await makeClinician();
    const patient = await makePerson('Unconscious Patient');
    await giveRestrictedRecord(clinician.practitioner.id, patient.id);

    const event = await breakGlass(prisma, {
      personId: patient.id,
      practitionerId: clinician.practitioner.id,
      checkInId: clinician.session.id,
      facilityId: clinician.facility.id,
      reasonCode: 'UNCONSCIOUS',
      justification: 'Patient brought in unconscious after RTA, no next of kin present',
      categories: ['HIV'],
    });

    // Access is immediate — waiting for approval in an emergency kills people.
    expect(event.reviewStatus).toBe('PENDING');
    const view = await filteredRecord(prisma, {
      personId: patient.id,
      practitionerId: clinician.practitioner.id,
      facilityId: clinician.facility.id,
      checkInId: clinician.session.id,
    });
    expect(view.conditions.map((c) => c.icd11Code)).toContain('1C62.Z');
    expect(view.access.basis).toBe('BREAK_GLASS');

    // It reaches the auditor's queue automatically.
    const queue = await pendingBreakGlassReviews(prisma);
    expect(queue.map((q) => q.id)).toContain(event.id);

    // And the patient can see it happened.
    const history = await accessHistory(prisma, patient.id);
    const emergency = history.find((h) => h.isEmergencyAccess);
    expect(emergency).toBeDefined();
    expect(emergency?.reasonPlain).toBe('in an emergency');
  });

  it('expires after four hours, unlike a shift', async () => {
    const clinician = await makeClinician();
    const patient = await makePerson('Patient');
    await giveRestrictedRecord(clinician.practitioner.id, patient.id);

    const now = new Date();
    await breakGlass(
      prisma,
      {
        personId: patient.id,
        practitionerId: clinician.practitioner.id,
        checkInId: clinician.session.id,
        facilityId: clinician.facility.id,
        reasonCode: 'LIFE_THREATENING',
        justification: 'Severe bleeding, needs transfusion history immediately',
        categories: ['HIV'],
      },
      now,
    );

    const afterExpiry = new Date(now.getTime() + (BREAK_GLASS_HOURS + 1) * 3_600_000);
    const decision = await evaluateAccess(
      prisma,
      {
        personId: patient.id,
        practitionerId: clinician.practitioner.id,
        facilityId: clinician.facility.id,
        checkInId: clinician.session.id,
      },
      afterExpiry,
    );
    expect(decision.tier3).toBe(false);
  });

  it('requires a real justification, not a keystroke', async () => {
    const clinician = await makeClinician();
    const patient = await makePerson('Patient');

    await expect(
      breakGlass(prisma, {
        personId: patient.id,
        practitionerId: clinician.practitioner.id,
        checkInId: clinician.session.id,
        facilityId: clinician.facility.id,
        reasonCode: 'UNCONSCIOUS',
        justification: 'emergency',
        categories: ['HIV'],
      }),
    ).rejects.toThrow(/at least 20 characters/i);
  });

  it('requires named categories rather than opening everything', async () => {
    const clinician = await makeClinician();
    const patient = await makePerson('Patient');

    await expect(
      breakGlass(prisma, {
        personId: patient.id,
        practitionerId: clinician.practitioner.id,
        checkInId: clinician.session.id,
        facilityId: clinician.facility.id,
        reasonCode: 'UNCONSCIOUS',
        justification: 'Patient unconscious, needs full history urgently please',
        categories: [],
      }),
    ).rejects.toThrow(/which restricted categories/i);
  });

  it('refuses break-glass on the clinician’s own record', async () => {
    const clinician = await makeClinician();

    // The doctor's own person record — the insider-abuse pattern break-glass
    // would otherwise make trivial.
    await expect(
      breakGlass(prisma, {
        personId: clinician.personId,
        practitionerId: clinician.practitioner.id,
        checkInId: clinician.session.id,
        facilityId: clinician.facility.id,
        reasonCode: 'UNCONSCIOUS',
        justification: 'Checking my own restricted records for no good reason',
        categories: ['HIV'],
      }),
    ).rejects.toThrow(/your own record/i);
  });

  it('flags events where the patient was never told', async () => {
    const clinician = await makeClinician();
    const patient = await makePerson('Patient');

    const event = await breakGlass(
      prisma,
      {
        personId: patient.id,
        practitionerId: clinician.practitioner.id,
        checkInId: clinician.session.id,
        facilityId: clinician.facility.id,
        reasonCode: 'MASS_CASUALTY',
        justification: 'Bus crash, multiple casualties, identifying patients rapidly',
        categories: ['HIV'],
      },
      new Date(Date.now() - 60 * 60_000),
    );

    // Someone got emergency access and the patient does not know.
    const unnotified = await unnotifiedBreakGlass(prisma, 30);
    expect(unnotified.map((u) => u.id)).toContain(event.id);

    await markPatientNotified(prisma, event.id, 'SMS');
    expect((await unnotifiedBreakGlass(prisma, 30)).map((u) => u.id)).not.toContain(event.id);
  });

  it('records an auditor review through the permitted function', async () => {
    const clinician = await makeClinician();
    const patient = await makePerson('Patient');
    const event = await breakGlass(prisma, {
      personId: patient.id,
      practitionerId: clinician.practitioner.id,
      checkInId: clinician.session.id,
      facilityId: clinician.facility.id,
      reasonCode: 'UNCONSCIOUS',
      justification: 'Patient unresponsive on arrival, no accompanying relative',
      categories: ['HIV'],
    });

    const reviewed = await reviewBreakGlass(prisma, {
      breakGlassId: event.id,
      ministryUserId: 'auditor-1',
      outcome: 'REVIEWED_OK',
      note: 'Justification consistent with the ED record',
    });
    expect(reviewed?.reviewStatus).toBe('REVIEWED_OK');
    expect(reviewed?.reviewedBy).toBe('auditor-1');
    // The justification is untouched by review.
    expect(reviewed?.justification).toMatch(/unresponsive on arrival/);
  });

  it('surfaces break-glass rate per facility', async () => {
    const clinician = await makeClinician('Outlier Hospital');
    const patient = await makePerson('Patient');

    const e = await openEncounter(prisma, {
      practitionerId: clinician.practitioner.id,
      personId: patient.id,
      kind: 'EMERGENCY',
      chiefComplaint: 'collapse',
    });
    expect(e.id).toBeTruthy();

    await breakGlass(prisma, {
      personId: patient.id,
      practitionerId: clinician.practitioner.id,
      checkInId: clinician.session.id,
      facilityId: clinician.facility.id,
      reasonCode: 'UNCONSCIOUS',
      justification: 'Collapsed in the waiting area, unresponsive, acting immediately',
      categories: ['HIV'],
    });

    const rates = await breakGlassRateByFacility(prisma, new Date(Date.now() - 86_400_000));
    const row = rates.find((r) => r.facilityId === clinician.facility.id);
    expect(row?.breakGlassCount).toBe(1);
    expect(row?.encounterCount).toBe(1);
    expect(row?.ratePercent).toBe(100);
  });
});

describe('the access log', () => {
  it('renders reasons in plain language for the citizen', async () => {
    const clinician = await makeClinician();
    const patient = await makePerson('Patient');

    await logAccess(prisma, {
      personId: patient.id,
      practitionerId: clinician.practitioner.id,
      checkInId: clinician.session.id,
      facilityId: clinician.facility.id,
      action: 'VIEW_RECORD',
      tierReached: 'TIER_2_GENERAL',
      reason: 'ACTIVE_CONSULTATION',
      outcome: 'GRANTED',
      requestId: 'req-plain-1',
    });

    const history = await accessHistory(prisma, patient.id);
    // The enum is for the auditor; the citizen gets a sentence.
    expect(history[0].reasonPlain).toBe('while treating you');
  });

  it('THE FRAUD SIGNAL — surfaces a high denial rate', async () => {
    const clinician = await makeClinician();
    const patients = await Promise.all(
      Array.from({ length: 12 }, (_, i) => makePerson(`P${i}`)),
    );

    // Ten searches denied, two granted — the pattern of someone fishing.
    for (const [i, p] of patients.entries()) {
      await logAccess(prisma, {
        personId: p.id,
        practitionerId: clinician.practitioner.id,
        checkInId: clinician.session.id,
        facilityId: clinician.facility.id,
        action: 'SEARCH',
        tierReached: 'TIER_2_GENERAL',
        reason: 'ACTIVE_CONSULTATION',
        outcome: i < 10 ? 'DENIED_NO_CONSENT' : 'GRANTED',
        requestId: `req-fraud-${i}`,
      });
    }

    const anomalies = await denialAnomalies(prisma, new Date(Date.now() - 3_600_000));
    const flagged = anomalies.find((a) => a.actorId === clinician.practitioner.id);
    expect(flagged).toBeDefined();
    expect(flagged?.denied).toBe(10);
    expect(flagged?.denialRate).toBeGreaterThan(80);
  });

  it('does not flag a clinician with normal access patterns', async () => {
    const clinician = await makeClinician();
    const patients = await Promise.all(
      Array.from({ length: 12 }, (_, i) => makePerson(`Q${i}`)),
    );

    for (const [i, p] of patients.entries()) {
      await logAccess(prisma, {
        personId: p.id,
        practitionerId: clinician.practitioner.id,
        checkInId: clinician.session.id,
        facilityId: clinician.facility.id,
        action: 'VIEW_RECORD',
        tierReached: 'TIER_2_GENERAL',
        reason: 'ACTIVE_CONSULTATION',
        outcome: 'GRANTED',
        requestId: `req-normal-${i}`,
      });
    }

    const anomalies = await denialAnomalies(prisma, new Date(Date.now() - 3_600_000));
    expect(anomalies.map((a) => a.actorId)).not.toContain(clinician.practitioner.id);
  });
});
