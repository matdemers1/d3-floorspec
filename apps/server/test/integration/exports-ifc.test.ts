import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { createDrain, type Drain } from '@d3-floorspec/worker/queue';
import type { Prisma } from '../../src/generated/prisma/client.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { reset, setupOperator, start, testDb, TEST_ENV, type Browser, type Reply, type Running } from './helpers.js';
import { projectWithDocument } from './drawings-support.js';

/**
 * FLR-T-9.4 end to end: an IFC export is asked for over the API, queued on the Postgres job queue,
 * drained by the worker's drain — which derives the version with the engine and has the Python
 * IFC worker write the file — and downloaded.
 *
 * With workers/ifc/.venv present (its README) the real IFC worker runs, IfcOpenShell and all;
 * without it (CI's integration job has no Python) a stand-in answers the same HTTP exchange, so the
 * job kind, the route and the queue are still tested end to end.
 */

interface ExportView {
  id: string;
  kind: string;
  status: string;
  levels: string[] | null;
  page: string | null;
  error: string | null;
  result: { name: string; contentType: string; size: number; sha256: string; ifc?: { schema: string; view: string; entities: Record<string, number>; validation: { errors: number } } } | null;
  download: string | null;
}

const db = testDb();
const view = (r: Reply): ExportView => (r.body as { export: ExportView }).export;
const HOUSE = JSON.parse(readFileSync(new URL('../../../web/e2e/fixtures/l-stair-hip-roof.json', import.meta.url), 'utf8')) as Prisma.InputJsonObject;
const workerDir = fileURLToPath(new URL('../../../../workers/ifc/', import.meta.url));
const python = `${workerDir}.venv/bin/python`;
const REAL = existsSync(python);

async function download(browser: Browser, url: string): Promise<{ status: number; type: string | null; disposition: string | null; text: string }> {
  const cookie = [...browser.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  const res = await fetch(url, { headers: { cookie } });
  return { status: res.status, type: res.headers.get('content-type'), disposition: res.headers.get('content-disposition'), text: await res.text() };
}

/** The real IFC worker on a free port, or a stand-in that answers as it does. */
async function ifcWorker(): Promise<{ url: string; stop: () => Promise<void> }> {
  if (REAL) {
    const child: ChildProcess = spawn(python, ['-m', 'floorspec_ifc', 'serve', '--port', '0'], { cwd: workerDir, stdio: ['ignore', 'pipe', 'inherit'] });
    const url = await new Promise<string>((resolve, reject) => {
      let text = '';
      child.stdout?.on('data', (d: Buffer) => {
        text += d.toString('utf8');
        const line = text.split('\n').find((l) => l.includes('listening'));
        if (line !== undefined) resolve(`http://127.0.0.1:${String((JSON.parse(line) as { port: number }).port)}`);
      });
      child.on('exit', (code) => { reject(new Error(`the IFC worker exited with ${String(code)}`)); });
    });
    return { url, stop: () => new Promise((resolve) => { child.once('exit', () => { resolve(); }); child.kill('SIGTERM'); }) };
  }
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { format: string; hash: string; file: { name: string } };
      if (payload.format !== 'floorspec-ifc-payload') {
        res.writeHead(422, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'not a payload' }));
        return;
      }
      const summary = { schema: 'IFC4', view: 'ReferenceView_V1.2', entities: { IfcWall: 16 }, validation: { errors: 0 } };
      res.writeHead(200, { 'content-type': 'application/x-step', 'x-floorspec-ifc-summary': JSON.stringify(summary) });
      res.end(`ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('ViewDefinition [ReferenceView_V1.2]'),'2;1');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n/* ${payload.hash} */\nENDSEC;\nEND-ISO-10303-21;\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`, stop: () => new Promise((resolve) => server.close(() => { resolve(); })) };
}

