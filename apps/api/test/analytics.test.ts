/**
 * PHASE 7 — Ministry analytics.
 *
 * The tests that matter are the disclosure-control ones. A dashboard that
 * merely aggregates is easy; one that cannot leak a small cell by
 * subtraction is the hard part, and it is what lets the Analyst role exist
 * at all.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import 'dotenv/config';
import {
  rollupConditions,
  applySuppression,
  burdenByCounty,
  burdenBySubcounty,
  workforceByCounty,
  careGaps,
  notifiableSignals,
  provenance,
  ageBandOf,
  SUPPRESSION_THRESHOLD,
  TIER3_CHAPTERS,
} from '../src/analytics.js';
import { registerAdult } from '../src/identity.js';
import { registerFacility, approveFacility } from '../src/facility.js';
import { registerPractitioner, grantAffiliation, checkIn } from '../src/practitioner.js';
import { openEncounter, recordDiagnosis } from '../src/clinical.js';

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
});
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const analyst = new pg.Pool({ connectionString: process.env.ANALYST_DATABASE_URL });

const ctx = { countyId: '', subA: '', subB: '' };
let seq = 0;

async function wipe() {
  await owner.query('SET session_replication_role = replica');
  for (const t of [
    'agg_condition_daily', 'recommendation', 'condition', 'medication',
    'allergy', 'encounter', 'access_log', 'break_glass', 'consent_grant',
    'check_in', 'affiliation', 'licence', 'practitioner',
    'facility_capability', 'facility', 'guardianship', 'identifier',
    'account', 'person',
  ]) {
    await owner.query(`DELETE FROM ${t}`);
  }
  await owner.query('SET session_replication_role = origin');
}

beforeAll(async () => {
  if ((await prisma.diagnosisTerm.count()) === 0) {
    throw new Error('Vocabularies not loaded. Run `pnpm seed` first.');
  }
  const county = await prisma.county.upsert({
    where: { code: '904' },
    create: { code: '904', name: 'Kisumu (analytics fixture)' },
    update: {},
  });
  ctx.countyId = county.id;

  const subs = await prisma.subCounty.findMany({ where: { countyId: county.id } });
  const a =
    subs[0] ??
    (await prisma.subCounty.create({
      data: { countyId: county.id, name: 'Central', kind: 'HEALTH_ADMIN' },
    }));
  const b =
    subs[1] ??
    (await prisma.subCounty.create({
      data: { countyId: county.id, name: 'West', kind: 'HEALTH_ADMIN' },
    }));
  ctx.subA = a.id;
  ctx.subB = b.id;
});

beforeEach(async () => {
  await wipe();
});

afterAll(async () => {
  await prisma.$disconnect();
  await owner.end();
  await analyst.end();
});

async function makePatient(subcountyId: string, dob = new Date(Date.UTC(1990, 0, 1))) {
  seq++;
  return registerAdult(prisma, {
    nationalId: `600000${String(seq).padStart(3, '0')}`,
    phone: `07150000${String(seq).padStart(3, '0')}`,
    givenName: `P${seq}`,
    familyName: 'Otieno',
    sexAtBirth: 'FEMALE',
    dateOfBirth: dob,
    countyId: ctx.countyId,
    subcountyId,
    passwordHash: 'argon2id$dummy',
  });
}

async function makeClinician() {
  const person = await makePatient(ctx.subA);
  seq++;
  const { practitioner } = await registerPractitioner(prisma, {
    personId: person.id,
    cadre: 'DOCTOR',
    countyId: ctx.countyId,
    subcountyId: ctx.subA,
    licenceNumber: `KMPDC/2026/A${String(seq).padStart(3, '0')}`,
  });

  const facility = await registerFacility(prisma, {
    name: `Facility ${seq}`,
    kephLevel: 4,
    ownership: 'PUBLIC_MOH',
    countyId: ctx.countyId,
    subcountyId: ctx.subA,
    locality: 'Milimani',
    latitude: -0.0917,
    longitude: 34.768,
  });
  await approveFacility(prisma, facility.id, 'ministry-1');
  await grantAffiliation(prisma, {
    practitionerId: practitioner.id,
    facilityId: facility.id,
    grantedBy: 'ministry-1',
    grantedByKind: 'MINISTRY',
  });
  await checkIn(prisma, { practitionerId: practitioner.id, facilityId: facility.id });
  return { practitioner, facility };
}

/** Records `count` cases of a code, spread across patients. */
async function recordCases(
  practitionerId: string,
  icd11Code: string,
  count: number,
  subcountyId: string,
  opts: { chronic?: boolean } = {},
) {
  for (let i = 0; i < count; i++) {
    const patient = await makePatient(subcountyId);
    const e = await openEncounter(prisma, {
      practitionerId,
      personId: patient.id,
      kind: 'OUTPATIENT',
      chiefComplaint: 'fever',
    });
    await recordDiagnosis(prisma, {
      practitionerId,
      encounterId: e.id,
      icd11Code,
      isChronic: opts.chronic,
    });
  }
}

