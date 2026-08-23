/**
 * Referrals — Phase 8.
 *
 * Kenyan care escalates by referral: a dispensary sends upward to a health
 * centre, a health centre to a county referral. NHP's contribution is not
 * the sending — a paper letter does that — but the LOOP: proving the patient
 * arrived, and returning the outcome to the clinician who referred them.
 *
 * The counter-referral is the part every system forgets, and the part every
 * clinician complains about. Referral loop closure is also the metric that
 * does not currently exist at national scale in Kenya, which is why it is
 * the strongest number in the Ministry pitch.
 */
import { PrismaClient, type Prisma } from '@prisma/client';
import { canWriteClinical } from './practitioner.js';
import { findFacilities, type FacilityMatch } from './facility.js';

export type Db = PrismaClient | Prisma.TransactionClient;

export class ReferralError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'ReferralError';
  }
}

export type Urgency = 'EMERGENCY' | 'URGENT_24H' | 'SOON_7D' | 'ROUTINE';

/**
 * How long a referral stays open before it lapses.
 *
 * An emergency referral that is still "issued" a week later is not pending —
 * it failed, and pretending otherwise hides the failure in the statistics.
 */
export const VALIDITY_DAYS: Record<Urgency, number> = {
  EMERGENCY: 1,
  URGENT_24H: 3,
  SOON_7D: 14,
  ROUTINE: 90,
};

export interface IssueReferralInput {
  practitionerId: string;
  personId: string;
  fromEncounterId: string;
  /** Omit for an open referral — any facility with the capabilities. */
  toFacilityId?: string;
  toSpecialty?: string;
  urgency: Urgency;
  reason: string;
  requiredCapabilities: string[];
}

/**
 * Issues a referral.
 *
 * Deliberately checks that the destination can actually do what is being
 * asked. Referring someone to a facility that cannot treat them is the exact
 * time-wasting the whole system exists to prevent.
 */
export async function issueReferral(db: Db, input: IssueReferralInput) {
  const gate = await canWriteClinical(db, input.practitionerId);
  if (!gate.allowed) throw new ReferralError(gate.reason, gate.code);

  if (!input.reason?.trim()) {
    throw new ReferralError(
      'A referral needs a reason — the receiving clinician reads it first',
      'REASON_REQUIRED',
    );
  }

  const encounter = await db.encounter.findUnique({
    where: { id: input.fromEncounterId },
    select: { id: true, personId: true, facilityId: true },
  });
  if (!encounter) throw new ReferralError('Encounter not found', 'ENCOUNTER_NOT_FOUND');
  if (encounter.personId !== input.personId) {
    throw new ReferralError(
      'That encounter belongs to a different patient',
      'PATIENT_MISMATCH',
    );
  }

  if (input.toFacilityId) {
    if (input.toFacilityId === gate.facilityId) {
      throw new ReferralError(
        'Cannot refer a patient to the facility they are already in',
        'SELF_REFERRAL',
      );
    }

    const destination = await db.facility.findUnique({
      where: { id: input.toFacilityId },
      select: {
        id: true,
        name: true,
        registrationStatus: true,
        capabilities: {
          where: { status: { not: 'SUSPENDED' } },
          select: { capability: { select: { code: true } } },
        },
      },
    });
    if (!destination) {
      throw new ReferralError('Destination facility not found', 'FACILITY_NOT_FOUND');
    }
    if (destination.registrationStatus !== 'ACTIVE') {
      throw new ReferralError(
        `${destination.name} is ${destination.registrationStatus}, not ACTIVE`,
        'FACILITY_NOT_ACTIVE',
      );
    }

    const has = new Set(destination.capabilities.map((c) => c.capability.code));
    const missing = input.requiredCapabilities.filter((c) => !has.has(c));
    if (missing.length > 0) {
      throw new ReferralError(
        `${destination.name} does not offer: ${missing.join(', ')}. ` +
          'Referring there would send the patient on a wasted journey.',
        'DESTINATION_LACKS_CAPABILITY',
      );
    }
  }

  const now = new Date();
  const referral = await db.referral.create({
    data: {
      personId: input.personId,
      fromFacilityId: gate.facilityId,
      fromEncounterId: encounter.id,
      referredBy: input.practitionerId,
      toFacilityId: input.toFacilityId ?? null,
      toSpecialty: input.toSpecialty ?? null,
      urgency: input.urgency,
      reason: input.reason.trim(),
      requiredCapabilities: input.requiredCapabilities,
      status: 'ISSUED',
      issuedAt: now,
      expiresAt: new Date(now.getTime() + VALIDITY_DAYS[input.urgency] * 86_400_000),
    },
  });

  // Record the disposition on the originating encounter, so a facility's
  // referral rate is derivable without joining every time.
  await db.$executeRawUnsafe(
    `SELECT nhp_set_encounter_disposition($1::text, $2::text, $3::text)`,
    encounter.id,
    'REFERRED',
    referral.id,
  );

  return referral;
}

