/**
 * A house-area measure after ANSI Z765-2021, "Single-Family Residential Buildings — Square Footage —
 * Method for Calculating" (FLR-T-7.6). This is an application measure of D3 Floorspec, not part of
 * the Floorspec standard: no chapter of Core defines it, and it is never a conformance value.
 *
 * The method is paraphrased here from general knowledge of the standard and cited by name and
 * edition only; its text is not reproduced. As this module reads it:
 *
 * - finished area is measured to the exterior finished surfaces of the outside walls, level by
 *   level, and reported as finished area above grade and finished area below grade, never added
 *   together; a level any part of whose floor is below grade is below grade;
 * - finished area is enclosed space suitable for year-round use, finished like the rest of the
 *   house; garages and unfinished spaces are not finished area;
 * - a finished space counts only where its ceiling is at least 7 ft high; under a sloped ceiling,
 *   no part lower than 5 ft counts, and at least half of what counts must be 7 ft or higher;
 * - an opening to the floor below (a two-storey foyer) is not floor area of the upper level, but a
 *   stair is counted on the level it descends from;
 * - the result is rounded to the nearest whole square foot.
 *
 * Simplifications, each because Floorspec's data does not say more, or to keep the measure exact:
 *
 * 1. Grade is one elevation, the project's datum 0 unless `grade` is given: Floorspec has no
 *    terrain. A level whose floor elevation is below grade is below grade, whole.
 * 2. The exterior outline of a level is the outside of its walls as Core derives it — the boundary
 *    of the unbounded face (Core §6.1, §6.2) — for every group of walls that encloses a room or a
 *    face; a free-standing wall that encloses nothing is not floor area.
 * 3. Unfinished space is a room whose function is `garage` or `exterior` (porches, decks), unless
 *    `unfinished` names other functions. Every other room is taken to be finished and heated:
 *    Floorspec Core does not record finish quality or heating.
 * 4. An unfinished room is subtracted by its net area (Core §6.4), inside its walls; the walls
 *    between it and finished space stay in the finished area.
 * 5. Ceiling height is a room's ceiling as Core derives it (Core §15) minus the top of its floor.
 *    A flat ceiling's height is uniform. A tray ceiling is taken at its border, its lowest part. A
 *    vaulted ceiling's area at or above 5 ft and at or above 7 ft is computed exactly, half-plane
 *    by half-plane, from its ridge and pitch; a room that fails the one-half test is left out whole,
 *    and otherwise only its part under 5 ft is left out. The test is applied room by room.
 * 6. On a level with another level of the building below it, a bounded face with no room in it
 *    (Core §6.3) is read as open to the floor below and left out — unless the head of a stair
 *    rising to the level is in it, when it is the stair's well and counts on the level the stair
 *    descends from. A face meant as floor area should be named as a room. On the lowest level such
 *    a face counts.
 * 7. Exact to the last step: areas are kept as exact numbers (integers and one square root for a
 *    vault) and rounded once — the base-unit area to an integer, square feet to a whole number.
 */
import { evaluate, type ValidateOptions } from '../validate/validate.js';
import { resolve, StairContext } from '../stairs/stairs.js';
import { Surd } from '../exact/surd.js';
import { toSafeNumber } from '../exact/bigint.js';
import { area2, locate, type IPoint } from '../geometry/predicates.js';
import { entries, get, type FloorspecDocument, type VaultedCeiling } from '../model/document.js';
import { ceilingBase, ceilingOf, floorTop } from '../slabs/floors.js';

/** The method this measure follows, as cited. */
export const Z765_CITATION = 'ANSI Z765-2021 (paraphrased; a D3 Floorspec application measure, not part of the Floorspec standard)';

/** One foot in base units: 304.8 mm × 1,280. */
export const FOOT = 390_144n;
const SQ_FT2 = 2n * FOOT * FOOT; // twice a square foot, in square base units
const SEVEN_FT = 7n * FOOT;
const FIVE_FT = 5n * FOOT;

export interface Z765Options extends Pick<ValidateOptions, 'core' | 'extensions' | 'knownExtensions'> {
  /** The elevation of grade, in base units (default 0, the project's datum). */
  readonly grade?: number;
  /** Room functions that are not finished area (default `garage` and `exterior`). */
  readonly unfinished?: readonly string[];
}

