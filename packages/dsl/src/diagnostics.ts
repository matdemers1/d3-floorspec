/** Where something is in a DSL text: 1-based line and column. */
export interface Pos {
  readonly line: number;
  readonly column: number;
}

/**
 * A DSL diagnostic. `code` is `FS-DSL-SYNTAX`, `FS-DSL-LAYOUT` or `FS-DSL-REFERENCE` for the DSL's
 * own errors; an error the applier or the engine reports about the compiled batch keeps its own code
 * (`FS-OPS-…`, `FS-INV-…`) and is placed on the line that made the element it names.
 */
export interface DslDiagnostic {
  readonly code: string;
  readonly severity: 'error' | 'warning';
  readonly message: string;
  readonly line: number;
  readonly column: number;
}

export class DslError extends Error {
  constructor(
    message: string,
    readonly pos: Pos,
    readonly code = 'FS-DSL-SYNTAX',
  ) {
    super(message);
    this.name = 'DslError';
  }
  toDiagnostic(): DslDiagnostic {
    return { code: this.code, severity: 'error', message: this.message, line: this.pos.line, column: this.pos.column };
  }
}

/** Thrown by `toDsl` for a document the DSL cannot say. */
export class DecompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecompileError';
  }
}

/** `line 3, column 7: …` */
export function formatDiagnostic(d: DslDiagnostic): string {
  return `line ${d.line}, column ${d.column}: ${d.severity === 'warning' ? 'warning: ' : ''}${d.message}${d.code.startsWith('FS-DSL') ? '' : ` (${d.code})`}`;
}
