import type { Tx } from '../db.js';
import { Prisma } from '../db.js';
import { contentHash } from '@floorspec/engine';
import type { Json } from '../model/document.js';
import { emptyDocument, FLOORSPEC_VERSION } from '../model/document.js';
import type { Author } from './history.js';

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
 * the first one included. The project belongs to the author's account whoever made it: a person,
 * their write token, or an agent acting for them — the log says which.
 */
export async function createProject(tx: Tx, author: Author, name: string) {
  const ownerAccountId = author.accountId;
  if (ownerAccountId === null) throw new Error('a project is created for an account');
  const project = await tx.project.create({ data: { ownerAccountId, name } });
  const hash = await storeVersion(tx, emptyDocument(name));
  await tx.head.create({ data: { projectId: project.id, name: MAIN, versionHash: hash } });
  await tx.opLog.create({
    data: {
      projectId: project.id,
      seq: 1,
      kind: 'create',
      authorKind: author.kind,
      authorAccountId: ownerAccountId,
      authorAgent: author.agent,
      authorTokenId: author.tokenId,
      ops: [{ op: 'createProject', name, floorspec: FLOORSPEC_VERSION }] as Prisma.InputJsonArray,
      beforeHash: null,
      afterHash: hash,
    },
  });
  return { project, hash };
}
