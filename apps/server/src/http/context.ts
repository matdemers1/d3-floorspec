import type { AccountRole, AuthMethod } from '../generated/prisma/enums.js';
import type { Project } from '../generated/prisma/client.js';

/** Who is asking. Set by `attachAuth` from the session cookie; absent for an anonymous request. */
export interface AuthContext {
  readonly accountId: string;
  readonly email: string;
  readonly role: AccountRole;
  readonly sessionId: string;
  readonly method: AuthMethod;
}

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthContext;
    /** Set by the ownership guard on every `:projectId` route, after it has checked the owner. */
    project?: Project;
  }
}
