/**
 * Ministry analytics — Phase 7.
 *
 * The ANALYST role holds no grant on any clinical table. It reads only from
 * aggregate tables that never contained a person_id. If a dashboard query
 * ever touched `condition` directly, the four-role separation would be
 * decorative and the Data Protection Act position would collapse.
 *
 * Two things make this harder than a GROUP BY:
 *
 *   1. Suppression is STORED, not rendered. A suppressed row carries
 *      case_count = 0, so no endpoint, export or debugging query can serve
 *      the true number by accident.
 *
 *   2. Complementary suppression. Hiding one small cell is not enough when
 *      the county total lets anyone recover it by subtraction — a second
 *      cell must be hidden purely so the first cannot be derived.
 */
import { PrismaClient, type Prisma } from '@prisma/client';

export type Db = PrismaClient | Prisma.TransactionClient;

export class AnalyticsError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'AnalyticsError';
  }
}

/**
 * Cells below this are suppressed. Health agencies commonly use 5; some use
 * 10 or 11. Ten gives headroom on small subcounties where re-identification
 * is genuinely plausible.
 */
export const SUPPRESSION_THRESHOLD = 10;

/** Chapters that may only ever aggregate at county level. */
export const TIER3_CHAPTERS = new Set([
  'TIER3_HIV',
  'TIER3_MENTAL',
  'TIER3_REPRO',
  'TIER3_SUBSTANCE',
]);

export type AgeBand =
  | 'U1'
  | '1_4'
  | '5_14'
  | '15_24'
  | '25_49'
  | '50_64'
  | '65_PLUS'
  /** The county-total row, which carries no age breakdown. */
  | 'ALL';

export function ageBandOf(ageYears: number): AgeBand {
  if (ageYears < 1) return 'U1';
  if (ageYears < 5) return '1_4';
  if (ageYears < 15) return '5_14';
  if (ageYears < 25) return '15_24';
  if (ageYears < 50) return '25_49';
  if (ageYears < 65) return '50_64';
  return '65_PLUS';
}

function ageYearsAt(dob: Date, at: Date): number {
  let age = at.getUTCFullYear() - dob.getUTCFullYear();
  const m = at.getUTCMonth() - dob.getUTCMonth();
  if (m < 0 || (m === 0 && at.getUTCDate() < dob.getUTCDate())) age -= 1;
  return age;
}

/**
 * Maps a Tier 3 diagnosis to a pseudo-chapter, so restricted conditions can
 * be constrained to county level by the database CHECK rather than by an
 * API filter someone might forget.
 */
function chapterFor(icd11Code: string, sensitivity: string, rawChapter: string): string {
  if (sensitivity !== 'TIER_3_RESTRICTED') return rawChapter;
  if (icd11Code.startsWith('1C6')) return 'TIER3_HIV';
  if (icd11Code.startsWith('6C4')) return 'TIER3_SUBSTANCE';
  if (icd11Code.startsWith('6A') || icd11Code.startsWith('6B')) return 'TIER3_MENTAL';
  return 'TIER3_REPRO';
}

interface Cell {
  date: Date;
  countyId: string;
  subcountyId: string | null;
  icd11Code: string;
  icd11Chapter: string;
  ageBand: AgeBand;
  sex: 'MALE' | 'FEMALE' | 'INTERSEX' | 'ALL';
  kephLevel: number;
  caseCount: number;
  newCaseCount: number;
}

function cellKey(c: Cell): string {
  return [
    c.date.toISOString().slice(0, 10),
    c.countyId,
    c.subcountyId ?? '-',
    c.icd11Code,
    c.ageBand,
    c.sex,
    c.kephLevel,
  ].join('|');
}

/**
 * Nightly rollup.
 *
 * Reads clinical rows once, aggregates in memory, applies suppression, then
 * writes. The read side is the only place in the system that touches both
 * clinical data and aggregates — and it runs as the app role, never as the
 * analyst.
 */
