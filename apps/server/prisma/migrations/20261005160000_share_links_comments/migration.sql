-- FLR-T-9.6: share links and comments. Expand-only: two new tables; nothing existing changes.
-- CreateTable
CREATE TABLE "share_links" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "created_by_account_id" UUID NOT NULL,
    "label" TEXT,
    "token_hash" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "version_hash" TEXT,
    "version_seq" INTEGER,
    "show_plan" BOOLEAN NOT NULL,
    "show_3d" BOOLEAN NOT NULL,
    "show_findings" BOOLEAN NOT NULL,
    "allow_comments" BOOLEAN NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "last_used_at" TIMESTAMPTZ(6),
    "view_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "share_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comments" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "share_link_id" UUID,
    "parent_id" UUID,
    "author_account_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "element_id" TEXT,
    "level_id" TEXT,
    "version_hash" TEXT NOT NULL,
    "point_x" INTEGER,
    "point_y" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "edited_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),
    "resolved_at" TIMESTAMPTZ(6),
    "resolved_by_account_id" UUID,

    CONSTRAINT "comments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "share_links_token_hash_key" ON "share_links"("token_hash");

-- CreateIndex
CREATE INDEX "share_links_project_id_created_at_idx" ON "share_links"("project_id", "created_at");

-- CreateIndex
CREATE INDEX "comments_project_id_created_at_idx" ON "comments"("project_id", "created_at");

-- CreateIndex
CREATE INDEX "comments_share_link_id_created_at_idx" ON "comments"("share_link_id", "created_at");

-- CreateIndex
CREATE INDEX "comments_parent_id_idx" ON "comments"("parent_id");

-- AddForeignKey
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_created_by_account_id_fkey" FOREIGN KEY ("created_by_account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_version_hash_fkey" FOREIGN KEY ("version_hash") REFERENCES "versions"("hash") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_share_link_id_fkey" FOREIGN KEY ("share_link_id") REFERENCES "share_links"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "comments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_author_account_id_fkey" FOREIGN KEY ("author_account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_resolved_by_account_id_fkey" FOREIGN KEY ("resolved_by_account_id") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_version_hash_fkey" FOREIGN KEY ("version_hash") REFERENCES "versions"("hash") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- A link always expires, at most a year after it was made, shows something, and allows comments
-- only where there is a plan or a 3D view to pin them to.
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_expiry_check"
  CHECK ("expires_at" > "created_at" AND "expires_at" <= "created_at" + interval '366 days');
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_shows_something"
  CHECK ("show_plan" OR "show_3d" OR "show_findings");
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_comments_need_a_view"
  CHECK (NOT "allow_comments" OR "show_plan" OR "show_3d");
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_pin_check"
  CHECK (("version_hash" IS NULL) = ("version_seq" IS NULL));
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_label_length"
  CHECK ("label" IS NULL OR char_length("label") BETWEEN 1 AND 80);
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_token_hash_is_sha256"
  CHECK ("token_hash" ~ '^[0-9a-f]{64}$');

-- A thread's root is pinned to an element on a level; a reply is not. A point is both
-- coordinates or neither. A deleted comment keeps no text.
ALTER TABLE "comments" ADD CONSTRAINT "comments_root_is_pinned"
  CHECK (("parent_id" IS NULL) = ("element_id" IS NOT NULL AND "level_id" IS NOT NULL));
ALTER TABLE "comments" ADD CONSTRAINT "comments_point_check"
  CHECK (("point_x" IS NULL) = ("point_y" IS NULL));
ALTER TABLE "comments" ADD CONSTRAINT "comments_body_length"
  CHECK (char_length("body") <= 4000);
ALTER TABLE "comments" ADD CONSTRAINT "comments_deleted_is_blank"
  CHECK ("deleted_at" IS NULL OR "body" = '');
ALTER TABLE "comments" ADD CONSTRAINT "comments_resolved_is_root"
  CHECK ("resolved_at" IS NULL OR "parent_id" IS NULL);
