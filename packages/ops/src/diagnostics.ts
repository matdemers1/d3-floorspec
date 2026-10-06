/**
 * The FS-OPS catalogue (chapter 7) and the failure that ends a transaction. Diagnostics have the
 * shape of Core §10.2; their `location.pointer` points into the request (`/batch/3/wall`).
 */
import type { Diagnostic } from '@floorspec/engine';
import { cmpStr } from './lib/json.js';

export type OpsCode =
  | 'FS-OPS-001'
  | 'FS-OPS-002'
  | 'FS-OPS-003'
  | 'FS-OPS-004'
  | 'FS-OPS-005'
  | 'FS-OPS-006'
  | 'FS-OPS-007'
  | 'FS-OPS-008'
  | 'FS-OPS-009'
  | 'FS-OPS-010'
  | 'FS-OPS-011'
  | 'FS-OPS-012'
  | 'FS-OPS-013';

/** 7.1, with the rule each code reports. Every FS-OPS diagnostic is an error. */
export const OPS_CATALOGUE: Readonly<Record<OpsCode, { condition: string; rules: readonly string[] }>> = {
  'FS-OPS-001': { condition: 'the request is malformed', rules: ['1.1.1'] },
  'FS-OPS-002': { condition: 'the document the batch applies to is not valid', rules: ['1.2.1'] },
  'FS-OPS-003': { condition: 'a reference resolves to nothing', rules: ['2.2.1', '2.3.1', '3.3.1', '4.5.1'] },
  'FS-OPS-004': { condition: 'a selector matches more than one element', rules: ['3.3.1'] },
  'FS-OPS-005': { condition: 'an operation names an ID already in use or retired', rules: ['1.5.2'] },
  'FS-OPS-006': { condition: 'a removal is blocked by elements that depend on it', rules: ['2.2.1'] },
  'FS-OPS-007': { condition: 'a selector needs faces on a level that has none to give', rules: ['3.4.1'] },
  'FS-OPS-008': { condition: 'a composite does not apply', rules: ['4.4.1', '4.7.1'] },
  'FS-OPS-009': { condition: 'an opening straddles a junction that planarization inserts', rules: ['5.2.1'] },
  'FS-OPS-010': { condition: 'a lock names elements that do not exist, or walls that are not parallel', rules: ['6.1.1'] },
  'FS-OPS-011': { condition: 'the result breaks a lock', rules: ['6.1.2'] },
  'FS-OPS-012': { condition: 'a length, point or vector string does not match the grammar', rules: ['3.1.1'] },
  'FS-OPS-013': { condition: 'planarization would route or split an arc edge', rules: ['5.2.4'] },
};

export function opsDiagnostic(code: OpsCode, message: string, elements: readonly string[] = [], pointer?: string): Diagnostic {
  return {
    code,
    severity: 'error',
    message,
    elements: [...new Set(elements)].sort(cmpStr),
    location: pointer === undefined ? {} : { pointer },
  };
}

/** Thrown inside a transaction to end it: the first failure wins (7). */
export class OpsFailure extends Error {
  readonly diagnostics: Diagnostic[];
  constructor(diagnostics: Diagnostic[]) {
    super(diagnostics.map((d) => `${d.code}: ${d.message}`).join('; '));
    this.diagnostics = diagnostics;
  }
}

export function fail(code: OpsCode, message: string, elements: readonly string[] = [], pointer?: string): never {
  throw new OpsFailure([opsDiagnostic(code, message, elements, pointer)]);
}
