import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';

/** Shared by the backup and the drill: running the Postgres client tools, and naming their files. */

/** Nightly dumps are `floorspec-<UTC timestamp>.dump`, beside `floorspec-<same>.manifest.json`. */
export const DUMP_PREFIX = 'floorspec-';
export const DUMP_SUFFIX = '.dump';
export const MANIFEST_SUFFIX = '.manifest.json';
export const MANIFEST_FORMAT = 'floorspec-backup/1';

/** The tables whose row counts a manifest records and a drill compares. */
export const COUNTED_TABLES = ['accounts', 'projects', 'versions', 'heads', 'op_log', 'changesets', 'audit_log'] as const;
export type RowCounts = Record<(typeof COUNTED_TABLES)[number], number>;

export interface Manifest {
  readonly format: typeof MANIFEST_FORMAT;
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly createdAt: string;
  readonly schemaRevision: string | null;
  readonly rowCounts: RowCounts;
  readonly assets: AssetSummary;
  readonly pgDump: string;
}

export type AssetSummary =
  | { readonly status: 'mirrored'; readonly dir: string; readonly files: number; readonly bytes: number; readonly copied: number }
  | { readonly status: 'none'; readonly reason: string };

export function stamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '-');
}

export function isDump(name: string): boolean {
  return name.startsWith(DUMP_PREFIX) && name.endsWith(DUMP_SUFFIX);
}

export function manifestName(dump: string): string {
  return `${dump.slice(0, -DUMP_SUFFIX.length)}${MANIFEST_SUFFIX}`;
}

/** Nightly dumps in `dir`, newest first (the timestamp sorts). */
export async function listDumps(dir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  return names.filter(isDump).sort().reverse();
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Run a command; never rejects for a non-zero exit, only when it cannot be started at all. */
export function run(command: string, args: readonly string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      reject(new Error(`${command} could not be started: ${error.message}`));
    });
    child.on('close', (code) => {
      resolve({ code: code ?? 1, stdout: stdout.slice(-4000), stderr: stderr.trim().slice(-2000) });
    });
  });
}

/** Postgres's client tools: their names, overridable so a test can make one fail. */
export interface PgTools {
  readonly pgDump: string;
  readonly pgRestore: string;
}

export const PG_TOOLS: PgTools = { pgDump: 'pg_dump', pgRestore: 'pg_restore' };
