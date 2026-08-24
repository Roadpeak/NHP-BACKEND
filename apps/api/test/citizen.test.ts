/**
 * The citizen's view of their own record.
 *
 * Mirror of the clinician summary: same rows, opposite reader. The tests
 * that matter are the ones about language and sequencing — showing someone
 * a bare abnormal result, or letting a cancer diagnosis arrive on a phone
 * before a clinician has spoken to them, are real harms.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import 'dotenv/config';
import {
  citizenSummary,
  citizenTimeline,
  raiseDispute,
  uiStrings,
  SERIOUS_DIAGNOSIS_DELAY_HOURS,
} from '../src/citizen.js';
import { registerAdult } from '../src/identity.js';
import { registerFacility, approveFacility } from '../src/facility.js';
import { registerPractitioner, grantAffiliation, checkIn } from '../src/practitioner.js';
import {
  openEncounter,
  recordDiagnosis,
  recordAllergy,
  prescribe,
} from '../src/clinical.js';

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
});
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const ctx = { countyId: '', subcountyId: '' };
let seq = 0;

async function wipe() {
  await owner.query('SET session_replication_role = replica');
  for (const t of [
    'observation', 'procedure', 'condition', 'medication', 'allergy',
    'encounter', 'access_log', 'check_in', 'affiliation', 'licence',
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
    where: { code: '909' },
    create: { code: '909', name: 'Kisumu (citizen fixture)' },
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
    nationalId: `100000${String(seq).padStart(3, '0')}`,
    phone: `07260000${String(seq).padStart(3, '0')}`,
    givenName,
    familyName: 'Otieno',
    sexAtBirth: 'FEMALE',
    dateOfBirth: new Date(Date.UTC(1992, 4, 15)),
    countyId: ctx.countyId,
    subcountyId: ctx.subcountyId,
    passwordHash: 'argon2id$dummy',
  });
}

async function makeClinician() {
  const person = await makePerson('Amina');
  seq++;
  const { practitioner } = await registerPractitioner(prisma, {
    personId: person.id,
    cadre: 'NURSE',
    countyId: ctx.countyId,
    subcountyId: ctx.subcountyId,
    licenceNumber: `NCK/2026/${String(seq).padStart(4, '0')}`,
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
  await checkIn(prisma, { practitionerId: practitioner.id, facilityId: facility.id });
  return { practitioner, facility };
}

// =====================================================================

describe('plain language', () => {
  it('THE LANGUAGE RULE — plain first, clinical term below', async () => {
    const { practitioner } = await makeClinician();
    const patient = await makePerson('Patient');

    const e = await openEncounter(prisma, {
      practitionerId: practitioner.id,
      personId: patient.id,
      kind: 'OUTPATIENT',
      chiefComplaint: 'fever for three days',
    });
    await recordDiagnosis(prisma, {
      practitionerId: practitioner.id,
      encounterId: e.id,
      icd11Code: '1F41.0',
    });

    const visits = await citizenTimeline(prisma, patient.id, { lang: 'en' });

    // "You had malaria", not "Plasmodium falciparum malaria".
    expect(visits[0].whatHappened).toMatch(/you had malaria/i);
    // The clinical term is still there — a patient carrying their record to
    // a private specialist needs the real one. Simplify the presentation,
    // never the record.
    expect(visits[0].clinicalTitle).toBe('Plasmodium falciparum malaria');
    expect(visits[0].icd11Code).toBe('1F41.0');
  });

  it('answers in Swahili when asked', async () => {
    const { practitioner } = await makeClinician();
    const patient = await makePerson('Patient');

    const e = await openEncounter(prisma, {
      practitionerId: practitioner.id,
      personId: patient.id,
      kind: 'OUTPATIENT',
      chiefComplaint: 'homa',
    });
    await recordDiagnosis(prisma, {
      practitionerId: practitioner.id,
      encounterId: e.id,
      icd11Code: '1F41.0',
    });

    const visits = await citizenTimeline(prisma, patient.id, { lang: 'sw' });
    expect(visits[0].whatHappened).toMatch(/ulikuwa na malaria/i);
    // Swahili is the language of everyday life in Kenya; the clinical term
    // is unchanged in either language.
    expect(visits[0].clinicalTitle).toBe('Plasmodium falciparum malaria');
  });

  it('names the clinician in a form a citizen recognises', async () => {
    const { practitioner } = await makeClinician();
    const patient = await makePerson('Patient');
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

    const en = await citizenTimeline(prisma, patient.id, { lang: 'en' });
    const sw = await citizenTimeline(prisma, patient.id, { lang: 'sw' });
    expect(en[0].treatedBy).toMatch(/^Nurse Amina/);
    expect(sw[0].treatedBy).toMatch(/^Muuguzi Amina/);
  });

  it('translates the interface, not just the content', () => {
    expect(uiStrings('en').yourVisits).toBe('Your visits');
    expect(uiStrings('sw').yourVisits).toBe('Ziara zako');
    // A national system that only speaks English is not national.
    expect(uiStrings('sw').cannotChange).toMatch(/haiwezi kufutwa/i);
  });

  it('falls back to the clinical term rather than showing nothing', async () => {
    const { practitioner } = await makeClinician();
    const patient = await makePerson('Patient');
    const e = await openEncounter(prisma, {
      practitionerId: practitioner.id,
      personId: patient.id,
      kind: 'OUTPATIENT',
      chiefComplaint: 'review',
    });
    await recordDiagnosis(prisma, {
      practitionerId: practitioner.id,
      encounterId: e.id,
      icd11Code: '5A11',
      isChronic: true,
    });

    const summary = await citizenSummary(prisma, patient.id, 'en');
    const chronic = summary.rightNow.find((r) => r.kind === 'CHRONIC');
    // An untranslated term sends someone to ask a nurse, which is safe. A
    // wrong one sends them home confident and mistaken.
    expect(chronic?.title).toBeTruthy();
  });
});

describe('what is true right now', () => {
  it('leads with allergies, chronic conditions and daily medicines', async () => {
    const { practitioner } = await makeClinician();
    const patient = await makePerson('Patient');

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
      kemlCode: 'KEML-EN-001',
      doseAmount: 500,
      doseUnit: 'mg',
      frequency: 'BD',
    });

    const summary = await citizenSummary(prisma, patient.id, 'en');

    // Someone opening this at 9pm wants to know whether to act.
    expect(summary.rightNow.some((r) => r.kind === 'ALLERGY')).toBe(true);
    expect(summary.rightNow.find((r) => r.kind === 'ALLERGY')?.tone).toBe('critical');
    expect(summary.rightNow.some((r) => r.kind === 'CHRONIC')).toBe(true);
    expect(summary.dailyMedicines[0].name).toBe('Metformin');
    expect(summary.dailyMedicines[0].regimen).toBe('500mg BD');
  });

  it('tells an allergic patient what to do about it', async () => {
    const { practitioner } = await makeClinician();
    const patient = await makePerson('Patient');
    await recordAllergy(prisma, {
      practitionerId: practitioner.id,
      personId: patient.id,
      substanceKind: 'FOOD',
      substanceLabel: 'Peanuts',
      reaction: 'swelling',
      severity: 'SEVERE',
    });

    const en = await citizenSummary(prisma, patient.id, 'en');
    const sw = await citizenSummary(prisma, patient.id, 'sw');
    expect(en.rightNow[0].title).toMatch(/allergic to Peanuts/i);
    expect(en.rightNow[0].detail).toMatch(/tell any clinician/i);
    expect(sw.rightNow[0].title).toMatch(/mzio wa Peanuts/i);
  });
});

describe('serious-diagnosis sequencing', () => {
  it('THE DISCLOSURE RULE — a cancer diagnosis does not arrive cold on a phone', async () => {
    const { practitioner } = await makeClinician();
    const patient = await makePerson('Patient');

    const e = await openEncounter(prisma, {
      practitionerId: practitioner.id,
      personId: patient.id,
      kind: 'OUTPATIENT',
      chiefComplaint: 'routine review',
    });
    // HIV is in the withheld set alongside neoplasms.
    await recordDiagnosis(prisma, {
      practitionerId: practitioner.id,
      encounterId: e.id,
      icd11Code: '1C62.Z',
    });

    const visits = await citizenTimeline(prisma, patient.id, { lang: 'en' });

    // Sequencing, not secrecy: the clinician gets a chance to have the
    // conversation first.
    expect(visits[0].withheld).toBe(true);
    expect(visits[0].whatHappened).toMatch(/clinician will contact you/i);
    expect(visits[0].clinicalTitle).toBeNull();
    expect(visits[0].icd11Code).toBeNull();
    expect(visits[0].medicines).toEqual([]);
  });

  it('releases it once the window passes', async () => {
    const { practitioner } = await makeClinician();
    const patient = await makePerson('Patient');
    const e = await openEncounter(prisma, {
      practitionerId: practitioner.id,
      personId: patient.id,
      kind: 'OUTPATIENT',
      chiefComplaint: 'routine review',
    });
    await recordDiagnosis(prisma, {
      practitionerId: practitioner.id,
      encounterId: e.id,
      icd11Code: '1C62.Z',
    });

    // Indefinite withholding would be worse than the harm it prevents.
    const later = new Date(Date.now() + (SERIOUS_DIAGNOSIS_DELAY_HOURS + 1) * 3_600_000);
    const visits = await citizenTimeline(prisma, patient.id, { lang: 'en', now: later });

    expect(visits[0].withheld).toBe(false);
    expect(visits[0].icd11Code).toBe('1C62.Z');
  });

  it('does not withhold an ordinary diagnosis', async () => {
    const { practitioner } = await makeClinician();
    const patient = await makePerson('Patient');
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

    const visits = await citizenTimeline(prisma, patient.id, { lang: 'en' });
    expect(visits[0].withheld).toBe(false);
    expect(visits[0].whatHappened).toMatch(/you had malaria/i);
  });

  it('flags on the summary that a clinician will make contact', async () => {
    const { practitioner } = await makeClinician();
    const patient = await makePerson('Patient');
    const e = await openEncounter(prisma, {
      practitionerId: practitioner.id,
      personId: patient.id,
      kind: 'OUTPATIENT',
      chiefComplaint: 'review',
    });
    await recordDiagnosis(prisma, {
      practitionerId: practitioner.id,
      encounterId: e.id,
      icd11Code: '1C62.Z',
    });

    const summary = await citizenSummary(prisma, patient.id, 'en');
    expect(summary.pendingClinicianContact).toBe(true);
  });
});

describe('disputes', () => {
  it('THE DISPUTE RULE — raises a review, never edits the record', async () => {
    const { practitioner } = await makeClinician();
    const patient = await makePerson('Patient');
    const e = await openEncounter(prisma, {
      practitionerId: practitioner.id,
      personId: patient.id,
      kind: 'OUTPATIENT',
      chiefComplaint: 'fever',
    });
    const condition = await recordDiagnosis(prisma, {
      practitionerId: practitioner.id,
      encounterId: e.id,
      icd11Code: '1F41.0',
    });

    await raiseDispute(prisma, {
      personId: patient.id,
      encounterId: e.id,
      note: 'I was never treated for malaria at this facility',
    });

    // The record's evidential value depends on the patient never writing to
    // it. The dispute is logged; the diagnosis is untouched.
    const after = await prisma.condition.findUniqueOrThrow({ where: { id: condition.id } });
    expect(after.icd11Code).toBe('1F41.0');
    expect(after.supersededAt).toBeNull();

    const log = await prisma.accessLog.findFirst({
      where: { actorKind: 'PATIENT', targetId: e.id },
    });
    expect(log).not.toBeNull();
    expect(log?.reason).toBe('PATIENT_REQUEST');
  });

  it('requires the patient to say what looks wrong', async () => {
    const { practitioner } = await makeClinician();
    const patient = await makePerson('Patient');
    const e = await openEncounter(prisma, {
      practitionerId: practitioner.id,
      personId: patient.id,
      kind: 'OUTPATIENT',
      chiefComplaint: 'fever',
    });

    await expect(
      raiseDispute(prisma, { personId: patient.id, encounterId: e.id, note: '  ' }),
    ).rejects.toThrow(/what looks wrong/i);
  });

  it('refuses a dispute on someone else’s visit', async () => {
    const { practitioner } = await makeClinician();
    const patient = await makePerson('Patient');
    const other = await makePerson('Someone Else');
    const e = await openEncounter(prisma, {
      practitionerId: practitioner.id,
      personId: patient.id,
      kind: 'OUTPATIENT',
      chiefComplaint: 'fever',
    });

    await expect(
      raiseDispute(prisma, {
        personId: other.id,
        encounterId: e.id,
        note: 'not mine',
      }),
    ).rejects.toThrow(/not on your record/i);
  });
});

describe('the identity strip labels', () => {
  /**
   * The strip mirrors the clinician's patient header, but the words must
   * not. "Allergies · Active issues · Medications" is the vocabulary of
   * someone with a medical degree; this screen is read by someone who may
   * be worried, on a shared handset, in Swahili.
   */
  it('avoids clinical vocabulary in English', () => {
    const en = uiStrings('en');
    expect(en.harmful).toBe('Things that could harm you');
    // "Allergy" is a word a lot of people will not connect to the rash they
    // once had after an injection.
    expect(en.harmful.toLowerCase()).not.toContain('allerg');
    expect(en.longTerm.toLowerCase()).not.toContain('chronic');
  });

  it('translates every label, so no column renders in English inside Swahili', () => {
    const en = uiStrings('en');
    const sw = uiStrings('sw');
    for (const key of ['harmful', 'longTerm', 'medicines', 'none', 'yourNumber'] as const) {
      expect(sw[key], key).toBeTruthy();
      // An untranslated key silently falls back to the English string and
      // reads as a half-finished product.
      expect(sw[key], key).not.toBe(en[key]);
    }
  });

  it('has no missing key in either language', () => {
    // A key present in one language and absent in the other renders as
    // `undefined` on screen.
    expect(Object.keys(uiStrings('sw')).sort()).toEqual(Object.keys(uiStrings('en')).sort());
  });
});
