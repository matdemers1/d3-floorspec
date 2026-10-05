/**
 * The reader the reference implementation runs everywhere — server, editor, MCP server: one that
 * implements every official extension (FS_electrical, FS_plumbing, FS_mechanical, FS_lowvoltage
 * 0.1.0) and knows them at those versions (Core 12.2), so their diagnostics are evaluated and their
 * derived values computed. Pass it as `ValidateOptions`, or to `@floorspec/ops`'s `apply`.
 *
 * A core-only reader is the default (`{}`): it still derives every extension element's fallback,
 * placement and clearances (Core 1.6.9), and nothing an extension defines.
 */
import type { RegistryEntry } from '../model/document.js';
import { IMPLEMENTATIONS, OFFICIAL_EXTENSIONS } from './official.js';

export const OFFICIAL_READER: { readonly extensions: readonly string[]; readonly knownExtensions: readonly RegistryEntry[] } = Object.freeze({
  extensions: Object.freeze([...IMPLEMENTATIONS.keys()]),
  knownExtensions: OFFICIAL_EXTENSIONS,
});
