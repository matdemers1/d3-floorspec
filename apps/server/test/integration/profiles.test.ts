import { readFileSync } from 'node:fs';
import { contentHash } from '@floorspec/engine';
import { NOTICE } from '@floorspec/rules-engine';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Prisma } from '../../src/db.js';
import { loadRulePacks } from '../../src/rules/packs.js';
import { Browser, inviteMember, isStream, reset, setupOperator, start, testDb, tokenFor, type EventStream, type Running } from './helpers.js';

/**
 * FLR-T-6.8 and the server half of FLR-T-6.9: jurisdiction profiles an account builds, the one a
 * project's findings are evaluated under, findings that follow a change of profile (Rules 10.7),
 * and the installed packs' coverage matrix.
 *
 * The packs are test/fixtures/rule-packs (the standard's synthetic example pack, citing only
 * TEST-CODE 2024 and TEST-ELEC 2026, with its published coverage matrix). Under the default
 * profile, "Model Codes (latest)", none of its rules is in force — so nothing is evaluated, and the
 * report says why; under a profile adopting the synthetic editions, its ROOM-SIZE rule finds the
 * small second bedroom of test/fixtures/documents/two-bedrooms.json.
 */

const PACKS = new URL('../fixtures/rule-packs/', import.meta.url).pathname;
const HOUSE = JSON.parse(readFileSync(new URL('../fixtures/documents/two-bedrooms.json', import.meta.url), 'utf8')) as Prisma.InputJsonObject;

const SYNTHETIC = {
  floorspecRules: '0.1',
  name: 'Nowhere County',
  jurisdiction: 'Nowhere County (synthetic codes)',
  adopts: [
    { code: 'TEST-ELEC', edition: '2026', effective: '2026-01-01' },
    { code: 'TEST-CODE', edition: '2024', effective: '2025-07-01' },
  ],
};

interface ProfileRow {
  id: string;
  profile: { name: string; adopts: { code: string; edition: string; effective?: string }[]; amendments?: unknown[] };
  projects: { id: string; name: string }[];
}

interface FindingsBody {
  profile: string;
  profileId: string | null;
  notice: string;
  coverageUrl: string;
  findings: { rule: string; subject: { id: string } }[];
  evaluated: { rule: string }[];
  notEvaluated: { rule: string; reason: string }[];
  coverage: { pack: string; code: string; section: string }[];
}

const db = testDb();

async function projectWith(operator: Browser, document: Prisma.InputJsonObject): Promise<string> {
  const { id } = (await operator.post('/api/projects', { name: 'Two bedrooms' })).body as { id: string };
  const hash = contentHash(document);
  await db.version.upsert({ where: { hash }, create: { hash, document }, update: {} });
  await db.head.update({ where: { projectId_name: { projectId: id, name: 'main' } }, data: { versionHash: hash } });
  return id;
}

