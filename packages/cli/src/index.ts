/**
 * The floorspec command line (FLR-T-1.11): validate, canonicalize, hash and derive Floorspec Core
 * documents with @floorspec/engine. The CLI may use Node; the engine may not.
 */
import { readFileSync } from 'node:fs';
import { CATALOGUE, OFFICIAL_EXTENSIONS, OFFICIAL_EXTENSION_NAMES, check, type Diagnostic, type ValidateOptions } from '@floorspec/engine';

export const PACKAGE_NAME = '@floorspec/cli';
export const VERSION = '0.3.0';

export const USAGE = `usage: floorspec <command> <file> [options]

commands:
  validate <file> [--json]   report diagnostics; exit 0 when valid, 1 when not
  canonicalize <file>        print the canonical form (9.2)
  hash <file>                print the content hash (9.3)
  derive <file>              print everything derived as JSON: walls, fills, rooms, openings, and
                             (Core 0.2) the program, fallbacks, placements, clearances, overlaps
                             and circulation, and (Core 0.3) each opening's declared clear opening
                             and every room's floor and ceiling and every slab

options:
  --registry <file>          the known extensions (Core 0.2, 12.2): a JSON array of registry
                             entries; FS-CFG-001 when they are not a valid registry
  --core 0.1|0.2|0.3         the newest Core draft to read as (default 0.3, which reads 0.2 and 0.1 too)
  --extensions <names>       the extensions to read as implementing, comma-separated: any of
                             FS_electrical, FS_plumbing, FS_mechanical, FS_lowvoltage, each
                             evaluated for a document that uses it at a version the validator
                             knows (--registry); or "official": all four, knowing their registry
                             entries unless --registry is given
  --json                     validate: print the conformance-shaped result

exit status: 0 valid, 1 invalid, 2 usage or I/O error
`;

export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
  read: (path: string) => Uint8Array;
}

const nodeIo: Io = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
  read: (p) => new Uint8Array(readFileSync(p === '-' ? 0 : p)),
};

/** One diagnostic as a line: `<file>: <severity> <code> [<elements>] <message> (<where>)`. */
export function formatDiagnostic(file: string, d: Diagnostic): string {
  const where = [d.location.pointer, d.location.level && `level ${d.location.level}`, d.location.point && `at [${d.location.point.join(', ')}]`].filter(Boolean).join(', ');
  const els = d.elements.length ? ` [${d.elements.join(', ')}]` : '';
  return `${file}: ${d.severity} ${d.code}${els} ${d.message}${where ? ` (${where})` : ''}\n`;
}

/** Options that take a value. */
const VALUED = new Set(['--registry', '--core', '--extensions']);

export function run(argv: readonly string[], io: Io = nodeIo): number {
  const args: string[] = [];
  const flags = new Set<string>();
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (!a.startsWith('--')) args.push(a);
    else if (VALUED.has(a)) {
      const v = argv[i + 1];
      if (v === undefined || values.has(a)) {
        io.err(USAGE);
        return 2;
      }
      values.set(a, v);
      i++;
    } else flags.add(a);
  }
  if (flags.has('--version')) {
    io.out(`floorspec ${VERSION}\n`);
    return 0;
  }
  if (flags.has('--help')) {
    io.out(USAGE);
    return 0;
  }
  const [command, file, ...rest] = args;
  const known = ['validate', 'canonicalize', 'hash', 'derive'];
  const unknownFlags = [...flags].filter((f) => f !== '--json');
  if (!command || !known.includes(command) || !file || rest.length || unknownFlags.length || (flags.has('--json') && command !== 'validate')) {
    io.err(USAGE);
    return 2;
  }
  let bytes: Uint8Array;
  try {
    bytes = io.read(file);
  } catch (e) {
    io.err(`floorspec: cannot read ${file}: ${(e as Error).message}\n`);
    return 2;
  }
  const core = values.get('--core');
  if (core !== undefined && core !== '0.1' && core !== '0.2' && core !== '0.3') {
    io.err(USAGE);
    return 2;
  }
  const options: { -readonly [K in keyof ValidateOptions]: ValidateOptions[K] } = {};
  if (core !== undefined) options.core = core;
  const registry = values.get('--registry');
  if (registry !== undefined) {
    try {
      options.knownExtensions = io.read(registry);
    } catch (e) {
      io.err(`floorspec: cannot read ${registry}: ${(e as Error).message}\n`);
      return 2;
    }
  }
  const exts = values.get('--extensions');
  if (exts !== undefined) {
    const names = exts === 'official' ? [...OFFICIAL_EXTENSION_NAMES] : exts.split(',');
    if (names.some((n) => !OFFICIAL_EXTENSION_NAMES.includes(n))) {
      io.err(USAGE);
      return 2;
    }
    options.extensions = names;
    if (exts === 'official' && options.knownExtensions === undefined) options.knownExtensions = OFFICIAL_EXTENSIONS;
  }
  const r = check(bytes, options);

  if (command === 'validate') {
    if (flags.has('--json')) {
      // The conformance-shaped result (conformance/README.md): valid, diagnostics, hash, derived.
      const shaped = { valid: r.valid, diagnostics: r.diagnostics, hash: r.hash, derived: r.derived };
      io.out(JSON.stringify(shaped, null, 2) + '\n');
    } else {
      for (const d of r.diagnostics) io.out(formatDiagnostic(file, d));
      const count = (s: string) => r.diagnostics.filter((d) => d.severity === s).length;
      io.out(`${file}: ${r.valid ? 'valid' : 'invalid'} — ${count('error')} errors, ${count('warning')} warnings, ${count('info')} info\n`);
    }
    return r.valid ? 0 : 1;
  }
  if (!r.valid) {
    for (const d of r.diagnostics.filter((x) => x.severity === 'error')) io.err(formatDiagnostic(file, d));
    io.err(`${file}: invalid; nothing to ${command}\n`);
    return 1;
  }
  if (command === 'canonicalize') io.out(r.canonical ?? '');
  else if (command === 'hash') io.out(`${r.hash ?? ''}\n`);
  else io.out(JSON.stringify(r.derived, null, 2) + '\n');
  return 0;
}

/** The catalogue size, re-exported so the CLI's tests can check they run against the same engine. */
export const CATALOGUE_SIZE = CATALOGUE.length;
