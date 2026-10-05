/**
 * The floorspec command line (FLR-T-1.11): validate, canonicalize, hash and derive Floorspec Core
 * documents with @floorspec/engine. The CLI may use Node; the engine may not.
 */
import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve, sep } from 'node:path';
import { CATALOGUE, CORE_VERSION, OFFICIAL_EXTENSIONS, OFFICIAL_EXTENSION_NAMES, Package, check, type Diagnostic, type ValidateOptions } from '@floorspec/engine';
import { RECORD, migrate } from '@floorspec/migrate';
import {
  DEFAULT_LIMITS,
  DOCUMENT_NAME,
  PackageError,
  isZip,
  packageEntries,
  packageZip,
  packagedAssets,
  parseDocument,
  pathProblem,
  readPackage as openPackageFile,
} from '@floorspec/package';

export const PACKAGE_NAME = '@floorspec/cli';
export const VERSION = '0.3.0';

export const USAGE = `usage: floorspec <command> <file> [options]

<file> is a document (.floorspec.json) or a package (.floorspec, a ZIP: model.json and its assets),
which is read as a package validator would (Core 18.4).

commands:
  validate <file> [--json]   report diagnostics; exit 0 when valid, 1 when not
  canonicalize <file>        print the canonical form (9.2)
  hash <file>                print the content hash (9.3)
  derive <file>              print everything derived as JSON: walls, fills, rooms, openings, and
                             (Core 0.2) the program, fallbacks, placements, clearances, overlaps
                             and circulation, and (Core 0.3) each opening's declared clear opening
                             and every room's floor and ceiling, every slab, roof and stair,
                             the finishes of rooms and walls, and a document's design options
  package <file> -o <out>    write the .floorspec package of a document: model.json and each asset
                             located by path, read from --assets (default: the document's folder);
                             refused, and nothing written, unless it is a valid package
  unpack <file> -o <dir>     write a .floorspec package as its folder — model.json and its assets,
                             byte for byte the archive's — into a new or empty <dir>
  migrate <file> [--to 0.3]  print the document migrated to a later Core draft (Core 20): it
                             declares the target, and what that draft reads differently - 0.1's
                             opaque extension collections, a 0.2 extension element's own option -
                             is moved into extras["floorspec:migration"]; refused (exit 1) when the
                             document cannot be read or the target is earlier or unknown

options:
  --registry <file>          the known extensions (Core 0.2, 12.2): a JSON array of registry
                             entries; FS-CFG-001 when they are not a valid registry
  --core 0.1|0.2|0.3         the newest Core draft to read as (default 0.3, which reads 0.2 and 0.1 too)
  --extensions <names>       the extensions to read as implementing, comma-separated: any of
                             FS_electrical, FS_plumbing, FS_mechanical, FS_lowvoltage, FS_furniture,
                             FS_structural, each
                             evaluated for a document that uses it at a version the validator
                             knows (--registry); or "official": all six, knowing their registry
                             entries unless --registry is given
  --design <json|file>       (Core 0.3, 19.6) the design to derive: a JSON object of option set →
                             option, given inline or as a file; default the primary design
  --package <dir>            (Core 0.3, 18.4) validate as a package validator, given the files
                             under <dir>: each asset located by path is checked against its file
  --assets <dir>             package: the folder the document's asset paths are relative to
  -o, --out <path>           package: the archive to write; unpack: the folder to write
  --json                     validate: print the conformance-shaped result
  --to 0.1|0.2|0.3           migrate: the target draft (default 0.3); no other option applies

exit status: 0 valid (migrate: migrated), 1 invalid (migrate: refused), 2 usage or I/O error
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

/** A package's document and files, from a .floorspec archive's bytes. */
function fromArchive(bytes: Uint8Array): { document: Uint8Array; package: Package } {
  const opened = openPackageFile(bytes, DEFAULT_LIMITS);
  return { document: opened.document, package: new Package(opened.files) };
}

/** One diagnostic as a line: `<file>: <severity> <code> [<elements>] <message> (<where>)`. */
export function formatDiagnostic(file: string, d: Diagnostic): string {
  const where = [d.location.pointer, d.location.level && `level ${d.location.level}`, d.location.point && `at [${d.location.point.join(', ')}]`].filter(Boolean).join(', ');
  const els = d.elements.length ? ` [${d.elements.join(', ')}]` : '';
  return `${file}: ${d.severity} ${d.code}${els} ${d.message}${where ? ` (${where})` : ''}\n`;
}

/** Options that take a value. */
const VALUED = new Set(['--registry', '--core', '--extensions', '--design', '--package', '--assets', '--out', '-o', '--to']);

export function run(argv: readonly string[], io: Io = nodeIo): number {
  const args: string[] = [];
  const flags = new Set<string>();
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const given = argv[i] ?? '';
    const a = given === '-o' ? '--out' : given;
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
  const known = ['validate', 'canonicalize', 'hash', 'derive', 'package', 'unpack', 'migrate'];
  const unknownFlags = [...flags].filter((f) => f !== '--json');
  const packing = command === 'package' || command === 'unpack';
  if (
    !command ||
    !known.includes(command) ||
    !file ||
    rest.length ||
    unknownFlags.length ||
    (flags.has('--json') && command !== 'validate') ||
    packing !== values.has('--out') ||
    (values.has('--assets') && command !== 'package') ||
    // A migration depends on the document and the target alone (Core 20.1): --to and nothing else.
    (values.has('--to') && command !== 'migrate') ||
    (command === 'migrate' && [...values.keys()].some((k) => k !== '--to'))
  ) {
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
  if (command === 'unpack') return unpack(file, bytes, values.get('--out') ?? '', io);
  // A .floorspec archive: its document, validated as a package validator would (Core 18.4).
  let archived: Package | undefined;
  if (isZip(bytes) && command !== 'package') {
    try {
      ({ document: bytes, package: archived } = fromArchive(bytes));
    } catch (e) {
      if (!(e instanceof PackageError)) throw e;
      io.err(`floorspec: ${file} is not a package that can be read: ${e.message}\n`);
      return 1;
    }
  }
  if (command === 'migrate') return migrateFile(file, bytes, values.get('--to') ?? CORE_VERSION, io);
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
  const design = values.get('--design');
  if (design !== undefined) {
    try {
      options.design = JSON.parse(design.trim().startsWith('{') ? design : new TextDecoder().decode(io.read(design))) as unknown;
    } catch (e) {
      io.err(`floorspec: cannot read the design ${design}: ${(e as Error).message}\n`);
      return 2;
    }
  }
  const pkg = values.get('--package');
  if (pkg !== undefined) {
    try {
      options.package = readPackage(pkg);
    } catch (e) {
      io.err(`floorspec: cannot read the package ${pkg}: ${(e as Error).message}\n`);
      return 2;
    }
  } else if (archived !== undefined) options.package = archived;
  if (command === 'package') return writePackage(file, bytes, values.get('--assets') ?? dirname(file), values.get('--out') ?? '', options, io);
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
  else if (r.derived === undefined) {
    io.err(`${file}: nothing is derived for this design: it is not one of the document's, or its view is not valid (Core 19.6.2)\n`);
    return 1;
  } else io.out(JSON.stringify(r.derived, null, 2) + '\n');
  return 0;
}

