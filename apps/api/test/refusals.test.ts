/**
 * PHASE 0 EXIT CRITERION — the twelve refusals.
 *
 * Each test performs a forbidden operation and asserts the DATABASE rejects
 * it. Not that the application declines to try — that the database refuses
 * even when asked directly.
 *
 * These are the spine of NHP. A skipped test here is a national data breach
 * later. None may be marked pending to unblock a deploy.
 *
 *   pnpm test
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import 'dotenv/config';

const OWNER = process.env.DATABASE_URL!;
const APP = process.env.APP_DATABASE_URL!;
const ANALYST = process.env.ANALYST_DATABASE_URL!;

/** Connects as the application role — the one with restricted grants. */
const app = new pg.Pool({ connectionString: APP });
/** Connects as the owner — used only to build fixtures. */
const owner = new pg.Pool({ connectionString: OWNER });

/** Asserts a query fails, and returns the error for message inspection. */
async function expectRejection(
  pool: pg.Pool,
  sql: string,
  params: unknown[] = [],
): Promise<Error> {
  try {
    await pool.query(sql, params);
  } catch (err) {
    return err as Error;
  }
  throw new Error(`Expected the database to reject this, but it succeeded:\n  ${sql}`);
}

// Fixture ids, populated in beforeAll.
const f = {
  countyId: '',
  subcountyId: '',
  personId: '',
  otherPersonId: '',
  practitionerId: '',
  facilityId: '',
  otherFacilityId: '',
  affiliationId: '',
  checkInId: '',
  expiredCheckInId: '',
  licenceNumber: 'KMPDC/TEST/0001',
  expiredLicence: 'KMPDC/TEST/EXPIRED',
  encounterId: '',
  conditionId: '',
};

