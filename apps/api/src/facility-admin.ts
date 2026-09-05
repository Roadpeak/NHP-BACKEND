/**
 * Running a facility.
 *
 * A facility administrator is not a new kind of account. They are a
 * practitioner holding the FACILITY_ADMIN role at one facility — which
 * means the existing licence checks, MFA and audit trail apply to them
 * unchanged, and there is no fourth credential type to keep secure.
 *
 * Two things live here that live nowhere else:
 *
 *   - The roster. A private facility engages its own staff; a public one
 *     receives staff posted by the Ministry. `grantAffiliation` already
 *     refuses the wrong direction, so this module only has to name the
 *     right actor and let that refusal happen.
 *
 *   - The reception queue. Reception registers arrivals. They confirm a
 *     person is who they say they are and put them in the queue — and
 *     that is all they ever see. The queue row below carries a name, an
 *     age and a photo. It carries no allergy, no diagnosis, no medicine,
 *     because a receptionist has no clinical reason to know any of it and
 *     a busy waiting room is the least private place in the building.
 */

import type { PrismaClient } from '@prisma/client';
import { decryptField } from './crypto.js';

type Db = PrismaClient;

export class FacilityAdminError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'FacilityAdminError';
  }
}

// ------------------------------------------------------------------- the guard

export interface AdminScope {
  facilityId: string;
  facilityName: string;
  ownership: string;
  isPublic: boolean;
  /**
   * Who the caller turned out to be. Grants are attributed to a person, and
   * "you cannot remove your own access" needs to know which row is yours —
   * neither works if the route has thrown the identity away.
   */
  actorPractitionerId?: string;
  actorPersonId?: string;
}

/**
 * Which facility, if any, this practitioner administers.
 *
 * Fails closed and says why. The status and role are both checked in the
 * query rather than after it, so a suspended administrator cannot be read
 * back and then waved through by a mistaken comparison.
 */
export async function requireFacilityAdmin(
  db: Db,
  practitionerId: string,
  facilityId?: string,
): Promise<AdminScope> {
  const affiliation = await db.affiliation.findFirst({
    where: {
      practitionerId,
      role: 'FACILITY_ADMIN',
      status: 'ACTIVE',
      endedAt: null,
      ...(facilityId ? { facilityId } : {}),
    },
    select: {
      facility: {
        select: { id: true, name: true, ownership: true, registrationStatus: true },
      },
    },
  });

  if (!affiliation) {
    throw new FacilityAdminError(
      facilityId
        ? 'You do not administer that facility.'
        : 'This account does not administer a facility.',
      'NOT_A_FACILITY_ADMIN',
    );
  }

  const f = affiliation.facility;
  if (f.registrationStatus !== 'ACTIVE') {
    throw new FacilityAdminError(
      `${f.name} is ${f.registrationStatus}. It cannot be administered until the Ministry approves it.`,
      'FACILITY_NOT_ACTIVE',
    );
  }

  return {
    facilityId: f.id,
    facilityName: f.name,
    ownership: f.ownership,
    isPublic: f.ownership === 'PUBLIC_MOH' || f.ownership === 'PUBLIC_OTHER',
    actorPractitionerId: practitionerId,
  };
}

// ---------------------------------------------------------------- the roster

export interface StaffRow {
  affiliationId: string;
  practitionerId: string;
  displayName: string;
  cadre: string;
  role: string;
  status: string;
  startedAt: Date;
  /** How this person came to work here — the ownership rule, made visible. */
  grantedByKind: string;
  /** Whether they are on the premises right now. */
  onDuty: boolean;
  /** Null for reception, who hold none. Blank is not an error. */
  licenceNumber: string | null;
  licenceStatus: string | null;
}

