-- NHP hardening — Phase 0
--
-- Applied by `pnpm harden` AFTER `prisma migrate`. Prisma owns table
-- structure; this file owns the guarantees. Everything here is enforced by
-- PostgreSQL, not by application code, because application code can be
-- bypassed by a bug, a migration script, or a console session.
--
-- Idempotent: safe to re-run.

-- =====================================================================
-- 1. ROLES
-- =====================================================================
-- nhp_owner  (superuser)  migrations and this file only
-- nhp_app                 the API. No UPDATE/DELETE on clinical tables.
-- nhp_audit_writer        INSERT on audit tables. Nothing else.
-- nhp_auditor             SELECT on audit tables. No clinical access.
-- nhp_analyst             SELECT on aggregates ONLY. No clinical grant at all.

-- Passwords are injected by src/harden.ts from the environment, never
-- committed. :'app_pw' etc. are placeholders substituted before execution.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'nhp_app') THEN
    EXECUTE format('CREATE ROLE nhp_app LOGIN PASSWORD %L', :'app_pw');
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'nhp_audit_writer') THEN
    EXECUTE format('CREATE ROLE nhp_audit_writer LOGIN PASSWORD %L', :'audit_writer_pw');
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'nhp_auditor') THEN
    EXECUTE format('CREATE ROLE nhp_auditor LOGIN PASSWORD %L', :'auditor_pw');
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'nhp_analyst') THEN
    EXECUTE format('CREATE ROLE nhp_analyst LOGIN PASSWORD %L', :'analyst_pw');
  END IF;
END
$$;

GRANT CONNECT ON DATABASE nhp TO nhp_app, nhp_audit_writer, nhp_auditor, nhp_analyst;
GRANT USAGE ON SCHEMA public TO nhp_app, nhp_audit_writer, nhp_auditor, nhp_analyst;

-- =====================================================================
-- 2. BASELINE GRANTS
-- =====================================================================

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO nhp_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO nhp_app;

-- =====================================================================
-- 3. APPEND-ONLY: revoke UPDATE and DELETE on clinical tables
-- =====================================================================
-- REFUSAL 1: UPDATE on a clinical row
-- REFUSAL 2: DELETE on a clinical row

REVOKE UPDATE, DELETE ON
  encounter, condition, allergy, medication, observation, procedure
  FROM nhp_app;

-- Audit tables: the app may INSERT and SELECT, never modify.
REVOKE UPDATE, DELETE ON access_log FROM nhp_app;

-- break_glass is evidence. Leaving UPDATE with the app role would let a
-- clinician rewrite their own justification, or mark their own emergency
-- access reviewed — defeating the point of routing review through the
-- SECURITY DEFINER function in §7. Revoke both; nhp_review_break_glass()
-- is the only way in.
REVOKE UPDATE, DELETE ON break_glass FROM nhp_app;

-- REFUSAL 9: DELETE on the audit log, by anyone but the owner
GRANT INSERT ON access_log TO nhp_audit_writer;
REVOKE UPDATE, DELETE ON access_log FROM nhp_audit_writer;
GRANT SELECT ON access_log, break_glass TO nhp_auditor;

-- The auditor sees the log, never the clinical content.
REVOKE ALL ON encounter, condition, allergy, medication, observation, procedure
  FROM nhp_auditor;

-- =====================================================================
-- 4. THE ANALYST SEPARATION
-- =====================================================================
-- The role powering the Ministry dashboard must hold no grant on any
-- clinical table. If this is ever relaxed, the four-role separation
-- becomes decorative and the Data Protection Act position collapses.

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM nhp_analyst;
GRANT SELECT ON agg_condition_daily TO nhp_analyst;

-- =====================================================================
-- 5. APPEND-ONLY TRIGGERS
-- =====================================================================
-- Grants alone are not enough: a future migration could restore them by
-- accident. The trigger makes the intent explicit and survives that.

CREATE OR REPLACE FUNCTION nhp_reject_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'NHP: % on % is forbidden. Clinical records are append-only; '
    'corrections must insert a new version via nhp_supersede().',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['encounter','condition','allergy','medication','observation','procedure','access_log','break_glass']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', 'trg_append_only_' || t, t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I '
      'FOR EACH ROW EXECUTE FUNCTION nhp_reject_mutation()',
      'trg_append_only_' || t, t
    );
  END LOOP;
END
$$;

-- =====================================================================
-- 6. THE SUPERSEDE FUNCTION — the ONLY permitted clinical write
-- =====================================================================
-- A correction must mark its predecessor superseded, which is technically
-- an UPDATE. Rather than granting UPDATE back, expose one SECURITY DEFINER
-- function that sets superseded_at and nothing else.

