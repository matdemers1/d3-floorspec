-- FLR-T-14.3: an AR model shared to a phone. Expand-only: a nullable column naming the USDZ export a
-- share link shows. An AR link shows the model and nothing else — no plan, 3D view, findings,
-- comments or tour — so the check that a link shows something counts it.

-- AlterTable
ALTER TABLE "share_links" ADD COLUMN "ar_job_id" UUID;

-- AddForeignKey
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_ar_job_id_fkey" FOREIGN KEY ("ar_job_id") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "share_links_ar_job_id_idx" ON "share_links"("ar_job_id");

ALTER TABLE "share_links" DROP CONSTRAINT "share_links_shows_something";
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_shows_something"
  CHECK ("show_plan" OR "show_3d" OR "show_findings" OR "tour_job_id" IS NOT NULL OR "ar_job_id" IS NOT NULL);
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_ar_alone"
  CHECK ("ar_job_id" IS NULL OR ("tour_job_id" IS NULL AND NOT ("show_plan" OR "show_3d" OR "show_findings" OR "allow_comments")));
