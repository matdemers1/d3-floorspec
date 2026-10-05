import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { Browser, Reply } from './helpers.js';

/**
 * The IFC round trip's suites (FLR-T-9.5): the Python IFC worker, or a stand-in, and uploads.
 *
 * With workers/ifc/.venv present the real worker runs — IfcOpenShell exporting, the edits made with
 * its authoring API (workers/ifc/tests/edits.py), the reconciliation — and without it (CI's
 * integration job has no Python) a stand-in answers `POST /import` with the reconciliation it is
 * given, so the route, the changeset and the report are still tested end to end.
 */

export const workerDir = fileURLToPath(new URL('../../../../workers/ifc/', import.meta.url));
export const python = `${workerDir}.venv/bin/python`;
export const REAL = existsSync(python);

export interface Worker {
  readonly url: string;
  stop(): Promise<void>;
}

/** The real IFC worker on a free port. */
export async function realWorker(): Promise<Worker> {
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

/** A stand-in that answers every `POST /import` with what `answer` returns for its request. */
export async function stubWorker(answer: (request: { payload: { hash: string }; name: string }) => { status: number; body: unknown }): Promise<Worker> {
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const request = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { payload: { hash: string }; name: string };
      const { status, body } = answer(request);
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`, stop: () => new Promise((resolve) => server.close(() => { resolve(); })) };
}

/** A reconciliation as the worker answers it, from its edits and report. */
export function reconciliation(base: string, edits: unknown[] = [], report: unknown[] = []) {
  return {
    format: 'floorspec-ifc-reconciliation',
    version: 1,
    base,
    documentHash: base,
    file: { schema: 'IFC4', originatingSystem: 'Stand-in', lengthUnitMm: 1 },
    batch: edits.flatMap((e) => (e as { ops: unknown[] }).ops),
    edits,
    report,
    counts: { elements: 1, unchanged: 1, edits: edits.length, ops: 0, unmapped: 0, ambiguous: 0, notes: 0 },
  };
}

/** A minimal STEP file whose elements say they came from `hash`, as the api's scan reads it. */
export function stepCarrying(hash: string | null): Uint8Array {
  const identity = hash === null ? '' : `#2=IFCPROPERTYSINGLEVALUE('DocumentHash',$,IFCIDENTIFIER('${hash}'),$);\n`;
  return new TextEncoder().encode(`ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n#1=IFCPROJECT('0',$,'P',$,$,$,$,$,$);\n${identity}ENDSEC;\nEND-ISO-10303-21;\n`);
}

/** Upload an IFC file: the raw bytes as the body, as the editor sends them. */
export async function uploadIfc(base: string, as: Browser | { bearer: string }, projectId: string, bytes: Uint8Array, options: { name?: string; base?: string } = {}): Promise<Reply> {
  const headers: Record<string, string> = { 'content-type': 'application/x-step' };
  if ('bearer' in as) headers['authorization'] = `Bearer ${as.bearer}`;
  else if (as.cookies.size > 0) headers['cookie'] = [...as.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  headers['x-file-name'] = encodeURIComponent(options.name ?? 'edited.ifc');
  const query = options.base === undefined ? '' : `?base=${options.base}`;
  const res = await fetch(`${base}/api/projects/${projectId}/imports/ifc${query}`, { method: 'POST', headers, body: Buffer.from(bytes), redirect: 'manual' });
  const text = await res.text();
  let body: unknown;
  try {
    body = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  return { status: res.status, body, text, headers: res.headers };
}

/** Run workers/ifc/tests/edits.py's scenarios on an IFC file: the edits an architect's tool makes. */
export async function editIfc(source: string, target: string, scenarios: readonly string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(python, ['-m', 'tests.edits', source, target, ...scenarios], { cwd: workerDir, stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('exit', (code) => { if (code === 0) resolve(); else reject(new Error(`the edits exited with ${String(code)}`)); });
  });
}
