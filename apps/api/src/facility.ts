/**
 * Facilities — Phase 2.
 *
 * The recommendation engine is only as good as this data, so two things
 * matter more than they look:
 *
 *   1. Capabilities come from a controlled vocabulary, never free text.
 *      "CT scanner" typed four ways is four capabilities and the engine
 *      cannot match any of them.
 *
 *   2. A claim has an age. A facility ticks "CT scanner" at registration;
 *      eighteen months later it is broken and nobody updated the profile.
 *      `lastConfirmedAt` is what stops NHP confidently routing head injuries
 *      to a hospital that cannot scan them.
 */
// Prisma is imported as a value, not just a type: Prisma.JsonNull is a
// runtime sentinel needed to write a SQL NULL into a Json column.
import { PrismaClient, Prisma } from '@prisma/client';

export type Db = PrismaClient | Prisma.TransactionClient;

export class FacilityError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'FacilityError';
  }
}

/**
 * Kenya's six-level facility tiering — the numbering facility staff and the
 * Master Health Facility List actually speak.
 *
 * Level 1 is community health units, which have no physical facility and
 * cannot be registered here.
 */
export const KEPH_LEVELS: Record<number, string> = {
  2: 'Dispensary / clinic',
  3: 'Health centre',
  4: 'Sub-county hospital',
  5: 'County referral hospital',
  6: 'National referral hospital',
};

/** Capability confidence decays after this many days without reconfirmation. */
export const STALE_AFTER_DAYS = 90;
/** Beyond this, a claim is not trusted for routing at all. */
export const EXPIRED_AFTER_DAYS = 365;

export type Freshness = 'FRESH' | 'STALE' | 'EXPIRED';

export function freshnessOf(lastConfirmedAt: Date, now: Date = new Date()): Freshness {
  const days = (now.getTime() - lastConfirmedAt.getTime()) / 86_400_000;
  if (days > EXPIRED_AFTER_DAYS) return 'EXPIRED';
  if (days > STALE_AFTER_DAYS) return 'STALE';
  return 'FRESH';
}

// ------------------------------------------------------------ registration

export interface RegisterFacilityInput {
  mflCode?: string;
  name: string;
  kephLevel: number;
  ownership:
    | 'PUBLIC_MOH'
    | 'PUBLIC_OTHER'
    | 'PRIVATE_FOR_PROFIT'
    | 'FAITH_BASED'
    | 'NGO';
  countyId: string;
  subcountyId: string;
  wardId?: string;
  locality: string;
  latitude: number;
  longitude: number;
  is24Hour?: boolean;
  operatingHours?: Prisma.InputJsonValue;
  bedCapacity?: number;
  icuBeds?: number;
  maternityBeds?: number;
  phone?: string;
  email?: string;
  licensedUntil?: Date;
}

/** Kenya's bounding box, generously drawn. Catches transposed lat/lng. */
const KENYA_BOUNDS = { minLat: -5.0, maxLat: 5.5, minLng: 33.5, maxLng: 42.0 };

/**
 * Registers a facility as PENDING. A facility cannot make itself active —
 * the Ministry approves, which is what makes the registry a registry rather
 * than a directory anyone can add themselves to.
 */
export async function registerFacility(db: Db, input: RegisterFacilityInput) {
  if (!(input.kephLevel in KEPH_LEVELS)) {
    throw new FacilityError(
      `KEPH level ${input.kephLevel} is not registrable. ` +
        'Valid levels are 2 (dispensary) to 6 (national referral); ' +
        'level 1 is community units, which have no facility.',
      'INVALID_KEPH_LEVEL',
    );
  }

  const { latitude: lat, longitude: lng } = input;
  if (
    lat < KENYA_BOUNDS.minLat ||
    lat > KENYA_BOUNDS.maxLat ||
    lng < KENYA_BOUNDS.minLng ||
    lng > KENYA_BOUNDS.maxLng
  ) {
    throw new FacilityError(
      `Coordinates (${lat}, ${lng}) fall outside Kenya. ` +
        'Check whether latitude and longitude are transposed.',
      'COORDINATES_OUT_OF_BOUNDS',
    );
  }

  if (input.mflCode) {
    const clash = await db.facility.findUnique({
      where: { mflCode: input.mflCode },
      select: { id: true, name: true },
    });
    if (clash) {
      throw new FacilityError(
        `MFL code ${input.mflCode} is already registered to ${clash.name}`,
        'MFL_CODE_TAKEN',
      );
    }
  }

  const subcounty = await db.subCounty.findUnique({
    where: { id: input.subcountyId },
    select: { countyId: true },
  });
  if (!subcounty) {
    throw new FacilityError('Subcounty not found', 'SUBCOUNTY_NOT_FOUND');
  }
  if (subcounty.countyId !== input.countyId) {
    throw new FacilityError(
      'That subcounty does not belong to the given county',
      'GEOGRAPHY_MISMATCH',
    );
  }

  return db.facility.create({
    data: {
      mflCode: input.mflCode ?? null,
      name: input.name,
      kephLevel: input.kephLevel,
      ownership: input.ownership,
      countyId: input.countyId,
      subcountyId: input.subcountyId,
      wardId: input.wardId ?? null,
      locality: input.locality,
      latitude: lat,
      longitude: lng,
      is24Hour: input.is24Hour ?? false,
      operatingHours: input.operatingHours ?? Prisma.JsonNull,
      bedCapacity: input.bedCapacity ?? null,
      icuBeds: input.icuBeds ?? null,
      maternityBeds: input.maternityBeds ?? null,
      phone: input.phone ?? null,
      email: input.email ?? null,
      licensedUntil: input.licensedUntil ?? null,
      registrationStatus: 'PENDING',
    },
  });
}

