/**
 * Identity — Phase 1.
 *
 * The whole phase rests on one decision from the blueprint: `person` holds no
 * external identifier at all. National ID, birth certificate, passport and
 * phone live in `identifier` as attached rows keyed to an immutable internal
 * id.
 *
 * That is what makes promotion at 18 an INSERT rather than a migration. The
 * dependant's clinical record never moves, is never copied, and is never
 * orphaned — only their credentials and consent authority change.
 */
import { PrismaClient, type Prisma } from '@prisma/client';
import {
  blindIndex,
  encryptField,
  decryptField,
  generateDisplayNumber,
  normalisePhone,
} from './crypto.js';

export type Db = PrismaClient | Prisma.TransactionClient;

export class IdentityError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'IdentityError';
  }
}

// ---------------------------------------------------------------- helpers

/** Age in whole years at a given instant. */
export function ageAt(dateOfBirth: Date, at: Date = new Date()): number {
  let age = at.getUTCFullYear() - dateOfBirth.getUTCFullYear();
  const monthDiff = at.getUTCMonth() - dateOfBirth.getUTCMonth();
  if (monthDiff < 0 || (monthDiff === 0 && at.getUTCDate() < dateOfBirth.getUTCDate())) {
    age -= 1;
  }
  return age;
}

/**
 * Display numbers are random, so a collision is possible if improbable.
 * Retry rather than surfacing a unique-constraint error to a citizen who
 * did nothing wrong.
 */
async function allocateDisplayNumber(db: Db): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = generateDisplayNumber();
    const taken = await db.person.findUnique({
      where: { displayNumber: candidate },
      select: { id: true },
    });
    if (!taken) return candidate;
  }
  throw new IdentityError(
    'Could not allocate a unique NHP number after 5 attempts',
    'DISPLAY_NUMBER_EXHAUSTED',
  );
}

// -------------------------------------------------------------- registration

export interface RegisterAdultInput {
  nationalId: string;
  phone: string;
  email?: string;
  givenName: string;
  middleName?: string;
  familyName: string;
  sexAtBirth: 'MALE' | 'FEMALE' | 'INTERSEX';
  dateOfBirth: Date;
  dobPrecision?: 'EXACT' | 'MONTH' | 'YEAR' | 'ESTIMATED';
  countyId: string;
  subcountyId: string;
  wardId?: string;
  residenceNote?: string;
  passwordHash: string;
  registeredBy?: string;
}

/**
 * Self-registration. Email is optional by design — a large share of the
 * population has a phone and no email, and requiring one would exclude them.
 */
export async function registerAdult(db: Db, input: RegisterAdultInput) {
  const age = ageAt(input.dateOfBirth);
  if (age < 18) {
    throw new IdentityError(
      `Self-registration requires age 18 or over; this person is ${age}. ` +
        'Register them as a dependant of their guardian instead.',
      'UNDERAGE_SELF_REGISTRATION',
    );
  }

  const idIndex = blindIndex(input.nationalId);
  const existing = await db.identifier.findFirst({
    where: { type: 'NATIONAL_ID', valueIndex: idIndex, status: 'ACTIVE' },
    select: { personId: true },
  });
  if (existing) {
    throw new IdentityError(
      'That National ID is already registered',
      'IDENTIFIER_ALREADY_REGISTERED',
    );
  }

  const phoneIndex = blindIndex(input.phone, normalisePhone);
  const phoneTaken = await db.account.findUnique({
    where: { phoneIndex },
    select: { id: true },
  });
  if (phoneTaken) {
    throw new IdentityError('That phone number is already in use', 'PHONE_IN_USE');
  }

  const displayNumber = await allocateDisplayNumber(db);

  const person = await db.person.create({
    data: {
      displayNumber,
      givenName: encryptField(input.givenName),
      middleName: input.middleName ? encryptField(input.middleName) : null,
      familyName: encryptField(input.familyName),
      sexAtBirth: input.sexAtBirth,
      dateOfBirth: input.dateOfBirth,
      dobPrecision: input.dobPrecision ?? 'EXACT',
      countyId: input.countyId,
      subcountyId: input.subcountyId,
      wardId: input.wardId ?? null,
      residenceNote: input.residenceNote ? encryptField(input.residenceNote) : null,
      maturity: 'ADULT',
      registeredBy: input.registeredBy ?? 'SELF',
      registrationRoute: 'SELF',
      verificationState: 'PENDING',
      identifiers: {
        create: {
          type: 'NATIONAL_ID',
          value: encryptField(input.nationalId),
          valueIndex: idIndex,
          status: 'ACTIVE',
        },
      },
      account: {
        create: {
          phone: encryptField(input.phone),
          phoneIndex,
          email: input.email ? encryptField(input.email) : null,
          emailIndex: input.email ? blindIndex(input.email) : null,
          passwordHash: input.passwordHash,
          status: 'ACTIVE',
        },
      },
    },
    include: { account: true, identifiers: true },
  });

  return person;
}

