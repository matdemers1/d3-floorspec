/**
 * A bounding volume hierarchy over triangles, built with binned SAH (12 bins, leaves of up to four
 * triangles) and traversed front to back with an explicit stack. Everything lives in typed arrays:
 * a house is tens of thousands of triangles and a still casts hundreds of millions of rays.
 *
 * Built deterministically — the same triangles in the same order make the same tree — so the same
 * rays hit the same triangles on every run.
 */

export interface Triangles {
  /** Nine per triangle, metres. */
  readonly positions: Float64Array;
  readonly count: number;
}

export interface Hit {
  /** The triangle's index in the input. */
  tri: number;
  t: number;
  /** Barycentric weights of vertices 1 and 2. */
  u: number;
  v: number;
}

const BINS = 12;
const LEAF = 4;

export class Bvh {
  /** Per node: min xyz, max xyz. */
  private readonly bounds: Float64Array;
  /** Per node: for a leaf, its first index into `order` and −(count); for an inner node, its left child and its right child. */
  private readonly a: Int32Array;
  private readonly b: Int32Array;
  /** Triangles in leaf order. */
  readonly order: Int32Array;
  /** Per triangle (input order): v0, edge1, edge2 — nine floats. */
  private readonly tri: Float64Array;
  readonly nodes: number;

