import { readFileSync } from 'node:fs';
import { contentHash } from '@floorspec/engine';
import { NOTICE } from '@floorspec/rules-engine';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Prisma } from '../../src/db.js';
import { NO_RULE_PACKS } from '../../src/routes/checks.js';
import { loadRulePacks } from '../../src/rules/packs.js';
import { reset, setupOperator, start, testDb, type Browser, type Running } from './helpers.js';

/**
 * FLR-T-6.2, the server side: GET /api/projects/:id/findings evaluates the installed rule packs
 * against the committed head with @floorspec/rules-engine, and answers with the findings, the
 * notice and each rule's edition — advice that never blocks an edit (FLR-ADR-011, FLR-REQ-098).
 *
 * The fixtures are copied from the Floorspec standard at 112a83d: test/fixtures/rule-packs/example.json
 * is rules/example/generated/pack.json — the synthetic example pack, citing only the made-up codes
 * TEST-CODE and TEST-ELEC — and test/fixtures/documents/two-bedrooms.json is
 * rules/example/documents/two-bedrooms.json, whose small second bedroom (R3) its ROOM-SIZE rule finds.
 * test/fixtures/profiles/synthetic.json is a profile adopting those codes' editions, as the
 * standard's tools/build-pack.ts evaluates the pack's fixtures under: the default profile adopts
 * only real model codes, so under it the pack's rules are not evaluated (reason "edition").
 */

const PACKS = new URL('../fixtures/rule-packs/', import.meta.url).pathname;
const PROFILE = new URL('../fixtures/profiles/synthetic.json', import.meta.url).pathname;
const HOUSE = JSON.parse(readFileSync(new URL('../fixtures/documents/two-bedrooms.json', import.meta.url), 'utf8')) as Prisma.InputJsonObject;

interface FindingsBody {
  profile?: string;
  head: string;
  hash: string;
  findings: { pack: string; version: string; rule: string; subject: { kind: string; id: string }; citation: { code: string; edition: string; section: string }; severity: string; message: string }[];
  rulePacks: { name: string; version: string; title: string }[];
  note: string;
  notice?: string;
  evaluated?: { rule: string; citation: { edition: string } }[];
}

const db = testDb();

/** A project whose head is `document`, seeded as a version row — the way a project stored before an import would be. */
async function projectWith(operator: Browser, document: Prisma.InputJsonObject): Promise<string> {
  const { id } = (await operator.post('/api/projects', { name: 'Two bedrooms' })).body as { id: string };
  const hash = contentHash(document);
  await db.version.upsert({ where: { hash }, create: { hash, document }, update: {} });
  await db.head.update({ where: { projectId_name: { projectId: id, name: 'main' } }, data: { versionHash: hash } });
  return id;
}

describe('findings with a rule pack installed', () => {
  let running: Running;

  beforeAll(async () => {
    running = await start({ with: { rulePacks: loadRulePacks(PACKS, PROFILE) } });
  });
  afterAll(async () => {
    await running.close();
  });
  beforeEach(async () => {
    await reset(db);
  });

  it('returns the findings with the notice and the edition each rule was checked against', async () => {
    const operator = await setupOperator(running);
    const id = await projectWith(operator, HOUSE);
    const res = await operator.get(`/api/projects/${id}/findings`);
    expect(res.status, res.text).toBe(200);
    const body = res.body as FindingsBody;
    expect(body).toMatchObject({ head: 'main', hash: contentHash(HOUSE), note: NOTICE, notice: NOTICE, profile: 'Synthetic codes (test)' });
    expect(body.rulePacks).toEqual([{ name: 'example', version: expect.any(String) as string, title: expect.any(String) as string }]);
    const small = body.findings.filter((f) => f.rule === 'ROOM-SIZE');
    expect(small.map((f) => f.subject)).toEqual([{ kind: 'room', id: 'R3' }]);
    expect(small[0]).toMatchObject({ pack: 'example', citation: { code: 'TEST-CODE', edition: '2024' }, severity: 'mayNotMeet' });
    expect(small[0]?.message).toContain('TEST-CODE 2024');
    expect(body.evaluated?.find((r) => r.rule === 'ROOM-SIZE')?.citation.edition).toBe('2024');
    // Advice, never a verdict.
    expect(res.text).not.toMatch(/\bcompliant\b|\bpasses code\b/i);
  });

  it('never blocks an edit: a batch commits whatever the findings say, and they are read again after it', async () => {
    const operator = await setupOperator(running);
    const id = await projectWith(operator, HOUSE);
    const before = (await operator.get(`/api/projects/${id}/findings`)).body as FindingsBody;
    expect(before.findings.some((f) => f.rule === 'ROOM-SIZE')).toBe(true);
    // An edit that leaves the finding standing, and one that adds to it, both commit.
    const renamed = await operator.post(`/api/projects/${id}/ops`, { batch: [{ op: 'setProperty', id: '$project', path: '/name', value: 'Still small' }] });
    expect(renamed.status, renamed.text).toBe(201);
    const worse = await operator.post(`/api/projects/${id}/ops`, { batch: [{ op: 'setProperty', id: 'R2', path: '/name', value: 'Living' }, { op: 'setProperty', id: 'R3', path: '/name', value: 'Box room' }] });
    expect(worse.status, worse.text).toBe(201);
    const after = (await operator.get(`/api/projects/${id}/findings`)).body as FindingsBody;
    expect(after.hash).not.toBe(before.hash);
    expect(after.findings.filter((f) => f.rule === 'ROOM-SIZE').map((f) => f.subject.id)).toEqual(['R3']);
  });
});

