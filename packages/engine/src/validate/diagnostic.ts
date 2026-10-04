/** A diagnostic (10.2). */

export type Severity = 'error' | 'warning' | 'info';

/** A fix operation (10.5): a provisional subset of Floorspec Ops. */
export type FixOp =
  | { op: 'remove'; id: string }
  | { op: 'set'; id: string; member: string; value: unknown }
  | { op: 'unset'; id: string; member: string };

export interface DiagnosticLocation {
  /** A JSON Pointer (RFC 6901) into the document. */
  pointer?: string;
  /** A level ID. */
  level?: string;
  /** A point on that level, in base units. */
  point?: [number, number];
}

export interface Diagnostic {
  code: string;
  severity: Severity;
  /** Human-readable; its wording is not normative. */
  message: string;
  /** The elements involved, sorted. */
  elements: string[];
  location: DiagnosticLocation;
  fix?: FixOp[];
}

/** Compare two string sequences element by element (10.2), shorter first on a common prefix. */
export function compareStringSeq(a: readonly string[], b: readonly string[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x !== y) return x < y ? -1 : 1;
  }
  return a.length - b.length;
}

/** Sort diagnostics by code, then by elements (10.2). Stable, so equal keys keep their order. */
export function sortDiagnostics(ds: Diagnostic[]): Diagnostic[] {
  for (const d of ds) d.elements = [...d.elements].sort(cmpStr);
  return ds.sort((a, b) => (a.code !== b.code ? cmpStr(a.code, b.code) : compareStringSeq(a.elements, b.elements)));
}

/** Compare strings as sequences of UTF-16 code units. */
export function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