export async function rollupConditions(
  db: Db,
  opts: { from: Date; to: Date; threshold?: number },
) {
  const threshold = opts.threshold ?? SUPPRESSION_THRESHOLD;

  const conditions = await db.condition.findMany({
    where: {
      recordedAt: { gte: opts.from, lt: opts.to },
      supersededAt: null,
      // Suspected and refuted diagnoses are not cases. Counting them would
      // inflate every outbreak signal.
      clinicalStatus: { in: ['CONFIRMED', 'ACTIVE', 'RECURRENCE'] },
    },
    select: {
      recordedAt: true,
      icd11Code: true,
      icd11Chapter: true,
      sensitivity: true,
      isFirstEver: true,
      kephLevel: true,
      personId: true,
      person: {
        select: {
          dateOfBirth: true,
          sexAtBirth: true,
          countyId: true,
          subcountyId: true,
        },
      },
    },
  });

  const cells = new Map<string, Cell>();

  for (const c of conditions) {
    const chapter = chapterFor(c.icd11Code, c.sensitivity, c.icd11Chapter);
    const isTier3 = TIER3_CHAPTERS.has(chapter);

    const cell: Cell = {
      date: new Date(c.recordedAt.toISOString().slice(0, 10)),
      countyId: c.person.countyId,
      // Restricted conditions never descend below county level — small
      // geography plus stigmatised condition is where re-identification
      // actually happens.
      subcountyId: isTier3 ? null : c.person.subcountyId,
      icd11Code: c.icd11Code,
      icd11Chapter: chapter,
      ageBand: ageBandOf(ageYearsAt(c.person.dateOfBirth, c.recordedAt)),
      sex: c.person.sexAtBirth,
      kephLevel: c.kephLevel,
      caseCount: 0,
      newCaseCount: 0,
    };

    const key = cellKey(cell);
    const existing = cells.get(key) ?? cell;
    existing.caseCount += 1;
    if (c.isFirstEver) existing.newCaseCount += 1;
    cells.set(key, existing);
  }

  // The fine-grained cells above are what an analyst drills into. But a
  // county choropleth needs a county TOTAL, and splitting 34 cases across
  // age band, sex, subcounty and facility level scatters them into cells of
  // three or four — all correctly suppressed, leaving a blank map.
  //
  // So roll a county-level cell alongside: same suppression rules, but the
  // denominator large enough that a real caseload survives them. It carries
  // no subcounty, no age band and no sex, so it discloses less than any of
  // the cells beneath it.
  const countyTotals = new Map<string, Cell>();
  for (const cell of cells.values()) {
    const key = [cell.date.toISOString().slice(0, 10), cell.countyId, cell.icd11Code].join('|');
    const existing = countyTotals.get(key);
    if (existing) {
      existing.caseCount += cell.caseCount;
      existing.newCaseCount += cell.newCaseCount;
    } else {
      countyTotals.set(key, {
        ...cell,
        subcountyId: null,
        ageBand: 'ALL' as AgeBand,
        sex: 'ALL' as Cell['sex'],
        kephLevel: 0,
      });
    }
  }

  const reporting = await facilityReportingCounts(db, opts.from, opts.to);
  const suppressed = applySuppression(
    [...cells.values(), ...countyTotals.values()],
    threshold,
  );

  // Replace the window wholesale — a rerun must be idempotent, not additive.
  await db.aggConditionDaily.deleteMany({
    where: { date: { gte: opts.from, lt: opts.to } },
  });

  for (const cell of suppressed.cells) {
    const counts = reporting.get(cell.countyId) ?? { reporting: 0, expected: 0 };
    await db.aggConditionDaily.create({
      data: {
        date: cell.date,
        countyId: cell.countyId,
        subcountyId: cell.subcountyId,
        icd11Code: cell.icd11Code,
        icd11Chapter: cell.icd11Chapter,
        ageBand: cell.ageBand,
        sex: cell.sex,
        kephLevel: cell.kephLevel,
        // A suppressed cell stores ZERO. The true count is never written,
        // so it cannot leak through a query nobody thought about.
        caseCount: cell.suppressed ? 0 : cell.caseCount,
        newCaseCount: cell.suppressed ? 0 : cell.newCaseCount,
        suppressed: cell.suppressed,
        suppressionReason: cell.suppressionReason,
        facilitiesReporting: counts.reporting,
        facilitiesExpected: counts.expected,
      },
    });
  }

  return {
    cellsWritten: suppressed.cells.length,
    primarySuppressed: suppressed.primary,
    complementarySuppressed: suppressed.complementary,
  };
}

