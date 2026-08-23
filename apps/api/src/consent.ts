/**
 * Consent, tiered access and break-glass — Phase 5.
 *
 * Three tiers, from the blueprint:
 *
 *   TIER 1  emergency data — allergies, blood group, current medications.
 *           Always visible to any checked-in clinician. Friction here kills
 *           people.
 *   TIER 2  general clinical — visible, but every access is logged and
 *           shown to the patient.
 *   TIER 3  restricted — HIV, mental health, reproductive health, substance
 *           use, GBV. Requires consent at the point of care, or break-glass.
 *
 * The design rule that matters most: a clinician is always told that
 * restricted records EXIST, without being shown their content. Hiding their
 * existence entirely means a clinician never knows to ask the patient, which
 * is the whole clinical purpose of the tier.
 */
import { PrismaClient, type Prisma } from '@prisma/client';
import { randomInt } from 'node:crypto';
import { sendAsync, messages } from './notify.js';
import { decryptField, normalisePhone } from './crypto.js';

export type Db = PrismaClient | Prisma.TransactionClient;

export class ConsentError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'ConsentError';
  }
}

/** Break-glass is deliberately short — an emergency, not a shift. */
export const BREAK_GLASS_HOURS = 4;
/** Point-of-care consent lasts the episode, not forever. */
export const DEFAULT_CONSENT_HOURS = 24;
/** The database also caps this (consent_expiry_ck). */
export const MAX_CONSENT_DAYS = 365;

export type SensitiveCategory =
  | 'HIV'
  | 'MENTAL_HEALTH'
  | 'REPRODUCTIVE'
  | 'SUBSTANCE_USE'
  | 'GBV'
  | 'GENETIC';

/**
 * Maps a Tier 3 diagnosis to its category, so consent can be granted per
 * category rather than all-or-nothing. Someone may be willing to disclose
 * a mental health history to a psychiatrist and not their HIV status.
 */
export function categoryForCode(icd11Code: string): SensitiveCategory | null {
  if (icd11Code.startsWith('1C6')) return 'HIV';
  if (icd11Code.startsWith('6A') || icd11Code.startsWith('6B')) return 'MENTAL_HEALTH';
  if (icd11Code.startsWith('6C4')) return 'SUBSTANCE_USE';
  if (icd11Code.startsWith('JA') || icd11Code.startsWith('GA')) return 'REPRODUCTIVE';
  return null;
}

// ----------------------------------------------------------------- consent

export interface GrantConsentInput {
  personId: string;
  facilityId?: string;
  practitionerId?: string;
  scope: 'ALL_TIER_3' | 'CATEGORY' | 'SINGLE_RECORD';
  category?: SensitiveCategory;
  grantedBy: 'PATIENT' | 'GUARDIAN' | 'COURT_ORDER';
  method: 'IN_PERSON_OTP' | 'PORTAL' | 'VERBAL_ATTESTED';
  hours?: number;
}

/**
 * Grants time-boxed access to restricted records.
 *
 * `expiresAt` is mandatory and capped. A perpetual grant is functionally the
 * same as no access control, and it is exactly what accumulates silently
 * over years until the tiering means nothing.
 */
export async function grantConsent(db: Db, input: GrantConsentInput) {
  if (!input.facilityId && !input.practitionerId) {
    throw new ConsentError(
      'A consent grant must name a facility or a practitioner',
      'NO_GRANT_TARGET',
    );
  }
  if (input.scope === 'CATEGORY' && !input.category) {
    throw new ConsentError(
      'A CATEGORY grant must say which category',
      'CATEGORY_REQUIRED',
    );
  }

  const hours = input.hours ?? DEFAULT_CONSENT_HOURS;
  if (hours <= 0 || hours > MAX_CONSENT_DAYS * 24) {
    throw new ConsentError(
      `Consent must expire within ${MAX_CONSENT_DAYS} days`,
      'INVALID_CONSENT_WINDOW',
    );
  }

  const now = new Date();
  return db.consentGrant.create({
    data: {
      personId: input.personId,
      facilityId: input.facilityId ?? null,
      practitionerId: input.practitionerId ?? null,
      scope: input.scope,
      category: input.category ?? null,
      grantedBy: input.grantedBy,
      method: input.method,
      grantedAt: now,
      expiresAt: new Date(now.getTime() + hours * 3_600_000),
    },
  });
}