const window = () => ({
  from: new Date(Date.now() - 86_400_000),
  to: new Date(Date.now() + 86_400_000),
});

// =====================================================================

describe('age banding', () => {
  it('bands ages the way the rollup expects', () => {
    expect(ageBandOf(0.5)).toBe('U1');
    expect(ageBandOf(3)).toBe('1_4');
    expect(ageBandOf(10)).toBe('5_14');
    expect(ageBandOf(20)).toBe('15_24');
    expect(ageBandOf(35)).toBe('25_49');
    expect(ageBandOf(60)).toBe('50_64');
    expect(ageBandOf(80)).toBe('65_PLUS');
  });
});

describe('suppression', () => {
  const baseCell = (caseCount: number, sub: string | null, sex: 'MALE' | 'FEMALE') => ({
    date: new Date('2026-08-01'),
    countyId: 'county-1',
    subcountyId: sub,
    icd11Code: '1F41.0',
    icd11Chapter: '01',
    ageBand: '25_49' as const,
    sex,
    kephLevel: 4,
    caseCount,
    newCaseCount: caseCount,
  });

  it('suppresses any cell below the threshold', () => {
    // Cells in DIFFERENT groups (different codes), so complementary
    // suppression does not apply — this isolates the primary rule.
    const small = { ...baseCell(3, 'sub-b', 'FEMALE'), icd11Code: '1F40.Z' };
    const { cells, primary } = applySuppression([baseCell(50, 'sub-a', 'FEMALE'), small]);

    expect(primary).toBe(1);
    expect(cells.find((c) => c.icd11Code === '1F40.Z')?.suppressed).toBe(true);
    expect(cells.find((c) => c.icd11Code === '1F41.0')?.suppressed).toBe(false);
  });

  it('covers the survivor when a two-cell group has one hidden', () => {
    // Two cells sharing a total, one below threshold: publishing the other
    // alongside the total would give the hidden one away exactly.
    const { cells, complementary } = applySuppression([
      baseCell(50, 'sub-a', 'FEMALE'),
      baseCell(3, 'sub-b', 'FEMALE'),
    ]);
    expect(complementary).toBe(1);
    expect(cells.every((c) => c.suppressed)).toBe(true);
  });

  it('THE SUBTRACTION ATTACK — a lone suppressed cell gets cover', () => {
    // Three cells, one below threshold. Publishing the other two alongside a
    // total would let anyone recover the hidden one by subtraction.
    const { cells, primary, complementary } = applySuppression([
      baseCell(100, 'sub-a', 'FEMALE'),
      baseCell(40, 'sub-b', 'FEMALE'),
      baseCell(2, 'sub-c', 'FEMALE'),
    ]);

    expect(primary).toBe(1);
    expect(complementary).toBe(1);

    // Two cells are now hidden, so neither is recoverable.
    const hidden = cells.filter((c) => c.suppressed);
    expect(hidden).toHaveLength(2);
    expect(hidden.map((c) => c.suppressionReason).sort()).toEqual([
      'COMPLEMENTARY',
      'PRIMARY',
    ]);
    // The cover is the SMALLEST survivor — least information lost.
    expect(cells.find((c) => c.suppressionReason === 'COMPLEMENTARY')?.caseCount).toBe(40);
  });

  it('adds no cover when two cells are already hidden', () => {
    const { complementary } = applySuppression([
      baseCell(100, 'sub-a', 'FEMALE'),
      baseCell(4, 'sub-b', 'FEMALE'),
      baseCell(2, 'sub-c', 'FEMALE'),
    ]);
    // Two hidden already — nothing is uniquely recoverable.
    expect(complementary).toBe(0);
  });

  it('adds no cover to a group of one', () => {
    const { complementary } = applySuppression([baseCell(3, 'sub-a', 'FEMALE')]);
    expect(complementary).toBe(0);
  });

  it('suppresses at exactly the threshold boundary', () => {
    const below = applySuppression([baseCell(SUPPRESSION_THRESHOLD - 1, 'a', 'FEMALE')]);
    const at = applySuppression([baseCell(SUPPRESSION_THRESHOLD, 'a', 'FEMALE')]);
    expect(below.cells[0].suppressed).toBe(true);
    expect(at.cells[0].suppressed).toBe(false);
  });
});

