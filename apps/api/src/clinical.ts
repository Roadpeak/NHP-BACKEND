/**
 * Clinical core — Phase 4.
 *
 * Every write here passes through the Phase 0 check-in gate at the database.
 * This layer supplies the clinical stamp correctly so that gate never has to
 * refuse, adds the vocabulary lookups the encounter screen needs, and runs
 * the prescribing safety check before a drug is committed.
 *
 * Nothing here can UPDATE or DELETE a clinical row. Corrections insert a new
 * version and mark the predecessor via nhp_supersede().
 */
import { PrismaClient, type Prisma } from '@prisma/client';
import { canWriteClinical } from './practitioner.js';
import { decryptField } from './crypto.js';
import { ageAt } from './identity.js';

export type Db = PrismaClient | Prisma.TransactionClient;

/**
 * The sentinel code for a medicine that is not on the KEML.
 *
 * A real value rather than null or the typed text, for two reasons. Every
 * query that groups or counts by KEML code keeps working unchanged, and an
 * uncoded medicine is visibly uncoded wherever it surfaces instead of
 * masquerading as a code nobody can look up.
 *
 * It is deliberately not a valid KEML code shape, so it can never collide
 * with one the list adds later.
 */
export const UNCODED_MEDICATION = 'UNCODED';

export class ClinicalError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'ClinicalError';
  }
}

// ------------------------------------------------------------- vocabulary

export interface DiagnosisHit {
  icd11Code: string;
  clinicalTitle: string;
  plainEn: string;
  plainSw: string;
  sensitivity: string;
  isNotifiable: boolean;
  score: number;
}

/**
 * Diagnosis search — the encounter screen's hot path.
 *
 * Ranking mirrors the wireframe spec: exact synonym beats prefix beats
 * substring. The target is that typing `mal` returns falciparum malaria
 * first, so coded entry is *faster* than free text rather than merely
 * possible.
 */
export async function searchDiagnoses(
  db: Db,
  query: string,
  limit = 5,
): Promise<DiagnosisHit[]> {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];

  // The seed vocabulary is small enough to rank in memory, which keeps the
  // ordering identical to search_test.py rather than approximating it in
  // SQL. Revisit when the list reaches the planned ~2,000 codes.
  const terms = await db.diagnosisTerm.findMany({
    select: {
      icd11Code: true,
      clinicalTitle: true,
      plainEn: true,
      plainSw: true,
      sensitivity: true,
      isNotifiable: true,
      synonyms: true,
      abbreviations: true,
    },
  });

  const scored = terms
    .map((t) => {
      const candidates = [t.clinicalTitle, ...t.synonyms, ...t.abbreviations].map((s) =>
        s.toLowerCase(),
      );
      let best = 0;
      for (const c of candidates) {
        if (c === q) best = Math.max(best, 1000);
        else if (c.startsWith(q)) best = Math.max(best, 500 - c.length);
        else if (c.includes(q)) best = Math.max(best, 300 - c.length);
      }
      // Typing a code directly is a valid shortcut for clinicians who know it.
      if (t.icd11Code.toLowerCase().startsWith(q)) best = Math.max(best, 900);
      return { term: t, score: best };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;

      // Ties are common — "malaria" matches both the specific and the
      // unspecified entry equally. Without a deterministic tiebreak the
      // winner depends on database row order, so the same query would
      // return different diagnoses on different days.
      //
      // Prefer the SPECIFIC code: an unspecified diagnosis is the one a
      // clinician falls back to, not the one they should be nudged toward,
      // and specific codes are what make the national analytics useful.
      const aUnspec = /unspecified/i.test(a.term.clinicalTitle);
      const bUnspec = /unspecified/i.test(b.term.clinicalTitle);
      if (aUnspec !== bUnspec) return aUnspec ? 1 : -1;

      // Still tied: order by code, so the result is at least stable.
      return a.term.icd11Code.localeCompare(b.term.icd11Code);
    })
    .slice(0, limit);

  return scored.map(({ term, score }) => ({
    icd11Code: term.icd11Code,
    clinicalTitle: term.clinicalTitle,
    plainEn: term.plainEn,
    plainSw: term.plainSw,
    sensitivity: term.sensitivity,
    isNotifiable: term.isNotifiable,
    score,
  }));
}

export async function searchMedications(db: Db, query: string, limit = 5) {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];

  const terms = await db.medicationTerm.findMany();
  return terms
    .map((t) => {
      const candidates = [t.genericName, ...t.synonyms].map((s) => s.toLowerCase());
      let best = 0;
      for (const c of candidates) {
        if (c === q) best = Math.max(best, 1000);
        else if (c.startsWith(q)) best = Math.max(best, 500 - c.length);
        else if (c.includes(q)) best = Math.max(best, 300 - c.length);
      }
      return { term: t, score: best };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ term }) => term);
}

