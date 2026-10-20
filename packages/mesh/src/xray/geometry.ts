/**
 * X-ray's pieces as triangles (FLR-T-14.5): one flat list per system, level and style, so the view
 * draws each system in a handful of meshes (one draw call each) however many studs it has.
 *
 * - A **box** (a stud, a batt, a device box, a duct's segment): twelve triangles, each face's normal.
 * - A **tube** (a pipe, a cable): six sides round its centreline, smooth-shaded, each segment run on
 *   past a bend by its radius so the bends close, and capped at its two ends. A dashed tube (a drain)
 *   is cut into 6″ dashes along its length, every other one drawn in the `dash` style.
 *
 * Arithmetic in base units — + − × ÷ and `Math.sqrt`, a written-out hexagon (½ and √3⁄2) — and one
 * conversion to Float32 metres at the end: the same bytes in Node and in a browser.
 */
import { INCH } from './frames.js';
import { XRAY_SYSTEMS, type FrameBox, type P3, type XrayMesh, type XrayPiece, type XrayStyle } from './types.js';
import { UNITS_PER_METRE, type Vec3 } from '../types.js';

/** A drain's dashes, along it. */
export const DASH = 6 * INCH;

const H = Math.sqrt(3) / 2;
/** The hexagon round a tube: cosines and sines of 0°, 60° … 300°. */
const RING: readonly (readonly [number, number])[] = [
  [1, 0],
  [0.5, H],
  [-0.5, H],
  [-1, 0],
  [-0.5, -H],
  [0.5, -H],
];

type V3 = readonly [number, number, number];
const add = (p: V3, q: V3): V3 => [p[0] + q[0], p[1] + q[1], p[2] + q[2]];
const scale = (p: V3, k: number): V3 => [p[0] * k, p[1] * k, p[2] * k];
const cross = (p: V3, q: V3): V3 => [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]];
const norm = (p: V3): V3 => {
  const l = Math.sqrt(p[0] * p[0] + p[1] * p[1] + p[2] * p[2]);
  return l === 0 ? p : scale(p, 1 / l);
};

/** Triangles being gathered: positions (base units) and normals, three numbers per vertex. */
class Sink {
  readonly p: number[] = [];
  readonly n: number[] = [];
  pieces = 0;
  tri(a: V3, b: V3, c: V3, na: V3, nb: V3, nc: V3): void {
    this.p.push(...a, ...b, ...c);
    this.n.push(...na, ...nb, ...nc);
  }
  quad(a: V3, b: V3, c: V3, d: V3, nrm: V3): void {
    this.tri(a, b, c, nrm, nrm, nrm);
    this.tri(a, c, d, nrm, nrm, nrm);
  }
}

/** A box in its frame: six faces, outward (u × v = z). */
function boxTriangles(s: Sink, b: FrameBox): void {
  const [ux, uy] = b.u;
  const vx = -uy;
  const vy = ux;
  const at = (i: 0 | 1, j: 0 | 1, k: 0 | 1): V3 => {
    const a = b.a[i];
    const bb = b.b[j];
    return [b.o[0] + a * ux + bb * vx, b.o[1] + a * uy + bb * vy, b.z[k]];
  };
  const U: V3 = [ux, uy, 0];
  const V: V3 = [vx, vy, 0];
  s.quad(at(0, 0, 0), at(0, 0, 1), at(0, 1, 1), at(0, 1, 0), scale(U, -1));
  s.quad(at(1, 0, 0), at(1, 1, 0), at(1, 1, 1), at(1, 0, 1), U);
  s.quad(at(0, 0, 0), at(1, 0, 0), at(1, 0, 1), at(0, 0, 1), scale(V, -1));
  s.quad(at(0, 1, 0), at(0, 1, 1), at(1, 1, 1), at(1, 1, 0), V);
  s.quad(at(0, 0, 0), at(0, 1, 0), at(1, 1, 0), at(1, 0, 0), [0, 0, -1]);
  s.quad(at(0, 0, 1), at(1, 0, 1), at(1, 1, 1), at(0, 1, 1), [0, 0, 1]);
}

