import { DEFERRED, type Pack } from '@floorspec/rules-engine';

/**
 * The coverage matrix of the installed rule packs (FLR-T-6.9, FLR-REQ-096): every section of every
 * code edition a pack addresses — and the ones it says it does not — with its status, the rules
 * that check it, their reviewed badges and the date each was last verified. So a reader of a
 * report can tell "no finding" from "not checked".
 *
 * The standard's pack tooling publishes the matrix beside each built pack
 * (`rules/<pack>/generated/coverage.json`, `pnpm coverage:matrix`), and that file is served as it
 * is. A pack installed without one — a single copied `*.json` file — has its matrix derived here
 * from the pack itself, in the same shape: its coverage entries, the rules within each, and their
 * provenance. The derivation is a reading of the pack, not a second opinion on it.
 */

export type MatrixStatus = 'covered' | 'partial' | 'deferred' | 'notCovered';

export interface MatrixRule {
  pack: string;
  rule: string;
  title: string;
  section: string;
  severity: string;
  link?: string;
  verifiedBy: string;
  verifiedOn: string;
  review: 'reviewed' | 'unreviewed';
  reviewed?: { by: string; on: string; credential?: string };
  deferred: string[];
}

export interface MatrixRow {
  pack: string;
  version: string;
  code: string;
  edition: string;
  section: string;
  domain: string | null;
  declared: 'addressed' | 'partial' | 'notAddressed' | 'undeclared';
  status: MatrixStatus;
  note?: string;
  needs: string[];
  rules: MatrixRule[];
  reviewed: number;
  oldestVerification: string | null;
  newestVerification: string | null;
}

export interface DomainSummary {
  pack: string;
  domain: string | null;
  title: string;
  sections: Record<MatrixStatus, number>;
  rules: number;
  reviewed: number;
  oldestVerification: string | null;
  newestVerification: string | null;
}

export interface MatrixPack {
  name: string;
  version: string;
  title: string;
  license: string;
  attribution: string | null;
  jurisdiction: string | null;
  synthetic: boolean;
  rules: number;
  reviewed: number;
}

export interface CoverageMatrix {
  floorspecRules: '0.1';
  packs: MatrixPack[];
  domains: DomainSummary[];
  rows: MatrixRow[];
  rules: MatrixRule[];
}

export const EMPTY_MATRIX: CoverageMatrix = Object.freeze({ floorspecRules: '0.1', packs: [], domains: [], rows: [], rules: [] });

const STATUSES: MatrixStatus[] = ['covered', 'partial', 'deferred', 'notCovered'];

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** As the standard's tooling: a section is within an entry when it is the entry or continues it after a separator. */
export function within(section: string, entry: string): boolean {
  if (section === entry) return true;
  if (!section.startsWith(entry)) return false;
  return /[^A-Za-z0-9]/.test(section[entry.length] ?? '');
}

function minMax(dates: readonly string[]): { oldest: string | null; newest: string | null } {
  const s = [...dates].sort();
  return { oldest: s[0] ?? null, newest: s.at(-1) ?? null };
}

/** Every measure a test or applicability reads. */
function measuresOf(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) measuresOf(v, out);
  else if (typeof value === 'object' && value !== null) {
    const o = value as Record<string, unknown>;
    if (typeof o['measure'] === 'string') out.add(o['measure']);
    for (const v of Object.values(o)) measuresOf(v, out);
  }
  return out;
}

interface PackFormat {
  attribution?: string;
  jurisdiction?: string;
  synthetic?: boolean;
  domains?: { id: string; title: string }[];
  coverage?: { domain?: string; needs?: string[] }[];
}

