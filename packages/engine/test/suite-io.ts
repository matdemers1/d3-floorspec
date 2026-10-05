/**
 * What a conformance test may hold besides its document (conformance/README.md): `design.json`, the
 * design to derive (Core 0.3, 19.6), and `package/`, the files of the document's package — the test
 * is then run by a package validator (18.4). Node-only: the browser gets these through a command.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The files under a test's `package/` directory, by their path relative to it with `/` between
 * names, as the directory lists them — so a path names exactly one file, case and all, even on a
 * file system that folds case. Undefined when the test has no package.
 */
export function readPackage(dir: string): Map<string, Uint8Array> | undefined {
  const root = join(dir, 'package');
  if (!existsSync(root)) return undefined;
  const out = new Map<string, Uint8Array>();
  const walk = (d: string, prefix: string): void => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p, `${prefix}${name}/`);
      else out.set(`${prefix}${name}`, new Uint8Array(readFileSync(p)));
    }
  };
  walk(root, '');
  return out;
}

/** The test's design input (design.json), when it has one. */
export function readDesign(dir: string): unknown {
  const p = join(dir, 'design.json');
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as unknown) : undefined;
}

/** A diagnostic as expected.json holds it: code, severity, elements, and `design` when it has one (19.5.2). */
export const diagnosticView = (d: { code: string; severity: string; elements: string[]; design?: string }) => ({
  code: d.code,
  severity: d.severity,
  elements: d.elements,
  ...(d.design !== undefined && { design: d.design }),
});
