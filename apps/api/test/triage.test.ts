/**
 * PHASE 6 — triage and facility recommendation.
 *
 * Two properties matter more than the ranking: a red flag must bypass
 * ranking entirely, and an unreviewed red-flag rule must not fire at all.
 * Both are safety controls, not features.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import 'dotenv/config';
import {
  recommend,
  evaluateRules,
  symptomPicker,
  saveRecommendation,
  markRecommendationActedOn,
  followThroughRate,
  ruleCoverageGaps,
  orphanedRedFlags,
  unknownSymptoms,
  DISCLAIMER_EN,
  DISCLAIMER_SW,
  historyFactors,
  HISTORY_CAPABILITIES,
} from '../src/triage.js';
import { registerFacility, approveFacility, claimCapability } from '../src/facility.js';
import { registerAdult } from '../src/identity.js';
import { openEncounter, recordDiagnosis } from '../src/clinical.js';
import {
  registerPractitioner,
  grantAffiliation,
  checkIn as checkInPractitioner,
} from '../src/practitioner.js';

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
});
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const ctx = { kisumuId: '', kisumuCentralId: '', siayaId: '', siayaCentralId: '' };

async function wipeFacilities() {
  await owner.query('SET session_replication_role = replica');
  for (const t of [
    'recommendation', 'condition', 'medication', 'allergy', 'encounter',
    'check_in', 'affiliation', 'facility_director', 'licence', 'practitioner',
    'facility_capability', 'facility',
  ]) {
    await owner.query(`DELETE FROM ${t}`);
  }
  await owner.query('SET session_replication_role = origin');
}

/** Activates a rule as a named clinician would, for tests that need it live. */
async function activateRule(ruleId: string, reviewer = 'Dr J. Ochieng, KMPDC/12345') {
  await prisma.triageRule.update({
    where: { ruleId },
    data: { reviewedBy: reviewer, active: true },
  });
}

beforeAll(async () => {
  if ((await prisma.triageRule.count()) === 0) {
    throw new Error('Triage rules not loaded. Run `pnpm seed` first.');
  }

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
});

beforeEach(async () => {
  await wipeFacilities();
  // Restore the seeded review state so one test cannot leak into another.
  await prisma.triageRule.updateMany({
    where: { redFlag: true },
    data: { reviewedBy: 'UNASSIGNED', active: false },
  });
});

afterAll(async () => {
  await prisma.triageRule.updateMany({
    where: { redFlag: true },
    data: { reviewedBy: 'UNASSIGNED', active: false },
  });
  await prisma.$disconnect();
  await owner.end();
});

/** A facility with the given capabilities, active and open. */
async function makeFacility(
  name: string,
  kephLevel: number,
  capabilities: string[],
  opts: { countyId?: string; subcountyId?: string; lat?: number; lng?: number } = {},
) {
  const f = await registerFacility(prisma, {
    name,
    kephLevel,
    ownership: 'PUBLIC_MOH',
    countyId: opts.countyId ?? ctx.kisumuId,
    subcountyId: opts.subcountyId ?? ctx.kisumuCentralId,
    locality: 'Milimani',
    latitude: opts.lat ?? -0.0917,
    longitude: opts.lng ?? 34.768,
    is24Hour: true,
  });
  await approveFacility(prisma, f.id, 'ministry-1');
  for (const c of capabilities) {
    await claimCapability(prisma, { facilityId: f.id, capabilityCode: c });
  }
  return f;
}

// =====================================================================

describe('the review gate', () => {
  it('THE SAFETY GATE — an unreviewed red-flag rule does not fire', async () => {
    await makeFacility('Kisumu County Referral', 5, ['EMERGENCY_24H', 'ECG', 'OXYGEN']);

    // RF001 (chest pain + breathlessness) ships with reviewed_by=UNASSIGNED.
    const result = await recommend(prisma, {
      symptoms: ['chest_pain', 'breathlessness'],
      ageYears: 55,
    });

    expect(result.redFlag).toBe(false);
    expect(result.rulesFired).not.toContain('RF001');
    // But an operator is told the rule set is incomplete, rather than the
    // gap being swallowed silently.
    expect(result.inactiveRulesMatched).toContain('RF001');
  });

  it('fires once a named clinician signs it off', async () => {
    await makeFacility('Kisumu County Referral', 5, ['EMERGENCY_24H', 'ECG', 'OXYGEN']);
    await activateRule('RF001');

    const result = await recommend(prisma, {
      symptoms: ['chest_pain', 'breathlessness'],
      ageYears: 55,
    });

    expect(result.redFlag).toBe(true);
    expect(result.rulesFired).toContain('RF001');
    expect(result.urgency).toBe('EMERGENCY');
    expect(result.adviceEn).toMatch(/emergency department now|ambulance/i);
  });
});

