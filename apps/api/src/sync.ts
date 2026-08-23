/**
 * Offline sync — Phase 9.
 *
 * Connectivity in Level 2 and 3 facilities is genuinely unreliable. If NHP
 * only works online, clinicians keep the paper register and enter data later
 * or not at all, and the record stops being trustworthy — which defeats the
 * entire system.
 *
 * The design that makes this safe:
 *
 *   - Envelopes carry a client-generated idempotency key, so a flaky
 *     connection replaying the queue cannot create duplicate diagnoses.
 *   - `occurredAt` is when the clinician actually did it. That is what the
 *     record shows, not when the packet arrived — otherwise a week of
 *     offline work all appears to have happened on Tuesday.
 *   - The check-in gate still applies. An envelope written outside a valid
 *     session is REJECTED, not quietly accepted because it arrived late.
 */
import { PrismaClient, type Prisma } from '@prisma/client';

export type Db = PrismaClient | Prisma.TransactionClient;

export class SyncError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'SyncError';
  }
}

/**
 * How far back a device may claim to have been offline.
 *
 * Beyond this, the write is quarantined rather than applied. A device
 * surfacing a month-late encounter is more likely a clock problem or a
 * stale queue than a genuine month of fieldwork.
 */
export const MAX_OFFLINE_DAYS = 14;

export type SyncOperation =
  | 'CREATE_ENCOUNTER'
  | 'RECORD_DIAGNOSIS'
  | 'RECORD_ALLERGY'
  | 'PRESCRIBE';

export interface EnvelopeInput {
  idempotencyKey: string;
  deviceId: string;
  practitionerId: string;
  facilityId: string;
  checkInId: string;
  operation: SyncOperation;
  payload: Prisma.InputJsonValue;
  occurredAt: Date;
}

/**
 * Accepts a queued write.
 *
 * Returns the existing envelope unchanged if the key has been seen — that
 * is the whole point of idempotency, and it must be a normal outcome rather
 * than an error, because clients replay on every reconnect.
 */
export async function acceptEnvelope(
  db: Db,
  input: EnvelopeInput,
  now: Date = new Date(),
) {
  const existing = await db.syncEnvelope.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
  });
  if (existing) return { envelope: existing, duplicate: true };

  if (input.occurredAt > now) {
    throw new SyncError(
      'This write claims to have happened in the future — check the device clock',
      'FUTURE_TIMESTAMP',
    );
  }

  const oldest = new Date(now.getTime() - MAX_OFFLINE_DAYS * 86_400_000);
  const tooOld = input.occurredAt < oldest;

  const envelope = await db.syncEnvelope.create({
    data: {
      idempotencyKey: input.idempotencyKey,
      deviceId: input.deviceId,
      practitionerId: input.practitionerId,
      facilityId: input.facilityId,
      checkInId: input.checkInId,
      operation: input.operation,
      payload: input.payload,
      occurredAt: input.occurredAt,
      receivedAt: now,
      // Quarantined, not silently dropped — a human decides.
      status: tooOld ? 'CONFLICT' : 'QUEUED',
      rejectionCode: tooOld ? 'STALE_ENVELOPE' : null,
      rejectionNote: tooOld
        ? `Occurred ${Math.round(
            (now.getTime() - input.occurredAt.getTime()) / 86_400_000,
          )} days ago, beyond the ${MAX_OFFLINE_DAYS}-day window`
        : null,
    },
  });

  return { envelope, duplicate: false };
}

/**
 * Validates an envelope against the same gate an online write faces.
 *
 * Arriving late is not a reason to relax attribution. A write outside a
 * valid session is refused whether it arrives in real time or a week later.
 */
export async function validateEnvelope(
  db: Db,
  envelopeId: string,
): Promise<{ ok: true } | { ok: false; code: string; reason: string }> {
  const envelope = await db.syncEnvelope.findUnique({ where: { id: envelopeId } });
  if (!envelope) return { ok: false, code: 'NOT_FOUND', reason: 'Envelope not found' };

  const session = await db.checkIn.findUnique({
    where: { id: envelope.checkInId },
    select: {
      practitionerId: true,
      facilityId: true,
      startedAt: true,
      endedAt: true,
      expiresAt: true,
    },
  });
  if (!session) {
    return { ok: false, code: 'NO_SESSION', reason: 'That check-in does not exist' };
  }

  if (session.practitionerId !== envelope.practitionerId) {
    return {
      ok: false,
      code: 'WRONG_PRACTITIONER',
      reason: 'The envelope claims a session belonging to someone else',
    };
  }
  if (session.facilityId !== envelope.facilityId) {
    return {
      ok: false,
      code: 'WRONG_FACILITY',
      reason: 'The envelope claims a facility the session was not at',
    };
  }

  // The work must have happened INSIDE the shift it claims.
  const sessionEnd = session.endedAt ?? session.expiresAt;
  if (envelope.occurredAt < session.startedAt || envelope.occurredAt > sessionEnd) {
    return {
      ok: false,
      code: 'OUTSIDE_SESSION',
      reason:
        `The write is timestamped outside the session it claims ` +
        `(${session.startedAt.toISOString()} to ${sessionEnd.toISOString()})`,
    };
  }

  const licence = await db.licence.findFirst({
    where: {
      practitionerId: envelope.practitionerId,
      status: 'ACTIVE',
      expiresOn: { gte: envelope.occurredAt },
    },
  });
  if (!licence) {
    return {
      ok: false,
      code: 'NO_VALID_LICENCE',
      reason: 'No licence was valid at the time of the write',
    };
  }

  return { ok: true };
}

