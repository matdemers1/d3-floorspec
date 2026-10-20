/**
 * Trade modes (FLR-T-18.3): a mode is a trade's view of the plan — a preset of layer states. Each
 * of the plan's layers is On (drawn as usual), Ghost (drawn in grey at reduced contrast, as
 * context, and not selectable in the editor) or Off. Construction, Decorator, Electrical, Plumbing,
 * Mechanical, Low-voltage and Landscape, after Revit's disciplines and Chief Architect's layer sets.
 * `beams` (FLR-T-15.5) is where exterior lights' light lands — a picture, not a calculation — on in
 * the Electrical and Landscape modes. `outdoor` (FLR-T-15.2) is FS_outdoor's rooms outdoors: on in Landscape mode,
 * ghosted in the Decorator and Electrical modes as the garden is. `context` (FLR-T-15.3) is FS_context's street,
 * neighbours and trees beyond the lot, in its neutral style: on in Landscape mode, off in every other.
 *
 * One table for every place a plan is drawn, so a mode means the same thing everywhere: the editor's
 * canvas and its switcher, `renderPlan` (floorspec_render's `mode`), and the PDF and DXF drawings
 * (an electrical plan, a furniture plan). Pure data: nothing here reads the document.
 */

export const MODE_IDS = ['construction', 'decorator', 'electrical', 'plumbing', 'mechanical', 'lowvoltage', 'landscape'] as const;
export type ModeId = (typeof MODE_IDS)[number];

/** The plan's layers a mode sets, in the order the Layers drawer lists them. */
export const PLAN_LAYERS = ['walls', 'openings', 'rooms', 'furniture', 'casework', 'dimensions', 'roof', 'electrical', 'beams', 'plumbing', 'mechanical', 'lowvoltage', 'site', 'contours', 'grading', 'spots', 'landscape', 'outdoor', 'context', 'findings'] as const;
export type PlanLayer = (typeof PLAN_LAYERS)[number];

export const LAYER_STATES = ['on', 'ghost', 'off'] as const;
export type LayerState = (typeof LAYER_STATES)[number];
export type LayerStates = Readonly<Record<PlanLayer, LayerState>>;

export const LAYER_LABELS: Readonly<Record<PlanLayer, string>> = {
  walls: 'Walls',
  openings: 'Openings',
  rooms: 'Floors',
  furniture: 'Furniture',
  casework: 'Casework',
  dimensions: 'Dimensions',
  roof: 'Stairs & roofs',
  electrical: 'Electrical',
  beams: 'Beams',
  plumbing: 'Plumbing',
  mechanical: 'Mechanical',
  lowvoltage: 'Low-voltage',
  site: 'Boundary',
  contours: 'Contours',
  grading: 'Cut and fill',
  spots: 'Spot levels',
  landscape: 'Landscape',
  outdoor: 'Outdoor',
  context: 'Context',
  findings: 'Findings',
};

export interface ModeDef {
  readonly id: ModeId;
  readonly label: string;
  /** What it shows, in a few words: the mode menu's second line. */
  readonly summary: string;
  /** What a drawing in this mode is called: "Electrical plan". */
  readonly plan: string;
  readonly layers: LayerStates;
}

const states = (on: readonly PlanLayer[], ghost: readonly PlanLayer[]): LayerStates =>
  Object.fromEntries(PLAN_LAYERS.map((l) => [l, on.includes(l) ? 'on' : ghost.includes(l) ? 'ghost' : 'off'])) as Record<PlanLayer, LayerState>;