describe('red flags', () => {
  beforeEach(async () => {
    for (const r of ['RF001', 'RF004', 'RF005', 'RF018']) await activateRule(r);
  });

  it('THE BYPASS — a red flag beats a routine symptom reported alongside it', async () => {
    await makeFacility('Kisumu County Referral', 5, ['EMERGENCY_24H']);
    // Physiotherapy needs KEPH 3, so a dispensary cannot claim it — the
    // Phase 2 guard enforces that.
    await makeFacility('Migosi Health Centre', 3, ['OPD_GENERAL', 'PHYSIOTHERAPY']);

    // Back pain would normally route to a dispensary. Convulsions must not
    // be averaged in with it.
    const result = await recommend(prisma, {
      symptoms: ['back_pain', 'convulsions'],
      ageYears: 45,
    });

    expect(result.redFlag).toBe(true);
    expect(result.urgency).toBe('EMERGENCY');
    expect(result.rulesFired).toEqual(['RF004']);
    expect(result.facilities[0].kephLevel).toBe(5);
  });

  it('applies the newborn fever red flag by age', async () => {
    await makeFacility('Kisumu County Referral', 5, [
      'EMERGENCY_24H',
      'PAEDIATRIC',
      'NEWBORN_UNIT',
    ]);

    // A fever in a baby under two months is an emergency.
    const newborn = await recommend(prisma, { symptoms: ['fever'], ageYears: 0.08 });
    expect(newborn.redFlag).toBe(true);
    expect(newborn.rulesFired).toContain('RF005');

    // The same symptom in an adult is not.
    const adult = await recommend(prisma, { symptoms: ['fever'], ageYears: 30 });
    expect(adult.redFlag).toBe(false);
  });

  it('routes self-harm disclosure as an emergency, not routine', async () => {
    await makeFacility('Kisumu County Referral', 5, ['MENTAL_HEALTH', 'EMERGENCY_24H']);

    const result = await recommend(prisma, {
      symptoms: ['self_harm_thoughts'],
      ageYears: 19,
    });
    expect(result.redFlag).toBe(true);
    expect(result.adviceEn).toMatch(/support is available/i);
  });

  it('requires ALL symptoms a rule names', async () => {
    await makeFacility('Kisumu County Referral', 5, ['EMERGENCY_24H', 'ECG', 'OXYGEN']);

    // RF001 needs chest pain AND breathlessness. Chest pain alone must not
    // escalate, or half the country ends up in emergency departments.
    const result = await recommend(prisma, { symptoms: ['chest_pain'], ageYears: 55 });
    expect(result.rulesFired).not.toContain('RF001');
  });
});

describe('routine routing', () => {
  it('sends a simple case to the nearest lowest-level facility', async () => {
    const dispensary = await makeFacility('Nyalenda Dispensary', 2, [
      'OPD_GENERAL',
      'PHARMACY',
      'MALARIA_RDT',
      'LAB_BASIC',
    ]);
    await makeFacility('Kisumu County Referral', 5, [
      'OPD_GENERAL',
      'PHARMACY',
      'MALARIA_RDT',
      'LAB_BASIC',
    ]);

    const result = await recommend(prisma, {
      symptoms: ['fever', 'headache', 'joint_pain'],
      ageYears: 30,
      location: { latitude: -0.0917, longitude: 34.768 },
    });

    expect(result.urgency).toBe('URGENT_24H');
    expect(result.rulesFired).toContain('R101');
    // Not the biggest hospital — that is what clogs Kenyan referrals.
    expect(result.facilities[0].id).toBe(dispensary.id);
    expect(result.adviceEn).toMatch(/malaria test/i);
  });

  it('takes the most urgent rule when several fire', async () => {
    await makeFacility('Migosi Health Centre', 3, [
      'OPD_GENERAL',
      'LAB_BASIC',
      'TB_DIAGNOSIS',
      'MALARIA_RDT',
      'PHARMACY',
    ]);

    // Cough+fever is SOON_7D; a cough over two weeks is URGENT_24H.
    const result = await recommend(prisma, {
      symptoms: ['cough', 'fever', 'cough_over_2_weeks'],
      ageYears: 34,
    });
    expect(result.urgency).toBe('URGENT_24H');
    expect(result.adviceEn).toMatch(/tuberculosis/i);
  });

  it('returns plain advice when nothing matches', async () => {
    const result = await recommend(prisma, { symptoms: ['hearing_loss'], ageYears: 40 });
    expect(result.urgency).toBeNull();
    expect(result.rulesFired).toEqual([]);
    expect(result.adviceEn).toMatch(/could not match/i);
    expect(result.adviceSw).toMatch(/hatukuweza/i);
  });

  it('refuses free-text symptoms', async () => {
    await expect(
      recommend(prisma, { symptoms: ['my chest hurts a lot'], ageYears: 40 }),
    ).rejects.toThrow(/Unknown symptom|controlled vocabulary/i);
  });
});

