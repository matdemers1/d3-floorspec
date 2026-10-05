import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { documentHashOf, IfcImportRefused, IfcWorkerUnavailable, reconcileIfc } from '../src/export/ifc/roundtrip.js';

/**
 * The api's side of the IFC round trip (FLR-T-9.5): which version a file says it came from, and the
 * `POST /import` exchange with the Python IFC worker (workers/ifc/tests/test_import.py tests the
 * reconciliation itself; apps/server's imports suite runs the two together).
 */

const root = new URL('../../../', import.meta.url);
const doc = JSON.parse(readFileSync(new URL('packages/mcp/test/fixtures/three-room-house.json', root), 'utf8')) as object;
const H1 = 'a'.repeat(64);
const H2 = 'b'.repeat(64);
const AT = new Date('2026-10-05T12:00:00Z');
const step = (lines: string[]) => new TextEncoder().encode(`ISO-10303-21;\nDATA;\n${lines.join('\n')}\nENDSEC;\n`);

describe('documentHashOf', () => {
  it('finds the DocumentHash every element carries, the commonest first', () => {
    const bytes = step([
      `#1=IFCPROPERTYSINGLEVALUE('DocumentHash',$,IFCIDENTIFIER('${H1}'),$);`,
      `#2=IFCPROPERTYSINGLEVALUE('DocumentHash',$,IFCIDENTIFIER('${H1}'),$);`,
      // Rewritten by another tool: spaces, a description, upper case.
      `#3= IFCPROPERTYSINGLEVALUE( 'DocumentHash' , 'copied' , IFCIDENTIFIER( '${H2.toUpperCase()}' ) , $ );`,
    ]);
    expect(documentHashOf(bytes)).toEqual({ hash: H1, hashes: [H1, H2] });
  });

  it('finds nothing in a file no Floorspec export wrote', () => {
    expect(documentHashOf(step(["#1=IFCPROPERTYSINGLEVALUE('ID',$,IFCIDENTIFIER('W1'),$);"]))).toEqual({ hash: null, hashes: [] });
  });
});

describe('reconcileIfc', () => {
  let server: Server | null = null;
  afterEach(async () => {
    const s = server;
    server = null;
    if (s !== null) await new Promise<void>((resolve) => s.close(() => { resolve(); }));
  });

  async function stub(status: number, body: unknown, seen: unknown[] = []): Promise<string> {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        seen.push({ path: req.url, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown });
        res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      });
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  }

  it('sends the version’s export payload and the file, and answers the reconciliation', async () => {
    const seen: { path: string; body: { format: string; version: number; payload: { hash: string; format: string }; ifc: string; name: string } }[] = [];
    const answer = { format: 'floorspec-ifc-reconciliation', version: 1, base: H1, documentHash: H1, file: {}, batch: [], edits: [], report: [], counts: {} };
    const url = await stub(200, answer, seen);
    const bytes = new TextEncoder().encode('ISO-10303-21;');
    expect(await reconcileIfc(doc, bytes, { version: { hash: H1, at: AT }, name: 'edited.ifc', workerUrl: url })).toEqual(answer);
    expect(seen[0]?.path).toBe('/import');
    expect(seen[0]?.body).toMatchObject({ format: 'floorspec-ifc-import', version: 1, name: 'edited.ifc', ifc: Buffer.from(bytes).toString('base64') });
    expect(seen[0]?.body.payload).toMatchObject({ format: 'floorspec-ifc-payload', hash: H1 });
  });

  it('says the worker refused the file, in the worker’s words', async () => {
    const url = await stub(422, { error: 'the file is not an IFC file (STEP physical file, ISO-10303-21)' });
    await expect(reconcileIfc(doc, new Uint8Array([1]), { version: { hash: H1, at: AT }, name: 'x.ifc', workerUrl: url })).rejects.toThrow(IfcImportRefused);
  });

  it('says the worker could not be reached', async () => {
    await expect(reconcileIfc(doc, new Uint8Array([1]), { version: { hash: H1, at: AT }, name: 'x.ifc', workerUrl: 'http://127.0.0.1:9' })).rejects.toThrow(IfcWorkerUnavailable);
  });

  it('refuses an answer that is not a reconciliation', async () => {
    const url = await stub(200, { hello: 'world' });
    await expect(reconcileIfc(doc, new Uint8Array([1]), { version: { hash: H1, at: AT }, name: 'x.ifc', workerUrl: url })).rejects.toThrow('not a reconciliation');
  });
});
