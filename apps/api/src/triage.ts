/**
 * Triage and facility recommendation — Phase 6.
 *
 * Deterministic, rules-based, explainable. Every recommendation traces to a
 * named rule at a known version, so when one is later questioned you can
 * reconstruct exactly what fired. No model sits in this decision path.
 *
 * Two properties matter more than the ranking:
 *
 *   1. A red flag bypasses ranking entirely. Chest pain with breathlessness
 *      does not get "nearest facility with an X-ray" — it gets "go to an
 *      emergency department now".
 *
 *   2. An unreviewed red-flag rule cannot fire. It is loaded inactive and
 *      stays that way until a practising clinician signs it off.
 */
import { PrismaClient, type Prisma } from '@prisma/client';
import { findFacilities, findWithWidening, type FacilityMatch } from './facility.js';

export type Db = PrismaClient | Prisma.TransactionClient;

export class TriageError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'TriageError';
  }
}

export type Urgency = 'EMERGENCY' | 'URGENT_24H' | 'SOON_7D' | 'ROUTINE';

const URGENCY_ORDER: Urgency[] = ['ROUTINE', 'SOON_7D', 'URGENT_24H', 'EMERGENCY'];

export interface TriageInput {
  symptoms: string[];
  ageYears: number;
  sex?: 'MALE' | 'FEMALE' | 'INTERSEX';
  personId?: string;
  countyId?: string;
  subcountyId?: string;
  location?: { latitude: number; longitude: number };
}

export interface TriageResult {
  urgency: Urgency | null;
  redFlag: boolean;
  rulesFired: string[];
  requiredCapabilities: string[];
  minKephLevel: number;
  adviceEn: string;
  adviceSw: string;
  facilities: FacilityMatch[];
  scope: 'SUBCOUNTY' | 'COUNTY' | 'NATIONAL' | 'NONE';
  /** Set when a rule matched the symptoms but was gated by clinical review. */
  inactiveRulesMatched: string[];
  disclaimer: string;
}

/**
 * Shown on every recommendation, without exception. NHP routes people to
 * facilities; it does not diagnose them, and the screen must never let a
 * citizen believe otherwise.
 */
export const DISCLAIMER_EN =
  'This is guidance on where to seek care, not a diagnosis. ' +
  'If your symptoms get worse, go to the nearest health facility immediately.';

export const DISCLAIMER_SW =
  'Huu ni mwongozo wa mahali pa kupata huduma, si utambuzi wa ugonjwa. ' +
  'Dalili zikizidi, nenda kituo cha afya kilicho karibu mara moja.';

/**
 * Matches the reported symptoms against the rule set.
 *
 * A rule fires only when EVERY symptom it names was reported — a rule for
 * "chest pain AND breathlessness" must not fire on chest pain alone, or the
 * engine would escalate half the country to emergency departments.
 */
export async function evaluateRules(db: Db, input: TriageInput) {
  const reported = new Set(input.symptoms);

  const all = await db.triageRule.findMany({
    where: { active: true },
    orderBy: { ruleId: 'asc' },
  });

  const fired = all.filter((r) => {
    if (r.symptoms.length === 0) return false;
    if (!r.symptoms.every((s) => reported.has(s))) return false;
    return input.ageYears >= r.ageMin && input.ageYears <= r.ageMax;
  });

  // Rules that WOULD have fired but are gated by clinical review. Surfaced
  // rather than swallowed — a silently missing red flag is dangerous, and
  // an operator needs to know the rule set is incomplete.
  const inactive = await db.triageRule.findMany({
    where: { active: false },
    select: { ruleId: true, symptoms: true, ageMin: true, ageMax: true, redFlag: true },
  });

  const inactiveMatched = inactive
    .filter(
      (r) =>
        r.symptoms.length > 0 &&
        r.symptoms.every((s) => reported.has(s)) &&
        input.ageYears >= r.ageMin &&
        input.ageYears <= r.ageMax,
    )
    .map((r) => r.ruleId);

  return { fired, inactiveMatched };
}

/**
 * The full recommendation.
 *
 * Red flags short-circuit: if one fires, ranking is skipped and the patient
 * is sent to the nearest facility that can handle an emergency, regardless
 * of what else matched.
 */
