import { useEffect, useMemo, useState } from 'react';
import * as THREE from 'three';
import { useThree } from '@react-three/fiber';
import { heatLossMesh, LOSS_BANDS, type HeatLossSurface, type Vec3 } from '@floorspec/mesh';
import type { EditorStore } from '../store';
import { useEditor } from '../store';
import { useEnvelope, useEnvelopeEstimate } from './state';

/**
 * The heat-loss map inside the canvas (FLR-T-16.4): @floorspec/mesh's heatLossMesh — the envelope's
 * walls, openings and roofs laid just outside the house — coloured by band with vertex colours read
 * from the theme (envelope.css). One unlit draw call, no texture: none of the 16 texture units the
 * view's lamps and maps share is taken. Never picked: a click goes through to the house.
 */

export type LossColours = Readonly<Record<(typeof LOSS_BANDS)[number], string>>;
const FALLBACK: LossColours = { high: 'crimson', raised: 'goldenrod', typical: 'steelblue', low: 'seagreen' };

function readColours(): LossColours {
  const s = getComputedStyle(document.documentElement);
  const v = (b: (typeof LOSS_BANDS)[number]) => s.getPropertyValue(`--fs-heatloss-${b}`).trim() || FALLBACK[b];
  return { high: v('high'), raised: v('raised'), typical: v('typical'), low: v('low') };
}

/** The band colours in the page's theme, read again when it changes. */
export function useLossColours(): LossColours {
  const [c, setC] = useState<LossColours>(FALLBACK);
  useEffect(() => {
    const update = () => { setC(readColours()); };
    update();
    const o = new MutationObserver(update);
    o.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
    const q = window.matchMedia('(prefers-color-scheme: dark)');
    q.addEventListener('change', update);
    return () => {
      o.disconnect();
      q.removeEventListener('change', update);
    };
  }, []);
  return c;
}

const noRaycast = (): void => undefined;

const bandCounts = (bands: readonly string[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const b of bands) out[b] = (out[b] ?? 0) + 1;
  return out;
};

export function HeatLossScene({ store, origin, levels }: { store: EditorStore; origin: Vec3; levels: ReadonlySet<string> }) {
  const on = useEnvelope(store, (s) => s.on);
  const env = useEnvelopeEstimate(store);
  const model = useEditor(store, (s) => s.model);
  const colours = useLossColours();
  const invalidate = useThree((s) => s.invalidate);
  const geometry = useMemo(() => {
    if (!on || env?.status !== 'ok' || model === null || model.derived === null) return null;
    const surfaces: HeatLossSurface[] = env.estimate.surfaces.map((s) => ({ element: s.element, kind: s.kind, band: s.band }));
    const m = heatLossMesh(model.view, model.derived, surfaces, origin);
    const at = (a: ArrayLike<number>, i: number): number => a[i] ?? 0;
    const keep: number[] = [];
    for (let t = 0; t < m.levels.length; t++) if (levels.has(m.levels[t] ?? '')) keep.push(t);
    const pos = new Float32Array(keep.length * 9);
    const nor = new Float32Array(keep.length * 9);
    const col = new Float32Array(keep.length * 9);
    const rgb = LOSS_BANDS.map((b) => new THREE.Color(colours[b]).convertSRGBToLinear());
    keep.forEach((t, i) => {
      for (let k = 0; k < 9; k++) {
        pos[i * 9 + k] = at(m.positions, t * 9 + k);
        nor[i * 9 + k] = at(m.normals, t * 9 + k);
      }
      for (let v = 0; v < 3; v++) {
        const c = rgb[at(m.bands, t * 3 + v)] ?? rgb[0];
        if (c === undefined) continue;
        col[i * 9 + v * 3] = c.r;
        col[i * 9 + v * 3 + 1] = c.g;
        col[i * 9 + v * 3 + 2] = c.b;
      }
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.computeBoundingSphere();
    return g;
  }, [on, env, model, origin, colours, levels]);
  useEffect(() => {
    invalidate();
    // A test hook, as the 3D view's own: what the map draws now — its triangles, and how many of each band.
    const w = window as unknown as { __floorspecHeatLoss?: { triangles: number; bands: Record<string, number> } };
    if (geometry !== null) {
      const col = geometry.getAttribute('position').count / 3;
      w.__floorspecHeatLoss = { triangles: col, bands: bandCounts(env?.status === 'ok' ? env.estimate.surfaces.map((x) => x.band) : []) };
    } else delete w.__floorspecHeatLoss;
    return () => { geometry?.dispose(); };
  }, [geometry, invalidate, env]);
  if (geometry === null) return null;
  return (
    <mesh geometry={geometry} renderOrder={4} raycast={noRaycast} userData={{ heatLoss: true }} name="heat-loss-map">
      <meshBasicMaterial vertexColors transparent opacity={0.88} side={THREE.DoubleSide} depthWrite={false} toneMapped={false} polygonOffset polygonOffsetFactor={-2} polygonOffsetUnits={-2} />
    </mesh>
  );
}
