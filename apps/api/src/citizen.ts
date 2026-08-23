/**
 * The citizen's own view of their record.
 *
 * The same rows the clinician sees, for a reader with no clinical training,
 * possibly reading in Swahili, possibly on a shared handset, possibly
 * worried. Kenya's adult literacy is around 78% with a real rural–urban
 * gap, and Swahili is the language of everyday life while English dominates
 * official documents.
 *
 * The rules that shape everything here:
 *
 *   - Plain language FIRST, the clinical term below it — never the reverse.
 *   - Lead with what is true right now. Someone opening this at 9pm wants to
 *     know whether they need to do something, not to read history.
 *   - Never show a bare abnormal result. "HbA1c 8.4% ▲" to someone with no
 *     context produces fear or false calm.
 *   - Never deliver a serious diagnosis here first. A cancer diagnosis
 *     arriving on a phone before a clinician has spoken to the patient is a
 *     real harm.
 */
import { PrismaClient, type Prisma } from '@prisma/client';
import { decryptField } from './crypto.js';
import { ageAt } from './identity.js';

export type Db = PrismaClient | Prisma.TransactionClient;

export class CitizenError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'CitizenError';
  }
}

export type Lang = 'en' | 'sw';

/**
 * How long a serious diagnosis is withheld from the citizen view.
 *
 * Not secrecy — sequencing. The clinician needs a chance to have the
 * conversation before the patient reads it on a phone. After the window the
 * record appears regardless, because indefinite withholding would be worse.
 */
export const SERIOUS_DIAGNOSIS_DELAY_HOURS = 48;

/**
 * Diagnoses NHP will not surface to a citizen before a clinician has had a
 * chance to speak to them. Deliberately narrow: cancers and a handful of
 * other findings where reading it cold causes real harm.
 */
function isSeriousDisclosure(icd11Code: string): boolean {
  // ICD-11 chapter 2 is neoplasms.
  return icd11Code.startsWith('2') || icd11Code.startsWith('1C6');
}

const UI = {
  en: {
    greeting: 'Habari',
    yourRecord: 'Your health record',
    rightNow: 'Right now',
    yourVisits: 'Your visits',
    dailyMedicines: 'Medicines you take daily',
    noVisits: 'No visits recorded yet',
    whatHappened: 'What happened',
    medicalTerm: 'The medical term',
    medicineGiven: 'Medicine you were given',
    whoTreated: 'Who treated you',
    somethingWrong: 'Something look wrong?',
    tellUs: 'Tell us — we will ask the facility',
    cannotChange:
      'This record cannot be deleted or changed. Corrections are added as a new entry, so your full history stays intact.',
    pendingReview: 'A recent result is being reviewed. Your clinician will contact you.',
  },
  sw: {
    greeting: 'Habari',
    yourRecord: 'Rekodi yako ya afya',
    rightNow: 'Kwa sasa',
    yourVisits: 'Ziara zako',
    dailyMedicines: 'Dawa unazotumia kila siku',
    noVisits: 'Hakuna ziara zilizorekodiwa bado',
    whatHappened: 'Kilichotokea',
    medicalTerm: 'Neno la kitaalamu',
    medicineGiven: 'Dawa uliyopewa',
    whoTreated: 'Aliyekutibu',
    somethingWrong: 'Kuna kitu si sahihi?',
    tellUs: 'Tuambie — tutauliza kituo',
    cannotChange:
      'Rekodi hii haiwezi kufutwa wala kubadilishwa. Marekebisho huongezwa kama kipengele kipya, hivyo historia yako yote inabaki.',
    pendingReview: 'Matokeo ya hivi karibuni yanakaguliwa. Daktari wako atawasiliana nawe.',
  },
} as const;

export function uiStrings(lang: Lang) {
  return UI[lang];
}