export async function recommend(db: Db, input: TriageInput): Promise<TriageResult> {
  const unknown = await unknownSymptoms(db, input.symptoms);
  if (unknown.length > 0) {
    throw new TriageError(
      `Unknown symptom code(s): ${unknown.join(', ')}. ` +
        'Symptoms come from a controlled vocabulary.',
      'UNKNOWN_SYMPTOM',
    );
  }

  const { fired, inactiveMatched } = await evaluateRules(db, input);

  if (fired.length === 0) {
    return {
      urgency: null,
      redFlag: false,
      rulesFired: [],
      requiredCapabilities: [],
      minKephLevel: 2,
      adviceEn:
        'We could not match your symptoms to a rule. Please visit your ' +
        'nearest health facility.',
      adviceSw:
        'Hatukuweza kulinganisha dalili zako. Tafadhali tembelea kituo cha ' +
        'afya kilicho karibu.',
      facilities: [],
      scope: 'NONE',
      inactiveRulesMatched: inactiveMatched,
      disclaimer: DISCLAIMER_EN,
    };
  }

  const redFlags = fired.filter((r) => r.redFlag);

  // A red flag bypasses ranking. Where several fire, take the one demanding
  // the highest facility level — the most capable destination wins.
  const chosen = redFlags.length
    ? redFlags.reduce((a, b) => (b.minKephLevel > a.minKephLevel ? b : a))
    : fired.reduce((a, b) =>
        URGENCY_ORDER.indexOf(b.urgency as Urgency) >
        URGENCY_ORDER.indexOf(a.urgency as Urgency)
          ? b
          : a,
      );

  const capabilities = redFlags.length
    ? chosen.requiredCapabilities
    : [...new Set(fired.flatMap((r) => r.requiredCapabilities))];

  const minKeph = redFlags.length
    ? chosen.minKephLevel
    : Math.max(...fired.map((r) => r.minKephLevel));

  const search = {
    requiredCapabilities: capabilities,
    minKephLevel: minKeph,
    near: input.location,
    // In an emergency, only a facility that is actually open counts.
    openNow: redFlags.length > 0,
    limit: 5,
  };

  let facilities: FacilityMatch[] = [];
  let scope: TriageResult['scope'] = 'NONE';

  if (input.countyId && input.subcountyId) {
    const widened = await findWithWidening(db, {
      ...search,
      countyId: input.countyId,
      subcountyId: input.subcountyId,
    });
    facilities = widened.matches;
    scope = widened.matches.length ? widened.scope : 'NONE';
  } else {
    facilities = await findFacilities(db, search);
    scope = facilities.length ? 'NATIONAL' : 'NONE';
  }

  return {
    urgency: redFlags.length ? 'EMERGENCY' : (chosen.urgency as Urgency),
    redFlag: redFlags.length > 0,
    rulesFired: (redFlags.length ? redFlags : fired).map((r) => r.ruleId),
    requiredCapabilities: capabilities,
    minKephLevel: minKeph,
    adviceEn: chosen.adviceEn,
    adviceSw: chosen.adviceSw,
    facilities,
    scope,
    inactiveRulesMatched: inactiveMatched,
    disclaimer: DISCLAIMER_EN,
  };
}

/** Symptom codes not in the vocabulary. Free text would break the engine. */
export async function unknownSymptoms(db: Db, codes: string[]): Promise<string[]> {
  if (codes.length === 0) return [];
  const known = await db.symptomTerm.findMany({
    where: { code: { in: codes } },
    select: { code: true },
  });
  const knownSet = new Set(known.map((k) => k.code));
  return codes.filter((c) => !knownSet.has(c));
}

/**
 * The citizen-facing picker, grouped by body system and filtered to what can
 * apply. Nobody should be asked about pregnancy bleeding if it cannot.
 */
export async function symptomPicker(
  db: Db,
  opts: { ageYears: number; sex?: 'MALE' | 'FEMALE' | 'INTERSEX'; lang?: 'en' | 'sw' } = {
    ageYears: 30,
  },
) {
  const lang = opts.lang ?? 'en';
  const symptoms = await db.symptomTerm.findMany({
    where: {
      minAge: { lte: opts.ageYears },
      maxAge: { gte: opts.ageYears },
      ...(opts.sex && opts.sex !== 'INTERSEX' ? { sex: { in: ['ANY', opts.sex] } } : {}),
    },
    orderBy: [{ bodySystem: 'asc' }, { labelEn: 'asc' }],
  });

  const grouped = new Map<
    string,
    Array<{ code: string; label: string; question: string; severityMarker: boolean }>
  >();

  for (const s of symptoms) {
    const list = grouped.get(s.bodySystem) ?? [];
    list.push({
      code: s.code,
      label: lang === 'sw' ? s.labelSw : s.labelEn,
      question: lang === 'sw' ? s.questionSw : s.questionEn,
      severityMarker: s.severityMarker,
    });
    grouped.set(s.bodySystem, list);
  }

  return [...grouped.entries()].map(([bodySystem, items]) => ({ bodySystem, items }));
}

