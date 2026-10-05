-- FLR-T-12.6: a long job (a path-traced still) says how far it has got. Expand-only: one nullable
-- column; the worker writes it while it holds the job, and the api shows it.
ALTER TABLE "jobs" ADD COLUMN "progress" JSONB;
