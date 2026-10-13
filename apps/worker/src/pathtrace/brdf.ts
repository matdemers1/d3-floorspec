/**
 * How a surface reflects light in the path tracer (FLR-T-13.14, FLR-ADR-040): the same model the
 * editor's GPU still traces (three-gpu-pathtracer's glTF material), so a still from either agrees.
 *
 * - **Gloss and metal: GGX.** A microfacet lobe — Trowbridge-Reitz's distribution D with α the
 *   square of the roughness (glTF's), Smith's height-correlated masking-shadowing G, and Schlick's
 *   Fresnel F: f = D G F / (4 (n·l)(n·v)). A dielectric's facets reflect 4% face on (ior 1.5); a
 *   metal's reflect its base colour, so steel is grey and brass is yellow, and a metal has no diffuse.
 * - **Sampled where it reflects.** A path continues along a facet normal drawn from the distribution
 *   of the normals the viewer sees (Heitz 2018), so its weight is F · G / G₁(v) — at most 1 — and a
 *   polished floor's reflection is no noisier than its diffuse light.
 * - **Energy.** What one bounce off the facets loses (light that would hit another facet) is put back
 *   as the GPU tracer does (Turquin 2019): the lobe scaled by 1 + F₀ (1 − E) / E, E its single-bounce
 *   albedo. What the gloss reflects the diffuse beneath it does not get: it is dimmed by 1 − E_F.
 *   E is tabulated once here, by the same sampling the tracer uses, so the tracer conserves energy by
 *   construction rather than by a fitted curve.
 * - **Glass: Fresnel.** A pane of glazing is a thin slab of dielectric (`thinPane`): each face reflects
 *   by the exact Fresnel equations for its ior, light bounces between its faces, and its tint absorbs
 *   along the slanted path inside — the rule @floorspec/mesh's glass.ts draws every view with
 *   (FLR-T-13.17), here from first principles.
 *
 * Isomorphic and allocation-free per call: the tracer calls these millions of times.
 */

/** The least α (roughness²) the lobe is drawn with: a mirror's lobe narrower than this only adds noise. */
export const MIN_ALPHA = 0.002;
/** F₀ of a dielectric's facets: ior 1.5, as glTF's metallic-roughness model fixes it. */
export const DIELECTRIC_F0 = 0.04;

/** Trowbridge-Reitz (GGX) normal distribution D(h) for n·h and α² — normalized: ∫ D (n·h) dω = 1. */
export function ggxD(nh: number, a2: number): number {
  if (nh <= 0) return 0;
  const d = nh * nh * (a2 - 1) + 1;
  return a2 / (Math.PI * d * d);
}

/** Smith's Λ for GGX at a direction with cosine `c` to the normal. */
export function smithLambda(c: number, a2: number): number {
  const c2 = Math.max(1e-12, c * c);
  return (-1 + Math.sqrt(1 + (a2 * (1 - c2)) / c2)) / 2;
}

/** Smith's masking G₁ for GGX. */
export function smithG1(c: number, a2: number): number {
  return 1 / (1 + smithLambda(c, a2));
}

/** Smith's height-correlated masking-shadowing G₂ = 1 / (1 + Λ(v) + Λ(l)). */
export function smithG2(nl: number, nv: number, a2: number): number {
  return 1 / (1 + smithLambda(nl, a2) + smithLambda(nv, a2));
}

/** The visibility term V = G₂ / (4 (n·l)(n·v)), in its closed form (Heitz 2014). */
export function smithV(nl: number, nv: number, a2: number): number {
  const gv = nl * Math.sqrt(nv * nv * (1 - a2) + a2);
  const gl = nv * Math.sqrt(nl * nl * (1 - a2) + a2);
  const s = gv + gl;
  return s > 0 ? 0.5 / s : 0;
}

/** Schlick's Fresnel: F₀ + (1 − F₀)(1 − cos)⁵. */
export function schlick(cos: number, f0: number): number {
  const k = 1 - Math.min(1, Math.max(0, cos));
  const k2 = k * k;
  return f0 + (1 - f0) * k2 * k2 * k;
}