export interface Z765Level {
  level: string;
  aboveGrade: boolean;
  /** Area inside the exterior outline, square feet (rounded for display). */
  grossSqFt: number;
  /** Left out: unfinished rooms, low ceilings, and openings to the floor below, square feet (rounded for display). */
  unfinishedSqFt: number;
  lowCeilingSqFt: number;
  openToBelowSqFt: number;
  /** Finished area, rounded once: square base units, and whole square feet. */
  finishedArea: number;
  finishedSqFt: number;
  /** The rooms left out or cut back, and why. */
  excluded: { id: string; reason: 'unfinished' | 'ceilingUnder7ft' | 'slopedUnder5ft' | 'slopedLessThanHalfAt7ft' | 'openToBelow' }[];
}

export interface Z765Building {
  building: string;
  /** Finished area above grade and below grade, each rounded once to whole square feet. */
  aboveGradeSqFt: number;
  belowGradeSqFt: number;
  levels: Z765Level[];
}

export interface Z765Result {
  method: string;
  buildings: Z765Building[];
}

const sqft = (a2: Surd): number => toSafeNumber(a2.divInt(SQ_FT2).round());

/** The area (twice) of the part of a ring where s · c(P) ≤ K, by Sutherland–Hodgman on one half-plane; c is integral on the ring's points. */
function clippedArea2(ring: readonly IPoint[], c: (p: IPoint) => bigint, s: bigint, K: Surd): Surd {
  type SP = { x: Surd; y: Surd };
  const out: SP[] = [];
  const v = (p: IPoint): Surd => Surd.of(s * c(p)).sub(K);
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const p = ring[i]!;
    const q = ring[(i + 1) % n]!;
    const vp = v(p);
    const vq = v(q);
    const pin = vp.sign() <= 0;
    const qin = vq.sign() <= 0;
    if (pin) out.push({ x: Surd.of(p[0]), y: Surd.of(p[1]) });
    if (pin !== qin) {
      // t = vp / (vp − vq), and vp − vq = s · (c(p) − c(q)) is an integer.
      const den = s * (c(p) - c(q));
      const t = vp.divInt(den);
      out.push({ x: t.mulInt(q[0] - p[0]).addInt(p[0]), y: t.mulInt(q[1] - p[1]).addInt(p[1]) });
    }
  }
  let a = Surd.ZERO;
  for (let i = 0; i < out.length; i++) {
    const p = out[i]!;
    const q = out[(i + 1) % out.length]!;
    a = a.add(p.x.mul(q.y).sub(q.x.mul(p.y)));
  }
  return a;
}

/** The area (twice) of a room polygon where a vaulted ceiling is at least `h` above the floor at `floor`. */
function vaultAreaAtLeast(rings: readonly IPoint[][], total2: bigint, c: VaultedCeiling, base: bigint, floor: bigint, h: bigint): Surd {
  const room = base - floor - h;
  if (room < 0n) return Surd.ZERO;
  const [[ax, ay], [bx, by]] = c.ridge;
  const dx = BigInt(bx - ax);
  const dy = BigInt(by - ay);
  const D = dx * dx + dy * dy;
  // f(P) ≤ (base − floor − h) · run · √D / rise, where f is the fall of Core §15.3.
  const K = Surd.sqrt(D).mulInt(room * BigInt(c.pitch.run)).divInt(BigInt(c.pitch.rise));
  const cross = (p: IPoint): bigint => dx * (p[1] - BigInt(ay)) - dy * (p[0] - BigInt(ax));
  const sum = (s: bigint): Surd => rings.reduce((acc, r) => acc.add(clippedArea2(r, cross, s, K)), Surd.ZERO);
  const slopes = c.slopes ?? 'both';
  if (slopes === 'left') return sum(1n);
  if (slopes === 'right') return sum(-1n);
  // |c| ≤ K is {c ≤ K} ∩ {−c ≤ K}, whose union is the whole room (K ≥ 0).
  return sum(1n).add(sum(-1n)).sub(Surd.of(total2));
}

/**
 * The finished area of every level and building of a valid document, after ANSI Z765-2021 as
 * paraphrased above. Throws when the document is not valid.
 */