export interface RegisterDependantInput {
  guardianPersonId: string;
  relationship:
    | 'MOTHER'
    | 'FATHER'
    | 'LEGAL_GUARDIAN'
    | 'GRANDPARENT'
    | 'SIBLING'
    | 'FOSTER'
    | 'INSTITUTION'
    | 'OTHER';
  evidence:
    | 'BIRTH_RECORD'
    | 'BIRTH_CERT'
    | 'COURT_ORDER'
    | 'FACILITY_ATTESTED'
    | 'SELF_DECLARED';
  birthCertNumber?: string;
  givenName: string;
  middleName?: string;
  familyName: string;
  sexAtBirth: 'MALE' | 'FEMALE' | 'INTERSEX';
  dateOfBirth: Date;
  dobPrecision?: 'EXACT' | 'MONTH' | 'YEAR' | 'ESTIMATED';
  countyId?: string;
  subcountyId?: string;
  isPrimary?: boolean;
  registeredBy: string;
  registrationRoute?: 'FACILITY_BIRTH' | 'GUARDIAN' | 'MINISTRY';
}

/**
 * A dependant is a person with a full clinical record and no credentials.
 *
 * The evidence field is what makes the registration gate enforceable: a
 * SELF_DECLARED dependant is created UNVERIFIED and is not yet searchable by
 * facilities, while one registered by the delivering facility at birth is
 * trusted immediately. Without this, any adult could fabricate a child.
 */
export async function registerDependant(db: Db, input: RegisterDependantInput) {
  const guardian = await db.person.findUnique({
    where: { id: input.guardianPersonId },
    select: {
      id: true,
      maturity: true,
      countyId: true,
      subcountyId: true,
      lifeStatus: true,
    },
  });
  if (!guardian) {
    throw new IdentityError('Guardian not found', 'GUARDIAN_NOT_FOUND');
  }
  if (guardian.maturity !== 'ADULT') {
    throw new IdentityError(
      'Only an adult account may register a dependant',
      'GUARDIAN_NOT_ADULT',
    );
  }

  const age = ageAt(input.dateOfBirth);
  if (age >= 18) {
    throw new IdentityError(
      `A dependant must be under 18; this person is ${age}`,
      'DEPENDANT_TOO_OLD',
    );
  }

  if (input.birthCertNumber) {
    const certIndex = blindIndex(input.birthCertNumber);
    const dup = await db.identifier.findFirst({
      where: { type: 'BIRTH_CERT', valueIndex: certIndex, status: 'ACTIVE' },
      select: { personId: true },
    });
    if (dup) {
      throw new IdentityError(
        'That birth certificate number is already registered',
        'IDENTIFIER_ALREADY_REGISTERED',
      );
    }
  }

  // Facility-attested and documented registrations are trusted; a bare
  // self-declaration waits for review before facilities can find the child.
  const trusted =
    input.evidence === 'BIRTH_RECORD' ||
    input.evidence === 'BIRTH_CERT' ||
    input.evidence === 'COURT_ORDER' ||
    input.evidence === 'FACILITY_ATTESTED';

  const displayNumber = await allocateDisplayNumber(db);

  const dependant = await db.person.create({
    data: {
      displayNumber,
      givenName: encryptField(input.givenName),
      middleName: input.middleName ? encryptField(input.middleName) : null,
      familyName: encryptField(input.familyName),
      sexAtBirth: input.sexAtBirth,
      dateOfBirth: input.dateOfBirth,
      dobPrecision: input.dobPrecision ?? 'EXACT',
      // Children inherit the guardian's geography unless told otherwise.
      countyId: input.countyId ?? guardian.countyId,
      subcountyId: input.subcountyId ?? guardian.subcountyId,
      maturity: 'DEPENDANT',
      registeredBy: input.registeredBy,
      registrationRoute: input.registrationRoute ?? 'GUARDIAN',
      verificationState: trusted ? 'VERIFIED' : 'PENDING',
      identifiers: input.birthCertNumber
        ? {
            create: {
              type: 'BIRTH_CERT',
              value: encryptField(input.birthCertNumber),
              valueIndex: blindIndex(input.birthCertNumber),
              status: 'ACTIVE',
            },
          }
        : undefined,
    },
  });

  await db.guardianship.create({
    data: {
      dependantId: dependant.id,
      guardianId: guardian.id,
      relationship: input.relationship,
      isPrimary: input.isPrimary ?? true,
      establishedBy: input.registeredBy,
      evidence: input.evidence,
      status: 'ACTIVE',
    },
  });

  return dependant;
}

