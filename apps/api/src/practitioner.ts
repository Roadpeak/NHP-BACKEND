/**
 * Practitioners, affiliation and check-in — Phase 3.
 *
 * The three-layer model from the blueprint:
 *
 *   affiliation  a durable clinician↔facility link, granted by the facility
 *                (private) or the Ministry (public). NEVER self-declared.
 *   check-in     a time-bounded shift. Everything written during it is
 *                stamped with the session.
 *   access       each patient record opened, logged with a stated reason.
 *
 * The database already refuses a clinical write outside an open session
 * (Phase 0). This layer is what makes those refusals rare — it fails early,
 * with an explanation a human can act on.
 */
import { PrismaClient, type Prisma } from '@prisma/client';
import {
  REGULATOR_FOR_CADRE,
  REGULATOR_NAMES,
  defaultRegistry,
  type Cadre,
  type Regulator,
  type VerificationRegistry,
} from './verification.js';
import { decryptField } from './crypto.js';

export type Db = PrismaClient | Prisma.TransactionClient;

export class PractitionerError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'PractitionerError';
  }
}

/** A shift, not a login. Long enough for a night duty, short enough that a
 *  forgotten check-in does not stay open for days. */
export const SESSION_HOURS = 16;
/** Warn the clinician before their session lapses mid-encounter. */
export const EXPIRY_WARNING_MINUTES = 15;
/**
 * Absolute ceiling on a session, counted from check-in. Matches the
 * `checkin_window_ck` constraint applied in Phase 0 — extensions may top a
 * session up, but never past this.
 */
export const MAX_SESSION_HOURS = 24;

// ------------------------------------------------------------ registration

export interface RegisterPractitionerInput {
  personId: string;
  cadre: Cadre;
  countyId: string;
  subcountyId: string;
  licenceNumber?: string;
  regulator?: Regulator;
  issuedOn?: Date;
  expiresOn?: Date;
  scope?: string;
  familyName?: string;
}

/**
 * A clinician creates their own account — correct, as specified. What they
 * cannot do is declare where they work; that requires a facility or the
 * Ministry to grant it.
 *
 * Status starts PENDING and only becomes ACTIVE when a licence verifies.
 */
export async function registerPractitioner(
  db: Db,
  input: RegisterPractitionerInput,
  registry: VerificationRegistry = defaultRegistry(),
) {
  const person = await db.person.findUnique({
    where: { id: input.personId },
    select: { id: true, maturity: true },
  });
  if (!person) throw new PractitionerError('Person not found', 'PERSON_NOT_FOUND');
  if (person.maturity !== 'ADULT') {
    throw new PractitionerError(
      'A practitioner account requires an adult identity',
      'NOT_ADULT',
    );
  }

  const existing = await db.practitioner.findUnique({
    where: { personId: input.personId },
    select: { id: true },
  });
  if (existing) {
    throw new PractitionerError(
      'This person already holds a practitioner account',
      'ALREADY_REGISTERED',
    );
  }

  const expectedRegulator = REGULATOR_FOR_CADRE[input.cadre];

  // Cadres with a statutory register must supply a licence. Psychologists
  // and community health workers have none, and pretending otherwise would
  // lock out staff who legitimately practise.
  if (expectedRegulator && !input.licenceNumber) {
    throw new PractitionerError(
      `A ${input.cadre} must supply a ${expectedRegulator} registration number`,
      'LICENCE_REQUIRED',
    );
  }

  if (input.licenceNumber && input.regulator && expectedRegulator) {
    if (input.regulator !== expectedRegulator) {
      throw new PractitionerError(
        `A ${input.cadre} registers with ${expectedRegulator} ` +
          `(${REGULATOR_NAMES[expectedRegulator]}), not ${input.regulator}`,
        'WRONG_REGULATOR',
      );
    }
  }

  /*
   * PENDING until something vouches for them.
   *
   * For a licensed cadre that something is the regulator, checked below.
   * For a cadre with no statutory register — reception, community health
   * workers, psychologists — there is no register to check, so waiting for
   * one means waiting forever: they were created PENDING and had no path to
   * ACTIVE at all, which left a facility unable to employ the reception
   * staff the queue was built for.
   *
   * They are activated here instead, and the safety argument is unchanged:
   * activation is not permission. Every clinical write independently
   * demands a licence that was valid at that moment, so an unlicensed
   * practitioner who is ACTIVE can hold an affiliation, appear on a roster
   * and work a reception desk, and still cannot write a single clinical
   * row. The licence gate, not the status field, is what protects the
   * record.
   */
  const unregistered = !expectedRegulator;

  const practitioner = await db.practitioner.create({
    data: {
      personId: input.personId,
      cadre: input.cadre,
      countyId: input.countyId,
      subcountyId: input.subcountyId,
      status: unregistered ? 'ACTIVE' : 'PENDING',
    },
  });

  if (!input.licenceNumber || !expectedRegulator) {
    return { practitioner, licence: null, verification: null };
  }

  const regulator = input.regulator ?? expectedRegulator;

  const clash = await db.licence.findUnique({
    where: { regulator_licenceNumber: { regulator, licenceNumber: input.licenceNumber } },
    select: { practitionerId: true },
  });
  if (clash) {
    throw new PractitionerError(
      `Licence ${input.licenceNumber} is already registered to another practitioner`,
      'LICENCE_TAKEN',
    );
  }

  const verification = await registry.verify({
    regulator,
    licenceNumber: input.licenceNumber,
    familyName: input.familyName,
  });

  const licenceStatus =
    verification.outcome === 'VERIFIED'
      ? 'ACTIVE'
      : verification.outcome === 'EXPIRED'
        ? 'EXPIRED'
        : verification.outcome === 'SUSPENDED' || verification.outcome === 'STRUCK_OFF'
          ? 'SUSPENDED'
          : 'PENDING';

  const licence = await db.licence.create({
    data: {
      practitionerId: practitioner.id,
      regulator,
      licenceNumber: input.licenceNumber,
      issuedOn: input.issuedOn ?? new Date(),
      expiresOn:
        verification.expiresOn ??
        input.expiresOn ??
        new Date(Date.UTC(new Date().getUTCFullYear() + 1, 11, 31)),
      scope: input.scope ?? null,
      verifiedAt: verification.outcome === 'VERIFIED' ? new Date() : null,
      verifiedVia: verification.source,
      status: licenceStatus,
    },
  });

  // Only a verified licence activates the account. Everything else waits.
  const updated =
    licenceStatus === 'ACTIVE'
      ? await db.practitioner.update({
          where: { id: practitioner.id },
          data: { status: 'ACTIVE' },
        })
      : practitioner;

  return { practitioner: updated, licence, verification };
}