beforeAll(async () => {
  const q = (sql: string, p: unknown[] = []) => owner.query(sql, p);

  // Clean slate, in dependency order.
  await q(`SET session_replication_role = replica`);
  for (const t of [
    'condition', 'medication', 'allergy', 'encounter', 'access_log',
    'break_glass', 'consent_grant', 'check_in', 'affiliation', 'licence',
    'practitioner', 'facility_capability', 'facility', 'guardianship',
    'identifier', 'account', 'merge_request', 'agg_condition_daily',
    'person', 'ward', 'subcounty', 'county',
  ]) {
    await q(`DELETE FROM ${t}`);
  }
  await q(`SET session_replication_role = origin`);

  const county = await q(
    `INSERT INTO county (id, code, name) VALUES (gen_random_uuid(), '042', 'Kisumu') RETURNING id`,
  );
  f.countyId = county.rows[0].id;

  const sub = await q(
    `INSERT INTO subcounty (id, county_id, name, kind)
     VALUES (gen_random_uuid(), $1, 'Kisumu Central', 'HEALTH_ADMIN') RETURNING id`,
    [f.countyId],
  );
  f.subcountyId = sub.rows[0].id;

  const mkPerson = async (display: string, given: string) => {
    const r = await q(
      `INSERT INTO person (id, display_number, given_name, family_name, sex_at_birth,
                           date_of_birth, county_id, subcounty_id, registered_by,
                           registration_route, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 'Test', 'FEMALE', '1990-01-01', $3, $4,
               'system', 'SELF', now())
       RETURNING id`,
      [display, given, f.countyId, f.subcountyId],
    );
    return r.rows[0].id as string;
  };
  f.personId = await mkPerson('NHP-TEST-0001', 'Achieng');
  f.otherPersonId = await mkPerson('NHP-TEST-0002', 'Wanjiru');
  const pracPerson = await mkPerson('NHP-TEST-0003', 'Amina');

  const mkFacility = async (name: string, mfl: string) => {
    const r = await q(
      `INSERT INTO facility (id, mfl_code, name, keph_level, ownership, county_id,
                             subcounty_id, locality, latitude, longitude,
                             registration_status, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 4, 'PUBLIC_MOH', $3, $4, 'Milimani',
               -0.0917, 34.7680, 'ACTIVE', now())
       RETURNING id`,
      [mfl, name, f.countyId, f.subcountyId],
    );
    return r.rows[0].id as string;
  };
  f.facilityId = await mkFacility('Kisumu County Referral', 'MFL-0001');
  f.otherFacilityId = await mkFacility('Migosi Health Centre', 'MFL-0002');

  const prac = await q(
    `INSERT INTO practitioner (id, person_id, cadre, county_id, subcounty_id, status, updated_at)
     VALUES (gen_random_uuid(), $1, 'DOCTOR', $2, $3, 'ACTIVE', now()) RETURNING id`,
    [pracPerson, f.countyId, f.subcountyId],
  );
  f.practitionerId = prac.rows[0].id;

  await q(
    `INSERT INTO licence (id, practitioner_id, regulator, licence_number, issued_on,
                          expires_on, status)
     VALUES (gen_random_uuid(), $1, 'KMPDC', $2, '2020-01-01', '2030-01-01', 'ACTIVE')`,
    [f.practitionerId, f.licenceNumber],
  );
  await q(
    `INSERT INTO licence (id, practitioner_id, regulator, licence_number, issued_on,
                          expires_on, status)
     VALUES (gen_random_uuid(), $1, 'KMPDC', $2, '2015-01-01', '2020-01-01', 'ACTIVE')`,
    [f.practitionerId, f.expiredLicence],
  );

  const aff = await q(
    `INSERT INTO affiliation (id, practitioner_id, facility_id, role, granted_by,
                              granted_by_kind, status)
     VALUES (gen_random_uuid(), $1, $2, 'ATTENDING', 'ministry', 'MINISTRY', 'ACTIVE')
     RETURNING id`,
    [f.practitionerId, f.facilityId],
  );
  f.affiliationId = aff.rows[0].id;

  const ci = await q(
    `INSERT INTO check_in (id, practitioner_id, facility_id, affiliation_id,
                           started_at, expires_at, method)
     VALUES (gen_random_uuid(), $1, $2, $3, now() - interval '1 hour',
             now() + interval '15 hours', 'SELF_SELECT')
     RETURNING id`,
    [f.practitionerId, f.facilityId, f.affiliationId],
  );
  f.checkInId = ci.rows[0].id;

  // An already-expired session, for the "write after expiry" refusal.
  const expired = await q(
    `INSERT INTO check_in (id, practitioner_id, facility_id, affiliation_id,
                           started_at, expires_at, ended_at, end_reason, method)
     VALUES (gen_random_uuid(), $1, $2, $3, now() - interval '30 hours',
             now() - interval '14 hours', now() - interval '14 hours',
             'EXPIRED', 'SELF_SELECT')
     RETURNING id`,
    [f.practitionerId, f.facilityId, f.affiliationId],
  );
  f.expiredCheckInId = expired.rows[0].id;

  // A legitimate encounter and condition, used as targets for mutation tests.
  const enc = await q(
    `INSERT INTO encounter (id, person_id, check_in_id, recorded_by, facility_id,
                            licence_number, recorded_at, kind, started_at, chief_complaint)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, now(), 'OUTPATIENT', now(), 'fever')
     RETURNING id`,
    [f.personId, f.checkInId, f.practitionerId, f.facilityId, f.licenceNumber],
  );
  f.encounterId = enc.rows[0].id;

  const cond = await q(
    `INSERT INTO condition (id, person_id, check_in_id, recorded_by, facility_id,
                            licence_number, recorded_at, encounter_id, icd11_code,
                            icd11_title, icd11_chapter, clinical_status, keph_level)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, now(), $6, '1F41.0',
             'Plasmodium falciparum malaria', '01', 'CONFIRMED', 4)
     RETURNING id`,
    [f.personId, f.checkInId, f.practitionerId, f.facilityId, f.licenceNumber, f.encounterId],
  );
  f.conditionId = cond.rows[0].id;
});

afterAll(async () => {
  await app.end();
  await owner.end();
});

// =====================================================================