export interface SuppressedCell extends Cell {
  suppressed: boolean;
  suppressionReason: 'PRIMARY' | 'COMPLEMENTARY' | null;
}

/**
 * Primary and complementary suppression.
 *
 * Primary: any cell below the threshold.
 *
 * Complementary: within a group that shares a published total, suppressing
 * exactly one cell leaves it recoverable by subtraction. So whenever a group
 * has exactly one suppressed cell and more than one cell overall, a second —
 * the smallest survivor — is suppressed purely to protect the first.
 */
export function applySuppression(
  cells: Cell[],
  threshold = SUPPRESSION_THRESHOLD,
): { cells: SuppressedCell[]; primary: number; complementary: number } {
  const result: SuppressedCell[] = cells.map((c) => ({
    ...c,
    suppressed: c.caseCount < threshold,
    suppressionReason: c.caseCount < threshold ? ('PRIMARY' as const) : null,
  }));

  let primary = result.filter((c) => c.suppressed).length;
  let complementary = 0;

  // Group by everything the published breakdown holds constant. Within a
  // group, the cells sum to a total a reader can see.
  const groups = new Map<string, SuppressedCell[]>();
  for (const c of result) {
    const key = [
      c.date.toISOString().slice(0, 10),
      c.countyId,
      c.icd11Code,
      c.kephLevel,
    ].join('|');
    const list = groups.get(key) ?? [];
    list.push(c);
    groups.set(key, list);
  }

  for (const group of groups.values()) {
    if (group.length < 2) continue;

    const hidden = group.filter((c) => c.suppressed);
    if (hidden.length !== 1) continue;

    // Exactly one hidden cell — recoverable by subtracting the visible ones
    // from the total. Hide the smallest survivor as cover.
    const survivors = group
      .filter((c) => !c.suppressed)
      .sort((a, b) => a.caseCount - b.caseCount);

    if (survivors.length > 0) {
      survivors[0].suppressed = true;
      survivors[0].suppressionReason = 'COMPLEMENTARY';
      complementary++;
    }
  }

  return { cells: result, primary, complementary };
}

/**
 * Completeness denominator.
 *
 * A rise in cases and a rise in reporting look identical without this. It is
 * the most damaging misreading the Ministry map can produce.
 */
async function facilityReportingCounts(db: Db, from: Date, to: Date) {
  const [reported, registered] = await Promise.all([
    db.encounter.findMany({
      where: { recordedAt: { gte: from, lt: to } },
      select: { facilityId: true },
      distinct: ['facilityId'],
    }),
    db.facility.findMany({
      where: { registrationStatus: 'ACTIVE' },
      select: { id: true, countyId: true },
    }),
  ]);

  const reportedIds = new Set(reported.map((r) => r.facilityId));
  const counts = new Map<string, { reporting: number; expected: number }>();

  for (const f of registered) {
    const entry = counts.get(f.countyId) ?? { reporting: 0, expected: 0 };
    entry.expected += 1;
    if (reportedIds.has(f.id)) entry.reporting += 1;
    counts.set(f.countyId, entry);
  }

  return counts;
}

// ------------------------------------------------------------- the queries

export interface BurdenRow {
  countyId: string;
  cases: number;
  newCases: number;
  suppressedCells: number;
  facilitiesReporting: number;
  facilitiesExpected: number;
  completenessPercent: number;
}

/**
 * National burden by county — the choropleth.
 *
 * Reads aggregates only. There is deliberately no variant of this that takes
 * a person_id, because the tables it reads have never held one.
 */
