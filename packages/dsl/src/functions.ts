/**
 * Room functions (Core §4.1) inferred from what a room is called. The last word of the name that
 * names a function decides — `dining_room` is dining, `kitchen_pantry` storage — and `as <function>`
 * overrides it. A name with no such word is `unspecified`, which is what Core says an undecided room is.
 */

/** The terms of Core §4.1, in the order of its table. */
export const ROOM_FUNCTIONS = ['unspecified', 'sleeping', 'bath', 'kitchen', 'living', 'dining', 'office', 'laundry', 'utility', 'storage', 'circulation', 'mechanical', 'garage', 'exterior'] as const;
export type RoomFunction = (typeof ROOM_FUNCTIONS)[number];

const WORDS: Readonly<Record<Exclude<RoomFunction, 'unspecified'>, readonly string[]>> = {
  sleeping: ['bed', 'bedroom', 'bunk', 'bunkroom', 'nursery', 'sleeping', 'dorm'],
  bath: ['bath', 'bathroom', 'wc', 'toilet', 'powder', 'ensuite', 'shower', 'lav', 'lavatory', 'washroom'],
  kitchen: ['kitchen', 'kitchenette', 'galley'],
  living: ['living', 'family', 'great', 'den', 'lounge', 'playroom', 'rec', 'sitting', 'media', 'parlor', 'parlour'],
  dining: ['dining', 'dinette', 'breakfast', 'nook'],
  office: ['office', 'study', 'library', 'studio'],
  laundry: ['laundry'],
  utility: ['utility', 'mudroom', 'mud', 'workshop', 'scullery'],
  storage: ['closet', 'storage', 'pantry', 'wic', 'wardrobe', 'store', 'attic', 'larder'],
  circulation: ['hall', 'hallway', 'foyer', 'entry', 'corridor', 'landing', 'vestibule', 'stair', 'stairs', 'stairwell', 'gallery'],
  mechanical: ['mechanical', 'mech', 'furnace', 'boiler'],
  garage: ['garage', 'carport'],
  exterior: ['porch', 'deck', 'patio', 'balcony', 'terrace', 'veranda', 'verandah'],
};

const BY_WORD = new Map<string, RoomFunction>();
for (const [fn, words] of Object.entries(WORDS) as [RoomFunction, readonly string[]][]) for (const w of words) BY_WORD.set(w, fn);

/** The words of a name, lower case: split at anything not a letter, and at camelCase humps. */
function words(name: string): string[] {
  return name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length > 0);
}

function lookup(word: string): RoomFunction | undefined {
  const hit = BY_WORD.get(word);
  if (hit) return hit;
  // Plurals: "baths", "closets", "porches".
  if (word.endsWith('es') && BY_WORD.has(word.slice(0, -2))) return BY_WORD.get(word.slice(0, -2));
  if (word.endsWith('s') && BY_WORD.has(word.slice(0, -1))) return BY_WORD.get(word.slice(0, -1));
  return undefined;
}

/** The function a room or brief item called `name` is inferred to have. */
export function inferFunction(...names: (string | undefined)[]): RoomFunction {
  for (const name of names) {
    if (name === undefined) continue;
    const ws = words(name);
    for (let i = ws.length - 1; i >= 0; i--) {
      const fn = lookup(ws[i]!);
      if (fn) return fn;
    }
  }
  return 'unspecified';
}

/** Whether a function term is one Core defines or an extension term (`EXT_x:term`, Core §4.2). */
export function isFunctionTerm(fn: string): boolean {
  return (ROOM_FUNCTIONS as readonly string[]).includes(fn) || /^[A-Za-z0-9_]+:[a-z][A-Za-z0-9]*$/.test(fn);
}

/** The display name of a room or item a handle names when no name is given: `primary_bed` → `Primary bed`. */
export function nameFromHandle(handle: string): string {
  const s = handle.replace(/_+/g, ' ').trim();
  return s.length === 0 ? handle : s[0]!.toUpperCase() + s.slice(1);
}

/** The display name of a brief item when the brief gives only a word: `bed` → `Bedroom`. */
const ITEM_NAMES: Readonly<Record<string, string>> = {
  bed: 'Bedroom',
  bedroom: 'Bedroom',
  bath: 'Bathroom',
  bathroom: 'Bathroom',
  wc: 'WC',
  living: 'Living room',
  dining: 'Dining room',
  family: 'Family room',
  hall: 'Hall',
};
export function itemName(word: string): string {
  const w = word.toLowerCase();
  const single = w.endsWith('s') && ITEM_NAMES[w.slice(0, -1)] !== undefined ? w.slice(0, -1) : w;
  return ITEM_NAMES[single] ?? nameFromHandle(word);
}