/** Ministry approval. The only path from PENDING to ACTIVE. */
export async function approveFacility(db: Db, facilityId: string, ministryUserId: string) {
  const facility = await db.facility.findUnique({
    where: { id: facilityId },
    select: {
      id: true,
      registrationStatus: true,
      pendingAdminPractitionerId: true,
      pendingDirectorPersonId: true,
    },
  });
  if (!facility) throw new FacilityError('Facility not found', 'FACILITY_NOT_FOUND');
  if (facility.registrationStatus === 'ACTIVE') {
    throw new FacilityError('Facility is already active', 'ALREADY_ACTIVE');
  }

  const approved = await db.facility.update({
    where: { id: facilityId },
    data: {
      registrationStatus: 'ACTIVE',
      // Attributed. Approval is what turns unverified ownership paperwork
      // into a facility that can reach patient records; an unattributable
      // approval leaves nobody answerable for that check.
      approvedBy: ministryUserId,
      approvedAt: new Date(),
    },
  });

  /*
   * The first administrator, materialised now.
   *
   * Whoever registered a private facility named themselves here. The
   * affiliation could not be created at registration because an
   * affiliation to a PENDING facility is refused by design — nobody
   * administers a facility the Ministry has not verified. Approval is
   * exactly the moment that verification happens.
   */
  /*
   * The director, made real at the same moment and for the same reason.
   *
   * Held as PENDING since registration because nobody administers a
   * facility the Ministry has not verified. Upserted rather than created:
   * a re-approval of a facility that was suspended and reinstated must not
   * fail on the unique (facility, person) pair.
   */
  if (facility.pendingDirectorPersonId) {
    await db.facilityDirector.upsert({
      where: {
        facilityId_personId: {
          facilityId,
          personId: facility.pendingDirectorPersonId,
        },
      },
      create: {
        facilityId,
        personId: facility.pendingDirectorPersonId,
        role: 'DIRECTOR',
        status: 'ACTIVE',
        // Attributed to the approving registrar. The applicant named
        // themselves; the Ministry is what made it true.
        appointedBy: ministryUserId,
        appointedByKind: 'MINISTRY',
      },
      update: { status: 'ACTIVE', endedAt: null },
    });
    await db.facility.update({
      where: { id: facilityId },
      data: { pendingDirectorPersonId: null },
    });
  }

  if (facility.pendingAdminPractitionerId) {
    await db.affiliation.create({
      data: {
        practitionerId: facility.pendingAdminPractitionerId,
        facilityId,
        role: 'FACILITY_ADMIN',
        // Attributed to the approving registrar, not to the applicant:
        // the Ministry conferred this by approving the application.
        grantedBy: ministryUserId,
        grantedByKind: 'MINISTRY',
        status: 'ACTIVE',
      },
    });
    await db.facility.update({
      where: { id: facilityId },
      data: { pendingAdminPractitionerId: null },
    });
  }

  return approved;
}

// -------------------------------------------------------------- capabilities

export interface ClaimCapabilityInput {
  facilityId: string;
  capabilityCode: string;
  availability?: 'ROUTINE' | 'BUSINESS_HOURS' | 'ON_CALL' | 'REFERRAL_ONLY';
}

/**
 * A facility claims a capability.
 *
 * `minKephLevel` is a sanity bound, not bureaucracy: a dispensary claiming
 * an ICU is a data-entry error, and letting it through would send critically
 * ill patients to a building with no oxygen.
 */