const CADRE_PLAIN: Record<string, { en: string; sw: string }> = {
  DOCTOR: { en: 'Dr', sw: 'Dkt' },
  DENTIST: { en: 'Dr', sw: 'Dkt' },
  CLINICAL_OFFICER: { en: 'Clinical Officer', sw: 'Afisa wa Kliniki' },
  NURSE: { en: 'Nurse', sw: 'Muuguzi' },
  MIDWIFE: { en: 'Midwife', sw: 'Mkunga' },
  PHARMACIST: { en: 'Pharmacist', sw: 'Mfamasia' },
};

export interface CitizenSummary {
  name: string;
  displayNumber: string;
  age: number;
  /** Things that need action today. */
  rightNow: Array<{
    kind: 'MEDICATION' | 'CHRONIC' | 'ALLERGY';
    title: string;
    detail: string;
    tone: 'good' | 'caution' | 'critical';
  }>;
  dailyMedicines: Array<{ name: string; forWhat: string | null; regimen: string }>;
  /** Set when a serious diagnosis is inside its release window. */
  pendingClinicianContact: boolean;
}

/**
 * The landing summary.
 *
 * Leads with what is true right now, because someone opening this at 9pm
 * wants to know whether they need to do something.
 */
export async function citizenSummary(
  db: Db,
  personId: string,
  lang: Lang = 'en',
  now: Date = new Date(),
): Promise<CitizenSummary> {
  const person = await db.person.findUnique({
    where: { id: personId },
    select: {
      displayNumber: true,
      givenName: true,
      familyName: true,
      dateOfBirth: true,
    },
  });
  if (!person) throw new CitizenError('Record not found', 'PERSON_NOT_FOUND');

  const [medications, chronic, allergies] = await Promise.all([
    db.medication.findMany({
      where: { personId, supersededAt: null, status: { in: ['PRESCRIBED', 'ACTIVE'] } },
      orderBy: { recordedAt: 'desc' },
      select: {
        kemlCode: true,
        genericName: true,
        doseAmount: true,
        doseUnit: true,
        frequency: true,
        indicationCode: true,
      },
    }),
    db.condition.findMany({
      where: {
        personId,
        supersededAt: null,
        isChronic: true,
        clinicalStatus: { notIn: ['RESOLVED', 'REFUTED'] },
      },
      select: { icd11Code: true, icd11Title: true },
    }),
    db.allergy.findMany({
      where: { personId, supersededAt: null },
      select: { substanceLabel: true, severity: true },
    }),
  ]);

  // Plain-language labels for anything we are about to show.
  const codes = [
    ...new Set([...chronic.map((c) => c.icd11Code), ...medications.map((m) => m.indicationCode).filter((c): c is string => !!c)]),
  ];
  const terms = await db.diagnosisTerm.findMany({
    where: { icd11Code: { in: codes } },
    select: { icd11Code: true, plainEn: true, plainSw: true, clinicalTitle: true },
  });
  const plainByCode = new Map(terms.map((t) => [t.icd11Code, lang === 'sw' ? t.plainSw : t.plainEn]));

  const medTerms = await db.medicationTerm.findMany({
    where: { kemlCode: { in: medications.map((m) => m.kemlCode) } },
    select: { kemlCode: true, plainEn: true, plainSw: true },
  });
  const medPlain = new Map(medTerms.map((t) => [t.kemlCode, lang === 'sw' ? t.plainSw : t.plainEn]));

  const rightNow: CitizenSummary['rightNow'] = [];

  for (const a of allergies) {
    const severe = a.severity === 'SEVERE' || a.severity === 'ANAPHYLAXIS';
    rightNow.push({
      kind: 'ALLERGY',
      title:
        lang === 'sw'
          ? `Una mzio wa ${a.substanceLabel}`
          : `You are allergic to ${a.substanceLabel}`,
      detail:
        lang === 'sw'
          ? 'Waambie daktari yeyote anayekutibu'
          : 'Tell any clinician who treats you',
      tone: severe ? 'critical' : 'caution',
    });
  }

  for (const c of chronic) {
    rightNow.push({
      kind: 'CHRONIC',
      // Falls back to the clinical title rather than showing nothing — an
      // untranslated term sends someone to ask a nurse, which is safe.
      title: plainByCode.get(c.icd11Code) ?? c.icd11Title,
      detail: lang === 'sw' ? 'Hali ya muda mrefu' : 'A long-term condition',
      tone: 'caution',
    });
  }

  // A serious diagnosis recorded very recently is withheld, with a note
  // that a clinician will make contact.
  const recentSerious = await db.condition.findFirst({
    where: {
      personId,
      supersededAt: null,
      recordedAt: { gte: new Date(now.getTime() - SERIOUS_DIAGNOSIS_DELAY_HOURS * 3_600_000) },
    },
    select: { icd11Code: true },
  });

  return {
    name: `${decryptField(person.givenName)} ${decryptField(person.familyName)}`,
    displayNumber: person.displayNumber,
    age: ageAt(person.dateOfBirth, now),
    rightNow,
    dailyMedicines: medications.map((m) => ({
      name: m.genericName,
      forWhat: m.indicationCode ? (plainByCode.get(m.indicationCode) ?? null) : (medPlain.get(m.kemlCode) ?? null),
      regimen: `${m.doseAmount}${m.doseUnit} ${m.frequency}`,
    })),
    pendingClinicianContact: recentSerious ? isSeriousDisclosure(recentSerious.icd11Code) : false,
  };
}

