-- CreateEnum
CREATE TYPE "AccountRole" AS ENUM ('operator', 'member');

-- CreateEnum
CREATE TYPE "AuthMethod" AS ENUM ('password', 'oidc');

-- CreateEnum
CREATE TYPE "ThrottleScope" AS ENUM ('account', 'ip');

-- CreateEnum
CREATE TYPE "AuthorKind" AS ENUM ('account', 'agent');

-- CreateTable
CREATE TABLE "accounts" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "role" "AccountRole" NOT NULL DEFAULT 'member',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "disabled_at" TIMESTAMPTZ(6),

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credentials" (
    "account_id" UUID NOT NULL,
    "password_hash" TEXT NOT NULL,
    "password_updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "totp_secret" TEXT,
    "totp_confirmed_at" TIMESTAMPTZ(6),
    "totp_last_step" BIGINT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "credentials_pkey" PRIMARY KEY ("account_id")
);

-- CreateTable
CREATE TABLE "identities" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "iss" TEXT NOT NULL,
    "sub" TEXT NOT NULL,
    "email" TEXT,
    "linked_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_login_at" TIMESTAMPTZ(6),

    CONSTRAINT "identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "method" "AuthMethod" NOT NULL,
    "ip" TEXT,
    "user_agent" TEXT,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invites" (
    "id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "email" TEXT,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "accepted_at" TIMESTAMPTZ(6),
    "accepted_account_id" UUID,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "invites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_throttle" (
    "scope" "ThrottleScope" NOT NULL,
    "key" TEXT NOT NULL,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "next_allowed_at" TIMESTAMPTZ(6) NOT NULL,
    "last_failure_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_throttle_pkey" PRIMARY KEY ("scope","key")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" UUID NOT NULL,
    "owner_account_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "versions" (
    "hash" TEXT NOT NULL,
    "document" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "versions_pkey" PRIMARY KEY ("hash")
);

-- CreateTable
CREATE TABLE "op_log" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "author_kind" "AuthorKind" NOT NULL,
    "author_account_id" UUID,
    "author_agent" TEXT,
    "ops" JSONB NOT NULL,
    "before_hash" TEXT,
    "after_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "op_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "heads" (
    "project_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "version_hash" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "heads_pkey" PRIMARY KEY ("project_id","name")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL,
    "actor" TEXT NOT NULL,
    "actor_account_id" UUID,
    "action" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "detail" JSONB,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "accounts_email_key" ON "accounts"("email");

-- CreateIndex
CREATE UNIQUE INDEX "identities_iss_sub_key" ON "identities"("iss", "sub");

-- CreateIndex
CREATE UNIQUE INDEX "identities_account_id_iss_key" ON "identities"("account_id", "iss");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE INDEX "sessions_account_id_expires_at_idx" ON "sessions"("account_id", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "invites_token_hash_key" ON "invites"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "invites_accepted_account_id_key" ON "invites"("accepted_account_id");

-- CreateIndex
CREATE INDEX "invites_created_by_id_idx" ON "invites"("created_by_id");

-- CreateIndex
CREATE INDEX "projects_owner_account_id_idx" ON "projects"("owner_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "op_log_project_id_seq_key" ON "op_log"("project_id", "seq");

-- CreateIndex
CREATE INDEX "audit_log_target_type_target_id_idx" ON "audit_log"("target_type", "target_id");

-- CreateIndex
CREATE INDEX "audit_log_actor_account_id_at_idx" ON "audit_log"("actor_account_id", "at");

-- CreateIndex
CREATE INDEX "audit_log_at_idx" ON "audit_log"("at");

-- AddForeignKey
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identities" ADD CONSTRAINT "identities_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invites" ADD CONSTRAINT "invites_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invites" ADD CONSTRAINT "invites_accepted_account_id_fkey" FOREIGN KEY ("accepted_account_id") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_owner_account_id_fkey" FOREIGN KEY ("owner_account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "op_log" ADD CONSTRAINT "op_log_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "op_log" ADD CONSTRAINT "op_log_author_account_id_fkey" FOREIGN KEY ("author_account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "op_log" ADD CONSTRAINT "op_log_before_hash_fkey" FOREIGN KEY ("before_hash") REFERENCES "versions"("hash") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "op_log" ADD CONSTRAINT "op_log_after_hash_fkey" FOREIGN KEY ("after_hash") REFERENCES "versions"("hash") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "heads" ADD CONSTRAINT "heads_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "heads" ADD CONSTRAINT "heads_version_hash_fkey" FOREIGN KEY ("version_hash") REFERENCES "versions"("hash") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── Invariants Prisma does not model ──────────────────────────────────────

-- A version is keyed by the lowercase hex SHA-256 of its JCS serialization, and nothing else.
ALTER TABLE "versions" ADD CONSTRAINT "versions_hash_is_sha256" CHECK ("hash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "op_log" ADD CONSTRAINT "op_log_seq_positive" CHECK ("seq" >= 1);
-- An op is authored by exactly one kind of author.
ALTER TABLE "op_log" ADD CONSTRAINT "op_log_author_matches_kind" CHECK (
  ("author_kind" = 'account' AND "author_account_id" IS NOT NULL AND "author_agent" IS NULL)
  OR ("author_kind" = 'agent' AND "author_agent" IS NOT NULL)
);

-- Append-only and immutable tables refuse UPDATE and DELETE outright. A bug that tries either is a
-- bug that would have rewritten history, and the database is the last place to stop it.
CREATE FUNCTION "refuse_mutation"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % refused', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "versions_immutable" BEFORE UPDATE OR DELETE ON "versions"
  FOR EACH ROW EXECUTE FUNCTION "refuse_mutation"();
CREATE TRIGGER "op_log_append_only" BEFORE UPDATE OR DELETE ON "op_log"
  FOR EACH ROW EXECUTE FUNCTION "refuse_mutation"();
CREATE TRIGGER "audit_log_append_only" BEFORE UPDATE OR DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION "refuse_mutation"();
