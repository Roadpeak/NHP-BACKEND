-- Restore the arrival → facility foreign key.
--
-- Dropped by a test that tried to reproduce an orphaned arrival, and left
-- off when that test failed before restoring it. The debris it was written
-- to reproduce is real: the test suite and the reset scripts TRUNCATE
-- facility and person, leaving arrival rows pointing at nothing, which is
-- how the payer rollup met the "Field facility is required" crash.
--
-- Run against the LOCAL development database only. It deletes arrival rows
-- whose facility no longer exists — dead rows referencing nothing, which is
-- also what blocks the constraint from being added back.
--
--   psql postgresql://…/nhp -f scripts/restore-arrival-fk.sql

BEGIN;

DELETE FROM arrival a
 USING (
   SELECT a2.id
     FROM arrival a2
     LEFT JOIN facility f ON f.id = a2.facility_id
    WHERE f.id IS NULL
 ) orphaned
 WHERE a.id = orphaned.id;

ALTER TABLE "arrival"
  ADD CONSTRAINT "arrival_facility_id_fkey"
  FOREIGN KEY ("facility_id") REFERENCES "facility"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;

SELECT conname FROM pg_constraint
 WHERE conrelid = 'arrival'::regclass AND contype = 'f'
 ORDER BY conname;