describe('append-only clinical records', () => {
  it('REFUSAL 1 — rejects UPDATE on a clinical row', async () => {
    const err = await expectRejection(
      app,
      `UPDATE condition SET icd11_title = 'tampered' WHERE id = $1`,
      [f.conditionId],
    );
    expect(err.message).toMatch(/append-only|permission denied|forbidden/i);
  });

  it('REFUSAL 2 — rejects DELETE on a clinical row', async () => {
    const err = await expectRejection(
      app,
      `DELETE FROM condition WHERE id = $1`,
      [f.conditionId],
    );
    expect(err.message).toMatch(/append-only|permission denied|forbidden/i);

    // And the row is still there.
    const { rows } = await owner.query(`SELECT count(*)::int n FROM condition WHERE id = $1`, [
      f.conditionId,
    ]);
    expect(rows[0].n).toBe(1);
  });

  it('REFUSAL 3 — rejects a clinical row with empty attribution', async () => {
    // Empty recorded_by is caught by the check-in gate first (it cannot match
    // the session holder), which is the stronger guarantee of the two.
    const emptyActor = await expectRejection(
      app,
      `INSERT INTO encounter (id, person_id, check_in_id, recorded_by, facility_id,
                              licence_number, recorded_at, kind, started_at, chief_complaint)
       VALUES (gen_random_uuid(), $1, $2, '', $3, $4, now(), 'OUTPATIENT', now(), 'x')`,
      [f.personId, f.checkInId, f.facilityId, f.licenceNumber],
    );
    expect(emptyActor.message).toMatch(/does not hold check-in/i);

    // The CHECK constraint itself is proven by bypassing the trigger: with
    // triggers disabled, an empty licence_number must STILL be refused.
    const constraintErr = await expectRejection(
      owner,
      `BEGIN;
       SET LOCAL session_replication_role = replica;
       INSERT INTO encounter (id, person_id, check_in_id, recorded_by, facility_id,
                              licence_number, recorded_at, kind, started_at, chief_complaint)
       VALUES (gen_random_uuid(), '${f.personId}', '${f.checkInId}',
               '${f.practitionerId}', '${f.facilityId}', '', now(),
               'OUTPATIENT', now(), 'x');
       COMMIT;`,
    );
    expect(constraintErr.message).toMatch(/attribution_ck|check constraint/i);
    await owner.query('ROLLBACK').catch(() => {});
  });

  it('REFUSAL 4 — rejects an allergy not marked Tier 1', async () => {
    const err = await expectRejection(
      app,
      `INSERT INTO allergy (id, person_id, check_in_id, recorded_by, facility_id,
                            licence_number, recorded_at, sensitivity, substance_kind,
                            substance_label, reaction, severity, certainty)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, now(), 'TIER_3_RESTRICTED',
               'DRUG', 'Penicillin', 'rash', 'SEVERE', 'CONFIRMED')`,
      [f.personId, f.checkInId, f.practitionerId, f.facilityId, f.licenceNumber],
    );
    expect(err.message).toMatch(/tier1|check constraint/i);
  });

  it('allows a correction via nhp_supersede, preserving the original', async () => {
    await app.query(`SELECT nhp_supersede('condition', $1::text)`, [f.conditionId]);

    const { rows } = await owner.query(
      `SELECT superseded_at, icd11_title FROM condition WHERE id = $1`,
      [f.conditionId],
    );
    expect(rows[0].superseded_at).not.toBeNull();
    // The original content is untouched — superseding marks, never edits.
    expect(rows[0].icd11_title).toBe('Plasmodium falciparum malaria');
  });
});

