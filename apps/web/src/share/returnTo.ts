/**
 * "Sign in to comment" (FLR-T-9.6): a viewer of a share link signs in — with a password or with
 * D3 Auth, whose round trip leaves this tab — and comes back to the link. The way back is kept in
 * this tab's sessionStorage for a few minutes, and it can only ever be a share link's path, so it
 * cannot be turned into a redirect anywhere else.
 */

const KEY = 'floorspec.returnTo';
const TTL_MS = 30 * 60_000;
export const SHARE_PATH = /^\/s\/([A-Za-z0-9_-]{43})$/;
/** A virtual tour's link (FLR-T-14.2): `/s/<token>/tour`. */
export const TOUR_PATH = /^\/s\/([A-Za-z0-9_-]{43})\/tour$/;
/** An AR model's link (FLR-T-14.3): `/s/<token>/ar`. */
export const AR_PATH = /^\/s\/([A-Za-z0-9_-]{43})\/ar$/;

export function rememberReturn(path: string): void {
  if (!SHARE_PATH.test(path)) return;
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ path, at: Date.now() }));
  } catch {
    // Storage refused (a private window): the person comes back to the projects screen instead.
  }
}

/** The share link to go back to after signing in, once; null when there is none or it is stale. */
export function takeReturn(now = Date.now()): string | null {
  let raw: string | null;
  try {
    raw = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    const { path, at } = JSON.parse(raw) as { path?: unknown; at?: unknown };
    if (typeof path !== 'string' || typeof at !== 'number' || now - at > TTL_MS || !SHARE_PATH.test(path)) return null;
    return path;
  } catch {
    return null;
  }
}
