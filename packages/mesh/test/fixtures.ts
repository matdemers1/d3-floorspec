/** Documents on disk (Node only): every conformance case of the vendored suites, and the editor's templates. */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const here = import.meta.dirname;

export interface Named {
  name: string;
  text: string;
}

/** Every case input of the vendored Core conformance suites (0.1, 0.2, 0.3), valid or not. */
export function conformanceInputs(): Named[] {
  const out: Named[] = [];
  const root = join(here, '..', '..', 'engine', 'standard', 'conformance', 'core');
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir).sort()) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (e === 'input.json') out.push({ name: relative(root, dir), text: readFileSync(p, 'utf8') });
    }
  };
  walk(root);
  return out;
}

/** The new-project template and the plan renderer's fixture houses. */
export function templates(): Named[] {
  const files = [
    join(here, '..', '..', '..', 'apps', 'web', 'src', 'projects', 'templates', 'three-room-house.floorspec.json'),
    ...['l-shaped-house', 'three-room-house', 'two-bedroom-ranch'].map((f) => join(here, '..', '..', 'render2d', 'test', 'fixtures', `${f}.json`)),
  ];
  return files.map((f) => ({ name: relative(join(here, '..', '..', '..'), f), text: readFileSync(f, 'utf8') }));
}
