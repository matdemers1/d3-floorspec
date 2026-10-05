/** A part before it is converted to Float32: built from exact points, or by manifold-3d. */
import type { MeshBuilder } from './builder.js';
import type { Manifold } from './kernel.js';
import type { Box3, MeshPart } from './types.js';

type Common = Omit<MeshPart, 'key' | 'mesh' | 'bbox' | 'stats'> & {
  /** Distinguishes several parts of one element and kind (a stair's flights and landings). */
  piece?: string;
};

/** Built from exact points: the box and, for a closed part, the volume come from them. */
export interface ExactPart extends Common {
  exact: MeshBuilder;
}

/**
 * Built by manifold-3d in a local frame: `origin` (base units, integers) is added back to every
 * point. Its exact box is computed from the exact inputs, not read off the result. The manifold
 * belongs to the part, which frees it.
 */
export interface ManifoldPart extends Common {
  manifold: Manifold;
  origin: readonly [number, number, number];
  box: Box3;
}

export type RawPart = ExactPart | ManifoldPart;