describe('the check-in gate', () => {
  it('REFUSAL 5 — rejects a clinical write with no open check-in', async () => {
    const err = await expectRejection(
      app,
      `INSERT INTO encounter (id, person_id, check_in_id, recorded_by, facility_id,
                              licence_number, recorded_at, kind, started_at, chief_complaint)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, now(), 'OUTPATIENT', now(), 'x')`,
      [f.personId, f.expiredCheckInId, f.practitionerId, f.facilityId, f.licenceNumber],
    );
    expect(err.message).toMatch(/closed|expired/i);
  });

  it('REFUSAL 6 — rejects a clinical write citing an expired licence', async () => {
    const err = await expectRejection(
      app,
      `INSERT INTO encounter (id, person_id, check_in_id, recorded_by, facility_id,
                              licence_number, recorded_at, kind, started_at, chief_complaint)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, now(), 'OUTPATIENT', now(), 'x')`,
      [f.personId, f.checkInId, f.practitionerId, f.facilityId, f.expiredLicence],
    );
    expect(err.message).toMatch(/licence .* not active|unexpired/i);
  });

  it('rejects a row claiming a facility other than the checked-in one', async () => {
    const err = await expectRejection(
      app,
      `INSERT INTO encounter (id, person_id, check_in_id, recorded_by, facility_id,
                              licence_number, recorded_at, kind, started_at, chief_complaint)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, now(), 'OUTPATIENT', now(), 'x')`,
      [f.personId, f.checkInId, f.practitionerId, f.otherFacilityId, f.licenceNumber],
    );
    expect(err.message).toMatch(/claims facility/i);
  });

  it('REFUSAL 7 — rejects check-in to a facility with no affiliation', async () => {
    const err = await expectRejection(
      app,
      `INSERT INTO check_in (id, practitioner_id, facility_id, affiliation_id,
                             started_at, expires_at, method)
       VALUES (gen_random_uuid(), $1, $2, $3, now(), now() + interval '8 hours', 'SELF_SELECT')`,
      [f.practitionerId, f.otherFacilityId, f.affiliationId],
    );
    expect(err.message).toMatch(/cannot check in to facility/i);
  });

  it('accepts a legitimate clinical write', async () => {
    const { rows } = await app.query(
      `INSERT INTO encounter (id, person_id, check_in_id, recorded_by, facility_id,
                              licence_number, recorded_at, kind, started_at, chief_complaint)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, now(), 'OUTPATIENT', now(), 'cough')
       RETURNING id`,
      [f.personId, f.checkInId, f.practitionerId, f.facilityId, f.licenceNumber],
    );
    expect(rows[0].id).toBeTruthy();
  });
});

describe('identity integrity', () => {
  it('REFUSAL 8 — rejects two ACTIVE identifiers with the same value', async () => {
    await app.query(
      `INSERT INTO identifier (id, person_id, type, value, value_index, status)
       VALUES (gen_random_uuid(), $1, 'NATIONAL_ID', 'enc:39104882', 'idx_39104882', 'ACTIVE')`,
      [f.personId],
    );

    const err = await expectRejection(
      app,
      `INSERT INTO identifier (id, person_id, type, value, value_index, status)
       VALUES (gen_random_uuid(), $1, 'NATIONAL_ID', 'enc:39104882', 'idx_39104882', 'ACTIVE')`,
      [f.otherPersonId],
    );
    expect(err.message).toMatch(/unique|duplicate/i);
  });

  it('allows a SUPERSEDED duplicate — history must survive a reissue', async () => {
    const { rows } = await app.query(
      `INSERT INTO identifier (id, person_id, type, value, value_index, status)
       VALUES (gen_random_uuid(), $1, 'NATIONAL_ID', 'enc:39104882', 'idx_39104882', 'SUPERSEDED')
       RETURNING id`,
      [f.otherPersonId],
    );
    expect(rows[0].id).toBeTruthy();
  });
});

