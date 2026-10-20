import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { useThree } from '@react-three/fiber';
import { Switch, IconButton, SegmentedControl, Tooltip } from '@d3cloud/ui';
import { Mountain, X } from 'lucide-react';
import { gradeAt, type DerivedSite } from '@floorspec/engine';
import { terrainMesh, type TerrainMesh } from '@floorspec/mesh';
import type { EditorStore } from '../../store';
import type { EditorModel } from '../../model';
import { siteDrawingOf } from '../../site/Layer';
import { siteOf, useSite, type Exaggeration } from '../../site/state';
import { benchmarkOf, FT, heightText } from '../../site/ops';
import { threeOf } from '../mode';
import { sunOf } from '../sun/study';
import { lawnMap } from '../sky/SkyScene';
import { useGroundLook } from './ground';
import { softwareWebGL } from '../software';
import '../sun/sun.css';
import '../../site/site.css';
import './terrain.css';

/**
 * The ground in 3D (FLR-T-15.1, FS_site 5.4): the site's surface, set to each pad and ground-laid slab
 * and graded back to the survey at 1:4 — the house's pad cut into the slope, the walk filled below it
 * — in the lawn of FLR-T-13.4, with its contours drawn on it and the cut and fill tinted amber and blue.
 * The vertical exaggeration stretches the ground in the view only (FS_site 5.4): no elevation, volume
 * or model changes. The Terrain panel holds those view settings and a live section A–A.
 */

// Cut and fill on the ground: amber and blue, as the plan draws them — what the ground is, not chrome.
const CUT = new THREE.Color('#d08a1c'); // d3-allow: FS_site's cut, amber, on the 3D ground (FLR-T-15.1)
const FILL = new THREE.Color('#4a8fd6'); // d3-allow: FS_site's fill, blue, on the 3D ground (FLR-T-15.1)
const CONTOUR = '#40523a'; // d3-allow: a contour line drawn on the lawn (FLR-T-15.1)
const MAJOR = '#22311f'; // d3-allow: a major contour line on the lawn (FLR-T-15.1)
const PLAIN = new THREE.Color('#9da48f'); // d3-allow: the ground without its lawn (FLR-T-15.1)

const meshes = new WeakMap<EditorModel, Map<string, TerrainMesh | null>>();

/** The model's terrain about the house mesh's origin, once per model and setting. */
export function terrainOf(model: EditorModel, origin: readonly [number, number, number], interval: number): TerrainMesh | null {
  let m = meshes.get(model);
  if (m === undefined) {
    m = new Map();
    meshes.set(model, m);
  }
  const key = `${origin.join(',')}|${String(interval)}`;
  if (!m.has(key)) m.set(key, terrainMesh(siteDrawingOf(model), { origin, interval: interval * FT }));
  return m.get(key) ?? null;
}

const noRaycast = (): void => undefined;