describe('jurisdiction profiles', () => {
  let running: Running;
  let operator: Browser;
  const open: EventStream[] = [];

  beforeAll(async () => {
    running = await start({ with: { rulePacks: loadRulePacks(PACKS) } });
  });
  afterAll(async () => {
    await running.close();
  });
  beforeEach(async () => {
    await reset(db);
    operator = await setupOperator(running);
  });
  afterEach(() => {
    for (const s of open.splice(0)) s.close();
  });

  it('defaults to Model Codes (latest), the standard’s default profile (FLR-REQ-099)', async () => {
    const list = (await operator.get('/api/profiles')).body as { default: { id: null; profile: ProfileRow['profile']; source: string }; profiles: unknown[] };
    expect(list.default).toMatchObject({ id: null, source: 'standard', profile: { name: 'Model Codes (latest)' } });
    expect(list.default.profile.adopts.map((a) => `${a.code} ${a.edition}`)).toEqual(['IRC 2024', 'NEC 2026', 'IPC 2024', 'IMC 2024', 'IFGC 2024']);
    expect(list.profiles).toEqual([]);
    const id = await projectWith(operator, HOUSE);
    expect((await operator.get(`/api/projects/${id}/profile`)).body).toMatchObject({ id: null, default: true, profile: { name: 'Model Codes (latest)' } });
  });

  it('builds a profile with editions, effective dates, asOf and cited amendments, stored in canonical form', async () => {
    const profile = {
      ...SYNTHETIC,
      asOf: '2026-03-01',
      amendments: [{ citation: { authority: 'Nowhere County', reference: 'Ord. 2026-2 §1', link: 'https://example.org/ord/2026-2' }, effective: '2026-02-01', withdraws: [{ pack: 'example', rule: 'SMOKE-ALARM' }], note: 'The county keeps its own alarm rule.' }],
    };
    const created = await operator.post('/api/profiles', { profile });
    expect(created.status, created.text).toBe(201);
    const row = created.body as ProfileRow;
    // Canonical: adoptions by domain (building before electrical), then code and date.
    expect(row.profile.adopts.map((a) => a.code)).toEqual(['TEST-CODE', 'TEST-ELEC']);
    expect((await operator.get(`/api/profiles/${row.id}`)).body).toMatchObject({ id: row.id, profile: { asOf: '2026-03-01', amendments: [{ withdraws: [{ pack: 'example', rule: 'SMOKE-ALARM' }] }] } });
    const updated = await operator.request('PUT', `/api/profiles/${row.id}`, { profile: { ...profile, name: 'Nowhere County, 2026' } });
    expect(updated.status, updated.text).toBe(200);
    expect((updated.body as ProfileRow).profile.name).toBe('Nowhere County, 2026');
    const audit = await db.auditLog.findMany({ where: { targetId: row.id }, orderBy: { at: 'asc' } });
    expect(audit.map((a) => a.action)).toEqual(['profile.create', 'profile.update']);
    expect((audit[1]?.detail as { editions: string; file: string }).editions).toBe('TEST-CODE 2024 · TEST-ELEC 2026');
  });

  it('refuses a profile field by field, and one that says a design meets a code', async () => {
    const bad = await operator.post('/api/profiles', {
      profile: { ...SYNTHETIC, adopts: [{ code: 'irc', edition: '2024' }, { code: 'NEC', edition: '2026', effective: '2026-02-30' }], amendments: [{ citation: { authority: 'X', reference: 'Y' }, withdraws: [] }] },
    });
    expect(bad.status).toBe(400);
    const fields = (bad.body as { fields: { path: string }[] }).fields.map((f) => f.path);
    expect(fields).toEqual(expect.arrayContaining(['profile.adopts.0.code', 'profile.adopts.1.effective', 'profile.amendments.0.withdraws']));
    const assuring = await operator.post('/api/profiles', { profile: { ...SYNTHETIC, jurisdiction: 'Where every house is up to code' } });
    expect(assuring.status).toBe(400);
    expect((assuring.body as { fields: { path: string }[] }).fields.map((f) => f.path)).toEqual(['profile.jurisdiction']);
    expect(await db.ruleProfile.count()).toBe(0);
  });

  it('re-evaluates the findings when the project’s profile changes, and tells the live stream (10.7)', async () => {
    const id = await projectWith(operator, HOUSE);
    const before = (await operator.get(`/api/projects/${id}/findings`)).body as FindingsBody;
    expect(before).toMatchObject({ profile: 'Model Codes (latest)', profileId: null, notice: NOTICE, findings: [], evaluated: [] });
    // Nothing of the synthetic pack is in force under the model codes: not evaluated, and why (a
    // rule on a measure this build defers is listed as deferred before its edition is looked at).
    expect(before.notEvaluated.find((r) => r.rule === 'ROOM-SIZE')?.reason).toBe('edition');
    expect(before.notEvaluated.every((r) => r.reason === 'edition' || r.reason === 'deferred')).toBe(true);
    expect(before.coverageUrl).toMatch(/\/rule-packs$/);

    const stream = await operator.events(`/api/projects/${id}/events`);
    if (!isStream(stream)) throw new Error(stream.text);
    open.push(stream);
    await stream.next('ready');

    const { id: profileId } = (await operator.post('/api/profiles', { profile: SYNTHETIC })).body as ProfileRow;
    const chosen = await operator.request('PUT', `/api/projects/${id}/profile`, { profileId });
    expect(chosen.status, chosen.text).toBe(200);
    expect((await stream.next('profile')).data).toEqual({ id: profileId, name: 'Nowhere County', change: 'chosen' });

    const after = (await operator.get(`/api/projects/${id}/findings`)).body as FindingsBody;
    expect(after).toMatchObject({ profile: 'Nowhere County', profileId, notice: NOTICE });
    expect(after.findings.filter((f) => f.rule === 'ROOM-SIZE').map((f) => f.subject.id)).toEqual(['R3']);
    expect(after.coverage.map((c) => `${c.code} ${c.section}`)).toEqual(expect.arrayContaining(['TEST-CODE §1', 'TEST-ELEC §3']));

    // An amendment that withdraws the rule takes its finding away — and the stream says the profile changed.
    const withdrawn = await operator.request('PUT', `/api/profiles/${profileId}`, {
      profile: { ...SYNTHETIC, amendments: [{ citation: { authority: 'Nowhere County', reference: 'Ord. 1' }, withdraws: [{ pack: 'example', rule: 'ROOM-SIZE' }] }] },
    });
    expect(withdrawn.status, withdrawn.text).toBe(200);
    expect((await stream.next('profile')).data).toMatchObject({ id: profileId, change: 'edited' });
    const amended = (await operator.get(`/api/projects/${id}/findings`)).body as FindingsBody;
    expect(amended.findings.some((f) => f.rule === 'ROOM-SIZE')).toBe(false);
    expect(amended.notEvaluated).toContainEqual(expect.objectContaining({ rule: 'ROOM-SIZE', reason: 'withdrawn' }));

    // Deleting the profile puts the project back on the default.
    expect((await operator.request('DELETE', `/api/profiles/${profileId}`)).status).toBe(204);
    expect((await stream.next('profile')).data).toEqual({ id: null, name: 'Model Codes (latest)', change: 'deleted' });
    expect(((await operator.get(`/api/projects/${id}/findings`)).body as FindingsBody).profileId).toBeNull();
    expect((await db.project.findUniqueOrThrow({ where: { id } })).ruleProfileId).toBeNull();
  });

  it('lists each profile with the projects that use it', async () => {
    const id = await projectWith(operator, HOUSE);
    const { id: profileId } = (await operator.post('/api/profiles', { profile: SYNTHETIC })).body as ProfileRow;
    await operator.request('PUT', `/api/projects/${id}/profile`, { profileId });
    const list = (await operator.get('/api/profiles')).body as { default: { projects: unknown[] }; profiles: ProfileRow[] };
    expect(list.profiles.map((p) => [p.profile.name, p.projects.map((x) => x.name)])).toEqual([['Nowhere County', ['Two bedrooms']]]);
    expect(list.default.projects).toEqual([]);
  });

  it('keeps every profile to its account: another account’s is a 404, and cannot be chosen', async () => {
    const { id: profileId } = (await operator.post('/api/profiles', { profile: SYNTHETIC })).body as ProfileRow;
    const bob = await inviteMember(running, operator, 'bob@example.test');
    for (const [method, body] of [['GET', undefined], ['PUT', { profile: SYNTHETIC }], ['DELETE', undefined]] as const) {
      const res = await bob.request(method, `/api/profiles/${profileId}`, body);
      expect(res.status, `${method} as B`).toBe(404);
      expect(res.body).toEqual({ error: 'profile not found' });
    }
    expect(((await bob.get('/api/profiles')).body as { profiles: unknown[] }).profiles).toEqual([]);
    const bobs = ((await bob.post('/api/projects', { name: "Bob's house" })).body as { id: string }).id;
    const stolen = await bob.request('PUT', `/api/projects/${bobs}/profile`, { profileId });
    expect(stolen.status).toBe(400);
    expect(await db.ruleProfile.count()).toBe(1);
    expect((await db.ruleProfile.findFirstOrThrow()).profile).toMatchObject({ name: 'Nowhere County' });
  });

  it('lets a read token see the project’s profile, never choose one', async () => {
    const id = await projectWith(operator, HOUSE);
    const token = Browser.bearer(running.url, await tokenFor(operator, id, 'write'));
    expect((await token.get(`/api/projects/${id}/profile`)).status).toBe(200);
    expect((await token.request('PUT', `/api/projects/${id}/profile`, { profileId: null })).status).toBe(403);
    expect((await token.post('/api/profiles', { profile: SYNTHETIC })).status).toBe(403);
    expect(await db.ruleProfile.count()).toBe(0);
  });
});

