-- FLR-T-14.2: a virtual tour. Expand-only: a table for a job's other files (a tour's panoramas and
-- plans, by path), and a nullable column naming the tour a share link shows. A tour link shows the
-- tour and nothing else — no plan, 3D view, findings or comments — so the check that a link shows
-- something counts a tour.

-- CreateTable
CREATE TABLE "job_assets" (
    "job_id" UUID NOT NULL,
    "path" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "bytes" BYTEA NOT NULL,
    "sha256" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_assets_pkey" PRIMARY KEY ("job_id","path")
);

-- AddForeignKey
ALTER TABLE "job_assets" ADD CONSTRAINT "job_assets_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "job_assets" ADD CONSTRAINT "job_assets_path_check"
  CHECK ("path" ~ '^[a-z0-9][a-z0-9._-]{0,127}$');

-- AlterTable
ALTER TABLE "share_links" ADD COLUMN "tour_job_id" UUID;

-- AddForeignKey
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_tour_job_id_fkey" FOREIGN KEY ("tour_job_id") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "share_links_tour_job_id_idx" ON "share_links"("tour_job_id");

ALTER TABLE "share_links" DROP CONSTRAINT "share_links_shows_something";
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_shows_something"
  CHECK ("show_plan" OR "show_3d" OR "show_findings" OR "tour_job_id" IS NOT NULL);
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_tour_alone"
  CHECK ("tour_job_id" IS NULL OR NOT ("show_plan" OR "show_3d" OR "show_findings" OR "allow_comments"));
