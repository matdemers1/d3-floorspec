/** Sample programs: the documents the tests and the render script lay out. */
import type { Program } from '../src/index.js';
import { BU_PER_FOOT, SQ_BU_PER_SQ_FT } from '../src/index.js';

/** Square feet to square base units (Core §11.1). */
export const sf = (n: number): number => n * SQ_BU_PER_SQ_FT;

/** An empty Core 0.2 house: one building, the given levels, and the program. */
export function house(name: string, program: Program, levels: Record<string, number> = { L1: 0 }): Record<string, unknown> {
  const ls: Record<string, unknown> = {};
  for (const [id, storey] of Object.entries(levels)) ls[id] = { building: 'B1', elevation: storey * 9 * BU_PER_FOOT, height: 9 * BU_PER_FOOT, name: storey === 0 ? 'Ground floor' : 'Upper floor' };
  return { floorspec: '0.2', project: { name }, buildings: { B1: { name: 'House' } }, levels: ls, program };
}

/** A three-bedroom, two-bath ranch with an attached garage. */
export const RANCH: Program = {
  items: {
    LIV: { function: 'living', name: 'Living room', targetArea: sf(300), minArea: sf(220) },
    KIT: { function: 'kitchen', name: 'Kitchen', targetArea: sf(170), minArea: sf(120) },
    DIN: { function: 'dining', name: 'Dining', targetArea: sf(130), minArea: sf(100) },
    PBR: { function: 'sleeping', name: 'Primary bedroom', targetArea: sf(190), minArea: sf(150) },
    PBA: { function: 'bath', name: 'Primary bath', targetArea: sf(75), minArea: sf(55) },
    WIC: { function: 'storage', name: 'Walk-in closet', targetArea: sf(40), minArea: sf(30) },
    BED: { function: 'sleeping', name: 'Bedroom', count: 2, targetArea: sf(130), minArea: sf(110) },
    BTH: { function: 'bath', name: 'Hall bath', targetArea: sf(50), minArea: sf(40) },
    LAU: { function: 'laundry', name: 'Laundry', targetArea: sf(50), minArea: sf(35) },
    GAR: { function: 'garage', name: 'Garage', targetArea: sf(460), minArea: sf(400) },
  },
  adjacency: [
    { a: 'KIT', b: 'DIN', kind: 'required', weight: 8 },
    { a: 'PBR', b: 'PBA', kind: 'required', weight: 9 },
    { a: 'PBR', b: 'WIC', kind: 'required', weight: 6 },
    { a: 'LIV', b: 'DIN', kind: 'preferred', weight: 6 },
    { a: 'KIT', b: 'LIV', kind: 'preferred', weight: 4 },
    { a: 'LAU', b: 'GAR', kind: 'preferred', weight: 4 },
    { a: 'GAR', b: 'PBR', kind: 'forbidden', weight: 7 },
    { a: 'GAR', b: 'BED', kind: 'forbidden', weight: 7 },
  ],
};

/** A one-bedroom cabin. */
export const CABIN: Program = {
  items: {
    GRT: { function: 'living', name: 'Great room', targetArea: sf(260), minArea: sf(200) },
    KIT: { function: 'kitchen', name: 'Kitchen', targetArea: sf(110), minArea: sf(80) },
    BED: { function: 'sleeping', name: 'Bedroom', targetArea: sf(130), minArea: sf(100) },
    BTH: { function: 'bath', name: 'Bath', targetArea: sf(45), minArea: sf(35) },
  },
  adjacency: [
    { a: 'KIT', b: 'GRT', kind: 'required', weight: 8 },
    { a: 'BED', b: 'BTH', kind: 'preferred', weight: 5 },
    { a: 'KIT', b: 'BED', kind: 'forbidden', weight: 3 },
  ],
};

/** A two-storey family house: living spaces preferred downstairs, bedrooms upstairs. */
export const TWO_STOREY: Program = {
  items: {
    LIV: { function: 'living', name: 'Family room', targetArea: sf(320), level: 'L1' },
    KIT: { function: 'kitchen', name: 'Kitchen', targetArea: sf(190), level: 'L1' },
    DIN: { function: 'dining', name: 'Dining', targetArea: sf(150), level: 'L1' },
    ENT: { function: 'circulation', name: 'Foyer', targetArea: sf(70), level: 'L1' },
    OFF: { function: 'office', name: 'Study', targetArea: sf(120), level: 'L1' },
    PWD: { function: 'bath', name: 'Powder room', targetArea: sf(30), level: 'L1' },
    LAU: { function: 'laundry', name: 'Laundry', targetArea: sf(60), level: 'L1' },
    PBR: { function: 'sleeping', name: 'Primary bedroom', targetArea: sf(210), level: 'L2' },
    PBA: { function: 'bath', name: 'Primary bath', targetArea: sf(90), level: 'L2' },
    BED: { function: 'sleeping', name: 'Bedroom', count: 3, targetArea: sf(130), minArea: sf(110), level: 'L2' },
    BTH: { function: 'bath', name: 'Hall bath', targetArea: sf(55), level: 'L2' },
  },
  adjacency: [
    { a: 'KIT', b: 'DIN', kind: 'required', weight: 9 },
    { a: 'ENT', b: 'LIV', kind: 'required', weight: 6 },
    { a: 'PBR', b: 'PBA', kind: 'required', weight: 9 },
    { a: 'LIV', b: 'KIT', kind: 'preferred', weight: 6 },
    { a: 'OFF', b: 'ENT', kind: 'preferred', weight: 4 },
    { a: 'OFF', b: 'KIT', kind: 'forbidden', weight: 3 },
  ],
};

export const SAMPLES = {
  ranch: () => house('Ranch', RANCH),
  cabin: () => house('Cabin', CABIN),
  'two-storey-ground': () => house('Two-storey', TWO_STOREY, { L1: 0, L2: 1 }),
} as const;