/**
 * `floorspec migrate <file> --to <draft>` (Core 0.3, chapter 20): the migration on standard output,
 * written as 20.1.1 says, or the diagnostics that refuse it on standard error.
 */
function migrateFile(file: string, bytes: Uint8Array, to: string, io: Io): number {
  const r = migrate(bytes, to);
  if (r.status === 'refused') {
    for (const d of r.diagnostics) io.err(formatDiagnostic(file, d));
    io.err(`${file}: not migrated to ${to}\n`);
    return 1;
  }
  io.out(r.text);
  for (const rec of r.records)
    io.err(`${file}: from ${rec.from} to ${rec.to}, moved into extras["${RECORD}"]: ${rec.moved.map((m) => m.pointer).join(', ')}\n`);
  return 0;
}

/**
 * A package (Core 0.3, 18.4): every file under `dir`, by its path relative to it with `/` between
 * names, as the directory lists them — so a path names one file, case and all, even where the file
 * system folds case.
 */
export function readPackage(dir: string): Package {
  const files = new Map<string, Uint8Array>();
  const walk = (d: string, prefix: string): void => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      // A package holds files: a symbolic link could name anything on the machine (FLR-T-9.1).
      const st = lstatSync(p);
      if (st.isSymbolicLink()) throw new Error(`${prefix}${name} is a symbolic link; a package holds files only`);
      if (st.isDirectory()) walk(p, `${prefix}${name}/`);
      else if (st.isFile()) files.set(`${prefix}${name}`, new Uint8Array(readFileSync(p)));
    }
  };
  walk(dir, '');
  return new Package(files);
}

