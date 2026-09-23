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
import { PrismaClient, type Prisma, type CondStatus } from '@prisma/client';
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
  /**
   * What in this person's record widened the search, and why.
   *
   * Surfaced so the recommendation can SAY "because you are living with
   * diabetes" rather than silently ranking differently. A citizen who
   * cannot see why they were sent somewhere has no way to disagree.
   */
  historyFactors: HistoryFactor[];
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

/**
 * Chronic conditions that change WHERE someone should be sent.
 *
 * Deliberately a short, explicit table rather than anything inferred. Each
 * entry says: if this person is living with X, the facility they are routed
 * to should also be able to handle X. A diabetic with a foot infection is
 * better served somewhere with a diabetes clinic, and that is a lookup, not
 * a prediction.
 *
 * Keyed by ICD-11 code PREFIX, so `5A11` matches `5A11.0` and the rest of
 * the block. Anything not listed simply adds nothing — the routing falls
 * back to what the symptoms alone require, which is the safe default.
 *
 * This table is the ONLY way a person's history influences routing. Keeping
 * it small and readable is the point: a clinician can audit it in a minute,
 * and every recommendation can name the condition that widened the search.
 */
export const HISTORY_CAPABILITIES: Array<{
  icd11Prefix: string;
  label: string;
  capabilities: string[];
}> = [
  { icd11Prefix: '5A1', label: 'diabetes', capabilities: ['DIABETES_CLINIC'] },
  { icd11Prefix: '5A2', label: 'diabetes', capabilities: ['DIABETES_CLINIC'] },
  { icd11Prefix: 'BA0', label: 'hypertension', capabilities: ['ECG'] },
  { icd11Prefix: 'BA4', label: 'a heart condition', capabilities: ['ECG', 'SPEC_CARDIOLOGIST'] },
  { icd11Prefix: 'BA5', label: 'a heart condition', capabilities: ['ECG', 'SPEC_CARDIOLOGIST'] },
  { icd11Prefix: 'CA23', label: 'asthma', capabilities: ['OXYGEN'] },
  { icd11Prefix: '1C6', label: 'HIV', capabilities: ['HIV_CARE'] },
  { icd11Prefix: '1B1', label: 'tuberculosis', capabilities: ['TB_TREATMENT'] },
  { icd11Prefix: 'GB6', label: 'kidney disease', capabilities: ['DIALYSIS'] },
  { icd11Prefix: '3A5', label: 'sickle cell disease', capabilities: ['BLOOD_BANK'] },
  { icd11Prefix: '8A6', label: 'epilepsy', capabilities: ['MENTAL_HEALTH'] },
];

export interface HistoryFactor {
  /** What the person is living with, in words a citizen would recognise. */
  label: string;
  /** What that adds to the facility search. */
  capabilities: string[];
}

/**
 * The statuses that mean the person still lives with the condition.
 *
 * Deliberately a named list rather than `status === 'ACTIVE'`. CONFIRMED is
 * what a clinician actually records when they diagnose something — the
 * first version of this filter matched only ACTIVE, and every confirmed
 * diabetic in the database was silently invisible to routing. The failure
 * was invisible too: the search simply was not widened, and nothing said so.
 *
 * SUSPECTED and REFUTED are excluded because neither is a diagnosis;
 * RESOLVED and IN_REMISSION because the condition is no longer driving
 * where this person should be sent.
 */
const LIVING_WITH: CondStatus[] = ['CONFIRMED', 'ACTIVE', 'RECURRENCE'];

/**
 * What this person's ongoing chronic conditions add to a facility search.
 *
 * Only current, non-superseded conditions count. A resolved condition must
 * not keep narrowing someone's options for the rest of their life.
 */
export async function historyFactors(
  db: Db,
  personId: string,
): Promise<HistoryFactor[]> {
  const chronic = await db.condition.findMany({
    where: {
      personId,
      isChronic: true,
      clinicalStatus: { in: LIVING_WITH },
      supersededAt: null,
    },
    select: { icd11Code: true },
  });

  const seen = new Map<string, HistoryFactor>();
  for (const c of chronic) {
    for (const entry of HISTORY_CAPABILITIES) {
      if (!c.icd11Code.startsWith(entry.icd11Prefix)) continue;
      const existing = seen.get(entry.label);
      if (existing) {
        for (const cap of entry.capabilities) {
          if (!existing.capabilities.includes(cap)) existing.capabilities.push(cap);
        }
      } else {
        seen.set(entry.label, { label: entry.label, capabilities: [...entry.capabilities] });
      }
    }
  }
  return [...seen.values()];
}

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
      historyFactors: [],
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

  /*
   * The person's own record, folded in.
   *
   * Deliberately NOT applied to a red flag. In an emergency the only thing
   * that matters is reaching a facility that can stabilise them; adding
   * "must also have a diabetes clinic" could rule out the nearest hospital
   * with an open theatre, and that trade is never worth making.
   */
  const factors = redFlags.length || !input.personId
    ? []
    : await historyFactors(db, input.personId);

  /*
   * What the SYMPTOMS require. Non-negotiable: a facility without these
   * cannot treat what the person came for.
   */
  const symptomCapabilities = redFlags.length
    ? chosen.requiredCapabilities
    : [...new Set(fired.flatMap((r) => r.requiredCapabilities))];

  /*
   * What their HISTORY prefers, on top. Not the same kind of requirement —
   * see the fallback below.
   */
  const preferred = [...new Set(factors.flatMap((f) => f.capabilities))].filter(
    (c) => !symptomCapabilities.includes(c),
  );

  const capabilities = [...symptomCapabilities, ...preferred];

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

  async function runSearch(required: string[]) {
    if (input.countyId && input.subcountyId) {
      const widened = await findWithWidening(db, {
        ...search,
        requiredCapabilities: required,
        countyId: input.countyId,
        subcountyId: input.subcountyId,
      });
      return {
        matches: widened.matches,
        scope: (widened.matches.length ? widened.scope : 'NONE') as TriageResult['scope'],
      };
    }
    const matches = await findFacilities(db, { ...search, requiredCapabilities: required });
    return { matches, scope: (matches.length ? 'NATIONAL' : 'NONE') as TriageResult['scope'] };
  }

  /*
   * History is a PREFERENCE, not a requirement.
   *
   * Asking for a diabetes clinic on top of what the symptoms need is right
   * when such a facility exists. When none does, insisting on it returns
   * NOTHING — and a diabetic with a fever is then told there is nowhere to
   * go, which is both false and the worst possible answer.
   *
   * So the preferred search runs first, and falls back to what the symptoms
   * alone require. `appliedHistory` records which one answered, so the
   * screen only claims the record shaped the result when it actually did.
   */
  let { matches: facilities, scope } = await runSearch(capabilities);
  let appliedHistory = preferred.length > 0;

  if (!facilities.length && preferred.length) {
    ({ matches: facilities, scope } = await runSearch(symptomCapabilities));
    appliedHistory = false;
  }

  return {
    urgency: redFlags.length ? 'EMERGENCY' : (chosen.urgency as Urgency),
    redFlag: redFlags.length > 0,
    rulesFired: (redFlags.length ? redFlags : fired).map((r) => r.ruleId),
    requiredCapabilities: appliedHistory ? capabilities : symptomCapabilities,
    minKephLevel: minKeph,
    adviceEn: chosen.adviceEn,
    adviceSw: chosen.adviceSw,
    facilities,
    scope,
    inactiveRulesMatched: inactiveMatched,
    // Reported only when it actually shaped the result — the screen says
    // "because you are living with X", and that must not be a lie.
    historyFactors: appliedHistory ? factors : [],
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