// ------------------------------------------------------- prescribing check

export type PrescribingVerdict = 'ALLOW' | 'WARN' | 'BLOCK';

export interface PrescribingCheck {
  verdict: PrescribingVerdict;
  reasons: string[];
  alternatives: Array<{ kemlCode: string; genericName: string; adultDose: string }>;
}

/**
 * The contraindication interrupt from the wireframes.
 *
 * Fires at drug SELECTION, not on submit. Names the allergy with its
 * provenance, and offers alternatives — each of which is re-checked against
 * the same patient, so a penicillin-allergic pregnant patient is never
 * handed something unsafe on the second hop.
 */
export async function checkPrescribing(
  db: Db,
  input: {
    personId: string;
    kemlCode: string;
    isPregnant?: boolean;
    ageYears?: number;
    renalImpairment?: boolean;
  },
  depth = 0,
): Promise<PrescribingCheck> {
  /*
   * An uncoded medicine.
   *
   * The KEML is what Kenyan facilities stock, but it is not everything a
   * clinician may legitimately prescribe — imports, specials, trial drugs,
   * and anything the list has not caught up with. Refusing outright pushed
   * that prescription onto paper, where the record cannot see it at all,
   * and a medicine missing from the record is exactly what the allergy
   * interrupt exists to prevent.
   *
   * So it is allowed, and it WARNS. The warning is the honest statement of
   * what was lost: with no KEML row there is no allergy class, no
   * pregnancy category and no renal flag, so none of the checks below can
   * run. The clinician is told that, rather than being given a silent
   * ALLOW that looks identical to a drug that passed every check.
   */
  if (input.kemlCode === UNCODED_MEDICATION) {
    return {
      verdict: 'WARN',
      reasons: [
        'This medicine is not on the Kenya Essential Medicines List, so no ' +
          'allergy, pregnancy or kidney-function check could be run against it. ' +
          'Check the patient’s allergies yourself before prescribing.',
      ],
      alternatives: [],
    };
  }

  const drug = await db.medicationTerm.findUnique({ where: { kemlCode: input.kemlCode } });
  if (!drug) {
    throw new ClinicalError(`Unknown medication '${input.kemlCode}'`, 'UNKNOWN_MEDICATION');
  }

  /*
   * A catalogue entry.
   *
   * These come from the official KEML PDF, which carries a name, a form, a
   * strength and a level of use — and no allergy class, no pregnancy
   * category and no paediatric dosing, because those are clinical policy
   * rather than reference data. So the drug is real and on the national
   * list, but the checks below have nothing to check against.
   *
   * Warned in the same terms as an uncoded medicine, for the same reason:
   * an ALLOW here would be indistinguishable from a drug that passed every
   * check, and that is the failure mode worth designing against.
   */
  if (drug.reviewStatus === 'CATALOGUE_ONLY') {
    return {
      verdict: 'WARN',
      reasons: [
        `${drug.genericName} is on the Kenya Essential Medicines List but has ` +
          'no reviewed safety data, so no allergy, pregnancy or kidney-function ' +
          'check could be run against it. Check the patient’s allergies yourself.',
      ],
      alternatives: [],
    };
  }

  const reasons: string[] = [];
  let verdict: PrescribingVerdict = 'ALLOW';
  const alternativeCodes: string[] = [];

  const escalate = (to: PrescribingVerdict) => {
    if (to === 'BLOCK' || verdict === 'BLOCK') verdict = 'BLOCK';
    else if (to === 'WARN') verdict = 'WARN';
  };

  // --- allergy, including cross-reactions
  const allergies = await db.allergy.findMany({
    where: { personId: input.personId, supersededAt: null },
    select: { allergyClass: true, substanceLabel: true, severity: true, recordedAt: true },
  });

  for (const patientAllergy of allergies) {
    if (!patientAllergy.allergyClass) continue;

    const cls = await db.allergyClassTerm.findUnique({
      where: { allergyClass: patientAllergy.allergyClass },
    });
    if (!cls) continue;

    const direct = drug.allergyClass === patientAllergy.allergyClass;
    const cross =
      drug.allergyClass !== null && cls.crossReactsWith.includes(drug.allergyClass);

    if (direct || cross) {
      const when = patientAllergy.recordedAt.toISOString().slice(0, 10);
      reasons.push(
        direct
          ? `${drug.genericName} is in the ${cls.labelEn} class — patient has a ` +
            `${patientAllergy.severity} reaction to ${patientAllergy.substanceLabel} ` +
            `recorded ${when}`
          : `${drug.genericName} (${drug.allergyClass}) cross-reacts with ` +
            `${cls.labelEn} — patient has a ${patientAllergy.severity} reaction ` +
            `recorded ${when}`,
      );
      escalate(
        patientAllergy.severity === 'SEVERE' || patientAllergy.severity === 'ANAPHYLAXIS'
          ? 'BLOCK'
          : 'WARN',
      );
      alternativeCodes.push(...cls.alternatives);
    }
  }

  // --- pregnancy
  if (input.isPregnant) {
    const pc = drug.pregnancyCategory;
    if (pc === 'CONTRAINDICATED') {
      reasons.push(`${drug.genericName} is contraindicated in pregnancy`);
      escalate('BLOCK');
    } else if (pc.startsWith('AVOID')) {
      reasons.push(`${drug.genericName}: ${pc.replace(/_/g, ' ').toLowerCase()}`);
      escalate('WARN');
    } else if (pc === 'USE_WITH_CAUTION') {
      reasons.push(`${drug.genericName}: use with caution in pregnancy`);
      escalate('WARN');
    }
  }

  // --- paediatric
  if (input.ageYears !== undefined && input.ageYears < 12) {
    if (drug.paedDosingMode === 'ADULT_ONLY') {
      reasons.push(`${drug.genericName} has no paediatric dose in the formulary`);
      escalate('WARN');
    } else if (drug.paedDosingMode === 'WEIGHT_BAND_TABLE') {
      reasons.push(`${drug.genericName}: dose from the weight-band table`);
    }
  }

  // --- renal
  if (input.renalImpairment && drug.renalCaution) {
    reasons.push(`${drug.genericName} needs dose adjustment in renal impairment`);
    escalate('WARN');
  }

  // Never suggest an alternative that is itself unsafe for this patient.
  // Depth-limited: alternatives are checked once, not recursively forever.
  const alternatives: PrescribingCheck['alternatives'] = [];
  if (depth === 0) {
    for (const code of [...new Set(alternativeCodes)]) {
      if (code === input.kemlCode) continue;
      const alt = await db.medicationTerm.findUnique({ where: { kemlCode: code } });
      if (!alt) continue;
      const altCheck = await checkPrescribing(db, { ...input, kemlCode: code }, depth + 1);
      if (altCheck.verdict === 'ALLOW') {
        alternatives.push({
          kemlCode: alt.kemlCode,
          genericName: alt.genericName,
          adultDose: `${alt.adultDose} ${alt.adultFreq}`,
        });
      }
    }
  }

  return { verdict, reasons, alternatives };
}