export async function listStaff(
  db: Db,
  facilityId: string,
  opts: { includeEnded?: boolean } = {},
): Promise<StaffRow[]> {
  const affiliations = await db.affiliation.findMany({
    where: {
      facilityId,
      ...(opts.includeEnded ? {} : { status: 'ACTIVE', endedAt: null }),
    },
    select: {
      id: true,
      practitionerId: true,
      role: true,
      status: true,
      startedAt: true,
      grantedByKind: true,
      practitioner: {
        select: {
          id: true,
          // A practitioner's name lives on their Person record — they are
          // a citizen who also happens to hold a licence.
          person: { select: { givenName: true, familyName: true } },
          cadre: true,
          licences: {
            where: { status: 'ACTIVE' },
            select: { licenceNumber: true, status: true },
            take: 1,
          },
        },
      },
    },
    orderBy: [{ status: 'asc' }, { startedAt: 'desc' }],
  });

  // One query for every open session rather than one per row: a district
  // hospital roster is long enough that the difference is felt.
  const open = await db.checkIn.findMany({
    where: {
      facilityId,
      endedAt: null,
      expiresAt: { gt: new Date() },
    },
    select: { practitionerId: true },
  });
  const onDuty = new Set(open.map((c) => c.practitionerId));

  return affiliations.map((a) => ({
    affiliationId: a.id,
    practitionerId: a.practitionerId,
    // Names are encrypted at rest. Returning the column directly hands
    // the reader base64 ciphertext, which looks like a rendering fault
    // rather than the access-control mistake it is.
    displayName: `${decryptField(a.practitioner.person.givenName)} ${decryptField(a.practitioner.person.familyName)}`,
    cadre: a.practitioner.cadre,
    role: a.role,
    status: a.status,
    startedAt: a.startedAt,
    grantedByKind: a.grantedByKind,
    onDuty: onDuty.has(a.practitionerId),
    licenceNumber: a.practitioner.licences[0]?.licenceNumber ?? null,
    licenceStatus: a.practitioner.licences[0]?.status ?? null,
  }));
}

// -------------------------------------------------------- the reception queue

/**
 * What reception may see about a person waiting.
 *
 * Every field here answers the one question reception has: is this the
 * right person? Nothing here answers any clinical question, and that is
 * the point — the shape of this type is the access control.
 */
export interface QueueEntry {
  visitId: string;
  nhpId: string;
  displayName: string;
  ageYears: number | null;
  sex: string | null;
  photoDataUrl: string | null;
  arrivedAt: Date;
  reasonForVisit: string | null;
  seenBy: string | null;
}

function ageFrom(dob: Date | null): number | null {
  if (!dob) return null;
  const now = new Date();
  let years = now.getUTCFullYear() - dob.getUTCFullYear();
  const before =
    now.getUTCMonth() < dob.getUTCMonth() ||
    (now.getUTCMonth() === dob.getUTCMonth() && now.getUTCDate() < dob.getUTCDate());
  if (before) years -= 1;
  return years;
}

/**
 * Register an arrival.
 *
 * Reception finds the person by their NHP number and confirms the photo
 * and name in front of them. Nothing clinical is asked for or accepted:
 * `statedReason` is the person's own words, kept as free text so nobody
 * is tempted to read it as triage.
 */
export async function registerArrival(
  db: Db,
  input: {
    facilityId: string;
    nhpId: string;
    statedReason?: string;
    registeredBy: string;
  },
) {
  const person = await db.person.findUnique({
    where: { displayNumber: input.nhpId.trim().toUpperCase() },
    select: { id: true, lifeStatus: true },
  });
  if (!person) {
    throw new FacilityAdminError(
      `No record found for ${input.nhpId}. Check the number on the card.`,
      'PERSON_NOT_FOUND',
    );
  }

  // Already waiting. Reception desks are busy and the same person gets
  // entered twice; a second row would show them queued twice and make the
  // waiting count wrong.
  const existing = await db.arrival.findFirst({
    where: {
      personId: person.id,
      facilityId: input.facilityId,
      status: { in: ['WAITING', 'IN_CONSULTATION'] },
    },
    select: { id: true, arrivedAt: true },
  });
  if (existing) {
    return { arrivalId: existing.id, alreadyWaiting: true, arrivedAt: existing.arrivedAt };
  }

  const arrival = await db.arrival.create({
    data: {
      personId: person.id,
      facilityId: input.facilityId,
      statedReason: input.statedReason?.trim() || null,
      registeredBy: input.registeredBy,
    },
    select: { id: true, arrivedAt: true },
  });
  return { arrivalId: arrival.id, alreadyWaiting: false, arrivedAt: arrival.arrivedAt };
}

