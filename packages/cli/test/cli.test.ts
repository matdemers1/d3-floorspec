/**
 * The built `floorspec` binary, run as a process against the conformance suite vendored in
 * packages/engine/standard (FLR-T-1.11).
 */
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const bin = join(import.meta.dirname, '..', 'dist', 'bin.js');
const suites = join(import.meta.dirname, '..', '..', 'engine', 'standard', 'conformance', 'core');
const suite = join(suites, '0.4');
const suite03 = join(suites, '0.3');
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
// The published Core 0.3, 0.2 and 0.1 suites, read as a reader of that draft: a sample, since the
// engine's own conformance test runs every case of every suite in process.
const all03 = existsSync(suite03) ? cases(suite03).filter((_, i) => i % 4 === 0) : [];
const all02 = existsSync(suite02) ? cases(suite02).filter((_, i) => i % 4 === 0) : [];
const all01 = existsSync(suite01) ? cases(suite01).filter((_, i) => i % 4 === 0) : [];
const floorspec = (...args: string[]) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' });
/**
 * The same, without blocking. Each per-case test below is a process of its own, well over a thousand
 * of them, so they run concurrently (FLR-T-12.47): one after another, their start-ups alone took
 * minutes on a two-core runner.
 */
const floorspecAsync = (...args: string[]) =>
  new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    execFile(process.execPath, [bin, ...args], { encoding: 'utf8', maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      // A non-zero exit is an answer, not an error: its code is the exit status. Anything else
      // (the process could not start, was killed, overflowed the buffer) fails the test.
      if (err && typeof err.code !== 'number') reject(new Error(`floorspec ${args.join(' ')}: ${err.message}`, { cause: err }));
      else resolve({ status: err ? (err.code as number) : 0, stdout, stderr });
    });
  });
/** A case's registry.json, when it has one, as --registry. */
const registryArgs = (dir: string): string[] => [
  ...(existsSync(join(dir, 'registry.json')) ? ['--registry', join(dir, 'registry.json')] : []),
  // Core 0.3: the design to derive (19.6), and a package validator's files (18.4).
  ...(existsSync(join(dir, 'design.json')) ? ['--design', join(dir, 'design.json')] : []),
  ...(existsSync(join(dir, 'package')) ? ['--package', join(dir, 'package')] : []),
];

describe.each([
  ['Core 0.4', suite, all, [] as string[]],
  ['Core 0.3, --core 0.3', suite03, all03, ['--core', '0.3']],
  ['Core 0.2, --core 0.2', suite02, all02, ['--core', '0.2']],
  ['Core 0.1, --core 0.1', suite01, all01, ['--core', '0.1']],
] as const)('floorspec validate --json (%s)', (_s, root, list, extra) => {
  it.concurrent.for(list.map((d) => [relative(root, d), d] as const))('%s', async ([_n, dir], { expect }) => {
    const expected = JSON.parse(readFileSync(join(dir, 'expected.json'), 'utf8')) as {
      valid: boolean;
      diagnostics: { code: string; severity: string; elements: string[]; design?: string }[];
      hash?: string;
      derived?: unknown;
    };
    const p = await floorspecAsync('validate', join(dir, 'input.json'), '--json', ...extra, ...registryArgs(dir));
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
  it.concurrent.for(valid.map((d) => [relative(suite, d), d] as const))('%s', async ([_n, dir], { expect }) => {
    const input = join(dir, 'input.json');
    const expected = JSON.parse(readFileSync(join(dir, 'expected.json'), 'utf8')) as { hash: string; derived?: unknown };
    const [canonical, hash, derived] = await Promise.all([floorspecAsync('canonicalize', input), floorspecAsync('hash', input), floorspecAsync('derive', input, ...registryArgs(dir))]);
    expect(canonical.status).toBe(0);
    expect(canonical.stdout).toBe(readFileSync(join(dir, 'canonical.json'), 'utf8'));
    expect(hash.status).toBe(0);
    expect(hash.stdout).toBe(`${expected.hash}\n`);
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
    expect(floorspec('--version').stdout).toBe('floorspec 0.4.0\n');
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

describe('floorspec migrate', () => {
  // The migration suite (Core 0.4, chapter 20), vendored in packages/migrate/standard.
  const msuite = join(import.meta.dirname, '..', '..', 'migrate', 'standard', 'conformance', 'migration', '0.4');
  const mcases = existsSync(msuite) ? cases(msuite) : [];

  it('has the migration suite', () => {
    expect(mcases.length).toBeGreaterThan(20);
  });

  it.concurrent.for(mcases.map((d) => [relative(msuite, d), d] as const))('%s', async ([_name, dir], { expect }) => {
    const { to } = JSON.parse(readFileSync(join(dir, 'request.json'), 'utf8')) as { to: unknown };
    // A target that is not a string cannot be given on a command line, where every argument is one.
    if (typeof to !== 'string') return;
    const expected = JSON.parse(readFileSync(join(dir, 'expected.json'), 'utf8')) as { status: string; diagnostics: { code: string }[] };
    const p = await floorspecAsync('migrate', join(dir, 'input.json'), '--to', to);
    if (expected.status === 'migrated') {
      expect(p.status).toBe(0);
      expect(p.stdout).toBe(readFileSync(join(dir, 'output.json'), 'utf8'));
    } else {
      expect(p.status).toBe(1);
      expect(p.stdout).toBe('');
      for (const d of expected.diagnostics) expect(p.stderr).toContain(d.code);
    }
  });

  it('takes no option but --to: nothing else decides a migration (Core 20.1)', () => {
    const doc = join(msuite, 'step-0.1-0.2', '001-version-only', 'input.json');
    expect(floorspec('migrate', doc, '--core', '0.2').status).toBe(2);
    expect(floorspec('validate', doc, '--to', '0.3').status).toBe(2);
    expect(floorspec('migrate', doc).stdout).toContain('"floorspec": "0.4"');
  });
});