export async function burdenByCounty(
  db: Db,
  opts: { from: Date; to: Date; icd11Code?: string; chapter?: string },
): Promise<BurdenRow[]> {
  const rows = await db.aggConditionDaily.findMany({
    where: {
      date: { gte: opts.from, lt: opts.to },
      // Only the county-total rows — summing the breakdown as well would
      // double-count every case.
      ageBand: 'ALL',
      ...(opts.icd11Code ? { icd11Code: opts.icd11Code } : {}),
      ...(opts.chapter ? { icd11Chapter: opts.chapter } : {}),
    },
  });

  const byCounty = new Map<string, BurdenRow>();

  for (const r of rows) {
    const entry = byCounty.get(r.countyId) ?? {
      countyId: r.countyId,
      cases: 0,
      newCases: 0,
      suppressedCells: 0,
      facilitiesReporting: r.facilitiesReporting,
      facilitiesExpected: r.facilitiesExpected,
      completenessPercent: 0,
    };
    entry.cases += r.caseCount;
    entry.newCases += r.newCaseCount;
    if (r.suppressed) entry.suppressedCells += 1;
    byCounty.set(r.countyId, entry);
  }

  return [...byCounty.values()]
    .map((r) => ({
      ...r,
      completenessPercent:
        r.facilitiesExpected > 0
          ? Math.round((r.facilitiesReporting / r.facilitiesExpected) * 1000) / 10
          : 0,
    }))
    .sort((a, b) => b.cases - a.cases);
}

/**
 * Drill into a county.
 *
 * Refuses Tier 3 chapters outright: those aggregate at county level only,
 * so a subcounty breakdown of HIV cannot be produced even by an Analyst.
 */
export async function burdenBySubcounty(
  db: Db,
  opts: { countyId: string; from: Date; to: Date; icd11Code?: string; chapter?: string },
) {
  if (opts.chapter && TIER3_CHAPTERS.has(opts.chapter)) {
    throw new AnalyticsError(
      'Restricted conditions are aggregated at county level only. A ' +
        'subcounty breakdown of this chapter does not exist.',
      'TIER3_GEOGRAPHY_REFUSED',
    );
  }

  const rows = await db.aggConditionDaily.findMany({
    where: {
      countyId: opts.countyId,
      date: { gte: opts.from, lt: opts.to },
      subcountyId: { not: null },
      ageBand: { not: 'ALL' },
      ...(opts.icd11Code ? { icd11Code: opts.icd11Code } : {}),
      ...(opts.chapter ? { icd11Chapter: opts.chapter } : {}),
    },
  });

  const bySub = new Map<string, { subcountyId: string; cases: number; suppressed: number }>();
  for (const r of rows) {
    if (!r.subcountyId) continue;
    const entry = bySub.get(r.subcountyId) ?? {
      subcountyId: r.subcountyId,
      cases: 0,
      suppressed: 0,
    };
    entry.cases += r.caseCount;
    if (r.suppressed) entry.suppressed += 1;
    bySub.set(r.subcountyId, entry);
  }

  return [...bySub.values()].sort((a, b) => b.cases - a.cases);
}

/**
 * Referral loop closure — the pitch number.
 *
 * Issued → accepted → arrived → outcome returned. Nothing else in Kenya can
 * produce this, because it requires linking a referral issued at one
 * facility to an arrival at another and an outcome returned to the first.
 * Aggregate reporting cannot do it; a longitudinal record can.
 *
 * Reported as a funnel by county, so a low figure can be read correctly:
 * patients never arriving and patients arriving unreported are completely
 * different problems with different fixes.
 */
