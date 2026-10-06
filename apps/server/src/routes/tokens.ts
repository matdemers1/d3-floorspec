import { z } from 'zod';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { Routes } from '../http/routes.js';
import { canonicalMcpUri } from '../auth/resource-server.js';
import { HttpError } from '../http/errors.js';
import { createToken, kindOf, TOKEN_KINDS, type TokenKind } from '../domain/tokens.js';
import { accountOf, parse } from './auth.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CreateBody = z.strictObject({
  /** Absent or null: every project the account owns, now and later (FLR-T-2.11). */
  projectId: z.string().regex(UUID, 'pick a project').nullable().optional(),
  name: z.string().trim().min(1, 'a token needs a name').max(80),
  kind: z.enum(Object.keys(TOKEN_KINDS) as [TokenKind, ...TokenKind[]]),
  /** Absent: the token lasts until it is revoked. */
  expiresInDays: z.number().int().min(1).max(365).optional(),
});

/**
 * API tokens for the MCP server and the REST API (FLR-T-2.5), managed from the account screen. A
 * person's session only: a token never mints, lists or revokes tokens.
 *
 * The list carries what the Connect Claude section needs (FLR-T-2.11): the MCP endpoint, and the
 * D3 Auth client Claude's connector signs in as — the value its "OAuth Client ID" field wants.
 */
export function tokenRoutes(db: Db, config: Config): Routes {
  const routes = new Routes(db);
  const connector =
    config.D3AUTH_ISSUER === undefined ? null : { issuer: config.D3AUTH_ISSUER, clientId: config.D3AUTH_MCP_CLIENT_ID ?? 'floorspec-mcp' };

  routes.read('/', async (req, res) => {
    const tokens = await db.apiToken.findMany({
      where: { accountId: accountOf(req), OR: [{ projectId: null }, { project: { deletedAt: null } }] },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { project: { select: { id: true, name: true } } },
    });
    const now = Date.now();
    res.json({
      mcp: { url: canonicalMcpUri(config), connector },
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
    const project =
      body.projectId === undefined || body.projectId === null
        ? null
        : await tx.project.findFirst({ where: { id: body.projectId, ownerAccountId: accountId, deletedAt: null }, select: { id: true, name: true } });
    if (project === null && typeof body.projectId === 'string') throw new HttpError(404, 'project not found');
    const expiresAt = body.expiresInDays === undefined ? null : new Date(Date.now() + body.expiresInDays * 86_400_000);
    const token = await createToken(tx, { accountId, projectId: project?.id ?? null, name: body.name, kind: body.kind, expiresAt });
    return {
      reply: (res) =>
        res.status(201).json({
          id: token.id,
          name: body.name,
          kind: body.kind,
          scopes: TOKEN_KINDS[body.kind],
          prefix: token.prefix,
          project,
          expiresAt,
          token: token.secret,
        }),
      audit: {
        action: 'token.create',
        targetType: 'api_token',
        targetId: token.id,
        detail: { project: project?.id ?? null, name: body.name, kind: body.kind, prefix: token.prefix, expiresAt },
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