// -------------------------------------------------------------- encounters

export interface OpenEncounterInput {
  practitionerId: string;
  personId: string;
  kind:
    | 'OUTPATIENT'
    | 'INPATIENT'
    | 'EMERGENCY'
    | 'MATERNITY'
    | 'IMMUNISATION'
    | 'SCREENING'
    | 'FOLLOW_UP'
    | 'TELEHEALTH';
  chiefComplaint: string;
  presentation?: Prisma.InputJsonValue;
  triageBand?: 'RED' | 'ORANGE' | 'YELLOW' | 'GREEN';
}

/**
 * Opens an encounter.
 *
 * The gate is checked here so a clinician gets an explanation, not a
 * database error — but the database checks it again regardless. Belt and
 * braces is correct for the only write path into a national health record.
 */
export async function openEncounter(db: Db, input: OpenEncounterInput) {
  const gate = await canWriteClinical(db, input.practitionerId);
  if (!gate.allowed) {
    throw new ClinicalError(gate.reason, gate.code);
  }

  const person = await db.person.findUnique({
    where: { id: input.personId },
    select: { id: true, lifeStatus: true },
  });
  if (!person) throw new ClinicalError('Patient not found', 'PERSON_NOT_FOUND');
  if (person.lifeStatus === 'DECEASED') {
    throw new ClinicalError(
      'This patient is recorded as deceased. If that is wrong, raise a ' +
        'correction before recording new care.',
      'PATIENT_DECEASED',
    );
  }

  const now = new Date();
  return db.encounter.create({
    data: {
      personId: input.personId,
      checkInId: gate.checkInId,
      recordedBy: input.practitionerId,
      facilityId: gate.facilityId,
      licenceNumber: gate.licenceNumber,
      recordedAt: now,
      kind: input.kind,
      startedAt: now,
      chiefComplaint: input.chiefComplaint,
      presentation: input.presentation,
      triageBand: input.triageBand ?? null,
    },
  });
}