/** Returns licences that are valid right now, cheapest check first. */
export async function activeLicences(db: Db, practitionerId: string, at: Date = new Date()) {
  return db.licence.findMany({
    where: {
      practitionerId,
      status: 'ACTIVE',
      expiresOn: { gte: at },
    },
    orderBy: { expiresOn: 'desc' },
  });
}

/**
 * Finds a practitioner a registrar is about to post.
 *
 * Searches by LICENCE NUMBER, not by name. Names are encrypted at rest and
 * have no blind index, so a name search is not possible without weakening
 * that — and it would be the wrong key anyway: a registrar posting staff is
 * working from a licence, and two clinicians share a name far more often
 * than they share a KMPDC number.
 *
 * Returns the affiliations too, so the screen can say "already at Migosi
 * Health Centre" rather than letting someone post a duplicate and meet the
 * refusal afterwards.
 */
export async function searchPractitioners(
  db: Db,
  query: string,
  limit = 10,
): Promise<
  Array<{
    practitionerId: string;
    name: string;
    cadre: string;
    status: string;
    licences: Array<{ regulator: string; licenceNumber: string; status: string; expiresOn: Date }>;
    affiliations: Array<{ id: string; facilityId: string; facilityName: string; role: string }>;
  }>
> {
  const q = query.trim();
  // Two characters is too loose for a licence number and would return the
  // whole register on a single keystroke.
  if (q.length < 3) return [];

  const licences = await db.licence.findMany({
    where: { licenceNumber: { contains: q, mode: 'insensitive' } },
    select: { practitionerId: true },
    take: limit * 3,
  });

  const ids = [...new Set(licences.map((l) => l.practitionerId))].slice(0, limit);
  if (ids.length === 0) return [];

  const practitioners = await db.practitioner.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      cadre: true,
      status: true,
      person: { select: { givenName: true, familyName: true } },
      licences: {
        select: { regulator: true, licenceNumber: true, status: true, expiresOn: true },
        orderBy: { expiresOn: 'desc' },
      },
      affiliations: {
        where: { status: 'ACTIVE' },
        select: {
          id: true,
          facilityId: true,
          role: true,
          facility: { select: { name: true } },
        },
      },
    },
  });

  return practitioners.map((p) => ({
    practitionerId: p.id,
    // Decrypted for display only. A registrar needs to confirm they are
    // posting the person they mean.
    name: `${decryptField(p.person.givenName)} ${decryptField(p.person.familyName)}`,
    cadre: p.cadre,
    status: p.status,
    licences: p.licences,
    affiliations: p.affiliations.map((a) => ({
      id: a.id,
      facilityId: a.facilityId,
      facilityName: a.facility.name,
      role: a.role,
    })),
  }));
}