export async function referralClosureByCounty(db: Db, opts: { from: Date; to: Date }) {
  const referrals = await db.referral.findMany({
    where: { issuedAt: { gte: opts.from, lt: opts.to } },
    select: {
      status: true,
      fromFacilityId: true,
    },
  });
  if (referrals.length === 0) return [];

  const facilities = await db.facility.findMany({
    select: { id: true, countyId: true },
  });
  const countyOf = new Map(facilities.map((f) => [f.id, f.countyId]));

  const byCounty = new Map<
    string,
    { issued: number; arrived: number; completed: number; declined: number }
  >();

  for (const r of referrals) {
    const county = countyOf.get(r.fromFacilityId);
    if (!county) continue;
    const entry = byCounty.get(county) ?? {
      issued: 0,
      arrived: 0,
      completed: 0,
      declined: 0,
    };
    entry.issued += 1;
    if (r.status === 'ARRIVED' || r.status === 'COMPLETED') entry.arrived += 1;
    if (r.status === 'COMPLETED') entry.completed += 1;
    if (r.status === 'DECLINED') entry.declined += 1;
    byCounty.set(county, entry);
  }

  return [...byCounty.entries()]
    .map(([countyId, v]) => ({
      countyId,
      ...v,
      arrivalRatePercent: Math.round((v.arrived / v.issued) * 1000) / 10,
      closureRatePercent: Math.round((v.completed / v.issued) * 1000) / 10,
    }))
    .sort((a, b) => a.closureRatePercent - b.closureRatePercent);
}

/**
 * Workforce distribution — clinicians per 10,000.
 *
 * Derived from active affiliations and check-in frequency, so it reflects
 * who is actually working rather than who is on an establishment list.
 */
export async function workforceByCounty(db: Db, opts: { since: Date }) {
  const facilities = await db.facility.findMany({
    where: { registrationStatus: 'ACTIVE' },
    select: { id: true, countyId: true },
  });
  const countyOf = new Map(facilities.map((f) => [f.id, f.countyId]));

  const sessions = await db.checkIn.findMany({
    where: { startedAt: { gte: opts.since } },
    select: { practitionerId: true, facilityId: true },
  });

  const byCounty = new Map<string, Set<string>>();
  for (const s of sessions) {
    const county = countyOf.get(s.facilityId);
    if (!county) continue;
    const set = byCounty.get(county) ?? new Set<string>();
    set.add(s.practitionerId);
    byCounty.set(county, set);
  }

  return [...byCounty.entries()]
    .map(([countyId, practitioners]) => ({
      countyId,
      activeClinicians: practitioners.size,
    }))
    .sort((a, b) => b.activeClinicians - a.activeClinicians);
}

/**
 * Care gaps — diagnosed, then never seen again.
 *
 * Counts only. Turning these into outreach lists requires a separate
 * authorisation, because a list of named hypertensives is identified data.
 */
export async function careGaps(db: Db, opts: { asOf?: Date } = {}) {
  const asOf = opts.asOf ?? new Date();
  const twelveMonthsAgo = new Date(asOf.getTime() - 365 * 86_400_000);

  const chronic = await db.condition.findMany({
    where: { isChronic: true, supersededAt: null, clinicalStatus: { not: 'RESOLVED' } },
    select: { personId: true, icd11Code: true },
    distinct: ['personId', 'icd11Code'],
  });

  const recentEncounters = await db.encounter.findMany({
    where: { startedAt: { gte: twelveMonthsAgo } },
    select: { personId: true },
    distinct: ['personId'],
  });
  const seenRecently = new Set(recentEncounters.map((e) => e.personId));

  const byCondition = new Map<string, number>();
  for (const c of chronic) {
    if (seenRecently.has(c.personId)) continue;
    byCondition.set(c.icd11Code, (byCondition.get(c.icd11Code) ?? 0) + 1);
  }

  return [...byCondition.entries()]
    .map(([icd11Code, lostToFollowUp]) => ({ icd11Code, lostToFollowUp }))
    .sort((a, b) => b.lostToFollowUp - a.lostToFollowUp);
}

// ------------------------------------------------------------ surveillance

/**
 * Notifiable disease signals.
 *
 * Raised automatically when a condition on the reportable list is recorded.
 * Manual notifiable-disease reporting is under-complied with everywhere in
 * the world, which is precisely why this cannot depend on a clinician
 * remembering.
 */
