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
} from '../src/triage.js';
import { registerFacility, approveFacility, claimCapability } from '../src/facility.js';

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
});
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const ctx = { kisumuId: '', kisumuCentralId: '', siayaId: '', siayaCentralId: '' };

async function wipeFacilities() {
  await owner.query('SET session_replication_role = replica');
  for (const t of [
    'recommendation', 'condition', 'medication', 'allergy', 'encounter',
    'check_in', 'affiliation', 'licence', 'practitioner',
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