export function TerrainScene({ store, model, origin }: { store: EditorStore; model: EditorModel; origin: readonly [number, number, number] }) {
  const settings = useSite(store, (s) => s.terrain);
  const interval = useSite(store, (s) => s.interval);
  const invalidate = useThree((s) => s.invalidate);
  const gl = useThree((s) => s.gl);
  const t = terrainOf(model, origin, interval);
  // FLR-T-15.4: the season's ground, as the lawn beyond wears it — a tint on the grass, or snow.
  const look = useGroundLook(store);
  const snow = look !== null && !look.grass;
  const geometry = useMemo(() => {
    if (t === null) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(t.positions, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(t.normals, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(t.uvs, 2));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(t.shade.length * 3), 3));
    g.setIndex(new THREE.BufferAttribute(t.indices, 1));
    g.computeBoundingSphere();
    return g;
  }, [t]);
  // the vertex colours: the lawn's own variation, tinted where the ground is cut or filled
  useEffect(() => {
    if (geometry === null || t === null) return;
    const col = geometry.getAttribute('color') as THREE.BufferAttribute;
    const c = new THREE.Color();
    for (let i = 0; i < t.shade.length; i++) {
      const base = settings.lawn && !snow ? (t.shade[i] ?? 1) : 1;
      c.setRGB(base, base, base);
      const dz = t.change[i] ?? 0;
      if (settings.tint && Math.abs(dz) > 0.02) c.lerp(dz < 0 ? CUT : FILL, Math.min(0.85, 0.35 + Math.abs(dz) * 0.6));
      col.setXYZ(i, c.r, c.g, c.b);
    }
    col.needsUpdate = true;
    invalidate();
  }, [geometry, t, settings.tint, settings.lawn, snow, invalidate]);
  const material = useMemo(() => {
    if (!settings.lawn) return new THREE.MeshLambertMaterial({ color: PLAIN, vertexColors: true });
    if (look !== null && !look.grass) return new THREE.MeshLambertMaterial({ color: new THREE.Color(look.albedo[0], look.albedo[1], look.albedo[2]), vertexColors: true });
    const m = new THREE.MeshLambertMaterial({ map: lawnMap(softwareWebGL() ? 1 : Math.min(8, gl.capabilities.getMaxAnisotropy())), vertexColors: true });
    if (look !== null) m.color.setRGB(look.tint[0], look.tint[1], look.tint[2]);
    return m;
  }, [settings.lawn, gl, look]);
  const lines = useMemo(() => {
    if (t === null) return null;
    const minor = new THREE.BufferGeometry();
    minor.setAttribute('position', new THREE.BufferAttribute(t.contours, 3));
    const major = new THREE.BufferGeometry();
    major.setAttribute('position', new THREE.BufferAttribute(t.majors, 3));
    return { minor, major };
  }, [t]);
  useEffect(() => () => { geometry?.dispose(); }, [geometry]);
  useEffect(() => () => { material.dispose(); }, [material]);
  useEffect(() => () => { lines?.minor.dispose(); lines?.major.dispose(); }, [lines]);
  useEffect(() => { invalidate(); }, [settings.exaggeration, settings.contours, invalidate]);
  // The test hook (e2e/site.spec.ts): what the 3D view draws of the ground.
  useEffect(() => {
    if (t === null) return;
    const w = window as unknown as { __floorspecTerrain?: unknown };
    const hook = { triangles: t.indices.length / 3, low: t.low, high: t.high, cut: t.change.some((c) => c < -0.02), fill: t.change.some((c) => c > 0.02), snow, contours: settings.contours ? (t.contours.length + t.majors.length) / 6 : 0, exaggeration: settings.exaggeration };
    w.__floorspecTerrain = hook;
    return () => {
      if (w.__floorspecTerrain === hook) delete w.__floorspecTerrain;
    };
  }, [t, settings.contours, settings.exaggeration, snow]);
  if (geometry === null || lines === null) return null;
  return (
    <group scale={[1, 1, settings.exaggeration]} userData={{ terrain: true }}>
      <mesh geometry={geometry} material={material} receiveShadow castShadow={false} raycast={noRaycast} userData={{ ground: true, terrain: true, snow }} />
      {settings.contours ? (
        <>
          <lineSegments geometry={lines.minor} raycast={noRaycast}>
            <lineBasicMaterial color={CONTOUR} transparent opacity={0.55} />
          </lineSegments>
          <lineSegments geometry={lines.major} raycast={noRaycast}>
            <lineBasicMaterial color={MAJOR} transparent opacity={0.85} />
          </lineSegments>
        </>
      ) : null}
    </group>
  );
}

// ─── The toolbar button ──────────────────────────────────────────────────────────────────────

export function TerrainButton({ store, model }: { store: EditorStore; model: EditorModel }) {
  const open = useSite(store, (s) => s.terrain.open);
  const has = siteDrawingOf(model).surface !== null;
  return (
    <Tooltip content={!has ? 'Terrain: survey the lot first — spot elevations and contour lines, in Landscape mode' : open ? 'Close the terrain' : 'Terrain: contours, cut and fill, vertical scale'}>
      <IconButton
        label="Terrain"
        icon={<Mountain />}
        size="sm"
        pressed={open}
        disabled={!has}
        onClick={() => {
          if (!open) {
            threeOf(store).set({ lightingOpen: false, cameraOpen: false });
            sunOf(store).set({ open: false });
          }
          siteOf(store).set({ terrain: { open: !open } });
        }}
      />
    </Tooltip>
  );
}

// ─── The panel ───────────────────────────────────────────────────────────────────────────────

const YD3 = 1_170_432 ** 3;
const yd3 = (v: string | null | undefined): string => (v === null || v === undefined ? '—' : `${String(Math.round(Number(BigInt(v) / 1_000_000n) / (YD3 / 1e6)))} yd³`);

