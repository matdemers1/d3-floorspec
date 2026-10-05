/** The shared viewer's stores are keyed `share:<token>` (share/Viewer.tsx), not by a project ID. */
const SHARE_KEY = 'share:';

/**
 * Where a stored file's bytes are, for the store that shows it: the project's asset route for its
 * owner, or — in the shared viewer — the link's own, which serves only files the shared version
 * names (FLR-T-9.6, FLR-T-9.1). The owner's route needs the owner's session, so a link's viewer
 * could never load a texture, a plan symbol or a model from it.
 */
export function assetUrl(store: string, sha256: string): string {
  if (store.startsWith(SHARE_KEY)) return `/api/share/${encodeURIComponent(store.slice(SHARE_KEY.length))}/assets/${sha256}`;
  return `/api/projects/${store}/assets/${sha256}`;
}

