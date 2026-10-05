-- FLR-T-12.1, FLR-T-12.2: the nightly backup's and weekly restore drill's recorded runs, and the
-- alerts raised about them. Expand-only: two new tables and an enum; nothing existing changes.
-- CreateEnum
CREATE TYPE "MaintenanceStatus" AS ENUM ('running', 'succeeded', 'failed');

-- CreateTable
CREATE TABLE "maintenance_runs" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "status" "MaintenanceStatus" NOT NULL DEFAULT 'running',
    "result" JSONB,
    "error" TEXT,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "maintenance_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alerts" (
    "id" BIGSERIAL NOT NULL,
    "kind" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "sent" BOOLEAN NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alerts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "maintenance_runs_key_key" ON "maintenance_runs"("key");

-- CreateIndex
CREATE INDEX "maintenance_runs_kind_started_at_idx" ON "maintenance_runs"("kind", "started_at");

-- CreateIndex
CREATE INDEX "alerts_kind_created_at_idx" ON "alerts"("kind", "created_at");

ALTER TABLE "maintenance_runs" ADD CONSTRAINT "maintenance_runs_kind_check" CHECK ("kind" IN ('backup', 'restore-drill'));
ALTER TABLE "maintenance_runs" ADD CONSTRAINT "maintenance_runs_trigger_check" CHECK ("trigger" IN ('schedule', 'manual'));