describe('the installed rule packs’ coverage', () => {
  let running: Running;

  afterEach(async () => {
    await running.close();
  });

  it('serves each pack with its coverage matrix, last-verified dates and reviewed badges (FLR-REQ-096)', async () => {
    running = await start({ with: { rulePacks: loadRulePacks(PACKS) } });
    await reset(db);
    const operator = await setupOperator(running);
    const res = await operator.get('/api/rule-packs');
    expect(res.status).toBe(200);
    const body = res.body as { notice: string; installed: number; packs: { name: string; coverage: string; license: string }[]; matrix: { rows: { section: string; status: string; oldestVerification: string | null }[]; rules: { rule: string; review: string; verifiedOn: string }[] } };
    expect(body).toMatchObject({ notice: NOTICE, installed: 1, packs: [{ name: 'example', coverage: 'published', license: 'CC-BY-4.0' }] });
    expect(body.matrix.rows.find((r) => r.section === '§1')).toMatchObject({ status: 'covered', oldestVerification: '2026-10-05' });
    expect(body.matrix.rules.find((r) => r.rule === 'ROOM-SIZE')).toMatchObject({ review: 'reviewed', verifiedOn: '2026-10-05' });
  });

  it('is empty, and says nothing was checked, with no pack installed', async () => {
    running = await start();
    await reset(db);
    const operator = await setupOperator(running);
    const body = (await operator.get('/api/rule-packs')).body as { installed: number; packs: unknown[]; matrix: { rows: unknown[] }; notice: string };
    expect(body).toMatchObject({ installed: 0, packs: [], matrix: { rows: [] }, notice: NOTICE });
    expect((await new Browser(running.url).get('/api/rule-packs')).status).toBe(401);
  });
});