export async function revokeConsent(db: Db, consentId: string, personId: string) {
  const grant = await db.consentGrant.findUnique({
    where: { id: consentId },
    select: { id: true, personId: true, revokedAt: true },
  });
  if (!grant) throw new ConsentError('Consent grant not found', 'CONSENT_NOT_FOUND');

  // Only the patient may revoke their own grant.
  if (grant.personId !== personId) {
    throw new ConsentError('That grant belongs to someone else', 'NOT_YOUR_CONSENT');
  }
  if (grant.revokedAt) return grant;

  return db.consentGrant.update({
    where: { id: consentId },
    data: { revokedAt: new Date() },
  });
}

/** One-time code, sent to the patient's phone at the point of care. */
export function generateConsentOtp(): string {
  return String(randomInt(100_000, 1_000_000));
}

// ------------------------------------------------------------ access check

export interface AccessContext {
  personId: string;
  practitionerId: string;
  facilityId: string;
  checkInId: string;
}

export interface TierDecision {
  tier1: true;
  tier2: boolean;
  tier3: boolean;
  /** Which restricted categories the patient actually has records in. */
  restrictedCategoriesPresent: SensitiveCategory[];
  /** Which of those this clinician may currently open. */
  restrictedCategoriesGranted: SensitiveCategory[];
  basis: 'NONE' | 'CONSENT' | 'BREAK_GLASS';
  breakGlassId?: string;
}

/**
 * Decides what this clinician may see of this patient, right now.
 *
 * Tier 1 is unconditional. Tier 2 requires only an open check-in — the
 * database has already enforced that. Tier 3 needs consent or break-glass.
 */
export async function evaluateAccess(
  db: Db,
  ctx: AccessContext,
  now: Date = new Date(),
): Promise<TierDecision> {
  // What restricted records does this patient actually have? Computed from
  // the record itself, so the marker cannot drift out of sync.
  const restricted = await db.condition.findMany({
    where: {
      personId: ctx.personId,
      sensitivity: 'TIER_3_RESTRICTED',
      supersededAt: null,
    },
    select: { icd11Code: true },
    distinct: ['icd11Code'],
  });

  const present = [
    ...new Set(
      restricted
        .map((r) => categoryForCode(r.icd11Code))
        .filter((c): c is SensitiveCategory => c !== null),
    ),
  ];

  const grants = await db.consentGrant.findMany({
    where: {
      personId: ctx.personId,
      revokedAt: null,
      expiresAt: { gt: now },
      OR: [{ facilityId: ctx.facilityId }, { practitionerId: ctx.practitionerId }],
    },
    select: { scope: true, category: true },
  });

  const granted = new Set<SensitiveCategory>();
  for (const g of grants) {
    if (g.scope === 'ALL_TIER_3') present.forEach((c) => granted.add(c));
    else if (g.category) granted.add(g.category as SensitiveCategory);
  }

  const openGlass = await db.breakGlass.findFirst({
    where: {
      personId: ctx.personId,
      practitionerId: ctx.practitionerId,
      expiresAt: { gt: now },
    },
    select: { id: true, categories: true },
    orderBy: { openedAt: 'desc' },
  });

  if (openGlass) {
    for (const c of openGlass.categories) granted.add(c as SensitiveCategory);
  }

  return {
    tier1: true,
    tier2: true,
    tier3: granted.size > 0,
    restrictedCategoriesPresent: present,
    restrictedCategoriesGranted: [...granted],
    basis: openGlass ? 'BREAK_GLASS' : grants.length > 0 ? 'CONSENT' : 'NONE',
    breakGlassId: openGlass?.id,
  };
}

/**
 * The patient record, filtered to what this clinician may see.
 *
 * When a restricted record is withheld, the clinician is still told it
 * exists. "Restricted records exist — ask the patient" is actionable;
 * silence is not.
 */