/**
 * The Fresnel reflectance of a smooth dielectric face for unpolarized light arriving at `cos` to its
 * normal from the side of index 1, into index `ior` — the exact equations, not Schlick's fit. Total
 * internal reflection (ior < 1 past the critical angle) reflects everything.
 */
export function fresnelDielectric(cos: number, ior: number): number {
  const ci = Math.min(1, Math.max(0, cos));
  const s2 = (1 - ci * ci) / (ior * ior);
  if (s2 >= 1) return 1;
  const ct = Math.sqrt(1 - s2);
  const rs = (ci - ior * ct) / (ci + ior * ct);
  const rp = (ior * ci - ct) / (ior * ci + ct);
  return (rs * rs + rp * rp) / 2;
}

/** Linear RGB, three numbers: what `thinPane` writes. */
type Out3 = Float64Array | [number, number, number];

/**
 * What a pane's tint lets through in one pass straight across it, linear RGB, from what the whole
 * pane lets through face on, `pane` (@floorspec/mesh's `paneTransmission`: both faces and the tint):
 * the a with (1 − R₀)² a / (1 − R₀² a²) = pane, R₀ a face's reflectance face on.
 */
export function paneAbsorption(pane: readonly [number, number, number], ior: number, out: Out3): void {
  const R0 = ((ior - 1) / (ior + 1)) ** 2;
  for (let k = 0; k < 3; k++) out[k] = solveAbsorption(pane[k]!, R0, pane[k]! / ((1 - R0) * (1 - R0)));
}

/**
 * A thin pane of glass — glazing — seen at `cos` (|n·v|): what it lets straight through, `t`, and
 * what it reflects, `r`, linear RGB. `absorb` is its tint's single pass face on (`paneAbsorption`),
 * `ior` its index. Each face reflects R by Fresnel at the angle, the light inside bounces between
 * the faces (a geometric series), and the tint absorbs along the refracted path, longer by 1 / cos θₜ
 * (Snell). Energy: r + t ≤ 1, the rest absorbed.
 */
export function thinPane(absorb: Readonly<Out3>, cos: number, ior: number, t: Out3, r: Out3): void {
  const c = Math.min(1, Math.max(1e-4, cos));
  const R = fresnelDielectric(c, ior);
  const inside = Math.sqrt(Math.max(1e-6, 1 - (1 - c * c) / (ior * ior)));
  for (let k = 0; k < 3; k++) {
    const a = absorb[k]! >= 1 ? 1 : absorb[k]! ** (1 / inside);
    const d = 1 - R * R * a * a;
    t[k] = ((1 - R) * (1 - R) * a) / d;
    r[k] = R + (R * (1 - R) * (1 - R) * a * a) / d;
  }
}

/** The single pass a with (1 − R)² a / (1 − R² a²) = T, by Newton from `guess`. */
function solveAbsorption(T: number, R: number, guess: number): number {
  if (T <= 0) return 0;
  let a = Math.min(1, Math.max(1e-6, guess));
  for (let i = 0; i < 8; i++) {
    const d = 1 - R * R * a * a;
    const f = ((1 - R) * (1 - R) * a) / d - T;
    const df = ((1 - R) * (1 - R) * (1 + R * R * a * a)) / (d * d);
    a = Math.min(1, Math.max(1e-6, a - f / df));
  }
  return a;
}

/**
 * A facet normal drawn from the GGX normals visible from `v` (Heitz 2018), in the frame where the
 * surface normal is +Z. `v` must be above the surface. Written to `out` (unit, +Z hemisphere).
 */