describe('cross-county widening', () => {
  it('reaches another county when nothing local qualifies', async () => {
    // Only Siaya has a CT scanner.
    await makeFacility('Migosi Health Centre', 3, ['OPD_GENERAL'], {
      countyId: ctx.kisumuId,
      subcountyId: ctx.kisumuCentralId,
    });
    const siaya = await makeFacility(
      'Siaya County Referral',
      5,
      ['EYE_CARE', 'EMERGENCY_24H'],
      {
        countyId: ctx.siayaId,
        subcountyId: ctx.siayaCentralId,
        lat: 0.0607,
        lng: 34.288,
      },
    );
    await activateRule('RF013'); // sudden vision loss

    const result = await recommend(prisma, {
      symptoms: ['vision_loss'],
      ageYears: 58,
      countyId: ctx.kisumuId,
      subcountyId: ctx.kisumuCentralId,
    });

    expect(result.redFlag).toBe(true);
    expect(result.scope).toBe('NATIONAL');
    expect(result.facilities[0].id).toBe(siaya.id);
  });

  it('stays local when something nearby qualifies', async () => {
    await makeFacility('Migosi Health Centre', 3, [
      'OPD_GENERAL',
      'LAB_BASIC',
      'MALARIA_RDT',
      'PHARMACY',
    ]);

    const result = await recommend(prisma, {
      symptoms: ['fever', 'headache', 'joint_pain'],
      ageYears: 30,
      countyId: ctx.kisumuId,
      subcountyId: ctx.kisumuCentralId,
    });
    expect(result.scope).toBe('SUBCOUNTY');
  });

  it('reports NONE rather than inventing a facility', async () => {
    // No facility has dialysis.
    await makeFacility('Migosi Health Centre', 3, ['OPD_GENERAL']);
    await activateRule('RF012');

    const result = await recommend(prisma, {
      symptoms: ['unable_to_urinate'],
      ageYears: 60,
      countyId: ctx.kisumuId,
      subcountyId: ctx.kisumuCentralId,
    });
    expect(result.facilities).toEqual([]);
    expect(result.scope).toBe('NONE');
    // The advice still stands even with nowhere to send them.
    expect(result.adviceEn).toMatch(/urgent attention|go to a facility/i);
  });
});

describe('the symptom picker', () => {
  it('groups by body system in the requested language', async () => {
    const en = await symptomPicker(prisma, { ageYears: 30, lang: 'en' });
    const respiratory = en.find((g) => g.bodySystem === 'respiratory');
    expect(respiratory?.items.some((i) => i.label === 'Cough')).toBe(true);

    const sw = await symptomPicker(prisma, { ageYears: 30, lang: 'sw' });
    const respSw = sw.find((g) => g.bodySystem === 'respiratory');
    expect(respSw?.items.some((i) => i.label === 'Kikohozi')).toBe(true);
  });

  it('hides symptoms that cannot apply at this age', async () => {
    const adult = await symptomPicker(prisma, { ageYears: 30 });
    const codes = adult.flatMap((g) => g.items.map((i) => i.code));
    // A paediatric red flag has no business on an adult's picker.
    expect(codes).not.toContain('child_not_feeding');

    const infant = await symptomPicker(prisma, { ageYears: 1 });
    const infantCodes = infant.flatMap((g) => g.items.map((i) => i.code));
    expect(infantCodes).toContain('child_not_feeding');
  });

  it('hides sex-specific symptoms that cannot apply', async () => {
    const male = await symptomPicker(prisma, { ageYears: 30, sex: 'MALE' });
    const codes = male.flatMap((g) => g.items.map((i) => i.code));
    expect(codes).not.toContain('pregnancy_bleeding');

    const female = await symptomPicker(prisma, { ageYears: 30, sex: 'FEMALE' });
    const femaleCodes = female.flatMap((g) => g.items.map((i) => i.code));
    expect(femaleCodes).toContain('pregnancy_bleeding');
  });

  it('carries the question text, not just a bare noun', async () => {
    const picker = await symptomPicker(prisma, { ageYears: 30 });
    const fever = picker.flatMap((g) => g.items).find((i) => i.code === 'fever');
    expect(fever?.question).toMatch(/do you have a fever/i);
  });
});

