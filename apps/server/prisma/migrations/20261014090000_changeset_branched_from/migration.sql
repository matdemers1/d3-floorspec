-- FLR-T-18.18: a changeset branched from an earlier version of main remembers that version, so its
-- first op — the return to it — is made again against main when it is replayed, instead of being
-- sent stale. Expand-only: a nullable column the previous release never reads.
-- AlterTable
ALTER TABLE "changesets" ADD COLUMN "branched_from" INTEGER;