export async function recordDiagnosis(
  db: Db,
  input: {
    practitionerId: string;
    encounterId: string;
    icd11Code: string;
    clinicalStatus?:
      | 'SUSPECTED'
      | 'CONFIRMED'
      | 'ACTIVE'
      | 'RESOLVED'
      | 'RECURRENCE'
      | 'IN_REMISSION'
      | 'REFUTED';
    onsetDate?: Date;
    isChronic?: boolean;
    notes?: string;
  },
) {
  const gate = await canWriteClinical(db, input.practitionerId);
  if (!gate.allowed) throw new ClinicalError(gate.reason, gate.code);

  const encounter = await db.encounter.findUnique({
    where: { id: input.encounterId },
    select: { id: true, personId: true },
  });
  if (!encounter) throw new ClinicalError('Encounter not found', 'ENCOUNTER_NOT_FOUND');

  // Free text here would make the national analytics worthless: "malaria",
  // "Malaria" and "susp. malaria" would become three diseases.
  const term = await db.diagnosisTerm.findUnique({
    where: { icd11Code: input.icd11Code },
  });
  if (!term) {
    throw new ClinicalError(
      `'${input.icd11Code}' is not in the diagnosis vocabulary. ` +
        'Diagnoses must be coded; use the search to find the right term.',
      'UNKNOWN_DIAGNOSIS',
    );
  }

  const facility = await db.facility.findUnique({
    where: { id: gate.facilityId },
    select: { kephLevel: true },
  });

  // First-ever flag for new-case counting in the Phase 7 rollup. Computing
  // it later means scanning a national dataset.
  const prior = await db.condition.count({
    where: { personId: encounter.personId, icd11Code: input.icd11Code },
  });

  return db.condition.create({
    data: {
      personId: encounter.personId,
      checkInId: gate.checkInId,
      recordedBy: input.practitionerId,
      facilityId: gate.facilityId,
      licenceNumber: gate.licenceNumber,
      recordedAt: new Date(),
      sensitivity: term.sensitivity,
      encounterId: encounter.id,
      icd11Code: term.icd11Code,
      // Frozen at write time: ICD-11 is revised, and a record must show what
      // the clinician actually selected on the day.
      icd11Title: term.clinicalTitle,
      icd11Chapter: term.icd11Chapter,
      clinicalStatus: input.clinicalStatus ?? 'CONFIRMED',
      onsetDate: input.onsetDate ?? null,
      isChronic: input.isChronic ?? false,
      isFirstEver: prior === 0,
      kephLevel: facility?.kephLevel ?? 2,
      notes: input.notes ?? null,
    },
  });
}

export async function recordAllergy(
  db: Db,
  input: {
    practitionerId: string;
    personId: string;
    substanceKind: 'DRUG' | 'FOOD' | 'ENVIRONMENT' | 'OTHER';
    substanceLabel: string;
    allergyClass?: string;
    reaction: string;
    severity: 'MILD' | 'MODERATE' | 'SEVERE' | 'ANAPHYLAXIS';
    certainty?: 'SUSPECTED' | 'CONFIRMED';
  },
) {
  const gate = await canWriteClinical(db, input.practitionerId);
  if (!gate.allowed) throw new ClinicalError(gate.reason, gate.code);

  if (input.allergyClass) {
    const cls = await db.allergyClassTerm.findUnique({
      where: { allergyClass: input.allergyClass },
    });
    if (!cls) {
      throw new ClinicalError(
        `Unknown allergy class '${input.allergyClass}'. Without a known class ` +
          'the contraindication check cannot fire.',
        'UNKNOWN_ALLERGY_CLASS',
      );
    }
  }

  return db.allergy.create({
    data: {
      personId: input.personId,
      checkInId: gate.checkInId,
      recordedBy: input.practitionerId,
      facilityId: gate.facilityId,
      licenceNumber: gate.licenceNumber,
      recordedAt: new Date(),
      // Always Tier 1 — a database CHECK enforces this too. An allergy that
      // consent rules could hide is an allergy that kills someone.
      sensitivity: 'TIER_1_EMERGENCY',
      substanceKind: input.substanceKind,
      substanceLabel: input.substanceLabel,
      allergyClass: input.allergyClass ?? null,
      reaction: input.reaction,
      severity: input.severity,
      certainty: input.certainty ?? 'CONFIRMED',
    },
  });
}