export async function claimCapability(db: Db, input: ClaimCapabilityInput) {
  const facility = await db.facility.findUnique({
    where: { id: input.facilityId },
    select: { id: true, kephLevel: true, name: true },
  });
  if (!facility) throw new FacilityError('Facility not found', 'FACILITY_NOT_FOUND');

  const capability = await db.capability.findUnique({
    where: { code: input.capabilityCode },
    select: { id: true, code: true, labelEn: true, minKephLevel: true },
  });
  if (!capability) {
    throw new FacilityError(
      `Unknown capability '${input.capabilityCode}'. Capabilities come from a ` +
        'controlled vocabulary — free text would break the triage engine.',
      'UNKNOWN_CAPABILITY',
    );
  }

  if (capability.minKephLevel !== null && facility.kephLevel < capability.minKephLevel) {
    throw new FacilityError(
      `${facility.name} is KEPH level ${facility.kephLevel}, but ` +
        `${capability.labelEn} requires at least level ${capability.minKephLevel}`,
      'CAPABILITY_ABOVE_FACILITY_LEVEL',
    );
  }

  return db.facilityCapability.upsert({
    where: {
      facilityId_capabilityId: {
        facilityId: facility.id,
        capabilityId: capability.id,
      },
    },
    create: {
      facilityId: facility.id,
      capabilityId: capability.id,
      availability: input.availability ?? 'ROUTINE',
      status: 'CLAIMED',
      lastConfirmedAt: new Date(),
    },
    update: {
      availability: input.availability ?? 'ROUTINE',
      lastConfirmedAt: new Date(),
    },
  });
}

/** Ministry verification lifts a claim from CLAIMED to VERIFIED. */
export async function verifyCapability(
  db: Db,
  facilityId: string,
  capabilityCode: string,
  ministryUserId: string,
) {
  const capability = await db.capability.findUnique({
    where: { code: capabilityCode },
    select: { id: true },
  });
  if (!capability) throw new FacilityError('Unknown capability', 'UNKNOWN_CAPABILITY');

  return db.facilityCapability.update({
    where: {
      facilityId_capabilityId: { facilityId, capabilityId: capability.id },
    },
    data: {
      status: 'VERIFIED',
      verifiedBy: ministryUserId,
      verifiedAt: new Date(),
      lastConfirmedAt: new Date(),
    },
  });
}

/**
 * Quarterly reconfirmation. This is the routine that keeps the registry
 * honest, and it is the one most likely to be skipped in practice — so the
 * decay is designed to be visible rather than silent.
 */
export async function reconfirmCapabilities(
  db: Db,
  facilityId: string,
  capabilityCodes: string[],
) {
  const caps = await db.capability.findMany({
    where: { code: { in: capabilityCodes } },
    select: { id: true, code: true },
  });

  const unknown = capabilityCodes.filter((c) => !caps.some((k) => k.code === c));
  if (unknown.length) {
    throw new FacilityError(
      `Unknown capabilities: ${unknown.join(', ')}`,
      'UNKNOWN_CAPABILITY',
    );
  }

  const now = new Date();
  await db.facilityCapability.updateMany({
    where: { facilityId, capabilityId: { in: caps.map((c) => c.id) } },
    data: { lastConfirmedAt: now },
  });

  // Anything not reconfirmed is implicitly no longer claimed. Suspend it
  // rather than deleting, so the history of what was claimed survives.
  const dropped = await db.facilityCapability.updateMany({
    where: {
      facilityId,
      capabilityId: { notIn: caps.map((c) => c.id) },
      status: { not: 'SUSPENDED' },
    },
    data: { status: 'SUSPENDED' },
  });

  return { confirmed: caps.length, suspended: dropped.count };
}

// ------------------------------------------------------------------ search

export interface FacilitySearchInput {
  /** Capability codes the facility must ALL have. */
  requiredCapabilities?: string[];
  countyId?: string;
  subcountyId?: string;
  minKephLevel?: number;
  openNow?: boolean;
  /** Rank by distance from here. */
  near?: { latitude: number; longitude: number };
  /** Exclude capability claims older than this. Defaults to EXPIRED_AFTER_DAYS. */
  maxClaimAgeDays?: number;
  limit?: number;
}

export interface FacilityMatch {
  id: string;
  name: string;
  kephLevel: number;
  kephLabel: string;
  countyId: string;
  subcountyId: string;
  locality: string;
  is24Hour: boolean;
  distanceKm: number | null;
  matchedCapabilities: string[];
  staleClaims: string[];
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
}