/** A section through the site, north to south through the house's middle: the surveyed ground dashed, the graded ground solid, cut and fill between. */
function SectionAA({ model }: { model: EditorModel }) {
  const site = siteDrawingOf(model);
  const s = site.surface;
  const derived = (model.derived?.extensions as { FS_site?: DerivedSite } | undefined)?.FS_site;
  if (s === null) return null;
  const xs = s.points.map((p) => p[0]);
  const ys = (site.lot ?? s.points.map((p) => [p[0], p[1]] as const)).map((p) => p[1]);
  const house = site.graded.find((g) => g.name === 'House') ?? site.graded[0];
  const x = house === undefined ? (Math.min(...xs) + Math.max(...xs)) / 2 : house.ring.reduce((a, p) => a + p[0], 0) / house.ring.length;
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  const N = 120;
  const inside = (px: number, py: number, ring: readonly (readonly [number, number])[]) => {
    let c = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i] ?? [0, 0];
      const [xj, yj] = ring[j] ?? [0, 0];
      if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  };
  const samples = Array.from({ length: N + 1 }, (_, i) => {
    const y = y1 - ((y1 - y0) * i) / N;
    const natural = gradeAt(s, x, y);
    const g = site.graded.find((o) => inside(x, y, o.ring));
    return { natural, graded: g === undefined ? natural : g.elevation, house: g?.id === house?.id };
  });
  const zs = samples.flatMap((p) => [p.natural, p.graded]).filter((z): z is number => z !== undefined);
  if (zs.length === 0) return null;
  const floorZ = model.document.levels !== undefined ? Math.min(...Object.values(model.document.levels).map((l) => l?.elevation ?? 0)) : 0;
  const zlo = Math.min(...zs) - 0.5 * FT;
  const zhi = Math.max(...zs, floorZ + 10 * FT) + FT;
  const W = 260;
  const H = 84;
  const X = (i: number) => (i / N) * W;
  const Y = (z: number) => H - ((z - zlo) / (zhi - zlo)) * H;
  const line = (key: 'natural' | 'graded') => samples.map((p, i) => (p[key] === undefined ? '' : `${i === 0 || samples[i - 1]?.[key] === undefined ? 'M' : 'L'}${X(i).toFixed(1)} ${Y(p[key]).toFixed(1)}`)).join('');
  const band = (cut: boolean) =>
    samples
      .map((p, i) => {
        if (p.natural === undefined || p.graded === undefined) return '';
        const d = p.natural - p.graded;
        if ((cut && d <= 0) || (!cut && d >= 0)) return '';
        const w = W / N;
        return `M${(X(i) - w / 2).toFixed(1)} ${Y(p.natural).toFixed(1)}V${Y(p.graded).toFixed(1)}h${w.toFixed(2)}V${Y(p.natural).toFixed(1)}Z`;
      })
      .join('');
  const houseRun = samples.map((p, i) => (p.house ? i : -1)).filter((i) => i >= 0);
  const houseFrom = houseRun[0];
  const houseTo = houseRun[houseRun.length - 1];
  return (
    <figure className="fs-terrain__section">
      <figcaption>Section A–A · north to south, through the house</figcaption>
      <svg viewBox={`0 0 ${String(W)} ${String(H)}`} width={W} height={H} role="img" aria-label={`Section through the site: cut ${yd3(derived?.cut)}, fill ${yd3(derived?.fill)}`}>
        <path className="fs-terrain__cut" d={band(true)} />
        <path className="fs-terrain__fill" d={band(false)} />
        {houseFrom !== undefined && houseTo !== undefined && houseTo > houseFrom ? <rect className="fs-terrain__house" x={X(houseFrom)} y={Y(floorZ + 10 * FT)} width={X(houseTo) - X(houseFrom)} height={Y(floorZ) - Y(floorZ + 10 * FT)} /> : null}
        <path className="fs-terrain__natural" d={line('natural')} />
        <path className="fs-terrain__graded" d={line('graded')} />
      </svg>
      <p className="fs-terrain__legend">
        <span className="fs-terrain__key fs-terrain__key--natural" aria-hidden="true" /> existing grade
        <span className="fs-terrain__key fs-terrain__key--cut" aria-hidden="true" /> cut {yd3(derived?.cut)}
        <span className="fs-terrain__key fs-terrain__key--fill" aria-hidden="true" /> fill {yd3(derived?.fill)}
      </p>
    </figure>
  );
}

export function TerrainPanel({ store, model }: { store: EditorStore; model: EditorModel }) {
  const t = useSite(store, (s) => s.terrain);
  const site = siteDrawingOf(model);
  if (!t.open || site.surface === null) return null;
  const bench = benchmarkOf(model);
  const set = (patch: Partial<typeof t>) => { siteOf(store).set({ terrain: patch }); };
  return (
    <section
      className="fs-sun fs-terrain"
      aria-label="Terrain view"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          set({ open: false });
          document.querySelector<HTMLElement>('.fs-three__gl')?.focus();
        }
        e.stopPropagation();
      }}
    >
      <header className="fs-sun__head">
        <Mountain aria-hidden="true" />
        <h2 className="fs-sun__title">Terrain</h2>
        <IconButton label="Close the terrain" icon={<X />} size="sm" onClick={() => { set({ open: false }); }} />
      </header>
      <p className="fs-note" role="status">
        {`${heightText(site.surface.low, bench)}′ – ${heightText(site.surface.high, bench)}′ · ${String(site.spots.length)} spots, ${String(site.contours.length)} contour lines`}
      </p>
      <div className="fs-terrain__switches">
        <Switch checked={t.contours} onCheckedChange={(v: boolean) => { set({ contours: v }); }}>Contours on the ground</Switch>
        <Switch checked={t.tint} onCheckedChange={(v: boolean) => { set({ tint: v }); }}>Tint cut and fill</Switch>
        <Switch checked={t.lawn} onCheckedChange={(v: boolean) => { set({ lawn: v }); }}>Ground material · lawn</Switch>
      </div>
      <div className="fs-terrain__scale">
        <span aria-hidden="true">Vertical scale</span>
        <SegmentedControl
          aria-label="Vertical scale"
          size="sm"
          value={String(t.exaggeration)}
          items={[{ value: '1', label: '1×' }, { value: '1.6', label: '1.6×' }, { value: '2', label: '2×' }]}
          onValueChange={(v) => { set({ exaggeration: Number(v) as Exaggeration }); }}
        />
      </div>
      <p className="fs-note">Exaggeration is a view setting only: elevations, volumes and the model never change.</p>
      <SectionAA model={model} />
    </section>
  );
}