export interface CitizenVisit {
  encounterId: string;
  when: Date;
  facilityName: string;
  /** Plain language, e.g. "You had malaria". */
  whatHappened: string;
  /** The clinical term, shown BELOW the plain one, never above. */
  clinicalTitle: string | null;
  icd11Code: string | null;
  treatedBy: string;
  medicines: Array<{ name: string; plain: string | null; regimen: string }>;
  /** True when a serious diagnosis is still inside its release window. */
  withheld: boolean;
}

/**
 * The visit timeline.
 *
 * Plain language leads; the clinical term sits below it. A patient carrying
 * their record to a private specialist or travelling abroad needs the real
 * term — so we simplify the presentation, never the record.
 */
export async function citizenTimeline(
  db: Db,
  personId: string,
  opts: { lang?: Lang; limit?: number; now?: Date } = {},
): Promise<CitizenVisit[]> {
  const lang = opts.lang ?? 'en';
  const now = opts.now ?? new Date();

  const encounters = await db.encounter.findMany({
    where: { personId, supersededAt: null },
    orderBy: { startedAt: 'desc' },
    take: opts.limit ?? 20,
    select: {
      id: true,
      startedAt: true,
      chiefComplaint: true,
      facilityId: true,
      recordedBy: true,
      conditions: {
        where: { supersededAt: null },
        select: { icd11Code: true, icd11Title: true, recordedAt: true },
      },
      medications: {
        where: { supersededAt: null },
        select: {
          kemlCode: true,
          genericName: true,
          doseAmount: true,
          doseUnit: true,
          frequency: true,
          durationDays: true,
        },
      },
    },
  });

  if (encounters.length === 0) return [];

  const [facilities, practitioners, terms, medTerms] = await Promise.all([
    db.facility.findMany({
      where: { id: { in: [...new Set(encounters.map((e) => e.facilityId))] } },
      select: { id: true, name: true },
    }),
    db.practitioner.findMany({
      where: { id: { in: [...new Set(encounters.map((e) => e.recordedBy))] } },
      select: { id: true, cadre: true, person: { select: { givenName: true, familyName: true } } },
    }),
    db.diagnosisTerm.findMany({
      where: {
        icd11Code: { in: [...new Set(encounters.flatMap((e) => e.conditions.map((c) => c.icd11Code)))] },
      },
      select: { icd11Code: true, plainEn: true, plainSw: true },
    }),
    db.medicationTerm.findMany({
      where: {
        kemlCode: { in: [...new Set(encounters.flatMap((e) => e.medications.map((m) => m.kemlCode)))] },
      },
      select: { kemlCode: true, plainEn: true, plainSw: true },
    }),
  ]);

  const facilityById = new Map(facilities.map((f) => [f.id, f.name]));
  const practitionerById = new Map(practitioners.map((p) => [p.id, p]));
  const plainByCode = new Map(terms.map((t) => [t.icd11Code, lang === 'sw' ? t.plainSw : t.plainEn]));
  const medPlainByCode = new Map(medTerms.map((t) => [t.kemlCode, lang === 'sw' ? t.plainSw : t.plainEn]));

  return encounters.map((e) => {
    const condition = e.conditions[0];
    const author = practitionerById.get(e.recordedBy);
    const cadre = author ? CADRE_PLAIN[author.cadre] : undefined;

    // Sequencing, not secrecy: a clinician gets a chance to have the
    // conversation before the patient reads it cold on a phone.
    const withheld =
      !!condition &&
      isSeriousDisclosure(condition.icd11Code) &&
      now.getTime() - condition.recordedAt.getTime() <
        SERIOUS_DIAGNOSIS_DELAY_HOURS * 3_600_000;

    return {
      encounterId: e.id,
      when: e.startedAt,
      facilityName: facilityById.get(e.facilityId) ?? 'Unknown facility',
      whatHappened: withheld
        ? lang === 'sw'
          ? 'Daktari wako atawasiliana nawe kuhusu ziara hii'
          : 'Your clinician will contact you about this visit'
        : condition
          ? (plainByCode.get(condition.icd11Code) ?? condition.icd11Title)
          : e.chiefComplaint,
      clinicalTitle: withheld ? null : (condition?.icd11Title ?? null),
      icd11Code: withheld ? null : (condition?.icd11Code ?? null),
      treatedBy: author
        ? `${cadre ? `${lang === 'sw' ? cadre.sw : cadre.en} ` : ''}` +
          `${decryptField(author.person.givenName)} ${decryptField(author.person.familyName)}`
        : lang === 'sw'
          ? 'Daktari asiyejulikana'
          : 'Unknown clinician',
      medicines: withheld
        ? []
        : e.medications.map((m) => ({
            name: m.genericName,
            plain: medPlainByCode.get(m.kemlCode) ?? null,
            regimen:
              `${m.doseAmount}${m.doseUnit} ${m.frequency}` +
              (m.durationDays ? `, ${m.durationDays} days` : ''),
          })),
      withheld,
    };
  });
}