/** Suggests destinations for an open referral. */
export async function suggestDestinations(
  db: Db,
  input: {
    requiredCapabilities: string[];
    countyId?: string;
    near?: { latitude: number; longitude: number };
    excludeFacilityId?: string;
    limit?: number;
  },
): Promise<FacilityMatch[]> {
  const matches = await findFacilities(db, {
    requiredCapabilities: input.requiredCapabilities,
    countyId: input.countyId,
    near: input.near,
    limit: (input.limit ?? 5) + 1,
  });
  return matches
    .filter((m) => m.id !== input.excludeFacilityId)
    .slice(0, input.limit ?? 5);
}

export async function respondToReferral(
  db: Db,
  input: {
    referralId: string;
    practitionerId: string;
    accept: boolean;
    declineReason?: string;
  },
) {
  const gate = await canWriteClinical(db, input.practitionerId);
  if (!gate.allowed) throw new ReferralError(gate.reason, gate.code);

  const referral = await db.referral.findUnique({
    where: { id: input.referralId },
    select: { id: true, status: true, toFacilityId: true, expiresAt: true },
  });
  if (!referral) throw new ReferralError('Referral not found', 'REFERRAL_NOT_FOUND');

  if (referral.status !== 'ISSUED') {
    throw new ReferralError(
      `This referral is already ${referral.status}`,
      'ALREADY_RESPONDED',
    );
  }
  if (referral.expiresAt <= new Date()) {
    throw new ReferralError('This referral has expired', 'REFERRAL_EXPIRED');
  }

  // A directed referral is answered by its destination. An open one may be
  // picked up by any facility that can meet it.
  if (referral.toFacilityId && referral.toFacilityId !== gate.facilityId) {
    throw new ReferralError(
      'This referral was directed to a different facility',
      'WRONG_FACILITY',
    );
  }

  if (!input.accept && !input.declineReason?.trim()) {
    throw new ReferralError(
      'Declining a referral requires a reason — the referring clinician ' +
        'needs to know where else to send the patient',
      'DECLINE_REASON_REQUIRED',
    );
  }

  return db.referral.update({
    where: { id: referral.id },
    data: {
      status: input.accept ? 'ACCEPTED' : 'DECLINED',
      // An open referral becomes directed once someone accepts it.
      toFacilityId: referral.toFacilityId ?? gate.facilityId,
      respondedAt: new Date(),
      respondedBy: input.practitionerId,
      declineReason: input.accept ? null : input.declineReason!.trim(),
    },
  });
}

/**
 * The patient presented. This is the step that proves a referral was more
 * than a piece of paper.
 */
export async function recordArrival(
  db: Db,
  input: { referralId: string; practitionerId: string; arrivalEncounterId: string },
) {
  const gate = await canWriteClinical(db, input.practitionerId);
  if (!gate.allowed) throw new ReferralError(gate.reason, gate.code);

  const referral = await db.referral.findUnique({
    where: { id: input.referralId },
    select: { id: true, status: true, personId: true, toFacilityId: true },
  });
  if (!referral) throw new ReferralError('Referral not found', 'REFERRAL_NOT_FOUND');

  if (referral.status === 'DECLINED' || referral.status === 'CANCELLED') {
    throw new ReferralError(
      `Cannot record arrival on a ${referral.status} referral`,
      'INVALID_STATE',
    );
  }
  if (referral.status === 'ARRIVED' || referral.status === 'COMPLETED') {
    throw new ReferralError('Arrival already recorded', 'ALREADY_ARRIVED');
  }

  const encounter = await db.encounter.findUnique({
    where: { id: input.arrivalEncounterId },
    select: { id: true, personId: true, facilityId: true },
  });
  if (!encounter) throw new ReferralError('Encounter not found', 'ENCOUNTER_NOT_FOUND');
  if (encounter.personId !== referral.personId) {
    throw new ReferralError(
      'That encounter belongs to a different patient',
      'PATIENT_MISMATCH',
    );
  }

  return db.referral.update({
    where: { id: referral.id },
    data: {
      status: 'ARRIVED',
      arrivedAt: new Date(),
      arrivalEncounterId: encounter.id,
      toFacilityId: referral.toFacilityId ?? encounter.facilityId,
    },
  });
}