export const MODES: Readonly<Record<ModeId, ModeDef>> = {
  construction: {
    id: 'construction',
    label: 'Construction',
    summary: 'Walls by type, openings, structure, dimensions',
    plan: 'Construction plan',
    layers: states(['walls', 'openings', 'rooms', 'dimensions', 'roof', 'findings'], ['casework', 'electrical', 'plumbing', 'mechanical', 'lowvoltage']),
  },
  decorator: {
    id: 'decorator',
    label: 'Decorator',
    summary: 'Floors in colour, furniture, finishes, rugs',
    plan: 'Furniture plan',
    layers: states(['openings', 'rooms', 'furniture', 'casework', 'findings'], ['walls', 'plumbing', 'landscape', 'outdoor']),
  },
  electrical: {
    id: 'electrical',
    label: 'Electrical',
    summary: 'Devices, circuits by colour, switch legs, beams',
    plan: 'Electrical plan',
    layers: states(['electrical', 'beams', 'findings'], ['walls', 'openings', 'rooms', 'furniture', 'casework', 'landscape', 'outdoor']),
  },
  plumbing: {
    id: 'plumbing',
    label: 'Plumbing',
    summary: 'Fixtures, stacks, supply and drain runs',
    plan: 'Plumbing plan',
    layers: states(['plumbing', 'findings'], ['walls', 'openings', 'rooms', 'casework']),
  },
  mechanical: {
    id: 'mechanical',
    label: 'Mechanical',
    summary: 'Equipment, registers, gas, ducts',
    plan: 'Mechanical plan',
    layers: states(['mechanical', 'findings'], ['walls', 'openings', 'rooms', 'casework', 'plumbing']),
  },
  lowvoltage: {
    id: 'lowvoltage',
    label: 'Low-voltage',
    summary: 'Data, coax, speakers, security',
    plan: 'Low-voltage plan',
    layers: states(['lowvoltage', 'findings'], ['walls', 'openings', 'rooms', 'furniture', 'electrical']),
  },
  landscape: {
    id: 'landscape',
    label: 'Landscape',
    summary: 'Site, paving, lawn, planting, exterior lights',
    plan: 'Landscape plan',
    layers: states(['site', 'contours', 'grading', 'spots', 'landscape', 'outdoor', 'context', 'beams', 'findings'], ['walls', 'openings', 'rooms', 'roof']),
  },
};

/** Every layer on: the plan as it was before modes, and what a drawing without a mode shows. */
export const ALL_ON: LayerStates = states(PLAN_LAYERS, []);

export const isModeId = (v: unknown): v is ModeId => typeof v === 'string' && (MODE_IDS as readonly string[]).includes(v);
export const isLayerState = (v: unknown): v is LayerState => v === 'on' || v === 'ghost' || v === 'off';

/** A mode's states with some layers set otherwise; unknown layers and states are ignored. */
export function layerStates(mode: ModeId | null | undefined, overrides?: Readonly<Partial<Record<string, unknown>>>): LayerStates {
  const base = mode === null || mode === undefined ? ALL_ON : MODES[mode].layers;
  if (overrides === undefined) return base;
  const out: Record<PlanLayer, LayerState> = { ...base };
  for (const l of PLAN_LAYERS) {
    const v = overrides[l];
    if (isLayerState(v)) out[l] = v;
  }
  return out;
}

/**
 * The layer an extension element belongs to: its trade. FS_lighting's luminaires are electrical;
 * FS_furniture's casework and appliances are the casework, its pieces the furniture. An element of an
 * extension no mode knows has no layer (null): it is drawn whatever the mode.
 */
export function layerOfElement(extension: string, collection: string): PlanLayer | null {
  switch (extension) {
    case 'FS_electrical':
    case 'FS_lighting':
      return 'electrical';
    case 'FS_plumbing':
      return 'plumbing';
    case 'FS_mechanical':
      return 'mechanical';
    case 'FS_lowvoltage':
      return 'lowvoltage';
    case 'FS_landscape':
      return 'landscape';
    // FS_outdoor (FLR-T-15.2): pools, fences, shelters, kitchens and fires — the Outdoor layer.
    case 'FS_outdoor':
      return 'outdoor';
    // FS_site has no elements; its drawing is the site, contours, grading and spots layers.
    case 'FS_furniture':
      return collection === 'casework' || collection === 'appliances' ? 'casework' : 'furniture';
    default:
      return null;
  }
}