export async function prescribe(
  db: Db,
  input: {
    practitionerId: string;
    encounterId: string;
    kemlCode: string;
    /**
     * The medicine's name, when `kemlCode` is UNCODED. Ignored otherwise —
     * a coded prescription takes its name from the formulary, so a typo in
     * a client cannot rename a drug in somebody's record.
     */
    genericName?: string;
    doseAmount: number;
    doseUnit: string;
    /** Only read for an UNCODED medicine; a coded one uses the formulary route. */
    route?: 'ORAL' | 'IV' | 'IM' | 'SC' | 'TOPICAL' | 'INHALED' | 'RECTAL';
    frequency: string;
    durationDays?: number;
    indicationCode?: string;
    /** Required when the safety check returns BLOCK. Logged against the prescriber. */
    overrideReason?: string;
    isPregnant?: boolean;
    ageYears?: number;
    renalImpairment?: boolean;
  },
) {
  const gate = await canWriteClinical(db, input.practitionerId);
  if (!gate.allowed) throw new ClinicalError(gate.reason, gate.code);

  const encounter = await db.encounter.findUnique({
    where: { id: input.encounterId },
    select: { id: true, personId: true },
  });
  if (!encounter) throw new ClinicalError('Encounter not found', 'ENCOUNTER_NOT_FOUND');

  /*
   * Uncoded, and recorded as such.
   *
   * `kemlCode` stays the UNCODED sentinel rather than being left blank or
   * filled with the typed text: every existing query that groups or counts
   * by KEML code keeps working, and an uncoded medicine is visibly uncoded
   * wherever it appears instead of masquerading as a code nobody can
   * resolve. The name the clinician typed goes in `genericName`, which is
   * where a reader looks anyway.
   */
  const uncoded = input.kemlCode === UNCODED_MEDICATION;
  if (uncoded && !input.genericName?.trim()) {
    throw new ClinicalError(
      'An uncoded medicine must be named.',
      'MEDICATION_NAME_REQUIRED',
    );
  }

  const drug = uncoded
    ? null
    : await db.medicationTerm.findUnique({ where: { kemlCode: input.kemlCode } });
  if (!uncoded && !drug) {
    throw new ClinicalError(
      `'${input.kemlCode}' is not in the formulary`,
      'UNKNOWN_MEDICATION',
    );
  }

  const check = await checkPrescribing(db, {
    personId: encounter.personId,
    kemlCode: input.kemlCode,
    isPregnant: input.isPregnant,
    ageYears: input.ageYears,
    renalImpairment: input.renalImpairment,
  });

  // Override is always available — blocking a clinician outright is how
  // people learn to route around the system. But it costs a typed reason,
  // and it is attributed.
  if (check.verdict === 'BLOCK' && !input.overrideReason) {
    throw new ClinicalError(
      `Contraindicated: ${check.reasons.join('; ')}. ` +
        'To prescribe anyway, supply an overrideReason — it will be recorded ' +
        'against you.',
      'CONTRAINDICATED',
    );
  }

  // No formulary row means no maximum to check against. Said plainly in
  // the WARN above rather than silently skipped here.
  if (drug?.maxDailyMg) {
    const perDay = input.doseAmount * frequencyPerDay(input.frequency);
    if (perDay > Number(drug.maxDailyMg)) {
      throw new ClinicalError(
        `${input.doseAmount}${input.doseUnit} ${input.frequency} is ` +
          `${perDay}mg/day, above the ${drug.maxDailyMg}mg maximum for ` +
          `${drug.genericName}`,
        'EXCEEDS_MAX_DAILY_DOSE',
      );
    }
  }

  const notes =
    check.verdict === 'BLOCK'
      ? `OVERRIDE: ${input.overrideReason} [${check.reasons.join('; ')}]`
      : null;

  return db.medication.create({
    data: {
      personId: encounter.personId,
      checkInId: gate.checkInId,
      recordedBy: input.practitionerId,
      facilityId: gate.facilityId,
      licenceNumber: gate.licenceNumber,
      recordedAt: new Date(),
      encounterId: encounter.id,
      kemlCode: uncoded ? UNCODED_MEDICATION : drug!.kemlCode,
      genericName: uncoded ? input.genericName!.trim() : drug!.genericName,
      doseAmount: input.doseAmount,
      doseUnit: input.doseUnit,
      // A coded medicine takes its route from the formulary, so a client
      // cannot contradict it. An uncoded one has no formulary row, so the
      // prescriber states the route and it defaults to oral.
      route: uncoded ? (input.route ?? 'ORAL') : drug!.route,
      frequency: input.frequency,
      durationDays: input.durationDays ?? drug?.adultDurationDays ?? null,
      indicationCode: input.indicationCode ?? null,
      status: 'PRESCRIBED',
      stoppedReason: notes,
    },
  });
}

/** Doses per day for the standard Kenyan frequency codes. */
export function frequencyPerDay(frequency: string): number {
  const map: Record<string, number> = {
    OD: 1,
    BD: 2,
    TDS: 3,
    QDS: 4,
    STAT: 1,
    PRN: 1,
  };
  return map[frequency.toUpperCase()] ?? 1;
}

