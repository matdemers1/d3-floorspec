-- FLR-T-2.4, FLR-T-2.5: the op log carries what undo and replay need; changesets, API tokens and
-- retired IDs. Expand-only: every column added is nullable or defaulted, nothing is dropped or renamed,
-- and every row the previous release writes still satisfies every constraint here.
-- CreateEnum
CREATE TYPE "OpKind" AS ENUM ('create', 'apply', 'undo', 'redo', 'merge');

-- CreateEnum
CREATE TYPE "ChangesetStatus" AS ENUM ('pending', 'accepted', 'rejected');

-- CreateEnum
CREATE TYPE "MergeMode" AS ENUM ('fast_forward', 'replay');

-- CreateEnum
CREATE TYPE "TokenScope" AS ENUM ('read', 'write', 'agent');

-- AlterEnum
ALTER TYPE "AuthorKind" ADD VALUE 'token';

-- AlterTable
ALTER TABLE "op_log" ADD COLUMN     "author_token_id" UUID,
ADD COLUMN     "changeset_id" UUID,
ADD COLUMN     "created" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "head" TEXT NOT NULL DEFAULT 'main',
ADD COLUMN     "inverse" JSONB,
ADD COLUMN     "kind" "OpKind" NOT NULL DEFAULT 'apply',
ADD COLUMN     "removed" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "resolved" JSONB,
ADD COLUMN     "undo_of_id" UUID;

-- CreateTable
CREATE TABLE "retired_ids" (
    "project_id" UUID NOT NULL,
    "element_id" TEXT NOT NULL,
    "changeset_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "retired_ids_pkey" PRIMARY KEY ("project_id","element_id")
);

-- CreateTable
CREATE TABLE "changesets" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" "ChangesetStatus" NOT NULL DEFAULT 'pending',
    "base_hash" TEXT NOT NULL,
    "created_by_account_id" UUID,
    "created_by_token_id" UUID,
    "created_by_agent" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "closed_at" TIMESTAMPTZ(6),
    "closed_by_account_id" UUID,
    "merge_mode" "MergeMode",
    "merged_hash" TEXT,

    CONSTRAINT "changesets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_tokens" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "scopes" "TokenScope"[],
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "api_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "changesets_project_id_status_idx" ON "changesets"("project_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "api_tokens_token_hash_key" ON "api_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "api_tokens_account_id_idx" ON "api_tokens"("account_id");

-- CreateIndex
CREATE INDEX "api_tokens_project_id_idx" ON "api_tokens"("project_id");

-- CreateIndex
CREATE INDEX "op_log_project_id_head_seq_idx" ON "op_log"("project_id", "head", "seq");

-- AddForeignKey
ALTER TABLE "op_log" ADD CONSTRAINT "op_log_author_token_id_fkey" FOREIGN KEY ("author_token_id") REFERENCES "api_tokens"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "op_log" ADD CONSTRAINT "op_log_changeset_id_fkey" FOREIGN KEY ("changeset_id") REFERENCES "changesets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "op_log" ADD CONSTRAINT "op_log_undo_of_id_fkey" FOREIGN KEY ("undo_of_id") REFERENCES "op_log"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "retired_ids" ADD CONSTRAINT "retired_ids_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "changesets" ADD CONSTRAINT "changesets_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "changesets" ADD CONSTRAINT "changesets_base_hash_fkey" FOREIGN KEY ("base_hash") REFERENCES "versions"("hash") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "changesets" ADD CONSTRAINT "changesets_created_by_account_id_fkey" FOREIGN KEY ("created_by_account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "changesets" ADD CONSTRAINT "changesets_created_by_token_id_fkey" FOREIGN KEY ("created_by_token_id") REFERENCES "api_tokens"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "changesets" ADD CONSTRAINT "changesets_closed_by_account_id_fkey" FOREIGN KEY ("closed_by_account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── Invariants Prisma does not model ──────────────────────────────────────

-- The op that created a project was written as an `apply` by the previous release; it is a `create`.
-- op_log refuses UPDATE, so its guard is lifted for exactly this one statement and put straight back.
ALTER TABLE "op_log" DISABLE TRIGGER "op_log_append_only";
UPDATE "op_log" SET "kind" = 'create' WHERE "before_hash" IS NULL;
ALTER TABLE "op_log" ENABLE TRIGGER "op_log_append_only";

-- An op is authored by exactly one kind of author. `author_kind` is compared as text because the
-- value 'token' was added to the enum by this migration and cannot be used as an enum literal
-- before it commits.
ALTER TABLE "op_log" DROP CONSTRAINT "op_log_author_matches_kind";
ALTER TABLE "op_log" ADD CONSTRAINT "op_log_author_matches_kind" CHECK (
  ("author_kind"::text = 'account' AND "author_account_id" IS NOT NULL AND "author_agent" IS NULL AND "author_token_id" IS NULL)
  OR ("author_kind"::text = 'token' AND "author_account_id" IS NOT NULL AND "author_token_id" IS NOT NULL AND "author_agent" IS NULL)
  OR ("author_kind"::text = 'agent' AND "author_agent" IS NOT NULL)
);
-- A head is `main` or a changeset's scratch head.
ALTER TABLE "op_log" ADD CONSTRAINT "op_log_head_named" CHECK (
  "head" = 'main' OR "head" ~ '^cs/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
);
-- Undo and redo name the op they invert; nothing else does.
ALTER TABLE "op_log" ADD CONSTRAINT "op_log_undo_names_target" CHECK (
  ("kind" IN ('undo', 'redo')) = ("undo_of_id" IS NOT NULL)
);
ALTER TABLE "op_log" ADD CONSTRAINT "op_log_merge_names_changeset" CHECK (
  "kind" <> 'merge' OR "changeset_id" IS NOT NULL
);
ALTER TABLE "heads" ADD CONSTRAINT "heads_name_named" CHECK (
  "name" = 'main' OR "name" ~ '^cs/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
);

-- One pending changeset per name per project: a second proposal under the same name appends to it.
CREATE UNIQUE INDEX "changesets_pending_name_key" ON "changesets"("project_id", "name") WHERE "status" = 'pending';
ALTER TABLE "changesets" ADD CONSTRAINT "changesets_name_nonempty" CHECK (length(trim("name")) > 0);
ALTER TABLE "changesets" ADD CONSTRAINT "changesets_closed_when_decided" CHECK (
  ("status" = 'pending') = ("closed_at" IS NULL)
);

-- A token has at least one scope, and is never both a person's write token and an agent's: an agent
-- token writes changesets and never main (FLR-ADR-016), so the two cannot share a secret.
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_scopes_valid" CHECK (
  cardinality("scopes") > 0 AND NOT ('write' = ANY("scopes") AND 'agent' = ANY("scopes"))
);

-- A retired ID is retired forever: the table refuses UPDATE and DELETE like the op log.
CREATE TRIGGER "retired_ids_append_only" BEFORE UPDATE OR DELETE ON "retired_ids"
  FOR EACH ROW EXECUTE FUNCTION "refuse_mutation"();
