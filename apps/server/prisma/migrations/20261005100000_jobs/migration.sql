-- FLR-T-9.3: the Postgres job queue — the api enqueues, the worker drains — and the files finished
-- jobs make. Expand-only: two new tables and an enum; nothing existing changes.
-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('queued', 'running', 'done', 'failed');

-- CreateTable
CREATE TABLE "jobs" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'queued',
    "params" JSONB NOT NULL,
    "version_hash" TEXT NOT NULL,
    "requested_by_account_id" UUID,
    "requested_by_token_id" UUID,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_by" TEXT,
    "locked_at" TIMESTAMPTZ(6),
    "error" TEXT,
    "result" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_outputs" (
    "job_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "bytes" BYTEA NOT NULL,
    "sha256" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_outputs_pkey" PRIMARY KEY ("job_id")
);

-- CreateIndex
CREATE INDEX "jobs_status_created_at_idx" ON "jobs"("status", "created_at");

-- CreateIndex
CREATE INDEX "jobs_project_id_created_at_idx" ON "jobs"("project_id", "created_at");

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_version_hash_fkey" FOREIGN KEY ("version_hash") REFERENCES "versions"("hash") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_requested_by_account_id_fkey" FOREIGN KEY ("requested_by_account_id") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_outputs" ADD CONSTRAINT "job_outputs_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;


ALTER TABLE "jobs" ADD CONSTRAINT "jobs_attempts_check" CHECK ("attempts" >= 0);

-- Wake the workers: a queued job is announced on `floorspec_jobs` (its ID) when its insert commits.
CREATE FUNCTION "announce_job"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('floorspec_jobs', NEW."id"::text);
  RETURN NEW;
END;
$$;
CREATE TRIGGER "jobs_announce" AFTER INSERT ON "jobs"
  FOR EACH ROW WHEN (NEW."status" = 'queued') EXECUTE FUNCTION "announce_job"();