/**
 * Records what we told someone.
 *
 * `actedOnEncounterId` closes the loop later: when a recommendation is
 * followed by an encounter at the recommended facility, you can measure
 * whether the engine routed correctly — which is how the rules improve
 * without a model ever entering the decision path.
 */
export async function saveRecommendation(
  db: Db,
  input: TriageInput,
  result: TriageResult,
  ruleVersion = 1,
) {
  return db.recommendation.create({
    data: {
      personId: input.personId ?? null,
      symptoms: input.symptoms,
      ageYears: input.ageYears,
      ruleVersion,
      rulesFired: result.rulesFired,
      redFlagShown: result.redFlag,
      urgency: result.urgency,
      facilitiesOffered: result.facilities.map((f) => ({
        id: f.id,
        name: f.name,
        kephLevel: f.kephLevel,
        distanceKm: f.distanceKm,
        confidence: f.confidence,
      })) as unknown as Prisma.InputJsonValue,
      scope: result.scope,
      fromLatitude: input.location?.latitude ?? null,
      fromLongitude: input.location?.longitude ?? null,
    },
  });
}

/** Links a recommendation to the encounter it led to. */
export async function markRecommendationActedOn(
  db: Db,
  recommendationId: string,
  encounterId: string,
) {
  return db.recommendation.update({
    where: { id: recommendationId },
    data: { actedOnEncounterId: encounterId },
  });
}

/**
 * Did people go where we sent them?
 *
 * The honest measure of whether the engine works. A low follow-through rate
 * on emergencies is a far more serious signal than a low one on routine
 * advice, so they are reported separately.
 */
export async function followThroughRate(db: Db, since: Date) {
  const rows = await db.recommendation.groupBy({
    by: ['urgency'],
    where: { issuedAt: { gte: since } },
    _count: { _all: true },
  });

  const acted = await db.recommendation.groupBy({
    by: ['urgency'],
    where: { issuedAt: { gte: since }, actedOnEncounterId: { not: null } },
    _count: { _all: true },
  });

  const actedByUrgency = new Map(acted.map((a) => [a.urgency, a._count._all]));

  return rows.map((r) => {
    const followed = actedByUrgency.get(r.urgency) ?? 0;
    return {
      urgency: r.urgency,
      issued: r._count._all,
      followed,
      ratePercent: Math.round((followed / r._count._all) * 1000) / 10,
    };
  });
}

/**
 * Rules that reference a symptom nobody can report, or capabilities no
 * facility has. A rule that can never fire is worse than no rule — it looks
 * like coverage that does not exist.
 */
export async function ruleCoverageGaps(db: Db) {
  const [rules, symptoms, capabilities] = await Promise.all([
    db.triageRule.findMany({
      where: { active: true },
      select: { ruleId: true, symptoms: true, requiredCapabilities: true, redFlag: true },
    }),
    db.symptomTerm.findMany({ select: { code: true } }),
    db.capability.findMany({ select: { code: true } }),
  ]);

  const knownSymptoms = new Set(symptoms.map((s) => s.code));
  const knownCapabilities = new Set(capabilities.map((c) => c.code));

  const gaps: Array<{ ruleId: string; issue: string; detail: string[] }> = [];

  for (const r of rules) {
    const missingSymptoms = r.symptoms.filter((s) => !knownSymptoms.has(s));
    if (missingSymptoms.length) {
      gaps.push({
        ruleId: r.ruleId,
        issue: 'UNKNOWN_SYMPTOM',
        detail: missingSymptoms,
      });
    }
    const missingCaps = r.requiredCapabilities.filter((c) => !knownCapabilities.has(c));
    if (missingCaps.length) {
      gaps.push({
        ruleId: r.ruleId,
        issue: 'UNKNOWN_CAPABILITY',
        detail: missingCaps,
      });
    }
  }

  return gaps;
}

/**
 * Red-flag symptoms with no active rule behind them.
 *
 * The invariant that caught nine real safety holes when the seed data was
 * built: a citizen reporting self-harm thoughts must not be routed as
 * routine because the rule is missing or gated.
 */
export async function orphanedRedFlags(db: Db) {
  const [redFlagSymptoms, activeRedFlagRules] = await Promise.all([
    db.symptomTerm.findMany({ where: { kind: 'RED_FLAG' }, select: { code: true } }),
    db.triageRule.findMany({
      where: { redFlag: true, active: true },
      select: { symptoms: true },
    }),
  ]);

  const covered = new Set(activeRedFlagRules.flatMap((r) => r.symptoms));
  return redFlagSymptoms.map((s) => s.code).filter((c) => !covered.has(c));
}
