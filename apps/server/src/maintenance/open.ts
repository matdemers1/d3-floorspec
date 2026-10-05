import type { AddressInfo } from 'node:net';
import { contentHash, validate } from '@floorspec/engine';
import { createApp, eventHubOf } from '../app.js';
import { cookieName, issue } from '../auth/sessions.js';
import { isSecureOrigin, type Config } from '../config.js';
import { createDb } from '../db.js';
import { MAIN } from '../domain/projects.js';
import { opsApplier } from '../ops/applier.js';
import type { InstalledPacks } from '../rules/packs.js';
import type { AppOpener, OpenedApp } from './drill.js';

/**
 * "Boots the app and opens a project" (FLR-T-12.1), concretely: the real app factory, run in this
 * process against the restored database on a loopback port; `/health` must answer 200 with the
 * schema revision; then the most recently edited project is opened the way the editor opens it —
 * as its owner, through a session issued in the scratch database (dropped with it), with
 * `GET /api/projects/:id` and `GET /api/projects/:id/model.json`. The model the app serves is
 * hashed with the engine, and the hash must be the head the app named: the restore holds the
 * document, intact, behind working auth, ownership and routes.
 */
export function appOpener(base: { config: Config; rulePacks?: InstalledPacks }): AppOpener {
  return async (databaseUrl) => {
    const config: Config = { ...base.config, DATABASE_URL: databaseUrl };
    const db = createDb(databaseUrl);
    const app = createApp({
      config,
      db,
      oidc: null,
      verifier: null,
      applier: opsApplier,
      renderer: null,
      ...(base.rulePacks === undefined ? {} : { rulePacks: base.rulePacks }),
    });
    const server = app.listen(0, '127.0.0.1');
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
      });
      const { port } = server.address() as AddressInfo;
      const origin = `http://127.0.0.1:${String(port)}`;

      const healthRes = await fetch(`${origin}/health`);
      const healthBody = (await healthRes.json().catch(() => ({}))) as { schemaRevision?: string | null };
      const health = { status: healthRes.status, schemaRevision: healthBody.schemaRevision ?? null };
      if (healthRes.status !== 200) throw new Error(`/health answered ${String(healthRes.status)} on the restored database`);

      const projects = await db.project.count({ where: { deletedAt: null } });
      const project = await db.project.findFirst({
        where: { deletedAt: null, owner: { disabledAt: null }, heads: { some: { name: MAIN } } },
        orderBy: { updatedAt: 'desc' },
        select: { id: true, ownerAccountId: true },
      });
      if (project === null) return { health, projects, opened: null } satisfies OpenedApp;

      const session = await issue(db, project.ownerAccountId, 'password', { userAgent: 'restore-drill' });
      const headers = { cookie: `${cookieName(isSecureOrigin(config))}=${session.token}` };

      const summaryRes = await fetch(`${origin}/api/projects/${project.id}`, { headers });
      if (summaryRes.status !== 200) throw new Error(`GET /api/projects/${project.id} answered ${String(summaryRes.status)}`);
      const summary = (await summaryRes.json()) as { name: string; head: { version: string } | null };
      if (summary.head === null) throw new Error(`project ${project.id} has no head on main`);

      const modelRes = await fetch(`${origin}/api/projects/${project.id}/model.json`, { headers });
      if (modelRes.status !== 200) throw new Error(`GET /api/projects/${project.id}/model.json answered ${String(modelRes.status)}`);
      const text = await modelRes.text();
      let model: unknown;
      try {
        model = JSON.parse(text);
      } catch {
        throw new Error(`the model the app served for project ${project.id} is not JSON`);
      }
      const modelHash = contentHash(model);
      if (modelHash !== summary.head.version) {
        throw new Error(`project ${project.id}: the served model hashes to ${modelHash.slice(0, 12)}…, but its head is ${summary.head.version.slice(0, 12)}…`);
      }
      const verdict = validate(text);
      return {
        health,
        projects,
        opened: {
          id: project.id,
          name: summary.name,
          head: summary.head.version,
          modelHash,
          modelBytes: Buffer.byteLength(text),
          valid: verdict.valid,
          errors: verdict.diagnostics.filter((d) => d.severity === 'error').length,
        },
      } satisfies OpenedApp;
    } finally {
      await eventHubOf(app).close().catch(() => undefined);
      await new Promise<void>((resolve) => {
        server.close(() => { resolve(); });
        // fetch keeps its connections alive; they would hold the close open for seconds.
        server.closeAllConnections();
      });
      await db.$disconnect();
    }
  };
}