describe('the disclaimer', () => {
  it('is on every recommendation', async () => {
    await makeFacility('Migosi Health Centre', 3, [
      'OPD_GENERAL',
      'LAB_BASIC',
      'MALARIA_RDT',
      'PHARMACY',
    ]);
    const result = await recommend(prisma, {
      symptoms: ['fever', 'headache', 'joint_pain'],
      ageYears: 30,
    });
    expect(result.disclaimer).toBe(DISCLAIMER_EN);
    expect(result.disclaimer).toMatch(/not a diagnosis/i);
    expect(DISCLAIMER_SW).toMatch(/si utambuzi/i);
  });
});

describe('the feedback loop', () => {
  it('records what we told someone, and whether they went', async () => {
    const facility = await makeFacility('Migosi Health Centre', 3, [
      'OPD_GENERAL',
      'LAB_BASIC',
      'MALARIA_RDT',
      'PHARMACY',
    ]);
    expect(facility.id).toBeTruthy();

    const input = { symptoms: ['fever', 'headache', 'joint_pain'], ageYears: 30 };
    const result = await recommend(prisma, input);
    const saved = await saveRecommendation(prisma, input, result);

    expect(saved.rulesFired).toContain('R101');
    expect(saved.redFlagShown).toBe(false);
    expect(saved.actedOnEncounterId).toBeNull();

    const rates = await followThroughRate(prisma, new Date(Date.now() - 3_600_000));
    const urgent = rates.find((r) => r.urgency === 'URGENT_24H');
    expect(urgent?.issued).toBe(1);
    expect(urgent?.ratePercent).toBe(0);
  });

  it('computes follow-through once an encounter is linked', async () => {
    await makeFacility('Migosi Health Centre', 3, [
      'OPD_GENERAL',
      'LAB_BASIC',
      'MALARIA_RDT',
      'PHARMACY',
    ]);
    const input = { symptoms: ['fever', 'headache', 'joint_pain'], ageYears: 30 };
    const result = await recommend(prisma, input);
    const saved = await saveRecommendation(prisma, input, result);

    await markRecommendationActedOn(prisma, saved.id, 'encounter-placeholder');

    const rates = await followThroughRate(prisma, new Date(Date.now() - 3_600_000));
    expect(rates.find((r) => r.urgency === 'URGENT_24H')?.ratePercent).toBe(100);
  });
});

describe('rule-set integrity', () => {
  it('has no rule referencing an unknown symptom or capability', async () => {
    const gaps = await ruleCoverageGaps(prisma);
    expect(gaps).toEqual([]);
  });

  it('reports red-flag symptoms with no active rule behind them', async () => {
    // With the seeded review state, every red-flag rule is gated — so every
    // red-flag symptom is currently orphaned. That is the honest state, and
    // the system reports it rather than pretending coverage exists.
    const orphaned = await orphanedRedFlags(prisma);
    expect(orphaned).toContain('self_harm_thoughts');
    expect(orphaned).toContain('convulsions');

    await activateRule('RF004'); // convulsions
    const after = await orphanedRedFlags(prisma);
    expect(after).not.toContain('convulsions');
    expect(after).toContain('self_harm_thoughts');
  });

  it('validates symptom codes against the vocabulary', async () => {
    expect(await unknownSymptoms(prisma, ['fever', 'cough'])).toEqual([]);
    expect(await unknownSymptoms(prisma, ['fever', 'made_up'])).toEqual(['made_up']);
  });
});