/**
 * Kenyan families are not always one-parent-one-child. A second guardian is
 * an additional row, not a replacement — searching either parent's ID must
 * surface the child.
 */
export async function addGuardian(
  db: Db,
  input: {
    dependantId: string;
    guardianPersonId: string;
    relationship: RegisterDependantInput['relationship'];
    evidence: RegisterDependantInput['evidence'];
    establishedBy: string;
  },
) {
  const existing = await db.guardianship.findFirst({
    where: {
      dependantId: input.dependantId,
      guardianId: input.guardianPersonId,
      status: 'ACTIVE',
    },
    select: { id: true },
  });
  if (existing) {
    throw new IdentityError(
      'That guardian is already linked to this dependant',
      'GUARDIANSHIP_EXISTS',
    );
  }

  return db.guardianship.create({
    data: {
      dependantId: input.dependantId,
      guardianId: input.guardianPersonId,
      relationship: input.relationship,
      isPrimary: false,
      establishedBy: input.establishedBy,
      evidence: input.evidence,
      status: 'ACTIVE',
    },
  });
}

// -------------------------------------------------------------------- search

export interface PersonSummary {
  id: string;
  displayNumber: string;
  givenName: string;
  familyName: string;
  dateOfBirth: Date;
  age: number;
  maturity: string;
  sexAtBirth: string;
  verificationState: string;
}

function toSummary(p: {
  id: string;
  displayNumber: string;
  givenName: string;
  familyName: string;
  dateOfBirth: Date;
  maturity: string;
  sexAtBirth: string;
  verificationState: string;
}): PersonSummary {
  return {
    id: p.id,
    displayNumber: p.displayNumber,
    givenName: decryptField(p.givenName),
    familyName: decryptField(p.familyName),
    dateOfBirth: p.dateOfBirth,
    age: ageAt(p.dateOfBirth),
    maturity: p.maturity,
    sexAtBirth: p.sexAtBirth,
    verificationState: p.verificationState,
  };
}

/**
 * THE hot path — every clinical interaction starts here.
 *
 * Searching a guardian's National ID returns the guardian *and* every
 * dependant linked to them, because a facility looking for a child's record
 * has only the parent's ID to go on. That is the requirement the whole
 * dependant model exists to serve.
 */
export async function searchByIdentifier(
  db: Db,
  rawIdentifier: string,
): Promise<{ match: PersonSummary | null; dependants: PersonSummary[] }> {
  const index = blindIndex(rawIdentifier);

  const identifier = await db.identifier.findFirst({
    where: { valueIndex: index, status: 'ACTIVE' },
    select: {
      person: {
        select: {
          id: true,
          displayNumber: true,
          givenName: true,
          familyName: true,
          dateOfBirth: true,
          maturity: true,
          sexAtBirth: true,
          verificationState: true,
          mergedIntoId: true,
        },
      },
    },
  });

  if (!identifier) return { match: null, dependants: [] };

  let person = identifier.person;

  // Follow the merge pointer: a losing person row is never deleted, so a
  // stale identifier must resolve to the surviving record.
  const seen = new Set<string>([person.id]);
  while (person.mergedIntoId) {
    if (seen.has(person.mergedIntoId)) {
      throw new IdentityError('Merge pointer cycle detected', 'MERGE_CYCLE');
    }
    const next = await db.person.findUnique({
      where: { id: person.mergedIntoId },
      select: {
        id: true,
        displayNumber: true,
        givenName: true,
        familyName: true,
        dateOfBirth: true,
        maturity: true,
        sexAtBirth: true,
        verificationState: true,
        mergedIntoId: true,
      },
    });
    if (!next) break;
    seen.add(next.id);
    person = next;
  }

  const links = await db.guardianship.findMany({
    where: { guardianId: person.id, status: 'ACTIVE' },
    select: {
      dependant: {
        select: {
          id: true,
          displayNumber: true,
          givenName: true,
          familyName: true,
          dateOfBirth: true,
          maturity: true,
          sexAtBirth: true,
          verificationState: true,
        },
      },
    },
  });

  return {
    match: toSummary(person),
    dependants: links.map((l) => toSummary(l.dependant)),
  };
}

// ----------------------------------------------------------------- promotion

/**
 * Flags dependants who have reached 18. Run nightly.
 *
 * Deliberately does NOT sever guardian access — care must not be interrupted
 * on a birthday. The record stays reachable through the guardian for a grace
 * period; only `finalisePromotions` closes that door.
 */
