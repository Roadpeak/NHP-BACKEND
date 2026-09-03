-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- CreateEnum
CREATE TYPE "Sex" AS ENUM ('MALE', 'FEMALE', 'INTERSEX');

-- CreateEnum
CREATE TYPE "Precision" AS ENUM ('EXACT', 'MONTH', 'YEAR', 'ESTIMATED');

-- CreateEnum
CREATE TYPE "LifeStatus" AS ENUM ('ALIVE', 'DECEASED', 'INACTIVE', 'EMIGRATED');

-- CreateEnum
CREATE TYPE "Maturity" AS ENUM ('DEPENDANT', 'PENDING_PROMOTION', 'ADULT');

-- CreateEnum
CREATE TYPE "RegRoute" AS ENUM ('SELF', 'FACILITY_BIRTH', 'GUARDIAN', 'MINISTRY');

-- CreateEnum
CREATE TYPE "VerState" AS ENUM ('UNVERIFIED', 'PENDING', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "BloodGroup" AS ENUM ('A_POS', 'A_NEG', 'B_POS', 'B_NEG', 'AB_POS', 'AB_NEG', 'O_POS', 'O_NEG');

-- CreateEnum
CREATE TYPE "IdType" AS ENUM ('NATIONAL_ID', 'BIRTH_CERT', 'PASSPORT', 'ALIEN_ID', 'UNHCR', 'HUDUMA', 'MILITARY', 'PROVISIONAL');

-- CreateEnum
CREATE TYPE "IdStatus" AS ENUM ('ACTIVE', 'SUPERSEDED', 'DISPUTED', 'REVOKED');

-- CreateEnum
CREATE TYPE "Relation" AS ENUM ('MOTHER', 'FATHER', 'LEGAL_GUARDIAN', 'GRANDPARENT', 'SIBLING', 'FOSTER', 'INSTITUTION', 'OTHER');

-- CreateEnum
CREATE TYPE "Evidence" AS ENUM ('BIRTH_RECORD', 'BIRTH_CERT', 'COURT_ORDER', 'FACILITY_ATTESTED', 'SELF_DECLARED');

-- CreateEnum
CREATE TYPE "GuardStatus" AS ENUM ('ACTIVE', 'ENDED', 'DISPUTED', 'REVOKED');

-- CreateEnum
CREATE TYPE "AcctStatus" AS ENUM ('ACTIVE', 'LOCKED', 'SUSPENDED', 'CLOSED');

-- CreateEnum
CREATE TYPE "MfaMode" AS ENUM ('NONE', 'SMS', 'TOTP');

-- CreateEnum
CREATE TYPE "SubKind" AS ENUM ('HEALTH_ADMIN', 'CONSTITUENCY', 'BOTH');

-- CreateEnum
CREATE TYPE "Ownership" AS ENUM ('PUBLIC_MOH', 'PUBLIC_OTHER', 'PRIVATE_FOR_PROFIT', 'FAITH_BASED', 'NGO');

-- CreateEnum
CREATE TYPE "FacStatus" AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED', 'CLOSED');

-- CreateEnum
CREATE TYPE "CapDomain" AS ENUM ('SERVICE', 'DIAGNOSTIC', 'EQUIPMENT', 'SPECIALTY');

-- CreateEnum
CREATE TYPE "Avail" AS ENUM ('ROUTINE', 'BUSINESS_HOURS', 'ON_CALL', 'REFERRAL_ONLY');

-- CreateEnum
CREATE TYPE "CapStatus" AS ENUM ('CLAIMED', 'VERIFIED', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "Cadre" AS ENUM ('RECEPTION', 'DOCTOR', 'DENTIST', 'CLINICAL_OFFICER', 'NURSE', 'MIDWIFE', 'PHARMACIST', 'LAB_TECH', 'RADIOGRAPHER', 'NUTRITIONIST', 'PSYCHOLOGIST', 'CHW');

-- CreateEnum
CREATE TYPE "Regulator" AS ENUM ('KMPDC', 'NCK', 'COC', 'PPB', 'KMLTTB', 'KNDI');

-- CreateEnum
CREATE TYPE "PracStatus" AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED', 'RETIRED', 'REVOKED');

-- CreateEnum
CREATE TYPE "LicStatus" AS ENUM ('PENDING', 'ACTIVE', 'EXPIRED', 'SUSPENDED', 'REVOKED');

-- CreateEnum
CREATE TYPE "FacRole" AS ENUM ('ATTENDING', 'RESIDENT', 'VISITING', 'LOCUM', 'FACILITY_ADMIN');

-- CreateEnum
CREATE TYPE "GrantKind" AS ENUM ('FACILITY', 'MINISTRY');

-- CreateEnum
CREATE TYPE "AffStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'ENDED');

-- CreateEnum
CREATE TYPE "EndReason" AS ENUM ('MANUAL', 'EXPIRED', 'REVOKED', 'FACILITY_CLOSED');

-- CreateEnum
CREATE TYPE "CheckMethod" AS ENUM ('SELF_SELECT', 'FACILITY_CODE', 'GEOFENCE');

-- CreateEnum
CREATE TYPE "Tier" AS ENUM ('TIER_1_EMERGENCY', 'TIER_2_GENERAL', 'TIER_3_RESTRICTED');

-- CreateEnum
CREATE TYPE "EncKind" AS ENUM ('OUTPATIENT', 'INPATIENT', 'EMERGENCY', 'MATERNITY', 'IMMUNISATION', 'SCREENING', 'FOLLOW_UP', 'TELEHEALTH');

-- CreateEnum
CREATE TYPE "Band" AS ENUM ('RED', 'ORANGE', 'YELLOW', 'GREEN');

-- CreateEnum
CREATE TYPE "Disposition" AS ENUM ('DISCHARGED', 'ADMITTED', 'REFERRED', 'ABSCONDED', 'DIED', 'LEFT_AGAINST_ADVICE');

-- CreateEnum
CREATE TYPE "CondStatus" AS ENUM ('SUSPECTED', 'CONFIRMED', 'ACTIVE', 'RESOLVED', 'RECURRENCE', 'IN_REMISSION', 'REFUTED');

-- CreateEnum
CREATE TYPE "SubstanceKind" AS ENUM ('DRUG', 'FOOD', 'ENVIRONMENT', 'OTHER');

-- CreateEnum
CREATE TYPE "Severity" AS ENUM ('MILD', 'MODERATE', 'SEVERE', 'ANAPHYLAXIS');

-- CreateEnum
CREATE TYPE "Certainty" AS ENUM ('SUSPECTED', 'CONFIRMED');

-- CreateEnum
CREATE TYPE "Route" AS ENUM ('ORAL', 'IV', 'IM', 'SC', 'TOPICAL', 'INHALED', 'RECTAL');

-- CreateEnum
CREATE TYPE "MedStatus" AS ENUM ('PRESCRIBED', 'DISPENSED', 'ACTIVE', 'COMPLETED', 'STOPPED_EARLY', 'NOT_DISPENSED');

-- CreateEnum
CREATE TYPE "ObsCat" AS ENUM ('VITAL', 'LAB', 'ANTHROPOMETRIC', 'IMAGING');

-- CreateEnum
CREATE TYPE "Flag" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "SensCat" AS ENUM ('HIV', 'MENTAL_HEALTH', 'REPRODUCTIVE', 'SUBSTANCE_USE', 'GBV', 'GENETIC');

-- CreateEnum
CREATE TYPE "Scope" AS ENUM ('ALL_TIER_3', 'CATEGORY', 'SINGLE_RECORD');

-- CreateEnum
CREATE TYPE "GrantBy" AS ENUM ('PATIENT', 'GUARDIAN', 'COURT_ORDER');

-- CreateEnum
CREATE TYPE "GrantMethod" AS ENUM ('IN_PERSON_OTP', 'PORTAL', 'VERBAL_ATTESTED');

-- CreateEnum
CREATE TYPE "ActorKind" AS ENUM ('PRACTITIONER', 'FACILITY_ADMIN', 'MINISTRY', 'PATIENT', 'GUARDIAN', 'SYSTEM');

-- CreateEnum
CREATE TYPE "Action" AS ENUM ('SEARCH', 'VIEW_SUMMARY', 'VIEW_RECORD', 'WRITE', 'EXPORT', 'PRINT', 'BREAK_GLASS');

-- CreateEnum
CREATE TYPE "AccessReason" AS ENUM ('ACTIVE_CONSULTATION', 'FOLLOW_UP', 'EMERGENCY', 'REFERRAL_REVIEW', 'ADMIN', 'PATIENT_REQUEST');

-- CreateEnum
CREATE TYPE "Outcome" AS ENUM ('GRANTED', 'DENIED_NO_CONSENT', 'DENIED_NO_CHECKIN', 'DENIED_LICENCE', 'DENIED_RATE_LIMIT', 'DENIED_SELF_ACCESS');

-- CreateEnum
CREATE TYPE "BgReason" AS ENUM ('UNCONSCIOUS', 'LIFE_THREATENING', 'PATIENT_UNABLE', 'GUARDIAN_UNREACHABLE', 'MASS_CASUALTY');

-- CreateEnum
CREATE TYPE "ReviewStatus" AS ENUM ('PENDING', 'REVIEWED_OK', 'FLAGGED', 'ESCALATED');

-- CreateEnum
CREATE TYPE "MinRole" AS ENUM ('SUPER_ADMIN', 'ANALYST', 'REGISTRAR', 'SURVEILLANCE', 'AUDITOR');

-- CreateEnum
CREATE TYPE "GeoScope" AS ENUM ('NATIONAL', 'COUNTY', 'SUBCOUNTY');

-- CreateEnum
CREATE TYPE "MergeStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'REVERSED');

-- CreateEnum
CREATE TYPE "DetectMode" AS ENUM ('AUTOMATIC', 'FACILITY_REPORT', 'CITIZEN_REPORT');

-- CreateEnum
CREATE TYPE "ArrivalStatus" AS ENUM ('WAITING', 'IN_CONSULTATION', 'COMPLETED', 'LEFT');

-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('QUEUED', 'APPLIED', 'CONFLICT', 'REJECTED');

-- CreateEnum
CREATE TYPE "Urgency" AS ENUM ('EMERGENCY', 'URGENT_24H', 'SOON_7D', 'ROUTINE');

-- CreateEnum
CREATE TYPE "RefStatus" AS ENUM ('ISSUED', 'ACCEPTED', 'DECLINED', 'ARRIVED', 'COMPLETED', 'EXPIRED', 'CANCELLED');

-- CreateTable
CREATE TABLE "county" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "county_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subcounty" (
    "id" TEXT NOT NULL,
    "county_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "SubKind" NOT NULL DEFAULT 'HEALTH_ADMIN',

    CONSTRAINT "subcounty_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ward" (
    "id" TEXT NOT NULL,
    "subcounty_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "ward_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "person" (
    "id" TEXT NOT NULL,
    "display_number" TEXT NOT NULL,
    "given_name" TEXT NOT NULL,
    "middle_name" TEXT,
    "family_name" TEXT NOT NULL,
    "sex_at_birth" "Sex" NOT NULL,
    "date_of_birth" DATE NOT NULL,
    "dob_precision" "Precision" NOT NULL DEFAULT 'EXACT',
    "blood_group" "BloodGroup",
    "photo_enc" TEXT,
    "life_status" "LifeStatus" NOT NULL DEFAULT 'ALIVE',
    "deceased_at" TIMESTAMP(3),
    "county_id" TEXT NOT NULL,
    "subcounty_id" TEXT NOT NULL,
    "ward_id" TEXT,
    "residence_note" TEXT,
    "maturity" "Maturity" NOT NULL DEFAULT 'ADULT',
    "registered_by" TEXT NOT NULL,
    "registration_route" "RegRoute" NOT NULL,
    "verification_state" "VerState" NOT NULL DEFAULT 'UNVERIFIED',
    "merged_into_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "person_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identifier" (
    "id" TEXT NOT NULL,
    "person_id" TEXT NOT NULL,
    "type" "IdType" NOT NULL,
    "value" TEXT NOT NULL,
    "value_index" TEXT NOT NULL,
    "issued_on" DATE,
    "verified_at" TIMESTAMP(3),
    "verified_via" TEXT,
    "status" "IdStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "identifier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guardianship" (
    "id" TEXT NOT NULL,
    "dependant_id" TEXT NOT NULL,
    "guardian_id" TEXT NOT NULL,
    "relationship" "Relation" NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "established_by" TEXT NOT NULL,
    "evidence" "Evidence" NOT NULL,
    "status" "GuardStatus" NOT NULL DEFAULT 'ACTIVE',
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),
    "end_reason" TEXT,

    CONSTRAINT "guardianship_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account" (
    "id" TEXT NOT NULL,
    "person_id" TEXT,
    "practitioner_id" TEXT,
    "ministry_user_id" TEXT,
    "phone" TEXT NOT NULL,
    "phone_index" TEXT NOT NULL,
    "sms_phone" TEXT,
    "phone_verified_at" TIMESTAMP(3),
    "email" TEXT,
    "email_index" TEXT,
    "password_hash" TEXT NOT NULL,
    "password_set_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mfa_mode" "MfaMode" NOT NULL DEFAULT 'NONE',
    "mfa_secret" TEXT,
    "status" "AcctStatus" NOT NULL DEFAULT 'ACTIVE',
    "failed_attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMP(3),
    "last_login_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "facility" (
    "id" TEXT NOT NULL,
    "mfl_code" TEXT,
    "name" TEXT NOT NULL,
    "keph_level" INTEGER NOT NULL,
    "ownership" "Ownership" NOT NULL,
    "county_id" TEXT NOT NULL,
    "subcounty_id" TEXT NOT NULL,
    "ward_id" TEXT,
    "locality" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "operating_hours" JSONB,
    "is_24_hour" BOOLEAN NOT NULL DEFAULT false,
    "bed_capacity" INTEGER,
    "icu_beds" INTEGER,
    "maternity_beds" INTEGER,
    "phone" TEXT,
    "registration_status" "FacStatus" NOT NULL DEFAULT 'PENDING',
    "licensed_until" DATE,
    "business_reg_no" TEXT,
    "kra_pin" TEXT,
    "practice_licence_no" TEXT,
    "owner_national_id" TEXT,
    "owner_name" TEXT,
    "pending_admin_practitioner_id" TEXT,
    "approved_by" TEXT,
    "approved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "facility_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "capability" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label_en" TEXT NOT NULL,
    "label_sw" TEXT NOT NULL,
    "domain" "CapDomain" NOT NULL,
    "min_keph_level" INTEGER,

    CONSTRAINT "capability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "facility_capability" (
    "id" TEXT NOT NULL,
    "facility_id" TEXT NOT NULL,
    "capability_id" TEXT NOT NULL,
    "availability" "Avail" NOT NULL DEFAULT 'ROUTINE',
    "status" "CapStatus" NOT NULL DEFAULT 'CLAIMED',
    "verified_by" TEXT,
    "verified_at" TIMESTAMP(3),
    "last_confirmed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "facility_capability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "practitioner" (
    "id" TEXT NOT NULL,
    "person_id" TEXT NOT NULL,
    "cadre" "Cadre" NOT NULL,
    "county_id" TEXT NOT NULL,
    "subcounty_id" TEXT NOT NULL,
    "status" "PracStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "practitioner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "licence" (
    "id" TEXT NOT NULL,
    "practitioner_id" TEXT NOT NULL,
    "regulator" "Regulator" NOT NULL,
    "licence_number" TEXT NOT NULL,
    "issued_on" DATE NOT NULL,
    "expires_on" DATE NOT NULL,
    "scope" TEXT,
    "verified_at" TIMESTAMP(3),
    "verified_via" TEXT,
    "status" "LicStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "licence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "affiliation" (
    "id" TEXT NOT NULL,
    "practitioner_id" TEXT NOT NULL,
    "facility_id" TEXT NOT NULL,
    "role" "FacRole" NOT NULL DEFAULT 'ATTENDING',
    "granted_by" TEXT NOT NULL,
    "granted_by_kind" "GrantKind" NOT NULL,
    "status" "AffStatus" NOT NULL DEFAULT 'ACTIVE',
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),

    CONSTRAINT "affiliation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "check_in" (
    "id" TEXT NOT NULL,
    "practitioner_id" TEXT NOT NULL,
    "facility_id" TEXT NOT NULL,
    "affiliation_id" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3),
    "end_reason" "EndReason",
    "method" "CheckMethod" NOT NULL DEFAULT 'SELF_SELECT',
    "device_hint" TEXT,
    "ip_hash" TEXT,

    CONSTRAINT "check_in_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "arrival" (
    "id" TEXT NOT NULL,
    "person_id" TEXT NOT NULL,
    "facility_id" TEXT NOT NULL,
    "arrived_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stated_reason" TEXT,
    "status" "ArrivalStatus" NOT NULL DEFAULT 'WAITING',
    "seen_by_id" TEXT,
    "closed_at" TIMESTAMP(3),
    "registered_by" TEXT NOT NULL,

    CONSTRAINT "arrival_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "encounter" (
    "id" TEXT NOT NULL,
    "person_id" TEXT NOT NULL,
    "check_in_id" TEXT NOT NULL,
    "recorded_by" TEXT NOT NULL,
    "facility_id" TEXT NOT NULL,
    "licence_number" TEXT NOT NULL,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sensitivity" "Tier" NOT NULL DEFAULT 'TIER_2_GENERAL',
    "supersedes_id" TEXT,
    "superseded_at" TIMESTAMP(3),
    "amendment_reason" TEXT,
    "kind" "EncKind" NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3),
    "chief_complaint" TEXT NOT NULL,
    "presentation" JSONB,
    "triage_band" "Band",
    "disposition" "Disposition",
    "referral_id" TEXT,

    CONSTRAINT "encounter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "condition" (
    "id" TEXT NOT NULL,
    "person_id" TEXT NOT NULL,
    "check_in_id" TEXT NOT NULL,
    "recorded_by" TEXT NOT NULL,
    "facility_id" TEXT NOT NULL,
    "licence_number" TEXT NOT NULL,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sensitivity" "Tier" NOT NULL DEFAULT 'TIER_2_GENERAL',
    "supersedes_id" TEXT,
    "superseded_at" TIMESTAMP(3),
    "amendment_reason" TEXT,
    "encounter_id" TEXT,
    "icd11_code" TEXT NOT NULL,
    "icd11_title" TEXT NOT NULL,
    "icd11_chapter" TEXT NOT NULL,
    "clinical_status" "CondStatus" NOT NULL,
    "onset_date" DATE,
    "onset_precision" "Precision",
    "resolved_date" DATE,
    "is_chronic" BOOLEAN NOT NULL DEFAULT false,
    "is_first_ever" BOOLEAN NOT NULL DEFAULT true,
    "keph_level" INTEGER NOT NULL,
    "notes" TEXT,

    CONSTRAINT "condition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "allergy" (
    "id" TEXT NOT NULL,
    "person_id" TEXT NOT NULL,
    "check_in_id" TEXT NOT NULL,
    "recorded_by" TEXT NOT NULL,
    "facility_id" TEXT NOT NULL,
    "licence_number" TEXT NOT NULL,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sensitivity" "Tier" NOT NULL DEFAULT 'TIER_1_EMERGENCY',
    "supersedes_id" TEXT,
    "superseded_at" TIMESTAMP(3),
    "amendment_reason" TEXT,
    "substance_kind" "SubstanceKind" NOT NULL,
    "substance_code" TEXT,
    "substance_label" TEXT NOT NULL,
    "allergy_class" TEXT,
    "reaction" TEXT NOT NULL,
    "severity" "Severity" NOT NULL,
    "certainty" "Certainty" NOT NULL,
    "first_observed" DATE,

    CONSTRAINT "allergy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "medication" (
    "id" TEXT NOT NULL,
    "person_id" TEXT NOT NULL,
    "check_in_id" TEXT NOT NULL,
    "recorded_by" TEXT NOT NULL,
    "facility_id" TEXT NOT NULL,
    "licence_number" TEXT NOT NULL,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sensitivity" "Tier" NOT NULL DEFAULT 'TIER_2_GENERAL',
    "supersedes_id" TEXT,
    "superseded_at" TIMESTAMP(3),
    "amendment_reason" TEXT,
    "encounter_id" TEXT NOT NULL,
    "keml_code" TEXT NOT NULL,
    "generic_name" TEXT NOT NULL,
    "brand_name" TEXT,
    "dose_amount" DECIMAL(10,3) NOT NULL,
    "dose_unit" TEXT NOT NULL,
    "route" "Route" NOT NULL,
    "frequency" TEXT NOT NULL,
    "duration_days" INTEGER,
    "quantity" DECIMAL(10,2),
    "indication_code" TEXT,
    "status" "MedStatus" NOT NULL DEFAULT 'PRESCRIBED',
    "stopped_reason" TEXT,

    CONSTRAINT "medication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "observation" (
    "id" TEXT NOT NULL,
    "person_id" TEXT NOT NULL,
    "check_in_id" TEXT NOT NULL,
    "recorded_by" TEXT NOT NULL,
    "facility_id" TEXT NOT NULL,
    "licence_number" TEXT NOT NULL,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sensitivity" "Tier" NOT NULL DEFAULT 'TIER_2_GENERAL',
    "supersedes_id" TEXT,
    "superseded_at" TIMESTAMP(3),
    "amendment_reason" TEXT,
    "encounter_id" TEXT,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "category" "ObsCat" NOT NULL,
    "value_num" DECIMAL(12,4),
    "value_text" TEXT,
    "value_code" TEXT,
    "unit" TEXT,
    "ref_low" DECIMAL(12,4),
    "ref_high" DECIMAL(12,4),
    "abnormal_flag" "Flag",
    "observed_at" TIMESTAMP(3) NOT NULL,
    "specimen_id" TEXT,

    CONSTRAINT "observation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "procedure" (
    "id" TEXT NOT NULL,
    "person_id" TEXT NOT NULL,
    "check_in_id" TEXT NOT NULL,
    "recorded_by" TEXT NOT NULL,
    "facility_id" TEXT NOT NULL,
    "licence_number" TEXT NOT NULL,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sensitivity" "Tier" NOT NULL DEFAULT 'TIER_2_GENERAL',
    "supersedes_id" TEXT,
    "superseded_at" TIMESTAMP(3),
    "amendment_reason" TEXT,
    "encounter_id" TEXT,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "performed_on" DATE NOT NULL,
    "date_precision" "Precision" NOT NULL DEFAULT 'EXACT',
    "performed_at_facility_id" TEXT,
    "external_facility_name" TEXT,
    "indication" TEXT NOT NULL,
    "outcome" TEXT,
    "complications" TEXT,
    "is_self_reported" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "procedure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consent_grant" (
    "id" TEXT NOT NULL,
    "person_id" TEXT NOT NULL,
    "facility_id" TEXT,
    "practitioner_id" TEXT,
    "scope" "Scope" NOT NULL,
    "category" "SensCat",
    "granted_by" "GrantBy" NOT NULL,
    "method" "GrantMethod" NOT NULL,
    "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "consent_grant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "access_log" (
    "id" TEXT NOT NULL,
    "person_id" TEXT NOT NULL,
    "actor_kind" "ActorKind" NOT NULL,
    "actor_id" TEXT NOT NULL,
    "check_in_id" TEXT,
    "facility_id" TEXT,
    "action" "Action" NOT NULL,
    "tier_reached" "Tier" NOT NULL,
    "target_table" TEXT,
    "target_id" TEXT,
    "reason" "AccessReason" NOT NULL,
    "outcome" "Outcome" NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip_hash" TEXT,
    "request_id" TEXT NOT NULL,

    CONSTRAINT "access_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "break_glass" (
    "id" TEXT NOT NULL,
    "person_id" TEXT NOT NULL,
    "practitioner_id" TEXT NOT NULL,
    "check_in_id" TEXT NOT NULL,
    "facility_id" TEXT NOT NULL,
    "reason_code" "BgReason" NOT NULL,
    "justification" TEXT NOT NULL,
    "categories" "SensCat"[],
    "opened_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "patient_notified_at" TIMESTAMP(3),
    "notification_channel" TEXT,
    "review_status" "ReviewStatus" NOT NULL DEFAULT 'PENDING',
    "reviewed_by" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "review_note" TEXT,

    CONSTRAINT "break_glass_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ministry_user" (
    "id" TEXT NOT NULL,
    "person_id" TEXT NOT NULL,
    "role" "MinRole" NOT NULL,
    "geo_scope" "GeoScope" NOT NULL DEFAULT 'NATIONAL',
    "county_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "mfa_required" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ministry_user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "merge_request" (
    "id" TEXT NOT NULL,
    "surviving_person_id" TEXT NOT NULL,
    "merged_person_id" TEXT NOT NULL,
    "detected_by" "DetectMode" NOT NULL,
    "match_score" DECIMAL(5,4),
    "match_evidence" JSONB,
    "status" "MergeStatus" NOT NULL DEFAULT 'PENDING',
    "approved_by" TEXT,
    "second_approver" TEXT,
    "executed_at" TIMESTAMP(3),
    "reversal_snapshot" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "merge_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "diagnosis_term" (
    "id" TEXT NOT NULL,
    "icd11_code" TEXT NOT NULL,
    "clinical_title" TEXT NOT NULL,
    "plain_en" TEXT NOT NULL,
    "plain_sw" TEXT NOT NULL,
    "synonyms" TEXT[],
    "abbreviations" TEXT[],
    "body_system" TEXT NOT NULL,
    "is_notifiable" BOOLEAN NOT NULL DEFAULT false,
    "sensitivity" "Tier" NOT NULL DEFAULT 'TIER_2_GENERAL',
    "icd11_chapter" TEXT NOT NULL,
    "review_status" TEXT NOT NULL,

    CONSTRAINT "diagnosis_term_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "medication_term" (
    "id" TEXT NOT NULL,
    "keml_code" TEXT NOT NULL,
    "generic_name" TEXT NOT NULL,
    "plain_en" TEXT NOT NULL,
    "plain_sw" TEXT NOT NULL,
    "form" TEXT NOT NULL,
    "strength" TEXT NOT NULL,
    "route" "Route" NOT NULL,
    "therapeutic_class" TEXT NOT NULL,
    "min_keph_level" INTEGER NOT NULL,
    "adult_dose" TEXT NOT NULL,
    "adult_freq" TEXT NOT NULL,
    "adult_duration_days" INTEGER,
    "paed_dose_mg_per_kg" DECIMAL(10,3),
    "paed_dosing_mode" TEXT NOT NULL,
    "max_daily_mg" DECIMAL(10,2),
    "allergy_class" TEXT,
    "pregnancy_category" TEXT NOT NULL,
    "renal_caution" BOOLEAN NOT NULL DEFAULT false,
    "controlled" BOOLEAN NOT NULL DEFAULT false,
    "synonyms" TEXT[],
    "review_status" TEXT NOT NULL,

    CONSTRAINT "medication_term_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "medication_weight_band" (
    "id" TEXT NOT NULL,
    "keml_code" TEXT NOT NULL,
    "min_kg" DECIMAL(5,2) NOT NULL,
    "max_kg" DECIMAL(5,2) NOT NULL,
    "dose_amount" DECIMAL(8,3) NOT NULL,
    "dose_unit" TEXT NOT NULL,
    "dose_form" TEXT NOT NULL,
    "frequency" TEXT NOT NULL,
    "duration_days" INTEGER,
    "notes" TEXT,

    CONSTRAINT "medication_weight_band_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "allergy_class_term" (
    "id" TEXT NOT NULL,
    "allergy_class" TEXT NOT NULL,
    "label_en" TEXT NOT NULL,
    "label_sw" TEXT NOT NULL,
    "cross_reacts_with" TEXT[],
    "severity_default" "Severity" NOT NULL,
    "alternatives" TEXT[],
    "clinical_note" TEXT,
    "review_status" TEXT NOT NULL,

    CONSTRAINT "allergy_class_term_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_token" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "family_id" TEXT NOT NULL,
    "device_hint" TEXT,
    "ip_hash" TEXT,
    "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "revoked_for" TEXT,

    CONSTRAINT "refresh_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "otp_challenge" (
    "id" TEXT NOT NULL,
    "account_id" TEXT,
    "phone_index" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),

    CONSTRAINT "otp_challenge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_envelope" (
    "id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "practitioner_id" TEXT NOT NULL,
    "facility_id" TEXT NOT NULL,
    "check_in_id" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "SyncStatus" NOT NULL DEFAULT 'QUEUED',
    "applied_at" TIMESTAMP(3),
    "result_id" TEXT,
    "rejection_code" TEXT,
    "rejection_note" TEXT,

    CONSTRAINT "sync_envelope_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referral" (
    "id" TEXT NOT NULL,
    "person_id" TEXT NOT NULL,
    "from_facility_id" TEXT NOT NULL,
    "from_encounter_id" TEXT NOT NULL,
    "referred_by" TEXT NOT NULL,
    "to_facility_id" TEXT,
    "to_specialty" TEXT,
    "urgency" "Urgency" NOT NULL,
    "reason" TEXT NOT NULL,
    "required_capabilities" TEXT[],
    "status" "RefStatus" NOT NULL DEFAULT 'ISSUED',
    "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "responded_at" TIMESTAMP(3),
    "responded_by" TEXT,
    "decline_reason" TEXT,
    "arrived_at" TIMESTAMP(3),
    "arrival_encounter_id" TEXT,
    "cancelled_reason" TEXT,

    CONSTRAINT "referral_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "counter_referral" (
    "id" TEXT NOT NULL,
    "referral_id" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "outcome_code" TEXT,
    "follow_up_plan" TEXT,
    "returned_by" TEXT NOT NULL,
    "returned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "facility_id" TEXT NOT NULL,
    "licence_number" TEXT NOT NULL,

    CONSTRAINT "counter_referral_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "symptom_term" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label_en" TEXT NOT NULL,
    "label_sw" TEXT NOT NULL,
    "question_en" TEXT NOT NULL,
    "question_sw" TEXT NOT NULL,
    "body_system" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "severity_marker" BOOLEAN NOT NULL DEFAULT false,
    "min_age" DOUBLE PRECISION NOT NULL,
    "max_age" DOUBLE PRECISION NOT NULL,
    "sex" TEXT NOT NULL DEFAULT 'ANY',
    "duration_relevant" BOOLEAN NOT NULL DEFAULT false,
    "review_status" TEXT NOT NULL,

    CONSTRAINT "symptom_term_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "triage_rule" (
    "id" TEXT NOT NULL,
    "rule_id" TEXT NOT NULL,
    "symptoms" TEXT[],
    "age_min" DOUBLE PRECISION NOT NULL,
    "age_max" DOUBLE PRECISION NOT NULL,
    "red_flag" BOOLEAN NOT NULL,
    "urgency" TEXT NOT NULL,
    "required_capabilities" TEXT[],
    "min_keph_level" INTEGER NOT NULL,
    "advice_en" TEXT NOT NULL,
    "advice_sw" TEXT NOT NULL,
    "reviewed_by" TEXT NOT NULL,
    "review_status" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "triage_rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recommendation" (
    "id" TEXT NOT NULL,
    "person_id" TEXT,
    "symptoms" TEXT[],
    "age_years" DOUBLE PRECISION NOT NULL,
    "rule_version" INTEGER NOT NULL,
    "rules_fired" TEXT[],
    "red_flag_shown" BOOLEAN NOT NULL,
    "urgency" TEXT,
    "facilities_offered" JSONB NOT NULL,
    "scope" TEXT NOT NULL,
    "from_latitude" DOUBLE PRECISION,
    "from_longitude" DOUBLE PRECISION,
    "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acted_on_encounter_id" TEXT,

    CONSTRAINT "recommendation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agg_condition_daily" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "county_id" TEXT NOT NULL,
    "subcounty_id" TEXT,
    "icd11_code" TEXT NOT NULL,
    "icd11_chapter" TEXT NOT NULL,
    "age_band" TEXT NOT NULL,
    "sex" TEXT NOT NULL,
    "keph_level" INTEGER NOT NULL,
    "case_count" INTEGER NOT NULL,
    "new_case_count" INTEGER NOT NULL,
    "suppressed" BOOLEAN NOT NULL DEFAULT false,
    "suppression_reason" TEXT,
    "facilities_reporting" INTEGER NOT NULL,
    "facilities_expected" INTEGER NOT NULL,

    CONSTRAINT "agg_condition_daily_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "county_code_key" ON "county"("code");

-- CreateIndex
CREATE INDEX "subcounty_county_id_idx" ON "subcounty"("county_id");

-- CreateIndex
CREATE INDEX "ward_subcounty_id_idx" ON "ward"("subcounty_id");

-- CreateIndex
CREATE UNIQUE INDEX "person_display_number_key" ON "person"("display_number");

-- CreateIndex
CREATE INDEX "person_county_id_subcounty_id_idx" ON "person"("county_id", "subcounty_id");

-- CreateIndex
CREATE INDEX "person_maturity_date_of_birth_idx" ON "person"("maturity", "date_of_birth");

-- CreateIndex
CREATE INDEX "identifier_person_id_type_idx" ON "identifier"("person_id", "type");

-- CreateIndex
CREATE INDEX "identifier_value_index_idx" ON "identifier"("value_index");

-- CreateIndex
CREATE INDEX "guardianship_guardian_id_status_idx" ON "guardianship"("guardian_id", "status");

-- CreateIndex
CREATE INDEX "guardianship_dependant_id_status_idx" ON "guardianship"("dependant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "account_person_id_key" ON "account"("person_id");

-- CreateIndex
CREATE UNIQUE INDEX "account_practitioner_id_key" ON "account"("practitioner_id");

-- CreateIndex
CREATE UNIQUE INDEX "account_ministry_user_id_key" ON "account"("ministry_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "account_phone_index_key" ON "account"("phone_index");

-- CreateIndex
CREATE INDEX "account_email_index_idx" ON "account"("email_index");

-- CreateIndex
CREATE UNIQUE INDEX "facility_mfl_code_key" ON "facility"("mfl_code");

-- CreateIndex
CREATE INDEX "facility_county_id_keph_level_registration_status_idx" ON "facility"("county_id", "keph_level", "registration_status");

-- CreateIndex
CREATE INDEX "facility_name_idx" ON "facility"("name");

-- CreateIndex
CREATE UNIQUE INDEX "capability_code_key" ON "capability"("code");

-- CreateIndex
CREATE INDEX "facility_capability_capability_id_idx" ON "facility_capability"("capability_id");

-- CreateIndex
CREATE UNIQUE INDEX "facility_capability_facility_id_capability_id_key" ON "facility_capability"("facility_id", "capability_id");

-- CreateIndex
CREATE UNIQUE INDEX "practitioner_person_id_key" ON "practitioner"("person_id");

-- CreateIndex
CREATE INDEX "licence_practitioner_id_idx" ON "licence"("practitioner_id");

-- CreateIndex
CREATE INDEX "licence_expires_on_idx" ON "licence"("expires_on");

-- CreateIndex
CREATE UNIQUE INDEX "licence_regulator_licence_number_key" ON "licence"("regulator", "licence_number");

-- CreateIndex
CREATE INDEX "affiliation_practitioner_id_status_idx" ON "affiliation"("practitioner_id", "status");

-- CreateIndex
CREATE INDEX "affiliation_facility_id_status_idx" ON "affiliation"("facility_id", "status");

-- CreateIndex
CREATE INDEX "check_in_practitioner_id_ended_at_idx" ON "check_in"("practitioner_id", "ended_at");

-- CreateIndex
CREATE INDEX "check_in_facility_id_started_at_idx" ON "check_in"("facility_id", "started_at");

-- CreateIndex
CREATE INDEX "arrival_facility_id_status_arrived_at_idx" ON "arrival"("facility_id", "status", "arrived_at");

-- CreateIndex
CREATE INDEX "arrival_person_id_arrived_at_idx" ON "arrival"("person_id", "arrived_at");

-- CreateIndex
CREATE INDEX "encounter_person_id_started_at_idx" ON "encounter"("person_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "encounter_facility_id_started_at_idx" ON "encounter"("facility_id", "started_at");

-- CreateIndex
CREATE INDEX "encounter_check_in_id_idx" ON "encounter"("check_in_id");

-- CreateIndex
CREATE INDEX "condition_icd11_code_recorded_at_idx" ON "condition"("icd11_code", "recorded_at");

-- CreateIndex
CREATE INDEX "condition_person_id_is_chronic_clinical_status_idx" ON "condition"("person_id", "is_chronic", "clinical_status");

-- CreateIndex
CREATE INDEX "condition_encounter_id_idx" ON "condition"("encounter_id");

-- CreateIndex
CREATE INDEX "allergy_person_id_idx" ON "allergy"("person_id");

-- CreateIndex
CREATE INDEX "medication_person_id_status_idx" ON "medication"("person_id", "status");

-- CreateIndex
CREATE INDEX "medication_encounter_id_idx" ON "medication"("encounter_id");

-- CreateIndex
CREATE INDEX "observation_person_id_code_observed_at_idx" ON "observation"("person_id", "code", "observed_at" DESC);

-- CreateIndex
CREATE INDEX "observation_encounter_id_idx" ON "observation"("encounter_id");

-- CreateIndex
CREATE INDEX "procedure_person_id_performed_on_idx" ON "procedure"("person_id", "performed_on" DESC);

-- CreateIndex
CREATE INDEX "consent_grant_person_id_facility_id_expires_at_idx" ON "consent_grant"("person_id", "facility_id", "expires_at");

-- CreateIndex
CREATE INDEX "access_log_person_id_occurred_at_idx" ON "access_log"("person_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "access_log_actor_id_occurred_at_idx" ON "access_log"("actor_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "break_glass_facility_id_opened_at_idx" ON "break_glass"("facility_id", "opened_at");

-- CreateIndex
CREATE INDEX "break_glass_review_status_opened_at_idx" ON "break_glass"("review_status", "opened_at");

-- CreateIndex
CREATE UNIQUE INDEX "ministry_user_person_id_key" ON "ministry_user"("person_id");

-- CreateIndex
CREATE UNIQUE INDEX "diagnosis_term_icd11_code_key" ON "diagnosis_term"("icd11_code");

-- CreateIndex
CREATE INDEX "diagnosis_term_body_system_idx" ON "diagnosis_term"("body_system");

-- CreateIndex
CREATE INDEX "diagnosis_term_is_notifiable_idx" ON "diagnosis_term"("is_notifiable");

-- CreateIndex
CREATE UNIQUE INDEX "medication_term_keml_code_key" ON "medication_term"("keml_code");

-- CreateIndex
CREATE INDEX "medication_term_therapeutic_class_idx" ON "medication_term"("therapeutic_class");

-- CreateIndex
CREATE INDEX "medication_term_allergy_class_idx" ON "medication_term"("allergy_class");

-- CreateIndex
CREATE INDEX "medication_weight_band_keml_code_idx" ON "medication_weight_band"("keml_code");

-- CreateIndex
CREATE UNIQUE INDEX "medication_weight_band_keml_code_min_kg_key" ON "medication_weight_band"("keml_code", "min_kg");

-- CreateIndex
CREATE UNIQUE INDEX "allergy_class_term_allergy_class_key" ON "allergy_class_term"("allergy_class");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_token_token_hash_key" ON "refresh_token"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_token_account_id_revoked_at_idx" ON "refresh_token"("account_id", "revoked_at");

-- CreateIndex
CREATE INDEX "refresh_token_family_id_idx" ON "refresh_token"("family_id");

-- CreateIndex
CREATE INDEX "otp_challenge_phone_index_purpose_expires_at_idx" ON "otp_challenge"("phone_index", "purpose", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "sync_envelope_idempotency_key_key" ON "sync_envelope"("idempotency_key");

-- CreateIndex
CREATE INDEX "sync_envelope_status_received_at_idx" ON "sync_envelope"("status", "received_at");

-- CreateIndex
CREATE INDEX "sync_envelope_device_id_occurred_at_idx" ON "sync_envelope"("device_id", "occurred_at");

-- CreateIndex
CREATE INDEX "referral_person_id_issued_at_idx" ON "referral"("person_id", "issued_at");

-- CreateIndex
CREATE INDEX "referral_to_facility_id_status_idx" ON "referral"("to_facility_id", "status");

-- CreateIndex
CREATE INDEX "referral_from_facility_id_issued_at_idx" ON "referral"("from_facility_id", "issued_at");

-- CreateIndex
CREATE INDEX "referral_status_expires_at_idx" ON "referral"("status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "counter_referral_referral_id_key" ON "counter_referral"("referral_id");

-- CreateIndex
CREATE UNIQUE INDEX "symptom_term_code_key" ON "symptom_term"("code");

-- CreateIndex
CREATE INDEX "symptom_term_body_system_idx" ON "symptom_term"("body_system");

-- CreateIndex
CREATE INDEX "symptom_term_kind_idx" ON "symptom_term"("kind");

-- CreateIndex
CREATE UNIQUE INDEX "triage_rule_rule_id_key" ON "triage_rule"("rule_id");

-- CreateIndex
CREATE INDEX "triage_rule_red_flag_active_idx" ON "triage_rule"("red_flag", "active");

-- CreateIndex
CREATE INDEX "recommendation_person_id_issued_at_idx" ON "recommendation"("person_id", "issued_at");

-- CreateIndex
CREATE INDEX "recommendation_issued_at_idx" ON "recommendation"("issued_at");

-- CreateIndex
CREATE INDEX "agg_condition_daily_date_county_id_idx" ON "agg_condition_daily"("date", "county_id");

-- CreateIndex
CREATE INDEX "agg_condition_daily_icd11_code_date_idx" ON "agg_condition_daily"("icd11_code", "date");

-- CreateIndex
CREATE UNIQUE INDEX "agg_condition_daily_date_county_id_subcounty_id_icd11_code__key" ON "agg_condition_daily"("date", "county_id", "subcounty_id", "icd11_code", "age_band", "sex", "keph_level");

-- AddForeignKey
ALTER TABLE "subcounty" ADD CONSTRAINT "subcounty_county_id_fkey" FOREIGN KEY ("county_id") REFERENCES "county"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ward" ADD CONSTRAINT "ward_subcounty_id_fkey" FOREIGN KEY ("subcounty_id") REFERENCES "subcounty"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "person" ADD CONSTRAINT "person_county_id_fkey" FOREIGN KEY ("county_id") REFERENCES "county"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "person" ADD CONSTRAINT "person_subcounty_id_fkey" FOREIGN KEY ("subcounty_id") REFERENCES "subcounty"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identifier" ADD CONSTRAINT "identifier_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guardianship" ADD CONSTRAINT "guardianship_dependant_id_fkey" FOREIGN KEY ("dependant_id") REFERENCES "person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guardianship" ADD CONSTRAINT "guardianship_guardian_id_fkey" FOREIGN KEY ("guardian_id") REFERENCES "person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account" ADD CONSTRAINT "account_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "person"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "facility" ADD CONSTRAINT "facility_county_id_fkey" FOREIGN KEY ("county_id") REFERENCES "county"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "facility" ADD CONSTRAINT "facility_subcounty_id_fkey" FOREIGN KEY ("subcounty_id") REFERENCES "subcounty"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "facility_capability" ADD CONSTRAINT "facility_capability_facility_id_fkey" FOREIGN KEY ("facility_id") REFERENCES "facility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "facility_capability" ADD CONSTRAINT "facility_capability_capability_id_fkey" FOREIGN KEY ("capability_id") REFERENCES "capability"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "practitioner" ADD CONSTRAINT "practitioner_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "licence" ADD CONSTRAINT "licence_practitioner_id_fkey" FOREIGN KEY ("practitioner_id") REFERENCES "practitioner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "affiliation" ADD CONSTRAINT "affiliation_practitioner_id_fkey" FOREIGN KEY ("practitioner_id") REFERENCES "practitioner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "affiliation" ADD CONSTRAINT "affiliation_facility_id_fkey" FOREIGN KEY ("facility_id") REFERENCES "facility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "check_in" ADD CONSTRAINT "check_in_practitioner_id_fkey" FOREIGN KEY ("practitioner_id") REFERENCES "practitioner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "check_in" ADD CONSTRAINT "check_in_facility_id_fkey" FOREIGN KEY ("facility_id") REFERENCES "facility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "check_in" ADD CONSTRAINT "check_in_affiliation_id_fkey" FOREIGN KEY ("affiliation_id") REFERENCES "affiliation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "arrival" ADD CONSTRAINT "arrival_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "arrival" ADD CONSTRAINT "arrival_facility_id_fkey" FOREIGN KEY ("facility_id") REFERENCES "facility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "encounter" ADD CONSTRAINT "encounter_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "encounter" ADD CONSTRAINT "encounter_check_in_id_fkey" FOREIGN KEY ("check_in_id") REFERENCES "check_in"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "condition" ADD CONSTRAINT "condition_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "condition" ADD CONSTRAINT "condition_check_in_id_fkey" FOREIGN KEY ("check_in_id") REFERENCES "check_in"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "condition" ADD CONSTRAINT "condition_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "encounter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "allergy" ADD CONSTRAINT "allergy_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "allergy" ADD CONSTRAINT "allergy_check_in_id_fkey" FOREIGN KEY ("check_in_id") REFERENCES "check_in"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "medication" ADD CONSTRAINT "medication_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "medication" ADD CONSTRAINT "medication_check_in_id_fkey" FOREIGN KEY ("check_in_id") REFERENCES "check_in"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "medication" ADD CONSTRAINT "medication_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "encounter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "observation" ADD CONSTRAINT "observation_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "observation" ADD CONSTRAINT "observation_check_in_id_fkey" FOREIGN KEY ("check_in_id") REFERENCES "check_in"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "procedure" ADD CONSTRAINT "procedure_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "procedure" ADD CONSTRAINT "procedure_check_in_id_fkey" FOREIGN KEY ("check_in_id") REFERENCES "check_in"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consent_grant" ADD CONSTRAINT "consent_grant_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ministry_user" ADD CONSTRAINT "ministry_user_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_token" ADD CONSTRAINT "refresh_token_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "counter_referral" ADD CONSTRAINT "counter_referral_referral_id_fkey" FOREIGN KEY ("referral_id") REFERENCES "referral"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

