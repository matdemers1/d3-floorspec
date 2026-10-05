import { createHash } from 'node:crypto';
import { get } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registry } from '../../src/http/routes.js';
import { shareLimits } from '../../src/share/limit.js';
import { projectWithDocument } from './drawings-support.js';
import { Browser, inviteMember, isStream, OPERATOR, reset, setupOperator, start, testDb, tokenFor, type EventStream, type Running } from './helpers.js';
import { shareOf } from './share-support.js';

/**
 * Share links, the shared viewer's reads and comments (FLR-T-9.6; FLR-REQ-133, 134, 167).
 *
 * The share routes are the first public reads beyond first-run setup, so this suite holds them to
 * the isolation suite's standard: every `/api/share` route the app declares must be in `CALLS`, and
 * each is called with no account at all, with a dead link, and with a link that does not show what
 * the route serves.
 */

/** Every route under /api/share, and what an anonymous visitor with a live, fully shared link gets. */
const CALLS: Record<string, { body?: unknown; anonymous: number; stream?: true }> = {
  'GET /api/share/:token': { anonymous: 200 },
  'GET /api/share/:token/model.json': { anonymous: 200 },
  // Answered, by a route that works: the shared house has no texture, so no digest is the link's to read (FLR-T-9.1).
  'GET /api/share/:token/assets/:sha256': { anonymous: 404 },
  'GET /api/share/:token/findings': { anonymous: 200 },
  'GET /api/share/:token/coverage': { anonymous: 200 },
  'GET /api/share/:token/comments': { anonymous: 200 },
  'GET /api/share/:token/events': { anonymous: 200, stream: true },
  // Writing needs an account.
  'POST /api/share/:token/comments': { body: { body: 'Hi', element: 'W1', level: 'MAIN' }, anonymous: 401 },
  'POST /api/share/:token/comments/:commentId/replies': { body: { body: 'Hi' }, anonymous: 401 },
  'PATCH /api/share/:token/comments/:commentId': { body: { body: 'Hi' }, anonymous: 401 },
  'DELETE /api/share/:token/comments/:commentId': { anonymous: 401 },
};

const MISSING_COMMENT = '01a10000-0000-7000-8000-000000000000';

