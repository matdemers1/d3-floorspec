import { OFFICIAL_EXTENSIONS } from '@floorspec/engine';
import type { UnitSystem } from '../units';

/**
 * The devices the editor places (FLR-T-5.7): each a kind of an official extension's collection —
 * FS_electrical, FS_plumbing, FS_mechanical, FS_lowvoltage 0.1.0 — with the members a new one
 * starts with, the fallback box a reader without the extension draws (Core 12.6), and how it is
 * usually hosted (Core 13.3). Every number here is an editor default for a new element, chosen to
 * look right on a plan; none is a code's requirement, and every one is editable once placed.
 */

export type SystemId = 'electrical' | 'plumbing' | 'mechanical' | 'lowvoltage';
export type ExtensionName = 'FS_electrical' | 'FS_plumbing' | 'FS_mechanical' | 'FS_lowvoltage';

export const SYSTEMS: readonly { id: SystemId; extension: ExtensionName; label: string }[] = [
  { id: 'electrical', extension: 'FS_electrical', label: 'Electrical' },
  { id: 'plumbing', extension: 'FS_plumbing', label: 'Plumbing' },
  { id: 'mechanical', extension: 'FS_mechanical', label: 'Mechanical' },
  { id: 'lowvoltage', extension: 'FS_lowvoltage', label: 'Low-voltage' },
];

export const systemOfExtension = (extension: string): SystemId | null => SYSTEMS.find((s) => s.extension === extension)?.id ?? null;
export const extensionOfSystem = (system: SystemId): ExtensionName => SYSTEMS.find((s) => s.id === system)?.extension ?? 'FS_electrical';

/** The version of an official extension the editor writes, from the vendored registry entry. */
export function extensionVersion(extension: string): string {
  return OFFICIAL_EXTENSIONS.find((e) => e.name === extension)?.version ?? '0.1.0';
}

/**
 * How a kind is hosted when placed with the pointer:
 * - `wall`: on a wall face, at a mounting height (a receptacle, a switch, a panel);
 * - `floorWall`: on the floor, backed against the nearest wall face when near one (a toilet, a tub);
 * - `floor`: on the floor where it is put (a water heater, a floor drain);
 * - `ceiling`: on the ceiling where it is put (a light, an alarm).
 */
export type Mount = 'wall' | 'floorWall' | 'floor' | 'ceiling';

/** The plan symbol a kind is drawn with (Symbols.tsx). */
export type SymbolId =
  | 'panel' | 'receptacle' | 'switch' | 'light' | 'alarm' | 'ev'
  | 'toilet' | 'basin' | 'shower' | 'tub' | 'heater' | 'drain' | 'cleanout'
  | 'equipment' | 'supply' | 'return' | 'exhaust' | 'range'
  | 'data' | 'headEnd' | 'lowvoltage';

type Triple = [number, number, number];
export interface Box {
  min: Triple;
  max: Triple;
}

export interface DeviceKind {
  /** The catalogue's own key: `receptacle`, `toilet`. */
  id: string;
  label: string;
  /** Other words a typed placement may use for it. */
  aliases: readonly string[];
  system: SystemId;
  extension: ExtensionName;
  collection: string;
  mount: Mount;
  /** The fallback box, in the element's frame (Core 13.2). */
  box: Box;
  /** A wall mount's default height above the wall's base, to the frame's origin: ft-in, metric. */
  height?: { imperial: number; metric: number };
  /** The extension's own members a new one starts with. */
  members: Record<string, unknown>;
  symbol: SymbolId;
}

const IN = 32_512;
const MM = 1_280;
const h = (inches: number, mm: number) => ({ imperial: inches * IN, metric: mm * MM });
const box = (min: Triple, max: Triple): Box => ({ min, max });

/** A small plate on a wall: 25 mm proud, 80 mm wide, 120 mm tall, centred on its height. */
const PLATE = box([0, -51_200, -76_800], [32_000, 51_200, 76_800]);

