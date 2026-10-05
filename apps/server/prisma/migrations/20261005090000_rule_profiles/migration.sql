-- FLR-T-6.8: jurisdiction profiles (Floorspec Rules 0.1, chapter 10) an account builds, and the one
-- each project's findings are evaluated under. Expand-only: a new table and a nullable column, so
-- every row the previous release writes still satisfies every constraint here — and a project with
-- no profile is evaluated under the default, as it was before.
-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "rule_profile_id" UUID;

-- CreateTable
CREATE TABLE "rule_profiles" (
    "id" UUID NOT NULL,
    "owner_account_id" UUID NOT NULL,
    "profile" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "rule_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "rule_profiles_owner_account_id_idx" ON "rule_profiles"("owner_account_id");

-- CreateIndex
CREATE INDEX "projects_rule_profile_id_idx" ON "projects"("rule_profile_id");

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_rule_profile_id_fkey" FOREIGN KEY ("rule_profile_id") REFERENCES "rule_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_profiles" ADD CONSTRAINT "rule_profiles_owner_account_id_fkey" FOREIGN KEY ("owner_account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