export function z765(input: string | Uint8Array | object, options: Z765Options = {}): Z765Result {
  const ev = evaluate(input, options);
  if (!ev.valid || !ev.document || !ev.analysis) throw new Error('z765: the document is not valid');
  const doc: FloorspecDocument = ev.document;
  const analysis = ev.analysis;
  const stairs = new StairContext(doc, analysis.levels);
  const grade = BigInt(options.grade ?? 0);
  const unfinished = new Set(options.unfinished ?? ['garage', 'exterior']);

  const buildings: Z765Building[] = [];
  for (const [bid] of entries(doc.buildings)) {
    const levels = entries(doc.levels).filter(([, l]) => l.building === bid);
    const out: Z765Level[] = [];
    let above = Surd.ZERO;
    let below = Surd.ZERO;
    for (const [lid, L] of levels) {
      const g = analysis.levels.get(lid)?.geometry;
      const la = analysis.levels.get(lid)!;
      if (!g) continue;
      const excluded: Z765Level['excluded'] = [];
      // Gross: inside the outside faces of every group of walls that encloses something.
      const enclosing = new Set(g.faces.map((f) => f.outer.component));
      let gross2 = 0n;
      for (const c of g.graph.unbounded) if (enclosing.has(c.component)) {
        const a = area2(g.ring(c));
        gross2 += a < 0n ? -a : a;
      }
      let unfin2 = 0n;
      let low = Surd.ZERO;
      for (const [rid, face] of [...la.roomFaces].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        const room = get(doc.rooms, rid)!;
        const p = g.roomPolygon(g.faces[face]!);
        if (unfinished.has(room.function ?? 'unspecified')) {
          unfin2 += p.area2;
          excluded.push({ id: rid, reason: 'unfinished' });
          continue;
        }
        const floor = floorTop(doc, room);
        const ceiling = ceilingOf(room);
        const base = ceilingBase(doc, room);
        if (ceiling.kind !== 'vaulted') {
          if (base - floor < SEVEN_FT) {
            low = low.add(Surd.of(p.area2));
            excluded.push({ id: rid, reason: 'ceilingUnder7ft' });
          }
          continue;
        }
        const rings = [p.outer, ...p.holes];
        const at5 = vaultAreaAtLeast(rings, p.area2, ceiling, base, floor, FIVE_FT);
        const at7 = vaultAreaAtLeast(rings, p.area2, ceiling, base, floor, SEVEN_FT);
        if (at7.mulInt(2n).cmp(at5) < 0) {
          low = low.add(Surd.of(p.area2));
          excluded.push({ id: rid, reason: 'slopedLessThanHalfAt7ft' });
        } else if (at5.cmp(Surd.of(p.area2)) < 0) {
          low = low.add(Surd.of(p.area2).sub(at5));
          excluded.push({ id: rid, reason: 'slopedUnder5ft' });
        }
      }
      // Open to below: an unanchored face on a level with a level of the building under it.
      let open2 = 0n;
      const hasBelow = levels.some(([, l]) => l.elevation < L.elevation);
      if (hasBelow) {
        const heads = entries(doc.stairs)
          .filter(([, st]) => st.to === lid)
          .map(([, st]) => resolve(stairs, st).head);
        const anchored = new Set(la.roomFaces.values());
        g.faces.forEach((f, i) => {
          if (anchored.has(i)) return;
          const p = g.roomPolygon(f);
          if (p.degenerate) return;
          if (heads.some((h) => locate(h, p.outer) !== 'outside')) return; // a stair's well: counted where the stair descends from
          open2 += p.area2;
          excluded.push({ id: `face@${p.outer[0]![0]},${p.outer[0]![1]}`, reason: 'openToBelow' });
        });
      }
      let finished = Surd.of(gross2 - unfin2 - open2).sub(low);
      if (finished.sign() < 0) finished = Surd.ZERO;
      const isAbove = BigInt(L.elevation) >= grade;
      if (isAbove) above = above.add(finished);
      else below = below.add(finished);
      out.push({
        level: lid,
        aboveGrade: isAbove,
        grossSqFt: sqft(Surd.of(gross2)),
        unfinishedSqFt: sqft(Surd.of(unfin2)),
        lowCeilingSqFt: sqft(low),
        openToBelowSqFt: sqft(Surd.of(open2)),
        finishedArea: toSafeNumber(finished.divInt(2n).round()),
        finishedSqFt: sqft(finished),
        excluded,
      });
    }
    buildings.push({ building: bid, aboveGradeSqFt: sqft(above), belowGradeSqFt: sqft(below), levels: out });
  }
  return { method: Z765_CITATION, buildings };
}
