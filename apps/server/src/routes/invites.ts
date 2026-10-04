import { z } from 'zod';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { Routes } from '../http/routes.js';
import { HttpError } from '../http/errors.js';
import { createInvite } from '../domain/invites.js';
import { accountOf, parse } from './auth.js';

const CreateBody = z.object({
  email: z.string().trim().toLowerCase().max(320).pipe(z.email()).optional(),
});

/** The operator's invites (FLR-REQ-009): create a single-use link, list them, revoke one. */
export function inviteRoutes(db: Db, config: Config): Routes {
  const routes = new Routes(db);

  routes.read(
    '/',
    async (_req, res) => {
      const invites = await db.invite.findMany({
        orderBy: { createdAt: 'desc' },
        take: 200,
        select: {
          id: true,
          email: true,
          createdAt: true,
          expiresAt: true,
          acceptedAt: true,
          revokedAt: true,
          acceptedAccount: { select: { email: true, displayName: true } },
        },
      });
      const now = Date.now();
      res.json({
        invites: invites.map((invite) => ({
          ...invite,
          state:
            invite.acceptedAt !== null
              ? 'accepted'
              : invite.revokedAt !== null
                ? 'revoked'
                : invite.expiresAt.getTime() <= now
                  ? 'expired'
                  : 'open',
        })),
      });
    },
    { access: 'operator' },
  );

  routes.mutate(
    'POST',
    '/',
    async (req, tx) => {
      const body = parse(CreateBody, req.body ?? {});
      const invite = await createInvite(tx, config, accountOf(req), body.email ?? null);
      return {
        reply: (res) => res.status(201).json(invite),
        audit: {
          action: 'invite.create',
          targetType: 'invite',
          targetId: invite.id,
          detail: { email: invite.email, expiresAt: invite.expiresAt },
        },
      };
    },
    { access: 'operator' },
  );

  routes.mutate(
    'DELETE',
    '/:inviteId',
    async (req, tx) => {
      const id = String(req.params['inviteId']);
      const { count } = await tx.invite.updateMany({
        where: { id: z.uuid().safeParse(id).success ? id : '00000000-0000-0000-0000-000000000000', acceptedAt: null, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (count === 0) throw new HttpError(404, 'no open invite with that id');
      return {
        reply: (res) => res.status(204).end(),
        audit: { action: 'invite.revoke', targetType: 'invite', targetId: id },
      };
    },
    { access: 'operator' },
  );

  return routes;
}