/** Licence expiry warnings — 30 days, 7 days, and on the day. */
export async function licencesExpiringSoon(db: Db, withinDays = 30, at: Date = new Date()) {
  const horizon = new Date(at.getTime() + withinDays * 86_400_000);
  const rows = await db.licence.findMany({
    where: { status: 'ACTIVE', expiresOn: { gte: at, lte: horizon } },
    select: {
      id: true,
      practitionerId: true,
      regulator: true,
      licenceNumber: true,
      expiresOn: true,
    },
    orderBy: { expiresOn: 'asc' },
  });
  return rows.map((r) => ({
    ...r,
    daysRemaining: Math.ceil((r.expiresOn.getTime() - at.getTime()) / 86_400_000),
  }));
}

/** Marks lapsed licences EXPIRED. Run nightly. */
export async function expireLapsedLicences(db: Db, at: Date = new Date()) {
  const result = await db.licence.updateMany({
    where: { status: 'ACTIVE', expiresOn: { lt: at } },
    data: { status: 'EXPIRED' },
  });
  return { expired: result.count };
}

// ------------------------------------------------------------- affiliation

export interface GrantAffiliationInput {
  practitionerId: string;
  facilityId: string;
  role?: 'ATTENDING' | 'RESIDENT' | 'VISITING' | 'LOCUM' | 'FACILITY_ADMIN';
  grantedBy: string;
  grantedByKind: 'FACILITY' | 'MINISTRY';
}

/**
 * Links a clinician to a facility.
 *
 * Who may grant is not a detail: private facilities manage their own staff,
 * public facilities are staffed by the Ministry. A private facility adding a
 * clinician to a public hospital would be a posting nobody authorised.
 */
export async function grantAffiliation(db: Db, input: GrantAffiliationInput) {
  const [practitioner, facility] = await Promise.all([
    db.practitioner.findUnique({
      where: { id: input.practitionerId },
      select: { id: true, status: true, cadre: true },
    }),
    db.facility.findUnique({
      where: { id: input.facilityId },
      select: { id: true, name: true, ownership: true, registrationStatus: true },
    }),
  ]);

  if (!practitioner) {
    throw new PractitionerError('Practitioner not found', 'PRACTITIONER_NOT_FOUND');
  }
  if (!facility) throw new PractitionerError('Facility not found', 'FACILITY_NOT_FOUND');

  if (facility.registrationStatus !== 'ACTIVE') {
    throw new PractitionerError(
      `${facility.name} is ${facility.registrationStatus}, not ACTIVE`,
      'FACILITY_NOT_ACTIVE',
    );
  }

  const isPublic =
    facility.ownership === 'PUBLIC_MOH' || facility.ownership === 'PUBLIC_OTHER';

  if (isPublic && input.grantedByKind !== 'MINISTRY') {
    throw new PractitionerError(
      `${facility.name} is a public facility — only the Ministry may assign staff`,
      'MINISTRY_GRANT_REQUIRED',
    );
  }
  if (!isPublic && input.grantedByKind !== 'FACILITY') {
    throw new PractitionerError(
      `${facility.name} is privately owned — the facility grants its own affiliations`,
      'FACILITY_GRANT_REQUIRED',
    );
  }

  const existing = await db.affiliation.findFirst({
    where: {
      practitionerId: input.practitionerId,
      facilityId: input.facilityId,
      status: 'ACTIVE',
    },
    select: { id: true },
  });
  if (existing) {
    throw new PractitionerError(
      'That practitioner is already affiliated to this facility',
      'AFFILIATION_EXISTS',
    );
  }

  return db.affiliation.create({
    data: {
      practitionerId: input.practitionerId,
      facilityId: input.facilityId,
      role: input.role ?? 'ATTENDING',
      grantedBy: input.grantedBy,
      grantedByKind: input.grantedByKind,
      status: 'ACTIVE',
    },
  });
}