describe('rule evaluation', () => {
  it('separates fired from gated rules', async () => {
    await activateRule('RF004');
    const { fired, inactiveMatched } = await evaluateRules(prisma, {
      symptoms: ['convulsions', 'chest_pain', 'breathlessness'],
      ageYears: 50,
    });

    expect(fired.map((r) => r.ruleId)).toContain('RF004');
    expect(inactiveMatched).toContain('RF001');
  });
});

/*
 * ROUTING ON WHAT WE ALREADY KNOW.
 *
 * A person's chronic conditions change where they should be sent: a
 * diabetic with an infection is better served somewhere that can also
 * handle the diabetes. That influence is a small explicit lookup table,
 * never an inference, and these tests pin the three properties that make
 * it safe to ship:
 *
 *   - every capability it names actually EXISTS in the vocabulary, or it
 *     silently narrows the search to nothing;
 *   - a resolved condition stops counting;
 *   - a red flag ignores history entirely, because in an emergency the
 *     nearest capable facility beats the best-matched one.
 */
describe('history-aware routing', () => {
  /**
   * The guard that would have caught a real bug in this table.
   *
   * `SPEC_NEUROLOGIST` was written here and does not exist — every epileptic
   * would have been routed to a facility holding a capability nothing can
   * hold, which returns no facilities at all. A typo in this table fails
   * closed and silently, so it is checked against the database.
   */
  it('EVERY capability in the history table exists in the vocabulary', async () => {
    const named = [...new Set(HISTORY_CAPABILITIES.flatMap((h) => h.capabilities))];
    const found = await prisma.capability.findMany({
      where: { code: { in: named } },
      select: { code: true },
    });
    const missing = named.filter((c) => !found.some((f) => f.code === c));
    expect(missing).toEqual([]);
  });

  async function personWithCondition(
    icd11Code: string,
    icd11Title: string,
    opts: { chronic?: boolean; status?: 'ACTIVE' | 'CONFIRMED' | 'RESOLVED' } = {},
  ) {
    const facility = await makeFacility('History Clinic', 4, ['OPD_GENERAL']);
    const person = await registerAdult(prisma, {
      nationalId: `77${Math.floor(Math.random() * 1_000_000)}`,
      phone: `0733${Math.floor(100000 + Math.random() * 899999)}`,
      givenName: 'Akinyi',
      familyName: 'Onyango',
      sexAtBirth: 'FEMALE',
      dateOfBirth: new Date(Date.UTC(1980, 0, 1)),
      countyId: ctx.kisumuId,
      subcountyId: ctx.kisumuCentralId,
      passwordHash: 'argon2id$test',
    });

    const docPerson = await registerAdult(prisma, {
      nationalId: `88${Math.floor(Math.random() * 1_000_000)}`,
      phone: `0744${Math.floor(100000 + Math.random() * 899999)}`,
      givenName: 'Doctor',
      familyName: 'Otieno',
      sexAtBirth: 'MALE',
      dateOfBirth: new Date(Date.UTC(1975, 0, 1)),
      countyId: ctx.kisumuId,
      subcountyId: ctx.kisumuCentralId,
      passwordHash: 'argon2id$test',
    });
    const { practitioner } = await registerPractitioner(prisma, {
      personId: docPerson.id,
      cadre: 'DOCTOR',
      countyId: ctx.kisumuId,
      subcountyId: ctx.kisumuCentralId,
      licenceNumber: `KMPDC/HX/${Math.floor(Math.random() * 100000)}`,
    });
    await grantAffiliation(prisma, {
      practitionerId: practitioner.id,
      facilityId: facility.id,
      grantedBy: 'ministry-1',
      grantedByKind: 'MINISTRY',
    });
    await checkInPractitioner(prisma, {
      practitionerId: practitioner.id,
      facilityId: facility.id,
    });

    /*
     * Written through the real service layer, not inserted directly.
     *
     * A direct insert was rejected by the licence trigger — the append-only
     * hardening refuses a row whose licence number does not belong to an
     * active licence. That refusal is correct, and going through
     * `openEncounter`/`recordDiagnosis` means this fixture exercises the
     * same gate a clinician does.
     */
    const encounter = await openEncounter(prisma, {
      practitionerId: practitioner.id,
      personId: person.id,
      kind: 'OUTPATIENT',
      chiefComplaint: 'Routine review',
    });
    await recordDiagnosis(prisma, {
      practitionerId: practitioner.id,
      encounterId: encounter.id,
      icd11Code,
      clinicalStatus: opts.status ?? 'ACTIVE',
      isChronic: opts.chronic ?? true,
    });

    return person;
  }

  it('an active chronic condition widens the search, and says why', async () => {
    const person = await personWithCondition('5A11', 'Type 2 diabetes mellitus');

    const factors = await historyFactors(prisma, person.id);

    expect(factors).toHaveLength(1);
    expect(factors[0].label).toBe('diabetes');
    expect(factors[0].capabilities).toContain('DIABETES_CLINIC');
  });

  it('CONFIRMED counts, not only ACTIVE — it is what clinicians record', async () => {
    /*
     * The bug this pins.
     *
     * The first version of this filter matched `clinicalStatus: 'ACTIVE'`
     * alone. `recordDiagnosis` writes CONFIRMED, so every confirmed diabetic
     * in the database was invisible to routing — and the failure was silent:
     * the search simply was not widened and nothing said why.
     */
    const person = await personWithCondition('5A11', 'Type 2 diabetes mellitus', {
      status: 'CONFIRMED',
    });

    const factors = await historyFactors(prisma, person.id);

    expect(factors.map((f) => f.label)).toContain('diabetes');
  });

  it('a RESOLVED condition stops narrowing their options', async () => {
    // Someone whose diabetes is in the record as resolved must not be
    // routed for the rest of their life as though it were active.
    const person = await personWithCondition('5A11', 'Type 2 diabetes mellitus', {
      status: 'RESOLVED',
    });

    expect(await historyFactors(prisma, person.id)).toEqual([]);
  });

  it('a one-off condition does not count as history', async () => {
    const person = await personWithCondition('5A11', 'Type 2 diabetes mellitus', {
      chronic: false,
    });

    expect(await historyFactors(prisma, person.id)).toEqual([]);
  });

  it('folds the history capability in when a facility can honour it', async () => {
    /*
     * The facility must hold everything the SYMPTOM rules need as well as
     * the preferred capability, or the preferred search finds nothing and
     * the engine correctly falls back — see "history never eliminates every
     * option" below. An earlier version of this test omitted MALARIA_RDT
     * and PHARMACY and then asserted the preference had applied, which it
     * had not.
     */
    const person = await personWithCondition('5A11', 'Type 2 diabetes mellitus');
    await makeFacility('Diabetes-capable', 4, [
      'OPD_GENERAL',
      'LAB_BASIC',
      'MALARIA_RDT',
      'PHARMACY',
      'DIABETES_CLINIC',
    ]);

    const result = await recommend(prisma, {
      symptoms: ['fever'],
      ageYears: 45,
      personId: person.id,
      countyId: ctx.kisumuId,
      subcountyId: ctx.kisumuCentralId,
    });

    expect(result.requiredCapabilities).toContain('DIABETES_CLINIC');
    expect(result.historyFactors.map((f) => f.label)).toContain('diabetes');
    expect(result.facilities.map((f) => f.name)).toContain('Diabetes-capable');
  });

  it('A RED FLAG IGNORES HISTORY — the nearest capable facility wins', async () => {
    await activateRule('RF001');
    const person = await personWithCondition('5A11', 'Type 2 diabetes mellitus');

    const result = await recommend(prisma, {
      symptoms: ['chest_pain', 'breathlessness'],
      ageYears: 45,
      personId: person.id,
      countyId: ctx.kisumuId,
      subcountyId: ctx.kisumuCentralId,
    });

    expect(result.redFlag).toBe(true);
    // Adding "must also have a diabetes clinic" here could rule out the
    // nearest hospital with an open theatre. That trade is never worth it.
    expect(result.requiredCapabilities).not.toContain('DIABETES_CLINIC');
    expect(result.historyFactors).toEqual([]);
  });
});

