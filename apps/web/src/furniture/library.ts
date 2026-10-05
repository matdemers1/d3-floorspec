import { furniture, type ClearanceEnvelope } from '@floorspec/engine';
import catalogue from '../../../../packages/engine/standard/registry/FS_furniture/library/library.json';
import type { Box } from './gltf';

/**
 * The FS_furniture starter library (FS_furniture chapter 7, CC0): generic furniture, appliances and
 * casework, each an element ready to place with its box, default envelopes, a proxy glTF model and
 * an SVG plan symbol. Vendored with the standard in packages/engine/standard, and bundled into the
 * editor by Vite as files of its own — content-hashed, served with the editor — so the library needs
 * no route of its own: placing an item fetches its two files from there and uploads them into the
 * project's asset store (FLR-T-8.2), where they become the project's own, by digest.
 */

export type FurnitureKind = 'pieces' | 'appliances' | 'casework';
export type Mounting = 'floor' | 'wall' | 'builtIn';

export interface LibraryFile {
  path: string;
  mediaType: string;
  sha256: string;
  byteLength: number;
  /** Where the editor serves it from. */
  url: string;
}

export interface LibraryItem {
  id: string;
  kind: FurnitureKind;
  mounting: Mounting;
  category: string;
  name: string;
  seats?: number;
  box: Box;
  clearances: Record<string, ClearanceEnvelope>;
  model: LibraryFile;
  symbol: LibraryFile;
}

interface RawFile {
  path: string;
  mediaType: string;
  sha256: string;
  byteLength: number;
}
interface RawItem {
  kind: FurnitureKind;
  mounting: Mounting;
  element: { category: string; catalogue: string; name: string; seats?: number; clearances?: Record<string, ClearanceEnvelope>; fallback: { box: Box } };
  model: RawFile;
  symbol: RawFile;
}

const FILES = import.meta.glob<string>('../../../../packages/engine/standard/registry/FS_furniture/library/{models,symbols}/*.{glb,svg}', { query: '?url&no-inline', import: 'default', eager: true });
const urlOf = (path: string): string => {
  const hit = Object.entries(FILES).find(([k]) => k.endsWith(`/library/${path}`));
  return hit?.[1] ?? '';
};

export const LIBRARY_LICENSE = (catalogue as { license: string }).license;
export const LIBRARY_VERSION = (catalogue as { version: string }).version;

export const LIBRARY: readonly LibraryItem[] = Object.entries((catalogue as unknown as { items: Record<string, RawItem> }).items).map(([id, raw]) => ({
  id,
  kind: raw.kind,
  mounting: raw.mounting,
  category: raw.element.category,
  name: raw.element.name,
  ...(raw.element.seats === undefined ? {} : { seats: raw.element.seats }),
  box: raw.element.fallback.box,
  clearances: raw.element.clearances ?? {},
  model: { ...raw.model, url: urlOf(raw.model.path) },
  symbol: { ...raw.symbol, url: urlOf(raw.symbol.path) },
}));

export const libraryItem = (id: string): LibraryItem | undefined => LIBRARY.find((i) => i.id === id);

/** The kinds as a person reads them, in the library's order. */
export const KINDS: readonly { kind: FurnitureKind; label: string; singular: string }[] = [
  { kind: 'pieces', label: 'Furniture', singular: 'Furniture piece' },
  { kind: 'appliances', label: 'Appliances', singular: 'Appliance' },
  { kind: 'casework', label: 'Casework', singular: 'Casework' },
];

/** FS_furniture 2.5: each kind's categories, in the spec's order. */
export const CATEGORIES: Readonly<Record<FurnitureKind, readonly string[]>> = {
  pieces: ['sofa', 'armchair', 'chair', 'bench', 'stool', 'diningTable', 'coffeeTable', 'sideTable', 'desk', 'bed', 'crib', 'nightstand', 'dresser', 'wardrobe', 'bookcase', 'sideboard', 'mediaUnit', 'shelf', 'other'],
  appliances: ['refrigerator', 'freezer', 'range', 'wallOven', 'cooktop', 'microwave', 'dishwasher', 'washer', 'dryer', 'other'],
  casework: ['baseCabinet', 'wallCabinet', 'tallCabinet', 'island', 'vanity', 'shelving', 'other'],
};

/** The kind a category belongs to, for a category only one kind has (`other` is every kind's). */
export const kindOfCategory = (category: string): FurnitureKind | null =>
  category === 'other' ? null : (KINDS.find((k) => CATEGORIES[k.kind].includes(category))?.kind ?? null);

/** FS_furniture 2.5: how an item of a category is mounted. */
export const mountingOf = (category: string): Mounting => furniture.mounting(category);

const LABELS: Readonly<Record<string, string>> = { diningTable: 'Dining table', coffeeTable: 'Coffee table', sideTable: 'Side table', mediaUnit: 'Media unit', wallOven: 'Wall oven', baseCabinet: 'Base cabinet', wallCabinet: 'Wall cabinet', tallCabinet: 'Tall cabinet' };

/** `diningTable` → `Dining table`. */
export function categoryLabel(category: string): string {
  return LABELS[category] ?? category.charAt(0).toUpperCase() + category.slice(1);
}

/** Whether an item matches a search: its name, category, kind or catalogue ID, every word. */
export function matches(item: Pick<LibraryItem, 'id' | 'name' | 'category' | 'kind'>, query: string): boolean {
  const hay = `${item.name} ${categoryLabel(item.category)} ${item.category} ${item.kind} ${item.id}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w !== '')
    .every((w) => hay.includes(w));
}

/** FS_furniture 4.2: the category's default envelopes for a box (`{}` for a category without any). */
export function defaultEnvelopes(category: string, box: Box): Record<string, ClearanceEnvelope> {
  return furniture.defaultFurnitureEnvelopes(category, box);
}

/** Where a category's item goes against a wall by default, when it is hung or set (base units above the floor). */
const HEIGHTS: Readonly<Record<string, number>> = {
  // A wall cabinet's bottom 54" (1372 mm) up: 18" over a 36" counter.
  wallCabinet: 1_756_160,
  shelf: 1_280_000,
  shelving: 1_280_000,
  // Set into a counter or a tall cabinet.
  cooktop: 1_152_000,
  microwave: 1_920_000,
  wallOven: 960_000,
};

/** The height a wall-mounted or built-in item is hosted at against a wall face, base units. */
export const mountHeight = (category: string): number => HEIGHTS[category] ?? 0;