/** Who is waiting, in arrival order. Identity only — see `QueueEntry`. */
export async function listQueue(db: Db, facilityId: string): Promise<QueueEntry[]> {
  const rows = await db.arrival.findMany({
    where: { facilityId, status: { in: ['WAITING', 'IN_CONSULTATION'] } },
    orderBy: { arrivedAt: 'asc' },
    select: {
      id: true,
      arrivedAt: true,
      statedReason: true,
      status: true,
      seenById: true,
      person: {
        // Named explicitly rather than taken wholesale. `person` carries
        // blood group, encrypted identifiers and life status; a spread
        // here would hand all of it to a reception desk.
        select: {
          displayNumber: true,
          givenName: true,
          familyName: true,
          sexAtBirth: true,
          dateOfBirth: true,
          photo: true,
        },
      },
    },
  });

  return rows.map((r) => ({
    visitId: r.id,
    nhpId: r.person.displayNumber,
    displayName: `${decryptField(r.person.givenName)} ${decryptField(r.person.familyName)}`,
    ageYears: ageFrom(r.person.dateOfBirth),
    sex: r.person.sexAtBirth,
    photoDataUrl: r.person.photo ? decryptField(r.person.photo) : null,
    arrivedAt: r.arrivedAt,
    reasonForVisit: r.statedReason,
    seenBy: r.seenById,
  }));
}

/** Reception marks someone as having left without being seen. */
export async function closeArrival(
  db: Db,
  arrivalId: string,
  facilityId: string,
  status: 'LEFT' | 'COMPLETED',
) {
  const arrival = await db.arrival.findUnique({
    where: { id: arrivalId },
    select: { id: true, facilityId: true, status: true },
  });
  if (!arrival || arrival.facilityId !== facilityId) {
    // Same answer either way: whether an arrival at another facility
    // exists is not something this desk gets to learn.
    throw new FacilityAdminError('Arrival not found', 'ARRIVAL_NOT_FOUND');
  }
  return db.arrival.update({
    where: { id: arrivalId },
    data: { status, closedAt: new Date() },
    select: { id: true, status: true },
  });
}

/**
 * The same scope, reached as a DIRECTOR rather than as a practitioner.
 *
 * A hospital owner is usually a businessperson, so the person who runs a
 * facility often holds no clinical licence at all. They are a Person with
 * their own account, linked through `FacilityDirector`.
 *
 * This grants the ADMINISTRATIVE surface and nothing else. Clinical writes
 * are gated separately by `requirePractitioner` and by the licence check in
 * the append-only triggers, neither of which this touches — so a
 * non-clinical director can run a roster and a reception desk and still
 * cannot record a single clinical row.
 */
export async function requireFacilityDirector(
  db: Db,
  personId: string,
  facilityId?: string,
): Promise<AdminScope> {
  // Status checked in the query rather than after it, so an ended
  // directorship cannot be read back and waved through by a mistaken
  // comparison.
  const directorship = await db.facilityDirector.findFirst({
    where: {
      personId,
      status: 'ACTIVE',
      endedAt: null,
      ...(facilityId ? { facilityId } : {}),
    },
    select: {
      facility: {
        select: { id: true, name: true, ownership: true, registrationStatus: true },
      },
    },
  });

  if (!directorship) {
    throw new FacilityAdminError(
      facilityId
        ? 'You do not direct that facility.'
        : 'This account does not direct a facility.',
      'NOT_A_FACILITY_ADMIN',
    );
  }

  const f = directorship.facility;
  if (f.registrationStatus !== 'ACTIVE') {
    throw new FacilityAdminError(
      `${f.name} is ${f.registrationStatus}. It cannot be administered until the Ministry approves it.`,
      'FACILITY_NOT_ACTIVE',
    );
  }

  return {
    facilityId: f.id,
    facilityName: f.name,
    ownership: f.ownership,
    isPublic: f.ownership === 'PUBLIC_MOH' || f.ownership === 'PUBLIC_OTHER',
    actorPersonId: personId,
  };
}

/**
 * Whichever of the two the caller actually is.
 *
 * Routes should not have to know: the reception queue is the reception
 * queue whether a clinician-administrator or a non-clinical director opens
 * it. Tries the practitioner path first only because it is the one that
 * existed, and reports the director's refusal when neither matches — a
 * caller with a personId and no practitionerId is far more likely to be a
 * director who is not linked than a practitioner who is missing.
 */
export async function requireFacilityScope(
  db: Db,
  who: { practitionerId?: string; personId?: string },
  facilityId?: string,
): Promise<AdminScope> {
  if (who.practitionerId) {
    try {
      return await requireFacilityAdmin(db, who.practitionerId, facilityId);
    } catch (err) {
      // A practitioner who is also a director falls through to the second
      // check rather than being refused on the first.
      if (!who.personId) throw err;
    }
  }
  if (who.personId) return requireFacilityDirector(db, who.personId, facilityId);
  throw new FacilityAdminError(
    'This account does not administer a facility.',
    'NOT_A_FACILITY_ADMIN',
  );
}
