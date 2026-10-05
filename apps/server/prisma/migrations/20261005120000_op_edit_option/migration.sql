-- FLR-T-8.4: the design option an edit was made in (Floorspec Ops 0.3, 2.8: `context.option`), so
-- a changeset replays its batches in the option they were drawn in, and the history says which.
-- Expand-only: a nullable column; every row the previous release writes still satisfies it.
-- AlterTable
ALTER TABLE "op_log" ADD COLUMN     "edit_option" TEXT;