/**
 * Closes the loop.
 *
 * The referring clinician finds out what happened to their patient. Almost
 * every system forgets this, and it is the single thing clinicians complain
 * about most in referral workflows.
 */
export async function returnCounterReferral(
  db: Db,
  input: {
    referralId: string;
    practitionerId: string;
    summary: string;
    outcomeCode?: string;
    followUpPlan?: string;
  },
) {
  const gate = await canWriteClinical(db, input.practitionerId);
  if (!gate.allowed) throw new ReferralError(gate.reason, gate.code);

  if (!input.summary?.trim()) {
    throw new ReferralError(
      'A counter-referral needs a summary — an empty one closes the loop ' +
        'on paper without telling the referring clinician anything',
      'SUMMARY_REQUIRED',
    );
  }

  const referral = await db.referral.findUnique({
    where: { id: input.referralId },
    select: { id: true, status: true, counterReferral: { select: { id: true } } },
  });
  if (!referral) throw new ReferralError('Referral not found', 'REFERRAL_NOT_FOUND');
  if (referral.counterReferral) {
    throw new ReferralError('The loop is already closed', 'ALREADY_CLOSED');
  }
  if (referral.status !== 'ARRIVED') {
    throw new ReferralError(
      `Cannot close a referral that is ${referral.status} — the patient must ` +
        'have arrived first',
      'PATIENT_NOT_ARRIVED',
    );
  }

  if (input.outcomeCode) {
    const term = await db.diagnosisTerm.findUnique({
      where: { icd11Code: input.outcomeCode },
      select: { icd11Code: true },
    });
    if (!term) {
      throw new ReferralError(
        `'${input.outcomeCode}' is not a known diagnosis code`,
        'UNKNOWN_DIAGNOSIS',
      );
    }
  }

  const counter = await db.counterReferral.create({
    data: {
      referralId: referral.id,
      summary: input.summary.trim(),
      outcomeCode: input.outcomeCode ?? null,
      followUpPlan: input.followUpPlan ?? null,
      returnedBy: input.practitionerId,
      facilityId: gate.facilityId,
      licenceNumber: gate.licenceNumber,
    },
  });

  await db.referral.update({
    where: { id: referral.id },
    data: { status: 'COMPLETED' },
  });

  return counter;
}

export async function cancelReferral(
  db: Db,
  input: { referralId: string; practitionerId: string; reason: string },
) {
  const referral = await db.referral.findUnique({
    where: { id: input.referralId },
    select: { id: true, status: true, referredBy: true },
  });
  if (!referral) throw new ReferralError('Referral not found', 'REFERRAL_NOT_FOUND');
  if (referral.referredBy !== input.practitionerId) {
    throw new ReferralError(
      'Only the referring clinician may cancel a referral',
      'NOT_REFERRER',
    );
  }
  if (referral.status === 'COMPLETED') {
    throw new ReferralError('Cannot cancel a completed referral', 'ALREADY_COMPLETED');
  }

  return db.referral.update({
    where: { id: referral.id },
    data: { status: 'CANCELLED', cancelledReason: input.reason },
  });
}

/** Lapses referrals nobody acted on. Run nightly. */
export async function expireStaleReferrals(db: Db, now: Date = new Date()) {
  const result = await db.referral.updateMany({
    where: { status: { in: ['ISSUED', 'ACCEPTED'] }, expiresAt: { lte: now } },
    data: { status: 'EXPIRED' },
  });
  return { expired: result.count };
}

/** A facility's inbound queue, most urgent and oldest first. */
export async function inboundQueue(db: Db, facilityId: string) {
  const now = new Date();
  const referrals = await db.referral.findMany({
    where: {
      status: { in: ['ISSUED', 'ACCEPTED'] },
      expiresAt: { gt: now },
      OR: [{ toFacilityId: facilityId }, { toFacilityId: null }],
    },
    orderBy: [{ urgency: 'asc' }, { issuedAt: 'asc' }],
  });

  const order: Urgency[] = ['EMERGENCY', 'URGENT_24H', 'SOON_7D', 'ROUTINE'];
  return referrals.sort(
    (a, b) =>
      order.indexOf(a.urgency as Urgency) - order.indexOf(b.urgency as Urgency) ||
      a.issuedAt.getTime() - b.issuedAt.getTime(),
  );
}