describe('the rollup', () => {
  it('aggregates cases and stores ZERO for suppressed cells', async () => {
    const { practitioner } = await makeClinician();
    await recordCases(practitioner.id, '1F41.0', 12, ctx.subA);
    await recordCases(practitioner.id, '1F41.0', 3, ctx.subB);

    const w = window();
    const result = await rollupConditions(prisma, w);
    expect(result.cellsWritten).toBeGreaterThan(0);
    expect(result.primarySuppressed).toBeGreaterThanOrEqual(1);

    // The suppressed row must not carry the true count — an endpoint that
    // forgot to check `suppressed` would otherwise leak it.
    const suppressed = await prisma.aggConditionDaily.findMany({
      where: { suppressed: true },
    });
    for (const row of suppressed) {
      expect(row.caseCount).toBe(0);
      expect(row.newCaseCount).toBe(0);
    }
  });

  it('is idempotent — a rerun replaces rather than doubles', async () => {
    const { practitioner } = await makeClinician();
    await recordCases(practitioner.id, '1F41.0', 12, ctx.subA);

    const w = window();
    await rollupConditions(prisma, w);
    const first = await prisma.aggConditionDaily.count();

    await rollupConditions(prisma, w);
    const second = await prisma.aggConditionDaily.count();

    expect(second).toBe(first);
  });

  it('excludes suspected diagnoses from case counts', async () => {
    const { practitioner } = await makeClinician();

    // Twelve confirmed, twelve suspected.
    await recordCases(practitioner.id, '1F41.0', 12, ctx.subA);
    for (let i = 0; i < 12; i++) {
      const patient = await makePatient(ctx.subA);
      const e = await openEncounter(prisma, {
        practitionerId: practitioner.id,
        personId: patient.id,
        kind: 'OUTPATIENT',
        chiefComplaint: 'fever',
      });
      await recordDiagnosis(prisma, {
        practitionerId: practitioner.id,
        encounterId: e.id,
        icd11Code: '1F41.0',
        clinicalStatus: 'SUSPECTED',
      });
    }

    await rollupConditions(prisma, window());
    const burden = await burdenByCounty(prisma, window());
    // Counting suspected cases would inflate every outbreak signal.
    expect(burden[0].cases).toBe(12);
  });

  it('THE TIER 3 GEOGRAPHY RULE — restricted conditions never go below county', async () => {
    const { practitioner } = await makeClinician();
    await recordCases(practitioner.id, '1C62.Z', 15, ctx.subA); // HIV

    await rollupConditions(prisma, window());

    const rows = await prisma.aggConditionDaily.findMany({
      where: { icd11Chapter: { in: [...TIER3_CHAPTERS] } },
    });
    expect(rows.length).toBeGreaterThan(0);
    // Small geography plus stigmatised condition is where re-identification
    // actually happens.
    for (const row of rows) {
      expect(row.subcountyId).toBeNull();
    }
  });

  it('refuses a subcounty breakdown of a restricted chapter', async () => {
    await expect(
      burdenBySubcounty(prisma, {
        countyId: ctx.countyId,
        chapter: 'TIER3_HIV',
        ...window(),
      }),
    ).rejects.toThrow(/county level only/i);
  });

  it('reports completeness alongside the count', async () => {
    const { practitioner } = await makeClinician();
    // A second facility that registers but never reports.
    const silent = await registerFacility(prisma, {
      name: 'Silent Dispensary',
      kephLevel: 2,
      ownership: 'PUBLIC_MOH',
      countyId: ctx.countyId,
      subcountyId: ctx.subB,
      locality: 'Nyalenda',
      latitude: -0.12,
      longitude: 34.76,
    });
    await approveFacility(prisma, silent.id, 'ministry-1');

    await recordCases(practitioner.id, '1F41.0', 12, ctx.subA);
    await rollupConditions(prisma, window());

    const burden = await burdenByCounty(prisma, window());
    // A rise in cases and a rise in reporting look identical without this.
    expect(burden[0].facilitiesExpected).toBe(2);
    expect(burden[0].facilitiesReporting).toBe(1);
    expect(burden[0].completenessPercent).toBe(50);
  });
});