export async function filteredRecord(db: Db, ctx: AccessContext, now: Date = new Date()) {
  const decision = await evaluateAccess(db, ctx, now);

  // Tier 1 — never gated, never hidden by consent rules.
  const allergies = await db.allergy.findMany({
    where: { personId: ctx.personId, supersededAt: null },
    orderBy: { severity: 'desc' },
    select: { substanceLabel: true, reaction: true, severity: true, allergyClass: true },
  });

  const visibleTiers: Array<'TIER_1_EMERGENCY' | 'TIER_2_GENERAL' | 'TIER_3_RESTRICTED'> = [
    'TIER_1_EMERGENCY',
    'TIER_2_GENERAL',
  ];
  if (decision.tier3) visibleTiers.push('TIER_3_RESTRICTED');

  const conditions = await db.condition.findMany({
    where: {
      personId: ctx.personId,
      supersededAt: null,
      sensitivity: { in: visibleTiers },
    },
    select: {
      icd11Code: true,
      icd11Title: true,
      clinicalStatus: true,
      sensitivity: true,
      recordedAt: true,
      isChronic: true,
    },
    orderBy: { recordedAt: 'desc' },
  });

  // If Tier 3 is granted, drop categories not covered by the grant.
  const filtered = decision.tier3
    ? conditions.filter((c) => {
        if (c.sensitivity !== 'TIER_3_RESTRICTED') return true;
        const cat = categoryForCode(c.icd11Code);
        return cat === null || decision.restrictedCategoriesGranted.includes(cat);
      })
    : conditions;

  const withheld = decision.restrictedCategoriesPresent.filter(
    (c) => !decision.restrictedCategoriesGranted.includes(c),
  );

  return {
    allergies,
    conditions: filtered,
    access: decision,
    // The clinician knows to ask, without seeing the content.
    restrictedRecordsExist: withheld.length > 0,
    withheldCategories: withheld,
  };
}

// ------------------------------------------------------------- break-glass

export interface BreakGlassInput {
  personId: string;
  practitionerId: string;
  checkInId: string;
  facilityId: string;
  reasonCode:
    | 'UNCONSCIOUS'
    | 'LIFE_THREATENING'
    | 'PATIENT_UNABLE'
    | 'GUARDIAN_UNREACHABLE'
    | 'MASS_CASUALTY';
  justification: string;
  categories: SensitiveCategory[];
}

const MIN_JUSTIFICATION = 20;

/**
 * Emergency override.
 *
 * Access is granted IMMEDIATELY — an unconscious patient cannot consent, and
 * a clinician must never wait for approval in an emergency. What makes it
 * expensive is everything that happens afterwards: the patient is notified,
 * an auditor reviews it, and the facility's rate is visible on its dashboard.
 *
 * The notification is queued, not awaited. If the SMS gateway is down a
 * clinician must still be able to treat someone.
 */
export async function breakGlass(db: Db, input: BreakGlassInput, now: Date = new Date()) {
  if (!input.justification || input.justification.trim().length < MIN_JUSTIFICATION) {
    throw new ConsentError(
      `Break-glass requires a written justification of at least ` +
        `${MIN_JUSTIFICATION} characters. It is reviewed by the Ministry.`,
      'JUSTIFICATION_TOO_SHORT',
    );
  }
  if (input.categories.length === 0) {
    throw new ConsentError(
      'Say which restricted categories you need. Opening everything by ' +
        'default is what makes break-glass routine.',
      'NO_CATEGORIES',
    );
  }

  const session = await db.checkIn.findUnique({
    where: { id: input.checkInId },
    select: { id: true, practitionerId: true, endedAt: true, expiresAt: true },
  });
  if (!session || session.practitionerId !== input.practitionerId) {
    throw new ConsentError('No valid session for this practitioner', 'NO_SESSION');
  }
  if (session.endedAt || session.expiresAt <= now) {
    throw new ConsentError('Your session has closed. Check in again.', 'SESSION_CLOSED');
  }

  // A practitioner opening their own record is the insider-abuse pattern
  // break-glass would otherwise make trivial.
  const self = await db.practitioner.findUnique({
    where: { id: input.practitionerId },
    select: { personId: true },
  });
  if (self?.personId === input.personId) {
    throw new ConsentError(
      'You cannot use emergency access on your own record.',
      'SELF_ACCESS_REFUSED',
    );
  }

  const event = await db.breakGlass.create({
    data: {
      personId: input.personId,
      practitionerId: input.practitionerId,
      checkInId: input.checkInId,
      facilityId: input.facilityId,
      reasonCode: input.reasonCode,
      justification: input.justification.trim(),
      categories: input.categories,
      openedAt: now,
      expiresAt: new Date(now.getTime() + BREAK_GLASS_HOURS * 3_600_000),
      reviewStatus: 'PENDING',
    },
  });

  await db.accessLog.create({
    data: {
      personId: input.personId,
      actorKind: 'PRACTITIONER',
      actorId: input.practitionerId,
      checkInId: input.checkInId,
      facilityId: input.facilityId,
      action: 'BREAK_GLASS',
      tierReached: 'TIER_3_RESTRICTED',
      reason: 'EMERGENCY',
      outcome: 'GRANTED',
      requestId: `bg-${event.id}`,
    },
  });

  // Tell the patient. Queued, never awaited: access was already granted
  // above, and a clinician must not wait on a gateway to treat someone
  // unconscious. An unsent notification is caught by unnotifiedBreakGlass().
  const [account, facility] = await Promise.all([
    db.account.findFirst({
      where: { personId: input.personId },
      select: { phone: true },
    }),
    db.facility.findUnique({
      where: { id: input.facilityId },
      select: { name: true },
    }),
  ]);

  if (account?.phone && facility) {
    sendAsync({
      to: normalisePhone(decryptField(account.phone)),
      // Names the facility and time so the patient can query it — but
      // nothing about what was seen or why they were there.
      body: messages.breakGlass(facility.name, now),
      purpose: 'BREAK_GLASS',
    });
  }

  return event;
}