/** The device tool's first kind, and its fallback. */
export const RECEPTACLE: DeviceKind = { id: 'receptacle', label: 'Receptacle', aliases: ['outlet', 'plug', 'duplex'], system: 'electrical', extension: 'FS_electrical', collection: 'receptacles', mount: 'wall', box: PLATE, height: h(12, 300), members: {}, symbol: 'receptacle' };

export const DEVICE_KINDS: readonly DeviceKind[] = [
  // FS_electrical
  { id: 'panel', label: 'Panel', aliases: ['panelboard', 'load centre', 'load center', 'subpanel'], system: 'electrical', extension: 'FS_electrical', collection: 'panels', mount: 'wall', box: box([0, -256_000, -512_000], [128_000, 256_000, 512_000]), height: h(60, 1500), members: { volts: [120, 240], rating: 200, mainBreaker: 200, spaces: 40 }, symbol: 'panel' },
  RECEPTACLE,
  { id: 'switch', label: 'Switch', aliases: ['light switch', 'dimmer'], system: 'electrical', extension: 'FS_electrical', collection: 'switches', mount: 'wall', box: PLATE, height: h(48, 1200), members: {}, symbol: 'switch' },
  { id: 'light', label: 'Ceiling light', aliases: ['light', 'luminaire', 'fixture light'], system: 'electrical', extension: 'FS_electrical', collection: 'lights', mount: 'ceiling', box: box([-128_000, -128_000, -192_000], [128_000, 128_000, 0]), members: { fixture: 'ceiling' }, symbol: 'light' },
  { id: 'alarm', label: 'Smoke/CO alarm', aliases: ['smoke alarm', 'smoke detector', 'co alarm', 'alarm'], system: 'electrical', extension: 'FS_electrical', collection: 'alarms', mount: 'ceiling', box: box([-96_000, -96_000, -64_000], [96_000, 96_000, 0]), members: { detects: ['smoke', 'carbonMonoxide'] }, symbol: 'alarm' },
  { id: 'evCharger', label: 'EV charger', aliases: ['ev', 'charger', 'evse'], system: 'electrical', extension: 'FS_electrical', collection: 'evChargers', mount: 'wall', box: box([0, -192_000, -256_000], [128_000, 192_000, 256_000]), height: h(48, 1200), members: { amps: 40, connector: 'j1772' }, symbol: 'ev' },
  // FS_plumbing
  { id: 'toilet', label: 'Toilet', aliases: ['water closet', 'wc'], system: 'plumbing', extension: 'FS_plumbing', collection: 'fixtures', mount: 'floorWall', box: box([0, -243_200, 0], [896_000, 243_200, 1_024_000]), members: { fixture: 'waterCloset', supply: ['cold'] }, symbol: 'toilet' },
  { id: 'lavatory', label: 'Lavatory', aliases: ['basin', 'bathroom sink', 'vanity'], system: 'plumbing', extension: 'FS_plumbing', collection: 'fixtures', mount: 'wall', box: box([0, -320_000, -256_000], [640_000, 320_000, 0]), height: h(32, 800), members: { fixture: 'lavatory', supply: ['cold', 'hot'] }, symbol: 'basin' },
  { id: 'kitchenSink', label: 'Kitchen sink', aliases: ['sink'], system: 'plumbing', extension: 'FS_plumbing', collection: 'fixtures', mount: 'wall', box: box([0, -416_000, -256_000], [704_000, 416_000, 0]), height: h(36, 900), members: { fixture: 'kitchenSink', supply: ['cold', 'hot'] }, symbol: 'basin' },
  { id: 'shower', label: 'Shower', aliases: [], system: 'plumbing', extension: 'FS_plumbing', collection: 'fixtures', mount: 'floorWall', box: box([0, -585_216, 0], [1_170_432, 585_216, 2_438_400]), members: { fixture: 'shower', supply: ['cold', 'hot'] }, symbol: 'shower' },
  { id: 'bathtub', label: 'Bathtub', aliases: ['tub', 'bath'], system: 'plumbing', extension: 'FS_plumbing', collection: 'fixtures', mount: 'floorWall', box: box([0, -975_360, 0], [975_360, 975_360, 650_240]), members: { fixture: 'bathtub', supply: ['cold', 'hot'] }, symbol: 'tub' },
  { id: 'waterHeater', label: 'Water heater', aliases: ['heater', 'hot water heater'], system: 'plumbing', extension: 'FS_plumbing', collection: 'waterHeaters', mount: 'floor', box: box([-358_400, -358_400, 0], [358_400, 358_400, 1_920_000]), members: { heater: 'storage', energy: 'electric' }, symbol: 'heater' },
  { id: 'floorDrain', label: 'Floor drain', aliases: ['drain'], system: 'plumbing', extension: 'FS_plumbing', collection: 'drains', mount: 'floor', box: box([-96_000, -96_000, -12_800], [96_000, 96_000, 0]), members: { receptor: 'floor' }, symbol: 'drain' },
  // FS_mechanical
  { id: 'furnace', label: 'Furnace', aliases: [], system: 'mechanical', extension: 'FS_mechanical', collection: 'equipment', mount: 'floor', box: box([-358_400, -358_400, 0], [358_400, 358_400, 1_792_000]), members: { equipment: 'furnace', fuel: 'electric' }, symbol: 'equipment' },
  { id: 'airHandler', label: 'Air handler', aliases: ['ahu'], system: 'mechanical', extension: 'FS_mechanical', collection: 'equipment', mount: 'floor', box: box([-320_000, -320_000, 0], [320_000, 320_000, 1_536_000]), members: { equipment: 'airHandler' }, symbol: 'equipment' },
  { id: 'supply', label: 'Supply register', aliases: ['supply', 'register', 'diffuser'], system: 'mechanical', extension: 'FS_mechanical', collection: 'terminals', mount: 'floor', box: box([-192_000, -64_000, -25_600], [192_000, 64_000, 0]), members: { terminal: 'supply' }, symbol: 'supply' },
  { id: 'return', label: 'Return grille', aliases: ['return'], system: 'mechanical', extension: 'FS_mechanical', collection: 'terminals', mount: 'wall', box: box([0, -256_000, -192_000], [25_600, 256_000, 192_000]), height: h(12, 300), members: { terminal: 'return' }, symbol: 'return' },
  { id: 'exhaustFan', label: 'Exhaust fan', aliases: ['bath fan', 'fan', 'exhaust'], system: 'mechanical', extension: 'FS_mechanical', collection: 'exhaust', mount: 'ceiling', box: box([-166_400, -166_400, -192_000], [166_400, 166_400, 0]), members: { exhaust: 'bathFan', discharge: 'outdoors' }, symbol: 'exhaust' },
  { id: 'gasRange', label: 'Gas range', aliases: ['range', 'stove', 'gas appliance'], system: 'mechanical', extension: 'FS_mechanical', collection: 'gasAppliances', mount: 'floorWall', box: box([0, -486_400, 0], [832_000, 486_400, 1_177_600]), members: { appliance: 'range', fuel: 'naturalGas', vent: 'none', combustionAir: 'indoor' }, symbol: 'range' },
  // FS_lowvoltage
  { id: 'dataOutlet', label: 'Data outlet', aliases: ['data', 'ethernet', 'network jack'], system: 'lowvoltage', extension: 'FS_lowvoltage', collection: 'outlets', mount: 'wall', box: PLATE, height: h(12, 300), members: { media: ['data'] }, symbol: 'data' },
  { id: 'coaxOutlet', label: 'Coax outlet', aliases: ['coax', 'tv', 'cable'], system: 'lowvoltage', extension: 'FS_lowvoltage', collection: 'outlets', mount: 'wall', box: PLATE, height: h(12, 300), members: { media: ['coax'] }, symbol: 'data' },
  { id: 'headEnd', label: 'Structured media panel', aliases: ['head-end', 'head end', 'media panel'], system: 'lowvoltage', extension: 'FS_lowvoltage', collection: 'headEnds', mount: 'wall', box: box([0, -230_400, -576_000], [128_000, 230_400, 576_000]), height: h(60, 1500), members: { headEnd: 'structuredMedia', serves: ['data', 'coax'] }, symbol: 'headEnd' },
];