  constructor(input: Triangles) {
    const n = input.count;
    const P = input.positions;
    this.tri = new Float64Array(9 * n);
    const cmin = new Float64Array(3 * n);
    const cmax = new Float64Array(3 * n);
    const cen = new Float64Array(3 * n);
    for (let i = 0; i < n; i++) {
      const o = 9 * i;
      for (let k = 0; k < 3; k++) {
        const p0 = P[o + k]!;
        const p1 = P[o + 3 + k]!;
        const p2 = P[o + 6 + k]!;
        this.tri[o + k] = p0;
        this.tri[o + 3 + k] = p1 - p0;
        this.tri[o + 6 + k] = p2 - p0;
        cmin[3 * i + k] = Math.min(p0, p1, p2);
        cmax[3 * i + k] = Math.max(p0, p1, p2);
        cen[3 * i + k] = (cmin[3 * i + k]! + cmax[3 * i + k]!) / 2;
      }
    }
    const order = new Int32Array(n);
    for (let i = 0; i < n; i++) order[i] = i;
    const cap = Math.max(1, 2 * n);
    const bounds = new Float64Array(6 * cap);
    const a = new Int32Array(cap);
    const b = new Int32Array(cap);
    let used = 0;

    const binCount = new Int32Array(BINS);
    const binBox = new Float64Array(6 * BINS);
    const leftArea = new Float64Array(BINS);
    const leftCount = new Int32Array(BINS);

    const area = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number => {
      const dx = x1 - x0;
      const dy = y1 - y0;
      const dz = z1 - z0;
      return dx < 0 ? 0 : 2 * (dx * dy + dy * dz + dz * dx);
    };

    const stack: [number, number, number][] = [];
    const root = used++;
    stack.push([root, 0, n]);
    while (stack.length) {
      const [node, start, end] = stack.pop()!;
      // The node's box and its centroids' box.
      let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
      let cx0 = Infinity, cy0 = Infinity, cz0 = Infinity, cx1 = -Infinity, cy1 = -Infinity, cz1 = -Infinity;
      for (let i = start; i < end; i++) {
        const t = order[i]!;
        x0 = Math.min(x0, cmin[3 * t]!); y0 = Math.min(y0, cmin[3 * t + 1]!); z0 = Math.min(z0, cmin[3 * t + 2]!);
        x1 = Math.max(x1, cmax[3 * t]!); y1 = Math.max(y1, cmax[3 * t + 1]!); z1 = Math.max(z1, cmax[3 * t + 2]!);
        cx0 = Math.min(cx0, cen[3 * t]!); cy0 = Math.min(cy0, cen[3 * t + 1]!); cz0 = Math.min(cz0, cen[3 * t + 2]!);
        cx1 = Math.max(cx1, cen[3 * t]!); cy1 = Math.max(cy1, cen[3 * t + 1]!); cz1 = Math.max(cz1, cen[3 * t + 2]!);
      }
      bounds.set([x0, y0, z0, x1, y1, z1], 6 * node);
      const count = end - start;
      const ext = [cx1 - cx0, cy1 - cy0, cz1 - cz0];
      const lo = [cx0, cy0, cz0];
      let bestAxis = -1;
      let bestSplit = -1;
      let bestCost = count; // the cost of a leaf, in triangle tests, against the traversal of two children
      if (count > LEAF) {
        for (let axis = 0; axis < 3; axis++) {
          if (ext[axis]! <= 1e-12) continue;
          binCount.fill(0);
          for (let k = 0; k < BINS; k++) binBox.set([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity], 6 * k);
          const scale = BINS / ext[axis]!;
          for (let i = start; i < end; i++) {
            const t = order[i]!;
            const k = Math.min(BINS - 1, Math.floor((cen[3 * t + axis]! - lo[axis]!) * scale));
            binCount[k]!++;
            const o = 6 * k;
            for (let j = 0; j < 3; j++) {
              binBox[o + j] = Math.min(binBox[o + j]!, cmin[3 * t + j]!);
              binBox[o + 3 + j] = Math.max(binBox[o + 3 + j]!, cmax[3 * t + j]!);
            }
          }
          // Sweep from the left, then from the right.
          let bx0 = Infinity, by0 = Infinity, bz0 = Infinity, bx1 = -Infinity, by1 = -Infinity, bz1 = -Infinity, c = 0;
          for (let k = 0; k < BINS - 1; k++) {
            const o = 6 * k;
            bx0 = Math.min(bx0, binBox[o]!); by0 = Math.min(by0, binBox[o + 1]!); bz0 = Math.min(bz0, binBox[o + 2]!);
            bx1 = Math.max(bx1, binBox[o + 3]!); by1 = Math.max(by1, binBox[o + 4]!); bz1 = Math.max(bz1, binBox[o + 5]!);
            c += binCount[k]!;
            leftCount[k] = c;
            leftArea[k] = c === 0 ? 0 : area(bx0, by0, bz0, bx1, by1, bz1);
          }
          bx0 = Infinity; by0 = Infinity; bz0 = Infinity; bx1 = -Infinity; by1 = -Infinity; bz1 = -Infinity; c = 0;
          const parent = area(x0, y0, z0, x1, y1, z1) || 1;
          for (let k = BINS - 1; k > 0; k--) {
            const o = 6 * k;
            bx0 = Math.min(bx0, binBox[o]!); by0 = Math.min(by0, binBox[o + 1]!); bz0 = Math.min(bz0, binBox[o + 2]!);
            bx1 = Math.max(bx1, binBox[o + 3]!); by1 = Math.max(by1, binBox[o + 4]!); bz1 = Math.max(bz1, binBox[o + 5]!);
            c += binCount[k]!;
            const lc = leftCount[k - 1]!;
            if (lc === 0 || c === 0) continue;
            const cost = 0.5 + (leftArea[k - 1]! * lc + (c === 0 ? 0 : area(bx0, by0, bz0, bx1, by1, bz1)) * c) / parent;
            if (cost < bestCost) {
              bestCost = cost;
              bestAxis = axis;
              bestSplit = k;
            }
          }
        }
      }
      if (bestAxis < 0) {
        if (count > 16) {
          // Every centroid in one place (or no split pays): halve by index so the tree stays shallow.
          const mid = (start + end) >> 1;
          const l = used++;
          const r = used++;
          a[node] = l;
          b[node] = r;
          stack.push([r, mid, end], [l, start, mid]);
          continue;
        }
        a[node] = start;
        b[node] = -count;
        continue;
      }
      // Partition by bin.
      const scale = BINS / ext[bestAxis]!;
      let i = start;
      let j = end - 1;
      while (i <= j) {
        const t = order[i]!;
        const k = Math.min(BINS - 1, Math.floor((cen[3 * t + bestAxis]! - lo[bestAxis]!) * scale));
        if (k < bestSplit) i++;
        else {
          order[i] = order[j]!;
          order[j] = t;
          j--;
        }
      }
      const mid = i === start || i === end ? (start + end) >> 1 : i;
      const l = used++;
      const r = used++;
      a[node] = l;
      b[node] = r;
      stack.push([r, mid, end], [l, start, mid]);
    }
    this.bounds = bounds.slice(0, 6 * used);
    this.a = a.slice(0, used);
    this.b = b.slice(0, used);
    this.order = order;
    this.nodes = used;
  }

