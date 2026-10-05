import threeRoomHouse from './templates/three-room-house.floorspec.json?raw';

/**
 * The templates a new project can start from.
 *
 * Phase 3 ships one real house: the conformance suite's three-room house
 * (`conformance/core/0.1/examples/001-three-room-house`, vendored in the engine), bundled as its
 * canonical form. A template is loaded into a new project as Floorspec Ops — every change is an op
 * (FLR-ADR-008): the project is created blank, then the template is applied as one batch
 * (fromDocument.ts) at `POST /api/projects/:id/ops`.
 */
export const TEMPLATES_LOADABLE = true as boolean;

export interface Template {
  id: string;
  name: string;
  /** A Floorspec document as text (its canonical form), or null for the blank project. */
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
    id: 'blank',
    name: 'Blank',
    document: null,
    blurb: 'An empty Floorspec document',
  },
];
