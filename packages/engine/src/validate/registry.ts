/**
 * Known extensions (Core 0.2, 12.2) and version ranges (12.3).
 *
 * A validator is configured with known extensions — registry entries — as an input to validation,
 * like the extensions a reader implements. `loadKnownExtensions` checks them as 12.2.1 requires
 * (each entry matches the registry entry schema, no two share a name and version, `requires` has
 * no cycle) and returns them, or `undefined` when they break it: FS-CFG-001, and nothing else.
 */
import { validate as entrySchema } from '../generated/validate-registry.js';
import { parseJson } from '../json/parse.js';
import type { RegistryEntry } from '../model/document.js';

// ── versions (Semantic Versioning 2.0.0 precedence, §11) ─────────────────────

interface Version {
  readonly core: readonly [bigint, bigint, bigint];
  /** Prerelease identifiers, or undefined for a release. */
  readonly pre: readonly string[] | undefined;
}

/** A version: `M.m.p` or `M.m` (read as `M.m.0`, 12.2), optionally with a `-prerelease`. */
export function parseVersion(v: string): Version {
  const dash = v.indexOf('-');
  const core = dash < 0 ? v : v.slice(0, dash);
  const parts = core.split('.').map((x) => BigInt(x));
  if (parts.length === 2) parts.push(0n);
  return { core: [parts[0]!, parts[1]!, parts[2]!], pre: dash < 0 ? undefined : v.slice(dash + 1).split('.') };
}

const numeric = (s: string): boolean => /^[0-9]+$/.test(s);
const cmp = <T extends bigint | string | number>(a: T, b: T): -1 | 0 | 1 => (a < b ? -1 : a > b ? 1 : 0);

function compareIdent(a: string, b: string): -1 | 0 | 1 {
  const an = numeric(a);
  const bn = numeric(b);
  if (an && bn) return cmp(BigInt(a), BigInt(b));
  if (an !== bn) return an ? -1 : 1; // numeric identifiers have lower precedence
  return cmp(a, b); // ASCII order
}

/** Semantic Versioning precedence: −1, 0 or 1. `1.2` equals `1.2.0`. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    const c = cmp(pa.core[i]!, pb.core[i]!);
    if (c) return c;
  }
  if (pa.pre === undefined || pb.pre === undefined) return pa.pre === pb.pre ? 0 : pa.pre === undefined ? 1 : -1;
  const n = Math.min(pa.pre.length, pb.pre.length);
  for (let i = 0; i < n; i++) {
    const c = compareIdent(pa.pre[i]!, pb.pre[i]!);
    if (c) return c;
  }
  return cmp(pa.pre.length, pb.pre.length);
}

function comparator(x: string, c: string): boolean {
  const m = /^(>=|>|<=|<|=|\^|~)?(.*)$/.exec(c)!;
  const op = m[1] ?? '=';
  const v = m[2]!;
  const k = compareVersions(x, v);
  switch (op) {
    case '=':
      return k === 0;
    case '>=':
      return k >= 0;
    case '>':
      return k > 0;
    case '<=':
      return k <= 0;
    case '<':
      return k < 0;
  }
  const [M, mi, p] = parseVersion(v).core;
  let upper: string;
  if (op === '~') upper = `${M}.${mi + 1n}.0`;
  else if (M > 0n) upper = `${M + 1n}.0.0`;
  else if (mi > 0n) upper = `0.${mi + 1n}.0`;
  else upper = `0.0.${p + 1n}`;
  return k >= 0 && compareVersions(x, upper) < 0;
}

/** 12.3: does `version` satisfy the range — every comparator of at least one of its sets? */
export function satisfies(version: string, range: string): boolean {
  return range.split(/ +\|\| +/).some((set) =>
    set
      .split(/ +/)
      .filter((c) => c !== '')
      .every((c) => comparator(version, c)),
  );
}

// ── known extensions (12.2) ──────────────────────────────────────────────────

type SchemaFn = (data: unknown) => boolean;

function cyclic(entries: readonly RegistryEntry[]): boolean {
  const edges = new Map<string, Set<string>>();
  for (const e of entries) {
    const s = edges.get(e.name) ?? new Set<string>();
    for (const y of Object.keys(e.requires ?? {})) s.add(y);
    edges.set(e.name, s);
  }
  const state = new Map<string, 1 | 2>();
  const visit = (n: string): boolean => {
    const st = state.get(n);
    if (st === 1) return true;
    if (st === 2) return false;
    state.set(n, 1);
    for (const m of [...(edges.get(n) ?? [])].sort()) if (visit(m)) return true;
    state.set(n, 2);
    return false;
  };
  return [...edges.keys()].sort().some(visit);
}

/**
 * The known extensions a validator is configured with: a JSON array of registry entries, given as
 * its text (UTF-8 bytes or a string) or as an already-parsed value. Returns the entries, or
 * `undefined` when they break 12.2.1 — a validator so configured reports only FS-CFG-001 (12.2.2).
 */
export function loadKnownExtensions(input: string | Uint8Array | readonly unknown[]): RegistryEntry[] | undefined {
  let value: unknown;
  if (typeof input === 'string' || input instanceof Uint8Array) {
    const parsed = parseJson(input);
    if (parsed.diagnostics.length || !('value' in parsed)) return undefined;
    value = parsed.value;
  } else value = input;
  if (!Array.isArray(value)) return undefined;
  const fn = entrySchema as unknown as SchemaFn;
  if (!value.every((e) => fn(e))) return undefined;
  const entries = value as RegistryEntry[];
  for (let i = 0; i < entries.length; i++)
    for (let k = i + 1; k < entries.length; k++)
      if (entries[i]!.name === entries[k]!.name && compareVersions(entries[i]!.version, entries[k]!.version) === 0) return undefined;
  if (cyclic(entries)) return undefined;
  return entries;
}

/** 12.2: the known entry of `name` at a version equal to `version`, if there is one. */
export function knownEntry(known: readonly RegistryEntry[] | undefined, name: string, version: string): RegistryEntry | undefined {
  return known?.find((e) => e.name === name && compareVersions(e.version, version) === 0);
}