/**
 * Marks the patient notified. Called by the SMS worker, not inline.
 *
 * break_glass is append-only, so this goes through the same kind of
 * SECURITY DEFINER function as review — the app role holds no UPDATE on
 * the evidence itself.
 */
export async function markPatientNotified(
  db: PrismaClient,
  breakGlassId: string,
  channel: 'SMS' | 'IN_APP' | 'POSTAL',
) {
  await db.$executeRawUnsafe(
    `SELECT nhp_mark_break_glass_notified($1::text, $2::text)`,
    breakGlassId,
    channel,
  );
  return db.breakGlass.findUnique({ where: { id: breakGlassId } });
}

/**
 * Break-glass events where the patient was never told.
 *
 * Someone got emergency access to restricted records and the person it
 * belongs to does not know. That is itself an alertable condition, not just
 * a missing field.
 */
export async function unnotifiedBreakGlass(db: Db, olderThanMinutes = 30, now = new Date()) {
  return db.breakGlass.findMany({
    where: {
      patientNotifiedAt: null,
      openedAt: { lte: new Date(now.getTime() - olderThanMinutes * 60_000) },
    },
    select: {
      id: true,
      personId: true,
      facilityId: true,
      openedAt: true,
      reasonCode: true,
    },
    orderBy: { openedAt: 'asc' },
  });
}

export async function reviewBreakGlass(
  db: PrismaClient,
  input: {
    breakGlassId: string;
    ministryUserId: string;
    outcome: 'REVIEWED_OK' | 'FLAGGED' | 'ESCALATED';
    note?: string;
  },
) {
  // break_glass is append-only for the app role; review goes through the
  // one SECURITY DEFINER function that may touch it.
  await db.$executeRawUnsafe(
    `SELECT nhp_review_break_glass($1::text, $2::text, $3::text, $4::text)`,
    input.breakGlassId,
    input.outcome,
    input.ministryUserId,
    input.note ?? null,
  );
  return db.breakGlass.findUnique({ where: { id: input.breakGlassId } });
}

/** The auditor's queue. Oldest first — these age badly. */
export async function pendingBreakGlassReviews(db: Db, limit = 50) {
  return db.breakGlass.findMany({
    where: { reviewStatus: 'PENDING' },
    orderBy: { openedAt: 'asc' },
    take: limit,
  });
}

/**
 * Break-glass rate per facility.
 *
 * An outlier facility becomes visible without anyone going looking, which is
 * the point — the alternative is discovering a pattern years later.
 */
export async function breakGlassRateByFacility(db: Db, since: Date) {
  const events = await db.breakGlass.groupBy({
    by: ['facilityId'],
    where: { openedAt: { gte: since } },
    _count: { _all: true },
  });

  const encounters = await db.encounter.groupBy({
    by: ['facilityId'],
    where: { recordedAt: { gte: since } },
    _count: { _all: true },
  });

  const encounterByFacility = new Map(encounters.map((e) => [e.facilityId, e._count._all]));

  return events
    .map((e) => {
      const total = encounterByFacility.get(e.facilityId) ?? 0;
      return {
        facilityId: e.facilityId,
        breakGlassCount: e._count._all,
        encounterCount: total,
        ratePercent: total > 0 ? Math.round((e._count._all / total) * 1000) / 10 : null,
      };
    })
    .sort((a, b) => (b.ratePercent ?? 0) - (a.ratePercent ?? 0));
}

