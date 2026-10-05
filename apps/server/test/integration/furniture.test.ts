import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { OFFICIAL_READER, Package, validate } from '@floorspec/engine';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createProjectAs, reset, setupOperator, start, testDb, type Browser, type Reply, type Running } from './helpers.js';
import { fetchBytes, type UploadedAsset } from './assets-support.js';

/**
 * FS_furniture over HTTP (FLR-T-8.3): a library item's glTF model and SVG symbol uploaded through
 * the asset store as `?as=model` and `?as=symbol`, kept byte for byte (so their digests are the
 * catalogue's), placed in a kitchen by one Ops batch that declares the extension, and the result a
 * valid package — model.json and both files at their paths — to the engine's package validator
 * configured as the server runs it, knowing and implementing FS_furniture. An SVG that carries a
 * script is stored without it; a texture upload still refuses a model.
 */

const LIB = new URL('../../../../packages/engine/standard/registry/FS_furniture/library/', import.meta.url);
const libFile = (path: string) => new Uint8Array(readFileSync(new URL(path, LIB)));
const LIBRARY = JSON.parse(readFileSync(new URL('library.json', LIB), 'utf8')) as {
  items: Record<string, { kind: string; element: { category: string; name: string; catalogue: string; clearances?: object; fallback: { box: object } }; model: { path: string; sha256: string }; symbol: { path: string; sha256: string } }>;
};
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

const IN = 32_512;
const FT = 12 * IN;

/** A 12 × 10 ft kitchen, drawn counter-clockwise. */
const KITCHEN = [
  { op: 'setProperty', id: '$document', path: '/floorspec', value: '0.3' },
  { op: 'addElement', collection: 'buildings', id: 'B1', element: {} },
  { op: 'addElement', collection: 'levels', id: 'L1', element: { building: 'B1', name: 'Level 1', elevation: 0, height: 9 * FT } },
  { op: 'addElement', collection: 'types', id: 'INT', element: { kind: 'wallType', name: '2x4 partition', layers: [{ thickness: 16_256, function: 'finish' }, { thickness: 113_792, function: 'core' }, { thickness: 16_256, function: 'finish' }] } },
  ...([[0, 0], [12 * FT, 0], [12 * FT, 10 * FT], [0, 10 * FT]] as const).map((position, i) => ({ op: 'addElement', collection: 'junctions', id: `J${String(i + 1)}`, element: { level: 'L1', position } })),
  ...[1, 2, 3, 4].map((i) => ({ op: 'addElement', collection: 'walls', id: `W${String(i)}`, element: { level: 'L1', start: `J${String(i)}`, end: `J${String((i % 4) + 1)}`, type: 'INT' } })),
  { op: 'addElement', collection: 'rooms', id: 'KIT', element: { level: 'L1', anchor: [6 * FT, 5 * FT], name: 'Kitchen', function: 'kitchen' } },
];

