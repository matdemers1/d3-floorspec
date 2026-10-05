-- FLR-T-8.2: a project's claim on files in the content-addressed asset store (ASSET_DIR). The bytes
-- live on the asset volume, keyed by SHA-256; this table records which project uploaded which
-- digest, so its owner can read them back. Expand-only: a new table, which the previous release
-- never reads.
-- CreateTable
CREATE TABLE "project_assets" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "sha256" TEXT NOT NULL,
    "media_type" TEXT NOT NULL,
    "byte_length" INTEGER NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "name" TEXT,
    "uploaded_by_account_id" UUID,
    "uploaded_by_token_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_assets_pkey" PRIMARY KEY ("id"),
    -- The store's key: anything else could name a path.
    CONSTRAINT "project_assets_sha256_hex" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "project_assets_byte_length_nonneg" CHECK ("byte_length" >= 0)
);

-- CreateIndex
CREATE INDEX "project_assets_sha256_idx" ON "project_assets"("sha256");

-- CreateIndex
CREATE UNIQUE INDEX "project_assets_project_id_sha256_key" ON "project_assets"("project_id", "sha256");

-- AddForeignKey
ALTER TABLE "project_assets" ADD CONSTRAINT "project_assets_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_assets" ADD CONSTRAINT "project_assets_uploaded_by_account_id_fkey" FOREIGN KEY ("uploaded_by_account_id") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