/** Referrals a clinician issued that have not come back. */
export async function openLoops(db: Db, practitionerId: string) {
  return db.referral.findMany({
    where: {
      referredBy: practitionerId,
      status: { in: ['ISSUED', 'ACCEPTED', 'ARRIVED'] },
    },
    orderBy: { issuedAt: 'asc' },
  });
}

// ------------------------------------------------------------- the metric

export interface ClosureFunnel {
  issued: number;
  accepted: number;
  declined: number;
  arrived: number;
  completed: number;
  expired: number;
  cancelled: number;
  arrivalRatePercent: number;
  closureRatePercent: number;
}

/**
 * Referral loop closure.
 *
 * The number that does not currently exist at national scale in Kenya,
 * because producing it requires linking a referral issued at one facility to
 * an arrival at another and an outcome returned to the first. Aggregate
 * reporting cannot do that; a longitudinal record can.
 *
 * Reported as a funnel, not a single figure — "23% closure" hides whether
 * patients never arrived or arrived and were never reported on, which are
 * completely different problems with different fixes.
 */
export async function closureFunnel(
  db: Db,
  opts: { from: Date; to: Date; facilityId?: string; countyId?: string },
): Promise<ClosureFunnel> {
  const where = {
    issuedAt: { gte: opts.from, lt: opts.to },
    ...(opts.facilityId ? { fromFacilityId: opts.facilityId } : {}),
  };

  const rows = await db.referral.groupBy({
    by: ['status'],
    where,
    _count: { _all: true },
  });

  const count = (s: string) => rows.find((r) => r.status === s)?._count._all ?? 0;

  const issued = rows.reduce((sum, r) => sum + r._count._all, 0);
  const declined = count('DECLINED');
  const expired = count('EXPIRED');
  const cancelled = count('CANCELLED');
  const arrivedNow = count('ARRIVED');
  const completed = count('COMPLETED');

  // Cumulative: a completed referral also arrived, and was also accepted.
  const arrived = arrivedNow + completed;
  const accepted = count('ACCEPTED') + arrived;

  return {
    issued,
    accepted,
    declined,
    arrived,
    completed,
    expired,
    cancelled,
    arrivalRatePercent: issued > 0 ? Math.round((arrived / issued) * 1000) / 10 : 0,
    closureRatePercent: issued > 0 ? Math.round((completed / issued) * 1000) / 10 : 0,
  };
}

/** Closure by facility — which facilities never report back. */
export async function closureByFacility(db: Db, opts: { from: Date; to: Date }) {
  const referrals = await db.referral.findMany({
    where: { issuedAt: { gte: opts.from, lt: opts.to } },
    select: { fromFacilityId: true, toFacilityId: true, status: true },
  });

  const byReceiver = new Map<string, { received: number; closed: number }>();
  for (const r of referrals) {
    if (!r.toFacilityId) continue;
    const entry = byReceiver.get(r.toFacilityId) ?? { received: 0, closed: 0 };
    entry.received += 1;
    if (r.status === 'COMPLETED') entry.closed += 1;
    byReceiver.set(r.toFacilityId, entry);
  }

  return [...byReceiver.entries()]
    .map(([facilityId, v]) => ({
      facilityId,
      received: v.received,
      closed: v.closed,
      closureRatePercent: Math.round((v.closed / v.received) * 1000) / 10,
    }))
    .sort((a, b) => a.closureRatePercent - b.closureRatePercent);
}

/**
 * Emergency referrals where the patient never arrived.
 *
 * The most serious failure the system can surface. Someone was sent
 * urgently and there is no record they got there.
 */
export async function emergencyNonArrivals(db: Db, opts: { from: Date; to: Date }) {
  return db.referral.findMany({
    where: {
      urgency: 'EMERGENCY',
      issuedAt: { gte: opts.from, lt: opts.to },
      status: { in: ['ISSUED', 'ACCEPTED', 'EXPIRED'] },
    },
    select: {
      id: true,
      personId: true,
      fromFacilityId: true,
      toFacilityId: true,
      issuedAt: true,
      status: true,
      reason: true,
    },
    orderBy: { issuedAt: 'asc' },
  });
}
