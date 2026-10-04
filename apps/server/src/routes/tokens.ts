import { z } from 'zod';
import type { Db } from '../db.js';
import { Routes } from '../http/routes.js';
import { HttpError } from '../http/errors.js';
import { createToken, kindOf, TOKEN_KINDS, type TokenKind } from '../domain/tokens.js';
import { accountOf, parse } from './auth.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CreateBody = z.strictObject({
  projectId: z.string().regex(UUID, 'pick a project'),
  name: z.string().trim().min(1, 'a token needs a name').max(80),
  kind: z.enum(Object.keys(TOKEN_KINDS) as [TokenKind, ...TokenKind[]]),
  /** Absent: the token lasts until it is revoked. */
  expiresInDays: z.number().int().min(1).max(365).optional(),
});

/**
 * API tokens for the MCP server and the REST API (FLR-T-2.5), managed from the account screen. A
 * person's session only: a token never mints, lists or revokes tokens.
 */
export function tokenRoutes(db: Db): Routes {
  const routes = new Routes(db);

  routes.read('/', async (req, res) => {
    const tokens = await db.apiToken.findMany({
      where: { accountId: accountOf(req), project: { deletedAt: null } },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { project: { select: { id: true, name: true } } },
    });
    const now = Date.now();
    res.json({
      tokens: tokens.map((t) => ({
        id: t.id,
        name: t.name,
        prefix: t.prefix,
        kind: kindOf(t.scopes),
        scopes: t.scopes,
        project: t.project,
        createdAt: t.createdAt,
        lastUsedAt: t.lastUsedAt,
        expiresAt: t.expiresAt,
        revokedAt: t.revokedAt,
        state: t.revokedAt !== null ? 'revoked' : t.expiresAt !== null && t.expiresAt.getTime() <= now ? 'expired' : 'active',
      })),
    });
  });

  /** Create a token. The secret is in this response and nowhere else, ever. */
  routes.mutate('POST', '/', async (req, tx) => {
    const accountId = accountOf(req);
    const body = parse(CreateBody, req.body);
    // Somebody else's project and no project are the same answer here as everywhere (FLR-T-0.6).
    const project = await tx.project.findFirst({ where: { id: body.projectId, ownerAccountId: accountId, deletedAt: null } });
    if (project === null) throw new HttpError(404, 'project not found');
    const expiresAt = body.expiresInDays === undefined ? null : new Date(Date.now() + body.expiresInDays * 86_400_000);
    const token = await createToken(tx, { accountId, projectId: project.id, name: body.name, kind: body.kind, expiresAt });
    return {
      reply: (res) =>
        res.status(201).json({
          id: token.id,
          name: body.name,
          kind: body.kind,
          scopes: TOKEN_KINDS[body.kind],
          prefix: token.prefix,
          project: { id: project.id, name: project.name },
          expiresAt,
          token: token.secret,
        }),
      audit: {
        action: 'token.create',
        targetType: 'api_token',
        targetId: token.id,
        detail: { project: project.id, name: body.name, kind: body.kind, prefix: token.prefix, expiresAt },
      },
    };
  });

  routes.mutate('DELETE', '/:tokenId', async (req, tx) => {
    const accountId = accountOf(req);
    const id = String(req.params['tokenId']);
    if (!UUID.test(id)) throw new HttpError(404, 'token not found');
    const token = await tx.apiToken.findFirst({ where: { id, accountId } });
    if (token === null) throw new HttpError(404, 'token not found');
    if (token.revokedAt === null) await tx.apiToken.update({ where: { id }, data: { revokedAt: new Date() } });
    return {
      reply: (res) => res.status(204).end(),
      audit: { action: 'token.revoke', targetType: 'api_token', targetId: id, detail: { name: token.name, prefix: token.prefix } },
    };
  });

  return routes;
}