async function upload(base: string, as: Browser, projectId: string, bytes: Uint8Array, name: string, purpose?: string): Promise<Reply> {
  const headers: Record<string, string> = { 'content-type': 'application/octet-stream', 'x-asset-name': encodeURIComponent(name) };
  if (as.cookies.size > 0) headers['cookie'] = [...as.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  const res = await fetch(`${base}/api/projects/${projectId}/assets${purpose === undefined ? '' : `?as=${purpose}`}`, { method: 'POST', headers, body: Buffer.from(bytes) });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  return { status: res.status, body, text, headers: res.headers };
}

describe('furniture through the asset store and the applier', () => {
  const db = testDb();
  let running: Running;
  let dir: string;
  let alice: Browser;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'flr-furniture-it-'));
    running = await start({ env: { ASSET_DIR: dir } });
  });
  afterAll(async () => {
    await running.close();
    await rm(dir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await reset(db);
    alice = await setupOperator(running);
  });

  it('uploads a library refrigerator’s model and symbol as they are, places it in one batch, and the package validates with FS_furniture known', async () => {
    const { id } = await createProjectAs(alice);
    expect((await alice.post(`/api/projects/${id}/ops`, { batch: KITCHEN })).status).toBe(201);
    const item = LIBRARY.items['refrigerator-900']!;
    const glb = libFile(item.model.path);
    const svg = libFile(item.symbol.path);

    const m = await upload(running.url, alice, id, glb, 'refrigerator-900.glb', 'model');
    expect(m.status, m.text).toBe(201);
    const model = (m.body as { asset: UploadedAsset }).asset;
    expect(model).toMatchObject({ sha256: item.model.sha256, mediaType: 'model/gltf-binary', byteLength: glb.length, width: 0, height: 0, path: `assets/${item.model.sha256}.glb` });
    const s = await upload(running.url, alice, id, svg, 'refrigerator-900.svg', 'symbol');
    expect(s.status, s.text).toBe(201);
    const symbol = (s.body as { asset: UploadedAsset; stripped: string[] }).asset;
    expect(symbol).toMatchObject({ sha256: item.symbol.sha256, mediaType: 'image/svg+xml', width: 900, height: 700, path: `assets/${item.symbol.sha256}.svg` });
    expect((s.body as { stripped: string[] }).stripped).toEqual([]);

    // The batch the editor sends (apps/web/src/furniture/ops.ts).
    const batch = [
      { op: 'setProperty', id: '$document', path: '/extensionsUsed/FS_furniture', value: '0.1.0' },
      { op: 'addElement', collection: 'assets', id: 'FA1', element: { path: model.path, sha256: model.sha256, mediaType: model.mediaType, byteLength: model.byteLength, name: 'refrigerator-900.glb' } },
      { op: 'addElement', collection: 'assets', id: 'FA2', element: { path: symbol.path, sha256: symbol.sha256, mediaType: symbol.mediaType, byteLength: symbol.byteLength, name: 'refrigerator-900.svg' } },
      {
        op: 'placeElement',
        extension: 'FS_furniture',
        collection: 'appliances',
        host: { mode: 'surface', room: 'KIT', surface: 'floor', at: [6 * FT, 73_152 + 12_800], rotation: 90_000_000 },
        element: { category: 'refrigerator', catalogue: 'refrigerator-900', name: item.element.name, clearances: item.element.clearances, fallback: { box: item.element.fallback.box, asset: 'FA1', symbol: 'FA2' } },
      },
    ];
    const applied = await alice.post(`/api/projects/${id}/ops`, { batch });
    expect(applied.status, applied.text).toBe(201);

    const doc = await fetchBytes(running.url, alice, `/api/projects/${id}/model.json`);
    const list = (await alice.get(`/api/projects/${id}/assets`)).body as { assets: { path: string; href: string | null; mediaType: string }[] };
    expect(list.assets.map((a) => a.mediaType).sort()).toEqual(['image/svg+xml', 'model/gltf-binary']);
    const files: Record<string, Uint8Array> = {};
    for (const a of list.assets) files[a.path] = (await fetchBytes(running.url, alice, `${a.href ?? ''}?download`)).bytes;
    expect(sha(files[model.path]!)).toBe(item.model.sha256);
    const result = validate(doc.bytes, { package: new Package(files), ...OFFICIAL_READER });
    expect(result.valid, JSON.stringify(result.diagnostics)).toBe(true);
    expect(result.diagnostics.filter((d) => d.code.startsWith('FS-FURN-') || /^FS-INV-100[5-7]$/.test(d.code))).toEqual([]);

    // The symbol is served as an image that runs nothing, wherever it is opened.
    const served = await fetchBytes(running.url, alice, `/api/projects/${id}/assets/${symbol.sha256}`);
    expect(served.headers.get('content-type')).toBe('image/svg+xml');
    expect(served.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(served.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('stores an SVG symbol without its script, and says what it removed', async () => {
    const { id } = await createProjectAs(alice);
    const evil = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" onload="alert(1)"><script>alert(2)</script><rect width="10" height="10"/></svg>');
    const res = await upload(running.url, alice, id, evil, 'chair.svg', 'symbol');
    expect(res.status, res.text).toBe(201);
    const body = res.body as { asset: UploadedAsset; stripped: string[] };
    expect(body.stripped).toEqual(expect.arrayContaining(['<script>', '@onload']));
    const stored = new TextDecoder().decode((await fetchBytes(running.url, alice, body.asset.href)).bytes);
    expect(stored).not.toMatch(/script|onload|alert/);
    expect(stored).toContain('<rect width="10" height="10"/>');
    const audit = await db.auditLog.findFirst({ where: { action: 'asset.upload', targetId: body.asset.sha256 } });
    expect(audit?.detail).toMatchObject({ purpose: 'symbol', stripped: expect.arrayContaining(['<script>']) as unknown });
  });

  it('refuses a model as a texture, a model that names another file, and an unknown purpose', async () => {
    const { id } = await createProjectAs(alice);
    const glb = libFile('models/sofa-2100.glb');
    expect((await upload(running.url, alice, id, glb, 'sofa.glb')).status).toBe(415);
    const external = new TextEncoder().encode(JSON.stringify({ asset: { version: '2.0' }, buffers: [{ uri: 'sofa.bin', byteLength: 10 }] }));
    const refused = await upload(running.url, alice, id, external, 'sofa.gltf', 'model');
    expect(refused.status).toBe(422);
    expect((refused.body as { error: string }).error).toMatch(/sofa\.bin.*\.glb/);
    expect((await upload(running.url, alice, id, glb, 'sofa.glb', 'script')).status).toBe(400);
    expect(await db.projectAsset.count()).toBe(0);
  });
});