const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

/**
 * `floorspec package`: the document and the files its assets locate by path, read from `assetsDir`
 * (never through a symbolic link, never outside it: every path is a safe one, Core 8.6.2), checked
 * as a package validator, and written as one deterministic .floorspec archive (packages/package).
 */
function writePackage(file: string, document: Uint8Array, assetsDir: string, out: string, options: ValidateOptions, io: Io): number {
  const files = new Map<string, Uint8Array>();
  for (const a of packagedAssets(parseDocument(document))) {
    if (files.has(a.path)) continue;
    const p = join(assetsDir, ...a.path.split('/'));
    try {
      if (lstatSync(p).isFile()) files.set(a.path, new Uint8Array(readFileSync(p)));
    } catch {
      // Missing: the package validator below says which (FS-INV-1005).
    }
  }
  const r = check(document, { ...options, package: new Package(files) });
  if (!r.valid) {
    for (const d of r.diagnostics.filter((x) => x.severity === 'error')) io.err(formatDiagnostic(file, d));
    io.err(`${file}: not a valid package; nothing written\n`);
    return 1;
  }
  const built = packageEntries(document, new Map([...files.values()].map((b) => [sha256(b), b])));
  const zip = packageZip(built);
  try {
    writeFileSync(out, zip);
  } catch (e) {
    io.err(`floorspec: cannot write ${out}: ${(e as Error).message}\n`);
    return 2;
  }
  io.out(`${out}: ${DOCUMENT_NAME} and ${String(built.entries.length - 1)} asset file${built.entries.length === 2 ? '' : 's'}, ${String(zip.length)} bytes, sha256 ${sha256(zip)}\n`);
  return 0;
}

/**
 * `floorspec unpack`: a .floorspec archive as its folder — model.json and every file its assets
 * name, byte for byte — into `out`, which must be new or empty. The archive is read with every
 * check (zip-slip, links, sizes: packages/package); each path is checked again against `out`
 * before a byte is written, and no file is overwritten (a case-folding file system included).
 */
function unpack(file: string, bytes: Uint8Array, out: string, io: Io): number {
  let opened;
  try {
    opened = openPackageFile(bytes, DEFAULT_LIMITS);
  } catch (e) {
    if (!(e instanceof PackageError)) throw e;
    io.err(`floorspec: ${file} is not a package that can be read: ${e.message}\n`);
    return 1;
  }
  const root = resolve(out);
  let existing: string[] = [];
  try {
    existing = readdirSync(root);
  } catch {
    // Absent: made below.
  }
  if (existing.length > 0) {
    io.err(`floorspec: ${out} is not empty; unpack into a new or empty folder\n`);
    return 2;
  }
  const files: [string, Uint8Array][] = [[DOCUMENT_NAME, opened.document], ...opened.files];
  const folded = new Set<string>();
  for (const [path] of files) {
    const target = resolve(root, ...path.split('/'));
    if (pathProblem(path) !== null || !target.startsWith(root + sep) || folded.has(path.toLowerCase())) {
      io.err(`floorspec: ${file}: ${path} cannot be written into a folder safely\n`);
      return 1;
    }
    folded.add(path.toLowerCase());
  }
  try {
    for (const [path, data] of files) {
      const target = resolve(root, ...path.split('/'));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, data, { flag: 'wx' });
    }
  } catch (e) {
    io.err(`floorspec: cannot write ${out}: ${(e as Error).message}\n`);
    return 2;
  }
  for (const a of opened.missing) io.err(`${file}: warning: asset ${a.asset} names ${a.path}, which the package does not hold\n`);
  for (const p of opened.ignored) io.err(`${file}: note: ${p} is not part of the package; not written\n`);
  io.out(`${out}: ${DOCUMENT_NAME} and ${String(opened.files.size)} asset file${opened.files.size === 1 ? '' : 's'}\n`);
  return 0;
}

/** The catalogue size, re-exported so the CLI's tests can check they run against the same engine. */
export const CATALOGUE_SIZE = CATALOGUE.length;