export async function recordObservation(
  db: Db,
  input: {
    practitionerId: string;
    personId: string;
    encounterId?: string;
    code: string;
    label: string;
    category: 'VITAL' | 'LAB' | 'ANTHROPOMETRIC' | 'IMAGING';
    valueNum?: number;
    valueText?: string;
    unit?: string;
    refLow?: number;
    refHigh?: number;
    observedAt?: Date;
  },
) {
  const gate = await canWriteClinical(db, input.practitionerId);
  if (!gate.allowed) throw new ClinicalError(gate.reason, gate.code);

  // Flagged here rather than at render: a clinician scanning a list needs
  // the abnormal ones to stand out without recomputing ranges by eye.
  let abnormalFlag: 'LOW' | 'NORMAL' | 'HIGH' | null = null;
  if (input.valueNum !== undefined && input.refLow !== undefined && input.refHigh !== undefined) {
    abnormalFlag =
      input.valueNum < input.refLow ? 'LOW' : input.valueNum > input.refHigh ? 'HIGH' : 'NORMAL';
  }

  return db.observation.create({
    data: {
      personId: input.personId,
      checkInId: gate.checkInId,
      recordedBy: input.practitionerId,
      facilityId: gate.facilityId,
      licenceNumber: gate.licenceNumber,
      recordedAt: new Date(),
      encounterId: input.encounterId ?? null,
      code: input.code,
      label: input.label,
      category: input.category,
      valueNum: input.valueNum ?? null,
      valueText: input.valueText ?? null,
      unit: input.unit ?? null,
      refLow: input.refLow ?? null,
      refHigh: input.refHigh ?? null,
      abnormalFlag,
      observedAt: input.observedAt ?? new Date(),
    },
  });
}

export async function recordProcedure(
  db: Db,
  input: {
    practitionerId: string;
    personId: string;
    encounterId?: string;
    code: string;
    title: string;
    performedOn: Date;
    datePrecision?: 'EXACT' | 'MONTH' | 'YEAR' | 'ESTIMATED';
    performedAtFacilityId?: string;
    externalFacilityName?: string;
    indication: string;
    outcome?: string;
    complications?: string;
    isSelfReported?: boolean;
  },
) {
  const gate = await canWriteClinical(db, input.practitionerId);
  if (!gate.allowed) throw new ClinicalError(gate.reason, gate.code);

  if (!input.indication?.trim()) {
    throw new ClinicalError(
      'A procedure needs an indication — what it was for',
      'INDICATION_REQUIRED',
    );
  }

  return db.procedure.create({
    data: {
      personId: input.personId,
      checkInId: gate.checkInId,
      recordedBy: input.practitionerId,
      facilityId: gate.facilityId,
      licenceNumber: gate.licenceNumber,
      recordedAt: new Date(),
      encounterId: input.encounterId ?? null,
      code: input.code,
      title: input.title,
      performedOn: input.performedOn,
      datePrecision: input.datePrecision ?? 'EXACT',
      performedAtFacilityId: input.performedAtFacilityId ?? null,
      externalFacilityName: input.externalFacilityName ?? null,
      indication: input.indication.trim(),
      outcome: input.outcome ?? null,
      complications: input.complications ?? null,
      isSelfReported: input.isSelfReported ?? false,
    },
  });
}

// ------------------------------------------------------------- corrections

/**
 * Amends a clinical row.
 *
 * Inserts a NEW version pointing at its predecessor, then marks the original
 * superseded via the one permitted UPDATE path. The original stays visible
 * and attributed — this is what makes the record defensible in an inquiry.
 */