export function sampleVndf(vx: number, vy: number, vz: number, alpha: number, u1: number, u2: number, out: Float64Array): void {
  // Stretch the view into the hemisphere configuration.
  let hx = alpha * vx;
  let hy = alpha * vy;
  let hz = vz;
  const hl = Math.hypot(hx, hy, hz);
  hx /= hl;
  hy /= hl;
  hz /= hl;
  const lensq = hx * hx + hy * hy;
  let t1x = 1;
  let t1y = 0;
  if (lensq > 1e-14) {
    const inv = 1 / Math.sqrt(lensq);
    t1x = -hy * inv;
    t1y = hx * inv;
  }
  // T2 = Vh × T1 (T1 has no z).
  const t2x = -hz * t1y;
  const t2y = hz * t1x;
  const t2z = hx * t1y - hy * t1x;
  const r = Math.sqrt(u1);
  const phi = 2 * Math.PI * u2;
  const p1 = r * Math.cos(phi);
  let p2 = r * Math.sin(phi);
  const s = 0.5 * (1 + hz);
  p2 = (1 - s) * Math.sqrt(Math.max(0, 1 - p1 * p1)) + s * p2;
  const p3 = Math.sqrt(Math.max(0, 1 - p1 * p1 - p2 * p2));
  const nx = p1 * t1x + p2 * t2x + p3 * hx;
  const ny = p1 * t1y + p2 * t2y + p3 * hy;
  const nz = p2 * t2z + p3 * hz;
  // Unstretch.
  const ex = alpha * nx;
  const ey = alpha * ny;
  const ez = Math.max(1e-6, nz);
  const el = Math.hypot(ex, ey, ez);
  out[0] = ex / el;
  out[1] = ey / el;
  out[2] = ez / el;
}

/** α for a glTF roughness: its square, no less than `MIN_ALPHA`. */
export const alphaOf = (roughness: number): number => Math.max(MIN_ALPHA, Math.min(1, Math.max(0, roughness)) ** 2);

// ─── The lobe's albedo, tabulated ────────────────────────────────────────────────────────────

/** Table resolution: n·v by roughness. */
const TN = 32;
/**
 * E(μ, r): the single-bounce albedo of the GGX lobe at n·v = μ and roughness r, split as Schlick's
 * Fresnel splits it — E_F = F₀·A + B, A + B the albedo for F = 1 — so one table serves every F₀.
 */
const TABLE_A = new Float64Array(TN * TN);
const TABLE_B = new Float64Array(TN * TN);
{
  const h = new Float64Array(3);
  const S = 24;
  for (let j = 0; j < TN; j++) {
    const rough = j / (TN - 1);
    const alpha = alphaOf(rough);
    const a2 = alpha * alpha;
    for (let i = 0; i < TN; i++) {
      const mu = Math.max(1e-3, i / (TN - 1));
      const vx = Math.sqrt(1 - mu * mu);
      const vz = mu;
      let ess = 0;
      let c = 0;
      // Stratified, so the table is the same everywhere it is built.
      for (let a = 0; a < S; a++)
        for (let b = 0; b < S; b++) {
          sampleVndf(vx, 0, vz, alpha, (a + 0.5) / S, (b + 0.5) / S, h);
          const vh = vx * h[0]! + vz * h[2]!;
          const lz = 2 * vh * h[2]! - vz;
          if (lz <= 0) continue;
          const w = (1 + smithLambda(mu, a2)) / (1 + smithLambda(mu, a2) + smithLambda(lz, a2));
          const k = 1 - Math.max(0, vh);
          ess += w;
          c += w * k * k * k * k * k;
        }
      TABLE_A[j * TN + i] = (ess - c) / (S * S);
      TABLE_B[j * TN + i] = c / (S * S);
    }
  }
}

/**
 * The GGX lobe's single-bounce albedo at n·v `mu` and `roughness`, as Schlick's (A, B): the albedo
 * for reflectance F₀ is F₀·A + B, and A + B is what it would be were every facet a perfect mirror.
 */
export function lobeAlbedo(mu: number, roughness: number, out: Float64Array): void {
  const x = Math.min(1, Math.max(0, mu)) * (TN - 1);
  const y = Math.min(1, Math.max(0, roughness)) * (TN - 1);
  const i = Math.min(TN - 2, Math.floor(x));
  const j = Math.min(TN - 2, Math.floor(y));
  const fx = x - i;
  const fy = y - j;
  const at = (t: Float64Array): number =>
    (t[j * TN + i]! * (1 - fx) + t[j * TN + i + 1]! * fx) * (1 - fy) + (t[(j + 1) * TN + i]! * (1 - fx) + t[(j + 1) * TN + i + 1]! * fx) * fy;
  out[0] = at(TABLE_A);
  out[1] = at(TABLE_B);
}