/** The matrix of one pack, derived from the pack itself (the shape of the standard's coverage.json). */
export function deriveMatrix(pack: Pack): CoverageMatrix {
  const fmt = ((pack.extras as { packFormat?: PackFormat } | undefined)?.packFormat ?? {});
  const records = Object.entries(pack.rules).flatMap(([id, r]) => (r === undefined ? [] : [[id, r] as const])).sort(([a], [b]) => cmp(a, b));
  const citations = new Map(records.map(([id, r]) => [id, r.citation]));
  const rules: MatrixRule[] = records
    .map(([id, r]) => {
      const reviewed = (r.provenance as { reviewed?: { by: string; on: string; credential?: string } }).reviewed;
      return {
        pack: pack.name,
        rule: id,
        title: r.title,
        section: r.citation.section,
        severity: r.severity,
        ...(r.citation.link === undefined ? {} : { link: r.citation.link }),
        verifiedBy: r.provenance.verifiedBy,
        verifiedOn: r.provenance.verifiedOn,
        review: reviewed === undefined ? 'unreviewed' : 'reviewed',
        ...(reviewed === undefined ? {} : { reviewed }),
        deferred: [...measuresOf([r.applies, r.select, r.requirement, r.exceptions])].filter((m) => DEFERRED.has(m)).sort(cmp),
      } satisfies MatrixRule;
    });
  const entries = (pack.coverage ?? []).map((c, i) => ({ ...c, domain: fmt.coverage?.[i]?.domain ?? null, needs: fmt.coverage?.[i]?.needs ?? [] }));
  const assigned = new Map<number, MatrixRule[]>();
  const loose = new Map<string, MatrixRule[]>();
  for (const mr of rules) {
    const c = citations.get(mr.rule);
    if (c === undefined) continue;
    let best = -1;
    let bestLength = -1;
    entries.forEach((e, i) => {
      if (e.code === c.code && e.edition === c.edition && within(c.section, e.section) && e.section.length > bestLength) {
        best = i;
        bestLength = e.section.length;
      }
    });
    if (best >= 0) assigned.set(best, [...(assigned.get(best) ?? []), mr]);
    else {
      const k = JSON.stringify([c.code, c.edition, c.section]);
      loose.set(k, [...(loose.get(k) ?? []), mr]);
    }
  }
  const row = (code: string, edition: string, section: string, domain: string | null, declared: MatrixRow['declared'], inRow: MatrixRule[], needs0: string[], note?: string): MatrixRow => {
    const deferredRules = inRow.filter((r) => r.deferred.length > 0);
    const needs = [...new Set([...needs0, ...deferredRules.flatMap((r) => r.deferred)])].sort(cmp);
    let status: MatrixStatus;
    if (declared === 'notAddressed') status = needs0.length > 0 ? 'deferred' : 'notCovered';
    else if (inRow.length > 0 && deferredRules.length === inRow.length) status = 'deferred';
    else if (declared === 'partial' || deferredRules.length > 0) status = 'partial';
    else status = inRow.length > 0 ? 'covered' : 'notCovered';
    const { oldest, newest } = minMax(inRow.map((r) => r.verifiedOn));
    return {
      pack: pack.name, version: pack.version, code, edition, section, domain, declared, status,
      ...(note === undefined ? {} : { note }),
      needs, rules: inRow, reviewed: inRow.filter((r) => r.review === 'reviewed').length, oldestVerification: oldest, newestVerification: newest,
    };
  };
  const rows: MatrixRow[] = entries.map((e, i) => row(e.code, e.edition, e.section, e.domain, e.status, assigned.get(i) ?? [], e.needs, e.note));
  for (const [k, inRow] of loose) {
    const [code, edition, section] = JSON.parse(k) as [string, string, string];
    rows.push(row(code, edition, section, null, 'undeclared', inRow, []));
  }
  const titles = new Map((fmt.domains ?? []).map((d) => [d.id as string | null, d.title]));
  const order: (string | null)[] = (fmt.domains ?? []).map((d) => d.id);
  for (const r of rows) if (!order.includes(r.domain)) order.push(r.domain);
  const domains: DomainSummary[] = [];
  for (const d of order) {
    const inDomain = rows.filter((r) => r.domain === d);
    if (inDomain.length === 0) continue;
    const inRules = inDomain.flatMap((r) => r.rules);
    const { oldest, newest } = minMax(inRules.map((r) => r.verifiedOn));
    domains.push({
      pack: pack.name,
      domain: d,
      title: titles.get(d) ?? (d === null ? 'Sections' : d),
      sections: Object.fromEntries(STATUSES.map((s) => [s, inDomain.filter((r) => r.status === s).length])) as Record<MatrixStatus, number>,
      rules: inRules.length,
      reviewed: inRules.filter((r) => r.review === 'reviewed').length,
      oldestVerification: oldest,
      newestVerification: newest,
    });
  }
  return {
    floorspecRules: '0.1',
    packs: [
      {
        name: pack.name,
        version: pack.version,
        title: pack.title,
        license: pack.license,
        attribution: fmt.attribution ?? null,
        jurisdiction: fmt.jurisdiction ?? null,
        synthetic: fmt.synthetic === true,
        rules: rules.length,
        reviewed: rules.filter((r) => r.review === 'reviewed').length,
      },
    ],
    domains,
    rows,
    rules,
  };
}

/** Whether a value has the matrix's shape — a published coverage.json, read from disk. */
export function isMatrix(value: unknown): value is CoverageMatrix {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Record<string, unknown>;
  return m['floorspecRules'] === '0.1' && Array.isArray(m['packs']) && Array.isArray(m['domains']) && Array.isArray(m['rows']) && Array.isArray(m['rules']);
}

/**
 * One pack's published matrix, narrowed to that pack and version: a coverage.json beside a pack
 * that is a different version of it (an operator copied a newer pack.json over an older build) is
 * not that pack's matrix, and is ignored for the derived one.
 */
export function publishedFor(pack: Pack, published: CoverageMatrix): CoverageMatrix | null {
  const meta = published.packs.find((p) => p.name === pack.name && p.version === pack.version);
  if (meta === undefined) return null;
  return {
    floorspecRules: '0.1',
    packs: [meta],
    domains: published.domains.filter((d) => d.pack === pack.name),
    rows: published.rows.filter((r) => r.pack === pack.name),
    rules: published.rules.filter((r) => r.pack === pack.name),
  };
}

/** Several packs' matrices as one, in pack-name order. */
export function mergeMatrices(matrices: readonly CoverageMatrix[]): CoverageMatrix {
  const sorted = [...matrices].sort((a, b) => cmp(a.packs[0]?.name ?? '', b.packs[0]?.name ?? ''));
  return {
    floorspecRules: '0.1',
    packs: sorted.flatMap((m) => m.packs),
    domains: sorted.flatMap((m) => m.domains),
    rows: sorted.flatMap((m) => m.rows),
    rules: sorted.flatMap((m) => m.rules),
  };
}