/** Ends an affiliation. Open sessions at that facility are closed with it. */
export async function endAffiliation(db: Db, affiliationId: string) {
  const affiliation = await db.affiliation.findUnique({
    where: { id: affiliationId },
    select: { id: true, practitionerId: true, facilityId: true },
  });
  if (!affiliation) {
    throw new PractitionerError('Affiliation not found', 'AFFILIATION_NOT_FOUND');
  }

  const now = new Date();

  // A revoked affiliation must not leave a live session behind it.
  await db.checkIn.updateMany({
    where: { affiliationId, endedAt: null },
    data: { endedAt: now, endReason: 'REVOKED' },
  });

  return db.affiliation.update({
    where: { id: affiliationId },
    data: { status: 'ENDED', endedAt: now },
  });
}

// ---------------------------------------------------------------- check-in

export interface CheckInInput {
  practitionerId: string;
  facilityId: string;
  method?: 'SELF_SELECT' | 'FACILITY_CODE' | 'GEOFENCE';
  deviceHint?: string;
  ipHash?: string;
}

/**
 * Opens a shift.
 *
 * Four gates, checked in the order that gives the most useful error:
 * practitioner active, affiliation exists, licence valid, no session already
 * open elsewhere.
 */
export async function checkIn(db: Db, input: CheckInInput, now: Date = new Date()) {
  const practitioner = await db.practitioner.findUnique({
    where: { id: input.practitionerId },
    select: { id: true, status: true, cadre: true },
  });
  if (!practitioner) {
    throw new PractitionerError('Practitioner not found', 'PRACTITIONER_NOT_FOUND');
  }
  if (practitioner.status !== 'ACTIVE') {
    throw new PractitionerError(
      `Practitioner account is ${practitioner.status}, not ACTIVE`,
      'PRACTITIONER_NOT_ACTIVE',
    );
  }

  const affiliation = await db.affiliation.findFirst({
    where: {
      practitionerId: input.practitionerId,
      facilityId: input.facilityId,
      status: 'ACTIVE',
    },
    select: { id: true, facility: { select: { name: true } } },
  });
  if (!affiliation) {
    throw new PractitionerError(
      'You are not affiliated to that facility. Affiliations are granted by the ' +
        'facility (private) or the Ministry (public) — they cannot be self-declared.',
      'NOT_AFFILIATED',
    );
  }

  const licences = await activeLicences(db, input.practitionerId, now);
  if (REGULATOR_FOR_CADRE[practitioner.cadre as Cadre] && licences.length === 0) {
    throw new PractitionerError(
      'No active, unexpired licence. Clinical writes will be refused until ' +
        'your registration is renewed.',
      'NO_ACTIVE_LICENCE',
    );
  }

  // One open session at a time. A clinician cannot be on duty in two
  // facilities at once, and allowing it would make attribution ambiguous.
  const open = await db.checkIn.findFirst({
    where: {
      practitionerId: input.practitionerId,
      endedAt: null,
      expiresAt: { gt: now },
    },
    select: { id: true, facilityId: true, facility: { select: { name: true } } },
  });
  if (open) {
    if (open.facilityId === input.facilityId) {
      throw new PractitionerError(
        `You are already checked in at ${open.facility.name}`,
        'ALREADY_CHECKED_IN',
      );
    }
    throw new PractitionerError(
      `You are still checked in at ${open.facility.name}. Check out there first.`,
      'OPEN_SESSION_ELSEWHERE',
    );
  }

  const session = await db.checkIn.create({
    data: {
      practitionerId: input.practitionerId,
      facilityId: input.facilityId,
      affiliationId: affiliation.id,
      startedAt: now,
      expiresAt: new Date(now.getTime() + SESSION_HOURS * 3_600_000),
      method: input.method ?? 'SELF_SELECT',
      deviceHint: input.deviceHint ?? null,
      ipHash: input.ipHash ?? null,
    },
  });

  return { session, licenceNumber: licences[0]?.licenceNumber ?? null };
}

/** The open session, if any, with the time left in it. */
export async function currentSession(
  db: Db,
  practitionerId: string,
  now: Date = new Date(),
) {
  const session = await db.checkIn.findFirst({
    where: { practitionerId, endedAt: null, expiresAt: { gt: now } },
    select: {
      id: true,
      facilityId: true,
      startedAt: true,
      expiresAt: true,
      method: true,
      facility: { select: { name: true, kephLevel: true } },
    },
  });
  if (!session) return null;

  const minutesRemaining = Math.floor((session.expiresAt.getTime() - now.getTime()) / 60_000);
  return {
    ...session,
    minutesRemaining,
    expiringSoon: minutesRemaining <= EXPIRY_WARNING_MINUTES,
  };
}

