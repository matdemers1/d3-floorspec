import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { loadRulePacks, NO_PACKS, RulePackError } from '../../src/rules/packs.js';

/** RULE_PACKS_DIR: built rule packs, read and validated once at boot (FLR-T-6.2). */

const EXAMPLE = readFileSync(new URL('../fixtures/rule-packs/example.json', import.meta.url), 'utf8');
const dir = (): string => mkdtempSync(join(tmpdir(), 'flr-packs-'));

describe('installed rule packs', () => {
  it('are none when RULE_PACKS_DIR is unset', () => {
    expect(loadRulePacks(undefined)).toBe(NO_PACKS);
    const env = { PUBLIC_URL: 'http://localhost:3400', DATABASE_URL: 'postgresql://x@localhost/x', KEK: Buffer.alloc(32, 1).toString('base64'), PEPPER: Buffer.alloc(32, 2).toString('base64') };
    expect(loadConfig(env).RULE_PACKS_DIR).toBeUndefined();
    expect(loadConfig({ ...env, RULE_PACKS_DIR: '' }).RULE_PACKS_DIR).toBeUndefined();
    expect(loadConfig({ ...env, RULE_PACKS_DIR: '/srv/packs' }).RULE_PACKS_DIR).toBe('/srv/packs');
  });

  it('reads each *.json file, and each <name>/generated/pack.json of a standard-style rules folder, never its manifest', () => {
    const d = dir();
    writeFileSync(join(d, 'example.json'), EXAMPLE);
    const other = { ...(JSON.parse(EXAMPLE) as Record<string, unknown>), name: 'example-two' };
    mkdirSync(join(d, 'two', 'generated'), { recursive: true });
    writeFileSync(join(d, 'two', 'generated', 'pack.json'), JSON.stringify(other));
    writeFileSync(join(d, 'two', 'pack.json'), '{"this is":"a manifest on disk, not a built pack"}');
    const loaded = loadRulePacks(d);
    expect(loaded.sources).toEqual(['example.json', join('two', 'generated', 'pack.json')]);
    expect(loaded.packs.map((p) => p.name)).toEqual(['example', 'example-two']);
  });

  it('evaluates under a profile file when RULE_PROFILE names one, and refuses one that is not a profile', () => {
    const synthetic = new URL('../fixtures/profiles/synthetic.json', import.meta.url).pathname;
    const d = dir();
    writeFileSync(join(d, 'example.json'), EXAMPLE);
    expect(loadRulePacks(d, synthetic).profile?.name).toBe('Synthetic codes (test)');
    expect(loadRulePacks(d).profile).toBeUndefined();
    const bad = join(dir(), 'profile.json');
    writeFileSync(bad, JSON.stringify({ floorspecRules: '0.1', name: 'Compliant with everything', adopts: [] }));
    expect(() => loadRulePacks(d, bad)).toThrow(/is not a Floorspec Rules 0\.1 profile/);
  });

  it('refuses the boot for a file that is not a pack, a duplicate, or a directory that is not one', () => {
    const notJson = dir();
    writeFileSync(join(notJson, 'bad.json'), '{');
    expect(() => loadRulePacks(notJson)).toThrow(/bad\.json is not JSON/);
    const notPack = dir();
    writeFileSync(join(notPack, 'manifest.json'), '{"floorspecRules":"0.1","name":"x"}');
    expect(() => loadRulePacks(notPack)).toThrow(/manifest\.json is not a Floorspec Rules 0\.1 pack/);
    const twice = dir();
    writeFileSync(join(twice, 'a.json'), EXAMPLE);
    writeFileSync(join(twice, 'b.json'), EXAMPLE);
    expect(() => loadRulePacks(twice)).toThrow(/a\.json and b\.json are both example@/);
    expect(() => loadRulePacks(join(twice, 'missing'))).toThrow(RulePackError);
  });
});
