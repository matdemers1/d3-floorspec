import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { contentHash } from '@floorspec/engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportIfc, ifcFileName, ifcPayload, ifcWorkerUrl, IFC_CONTENT_TYPE, type IfcPayload } from '../src/export/ifc/index.js';
import { handlers } from '../src/queue/handlers.js';

/**
 * FLR-T-9.4, the Node side: the payload the IFC worker reads, and the HTTP exchange with it.
 *
 * The payloads of the sample houses are committed in workers/ifc/tests/fixtures, where the Python
 * tests read them; this test keeps them equal to what `ifcPayload` makes today
 * (`UPDATE_IFC_FIXTURES=1 pnpm --filter @d3-floorspec/worker test` rewrites them).
 */

const root = new URL('../../../', import.meta.url);
const read = (path: string): Record<string, unknown> => JSON.parse(readFileSync(new URL(path, root), 'utf8')) as Record<string, unknown>;
const FIXTURES = new URL('workers/ifc/tests/fixtures/', root);
const SOURCES: Record<string, string> = {
  'three-room-house': 'packages/mcp/test/fixtures/three-room-house.json',
  'l-stair-hip-roof': 'apps/web/e2e/fixtures/l-stair-hip-roof.json',
  'p5-systems-demo': 'packages/engine/standard/conformance/ext/FS_electrical/0.1.0/examples/001-p5-demo-house/input.json',
  'every-mapping': 'workers/ifc/tests/fixtures/every-mapping.floorspec.json',
};
const AT = new Date('2026-10-05T12:00:00Z');
const doc = (name: string): Record<string, unknown> => {
  const source = SOURCES[name];
  if (source === undefined) throw new Error(`no fixture ${name}`);
  return read(source);
};

describe('the IFC payload', () => {
  for (const [name, source] of Object.entries(SOURCES)) {
    it(`for ${name} is the committed fixture the Python tests read`, () => {
      const payload = ifcPayload(read(source), { hash: '', seq: null, at: AT });
      const text = `${JSON.stringify(payload)}\n`;
      const target = new URL(`${name}.payload.json`, FIXTURES);
      if (process.env['UPDATE_IFC_FIXTURES'] === '1') writeFileSync(target, text);
      expect(readFileSync(target, 'utf8')).toBe(text);
    });
  }

  it('carries the design view, its derived values, the version and the engine', () => {
    const every = doc('every-mapping');
    const p = ifcPayload(every, { hash: 'a'.repeat(64), seq: 42, at: new Date('2026-10-05T12:34:56.789Z') });
    expect(p.format).toBe('floorspec-ifc-payload');
    expect(p.version).toBe(1);
    expect(p.hash).toBe('a'.repeat(64));
    expect(p.file).toEqual({ name: 'every-ifc-mapping-v42.ifc', timestamp: '2026-10-05T12:34:56Z', versionSeq: 42 });
    expect(p.design).toEqual({ OS: 'OPA' });
    // The view holds no option members' `option` and no option sets: one design (19.7).
    expect(p.document.slabs?.['PATIO']).toBeDefined();
    expect(Object.keys(p.derived.walls)).toHaveLength(16);
    expect(p.derived.roofs?.['RF']?.surface?.faces).toHaveLength(4);
    // A bare document carries its own content hash.
    expect(ifcPayload(every, { hash: '', at: AT }).hash).toBe(contentHash(every));
  });

  it('refuses a document that is not valid', () => {
    expect(() => ifcPayload({ floorspec: '0.3', project: {}, walls: { W: { level: 'nowhere' } } }, { hash: '', at: AT })).toThrow(/not valid/);
  });

  it('names the file by the version’s number, else its hash', () => {
    expect(ifcFileName('Stair & hip roof house', { hash: 'b'.repeat(64), seq: 7, at: AT })).toBe('stair-hip-roof-house-v7.ifc');
    expect(ifcFileName('Stair & hip roof house', { hash: 'c0ffee'.padEnd(64, '0'), seq: null, at: AT })).toBe('stair-hip-roof-house-c0ffee00.ifc');
  });

  it('finds the worker by IFC_WORKER_URL, the compose name in production, else loopback', () => {
    expect(ifcWorkerUrl({ IFC_WORKER_URL: 'http://x:1/' })).toBe('http://x:1');
    expect(ifcWorkerUrl({ NODE_ENV: 'production' })).toBe('http://ifc-worker:3410');
    expect(ifcWorkerUrl({})).toBe('http://127.0.0.1:3410');
  });
});

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

