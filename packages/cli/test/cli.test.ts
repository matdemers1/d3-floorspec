/**
 * The built `floorspec` binary, run as a process against the conformance suite vendored in
 * packages/engine/standard (FLR-T-1.11).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const bin = join(import.meta.dirname, '..', 'dist', 'bin.js');
const suites = join(import.meta.dirname, '..', '..', 'engine', 'standard', 'conformance', 'core');
const suite = join(suites, '0.3');
const suite02 = join(suites, '0.2');
const suite01 = join(suites, '0.1');

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
// The published Core 0.2 and 0.1 suites, read as a reader of that draft: a sample, since the
// engine's own conformance test runs every case of every suite in process.
const all02 = existsSync(suite02) ? cases(suite02).filter((_, i) => i % 4 === 0) : [];
const all01 = existsSync(suite01) ? cases(suite01).filter((_, i) => i % 4 === 0) : [];
const floorspec = (...args: string[]) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' });
/** A case's registry.json, when it has one, as --registry. */
const registryArgs = (dir: string): string[] => [
  ...(existsSync(join(dir, 'registry.json')) ? ['--registry', join(dir, 'registry.json')] : []),
  // Core 0.3: the design to derive (19.6), and a package validator's files (18.4).
  ...(existsSync(join(dir, 'design.json')) ? ['--design', join(dir, 'design.json')] : []),
  ...(existsSync(join(dir, 'package')) ? ['--package', join(dir, 'package')] : []),
];

describe.each([
  ['Core 0.3', suite, all, [] as string[]],
  ['Core 0.2, --core 0.2', suite02, all02, ['--core', '0.2']],
  ['Core 0.1, --core 0.1', suite01, all01, ['--core', '0.1']],
] as const)('floorspec validate --json (%s)', (_s, root, list, extra) => {
  it.each(list.map((d) => [relative(root, d), d]))('%s', (_n, dir) => {
    const expected = JSON.parse(readFileSync(join(dir, 'expected.json'), 'utf8')) as {
      valid: boolean;
      diagnostics: { code: string; severity: string; elements: string[]; design?: string }[];
      hash?: string;
      derived?: unknown;
    };
    const p = floorspec('validate', join(dir, 'input.json'), '--json', ...extra, ...registryArgs(dir));
    expect(p.status).toBe(expected.valid ? 0 : 1);
    const got = JSON.parse(p.stdout) as typeof expected;
    expect(got.valid).toBe(expected.valid);
    const diags = got.diagnostics.map((d) => ({ code: d.code, severity: d.severity, elements: d.elements, ...(d.design !== undefined && { design: d.design }) }));
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
    const expected = JSON.parse(readFileSync(join(dir, 'expected.json'), 'utf8')) as { hash: string; derived?: unknown };
    expect(execFileSync(process.execPath, [bin, 'canonicalize', input], { encoding: 'utf8' })).toBe(readFileSync(join(dir, 'canonical.json'), 'utf8'));
    expect(execFileSync(process.execPath, [bin, 'hash', input], { encoding: 'utf8' })).toBe(`${expected.hash}\n`);
    const derived = floorspec('derive', input, ...registryArgs(dir));
    // A design Core derives nothing for (19.6.2): exit 1, nothing printed.
    if (expected.derived === undefined) expect(derived.status).toBe(1);
    else expect(JSON.parse(derived.stdout)).toEqual(expected.derived);
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
    expect(floorspec('validate', 'x.json', '--core', '0.4').status).toBe(2);
    expect(floorspec('validate', 'x.json', '--registry').status).toBe(2);
    const p = floorspec('validate', '/nonexistent/file.floorspec.json');
    expect(p.status).toBe(2);
    expect(p.stderr).toMatch(/cannot read/);
  });
  it('--help and --version exit 0', () => {
    expect(floorspec('--help').status).toBe(0);
    expect(floorspec('--version').stdout).toBe('floorspec 0.3.0\n');
  });
  it('--registry is read as the known extensions; a bad one is FS-CFG-001', () => {
    const dir = join(suite, 'extensions', '047-registry-cycle');
    const p = floorspec('validate', join(dir, 'input.json'), '--registry', join(dir, 'registry.json'));
    expect(p.status).toBe(1);
    expect(p.stdout).toMatch(/error FS-CFG-001/);
    expect(floorspec('validate', join(dir, 'input.json'), '--registry', '/nonexistent/registry.json').status).toBe(2);
  });
  it('derive prints the Core 0.2 and 0.3 members', () => {
    const out = JSON.parse(execFileSync(process.execPath, [bin, 'derive', join(suite, 'program', '001-house-brief', 'input.json')], { encoding: 'utf8' })) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(['walls', 'junctionFills', 'rooms', 'unanchored', 'openings', 'program', 'fallbacks', 'placements', 'clearances', 'clearanceOverlaps', 'circulation', 'floors', 'ceilings', 'slabs', 'roofs', 'stairs', 'finishes']);
  });
});

describe('floorspec --extensions', () => {
  const ext = join(import.meta.dirname, '..', '..', 'engine', 'standard', 'conformance', 'ext');
  const demo = join(ext, 'FS_electrical', '0.1.0', 'examples', '001-p5-demo-house');

  it('evaluates an official extension for a document that uses it, with its entry known', () => {
    const expected = JSON.parse(readFileSync(join(demo, 'expected.json'), 'utf8')) as { derived: unknown };
    // The demo house declares "0.2": its suite reads it as a Core 0.2 reader (conformance/README.md).
    const p = floorspec('validate', join(demo, 'input.json'), '--json', '--core', '0.2', '--extensions', 'FS_electrical', '--registry', join(demo, 'registry.json'));
    expect(p.status).toBe(0);
    expect((JSON.parse(p.stdout) as { derived: unknown }).derived).toEqual(expected.derived);
  });

  it('"official" implements and knows all four', () => {
    const p = floorspec('derive', join(demo, 'input.json'), '--extensions', 'official');
    expect(p.status).toBe(0);
    expect(Object.keys((JSON.parse(p.stdout) as { extensions: object }).extensions).sort()).toEqual(['FS_electrical', 'FS_lowvoltage', 'FS_mechanical', 'FS_plumbing']);
  });

  it('reports an extension invariant like any other diagnostic', () => {
    const dir = join(ext, 'FS_electrical', '0.1.0', 'invariants', '011-240-volt-charger-on-a-120-volt-circuit');
    const p = floorspec('validate', join(dir, 'input.json'), '--extensions', 'official');
    expect(p.status).toBe(1);
    expect(p.stdout).toContain('error FS-ELEC-INV-006 [C5, X24]');
  });

  it('refuses an extension it does not implement', () => {
    expect(floorspec('validate', join(demo, 'input.json'), '--extensions', 'FS_nonesuch').status).toBe(2);
  });
});