export async function amendDiagnosis(
  db: PrismaClient,
  input: {
    practitionerId: string;
    conditionId: string;
    icd11Code: string;
    clinicalStatus?: 'SUSPECTED' | 'CONFIRMED' | 'RESOLVED' | 'REFUTED';
    amendmentReason: string;
  },
) {
  const gate = await canWriteClinical(db, input.practitionerId);
  if (!gate.allowed) throw new ClinicalError(gate.reason, gate.code);

  if (!input.amendmentReason?.trim()) {
    throw new ClinicalError(
      'A correction requires a reason — it becomes part of the record',
      'AMENDMENT_REASON_REQUIRED',
    );
  }

  const original = await db.condition.findUnique({ where: { id: input.conditionId } });
  if (!original) throw new ClinicalError('Condition not found', 'CONDITION_NOT_FOUND');
  if (original.supersededAt) {
    throw new ClinicalError(
      'That record has already been superseded; amend the current version',
      'ALREADY_SUPERSEDED',
    );
  }

  const term = await db.diagnosisTerm.findUnique({ where: { icd11Code: input.icd11Code } });
  if (!term) throw new ClinicalError('Unknown diagnosis code', 'UNKNOWN_DIAGNOSIS');

  const facility = await db.facility.findUnique({
    where: { id: gate.facilityId },
    select: { kephLevel: true },
  });

  const corrected = await db.condition.create({
    data: {
      personId: original.personId,
      checkInId: gate.checkInId,
      recordedBy: input.practitionerId,
      facilityId: gate.facilityId,
      licenceNumber: gate.licenceNumber,
      recordedAt: new Date(),
      sensitivity: term.sensitivity,
      encounterId: original.encounterId,
      icd11Code: term.icd11Code,
      icd11Title: term.clinicalTitle,
      icd11Chapter: term.icd11Chapter,
      clinicalStatus: input.clinicalStatus ?? original.clinicalStatus,
      isChronic: original.isChronic,
      isFirstEver: false,
      kephLevel: facility?.kephLevel ?? original.kephLevel,
      supersedesId: original.id,
      amendmentReason: input.amendmentReason,
    },
  });

  // The only permitted UPDATE on a clinical table — a SECURITY DEFINER
  // function that sets superseded_at and nothing else.
  await db.$executeRawUnsafe(`SELECT nhp_supersede('condition', $1::text)`, original.id);

  return corrected;
}

// ----------------------------------------------------------- patient view

/**
 * Resolves the NHP number a clinician types (`NHP-0Y3F-4RGH`) to the
 * internal person id every service below expects.
 *
 * These are two different things and confusing them fails quietly: the
 * clinical queries filter on `person_id`, so a display number matches
 * nothing and the caller gets an empty timeline rather than an error —
 * a patient with a real history looking like a patient with none.
 *
 * Accepts an internal id too, so callers that already hold one still work.
 */
export async function resolvePersonId(db: Db, nhpIdOrPersonId: string): Promise<string> {
  const person = await db.person.findFirst({
    where: {
      OR: [{ displayNumber: nhpIdOrPersonId }, { id: nhpIdOrPersonId }],
    },
    select: { id: true },
  });
  if (!person) {
    throw new ClinicalError('Patient not found', 'PERSON_NOT_FOUND');
  }
  return person.id;
}

/**
 * The clinician's summary banner.
 *
 * Allergies, current medications and chronic conditions — everything capable
 * of causing harm, in one query, visible without scrolling. Superseded rows
 * are excluded; the current version is what a clinician acts on.
 */
export async function patientSummary(db: Db, personId: string) {
  const [person, allergies, medications, chronic] = await Promise.all([
    db.person.findUnique({
      where: { id: personId },
      select: {
        id: true,
        displayNumber: true,
        givenName: true,
        familyName: true,
        dateOfBirth: true,
        sexAtBirth: true,
        bloodGroup: true,
        lifeStatus: true,
      },
    }),
    db.allergy.findMany({
      where: { personId, supersededAt: null },
      orderBy: { severity: 'desc' },
      select: {
        substanceLabel: true,
        allergyClass: true,
        reaction: true,
        severity: true,
        recordedAt: true,
      },
    }),
    db.medication.findMany({
      where: { personId, supersededAt: null, status: { in: ['PRESCRIBED', 'ACTIVE'] } },
      orderBy: { recordedAt: 'desc' },
      select: {
        genericName: true,
        doseAmount: true,
        doseUnit: true,
        frequency: true,
        recordedAt: true,
      },
    }),
    db.condition.findMany({
      where: {
        personId,
        supersededAt: null,
        isChronic: true,
        clinicalStatus: { notIn: ['RESOLVED', 'REFUTED'] },
      },
      select: { icd11Code: true, icd11Title: true, onsetDate: true },
    }),
  ]);

  if (!person) throw new ClinicalError('Patient not found', 'PERSON_NOT_FOUND');

  // Names are encrypted at rest. Decrypting here rather than at the HTTP
  // layer keeps every caller — API, worker, report — on the same path, so
  // one of them cannot forget.
  return {
    person: {
      ...person,
      givenName: decryptField(person.givenName),
      familyName: decryptField(person.familyName),
      age: ageAt(person.dateOfBirth),
    },
    allergies,
    medications,
    chronicConditions: chronic,
  };
}

/**
 * Key results, most recent first, with the series behind each.
 *
 * The wireframes are specific about this: a single HbA1c of 8.4% is a
 * number, six readings trending upward is a clinical finding. Sparklines
 * cost almost nothing and change what the clinician concludes, so the API
 * returns the series rather than just the latest value.
 */