describe('the IFC worker exchange', () => {
  let server: Server;
  let url = '';
  let reply: (payload: IfcPayload) => { status: number; body: string; headers?: Record<string, string> } = () => ({ status: 500, body: '' });
  let seen: IfcPayload | null = null;

  beforeAll(async () => {
    server = createServer((req, res) => {
      void body(req).then((text) => {
        seen = JSON.parse(text) as IfcPayload;
        const r = reply(seen);
        res.writeHead(r.status, r.headers ?? {});
        res.end(r.body);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('posts the payload and returns the file with the worker’s summary', async () => {
    const summary = { schema: 'IFC4', view: 'ReferenceView_V1.2', entities: { IfcWall: 16 }, validation: { errors: 0 } };
    reply = () => ({ status: 200, body: 'ISO-10303-21;\n', headers: { 'content-type': IFC_CONTENT_TYPE, 'x-floorspec-ifc-summary': JSON.stringify(summary) } });
    const out = await exportIfc(doc('l-stair-hip-roof'), { version: { hash: 'd'.repeat(64), seq: 3, at: AT }, workerUrl: url });
    expect(seen?.hash).toBe('d'.repeat(64));
    expect(seen?.document.project.name).toBe('Stair and hip roof house');
    expect(out).toMatchObject({ name: 'stair-and-hip-roof-house-v3.ifc', contentType: 'application/x-step', summary });
    expect(new TextDecoder().decode(out.bytes)).toBe('ISO-10303-21;\n');
  });

  it('turns a refusal into the worker’s own sentence', async () => {
    reply = () => ({ status: 422, body: JSON.stringify({ error: 'the payload is not floorspec-ifc-payload version 1' }), headers: { 'content-type': 'application/json' } });
    await expect(exportIfc(doc('three-room-house'), { version: { hash: '', at: AT }, workerUrl: url })).rejects.toThrow(
      'the IFC worker refused the export: the payload is not floorspec-ifc-payload version 1',
    );
  });

  it('says so when the worker cannot be reached', async () => {
    await expect(exportIfc(doc('three-room-house'), { version: { hash: '', at: AT }, workerUrl: 'http://127.0.0.1:9' })).rejects.toThrow(
      /the IFC worker at http:\/\/127\.0\.0\.1:9 could not be reached/,
    );
  });

  it('is the export.ifc job kind of the drain', () => {
    expect(Object.keys(handlers)).toContain('export.ifc');
  });
});

// The real worker, when workers/ifc/.venv exists (see its README): the same exchange, end to end.
const python = fileURLToPath(new URL('workers/ifc/.venv/bin/python', root));
describe.skipIf(!existsSync(python))('the real IFC worker', () => {
  let child: ChildProcess;
  let url = '';

  beforeAll(async () => {
    child = spawn(python, ['-m', 'floorspec_ifc', 'serve', '--port', '0'], { cwd: fileURLToPath(new URL('workers/ifc/', root)), stdio: ['ignore', 'pipe', 'inherit'] });
    url = await new Promise<string>((resolve, reject) => {
      let text = '';
      child.stdout?.on('data', (d: Buffer) => {
        text += d.toString('utf8');
        const line = text.split('\n').find((l) => l.includes('listening'));
        if (line !== undefined) resolve(`http://127.0.0.1:${String((JSON.parse(line) as { port: number }).port)}`);
      });
      child.on('exit', (code) => { reject(new Error(`the IFC worker exited with ${String(code)}`)); });
    });
  }, 30_000);
  afterAll(() => {
    child.kill('SIGTERM');
  });

  it('writes an IFC4 Reference View file with no validation errors', async () => {
    const out = await exportIfc(doc('l-stair-hip-roof'), { version: { hash: '', seq: 1, at: AT }, workerUrl: url });
    const text = new TextDecoder().decode(out.bytes);
    expect(text.startsWith('ISO-10303-21;')).toBe(true);
    expect(text).toContain("FILE_DESCRIPTION(('ViewDefinition [ReferenceView_V1.2]'),'2;1');");
    expect(text).toContain("FILE_SCHEMA(('IFC4'));");
    expect(out.summary.validation.errors).toBe(0);
    expect(out.summary.entities).toMatchObject({ IfcWall: 16, IfcDoor: 3, IfcWindow: 8, IfcSpace: 4, IfcRoof: 1, IfcStair: 1, IfcStairFlight: 2 });
  }, 60_000);
});