export const kindById = (id: string): DeviceKind | undefined => DEVICE_KINDS.find((k) => k.id === id);
export const kindsOf = (system: SystemId): DeviceKind[] => DEVICE_KINDS.filter((k) => k.system === system);

/** A wall-mounted kind's default height in the project's units. */
export const defaultHeight = (kind: DeviceKind, units: UnitSystem): number => (kind.height === undefined ? 0 : kind.height[units]);

/** Options a receptacle is placed with (the draw panel's toggles). */
export interface ReceptacleOptions {
  gfci: boolean;
  afci: boolean;
  usb: boolean;
  /** A 240 V receptacle: a range or dryer outlet, 30 A, one socket. */
  v240: boolean;
}

export const NO_OPTIONS: ReceptacleOptions = { gfci: false, afci: false, usb: false, v240: false };

/** The members a new element of `kind` starts with, the receptacle options applied. */
export function membersFor(kind: DeviceKind, options: ReceptacleOptions = NO_OPTIONS): Record<string, unknown> {
  const members: Record<string, unknown> = structuredClone(kind.members);
  if (kind.collection !== 'receptacles') return members;
  const features = (['gfci', 'afci', 'usb'] as const).filter((f) => options[f]);
  if (features.length > 0) members['features'] = features;
  if (options.v240) Object.assign(members, { volts: 240, amps: 30, outlets: 1 });
  return members;
}