// -------------------------------------------------- patient transparency

/**
 * "Who has seen my record."
 *
 * Reasons are rendered in plain language, not enum codes — the enum is for
 * the auditor, the citizen gets a sentence.
 */
const REASON_TEXT: Record<string, string> = {
  ACTIVE_CONSULTATION: 'while treating you',
  FOLLOW_UP: 'for a follow-up',
  EMERGENCY: 'in an emergency',
  REFERRAL_REVIEW: 'reviewing a referral',
  ADMIN: 'for administration',
  PATIENT_REQUEST: 'at your request',
};

export async function accessHistory(
  db: Db,
  personId: string,
  opts: { limit?: number; before?: Date } = {},
) {
  const rows = await db.accessLog.findMany({
    where: {
      personId,
      ...(opts.before ? { occurredAt: { lt: opts.before } } : {}),
    },
    orderBy: { occurredAt: 'desc' },
    take: opts.limit ?? 50,
  });

  return rows.map((r) => ({
    occurredAt: r.occurredAt,
    facilityId: r.facilityId,
    actorId: r.actorId,
    actorKind: r.actorKind,
    action: r.action,
    isEmergencyAccess: r.action === 'BREAK_GLASS',
    reasonPlain: REASON_TEXT[r.reason] ?? 'for care',
    outcome: r.outcome,
  }));
}

/** Records a record view. Every clinical read produces one of these. */
export async function logAccess(
  db: Db,
  input: {
    personId: string;
    practitionerId: string;
    checkInId?: string;
    facilityId?: string;
    action: 'SEARCH' | 'VIEW_SUMMARY' | 'VIEW_RECORD' | 'WRITE' | 'EXPORT' | 'PRINT';
    tierReached: 'TIER_1_EMERGENCY' | 'TIER_2_GENERAL' | 'TIER_3_RESTRICTED';
    reason:
      | 'ACTIVE_CONSULTATION'
      | 'FOLLOW_UP'
      | 'EMERGENCY'
      | 'REFERRAL_REVIEW'
      | 'ADMIN'
      | 'PATIENT_REQUEST';
    outcome:
      | 'GRANTED'
      | 'DENIED_NO_CONSENT'
      | 'DENIED_NO_CHECKIN'
      | 'DENIED_LICENCE'
      | 'DENIED_RATE_LIMIT';
    requestId: string;
    targetTable?: string;
    targetId?: string;
  },
) {
  return db.accessLog.create({
    data: {
      personId: input.personId,
      actorKind: 'PRACTITIONER',
      actorId: input.practitionerId,
      checkInId: input.checkInId ?? null,
      facilityId: input.facilityId ?? null,
      action: input.action,
      tierReached: input.tierReached,
      targetTable: input.targetTable ?? null,
      targetId: input.targetId ?? null,
      reason: input.reason,
      outcome: input.outcome,
      requestId: input.requestId,
    },
  });
}

/**
 * Denial-rate anomaly detection.
 *
 * A clinician who searches forty IDs in an afternoon and is denied on
 * thirty-eight is a far stronger fraud signal than anyone who was granted
 * access. Most systems log only success and are blind to exactly this.
 */
export async function denialAnomalies(
  db: Db,
  since: Date,
  minAttempts = 10,
  denialThreshold = 0.5,
) {
  const rows = await db.accessLog.groupBy({
    by: ['actorId', 'outcome'],
    where: { occurredAt: { gte: since } },
    _count: { _all: true },
  });

  const byActor = new Map<string, { total: number; denied: number }>();
  for (const r of rows) {
    const entry = byActor.get(r.actorId) ?? { total: 0, denied: 0 };
    entry.total += r._count._all;
    if (r.outcome !== 'GRANTED') entry.denied += r._count._all;
    byActor.set(r.actorId, entry);
  }

  return [...byActor.entries()]
    .filter(([, v]) => v.total >= minAttempts && v.denied / v.total >= denialThreshold)
    .map(([actorId, v]) => ({
      actorId,
      attempts: v.total,
      denied: v.denied,
      denialRate: Math.round((v.denied / v.total) * 1000) / 10,
    }))
    .sort((a, b) => b.denialRate - a.denialRate);
}