describe('the analyst separation', () => {
  it('THE HARD BOUNDARY — the analyst role cannot reach clinical data', async () => {
    const { practitioner } = await makeClinician();
    await recordCases(practitioner.id, '1F41.0', 12, ctx.subA);
    await rollupConditions(prisma, window());

    // Every table the dashboard might be tempted to query directly.
    for (const table of [
      'person',
      'encounter',
      'condition',
      'allergy',
      'medication',
      'access_log',
      'break_glass',
    ]) {
      await expect(analyst.query(`SELECT * FROM ${table} LIMIT 1`)).rejects.toThrow(
        /permission denied/i,
      );
    }

    // But the aggregates it exists to serve are readable.
    const { rows } = await analyst.query(
      `SELECT count(*)::int n FROM agg_condition_daily`,
    );
    expect(rows[0].n).toBeGreaterThan(0);
  });

  it('serves suppressed cells as zero even to a raw analyst query', async () => {
    const { practitioner } = await makeClinician();
    await recordCases(practitioner.id, '1F41.0', 3, ctx.subA);
    await rollupConditions(prisma, window());

    const { rows } = await analyst.query(
      `SELECT case_count FROM agg_condition_daily WHERE suppressed = true`,
    );
    // Suppression is stored, not rendered — a raw SQL query cannot bypass it.
    for (const r of rows) expect(r.case_count).toBe(0);
  });
});

describe('the views that only a linked record can produce', () => {
  it('reports workforce from actual check-ins, not an establishment list', async () => {
    await makeClinician();
    await makeClinician();

    const workforce = await workforceByCounty(prisma, {
      since: new Date(Date.now() - 86_400_000),
    });
    const county = workforce.find((w) => w.countyId === ctx.countyId);
    expect(county?.activeClinicians).toBe(2);
  });

  it('finds chronic patients lost to follow-up', async () => {
    const { practitioner } = await makeClinician();
    await recordCases(practitioner.id, '5A11', 3, ctx.subA, { chronic: true });

    // Everyone was seen today, so nobody is overdue yet.
    expect(await careGaps(prisma)).toEqual([]);

    // Eighteen months on, all three are lost to follow-up.
    const gaps = await careGaps(prisma, {
      asOf: new Date(Date.now() + 550 * 86_400_000),
    });
    expect(gaps.find((g) => g.icd11Code === '5A11')?.lostToFollowUp).toBe(3);
  });

  it('raises a signal for a notifiable disease without being asked', async () => {
    const { practitioner } = await makeClinician();
    await recordCases(practitioner.id, '1A00', 6, ctx.subA); // cholera

    const signals = await notifiableSignals(prisma, window());
    const cholera = signals.find((s) => s.icd11Code === '1A00');
    // Manual notifiable-disease reporting is under-complied with everywhere,
    // which is exactly why this cannot depend on a clinician remembering.
    expect(cholera?.cases).toBe(6);
    expect(cholera?.title).toMatch(/cholera/i);
  });

  it('does not raise signals for ordinary conditions', async () => {
    const { practitioner } = await makeClinician();
    await recordCases(practitioner.id, 'ME84.2', 8, ctx.subA); // back pain

    const signals = await notifiableSignals(prisma, window());
    expect(signals.find((s) => s.icd11Code === 'ME84.2')).toBeUndefined();
  });
});

describe('provenance', () => {
  it('states what was counted, from how many facilities, and when', async () => {
    const { practitioner } = await makeClinician();
    await recordCases(practitioner.id, '1F41.0', 12, ctx.subA);
    await rollupConditions(prisma, window());

    const p = await provenance(prisma, window());
    // A national health figure with no denominator is one someone misquotes.
    expect(p.facilitiesReporting).toBe(1);
    expect(p.facilitiesRegistered).toBe(1);
    expect(p.completenessPercent).toBe(100);
    expect(p.suppressionThreshold).toBe(SUPPRESSION_THRESHOLD);
    expect(p.lastRollupDate).not.toBeNull();
    expect(p.denominatorNote).toMatch(/census denominators/i);
  });
});
