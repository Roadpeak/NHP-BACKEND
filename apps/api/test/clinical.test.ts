/**
 * PHASE 4 — the clinical core.
 *
 * The end-to-end loop from the blueprint: search a patient, open the file,
 * record a coded encounter, see it on the timeline. Plus the two safety
 * mechanisms that decide whether the record is trustworthy — the
 * contraindication interrupt, and corrections that never overwrite.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import 'dotenv/config';
import {
  searchDiagnoses,
  searchMedications,
  checkPrescribing,
  openEncounter,
  recordDiagnosis,
  recordAllergy,
  prescribe,
  amendDiagnosis,
  patientSummary,
  patientTimeline,
  recordObservation,
  recordProcedure,
  keyResults,
  procedureHistory,
  resolvePersonId,
  frequencyPerDay,
} from '../src/clinical.js';
import { registerAdult } from '../src/identity.js';
import { registerFacility, approveFacility } from '../src/facility.js';
import {
  registerPractitioner,
  grantAffiliation,
  checkIn,
} from '../src/practitioner.js';

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
    'check_in', 'affiliation', 'licence', 'practitioner',
    'facility_capability', 'facility', 'guardianship', 'identifier',
    'account', 'person',
  ]) {
    await owner.query(`DELETE FROM ${t}`);
  }
  await owner.query('SET session_replication_role = origin');
}

beforeAll(async () => {
  const vocab = await prisma.diagnosisTerm.count();
  if (vocab === 0) {
    throw new Error('Vocabularies not loaded. Run `pnpm seed` first.');
  }

  const county = await prisma.county.upsert({
    where: { code: '902' },
    create: { code: '902', name: 'Kisumu (clinical fixture)' },
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
    nationalId: `800000${String(seq).padStart(2, '0')}`,
    phone: `07130000${String(seq).padStart(2, '0')}`,
    givenName,
    familyName: 'Otieno',
    sexAtBirth: 'FEMALE',
    dateOfBirth: new Date(Date.UTC(1992, 4, 15)),
    countyId: ctx.countyId,
    subcountyId: ctx.subcountyId,
    passwordHash: 'argon2id$dummy',
  });
}

/** A checked-in doctor at an active facility, ready to write. */
async function makeClinician() {
  const person = await makePerson('Amina');
  seq++;
  const { practitioner } = await registerPractitioner(prisma, {
    personId: person.id,
    cadre: 'DOCTOR',
    countyId: ctx.countyId,
    subcountyId: ctx.subcountyId,
    licenceNumber: `KMPDC/2026/C${String(seq).padStart(3, '0')}`,
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

  return { practitioner, facility };
}

// =====================================================================

describe('diagnosis search', () => {
  it('returns falciparum malaria first for "mal"', async () => {
    const hits = await searchDiagnoses(prisma, 'mal');
    expect(hits[0].icd11Code).toBe('1F41.0');
    expect(hits[0].clinicalTitle).toMatch(/falciparum malaria/i);
  });

  it('resolves Kenyan colloquial terms', async () => {
    expect((await searchDiagnoses(prisma, 'pressure'))[0].icd11Code).toBe('BA00.Z');
    expect((await searchDiagnoses(prisma, 'sugar'))[0].icd11Code).toBe('5A11');
    expect((await searchDiagnoses(prisma, 'kisukari'))[0].icd11Code).toBe('5A11');
  });

  it('resolves clinical abbreviations', async () => {
    expect((await searchDiagnoses(prisma, 'URTI'))[0].icd11Code).toBe('CA07.Z');
    expect((await searchDiagnoses(prisma, 'TB'))[0].icd11Code).toBe('1B10.Z');
  });

  it('accepts a code typed directly', async () => {
    expect((await searchDiagnoses(prisma, '1F41.0'))[0].icd11Code).toBe('1F41.0');
  });

  it('returns nothing below two characters', async () => {
    expect(await searchDiagnoses(prisma, 'm')).toEqual([]);
  });

  it('carries the plain-language pair for the citizen view', async () => {
    const hit = (await searchDiagnoses(prisma, 'malaria'))[0];
    expect(hit.plainEn).toMatch(/you had malaria/i);
    expect(hit.plainSw).toMatch(/ulikuwa na malaria/i);
  });
});

describe('the clinical loop', () => {
  it('THE END-TO-END LOOP — open, diagnose, prescribe, appear on the timeline', async () => {
    const { practitioner, facility } = await makeClinician();
    const patient = await makePerson();

    const encounter = await openEncounter(prisma, {
      practitionerId: practitioner.id,
      personId: patient.id,
      kind: 'OUTPATIENT',
      chiefComplaint: 'fever and headache for three days',
    });
    expect(encounter.facilityId).toBe(facility.id);

    const condition = await recordDiagnosis(prisma, {
      practitionerId: practitioner.id,
      encounterId: encounter.id,
      icd11Code: '1F41.0',
    });
    // The title is frozen at write time — ICD-11 is revised, and the record
    // must show what the clinician actually selected.
    expect(condition.icd11Title).toBe('Plasmodium falciparum malaria');
    expect(condition.isFirstEver).toBe(true);
    expect(condition.kephLevel).toBe(5);

    const rx = await prescribe(prisma, {
      practitionerId: practitioner.id,
      encounterId: encounter.id,
      kemlCode: 'KEML-AM-001',
      doseAmount: 4,
      doseUnit: 'tablet',
      frequency: 'BD',
      durationDays: 3,
      indicationCode: '1F41.0',
    });
    expect(rx.genericName).toMatch(/artemether/i);

    const timeline = await patientTimeline(prisma, patient.id);
    expect(timeline).toHaveLength(1);
    expect(timeline[0].conditions[0].icd11Code).toBe('1F41.0');
    // Attribution is on the row, not inferred.
    expect(timeline[0].recordedBy).toBe(practitioner.id);
    expect(timeline[0].licenceNumber).toBeTruthy();
  });

  it('refuses free-text diagnoses', async () => {
    const { practitioner } = await makeClinician();
    const patient = await makePerson();
    const encounter = await openEncounter(prisma, {
      practitionerId: practitioner.id,
      personId: patient.id,
      kind: 'OUTPATIENT',
      chiefComplaint: 'cough',
    });

    await expect(
      recordDiagnosis(prisma, {
        practitionerId: practitioner.id,
        encounterId: encounter.id,
        icd11Code: 'malaria probably',
      }),
    ).rejects.toThrow(/not in the diagnosis vocabulary|must be coded/i);
  });

  it('refuses to write without an open session', async () => {
    const person = await makePerson('Unchecked');
    seq++;
    const { practitioner } = await registerPractitioner(prisma, {
      personId: person.id,
      cadre: 'DOCTOR',
      countyId: ctx.countyId,
      subcountyId: ctx.subcountyId,
      licenceNumber: `KMPDC/2026/N${seq}`,
    });
    const patient = await makePerson();

    await expect(
      openEncounter(prisma, {
        practitionerId: practitioner.id,
        personId: patient.id,
        kind: 'OUTPATIENT',
        chiefComplaint: 'fever',
      }),
    ).rejects.toThrow(/check in to a facility/i);
  });

  it('marks a repeat diagnosis as not first-ever', async () => {
    const { practitioner } = await makeClinician();
    const patient = await makePerson();

    for (const complaint of ['first bout', 'second bout']) {
      const e = await openEncounter(prisma, {
        practitionerId: practitioner.id,
        personId: patient.id,
        kind: 'OUTPATIENT',
        chiefComplaint: complaint,
      });
      await recordDiagnosis(prisma, {
        practitionerId: practitioner.id,
        encounterId: e.id,
        icd11Code: '1F41.0',
      });
    }

    const conditions = await prisma.condition.findMany({
      where: { personId: patient.id },
      orderBy: { recordedAt: 'asc' },
    });
    expect(conditions[0].isFirstEver).toBe(true);
    expect(conditions[1].isFirstEver).toBe(false);
  });

  it('inherits Tier 3 sensitivity from the vocabulary', async () => {
    const { practitioner } = await makeClinician();
    const patient = await makePerson();
    const e = await openEncounter(prisma, {
      practitionerId: practitioner.id,
      personId: patient.id,
      kind: 'OUTPATIENT',
      chiefComplaint: 'routine review',
    });

    const hiv = await recordDiagnosis(prisma, {
      practitionerId: practitioner.id,
      encounterId: e.id,
      icd11Code: '1C62.Z',
    });
    // The clinician does not classify sensitivity by hand — the vocabulary
    // does, so it cannot be forgotten.
    expect(hiv.sensitivity).toBe('TIER_3_RESTRICTED');
  });
});

describe('the contraindication interrupt', () => {
  it('THE PENICILLIN CASE — blocks amoxicillin and offers safe alternatives', async () => {
    const { practitioner } = await makeClinician();
    const patient = await makePerson();

    await recordAllergy(prisma, {
      practitionerId: practitioner.id,
      personId: patient.id,
      substanceKind: 'DRUG',
      substanceLabel: 'Penicillin',
      allergyClass: 'PENICILLIN',
      reaction: 'anaphylaxis',
      severity: 'ANAPHYLAXIS',
    });

    const check = await checkPrescribing(prisma, {
      personId: patient.id,
      kemlCode: 'KEML-AB-001', // amoxicillin
    });

    expect(check.verdict).toBe('BLOCK');
    expect(check.reasons[0]).toMatch(/Penicillin family/i);
    expect(check.alternatives.length).toBeGreaterThan(0);
    // Every alternative offered must itself be safe for this patient.
    for (const alt of check.alternatives) {
      const recheck = await checkPrescribing(prisma, {
        personId: patient.id,
        kemlCode: alt.kemlCode,
      });
      expect(recheck.verdict).toBe('ALLOW');
    }
  });

  it('catches a cross-reaction, not just the same class', async () => {
    const { practitioner } = await makeClinician();
    const patient = await makePerson();

    await recordAllergy(prisma, {
      practitionerId: practitioner.id,
      personId: patient.id,
      substanceKind: 'DRUG',
      substanceLabel: 'Penicillin',
      allergyClass: 'PENICILLIN',
      reaction: 'rash',
      severity: 'SEVERE',
    });

    // Ceftriaxone is a cephalosporin — a different class that cross-reacts.
    const check = await checkPrescribing(prisma, {
      personId: patient.id,
      kemlCode: 'KEML-AB-008',
    });
    expect(check.verdict).toBe('BLOCK');
    expect(check.reasons[0]).toMatch(/cross-react/i);
  });

  it('allows an unrelated antibiotic', async () => {
    const { practitioner } = await makeClinician();
    const patient = await makePerson();
    await recordAllergy(prisma, {
      practitionerId: practitioner.id,
      personId: patient.id,
      substanceKind: 'DRUG',
      substanceLabel: 'Penicillin',
      allergyClass: 'PENICILLIN',
      reaction: 'rash',
      severity: 'SEVERE',
    });

    const check = await checkPrescribing(prisma, {
      personId: patient.id,
      kemlCode: 'KEML-AB-004', // azithromycin
    });
    expect(check.verdict).toBe('ALLOW');
  });

  it('blocks a drug contraindicated in pregnancy', async () => {
    const patient = await makePerson();
    const check = await checkPrescribing(prisma, {
      personId: patient.id,
      kemlCode: 'KEML-AB-006', // doxycycline
      isPregnant: true,
    });
    expect(check.verdict).toBe('BLOCK');
    expect(check.reasons[0]).toMatch(/contraindicated in pregnancy/i);
  });

  it('refuses to prescribe a BLOCKed drug without an override reason', async () => {
    const { practitioner } = await makeClinician();
    const patient = await makePerson();
    await recordAllergy(prisma, {
      practitionerId: practitioner.id,
      personId: patient.id,
      substanceKind: 'DRUG',
      substanceLabel: 'Penicillin',
      allergyClass: 'PENICILLIN',
      reaction: 'anaphylaxis',
      severity: 'ANAPHYLAXIS',
    });
    const e = await openEncounter(prisma, {
      practitionerId: practitioner.id,
      personId: patient.id,
      kind: 'OUTPATIENT',
      chiefComplaint: 'chest infection',
    });

    await expect(
      prescribe(prisma, {
        practitionerId: practitioner.id,
        encounterId: e.id,
        kemlCode: 'KEML-AB-001',
        doseAmount: 500,
        doseUnit: 'mg',
        frequency: 'TDS',
      }),
    ).rejects.toThrow(/Contraindicated.*overrideReason/is);
  });

  it('allows an override, and records it against the prescriber', async () => {
    const { practitioner } = await makeClinician();
    const patient = await makePerson();
    await recordAllergy(prisma, {
      practitionerId: practitioner.id,
      personId: patient.id,
      substanceKind: 'DRUG',
      substanceLabel: 'Penicillin',
      allergyClass: 'PENICILLIN',
      reaction: 'mild rash only, tolerated since',
      severity: 'ANAPHYLAXIS',
    });
    const e = await openEncounter(prisma, {
      practitionerId: practitioner.id,
      personId: patient.id,
      kind: 'OUTPATIENT',
      chiefComplaint: 'severe infection, no alternative available',
    });

    // Blocking outright is how clinicians learn to route around a system.
    const rx = await prescribe(prisma, {
      practitionerId: practitioner.id,
      encounterId: e.id,
      kemlCode: 'KEML-AB-001',
      doseAmount: 500,
      doseUnit: 'mg',
      frequency: 'TDS',
      overrideReason: 'Desensitisation protocol in place; no alternative stocked',
    });
    expect(rx.stoppedReason).toMatch(/^OVERRIDE:/);
    expect(rx.stoppedReason).toMatch(/Desensitisation protocol/);
  });

  it('refuses a dose above the daily maximum', async () => {
    const { practitioner } = await makeClinician();
    const patient = await makePerson();
    const e = await openEncounter(prisma, {
      practitionerId: practitioner.id,
      personId: patient.id,
      kind: 'OUTPATIENT',
      chiefComplaint: 'pain',
    });

    // Paracetamol 2g QDS = 8g/day, double the 4g ceiling.
    await expect(
      prescribe(prisma, {
        practitionerId: practitioner.id,
        encounterId: e.id,
        kemlCode: 'KEML-AN-001',
        doseAmount: 2000,
        doseUnit: 'mg',
        frequency: 'QDS',
      }),
    ).rejects.toThrow(/above the .* maximum/i);
  });

  it('computes doses per day from Kenyan frequency codes', () => {
    expect(frequencyPerDay('OD')).toBe(1);
    expect(frequencyPerDay('BD')).toBe(2);
    expect(frequencyPerDay('TDS')).toBe(3);
    expect(frequencyPerDay('QDS')).toBe(4);
  });
});

describe('corrections', () => {
  it('supersedes without overwriting — both versions survive', async () => {
    const { practitioner } = await makeClinician();
    const patient = await makePerson();
    const e = await openEncounter(prisma, {
      practitionerId: practitioner.id,
      personId: patient.id,
      kind: 'OUTPATIENT',
      chiefComplaint: 'fever',
    });

    const original = await recordDiagnosis(prisma, {
      practitionerId: practitioner.id,
      encounterId: e.id,
      icd11Code: '1F40.Z', // malaria, unspecified
    });

    const corrected = await amendDiagnosis(prisma, {
      practitionerId: practitioner.id,
      conditionId: original.id,
      icd11Code: '1F41.0', // blood film came back: falciparum
      amendmentReason: 'Blood film result returned',
    });

    expect(corrected.supersedesId).toBe(original.id);
    expect(corrected.amendmentReason).toBe('Blood film result returned');

    // The original is marked superseded but its content is untouched.
    const after = await prisma.condition.findUnique({ where: { id: original.id } });
    expect(after?.supersededAt).not.toBeNull();
    expect(after?.icd11Title).toBe('Malaria, unspecified');

    // The timeline shows only the current version.
    const timeline = await patientTimeline(prisma, patient.id);
    const codes = timeline[0].conditions.map((c) => c.icd11Code);
    expect(codes).toEqual(['1F41.0']);
  });

  it('requires a reason for a correction', async () => {
    const { practitioner } = await makeClinician();
    const patient = await makePerson();
    const e = await openEncounter(prisma, {
      practitionerId: practitioner.id,
      personId: patient.id,
      kind: 'OUTPATIENT',
      chiefComplaint: 'fever',
    });
    const original = await recordDiagnosis(prisma, {
      practitionerId: practitioner.id,
      encounterId: e.id,
      icd11Code: '1F40.Z',
    });

    await expect(
      amendDiagnosis(prisma, {
        practitionerId: practitioner.id,
        conditionId: original.id,
        icd11Code: '1F41.0',
        amendmentReason: '   ',
      }),
    ).rejects.toThrow(/requires a reason/i);
  });

  it('refuses to amend an already-superseded row', async () => {
    const { practitioner } = await makeClinician();
    const patient = await makePerson();
    const e = await openEncounter(prisma, {
      practitionerId: practitioner.id,
      personId: patient.id,
      kind: 'OUTPATIENT',
      chiefComplaint: 'fever',
    });
    const original = await recordDiagnosis(prisma, {
      practitionerId: practitioner.id,
      encounterId: e.id,
      icd11Code: '1F40.Z',
    });
    await amendDiagnosis(prisma, {
      practitionerId: practitioner.id,
      conditionId: original.id,
      icd11Code: '1F41.0',
      amendmentReason: 'first correction',
    });

    await expect(
      amendDiagnosis(prisma, {
        practitionerId: practitioner.id,
        conditionId: original.id,
        icd11Code: '1F41.3',
        amendmentReason: 'second correction on a stale row',
      }),
    ).rejects.toThrow(/already been superseded/i);
  });
});

describe('the patient summary banner', () => {
  it('surfaces allergies, current medications and chronic conditions', async () => {
    const { practitioner } = await makeClinician();
    const patient = await makePerson();

    await recordAllergy(prisma, {
      practitionerId: practitioner.id,
      personId: patient.id,
      substanceKind: 'DRUG',
      substanceLabel: 'Penicillin',
      allergyClass: 'PENICILLIN',
      reaction: 'anaphylaxis',
      severity: 'ANAPHYLAXIS',
    });

    const e = await openEncounter(prisma, {
      practitionerId: practitioner.id,
      personId: patient.id,
      kind: 'OUTPATIENT',
      chiefComplaint: 'diabetes review',
    });
    await recordDiagnosis(prisma, {
      practitionerId: practitioner.id,
      encounterId: e.id,
      icd11Code: '5A11',
      isChronic: true,
    });
    await prescribe(prisma, {
      practitionerId: practitioner.id,
      encounterId: e.id,
      kemlCode: 'KEML-EN-001', // metformin
      doseAmount: 500,
      doseUnit: 'mg',
      frequency: 'BD',
    });

    const summary = await patientSummary(prisma, patient.id);
    expect(summary.allergies).toHaveLength(1);
    expect(summary.allergies[0].severity).toBe('ANAPHYLAXIS');
    expect(summary.medications).toHaveLength(1);
    expect(summary.medications[0].genericName).toBe('Metformin');
    expect(summary.chronicConditions).toHaveLength(1);
    expect(summary.chronicConditions[0].icd11Code).toBe('5A11');
  });

  it('records allergies as Tier 1 regardless of what is asked for', async () => {
    const { practitioner } = await makeClinician();
    const patient = await makePerson();
    const allergy = await recordAllergy(prisma, {
      practitionerId: practitioner.id,
      personId: patient.id,
      substanceKind: 'FOOD',
      substanceLabel: 'Peanuts',
      reaction: 'swelling',
      severity: 'SEVERE',
    });
    // An allergy consent rules could hide is an allergy that kills someone.
    expect(allergy.sensitivity).toBe('TIER_1_EMERGENCY');
  });
});

describe('medication search', () => {
  it('finds a drug by generic name or synonym', async () => {
    expect((await searchMedications(prisma, 'amox'))[0].kemlCode).toBe('KEML-AB-001');
    expect((await searchMedications(prisma, 'panadol'))[0].kemlCode).toBe('KEML-AN-001');
    expect((await searchMedications(prisma, 'AL'))[0].kemlCode).toBe('KEML-AM-001');
  });
});


describe('the summary screen payload', () => {
  it('names the author and facility on every encounter', async () => {
    const { practitioner, facility } = await makeClinician();
    const patient = await makePerson();

    const e = await openEncounter(prisma, {
      practitionerId: practitioner.id,
      personId: patient.id,
      kind: 'OUTPATIENT',
      chiefComplaint: 'fever',
    });
    await recordDiagnosis(prisma, {
      practitionerId: practitioner.id,
      encounterId: e.id,
      icd11Code: '1F41.0',
    });

    const timeline = await patientTimeline(prisma, patient.id);
    // Raw ids build no trust and let nobody call whoever saw the patient
    // last, which is half the point of showing attribution at all.
    expect(timeline[0].facilityName).toBe('Kisumu County Referral');
    expect(timeline[0].recordedByName).toMatch(/Amina/);
    expect(timeline[0].recordedByCadre).toBe('DOCTOR');
    expect(timeline[0].facilityId).toBe(facility.id);
  });

  it('THE TREND — returns a series, not just the latest value', async () => {
    const { practitioner } = await makeClinician();
    const patient = await makePerson();

    for (const [i, value] of [6.8, 7.4, 8.1, 8.4].entries()) {
      await recordObservation(prisma, {
        practitionerId: practitioner.id,
        personId: patient.id,
        code: '4548-4',
        label: 'HbA1c',
        category: 'LAB',
        valueNum: value,
        unit: '%',
        refLow: 4,
        refHigh: 7,
        observedAt: new Date(Date.now() - (3 - i) * 90 * 86_400_000),
      });
    }

    const results = await keyResults(prisma, patient.id);
    const hba1c = results.find((r) => r.code === '4548-4');

    // One reading is a number; four rising is a clinical finding.
    expect(hba1c?.series).toHaveLength(4);
    expect(hba1c?.series[0].value).toBe(6.8);
    expect(hba1c?.series.at(-1)?.value).toBe(8.4);
    expect(hba1c?.latest.value).toBe(8.4);
    // Flagged at write time, so a clinician does not recompute ranges by eye.
    expect(hba1c?.latest.abnormalFlag).toBe('HIGH');
  });

  it('flags a normal result as normal', async () => {
    const { practitioner } = await makeClinician();
    const patient = await makePerson();
    await recordObservation(prisma, {
      practitionerId: practitioner.id,
      personId: patient.id,
      code: '718-7',
      label: 'Haemoglobin',
      category: 'LAB',
      valueNum: 13.2,
      unit: 'g/dL',
      refLow: 11,
      refHigh: 15,
    });

    const results = await keyResults(prisma, patient.id);
    expect(results[0].latest.abnormalFlag).toBe('NORMAL');
  });

  it('THE PROVENANCE RULE — marks patient-recalled history as unverified', async () => {
    const { practitioner, facility } = await makeClinician();
    const patient = await makePerson();

    await recordProcedure(prisma, {
      practitionerId: practitioner.id,
      personId: patient.id,
      code: 'JB40.0',
      title: 'Caesarean section',
      performedOn: new Date(Date.UTC(2022, 10, 9)),
      performedAtFacilityId: facility.id,
      indication: 'Failure to progress',
    });

    await recordProcedure(prisma, {
      practitionerId: practitioner.id,
      personId: patient.id,
      code: 'JD10.0',
      title: 'Appendicectomy',
      performedOn: new Date(Date.UTC(2015, 0, 1)),
      datePrecision: 'YEAR',
      externalFacilityName: "St Mary's Mumias",
      indication: 'Acute appendicitis',
      isSelfReported: true,
    });

    const history = await procedureHistory(prisma, patient.id);
    const documented = history.find((p) => p.title === 'Caesarean section');
    const recalled = history.find((p) => p.title === 'Appendicectomy');

    // A clinician must tell documented history from remembered history at a
    // glance — and the registry cannot hold every facility a fifty-million
    // person population has ever used.
    expect(documented?.isSelfReported).toBe(false);
    expect(recalled?.isSelfReported).toBe(true);
    expect(recalled?.externalFacilityName).toBe("St Mary's Mumias");
    expect(recalled?.datePrecision).toBe('YEAR');
  });

  it('requires an indication on a procedure', async () => {
    const { practitioner } = await makeClinician();
    const patient = await makePerson();
    await expect(
      recordProcedure(prisma, {
        practitionerId: practitioner.id,
        personId: patient.id,
        code: 'JD10.0',
        title: 'Appendicectomy',
        performedOn: new Date(),
        indication: '   ',
      }),
    ).rejects.toThrow(/needs an indication/i);
  });

  it('refuses an observation without an open session', async () => {
    const person = await makePerson('Unchecked');
    seq++;
    const { practitioner } = await registerPractitioner(prisma, {
      personId: person.id,
      cadre: 'DOCTOR',
      countyId: ctx.countyId,
      subcountyId: ctx.subcountyId,
      licenceNumber: `KMPDC/2026/OB${seq}`,
    });
    const patient = await makePerson();

    await expect(
      recordObservation(prisma, {
        practitionerId: practitioner.id,
        personId: patient.id,
        code: '718-7',
        label: 'Haemoglobin',
        category: 'LAB',
        valueNum: 12,
      }),
    ).rejects.toThrow(/check in to a facility/i);
  });
});

describe('the NHP number a clinician actually types', () => {
  /**
   * The routes take `:nhpId` — the number printed on a patient's card,
   * `NHP-XXXX-XXXX` — while every clinical query filters on the internal
   * `person_id`. Handing the display number straight to those queries
   * matched nothing and returned an EMPTY timeline: a patient with a full
   * history rendered as a patient with none, with no error anywhere.
   *
   * These tests exist because every existing test called the services with
   * `patient.id` directly and so could never see the mismatch.
   */
  it('resolves the display number to the internal person id', async () => {
    const patient = await makePerson();
    expect(patient.displayNumber).toMatch(/^NHP-/);
    expect(await resolvePersonId(prisma, patient.displayNumber)).toBe(patient.id);
  });

  it('accepts an internal id unchanged', async () => {
    const patient = await makePerson();
    expect(await resolvePersonId(prisma, patient.id)).toBe(patient.id);
  });

  it('refuses an unknown number rather than returning nothing', async () => {
    // The dangerous failure is the quiet one — "no records" for a patient
    // who has them reads as a clean history at the point of treatment.
    await expect(resolvePersonId(prisma, 'NHP-0000-0000')).rejects.toThrow(
      /not found/i,
    );
  });

  it('THE REGRESSION — a timeline found by display number is not empty', async () => {
    const { practitioner } = await makeClinician();
    const patient = await makePerson();

    const e = await openEncounter(prisma, {
      practitionerId: practitioner.id,
      personId: patient.id,
      kind: 'OUTPATIENT',
      chiefComplaint: 'fever',
    });
    await recordDiagnosis(prisma, {
      practitionerId: practitioner.id,
      encounterId: e.id,
      icd11Code: '1F41.0',
    });

    // What the route does now.
    const viaDisplay = await patientTimeline(
      prisma,
      await resolvePersonId(prisma, patient.displayNumber),
    );
    // What it did before: the display number passed straight through.
    const viaRawDisplayNumber = await patientTimeline(prisma, patient.displayNumber);

    expect(viaDisplay).toHaveLength(1);
    expect(viaRawDisplayNumber).toHaveLength(0);
  });

  it('resolves for the summary banner too', async () => {
    const { practitioner } = await makeClinician();
    const patient = await makePerson();
    await recordAllergy(prisma, {
      practitionerId: practitioner.id,
      personId: patient.id,
      substanceKind: 'DRUG',
      substanceLabel: 'Penicillin',
      allergyClass: 'PENICILLIN',
      reaction: 'anaphylaxis',
      severity: 'ANAPHYLAXIS',
    });

    const summary = await patientSummary(
      prisma,
      await resolvePersonId(prisma, patient.displayNumber),
    );
    // An allergy banner that silently fails to load is the exact failure
    // this system exists to prevent.
    expect(summary.allergies).toHaveLength(1);
  });
});
