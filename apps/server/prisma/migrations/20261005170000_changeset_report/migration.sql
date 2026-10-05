-- FLR-T-9.5: a changeset made by importing an edited IFC file carries the report of what the import
-- could not map — every unmapped, ambiguous or refused edit, with its IFC GlobalId — so the person
-- reviewing it sees what did not come across. Expand-only: a nullable column the previous release
-- never reads.
-- AlterTable
ALTER TABLE "changesets" ADD COLUMN "report" JSONB;