/*
 * HISTORY MUST NOT LEAVE SOMEBODY WITH NOWHERE TO GO.
 *
 * Adding "must also have a diabetes clinic" is right when such a facility
 * exists. When none does, insisting on it returns nothing — and a diabetic
 * with a fever is told there is nowhere to go, which is false and is the
 * worst answer the system could give. So history is a preference with a
 * fallback, and the screen only claims the record shaped the result when it
 * actually did.
 */
describe('history never eliminates every option', () => {
  async function diabeticPerson() {
    const person = await registerAdult(prisma, {
      nationalId: `66${Math.floor(Math.random() * 1_000_000)}`,
      phone: `0755${Math.floor(100000 + Math.random() * 899999)}`,
      givenName: 'Wanjiru',
      familyName: 'Kamau',
      sexAtBirth: 'FEMALE',
      dateOfBirth: new Date(Date.UTC(1980, 0, 1)),
      countyId: ctx.kisumuId,
      subcountyId: ctx.kisumuCentralId,
      passwordHash: 'argon2id$test',
    });
    const facility = await makeFacility('Basic Clinic', 4, [
      'OPD_GENERAL',
      'LAB_BASIC',
      'MALARIA_RDT',
      'PHARMACY',
    ]);
    const docPerson = await registerAdult(prisma, {
      nationalId: `55${Math.floor(Math.random() * 1_000_000)}`,
      phone: `0766${Math.floor(100000 + Math.random() * 899999)}`,
      givenName: 'Doctor',
      familyName: 'Owino',
      sexAtBirth: 'MALE',
      dateOfBirth: new Date(Date.UTC(1975, 0, 1)),
      countyId: ctx.kisumuId,
      subcountyId: ctx.kisumuCentralId,
      passwordHash: 'argon2id$test',
    });
    const { practitioner } = await registerPractitioner(prisma, {
      personId: docPerson.id,
      cadre: 'DOCTOR',
      countyId: ctx.kisumuId,
      subcountyId: ctx.kisumuCentralId,
      licenceNumber: `KMPDC/FB/${Math.floor(Math.random() * 100000)}`,
    });
    await grantAffiliation(prisma, {
      practitionerId: practitioner.id,
      facilityId: facility.id,
      grantedBy: 'ministry-1',
      grantedByKind: 'MINISTRY',
    });
    await checkInPractitioner(prisma, {
      practitionerId: practitioner.id,
      facilityId: facility.id,
    });
    const encounter = await openEncounter(prisma, {
      practitionerId: practitioner.id,
      personId: person.id,
      kind: 'OUTPATIENT',
      chiefComplaint: 'Review',
    });
    await recordDiagnosis(prisma, {
      practitionerId: practitioner.id,
      encounterId: encounter.id,
      icd11Code: '5A11',
      clinicalStatus: 'CONFIRMED',
      isChronic: true,
    });
    return person;
  }

  it('FALLS BACK to what the symptoms need when nowhere has the preferred capability', async () => {
    // No facility in this world holds DIABETES_CLINIC.
    const person = await diabeticPerson();

    const result = await recommend(prisma, {
      symptoms: ['cough', 'fever'],
      ageYears: 45,
      personId: person.id,
      countyId: ctx.kisumuId,
      subcountyId: ctx.kisumuCentralId,
    });

    // The answer a diabetic with a cough must never get is "nowhere".
    expect(result.facilities.length).toBeGreaterThan(0);
    // …and the screen must not claim the record shaped a result it did not.
    expect(result.historyFactors).toEqual([]);
    expect(result.requiredCapabilities).not.toContain('DIABETES_CLINIC');
  });

  it('PREFERS the capable facility when one exists, and says so', async () => {
    const person = await diabeticPerson();
    await makeFacility('Diabetes Centre', 4, [
      'OPD_GENERAL',
      'LAB_BASIC',
      'MALARIA_RDT',
      'PHARMACY',
      'DIABETES_CLINIC',
    ]);

    const result = await recommend(prisma, {
      symptoms: ['cough', 'fever'],
      ageYears: 45,
      personId: person.id,
      countyId: ctx.kisumuId,
      subcountyId: ctx.kisumuCentralId,
    });

    /*
     * Asserted on EXCLUSIVITY, not membership.
     *
     * "Diabetes Centre is in the list" passes even with the preference
     * removed — both facilities match the symptoms, so both appear. What
     * proves the preference ran is that the basic clinic is FILTERED OUT.
     */
    const names = result.facilities.map((f) => f.name);
    expect(names).toContain('Diabetes Centre');
    expect(names).not.toContain('Basic Clinic');
    expect(result.historyFactors.map((f) => f.label)).toContain('diabetes');
    expect(result.requiredCapabilities).toContain('DIABETES_CLINIC');
  });
});