describe('a design of a document with design options (Core 0.3, 19.6)', () => {
  let running: Running;
  const KITCHEN = JSON.parse(
    readFileSync(new URL('../../../../packages/engine/standard/conformance/core/0.3/options/001-kitchen-a-and-b/input.json', import.meta.url), 'utf8'),
  ) as Prisma.InputJsonObject;

  beforeAll(async () => {
    running = await start({ with: { rulePacks: loadRulePacks(PACKS, PROFILE) } });
  });
  afterAll(async () => {
    await running.close();
  });
  beforeEach(async () => {
    await reset(db);
  });

  it('validates every checked design whatever the query, and says whether the one asked for derives', async () => {
    const operator = await setupOperator(running);
    const id = await projectWith(operator, KITCHEN);
    const plain = await operator.get(`/api/projects/${id}/validate`);
    expect(plain.body).toMatchObject({ valid: true });
    expect(plain.body).not.toHaveProperty('derives');
    expect((await operator.get(`/api/projects/${id}/validate?design=KS:KB`)).body).toMatchObject({ valid: true, design: { KS: 'KB' }, derives: true });
    expect((await operator.get(`/api/projects/${id}/validate?design=${encodeURIComponent('{"KS":"KA"}')}`)).body).toMatchObject({ derives: true });
    expect((await operator.get(`/api/projects/${id}/validate?design=KS:nope`)).body).toMatchObject({ valid: true, derives: false });
    expect((await operator.get(`/api/projects/${id}/validate?design=KS:KB:KC`)).status).toBe(400);
  });

  it('evaluates the findings of the design asked for, and says which', async () => {
    const operator = await setupOperator(running);
    const id = await projectWith(operator, KITCHEN);
    const res = await operator.get(`/api/projects/${id}/findings?design=KS:KB`);
    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({ design: { KS: 'KB' }, notice: NOTICE });
    // A design Core derives nothing for is FS-RULES-003, and no finding (Rules 1.2.2).
    const none = (await operator.get(`/api/projects/${id}/findings?design=KS:nope`)).body as FindingsBody & { diagnostics: { code: string }[] };
    expect(none.findings).toEqual([]);
    expect(none.diagnostics.map((d) => d.code)).toContain('FS-RULES-003');
  });
});

describe('findings with no rule pack installed', () => {
  let running: Running;

  beforeAll(async () => {
    running = await start();
  });
  afterAll(async () => {
    await running.close();
  });
  beforeEach(async () => {
    await reset(db);
  });

  it('says that none is installed, rather than look clean', async () => {
    const operator = await setupOperator(running);
    const id = await projectWith(operator, HOUSE);
    const res = await operator.get(`/api/projects/${id}/findings`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      head: 'main',
      hash: contentHash(HOUSE),
      findings: [],
      rulePacks: [],
      note: NO_RULE_PACKS,
      // Every findings answer carries the notice, the profile and where the coverage is (FLR-REQ-105, 096).
      notice: NOTICE,
      profile: 'Model Codes (latest)',
      profileId: null,
      coverageUrl: `${running.config.PUBLIC_URL.replace(/\/$/, '')}/rule-packs`,
    });
    expect(res.text).not.toMatch(/\bcomplian|\bcomplies\b|passes code/i);
  });
});
