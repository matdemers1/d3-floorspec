-- FLR-T-2.11: an API token may reach every project its account owns. A null project_id means
-- exactly that; a token naming a project still reaches that one and no other.
ALTER TABLE "api_tokens" ALTER COLUMN "project_id" DROP NOT NULL;
