-- AlterEnum
ALTER TYPE "DirectorRole" ADD VALUE 'RECEPTION';

-- AlterTable
ALTER TABLE "account" ADD COLUMN     "must_change_password" BOOLEAN NOT NULL DEFAULT false;

