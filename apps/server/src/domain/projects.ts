import type { Tx } from '../db.js';
import { Prisma } from '../db.js';
import { contentHash, type Json } from '../model/canonical.js';
import { emptyDocument } from '../model/document.js';

/** The head every project has from birth. Changesets add others in later phases. */
export const MAIN = 'main';

/**
 * Store a document as a version, keyed by its content hash. Versions are immutable and shared: a
 * document that already exists — the same empty house, named the same — is the same row.
 */
export async function storeVersion(tx: Tx, document: Json): Promise<string> {
  const hash = contentHash(document);
  await tx.$executeRaw`
    insert into versions (hash, document) values (${hash}, ${JSON.stringify(document)}::jsonb)
    on conflict (hash) do nothing
  `;
  return hash;
}

/**
 * Create a project at version 0: the empty Floorspec document, stored canonically, `main` pointing
 * at it, and op 1 in the log — a `createProject` op, because every change is an op (FLR-ADR-008),
 * the first one included.
 */
export async function createProject(tx: Tx, ownerAccountId: string, name: string) {
  const project = await tx.project.create({ data: { ownerAccountId, name } });
  const hash = await storeVersion(tx, emptyDocument(name));
  await tx.head.create({ data: { projectId: project.id, name: MAIN, versionHash: hash } });
  await tx.opLog.create({
    data: {
      projectId: project.id,
      seq: 1,
      authorKind: 'account',
      authorAccountId: ownerAccountId,
      ops: [{ op: 'createProject', name, floorspec: '0.1' }] as Prisma.InputJsonArray,
      beforeHash: null,
      afterHash: hash,
    },
  });
  return { project, hash };
}
