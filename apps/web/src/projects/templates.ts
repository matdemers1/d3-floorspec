import threeRoomHouse from './templates/three-room-house.floorspec.json?raw';
// The standard's starter templates (FLR-REQ-078), vendored with the rest of the standard by
// packages/engine's sync-standard at the commit standard/LOCK.json names. Each is also a Core 0.3
// conformance example (examples/004-006), so the engine's suite checks the very file a project starts from.
import ranch from '../../../../packages/engine/standard/templates/ranch.floorspec.json?raw';
import twoStorey from '../../../../packages/engine/standard/templates/two-storey.floorspec.json?raw';
import cabin from '../../../../packages/engine/standard/templates/cabin.floorspec.json?raw';

/**
 * The templates a new project can start from.
 *
 * The three-room house is the conformance suite's Phase 1 house
 * (`conformance/core/0.1/examples/001-three-room-house`), bundled as its canonical form and declared
 * Core 0.3, as every new project is. The ranch, the two-storey house and the cabin are the standard's
 * starter templates (`templates/` in the standard), as the standard publishes them. A template is
 * loaded into a new project as Floorspec Ops — every change is an op (FLR-ADR-008): the project is
 * created blank, then the template is applied as one batch (fromDocument.ts) at
 * `POST /api/projects/:id/ops`.
 */
export const TEMPLATES_LOADABLE = true as boolean;

export interface Template {
  id: string;
  name: string;
  /** A Floorspec document as text, or null for the blank project. */
  document: string | null;
  blurb: string;
}

export const TEMPLATES: readonly Template[] = [
  {
    id: 'three-room-house',
    name: 'Three-room house',
    document: threeRoomHouse,
    blurb: 'The conformance example: living, kitchen and bedroom.',
  },
  {
    id: 'ranch',
    name: 'Ranch',
    document: ranch,
    blurb: 'One storey: three bedrooms, two baths, a great room, a den and a two-car garage under a hip roof.',
  },
  {
    id: 'two-storey',
    name: 'Two-storey house',
    document: twoStorey,
    blurb: 'Living, dining, kitchen and family room down; an L stair to three bedrooms and a vaulted primary suite up.',
  },
  {
    id: 'cabin',
    name: 'Cabin',
    document: cabin,
    blurb: 'A double-height living room under a shed roof, a bedroom and bath, and a sleeping loft up a straight stair.',
  },
  {
    id: 'blank',
    name: 'Blank',
    document: null,
    blurb: 'An empty Floorspec document',
  },
];