export async function markApplied(db: Db, envelopeId: string, resultId: string) {
  return db.syncEnvelope.update({
    where: { id: envelopeId },
    data: { status: 'APPLIED', appliedAt: new Date(), resultId },
  });
}

export async function markRejected(
  db: Db,
  envelopeId: string,
  code: string,
  note: string,
) {
  return db.syncEnvelope.update({
    where: { id: envelopeId },
    data: { status: 'REJECTED', rejectionCode: code, rejectionNote: note },
  });
}

/** The queue, oldest first — offline writes are already delayed. */
export async function pendingEnvelopes(db: Db, limit = 100) {
  return db.syncEnvelope.findMany({
    where: { status: 'QUEUED' },
    orderBy: { occurredAt: 'asc' },
    take: limit,
  });
}

/** Envelopes needing a human: stale, or refused by the gate. */
export async function quarantinedEnvelopes(db: Db) {
  return db.syncEnvelope.findMany({
    where: { status: { in: ['CONFLICT', 'REJECTED'] } },
    orderBy: { receivedAt: 'desc' },
  });
}

/**
 * Sync health per device.
 *
 * A device with a growing queue and no successful applies is a facility
 * quietly falling out of the record — visible here before anyone notices
 * the data has stopped arriving.
 */
export async function deviceSyncHealth(db: Db, since: Date) {
  const rows = await db.syncEnvelope.groupBy({
    by: ['deviceId', 'status'],
    where: { receivedAt: { gte: since } },
    _count: { _all: true },
  });

  const byDevice = new Map<
    string,
    { queued: number; applied: number; rejected: number; conflict: number }
  >();

  for (const r of rows) {
    const entry = byDevice.get(r.deviceId) ?? {
      queued: 0,
      applied: 0,
      rejected: 0,
      conflict: 0,
    };
    if (r.status === 'QUEUED') entry.queued += r._count._all;
    if (r.status === 'APPLIED') entry.applied += r._count._all;
    if (r.status === 'REJECTED') entry.rejected += r._count._all;
    if (r.status === 'CONFLICT') entry.conflict += r._count._all;
    byDevice.set(r.deviceId, entry);
  }

  return [...byDevice.entries()]
    .map(([deviceId, v]) => {
      const total = v.queued + v.applied + v.rejected + v.conflict;
      return {
        deviceId,
        ...v,
        total,
        failureRatePercent:
          total > 0 ? Math.round(((v.rejected + v.conflict) / total) * 1000) / 10 : 0,
      };
    })
    .sort((a, b) => b.failureRatePercent - a.failureRatePercent);
}

// ------------------------------------------------------------ rate limits

/**
 * Patient-search rate limiting.
 *
 * From the blueprint: forty searches in an afternoon with thirty-eight
 * denials is the fraud signal. The limit makes it visible; the access log
 * makes it actionable.
 *
 * Reads the audit log rather than keeping separate counters, so the limit
 * and the evidence can never disagree.
 */
export const SEARCH_LIMIT_PER_HOUR = 60;

export async function checkSearchRateLimit(
  db: Db,
  practitionerId: string,
  now: Date = new Date(),
): Promise<{ allowed: boolean; used: number; limit: number; resetsAt: Date }> {
  const windowStart = new Date(now.getTime() - 3_600_000);

  const used = await db.accessLog.count({
    where: {
      actorId: practitionerId,
      action: 'SEARCH',
      occurredAt: { gte: windowStart },
    },
  });

  return {
    allowed: used < SEARCH_LIMIT_PER_HOUR,
    used,
    limit: SEARCH_LIMIT_PER_HOUR,
    resetsAt: new Date(windowStart.getTime() + 3_600_000),
  };
}

// ------------------------------------------------------------------- MFA

/**
 * MFA is mandatory for clinical and Ministry roles, and enforced
 * server-side. A client that "forgets" to prompt must not get access to a
 * national health record.
 */
export async function mfaRequired(
  db: Db,
  accountId: string,
): Promise<{ required: boolean; enrolled: boolean; reason: string }> {
  const account = await db.account.findUnique({
    where: { id: accountId },
    select: { practitionerId: true, ministryUserId: true, mfaMode: true },
  });
  if (!account) throw new SyncError('Account not found', 'ACCOUNT_NOT_FOUND');

  const privileged = Boolean(account.practitionerId || account.ministryUserId);
  return {
    required: privileged,
    enrolled: account.mfaMode !== 'NONE',
    reason: privileged
      ? 'Clinical and Ministry accounts reach identifiable health data'
      : 'Citizen accounts may enrol but are not required to',
  };
}

/** Accounts that can reach patient data without a second factor. */
export async function accountsMissingMfa(db: Db) {
  const accounts = await db.account.findMany({
    where: {
      status: 'ACTIVE',
      mfaMode: 'NONE',
      OR: [{ practitionerId: { not: null } }, { ministryUserId: { not: null } }],
    },
    select: { id: true, practitionerId: true, ministryUserId: true },
  });

  return accounts.map((a) => ({
    accountId: a.id,
    kind: a.practitionerId ? ('PRACTITIONER' as const) : ('MINISTRY' as const),
    subjectId: a.practitionerId ?? a.ministryUserId,
  }));
}