type Json = Record<string, unknown>;

/**
 * The catalogue kind an element is, read from its collection and the member that says what it is
 * (a fixture's `fixture`, equipment's `equipment` …) — or a generic one for the rest of its
 * collection; null for an element of an extension the editor does not know.
 */
export function kindOfElement(extension: string, collection: string, element: Json): DeviceKind | null {
  const candidates = DEVICE_KINDS.filter((k) => k.extension === extension && k.collection === collection);
  if (candidates.length === 0) return null;
  const discriminant = ['fixture', 'equipment', 'terminal', 'exhaust', 'appliance', 'media', 'headEnd'].find((m) => element[m] !== undefined);
  if (discriminant !== undefined) {
    const value = element[discriminant];
    const exact = candidates.find((k) => JSON.stringify(k.members[discriminant]) === JSON.stringify(value));
    if (exact !== undefined) return exact;
    if (Array.isArray(value)) {
      const first = candidates.find((k) => Array.isArray(k.members[discriminant]) && (k.members[discriminant] as unknown[]).some((m) => value.includes(m)));
      if (first !== undefined) return first;
    }
  }
  return candidates[0] ?? null;
}

/** "Receptacle", "Toilet", or the collection's singular for a kind the catalogue does not name. */
export function kindLabel(extension: string, collection: string, element: Json): string {
  const kind = kindOfElement(extension, collection, element);
  if (kind === null) return collection;
  if (collection === 'fixtures' && typeof element['fixture'] === 'string' && kind.members['fixture'] !== element['fixture']) return words(element['fixture']);
  if (collection === 'equipment' && typeof element['equipment'] === 'string' && kind.members['equipment'] !== element['equipment']) return words(element['equipment']);
  return kind.label;
}

/** `kitchenSink` → `Kitchen sink`. */
export function words(camel: string): string {
  const spaced = camel.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