/**
 * Extends a session that is about to lapse.
 *
 * Deliberately only extends near the end — a clinician who could top up at
 * any time would simply never check out, and the session would stop meaning
 * "this shift".
 */
export async function extendSession(
  db: Db,
  practitionerId: string,
  now: Date = new Date(),
) {
  const session = await db.checkIn.findFirst({
    where: { practitionerId, endedAt: null, expiresAt: { gt: now } },
    select: { id: true, expiresAt: true, startedAt: true },
  });
  if (!session) {
    throw new PractitionerError('No open session to extend', 'NO_OPEN_SESSION');
  }

  const minutesRemaining = (session.expiresAt.getTime() - now.getTime()) / 60_000;
  if (minutesRemaining > 60) {
    throw new PractitionerError(
      `Session still has ${Math.round(minutesRemaining)} minutes; ` +
        'extension is only available in the final hour.',
      'EXTENSION_TOO_EARLY',
    );
  }

  // A session may never span more than MAX_SESSION_HOURS from when it
  // opened. Without this cap, rolling extensions would turn a shift into a
  // permanent session and "checked in" would stop meaning anything. The
  // database enforces the same bound (checkin_window_ck); we fail here with
  // an explanation rather than letting the constraint surface raw.
  const hardCeiling = new Date(
    session.startedAt.getTime() + MAX_SESSION_HOURS * 3_600_000,
  );
  if (now >= hardCeiling) {
    throw new PractitionerError(
      `This session opened ${MAX_SESSION_HOURS} hours ago and cannot be ` +
        'extended further. Check out and check in again for a new shift.',
      'SESSION_CEILING_REACHED',
    );
  }

  const requested = new Date(now.getTime() + SESSION_HOURS * 3_600_000);
  const expiresAt = requested > hardCeiling ? hardCeiling : requested;

  return db.checkIn.update({
    where: { id: session.id },
    data: { expiresAt },
  });
}

export async function checkOut(db: Db, practitionerId: string, now: Date = new Date()) {
  const session = await db.checkIn.findFirst({
    where: { practitionerId, endedAt: null },
    select: { id: true },
  });
  if (!session) {
    throw new PractitionerError('No open session to close', 'NO_OPEN_SESSION');
  }

  return db.checkIn.update({
    where: { id: session.id },
    data: { endedAt: now, endReason: 'MANUAL' },
  });
}

/** Closes sessions nobody checked out of. Run frequently. */
export async function closeExpiredSessions(db: Db, now: Date = new Date()) {
  const result = await db.checkIn.updateMany({
    where: { endedAt: null, expiresAt: { lte: now } },
    data: { endedAt: now, endReason: 'EXPIRED' },
  });
  return { closed: result.count };
}

/**
 * Can this practitioner write a clinical record right now?
 *
 * The same four conditions the Phase 0 trigger enforces, checked in advance
 * so the UI can explain the problem instead of surfacing a database error.
 */
export async function canWriteClinical(
  db: Db,
  practitionerId: string,
  now: Date = new Date(),
): Promise<
  | { allowed: true; checkInId: string; facilityId: string; licenceNumber: string }
  | { allowed: false; reason: string; code: string }
> {
  const session = await db.checkIn.findFirst({
    where: { practitionerId, endedAt: null, expiresAt: { gt: now } },
    select: { id: true, facilityId: true, affiliationId: true },
  });
  if (!session) {
    return {
      allowed: false,
      code: 'NO_OPEN_SESSION',
      reason: 'You must check in to a facility before recording clinical data.',
    };
  }

  const affiliation = await db.affiliation.findUnique({
    where: { id: session.affiliationId },
    select: { status: true },
  });
  if (affiliation?.status !== 'ACTIVE') {
    return {
      allowed: false,
      code: 'AFFILIATION_ENDED',
      reason: 'Your affiliation to this facility is no longer active.',
    };
  }

  const licences = await activeLicences(db, practitionerId, now);
  if (licences.length === 0) {
    return {
      allowed: false,
      code: 'NO_ACTIVE_LICENCE',
      reason: 'Your licence has expired or been suspended. Clinical writes are refused.',
    };
  }

  return {
    allowed: true,
    checkInId: session.id,
    facilityId: session.facilityId,
    licenceNumber: licences[0].licenceNumber,
  };
}
