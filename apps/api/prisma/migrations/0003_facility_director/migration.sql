-- CreateEnum
CREATE TYPE "DirectorRole" AS ENUM ('OWNER', 'DIRECTOR', 'MANAGER');

-- CreateEnum
CREATE TYPE "DirectorStatus" AS ENUM ('PENDING', 'ACTIVE', 'ENDED');

-- CreateEnum
CREATE TYPE "AppointedByKind" AS ENUM ('SELF', 'MINISTRY');

-- AlterTable
ALTER TABLE "facility" ADD COLUMN     "pending_director_person_id" TEXT;

-- CreateTable
CREATE TABLE "facility_director" (
    "id" TEXT NOT NULL,
    "facility_id" TEXT NOT NULL,
    "person_id" TEXT NOT NULL,
    "role" "DirectorRole" NOT NULL DEFAULT 'DIRECTOR',
    "status" "DirectorStatus" NOT NULL DEFAULT 'PENDING',
    "appointed_by" TEXT NOT NULL,
    "appointed_by_kind" "AppointedByKind" NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),

    CONSTRAINT "facility_director_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "facility_director_facility_id_status_idx" ON "facility_director"("facility_id", "status");

-- CreateIndex
CREATE INDEX "facility_director_person_id_status_idx" ON "facility_director"("person_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "facility_director_facility_id_person_id_key" ON "facility_director"("facility_id", "person_id");

-- AddForeignKey
ALTER TABLE "facility_director" ADD CONSTRAINT "facility_director_facility_id_fkey" FOREIGN KEY ("facility_id") REFERENCES "facility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "facility_director" ADD CONSTRAINT "facility_director_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

