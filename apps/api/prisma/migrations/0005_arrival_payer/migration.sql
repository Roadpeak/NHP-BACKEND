-- CreateEnum
CREATE TYPE "PayerKind" AS ENUM ('CASH', 'SHA', 'PRIVATE_INSURANCE', 'EMPLOYER', 'NGO_DONOR', 'WAIVER', 'UNKNOWN');

-- AlterTable
ALTER TABLE "arrival" ADD COLUMN     "payer_org_id" TEXT,
ADD COLUMN     "stated_payer" "PayerKind" NOT NULL DEFAULT 'UNKNOWN';

-- CreateTable
CREATE TABLE "payer_organisation" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "PayerKind" NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "payer_organisation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agg_payer_daily" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "county_id" TEXT NOT NULL,
    "subcounty_id" TEXT,
    "stated_payer" TEXT NOT NULL,
    "keph_level" INTEGER NOT NULL,
    "arrival_count" INTEGER NOT NULL,
    "suppressed" BOOLEAN NOT NULL DEFAULT false,
    "suppression_reason" TEXT,

    CONSTRAINT "agg_payer_daily_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payer_organisation_code_key" ON "payer_organisation"("code");

-- CreateIndex
CREATE INDEX "agg_payer_daily_date_county_id_idx" ON "agg_payer_daily"("date", "county_id");

-- CreateIndex
CREATE UNIQUE INDEX "agg_payer_daily_date_county_id_subcounty_id_stated_payer_ke_key" ON "agg_payer_daily"("date", "county_id", "subcounty_id", "stated_payer", "keph_level");

-- AddForeignKey
ALTER TABLE "arrival" ADD CONSTRAINT "arrival_payer_org_id_fkey" FOREIGN KEY ("payer_org_id") REFERENCES "payer_organisation"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- The Ministry dashboard role reads aggregates only. Granted here rather
-- than in harden.sql so a deploy that runs migrations without re-running
-- the hardening script still ends up with a working payer panel.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nhp_analyst') THEN
    GRANT SELECT ON agg_payer_daily TO nhp_analyst;
  END IF;
END $$;