/** Great-circle distance. Good enough for routing; PostGIS is for polygons. */
export function haversineKm(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Finds facilities matching a capability set.
 *
 * Ranking is deliberately NOT "biggest hospital first". Sending simple cases
 * to Level 6 referrals is exactly what clogs Kenyan hospitals, so among
 * facilities that can treat the case, the nearest appropriate one wins.
 */
export async function findFacilities(
  db: Db,
  input: FacilitySearchInput,
): Promise<FacilityMatch[]> {
  const maxAge = input.maxClaimAgeDays ?? EXPIRED_AFTER_DAYS;
  const cutoff = new Date(Date.now() - maxAge * 86_400_000);
  const required = input.requiredCapabilities ?? [];

  const facilities = await db.facility.findMany({
    where: {
      registrationStatus: 'ACTIVE',
      ...(input.countyId ? { countyId: input.countyId } : {}),
      ...(input.subcountyId ? { subcountyId: input.subcountyId } : {}),
      ...(input.minKephLevel ? { kephLevel: { gte: input.minKephLevel } } : {}),
      ...(input.openNow ? { is24Hour: true } : {}),
      ...(required.length
        ? {
            capabilities: {
              some: {
                capability: { code: { in: required } },
                status: { not: 'SUSPENDED' },
                lastConfirmedAt: { gte: cutoff },
              },
            },
          }
        : {}),
    },
    select: {
      id: true,
      name: true,
      kephLevel: true,
      countyId: true,
      subcountyId: true,
      locality: true,
      latitude: true,
      longitude: true,
      is24Hour: true,
      capabilities: {
        where: { status: { not: 'SUSPENDED' } },
        select: {
          lastConfirmedAt: true,
          status: true,
          capability: { select: { code: true } },
        },
      },
    },
  });

  const now = new Date();
  const matches: FacilityMatch[] = [];

  for (const f of facilities) {
    const usable = f.capabilities.filter(
      (c) => freshnessOf(c.lastConfirmedAt, now) !== 'EXPIRED',
    );
    const codes = new Set(usable.map((c) => c.capability.code));

    // Every required capability must be present — a facility that can do
    // three of four things a case needs is not a match.
    if (!required.every((r) => codes.has(r))) continue;

    const stale = usable
      .filter(
        (c) =>
          required.includes(c.capability.code) &&
          freshnessOf(c.lastConfirmedAt, now) === 'STALE',
      )
      .map((c) => c.capability.code);

    const verifiedCount = usable.filter(
      (c) => required.includes(c.capability.code) && c.status === 'VERIFIED',
    ).length;

    let confidence: FacilityMatch['confidence'] = 'HIGH';
    if (stale.length > 0) confidence = 'LOW';
    else if (required.length > 0 && verifiedCount < required.length) confidence = 'MEDIUM';

    matches.push({
      id: f.id,
      name: f.name,
      kephLevel: f.kephLevel,
      kephLabel: KEPH_LEVELS[f.kephLevel] ?? `Level ${f.kephLevel}`,
      countyId: f.countyId,
      subcountyId: f.subcountyId,
      locality: f.locality,
      is24Hour: f.is24Hour,
      distanceKm: input.near
        ? Math.round(haversineKm(input.near, f) * 10) / 10
        : null,
      matchedCapabilities: required.filter((r) => codes.has(r)),
      staleClaims: stale,
      confidence,
    });
  }

  matches.sort((a, b) => {
    // Fresh claims beat stale ones — routing to a facility whose capability
    // claim has rotted is worse than routing slightly further.
    const conf = { HIGH: 0, MEDIUM: 1, LOW: 2 };
    if (conf[a.confidence] !== conf[b.confidence]) {
      return conf[a.confidence] - conf[b.confidence];
    }
    if (a.distanceKm !== null && b.distanceKm !== null) {
      if (a.distanceKm !== b.distanceKm) return a.distanceKm - b.distanceKm;
    }
    // Then the LOWEST adequate level — do not send simple cases to Level 6.
    return a.kephLevel - b.kephLevel;
  });

  return matches.slice(0, input.limit ?? 10);
}

/**
 * Widens the search when nothing local qualifies: subcounty, then county,
 * then adjacent counties. Returns how far we had to reach, so the citizen
 * can be told plainly why they are being sent further.
 */
export async function findWithWidening(
  db: Db,
  input: FacilitySearchInput & { subcountyId: string; countyId: string },
): Promise<{ scope: 'SUBCOUNTY' | 'COUNTY' | 'NATIONAL'; matches: FacilityMatch[] }> {
  const inSub = await findFacilities(db, input);
  if (inSub.length) return { scope: 'SUBCOUNTY', matches: inSub };

  const inCounty = await findFacilities(db, { ...input, subcountyId: undefined });
  if (inCounty.length) return { scope: 'COUNTY', matches: inCounty };

  const anywhere = await findFacilities(db, {
    ...input,
    subcountyId: undefined,
    countyId: undefined,
  });
  return { scope: 'NATIONAL', matches: anywhere };
}