describe('IFC exports', () => {
  let running: Running;
  let drain: Drain;
  let worker: { url: string; stop: () => Promise<void> };
  const before = process.env['IFC_WORKER_URL'];

  beforeAll(async () => {
    running = await start();
    worker = await ifcWorker();
    process.env['IFC_WORKER_URL'] = worker.url;
  }, 30_000);
  afterAll(async () => {
    if (before === undefined) delete process.env['IFC_WORKER_URL'];
    else process.env['IFC_WORKER_URL'] = before;
    await worker.stop();
    await running.close();
  });
  beforeEach(async () => {
    await reset(db);
    drain = createDrain({ databaseUrl: TEST_ENV.DATABASE_URL, log: () => undefined });
  });
  afterEach(async () => {
    await drain.stop();
  });

  it('queues an IFC export, drains it through the IFC worker, and serves the file', async () => {
    const operator = await setupOperator(running);
    const { id, hash } = await projectWithDocument(db, operator, HOUSE, 'Stair and hip roof house');
    const asked = await operator.post(`/api/projects/${id}/exports`, { kind: 'ifc' });
    expect(asked.status, asked.text).toBe(202);
    expect(view(asked)).toMatchObject({ kind: 'ifc', status: 'queued', levels: null, page: null });

    expect(await drain.runOnce()).toBe(1);
    const done = view(await operator.get(`/api/projects/${id}/exports/${view(asked).id}`));
    expect(done.status, done.error ?? '').toBe('done');
    expect(done.result).toMatchObject({ name: `stair-and-hip-roof-house-${hash.slice(0, 8)}.ifc`, contentType: 'application/x-step' });
    expect(done.result?.ifc).toMatchObject({ schema: 'IFC4', view: 'ReferenceView_V1.2', validation: { errors: 0 } });

    const file = await download(operator, `${running.url}${done.download ?? ''}`);
    expect(file.status).toBe(200);
    expect(file.type).toBe('application/x-step');
    expect(file.disposition).toBe(`attachment; filename="stair-and-hip-roof-house-${hash.slice(0, 8)}.ifc"`);
    expect(file.text.startsWith('ISO-10303-21;')).toBe(true);
    expect(file.text).toContain("FILE_DESCRIPTION(('ViewDefinition [ReferenceView_V1.2]'),'2;1');");
    expect(file.text).toContain(hash);
    if (REAL) {
      expect(done.result?.ifc?.entities).toMatchObject({ IfcWall: 16, IfcOpeningElement: 11, IfcDoor: 3, IfcWindow: 8, IfcSpace: 4, IfcRoof: 1, IfcStair: 1, IfcStairFlight: 2 });
      // Every element names its Floorspec ID in Floorspec_Identity.
      expect(file.text).toContain("IFCPROPERTYSET('");
      expect(file.text).toContain("'Floorspec_Identity'");
      expect(file.text).toContain("IFCIDENTIFIER('GAB')");
    }
    expect(await db.auditLog.count({ where: { action: 'export.request', targetId: view(asked).id } })).toBe(1);
  }, 60_000);

  it('exports the whole model: an IFC export takes no levels', async () => {
    const operator = await setupOperator(running);
    const { id } = await projectWithDocument(db, operator, HOUSE, 'Stair and hip roof house');
    const refused = await operator.post(`/api/projects/${id}/exports`, { kind: 'ifc', levels: ['L1'] });
    expect(refused.status).toBe(400);
    expect(refused.text).toContain('takes no levels');
    expect(await db.job.count()).toBe(0);
  });

  it('fails the job with a reason a person can read when the IFC worker is not there', async () => {
    const operator = await setupOperator(running);
    const { id } = await projectWithDocument(db, operator, HOUSE, 'Stair and hip roof house');
    process.env['IFC_WORKER_URL'] = 'http://127.0.0.1:9';
    try {
      const job = view(await operator.post(`/api/projects/${id}/exports`, { kind: 'ifc' }));
      await drain.runOnce();
      const failed = view(await operator.get(`/api/projects/${id}/exports/${job.id}`));
      expect(failed.status).toBe('failed');
      expect(failed.error).toMatch(/^the IFC worker at http:\/\/127\.0\.0\.1:9 could not be reached/);
    } finally {
      process.env['IFC_WORKER_URL'] = worker.url;
    }
  });
});
