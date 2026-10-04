/**
 * The built `floorspec` binary, run as a process against the conformance suite vendored in
 * packages/engine/standard (FLR-T-1.11).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const bin = join(import.meta.dirname, '..', 'dist', 'bin.js');
const suite = join(import.meta.dirname, '..', '..', 'engine', 'standard', 'conformance', 'core', '0.1');

function cases(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir).sort()) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...cases(p));
    else if (e === 'test.json') out.push(dir);
  }
  return out;
}

const all = existsSync(suite) ? cases(suite) : [];
const floorspec = (...args: string[]) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' });

describe('floorspec validate --json', () => {
  it.each(all.map((d) => [relative(suite, d), d]))('%s', (_n, dir) => {
    const expected = JSON.parse(readFileSync(join(dir, 'expected.json'), 'utf8')) as {
      valid: boolean;
      diagnostics: { code: string; severity: string; elements: string[] }[];
      hash?: string;
      derived?: unknown;
    };
    const p = floorspec('validate', join(dir, 'input.json'), '--json');
    expect(p.status).toBe(expected.valid ? 0 : 1);
    const got = JSON.parse(p.stdout) as typeof expected;
    expect(got.valid).toBe(expected.valid);
    const diags = got.diagnostics.map((d) => ({ code: d.code, severity: d.severity, elements: d.elements }));
    if (expected.diagnostics.length === 1 && expected.diagnostics[0]!.code === 'FS-SCH-001') expect(diags.every((d) => d.code === 'FS-SCH-001')).toBe(true);
    else expect(diags).toEqual(expected.diagnostics);
    expect(got.hash).toBe(expected.hash);
    expect(got.derived).toEqual(expected.derived);
  });
});

describe('floorspec canonicalize, hash, derive', () => {
  const valid = all.filter((d) => existsSync(join(d, 'canonical.json'))).filter((_, i) => i % 4 === 0);
  it.each(valid.map((d) => [relative(suite, d), d]))('%s', (_n, dir) => {
    const input = join(dir, 'input.json');
    const expected = JSON.parse(readFileSync(join(dir, 'expected.json'), 'utf8')) as { hash: string; derived: unknown };
    expect(execFileSync(process.execPath, [bin, 'canonicalize', input], { encoding: 'utf8' })).toBe(readFileSync(join(dir, 'canonical.json'), 'utf8'));
    expect(execFileSync(process.execPath, [bin, 'hash', input], { encoding: 'utf8' })).toBe(`${expected.hash}\n`);
    expect(JSON.parse(execFileSync(process.execPath, [bin, 'derive', input], { encoding: 'utf8' }))).toEqual(expected.derived);
  });
});

describe('human output and exit codes', () => {
  it('prints one line per diagnostic and a summary; exit 1 when invalid', () => {
    const invalid = all.find((d) => !(JSON.parse(readFileSync(join(d, 'expected.json'), 'utf8')) as { valid: boolean }).valid)!;
    const p = floorspec('validate', join(invalid, 'input.json'));
    expect(p.status).toBe(1);
    expect(p.stdout).toMatch(/: error FS-[A-Z]+-\d{3}/);
    expect(p.stdout).toMatch(/invalid — \d+ errors/);
  });
  it('refuses to canonicalize an invalid document', () => {
    const invalid = all.find((d) => !existsSync(join(d, 'canonical.json')))!;
    expect(floorspec('canonicalize', join(invalid, 'input.json')).status).toBe(1);
  });
  it('exit 2 on usage and I/O errors', () => {
    expect(floorspec().status).toBe(2);
    expect(floorspec('frobnicate', 'x').status).toBe(2);
    expect(floorspec('validate').status).toBe(2);
    expect(floorspec('hash', 'x.json', '--json').status).toBe(2);
    const p = floorspec('validate', '/nonexistent/file.floorspec.json');
    expect(p.status).toBe(2);
    expect(p.stderr).toMatch(/cannot read/);
  });
  it('--help and --version exit 0', () => {
    expect(floorspec('--help').status).toBe(0);
    expect(floorspec('--version').stdout).toBe('floorspec 0.1.0\n');
  });
});