export async function flagDueForPromotion(db: Db, now: Date = new Date()) {
  const eighteenYearsAgo = new Date(
    Date.UTC(now.getUTCFullYear() - 18, now.getUTCMonth(), now.getUTCDate()),
  );

  const due = await db.person.findMany({
    where: { maturity: 'DEPENDANT', dateOfBirth: { lte: eighteenYearsAgo } },
    select: { id: true, displayNumber: true },
  });

  if (due.length === 0) return { flagged: 0, ids: [] as string[] };

  await db.person.updateMany({
    where: { id: { in: due.map((d) => d.id) } },
    data: { maturity: 'PENDING_PROMOTION' },
  });

  return { flagged: due.length, ids: due.map((d) => d.id) };
}

export interface PromoteInput {
  personId: string;
  nationalId: string;
  phone: string;
  email?: string;
  passwordHash: string;
}

/**
 * An 18-year-old claims their own record.
 *
 * The clinical history does not move. We attach a National ID to the existing
 * person, issue credentials, and end the guardianship links. Every encounter,
 * diagnosis, allergy and immunisation recorded during childhood still points
 * at the same `person.id` it always did.
 */
export async function promoteToAdult(db: Db, input: PromoteInput) {
  const person = await db.person.findUnique({
    where: { id: input.personId },
    select: { id: true, maturity: true, dateOfBirth: true },
  });
  if (!person) throw new IdentityError('Person not found', 'PERSON_NOT_FOUND');

  if (person.maturity === 'ADULT') {
    throw new IdentityError('This record is already an adult account', 'ALREADY_ADULT');
  }

  const age = ageAt(person.dateOfBirth);
  if (age < 18) {
    throw new IdentityError(
      `Promotion requires age 18 or over; this person is ${age}`,
      'NOT_YET_ELIGIBLE',
    );
  }

  const idIndex = blindIndex(input.nationalId);
  const clash = await db.identifier.findFirst({
    where: { type: 'NATIONAL_ID', valueIndex: idIndex, status: 'ACTIVE' },
    select: { personId: true },
  });
  if (clash && clash.personId !== person.id) {
    throw new IdentityError(
      'That National ID is already registered to someone else',
      'IDENTIFIER_ALREADY_REGISTERED',
    );
  }

  const phoneIndex = blindIndex(input.phone, normalisePhone);
  const phoneTaken = await db.account.findUnique({
    where: { phoneIndex },
    select: { id: true, personId: true },
  });
  if (phoneTaken && phoneTaken.personId !== person.id) {
    throw new IdentityError('That phone number is already in use', 'PHONE_IN_USE');
  }

  if (!clash) {
    await db.identifier.create({
      data: {
        personId: person.id,
        type: 'NATIONAL_ID',
        value: encryptField(input.nationalId),
        valueIndex: idIndex,
        status: 'ACTIVE',
      },
    });
  }

  await db.account.create({
    data: {
      personId: person.id,
      phone: encryptField(input.phone),
      phoneIndex,
      email: input.email ? encryptField(input.email) : null,
      emailIndex: input.email ? blindIndex(input.email) : null,
      passwordHash: input.passwordHash,
      status: 'ACTIVE',
    },
  });

  // Guardian authority ends. The links stay as history, never deleted.
  await db.guardianship.updateMany({
    where: { dependantId: person.id, status: 'ACTIVE' },
    data: { status: 'ENDED', endedAt: new Date(), endReason: 'PROMOTED_TO_ADULT' },
  });

  return db.person.update({
    where: { id: person.id },
    data: { maturity: 'ADULT', verificationState: 'PENDING' },
  });
}

/**
 * Closes the grace period for young adults who never registered.
 *
 * After this, a guardian searching their own ID no longer surfaces the
 * record — the person is an adult whether or not they have claimed it, and
 * an adult's health record is not their parent's to read.
 */
export async function finalisePromotions(
  db: Db,
  graceDays = 90,
  now: Date = new Date(),
) {
  const cutoff = new Date(
    Date.UTC(now.getUTCFullYear() - 18, now.getUTCMonth(), now.getUTCDate()),
  );
  cutoff.setUTCDate(cutoff.getUTCDate() - graceDays);

  const overdue = await db.person.findMany({
    where: { maturity: 'PENDING_PROMOTION', dateOfBirth: { lte: cutoff } },
    select: { id: true },
  });
  if (overdue.length === 0) return { closed: 0 };

  const ids = overdue.map((p) => p.id);

  await db.guardianship.updateMany({
    where: { dependantId: { in: ids }, status: 'ACTIVE' },
    data: {
      status: 'ENDED',
      endedAt: now,
      endReason: 'GRACE_PERIOD_EXPIRED',
    },
  });

  return { closed: ids.length };
}