describe('share links', () => {
  const db = testDb();
  let running: Running;
  let alice: Browser;
  let bob: Browser;
  let anon: Browser;
  let project: string;
  let head: string;

  const fill = (path: string, token: string, comment = MISSING_COMMENT) => path.replace(':token', token).replace(':commentId', comment).replace(':sha256', 'a'.repeat(64));

  beforeAll(async () => {
    running = await start({ with: { eventStream: { heartbeatMs: 200 } } });
  });
  afterAll(async () => {
    await running.close();
  });
  beforeEach(async () => {
    await reset(db);
    alice = await setupOperator(running);
    bob = await inviteMember(running, alice, 'bob@example.test');
    anon = new Browser(running.url);
    ({ id: project, hash: head } = await projectWithDocument(db, alice));
  });

  it('declares no /api/share route this suite does not cover', () => {
    const declared = registry(running.app)
      .filter((r) => r.path.startsWith('/api/share'))
      .map((r) => `${r.method} ${r.path}`)
      .sort();
    expect(Object.keys(CALLS).sort()).toEqual(declared);
    // None is project-scoped by path, and none accepts a bearer token: the link is the only key.
    for (const r of registry(running.app).filter((x) => x.path.startsWith('/api/share'))) {
      expect(r.projectScoped).toBe(false);
      expect(r.token).toBeNull();
    }
  });

  describe('making and revoking', () => {
    it('shows the URL once and stores only its hash', async () => {
      const res = await alice.post(`/api/projects/${project}/shares`, { label: 'Architect review' });
      expect(res.status).toBe(201);
      const { url, token, link } = res.body as { url: string; token: string; link: { id: string; prefix: string; state: string; expiresAt: string; shows: unknown; comments: boolean } };
      expect(url).toBe(`${running.config.PUBLIC_URL}/s/${token}`);
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(link).toMatchObject({ prefix: token.slice(0, 6), state: 'active', shows: { plan: true, threeD: true, findings: true }, comments: true });
      // Thirty days by default.
      expect(Math.round((Date.parse(link.expiresAt) - Date.now()) / 86_400_000)).toBe(30);
      const row = await db.shareLink.findUniqueOrThrow({ where: { id: link.id } });
      expect(row.tokenHash).toBe(createHash('sha256').update(token).digest('hex'));
      expect(JSON.stringify(row)).not.toContain(token);
      // Neither the list nor the audit trail ever carries it.
      const listed = await alice.get(`/api/projects/${project}/shares`);
      expect(listed.text).not.toContain(token);
      const audit = await db.auditLog.findMany({ where: { action: 'share.create' } });
      expect(audit).toHaveLength(1);
      expect(JSON.stringify(audit)).not.toContain(token);
      expect(audit[0]?.actor).toMatch(/^account:/);
    });

    it('refuses a link that shows nothing, comments with nowhere to pin them, and a link past a year', async () => {
      const bad = [
        { shows: { plan: false, threeD: false, findings: false } },
        { shows: { plan: false, threeD: false, findings: true }, comments: true },
        { expiresInDays: 366 },
        { expiresInDays: 0 },
        { label: ' ' },
        { anything: 'else' },
      ];
      for (const body of bad) expect((await alice.post(`/api/projects/${project}/shares`, body)).status, JSON.stringify(body)).toBe(400);
    });

    it('lists links with their views and comments, and a revoke stops a link at once', async () => {
      const share = await shareOf(alice, project, { label: 'Family' });
      await anon.get(`/api/share/${share.token}`);
      await anon.get(`/api/share/${share.token}`);
      await alice.post(`/api/share/${share.token}/comments`, { body: 'Hello', element: 'W1', level: 'MAIN' });
      await waitFor(async () => ((await db.shareLink.findUniqueOrThrow({ where: { id: share.id } })).viewCount === 2));
      const listed = (await alice.get(`/api/projects/${project}/shares`)).body as { links: { id: string; views: number; commentCount: number; state: string; label: string }[] };
      expect(listed.links).toEqual([expect.objectContaining({ id: share.id, label: 'Family', views: 2, commentCount: 1, state: 'active' })]);

      expect((await alice.request('DELETE', `/api/projects/${project}/shares/${share.id}`)).status).toBe(204);
      for (const [route, call] of Object.entries(CALLS)) {
        const [method = 'GET', path = ''] = route.split(' ');
        const res = await alice.request(method, fill(path, share.token), call.body);
        expect(res.status, route).toBe(410);
        expect(res.body, route).toEqual({ error: 'this link was revoked', reason: 'revoked' });
      }
      const after = (await alice.get(`/api/projects/${project}/shares`)).body as { links: { state: string }[] };
      expect(after.links[0]?.state).toBe('revoked');
      expect(await db.auditLog.count({ where: { action: 'share.revoke', targetId: share.id } })).toBe(1);
    });

    it('answers an expired link with 410 on every route, and says why', async () => {
      const share = await shareOf(alice, project);
      await db.$executeRaw`update share_links set created_at = now() - interval '40 days', expires_at = now() - interval '1 second' where id = ${share.id}::uuid`;
      for (const [route, call] of Object.entries(CALLS)) {
        const [method = 'GET', path = ''] = route.split(' ');
        const res = await alice.request(method, fill(path, share.token), call.body);
        expect(res.status, route).toBe(410);
        expect(res.body, route).toEqual({ error: 'this link has expired', reason: 'expired' });
      }
    });

    it('answers 404 for a token that names nothing, a deleted project and a disabled owner', async () => {
      const share = await shareOf(alice, project);
      const unknown = 'A'.repeat(43);
      for (const token of [unknown, 'short', `${share.token}x`, '..%2F..%2Fprojects']) {
        expect((await anon.get(`/api/share/${token}`)).status, token).toBe(404);
      }
      await db.account.updateMany({ where: { email: OPERATOR.email }, data: { disabledAt: new Date() } });
      expect((await anon.get(`/api/share/${share.token}`)).status).toBe(404);
      await db.account.updateMany({ where: { email: OPERATOR.email }, data: { disabledAt: null } });
      expect((await anon.get(`/api/share/${share.token}`)).status).toBe(200);
      await db.project.update({ where: { id: project }, data: { deletedAt: new Date() } });
      expect((await anon.get(`/api/share/${share.token}`)).status).toBe(404);
    });
  });

  describe('what a viewer without an account sees', () => {
    it('reads the 2D/3D model, findings, coverage and comments, and nothing that identifies anybody', async () => {
      const share = await shareOf(alice, project);
      for (const [route, call] of Object.entries(CALLS)) {
        const [method = 'GET', path = ''] = route.split(' ');
        if (call.stream === true) {
          const opened = await anon.events(fill(path, share.token));
          expect(isStream(opened), route).toBe(true);
          if (isStream(opened)) {
            await opened.next('ready');
            opened.close();
          }
          continue;
        }
        const res = await anon.request(method, fill(path, share.token), call.body);
        expect(res.status, `${route}: ${res.text}`).toBe(call.anonymous);
        if (call.anonymous !== 200) continue;
        expect(res.headers.get('x-robots-tag'), route).toContain('noindex');
        expect(res.headers.get('referrer-policy'), route).toBe('no-referrer');
      }

      const meta = await anon.get(`/api/share/${share.token}`);
      expect(meta.body).toEqual({
        project: { name: 'Two-storey ranch' },
        sharedBy: OPERATOR.displayName,
        version: { hash: head, seq: 1, pinned: false },
        shows: { plan: true, threeD: true, findings: true },
        comments: { allowed: true, signedIn: false, you: null, owner: false },
        expiresAt: expect.any(String) as unknown,
      });
      expect(meta.headers.get('cache-control')).toBe('private, no-store');
      const owner = await db.account.findFirstOrThrow({ where: { email: OPERATOR.email } });
      for (const leak of [OPERATOR.email, owner.id, project, share.id]) expect(meta.text).not.toContain(leak);

      const model = await anon.get(`/api/share/${share.token}/model.json`);
      expect(model.headers.get('etag')).toBe(`"${head}"`);
      expect(model.headers.get('cache-control')).toBe('private, no-cache');
      expect(createHash('sha256').update(model.text.replace(/\n$/, '')).digest('hex')).toHaveLength(64);
      // A browser revalidating its copy (fetch() would add `Cache-Control: no-cache`, which a cache never sends).
      expect(await statusOf(`${running.url}/api/share/${share.token}/model.json`, { 'if-none-match': `"${head}"` })).toBe(304);

      const findings = (await anon.get(`/api/share/${share.token}/findings`)).body as { hash: string; notice: string; findings: unknown[]; profileId: unknown; coverageUrl: string };
      expect(findings.hash).toBe(head);
      expect(findings.notice).toMatch(/not a plan review/);
      expect(findings.profileId).toBeNull();
      expect(findings.coverageUrl).toBe('coverage');
    });

    it('serves only what the link shows', async () => {
      const findingsOnly = await shareOf(alice, project, { shows: { plan: false, threeD: false, findings: true }, comments: false });
      expect((await anon.get(`/api/share/${findingsOnly.token}/model.json`)).status).toBe(404);
      expect((await anon.get(`/api/share/${findingsOnly.token}/comments`)).status).toBe(404);
      expect((await anon.get(`/api/share/${findingsOnly.token}/findings`)).status).toBe(200);

      const planOnly = await shareOf(alice, project, { shows: { plan: true, threeD: false, findings: false }, comments: false });
      expect((await anon.get(`/api/share/${planOnly.token}/model.json`)).status).toBe(200);
      expect((await anon.get(`/api/share/${planOnly.token}/findings`)).status).toBe(404);
      expect((await anon.get(`/api/share/${planOnly.token}/coverage`)).status).toBe(404);
      expect((await anon.get(`/api/share/${planOnly.token}/comments`)).status).toBe(404);
      expect((await bob.post(`/api/share/${planOnly.token}/comments`, { body: 'Hi', element: 'W1', level: 'MAIN' })).status).toBe(403);
    });

    it('keeps a pinned link on its version while main moves, and a latest link on main', async () => {
      const pinned = await shareOf(alice, project, { version: 'current' });
      const latest = await shareOf(alice, project, { version: 'latest' });
      const moved = await alice.post(`/api/projects/${project}/ops`, { batch: [{ op: 'addElement', collection: 'buildings', id: 'B9', element: {} }] });
      expect(moved.status, moved.text).toBe(201);
      const now = (moved.body as { hash: string }).hash;
      expect((await anon.get(`/api/share/${pinned.token}/model.json`)).headers.get('etag')).toBe(`"${head}"`);
      expect((await anon.get(`/api/share/${latest.token}/model.json`)).headers.get('etag')).toBe(`"${now}"`);
      expect(((await anon.get(`/api/share/${pinned.token}`)).body as { version: unknown }).version).toEqual({ hash: head, seq: 1, pinned: true });
      expect(((await anon.get(`/api/share/${latest.token}`)).body as { version: unknown }).version).toEqual({ hash: now, seq: 2, pinned: false });
    });
  });

  describe('isolation', () => {
    it('is never a credential: not as a bearer token, and not for any other route', async () => {
      const share = await shareOf(alice, project);
      const bearer = Browser.bearer(running.url, share.token);
      expect((await bearer.get(`/api/projects/${project}`)).status).toBe(401);
      expect((await bearer.get('/api/projects')).status).toBe(401);
      expect((await bearer.get(`/api/projects/${project}/comments`)).status).toBe(401);
      expect((await bearer.post(`/api/share/${share.token}/comments`, { body: 'Hi', element: 'W1', level: 'MAIN' })).status).toBe(401);
      // A share route with the token as a bearer as well is still only the link's read.
      expect((await bearer.get(`/api/share/${share.token}`)).status).toBe(200);
    });

    it("never shows one link's comments through another, or another project's", async () => {
      const architect = await shareOf(alice, project, { label: 'Architect' });
      const family = await shareOf(alice, project, { label: 'Family' });
      const { id: bobsProject } = await projectWithDocument(db, bob, undefined, "Bob's house");
      const bobs = await shareOf(bob, bobsProject);
      const made = await bob.post(`/api/share/${architect.token}/comments`, { body: 'Through the architect link', element: 'W1', level: 'MAIN' });
      expect(made.status).toBe(201);
      const comment = (made.body as { comment: { id: string } }).comment.id;

      const threads = async (token: string) => ((await anon.get(`/api/share/${token}/comments`)).body as { threads: { id: string }[] }).threads.map((t) => t.id);
      expect(await threads(architect.token)).toEqual([comment]);
      expect(await threads(family.token)).toEqual([]);
      expect(await threads(bobs.token)).toEqual([]);

      // Reaching the comment through another link, or another project's, is the same 404 as no comment.
      for (const token of [family.token, bobs.token]) {
        expect((await bob.post(`/api/share/${token}/comments/${comment}/replies`, { body: 'Hi' })).status).toBe(404);
        expect((await bob.request('PATCH', `/api/share/${token}/comments/${comment}`, { body: 'Hi' })).status).toBe(404);
        expect((await bob.request('DELETE', `/api/share/${token}/comments/${comment}`)).status).toBe(404);
      }
      // Bob owns his project, not Alice's: her comments list is not his to read or resolve.
      expect((await bob.get(`/api/projects/${project}/comments`)).status).toBe(404);
      expect((await bob.post(`/api/projects/${project}/comments/${comment}/resolve`)).status).toBe(404);
      // And a comment on Alice's project is not reachable through Bob's project routes either.
      expect((await bob.post(`/api/projects/${bobsProject}/comments/${comment}/resolve`)).status).toBe(404);
    });
  });

  describe('comments', () => {
    it('need a person signed in: not an anonymous viewer, not an API token', async () => {
      const share = await shareOf(alice, project);
      const body = { body: 'Hi', element: 'W1', level: 'MAIN' };
      expect((await anon.post(`/api/share/${share.token}/comments`, body)).status).toBe(401);
      const token = Browser.bearer(running.url, await tokenFor(alice, project, 'write'));
      expect((await token.post(`/api/share/${share.token}/comments`, body)).status).toBe(403);
      const res = await bob.post(`/api/share/${share.token}/comments`, { ...body, point: [1200, -3400] });
      expect(res.status, res.text).toBe(201);
      expect((res.body as { comment: unknown }).comment).toMatchObject({
        author: { name: 'bob@example.test', you: true, owner: false },
        body: 'Hi',
        pin: { element: 'W1', level: 'MAIN', version: head, point: [1200, -3400] },
        resolved: null,
      });
      // A signed-in viewer is told so, and who they are.
      expect(((await bob.get(`/api/share/${share.token}`)).body as { comments: unknown }).comments).toEqual({ allowed: true, signedIn: true, you: { name: 'bob@example.test' }, owner: false });
      const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'comment.create' } });
      expect(audit.actor).toMatch(/^account:/);
      expect(audit.detail).toMatchObject({ element: 'W1', level: 'MAIN', version: head, route: 'POST /api/share/:token/comments' });
    });

    it('pin to an element of the version the link shows, and nothing else', async () => {
      const share = await shareOf(alice, project);
      const post = (body: unknown) => bob.post(`/api/share/${share.token}/comments`, body);
      expect((await post({ body: 'Hi', element: 'NOPE', level: 'MAIN' })).status).toBe(409);
      expect((await post({ body: 'Hi', element: 'W1', level: 'NOPE' })).status).toBe(409);
      // A level is not an element; a type is not a place on the plan.
      expect((await post({ body: 'Hi', element: 'MAIN', level: 'MAIN' })).status).toBe(409);
      expect((await post({ body: 'Hi', element: 'EXT26', level: 'MAIN' })).status).toBe(409);
      expect((await post({ body: 'Hi', level: 'MAIN' })).status).toBe(400);
      expect((await post({ body: 'Hi', element: 'W1', level: 'MAIN', point: [0.5, 1] })).status).toBe(400);
      expect((await post({ body: '   ', element: 'W1', level: 'MAIN' })).status).toBe(400);
      expect((await post({ body: 'x'.repeat(4001), element: 'W1', level: 'MAIN' })).status).toBe(400);
      expect((await post({ body: 'Room', element: 'LIV', level: 'MAIN' })).status).toBe(201);
    });

    it('keep text as text: unsafe characters are dropped, markup is stored as typed', async () => {
      const share = await shareOf(alice, project);
      const typed = 'Look\u202E at <img src=x onerror=alert(1)> **this**\u0000\r\n\r\n\r\n\r\nnext\u200B line';
      const res = await bob.post(`/api/share/${share.token}/comments`, { body: typed, element: 'W1', level: 'MAIN' });
      expect(res.status).toBe(201);
      expect((res.body as { comment: { body: string } }).comment.body).toBe('Look at <img src=x onerror=alert(1)> **this**\n\nnext line');
    });

    it('edit and delete only their own; the owner resolves, reopens and moderates', async () => {
      const share = await shareOf(alice, project);
      const carol = await inviteMember(running, alice, 'carol@example.test');
      const root = ((await bob.post(`/api/share/${share.token}/comments`, { body: 'Mine', element: 'W1', level: 'MAIN' })).body as { comment: { id: string } }).comment.id;
      expect((await carol.request('PATCH', `/api/share/${share.token}/comments/${root}`, { body: 'Not mine' })).status).toBe(404);
      expect((await carol.request('DELETE', `/api/share/${share.token}/comments/${root}`)).status).toBe(404);
      const reply = await carol.post(`/api/share/${share.token}/comments/${root}/replies`, { body: 'A reply' });
      expect(reply.status).toBe(201);
      expect((await bob.request('PATCH', `/api/share/${share.token}/comments/${root}`, { body: 'Mine, edited' })).status).toBe(200);
      // Resolving is the owner's, from the owner's routes: a commenter has no route for it at all.
      expect((await bob.post(`/api/projects/${project}/comments/${root}/resolve`)).status).toBe(404);
      expect((await alice.post(`/api/projects/${project}/comments/${root}/resolve`)).status).toBe(200);
      type Threads = { threads: { id: string; body: string; editedAt: string | null; resolved: unknown; replies: { body: string }[] }[] };
      let threads = ((await anon.get(`/api/share/${share.token}/comments`)).body as Threads).threads;
      expect(threads).toEqual([expect.objectContaining({ id: root, body: 'Mine, edited', resolved: { at: expect.any(String) as unknown, by: OPERATOR.displayName }, replies: [expect.objectContaining({ body: 'A reply' })] })]);
      expect(threads[0]?.editedAt).not.toBeNull();
      expect((await alice.post(`/api/projects/${project}/comments/${root}/reopen`)).status).toBe(200);
      // Every thread, every link, for the owner — the link it came through named.
      const all = (await alice.get(`/api/projects/${project}/comments`)).body as { threads: { link: { id: string } }[] };
      expect(all.threads).toEqual([expect.objectContaining({ link: { id: share.id, label: null, prefix: share.token.slice(0, 6) } })]);

      // A reply cannot be resolved: only a thread is.
      const replyId = (reply.body as { comment: { id: string } }).comment.id;
      expect((await alice.post(`/api/projects/${project}/comments/${replyId}/resolve`)).status).toBe(404);
      // Deleting the root keeps the thread, blank, while it has a reply.
      expect((await bob.request('DELETE', `/api/share/${share.token}/comments/${root}`)).status).toBe(204);
      threads = ((await anon.get(`/api/share/${share.token}/comments`)).body as Threads).threads;
      expect(threads).toEqual([expect.objectContaining({ id: root, body: '', deleted: true })]);
      const stored = await db.comment.findUniqueOrThrow({ where: { id: root } });
      expect(stored.body).toBe('');
      // The owner removes the reply; the empty thread is gone.
      expect((await alice.request('DELETE', `/api/projects/${project}/comments/${replyId}`)).status).toBe(204);
      expect(((await anon.get(`/api/share/${share.token}/comments`)).body as { threads: unknown[] }).threads).toEqual([]);
    });

    it('refuse a write from another site', async () => {
      const share = await shareOf(alice, project);
      const body = { body: 'Hi', element: 'W1', level: 'MAIN' };
      expect((await bob.post(`/api/share/${share.token}/comments`, body, { origin: 'https://evil.example' })).status).toBe(403);
      expect((await bob.post(`/api/share/${share.token}/comments`, body, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
      expect((await bob.post(`/api/share/${share.token}/comments`, body, { origin: running.config.PUBLIC_URL, 'sec-fetch-site': 'same-origin' })).status).toBe(201);
      expect((await alice.post(`/api/projects/${project}/shares`, {}, { origin: 'https://evil.example' })).status).toBe(403);
      // A form post: not JSON, so never read as a comment.
      const form = await fetch(`${running.url}/api/share/${share.token}/comments`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain', cookie: [...bob.cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
        body: JSON.stringify(body),
      });
      expect(form.status).toBe(415);
    });
  });

  describe('live', () => {
    it("tells a link's viewers about its own comments, the model moving and the revoke — and no one else's", async () => {
      const architect = await shareOf(alice, project);
      const family = await shareOf(alice, project);
      const viewing = (await anon.events(`/api/share/${architect.token}/events`)) as EventStream;
      const other = (await anon.events(`/api/share/${family.token}/events`)) as EventStream;
      const owner = (await alice.events(`/api/projects/${project}/comments/events`)) as EventStream;
      await viewing.next('ready');
      await other.next('ready');
      await owner.next('ready');

      const made = await bob.post(`/api/share/${architect.token}/comments`, { body: 'Hello', element: 'W1', level: 'MAIN' });
      const id = (made.body as { comment: { id: string } }).comment.id;
      expect((await viewing.next('comment')).data).toEqual({ id, thread: id, change: 'created' });
      expect((await owner.next('comment')).data).toEqual({ id, thread: id, link: architect.id, change: 'created' });

      await alice.post(`/api/projects/${project}/ops`, { batch: [{ op: 'addElement', collection: 'buildings', id: 'B9', element: {} }] });
      const model = await viewing.next('model');
      expect(Object.keys(model.data as object)).toEqual(['hash']);

      await alice.request('DELETE', `/api/projects/${project}/shares/${architect.id}`);
      await viewing.next('revoked');
      await viewing.closed();
      // The other link heard of the model moving, but of neither the comment nor the revoke.
      await other.next('model');
      expect(other.events.map((e) => e.event)).not.toContain('comment');
      expect(other.events.map((e) => e.event)).not.toContain('revoked');
      other.close();
      owner.close();
    });
  });

  describe('rate limits', () => {
    it('stops a client guessing at tokens', async () => {
      const limited = await start({ with: { shareLimits: shareLimits({ misses: { limit: 3, windowMs: 60_000 } }) } });
      try {
        const visitor = new Browser(limited.url);
        for (let i = 0; i < 3; i++) expect((await visitor.get(`/api/share/${'B'.repeat(43)}`)).status).toBe(404);
        const refused = await visitor.get(`/api/share/${'B'.repeat(43)}`);
        expect(refused.status).toBe(429);
        expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
      } finally {
        await limited.close();
      }
    });

    it("limits a person's comments", async () => {
      const limited = await start({ with: { shareLimits: shareLimits({ writes: { limit: 2, windowMs: 60_000 } }) } });
      try {
        const operator = new Browser(limited.url);
        await operator.post('/auth/login', OPERATOR);
        const share = await shareOf(operator, project);
        const body = { body: 'Hi', element: 'W1', level: 'MAIN' };
        expect((await operator.post(`/api/share/${share.token}/comments`, body)).status).toBe(201);
        expect((await operator.post(`/api/share/${share.token}/comments`, body)).status).toBe(201);
        expect((await operator.post(`/api/share/${share.token}/comments`, body)).status).toBe(429);
      } finally {
        await limited.close();
      }
    });
  });

  it('serves the viewer page without indexing or a Referer', async () => {
    const share = await shareOf(alice, project);
    const res = await fetch(`${running.url}/s/${share.token}`);
    expect(res.headers.get('x-robots-tag')).toContain('noindex');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });
});

/** A GET's status through node:http, with exactly the headers given. */
function statusOf(url: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    get(url, { headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    }).on('error', reject);
  });
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