describe('the audit log', () => {
  it('REFUSAL 9 — rejects DELETE on the audit log', async () => {
    await app.query(
      `INSERT INTO access_log (id, person_id, actor_kind, actor_id, action,
                               tier_reached, reason, outcome, request_id)
       VALUES (gen_random_uuid(), $1, 'PRACTITIONER', $2, 'VIEW_RECORD',
               'TIER_2_GENERAL', 'ACTIVE_CONSULTATION', 'GRANTED', 'req-1')`,
      [f.personId, f.practitionerId],
    );

    const err = await expectRejection(app, `DELETE FROM access_log WHERE person_id = $1`, [
      f.personId,
    ]);
    expect(err.message).toMatch(/append-only|permission denied|forbidden/i);
  });

  it('rejects UPDATE on the audit log', async () => {
    const err = await expectRejection(
      app,
      `UPDATE access_log SET outcome = 'GRANTED' WHERE person_id = $1`,
      [f.personId],
    );
    expect(err.message).toMatch(/append-only|permission denied|forbidden/i);
  });

  it('REFUSAL 13 — rejects UPDATE on break_glass', async () => {
    // Break-glass is evidence. If the app role could UPDATE it, a clinician
    // could rewrite their own justification or mark their own emergency
    // access reviewed — defeating nhp_review_break_glass() entirely.
    await owner.query(
      `INSERT INTO break_glass (id, person_id, practitioner_id, check_in_id,
                                facility_id, reason_code, justification,
                                categories, opened_at, expires_at, review_status)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 'UNCONSCIOUS',
               'Patient unconscious on arrival, no next of kin present',
               ARRAY['HIV']::"SensCat"[], now(), now() + interval '4 hours',
               'PENDING')`,
      [f.personId, f.practitionerId, f.checkInId, f.facilityId],
    );

    const err = await expectRejection(
      app,
      `UPDATE break_glass SET justification = 'tampered' WHERE person_id = $1`,
      [f.personId],
    );
    expect(err.message).toMatch(/append-only|permission denied|forbidden/i);

    const { rows } = await owner.query(
      `SELECT justification FROM break_glass WHERE person_id = $1`,
      [f.personId],
    );
    expect(rows[0].justification).toMatch(/unconscious on arrival/i);
  });

  it('REFUSAL 14 — rejects DELETE on break_glass', async () => {
    const err = await expectRejection(app, `DELETE FROM break_glass WHERE person_id = $1`, [
      f.personId,
    ]);
    expect(err.message).toMatch(/append-only|permission denied|forbidden/i);
  });

  it('allows review only through nhp_review_break_glass()', async () => {
    const { rows: bg } = await owner.query(
      `SELECT id FROM break_glass WHERE person_id = $1 LIMIT 1`,
      [f.personId],
    );

    await app.query(
      `SELECT nhp_review_break_glass($1::text, $2::text, $3::text, $4::text)`,
      [bg[0].id, 'REVIEWED_OK', 'auditor-1', 'Consistent with the ED record'],
    );

    const { rows } = await owner.query(
      `SELECT review_status, reviewed_by, justification FROM break_glass WHERE id = $1`,
      [bg[0].id],
    );
    expect(rows[0].review_status).toBe('REVIEWED_OK');
    expect(rows[0].reviewed_by).toBe('auditor-1');
    // Review records an outcome; it never edits the evidence.
    expect(rows[0].justification).toMatch(/unconscious on arrival/i);
  });

  it('forces DENIED_SELF_ACCESS when a practitioner opens their own record', async () => {
    const { rows: prac } = await owner.query(
      `SELECT person_id FROM practitioner WHERE id = $1`,
      [f.practitionerId],
    );
    const ownPersonId = prac[0].person_id;

    await app.query(
      `INSERT INTO access_log (id, person_id, actor_kind, actor_id, action,
                               tier_reached, reason, outcome, request_id)
       VALUES (gen_random_uuid(), $1, 'PRACTITIONER', $2, 'VIEW_RECORD',
               'TIER_2_GENERAL', 'ACTIVE_CONSULTATION', 'GRANTED', 'req-self')`,
      [ownPersonId, f.practitionerId],
    );

    const { rows } = await owner.query(
      `SELECT outcome FROM access_log WHERE request_id = 'req-self'`,
    );
    // The row claimed GRANTED; the trigger rewrote it to the truth.
    expect(rows[0].outcome).toBe('DENIED_SELF_ACCESS');
  });
});