/** One straight length of tube from p to q, radius r, its ends capped as asked. */
function tubeSegment(s: Sink, p: V3, q: V3, r: number, capP: boolean, capQ: boolean): void {
  const d = norm([q[0] - p[0], q[1] - p[1], q[2] - p[2]]);
  const helper: V3 = Math.abs(d[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const e1 = norm(cross(helper, d));
  const e2 = cross(d, e1);
  const ring = RING.map(([c, sn]) => add(scale(e1, c), scale(e2, sn)));
  for (let k = 0; k < ring.length; k++) {
    const n0 = ring[k]!;
    const n1 = ring[(k + 1) % ring.length]!;
    const p0 = add(p, scale(n0, r));
    const p1 = add(p, scale(n1, r));
    const q0 = add(q, scale(n0, r));
    const q1 = add(q, scale(n1, r));
    s.tri(p0, p1, q1, n0, n1, n1);
    s.tri(p0, q1, q0, n0, n1, n0);
    if (capP) s.tri(p, p1, p0, scale(d, -1), scale(d, -1), scale(d, -1));
    if (capQ) s.tri(q, q0, q1, d, d, d);
  }
}

/** A polyline as tube: each segment run on past a bend by r; dashed, into `dash` every other 6″. */
function tube(solid: Sink, dash: Sink | null, points: readonly P3[], diameter: number): void {
  const r = diameter / 2;
  let s0 = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const p = points[i]!;
    const q = points[i + 1]!;
    const dv: V3 = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
    const len = Math.sqrt(dv[0] * dv[0] + dv[1] * dv[1] + dv[2] * dv[2]);
    if (len === 0) continue;
    const d = scale(dv, 1 / len);
    const first = i === 0;
    const last = i + 2 === points.length;
    const lo = first ? 0 : -r;
    const end = last ? len : len + r;
    if (dash === null) {
      tubeSegment(solid, add(p, scale(d, lo)), add(p, scale(d, end)), r, first, last);
    } else {
      // Cut at every multiple of DASH along the run.
      const cuts = [lo];
      for (let k = Math.ceil((s0 + lo) / DASH); k * DASH < s0 + end; k++) if (k * DASH - s0 > lo) cuts.push(k * DASH - s0);
      cuts.push(end);
      for (let j = 0; j + 1 < cuts.length; j++) {
        const a = cuts[j]!;
        const b = cuts[j + 1]!;
        if (!(b > a)) continue;
        const odd = Math.floor((s0 + (a + b) / 2) / DASH) % 2 === 1;
        tubeSegment(odd ? dash : solid, add(p, scale(d, a)), add(p, scale(d, b)), r, first && j === 0, last && j + 2 === cuts.length);
      }
    }
    s0 += len;
  }
}

/** A polyline as a rectangular duct: a box per segment, run on past a bend by half its section. */
function duct(s: Sink, points: readonly P3[], width: number, height: number): void {
  const ext = Math.max(width, height) / 2;
  for (let i = 0; i + 1 < points.length; i++) {
    const p = points[i]!;
    const q = points[i + 1]!;
    const lo = i === 0 ? 0 : ext;
    const hi = i + 2 === points.length ? 0 : ext;
    if (p[0] === q[0] && p[1] === q[1]) {
      const z0 = Math.min(p[2], q[2]);
      const z1 = Math.max(p[2], q[2]);
      const down = p[2] > q[2];
      boxTriangles(s, { o: [p[0], p[1]], u: [1, 0], a: [-width / 2, width / 2], b: [-height / 2, height / 2], z: [z0 - (down ? hi : lo), z1 + (down ? lo : hi)] });
      continue;
    }
    const dx = q[0] - p[0];
    const dy = q[1] - p[1];
    const len = Math.sqrt(dx * dx + dy * dy);
    boxTriangles(s, { o: [p[0], p[1]], u: [dx / len, dy / len], a: [-lo, len + hi], b: [-width / 2, width / 2], z: [p[2] - height / 2, p[2] + height / 2] });
  }
}

/**
 * The pieces as meshes: one per system, level and style that has any, in the order of XRAY_SYSTEMS,
 * then level, then style; Float32 metres relative to `origin`.
 */
export function meshPieces(pieces: readonly XrayPiece[], origin: Vec3 = [0, 0, 0]): XrayMesh[] {
  const sinks = new Map<string, { system: XrayPiece['system']; level: string; style: XrayStyle; sink: Sink }>();
  const sinkOf = (p: XrayPiece, style: XrayStyle): Sink => {
    const key = `${p.system}\u0000${p.level}\u0000${style}`;
    let s = sinks.get(key);
    if (s === undefined) {
      s = { system: p.system, level: p.level, style, sink: new Sink() };
      sinks.set(key, s);
    }
    return s.sink;
  };
  for (const p of pieces) {
    if (p.shape === 'box') {
      const s = sinkOf(p, p.sheet === true ? 'sheet' : 'solid');
      boxTriangles(s, p.box);
      s.pieces++;
    } else if (p.shape === 'tube') {
      const s = sinkOf(p, 'solid');
      const d = p.dashed === true ? sinkOf(p, 'dash') : null;
      tube(s, d, p.points, p.diameter);
      s.pieces++;
      if (d !== null) d.pieces++;
    } else {
      const s = sinkOf(p, 'solid');
      duct(s, p.points, p.width, p.height);
      s.pieces++;
    }
  }
  const rank = (s: XrayPiece['system']) => XRAY_SYSTEMS.indexOf(s);
  const styles: readonly XrayStyle[] = ['solid', 'dash', 'sheet'];
  return [...sinks.values()]
    .filter((s) => s.sink.p.length > 0)
    .sort((a, b) => rank(a.system) - rank(b.system) || (a.level < b.level ? -1 : a.level > b.level ? 1 : 0) || styles.indexOf(a.style) - styles.indexOf(b.style))
    .map(({ system, level, style, sink }) => {
      const positions = new Float32Array(sink.p.length);
      for (let i = 0; i < sink.p.length; i++) positions[i] = (sink.p[i]! - origin[i % 3]!) / UNITS_PER_METRE;
      return { system, level, style, positions, normals: Float32Array.from(sink.n), pieces: sink.pieces };
    });
}