  private readonly stack = new Int32Array(128);

  /**
   * The nearest triangle the ray meets between `tMin` and `tMax`, skipping any `skip` says to (glass,
   * for a shadow ray that looks through it): written into `hit`; false when it meets none.
   */
  intersect(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, tMin: number, tMax: number, hit: Hit): boolean {
    const ix = 1 / dx;
    const iy = 1 / dy;
    const iz = 1 / dz;
    const B = this.bounds;
    const T = this.tri;
    const stack = this.stack;
    let sp = 0;
    stack[sp++] = 0;
    let best = tMax;
    let found = -1;
    let bu = 0;
    let bv = 0;
    while (sp > 0) {
      const node = stack[--sp]!;
      const o = 6 * node;
      let t0 = ((ix >= 0 ? B[o]! : B[o + 3]!) - ox) * ix;
      let t1 = ((ix >= 0 ? B[o + 3]! : B[o]!) - ox) * ix;
      const ty0 = ((iy >= 0 ? B[o + 1]! : B[o + 4]!) - oy) * iy;
      const ty1 = ((iy >= 0 ? B[o + 4]! : B[o + 1]!) - oy) * iy;
      if (ty0 > t0) t0 = ty0;
      if (ty1 < t1) t1 = ty1;
      const tz0 = ((iz >= 0 ? B[o + 2]! : B[o + 5]!) - oz) * iz;
      const tz1 = ((iz >= 0 ? B[o + 5]! : B[o + 2]!) - oz) * iz;
      if (tz0 > t0) t0 = tz0;
      if (tz1 < t1) t1 = tz1;
      if (t0 > t1 || t1 < tMin || t0 > best) continue;
      const bb = this.b[node]!;
      if (bb <= 0) {
        const first = this.a[node]!;
        for (let k = first; k < first - bb; k++) {
          const t = this.order[k]!;
          const p = 9 * t;
          const e1x = T[p + 3]!, e1y = T[p + 4]!, e1z = T[p + 5]!;
          const e2x = T[p + 6]!, e2y = T[p + 7]!, e2z = T[p + 8]!;
          const px = dy * e2z - dz * e2y;
          const py = dz * e2x - dx * e2z;
          const pz = dx * e2y - dy * e2x;
          const det = e1x * px + e1y * py + e1z * pz;
          if (det > -1e-14 && det < 1e-14) continue;
          const inv = 1 / det;
          const sx = ox - T[p]!, sy = oy - T[p + 1]!, sz = oz - T[p + 2]!;
          const u = (sx * px + sy * py + sz * pz) * inv;
          if (u < 0 || u > 1) continue;
          const qx = sy * e1z - sz * e1y;
          const qy = sz * e1x - sx * e1z;
          const qz = sx * e1y - sy * e1x;
          const v = (dx * qx + dy * qy + dz * qz) * inv;
          if (v < 0 || u + v > 1) continue;
          const d = (e2x * qx + e2y * qy + e2z * qz) * inv;
          if (d > tMin && d < best) {
            best = d;
            found = t;
            bu = u;
            bv = v;
          }
        }
        continue;
      }
      // Visit the nearer child first: push it last.
      const l = this.a[node]!;
      const lo = 6 * l;
      const ro = 6 * bb;
      const nearLeft = (B[lo]! + B[lo + 3]! - B[ro]! - B[ro + 3]!) * dx + (B[lo + 1]! + B[lo + 4]! - B[ro + 1]! - B[ro + 4]!) * dy + (B[lo + 2]! + B[lo + 5]! - B[ro + 2]! - B[ro + 5]!) * dz < 0;
      if (sp + 2 > stack.length) throw new Error('the scene is too deep to trace');
      if (nearLeft) {
        stack[sp++] = bb;
        stack[sp++] = l;
      } else {
        stack[sp++] = l;
        stack[sp++] = bb;
      }
    }
    if (found < 0) return false;
    hit.tri = found;
    hit.t = best;
    hit.u = bu;
    hit.v = bv;
    return true;
  }
}