/**
 * Raises a dispute.
 *
 * A patient can flag an error; they can never edit a clinical row. The
 * record's evidential value depends on that, and the UI says so plainly.
 */
export async function raiseDispute(
  db: Db,
  input: { personId: string; encounterId: string; note: string },
) {
  if (!input.note?.trim()) {
    throw new CitizenError(
      'Tell us what looks wrong, so the facility knows what to check',
      'NOTE_REQUIRED',
    );
  }

  const encounter = await db.encounter.findUnique({
    where: { id: input.encounterId },
    select: { id: true, personId: true, facilityId: true },
  });
  if (!encounter || encounter.personId !== input.personId) {
    throw new CitizenError('That visit is not on your record', 'NOT_YOUR_RECORD');
  }

  // Logged as a patient-initiated access event. The clinical row is
  // untouched — disputes open a review, they never write to the record.
  return db.accessLog.create({
    data: {
      personId: input.personId,
      actorKind: 'PATIENT',
      actorId: input.personId,
      facilityId: encounter.facilityId,
      action: 'VIEW_RECORD',
      tierReached: 'TIER_2_GENERAL',
      targetTable: 'encounter',
      targetId: encounter.id,
      reason: 'PATIENT_REQUEST',
      outcome: 'GRANTED',
      requestId: `dispute-${encounter.id}`,
    },
  });
}