export async function keyResults(
  db: Db,
  personId: string,
  opts: { codes?: string[]; perCode?: number } = {},
) {
  const observations = await db.observation.findMany({
    where: {
      personId,
      supersededAt: null,
      ...(opts.codes ? { code: { in: opts.codes } } : {}),
    },
    orderBy: { observedAt: 'desc' },
    select: {
      code: true,
      label: true,
      category: true,
      valueNum: true,
      valueText: true,
      unit: true,
      refLow: true,
      refHigh: true,
      abnormalFlag: true,
      observedAt: true,
    },
  });

  const byCode = new Map<string, typeof observations>();
  for (const o of observations) {
    const list = byCode.get(o.code) ?? [];
    if (list.length < (opts.perCode ?? 8)) list.push(o);
    byCode.set(o.code, list);
  }

  return [...byCode.entries()].map(([code, series]) => {
    const latest = series[0];
    return {
      code,
      label: latest.label,
      category: latest.category,
      unit: latest.unit,
      latest: {
        value: latest.valueNum !== null ? Number(latest.valueNum) : latest.valueText,
        observedAt: latest.observedAt,
        abnormalFlag: latest.abnormalFlag,
      },
      refLow: latest.refLow !== null ? Number(latest.refLow) : null,
      refHigh: latest.refHigh !== null ? Number(latest.refHigh) : null,
      // Oldest first, so a sparkline reads left to right.
      series: [...series]
        .reverse()
        .map((o) => ({
          value: o.valueNum !== null ? Number(o.valueNum) : null,
          observedAt: o.observedAt,
        }))
        .filter((p) => p.value !== null),
    };
  });
}

/**
 * Surgeries and procedures.
 *
 * `isSelfReported` and `externalFacilityName` matter here: NHP starts with
 * fifty million people who already have histories, and a clinician must be
 * able to tell documented history from remembered history at a glance.
 */
export async function procedureHistory(db: Db, personId: string) {
  return db.procedure.findMany({
    where: { personId, supersededAt: null },
    orderBy: { performedOn: 'desc' },
    select: {
      code: true,
      title: true,
      performedOn: true,
      datePrecision: true,
      externalFacilityName: true,
      performedAtFacilityId: true,
      indication: true,
      outcome: true,
      complications: true,
      isSelfReported: true,
    },
  });
}

/**
 * Paginated timeline. Never load a whole life at once.
 *
 * Resolves the author and facility to names. The wireframes require every
 * encounter to say who recorded it — "Nurse S. Adhiambo · NCK/44812" — both
 * because it builds trust in the record and because a clinician needs to be
 * able to call whoever saw the patient last. Raw ids do neither.
 */
export async function patientTimeline(
  db: Db,
  personId: string,
  opts: { limit?: number; before?: Date } = {},
) {
  const encounters = await db.encounter.findMany({
    where: {
      personId,
      supersededAt: null,
      ...(opts.before ? { startedAt: { lt: opts.before } } : {}),
    },
    orderBy: { startedAt: 'desc' },
    take: opts.limit ?? 20,
    select: {
      id: true,
      kind: true,
      startedAt: true,
      chiefComplaint: true,
      disposition: true,
      facilityId: true,
      recordedBy: true,
      licenceNumber: true,
      conditions: {
        where: { supersededAt: null },
        select: { icd11Code: true, icd11Title: true, clinicalStatus: true },
      },
      medications: {
        where: { supersededAt: null },
        select: { genericName: true, doseAmount: true, doseUnit: true, frequency: true },
      },
    },
  });

  if (encounters.length === 0) return [];

  // Two lookups for the whole page rather than one per row.
  const [facilities, practitioners] = await Promise.all([
    db.facility.findMany({
      where: { id: { in: [...new Set(encounters.map((e) => e.facilityId))] } },
      select: { id: true, name: true, kephLevel: true },
    }),
    db.practitioner.findMany({
      where: { id: { in: [...new Set(encounters.map((e) => e.recordedBy))] } },
      select: { id: true, cadre: true, person: { select: { givenName: true, familyName: true } } },
    }),
  ]);

  const facilityById = new Map(facilities.map((f) => [f.id, f]));
  const practitionerById = new Map(practitioners.map((p) => [p.id, p]));

  return encounters.map((e) => {
    const facility = facilityById.get(e.facilityId);
    const author = practitionerById.get(e.recordedBy);

    return {
      ...e,
      facilityName: facility?.name ?? 'Unknown facility',
      facilityKephLevel: facility?.kephLevel ?? null,
      recordedByName: author
        ? `${decryptField(author.person.givenName)} ${decryptField(author.person.familyName)}`
        : 'Unknown clinician',
      recordedByCadre: author?.cadre ?? null,
    };
  });
}
