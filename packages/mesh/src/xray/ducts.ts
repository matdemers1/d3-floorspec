/**
 * FS_mechanical in X-ray (FLR-T-14.5): a duct from each piece of equipment to every supply and return
 * terminal that names it (FS_mechanical §3.2). FS_mechanical 0.1 records which equipment serves a
 * terminal, not where its duct runs, so X-ray routes it: up from the top of the equipment to the
 * ceiling's joist space over the terminal's level (1″ above its ceiling) — or down to the floor's, for
 * a terminal whose middle is within a metre of its floor — east–west then north–south, and down to
 * the top of a ceiling register (or up to the bottom of a floor grille). A supply branch is drawn
 * 8″ × 6″, a return 14″ × 8″. A transfer grille has no duct.
 */
import type { Derived, FloorspecDocument } from '@floorspec/engine';
import { INCH } from './frames.js';
import { collection, levelOf, locate, plan, str } from './elements.js';
import { simplify, squareRoute } from './routes.js';
import type { P3, XrayPiece, XrayRun } from './types.js';

const SECTIONS = { supply: { width: 8 * INCH, height: 6 * INCH }, return: { width: 14 * INCH, height: 8 * INCH } } as const;
/** A terminal within this of its floor is fed from under the floor. */
const LOW = 1_280_000;

export function ductRuns(doc: FloorspecDocument, derived: Derived): { runs: XrayRun[]; pieces: XrayPiece[] } {
  const runs: XrayRun[] = [];
  const pieces: XrayPiece[] = [];
  for (const [id, t] of collection(doc, 'FS_mechanical', 'terminals')) {
    const kind = t['terminal'];
    const served = str(t['equipment']);
    if ((kind !== 'supply' && kind !== 'return') || served === undefined) continue;
    const at = locate(derived, id);
    const eq = locate(derived, served);
    if (at === null || eq === null) continue;
    const { width, height } = SECTIONS[kind];
    const l = levelOf(doc, at.level);
    // High (a ceiling register): fed from over the ceiling, to its top; low (a floor grille): from under the floor, to its bottom.
    const high = (at.bottom + at.top) / 2 - l.elevation > LOW;
    const zone = high ? l.elevation + l.ceiling + height / 2 + INCH : l.elevation - height / 2 - INCH;
    const a = plan(eq.point);
    const b = plan(at.point);
    const points = simplify<P3>([[a[0], a[1], eq.top], [a[0], a[1], zone], ...squareRoute(a, b, zone), [b[0], b[1], high ? at.top : at.bottom]]);
    if (points.length < 2) continue;
    const run = `${id}:duct`;
    runs.push({ id: run, system: 'ducts', kind, owner: id, size: width, level: at.level, walls: [], points });
    pieces.push({ system: 'ducts', level: at.level, part: kind, owner: run, shape: 'duct', points, width, height });
  }
  return { runs, pieces };
}