-- p_id is text, not uuid: Prisma stores ids as text columns, so a uuid
-- parameter would fail with "operator does not exist: text = uuid".
CREATE OR REPLACE FUNCTION nhp_supersede(
  p_table text,
  p_id    text,
  p_at    timestamptz DEFAULT now()
)
RETURNS void AS $$
BEGIN
  IF p_table NOT IN ('encounter','condition','allergy','medication','observation','procedure') THEN
    RAISE EXCEPTION 'NHP: % is not a supersedable clinical table', p_table
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- Disable the append-only trigger for this one statement, in this
  -- transaction only. session_replication_role is reset on commit.
  SET LOCAL session_replication_role = replica;

  EXECUTE format(
    'UPDATE %I SET superseded_at = $1 WHERE id = $2 AND superseded_at IS NULL',
    p_table
  ) USING p_at, p_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP FUNCTION IF EXISTS nhp_supersede(text, uuid, timestamptz);
REVOKE ALL ON FUNCTION nhp_supersede(text, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nhp_supersede(text, text, timestamptz) TO nhp_app;

-- =====================================================================
-- 7. BREAK-GLASS REVIEW — the only other permitted UPDATE
-- =====================================================================

CREATE OR REPLACE FUNCTION nhp_review_break_glass(
  p_id     text,
  p_status text,
  p_by     text,
  p_note   text DEFAULT NULL
)
RETURNS void AS $$
BEGIN
  IF p_status NOT IN ('REVIEWED_OK','FLAGGED','ESCALATED') THEN
    RAISE EXCEPTION 'NHP: invalid break-glass review status %', p_status
      USING ERRCODE = 'check_violation';
  END IF;

  -- break_glass is append-only (§5). Suspend the trigger for this one
  -- statement, in this transaction only, so review can be recorded without
  -- granting the app role UPDATE on the evidence.
  SET LOCAL session_replication_role = replica;

  UPDATE break_glass
     SET review_status = p_status::"ReviewStatus",
         reviewed_by   = p_by,
         reviewed_at   = now(),
         review_note   = p_note
   WHERE id = p_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Recording that the patient was told is not a review — it is done by the
-- SMS worker, asynchronously, and must not require UPDATE on the evidence.
CREATE OR REPLACE FUNCTION nhp_mark_break_glass_notified(
  p_id      text,
  p_channel text
)
RETURNS void AS $$
BEGIN
  IF p_channel NOT IN ('SMS','IN_APP','POSTAL') THEN
    RAISE EXCEPTION 'NHP: invalid notification channel %', p_channel
      USING ERRCODE = 'check_violation';
  END IF;

  SET LOCAL session_replication_role = replica;

  UPDATE break_glass
     SET patient_notified_at   = now(),
         notification_channel  = p_channel
   WHERE id = p_id
     AND patient_notified_at IS NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION nhp_mark_break_glass_notified(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nhp_mark_break_glass_notified(text, text) TO nhp_app;

-- Recording that an encounter ended in a referral is a lifecycle fact, not
-- a clinical edit — but `encounter` is append-only, so it goes through a
-- narrow function that may set ONLY these two columns.
CREATE OR REPLACE FUNCTION nhp_set_encounter_disposition(
  p_encounter_id text,
  p_disposition  text,
  p_referral_id  text DEFAULT NULL
)
RETURNS void AS $$
BEGIN
  IF p_disposition NOT IN ('DISCHARGED','ADMITTED','REFERRED','ABSCONDED',
                           'DIED','LEFT_AGAINST_ADVICE') THEN
    RAISE EXCEPTION 'NHP: invalid disposition %', p_disposition
      USING ERRCODE = 'check_violation';
  END IF;

  SET LOCAL session_replication_role = replica;

  UPDATE encounter
     SET disposition = p_disposition::"Disposition",
         referral_id = COALESCE(p_referral_id, referral_id),
         ended_at    = COALESCE(ended_at, now())
   WHERE id = p_encounter_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION nhp_set_encounter_disposition(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nhp_set_encounter_disposition(text, text, text) TO nhp_app;

DROP FUNCTION IF EXISTS nhp_review_break_glass(uuid, text, uuid, text);
REVOKE ALL ON FUNCTION nhp_review_break_glass(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nhp_review_break_glass(text, text, text, text) TO nhp_app;

-- =====================================================================
-- 8. CHECK CONSTRAINTS
-- =====================================================================

-- REFUSAL 3: clinical row with null attribution.
-- Prisma already enforces NOT NULL; these assert non-emptiness too, since
-- an empty string would satisfy NOT NULL while carrying no attribution.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['encounter','condition','allergy','medication','observation','procedure']
  LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I', t, t || '_attribution_ck');
    EXECUTE format($f$
      ALTER TABLE %I ADD CONSTRAINT %I CHECK (
        length(recorded_by) > 0
        AND length(facility_id) > 0
        AND length(licence_number) > 0
      )$f$, t, t || '_attribution_ck');
  END LOOP;
END
$$;

-- REFUSAL 4: an allergy not marked Tier 1.
-- Allergies must always be visible in an emergency; consent must never hide one.
ALTER TABLE allergy DROP CONSTRAINT IF EXISTS allergy_tier1_ck;
ALTER TABLE allergy ADD CONSTRAINT allergy_tier1_ck
  CHECK (sensitivity = 'TIER_1_EMERGENCY');

-- REFUSAL 10: a consent grant with no expiry, or one that expires before
-- it starts. A perpetual grant is functionally the same as no access control.
ALTER TABLE consent_grant DROP CONSTRAINT IF EXISTS consent_expiry_ck;
ALTER TABLE consent_grant ADD CONSTRAINT consent_expiry_ck
  CHECK (expires_at > granted_at AND expires_at <= granted_at + interval '1 year');

-- A grant must name a facility or a practitioner.
ALTER TABLE consent_grant DROP CONSTRAINT IF EXISTS consent_target_ck;
ALTER TABLE consent_grant ADD CONSTRAINT consent_target_ck
  CHECK (facility_id IS NOT NULL OR practitioner_id IS NOT NULL);

-- REFUSAL 11: a merge approved by one person.
ALTER TABLE merge_request DROP CONSTRAINT IF EXISTS merge_two_approver_ck;
ALTER TABLE merge_request ADD CONSTRAINT merge_two_approver_ck
  CHECK (
    status <> 'APPROVED' OR (
      approved_by IS NOT NULL
      AND second_approver IS NOT NULL
      AND approved_by <> second_approver
    )
  );

-- An account belongs to exactly one kind of user.
ALTER TABLE account DROP CONSTRAINT IF EXISTS account_one_owner_ck;
ALTER TABLE account ADD CONSTRAINT account_one_owner_ck
  CHECK (num_nonnulls(person_id, practitioner_id, ministry_user_id) = 1);

-- Check-in must expire after it starts, and within 24 hours.
ALTER TABLE check_in DROP CONSTRAINT IF EXISTS checkin_window_ck;
ALTER TABLE check_in ADD CONSTRAINT checkin_window_ck
  CHECK (expires_at > started_at AND expires_at <= started_at + interval '24 hours');

-- REFUSAL 12: a Tier 3 aggregate below county level.
-- Small geography + stigmatised condition is where re-identification happens.
ALTER TABLE agg_condition_daily DROP CONSTRAINT IF EXISTS agg_tier3_geo_ck;
ALTER TABLE agg_condition_daily ADD CONSTRAINT agg_tier3_geo_ck
  CHECK (
    icd11_chapter NOT IN ('TIER3_HIV','TIER3_MENTAL','TIER3_REPRO','TIER3_SUBSTANCE')
    OR subcounty_id IS NULL
  );

-- Suppressed cells must not carry a real count.
ALTER TABLE agg_condition_daily DROP CONSTRAINT IF EXISTS agg_suppression_ck;
ALTER TABLE agg_condition_daily ADD CONSTRAINT agg_suppression_ck
  CHECK (NOT suppressed OR case_count = 0);

-- =====================================================================
-- 9. THE CHECK-IN GATE
-- =====================================================================
-- REFUSAL 5: a clinical write with no open check-in.
-- REFUSAL 6: a clinical write on an expired licence.
--
-- The single most important trigger in the system. Every clinical insert
-- must fall inside an open session, at the facility it claims, by a
-- practitioner whose licence was valid at that moment.

CREATE OR REPLACE FUNCTION nhp_enforce_checkin()
RETURNS TRIGGER AS $$
DECLARE
  ci        record;
  lic_count int;
BEGIN
  SELECT c.id, c.practitioner_id, c.facility_id, c.started_at,
         c.expires_at, c.ended_at
    INTO ci
    FROM check_in c
   WHERE c.id = NEW.check_in_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NHP: check_in % does not exist', NEW.check_in_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- The write must fall inside the session window.
  IF NEW.recorded_at < ci.started_at THEN
    RAISE EXCEPTION
      'NHP: recorded_at % precedes check-in start %', NEW.recorded_at, ci.started_at
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.recorded_at > COALESCE(ci.ended_at, ci.expires_at) THEN
    RAISE EXCEPTION
      'NHP: recorded_at % is after the check-in closed/expired at %',
      NEW.recorded_at, COALESCE(ci.ended_at, ci.expires_at)
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- The row must claim the facility the clinician actually checked into.
  IF NEW.facility_id <> ci.facility_id THEN
    RAISE EXCEPTION
      'NHP: row claims facility % but the check-in is at %',
      NEW.facility_id, ci.facility_id
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- recorded_by must be the practitioner who holds the session.
  IF NEW.recorded_by <> ci.practitioner_id THEN
    RAISE EXCEPTION
      'NHP: recorded_by % does not hold check-in %', NEW.recorded_by, ci.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- The cited licence must belong to that practitioner, be ACTIVE, and
  -- have been unexpired at the moment of the write.
  SELECT count(*) INTO lic_count
    FROM licence l
   WHERE l.practitioner_id = ci.practitioner_id
     AND l.licence_number  = NEW.licence_number
     AND l.status          = 'ACTIVE'
     AND l.expires_on     >= NEW.recorded_at::date;

  IF lic_count = 0 THEN
    RAISE EXCEPTION
      'NHP: licence % is not active/unexpired for practitioner % at %',
      NEW.licence_number, ci.practitioner_id, NEW.recorded_at
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['encounter','condition','allergy','medication','observation','procedure']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', 'trg_checkin_gate_' || t, t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE INSERT ON %I '
      'FOR EACH ROW EXECUTE FUNCTION nhp_enforce_checkin()',
      'trg_checkin_gate_' || t, t
    );
  END LOOP;
END
$$;

-- =====================================================================
-- 10. AFFILIATION GATE ON CHECK-IN
-- =====================================================================
-- REFUSAL 7: checking in to a facility the clinician is not affiliated to.

CREATE OR REPLACE FUNCTION nhp_enforce_affiliation()
RETURNS TRIGGER AS $$
DECLARE aff record;
BEGIN
  SELECT a.id, a.practitioner_id, a.facility_id, a.status, a.ended_at
    INTO aff
    FROM affiliation a
   WHERE a.id = NEW.affiliation_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NHP: affiliation % does not exist', NEW.affiliation_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF aff.practitioner_id <> NEW.practitioner_id THEN
    RAISE EXCEPTION 'NHP: affiliation % belongs to a different practitioner', aff.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF aff.facility_id <> NEW.facility_id THEN
    RAISE EXCEPTION
      'NHP: cannot check in to facility % using an affiliation to %',
      NEW.facility_id, aff.facility_id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF aff.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'NHP: affiliation % is %, not ACTIVE', aff.id, aff.status
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_affiliation_gate ON check_in;
CREATE TRIGGER trg_affiliation_gate
  BEFORE INSERT ON check_in
  FOR EACH ROW EXECUTE FUNCTION nhp_enforce_affiliation();

-- =====================================================================
-- 11. IDENTIFIER UNIQUENESS
-- =====================================================================
-- REFUSAL 8: two ACTIVE identifiers with the same type and value.
-- Partial index: superseded identifiers may linger for history.

DROP INDEX IF EXISTS identifier_active_unique;
CREATE UNIQUE INDEX identifier_active_unique
  ON identifier (type, value_index)
  WHERE status = 'ACTIVE';

-- =====================================================================
-- 12. SELF-ACCESS DETECTION
-- =====================================================================
-- A practitioner opening their own record is the most common insider-abuse
-- pattern. Not blocked at the database — the API refuses it — but any row
-- that reaches the log is forced to carry the honest outcome.

CREATE OR REPLACE FUNCTION nhp_flag_self_access()
RETURNS TRIGGER AS $$
DECLARE prac_person text;
BEGIN
  IF NEW.actor_kind = 'PRACTITIONER' THEN
    SELECT p.person_id INTO prac_person
      FROM practitioner p WHERE p.id = NEW.actor_id;

    IF prac_person IS NOT NULL AND prac_person = NEW.person_id THEN
      NEW.outcome := 'DENIED_SELF_ACCESS';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_self_access ON access_log;
CREATE TRIGGER trg_self_access
  BEFORE INSERT ON access_log
  FOR EACH ROW EXECUTE FUNCTION nhp_flag_self_access();

-- =====================================================================
-- 13. DEFAULTS FOR FUTURE TABLES
-- =====================================================================

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO nhp_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO nhp_app;
