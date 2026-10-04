import type { Db } from '../db.js';
import { Routes } from '../http/routes.js';
import { HttpError } from '../http/errors.js';
import { accountOf } from './auth.js';

/** The signed-in account's own settings. Two-factor lives under /auth/totp; this is D3 Auth. */
export function accountRoutes(db: Db): Routes {
  const routes = new Routes(db);

  /** Unlink D3 Auth. Refused when it is the only way into the account. */
  routes.mutate('DELETE', '/d3auth', async (req, tx) => {
    const accountId = accountOf(req);
    const account = await tx.account.findUniqueOrThrow({
      where: { id: accountId },
      include: { credential: true, identities: true },
    });
    const identity = account.identities[0];
    if (identity === undefined) throw new HttpError(404, 'D3 Auth is not linked to this account');
    if (account.credential === null) {
      throw new HttpError(409, 'D3 Auth is the only way into this account; it cannot be unlinked');
    }
    await tx.identity.deleteMany({ where: { accountId } });
    return {
      reply: (res) => res.status(204).end(),
      audit: { action: 'identity.unlink', targetType: 'identity', targetId: identity.id, detail: { iss: identity.iss } },
    };
  });

  return routes;
}
