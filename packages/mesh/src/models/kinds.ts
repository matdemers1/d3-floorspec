/**
 * What an extension element is: the member of its collection that says so (each official
 * extension's spec) — a plumbing fixture's `fixture`, a light's `fixture`, a gas appliance's
 * `appliance`, a furniture piece's `category`. The editor's catalogue reads the same table
 * (apps/web editor/systems/catalog.ts), so a model and a plan symbol agree on what a thing is.
 */

type Json = Record<string, unknown>;

/** Extension → collection → the member that names what an element of it is. */
const MEMBERS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  FS_electrical: { switches: 'control', lights: 'fixture' },
  FS_plumbing: { fixtures: 'fixture', waterHeaters: 'heater', drains: 'receptor' },
  FS_mechanical: { equipment: 'equipment', terminals: 'terminal', exhaust: 'exhaust', gasAppliances: 'appliance' },
  FS_lowvoltage: { outlets: 'media', doorbells: 'part', security: 'device', speakers: 'speaker', headEnds: 'headEnd' },
  FS_furniture: { pieces: 'category', appliances: 'category', casework: 'category' },
};

/** The member that says what an element of a collection is, or undefined for a collection without one. */
export function discriminant(extension: string, collection: string): string | undefined {
  const c = Object.hasOwn(MEMBERS, extension) ? MEMBERS[extension]! : undefined;
  return c !== undefined && Object.hasOwn(c, collection) ? c[collection] : undefined;
}

/**
 * What an element is, as one word: the discriminant's value (its first, for a list), or the
 * collection's own name for a collection without one (`receptacles`, `panels`). A light without a
 * `fixture` is a ceiling light, as FS_electrical's default reads it.
 */
export function elementKind(extension: string, collection: string, element: Json): string {
  const m = discriminant(extension, collection);
  const v = m === undefined ? undefined : element[m];
  const first = Array.isArray(v) ? (v as unknown[])[0] : v;
  if (typeof first === 'string') return first;
  if (extension === 'FS_electrical' && collection === 'lights') return 'ceiling';
  return collection;
}