describe('consent and merge', () => {
  it('REFUSAL 10 — rejects a consent grant with no expiry', async () => {
    const err = await expectRejection(
      app,
      `INSERT INTO consent_grant (id, person_id, facility_id, scope, granted_by,
                                  method, granted_at, expires_at)
       VALUES (gen_random_uuid(), $1, $2, 'ALL_TIER_3', 'PATIENT', 'IN_PERSON_OTP',
               now(), NULL)`,
      [f.personId, f.facilityId],
    );
    expect(err.message).toMatch(/null value|not-null/i);
  });

  it('rejects a perpetual consent grant (expiry beyond one year)', async () => {
    const err = await expectRejection(
      app,
      `INSERT INTO consent_grant (id, person_id, facility_id, scope, granted_by,
                                  method, granted_at, expires_at)
       VALUES (gen_random_uuid(), $1, $2, 'ALL_TIER_3', 'PATIENT', 'IN_PERSON_OTP',
               now(), now() + interval '10 years')`,
      [f.personId, f.facilityId],
    );
    expect(err.message).toMatch(/consent_expiry|check constraint/i);
  });

  it('REFUSAL 11 — rejects a merge approved by one person', async () => {
    const err = await expectRejection(
      app,
      `INSERT INTO merge_request (id, surviving_person_id, merged_person_id,
                                  detected_by, status, approved_by, second_approver)
       VALUES (gen_random_uuid(), $1, $2, 'AUTOMATIC', 'APPROVED', 'user-a', 'user-a')`,
      [f.personId, f.otherPersonId],
    );
    expect(err.message).toMatch(/two_approver|check constraint/i);
  });

  it('accepts a merge with two distinct approvers', async () => {
    const { rows } = await app.query(
      `INSERT INTO merge_request (id, surviving_person_id, merged_person_id,
                                  detected_by, status, approved_by, second_approver)
       VALUES (gen_random_uuid(), $1, $2, 'AUTOMATIC', 'APPROVED', 'user-a', 'user-b')
       RETURNING id`,
      [f.personId, f.otherPersonId],
    );
    expect(rows[0].id).toBeTruthy();
  });
});

describe('the analyst separation', () => {
  it('REFUSAL 12 — rejects a Tier 3 aggregate below county level', async () => {
    const err = await expectRejection(
      app,
      `INSERT INTO agg_condition_daily (id, date, county_id, subcounty_id, icd11_code,
                                        icd11_chapter, age_band, sex, keph_level,
                                        case_count, new_case_count,
                                        facilities_reporting, facilities_expected)
       VALUES (gen_random_uuid(), current_date, $1, $2, '1C62.Z', 'TIER3_HIV',
               '25_49', 'FEMALE', 4, 12, 3, 40, 50)`,
      [f.countyId, f.subcountyId],
    );
    expect(err.message).toMatch(/tier3_geo|check constraint/i);
  });

  it('allows a Tier 3 aggregate at county level', async () => {
    const { rows } = await app.query(
      `INSERT INTO agg_condition_daily (id, date, county_id, subcounty_id, icd11_code,
                                        icd11_chapter, age_band, sex, keph_level,
                                        case_count, new_case_count,
                                        facilities_reporting, facilities_expected)
       VALUES (gen_random_uuid(), current_date, $1, NULL, '1C62.Z', 'TIER3_HIV',
               '25_49', 'FEMALE', 4, 12, 3, 40, 50)
       RETURNING id`,
      [f.countyId],
    );
    expect(rows[0].id).toBeTruthy();
  });

  it('rejects a suppressed cell carrying a real count', async () => {
    const err = await expectRejection(
      app,
      `INSERT INTO agg_condition_daily (id, date, county_id, icd11_code, icd11_chapter,
                                        age_band, sex, keph_level, case_count,
                                        new_case_count, suppressed,
                                        facilities_reporting, facilities_expected)
       VALUES (gen_random_uuid(), current_date - 1, $1, '1F41.0', '01', '5_14',
               'MALE', 4, 7, 2, true, 40, 50)`,
      [f.countyId],
    );
    expect(err.message).toMatch(/suppression|check constraint/i);
  });

  it('the ANALYST role cannot read any clinical table', async () => {
    const analyst = new pg.Pool({ connectionString: ANALYST });
    try {
      for (const table of ['person', 'encounter', 'condition', 'allergy', 'medication']) {
        const err = await expectRejection(analyst, `SELECT * FROM ${table} LIMIT 1`);
        expect(err.message).toMatch(/permission denied/i);
      }
      // But it can read the aggregates it exists to serve.
      const { rows } = await analyst.query(`SELECT count(*)::int n FROM agg_condition_daily`);
      expect(rows[0].n).toBeGreaterThanOrEqual(0);
    } finally {
      await analyst.end();
    }
  });
});
