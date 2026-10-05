import { projectWithDocument } from './drawings-support.js';
import type { Browser, Running } from './helpers.js';

/** A share link the owner made through the real route; returns its row's ID, its token and URL. */
export async function shareOf(owner: Browser, projectId: string, body: Record<string, unknown> = {}): Promise<{ id: string; token: string; url: string }> {
  const res = await owner.post(`/api/projects/${projectId}/shares`, body);
  if (res.status !== 201) throw new Error(`share failed: ${String(res.status)} ${res.text}`);
  const { link, token, url } = res.body as { link: { id: string }; token: string; url: string };
  return { id: link.id, token, url };
}

/**
 * The two-storey house, shared, with one comment on wall W1 of its main level made by `author`
 * (the owner by default) through the link.
 */
export async function commentOn(running: Running, owner: Browser, author: Browser = owner): Promise<{ project: string; share: { id: string; token: string }; comment: string }> {
  const { id: project } = await projectWithDocument(running.db, owner);
  const share = await shareOf(owner, project);
  const res = await author.post(`/api/share/${share.token}/comments`, { body: 'A 6" wall here?', element: 'W1', level: 'MAIN', point: [100, 200] });
  if (res.status !== 201) throw new Error(`comment failed: ${String(res.status)} ${res.text}`);
  return { project, share, comment: (res.body as { comment: { id: string } }).comment.id };
}
