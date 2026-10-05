import { check, OFFICIAL_READER, type Derived, type Diagnostic, type FloorspecDocument, type ValidateOptions } from '@floorspec/engine';
import { ApiError } from '../lib/api';

/**
 * A project's head model, read the way every surface reads it: the canonical bytes from
 * `model.json`, checked and derived by `@floorspec/engine` — the same engine the server, MCP and CLI
 * run (FLR-ADR-010). Nothing here is a second opinion about the geometry; it only sums and groups
 * what the engine derived.
 */

/** Base units per foot: 1 in = 25.4 mm = 32,512 base units of 1/1280 mm (FLR-ADR-004). */
export const BASE_PER_FOOT = 390_144n;
const BASE2_PER_SQFT = BASE_PER_FOOT * BASE_PER_FOOT;

export interface LevelSummary {
  id: string;
  name: string;
  /** Elevation in base units, for ordering bottom to top. */
  elevation: number;
  rooms: number;
  walls: number;
  openings: number;
  /** Twice the net room area of the level, in square base units — exact. */
  area2: bigint;
}

export interface ModelSummary {
  valid: boolean;
  /** Errors first, then warnings and notes, in the engine's order. */
  diagnostics: Diagnostic[];
  document: FloorspecDocument | null;
  derived: Derived | null;
  name: string | null;
  levels: LevelSummary[];
  rooms: number;
  walls: number;
  openings: number;
  /** Twice the net area of every room, in square base units — exact (6.4). */
  area2: bigint;
  /** True when the model has nothing drawn yet: no walls, no rooms. */
  empty: boolean;
}

/** Twice a decimal half-string area ("123" or "123.5"), as an exact BigInt. */
export function twice(area: string): bigint {
  const negative = area.startsWith('-');
  const [whole = '0', half] = (negative ? area.slice(1) : area).split('.');
  const value = BigInt(whole) * 2n + (half === '5' ? 1n : 0n);
  return negative ? -value : value;
}

/** Square feet from twice an area in square base units, rounded to one decimal for display only. */
export function squareFeet(area2: bigint): number {
  const tenths = (area2 * 10n + BASE2_PER_SQFT) / (2n * BASE2_PER_SQFT);
  return Number(tenths) / 10;
}

/** "2,412" — whole square feet, grouped, as the design shows them. */
export function formatSquareFeet(area2: bigint): string {
  return Math.round(squareFeet(area2)).toLocaleString('en-US');
}

const plural = (n: number, one: string, other = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : other}`;
export { plural };

/**
 * Summarise a document: valid or not, and what the engine derived from it. `options` adds to the
 * official reader — a package's files, for one (FLR-T-9.1: the engine is then a package validator).
 */
export function summarize(input: string | object, options: Pick<ValidateOptions, 'package'> = {}): ModelSummary {
  const result = check(input, { ...OFFICIAL_READER, ...options });
  const document = (result.valid ? (typeof input === 'string' ? JSON.parse(input) : input) : null) as FloorspecDocument | null;
  const derived = result.derived ?? null;
  const levels: LevelSummary[] = [];
  let area2 = 0n;
  if (document !== null && derived !== null) {
    const byLevel = new Map<string, LevelSummary>();
    for (const [id, level] of Object.entries(document.levels ?? {})) {
      if (level === undefined) continue;
      byLevel.set(id, { id, name: level.name ?? id, elevation: level.elevation, rooms: 0, walls: 0, openings: 0, area2: 0n });
    }
    for (const [id, room] of Object.entries(derived.rooms)) {
      const levelId = document.rooms?.[id]?.level;
      const a = twice(room.area);
      area2 += a;
      const level = levelId === undefined ? undefined : byLevel.get(levelId);
      if (level !== undefined) {
        level.rooms += 1;
        level.area2 += a;
      }
    }
    for (const id of Object.keys(derived.walls)) {
      const level = byLevel.get(document.walls?.[id]?.level ?? '');
      if (level !== undefined) level.walls += 1;
    }
    for (const id of Object.keys(derived.openings)) {
      const wall = document.openings?.[id]?.wall;
      const level = byLevel.get(wall === undefined ? '' : (document.walls?.[wall]?.level ?? ''));
      if (level !== undefined) level.openings += 1;
    }
    levels.push(...[...byLevel.values()].sort((a, b) => a.elevation - b.elevation || (a.id < b.id ? -1 : 1)));
  }
  const rooms = derived === null ? 0 : Object.keys(derived.rooms).length;
  const walls = derived === null ? 0 : Object.keys(derived.walls).length;
  return {
    valid: result.valid,
    diagnostics: result.diagnostics,
    document,
    derived,
    name: document?.project.name ?? null,
    levels,
    rooms,
    walls,
    openings: derived === null ? 0 : Object.keys(derived.openings).length,
    area2,
    empty: rooms === 0 && walls === 0,
  };
}

/** One line about a model, as the project card shows it: "1 level · 3 rooms · 694 ft²". */
export function describeModel(summary: ModelSummary): string {
  if (!summary.valid) return 'The model does not validate';
  if (summary.empty) return 'Nothing drawn yet';
  return [
    plural(summary.levels.length, 'level'),
    plural(summary.rooms, 'room'),
    `${formatSquareFeet(summary.area2)} ft²`,
  ].join(' · ');
}

// ─── Loading ───────────────────────────────────────────────────────────────

/**
 * Head models by version hash. A version is immutable and keyed by its content hash, so a cached
 * summary can never be stale: a new head is a new key.
 */
const cache = new Map<string, Promise<ModelSummary | null>>();

/** The model `main` points at, or null when the project has no model yet. */
export function loadModel(projectId: string, head: string | null): Promise<ModelSummary | null> {
  const key = head ?? `none:${projectId}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const pending = fetch(`/api/projects/${projectId}/model.json`, { credentials: 'same-origin' })
    .then(async (res) => {
      if (res.status === 404) return null;
      if (!res.ok) throw new ApiError(res.status, `the model did not load (${String(res.status)})`);
      return summarize(await res.text());
    })
    .catch((error: unknown) => {
      // A failure is not remembered: the next look tries again.
      cache.delete(key);
      throw error;
    });
  cache.set(key, pending);
  return pending;
}

/** Run `task` over `items` with at most `limit` in flight — a long list must not open 50 sockets. */
export async function eachLimited<T>(items: readonly T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      await task(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// ─── Time ──────────────────────────────────────────────────────────────────

/** "2 h ago", "3 d ago", "2 wk ago" — the design's short relative times. */
export function timeAgo(iso: string, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${String(minutes)} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${String(hours)} h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 14) return `${String(days)} d ago`;
  const weeks = Math.round(days / 7);
  if (weeks < 9) return `${String(weeks)} wk ago`;
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