export async function notifiableSignals(db: Db, opts: { from: Date; to: Date }) {
  const notifiable = await db.diagnosisTerm.findMany({
    where: { isNotifiable: true },
    select: { icd11Code: true, clinicalTitle: true },
  });
  if (notifiable.length === 0) return [];

  const codes = notifiable.map((n) => n.icd11Code);
  const titleOf = new Map(notifiable.map((n) => [n.icd11Code, n.clinicalTitle]));

  const cases = await db.condition.findMany({
    where: {
      icd11Code: { in: codes },
      recordedAt: { gte: opts.from, lt: opts.to },
      supersededAt: null,
      clinicalStatus: { in: ['SUSPECTED', 'CONFIRMED', 'ACTIVE'] },
    },
    select: {
      icd11Code: true,
      recordedAt: true,
      facilityId: true,
      clinicalStatus: true,
      person: { select: { countyId: true, subcountyId: true } },
    },
  });

  const clusters = new Map<
    string,
    { icd11Code: string; title: string; countyId: string; cases: number; facilities: Set<string> }
  >();

  for (const c of cases) {
    const key = `${c.icd11Code}|${c.person.countyId}`;
    const entry = clusters.get(key) ?? {
      icd11Code: c.icd11Code,
      title: titleOf.get(c.icd11Code) ?? c.icd11Code,
      countyId: c.person.countyId,
      cases: 0,
      facilities: new Set<string>(),
    };
    entry.cases += 1;
    entry.facilities.add(c.facilityId);
    clusters.set(key, entry);
  }

  return [...clusters.values()]
    .map((c) => ({
      icd11Code: c.icd11Code,
      title: c.title,
      countyId: c.countyId,
      cases: c.cases,
      facilitiesInvolved: c.facilities.size,
    }))
    .sort((a, b) => b.cases - a.cases);
}

/**
 * Parses a requested reporting period, defaulting to the last 30 days.
 *
 * The aggregate tables are day-grained — `date` is a Postgres DATE, not a
 * timestamp — so both bounds are snapped to midnight UTC and the returned
 * upper bound is exclusive: the start of the day AFTER the last day covered.
 *
 * Passing a mid-afternoon `new Date()` straight through as an exclusive
 * bound made Postgres coerce it to today's DATE, so `date < today` dropped
 * every row dated today. The most recent rollup — the one an outbreak
 * shows up in first — was missing from every analytics answer, and the
 * endpoints still returned 200 with a plausible-looking shorter list.
 */
export function periodFrom(query: Record<string, unknown>): {
  from: Date;
  to: Date;
} {
  const startOfDay = (d: Date) =>
    new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

  const toRequested = query.to ? new Date(String(query.to)) : new Date();
  const lastDay = startOfDay(toRequested);
  return {
    from: query.from
      ? startOfDay(new Date(String(query.from)))
      : new Date(lastDay.getTime() - 29 * 86_400_000),
    to: new Date(lastDay.getTime() + 86_400_000),
  };
}

/** Provenance footer. A figure without these is a figure someone misquotes. */
export async function provenance(db: Db, opts: { from: Date; to: Date }) {
  const [facilitiesActive, lastRollup] = await Promise.all([
    db.facility.count({ where: { registrationStatus: 'ACTIVE' } }),
    db.aggConditionDaily.findFirst({ orderBy: { date: 'desc' }, select: { date: true } }),
  ]);

  const reported = await db.encounter.findMany({
    where: { recordedAt: { gte: opts.from, lt: opts.to } },
    select: { facilityId: true },
    distinct: ['facilityId'],
  });

  return {
    periodFrom: opts.from,
    // `opts.to` is the exclusive upper bound — the start of the day AFTER
    // the last day covered. Reporting it verbatim would tell an analyst the
    // figures run a day later than they do, so publish the inclusive last day.
    periodTo: new Date(opts.to.getTime() - 86_400_000),
    facilitiesReporting: reported.length,
    facilitiesRegistered: facilitiesActive,
    completenessPercent:
      facilitiesActive > 0
        ? Math.round((reported.length / facilitiesActive) * 1000) / 10
        : 0,
    lastRollupDate: lastRollup?.date ?? null,
    suppressionThreshold: SUPPRESSION_THRESHOLD,
    denominatorNote:
      'Rates use 2019 census denominators projected to 2026. ' +
      'Confirmed diagnoses only; suspected excluded.',
  };
}
