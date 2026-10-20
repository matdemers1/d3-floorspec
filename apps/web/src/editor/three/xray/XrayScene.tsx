import { useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { xrayMeshes, type Vec3, type XrayMesh, type XrayPlan, type XraySystem } from '@floorspec/mesh';
import { XRAY_SYSTEMS } from './xray';
import type { XrayState } from './xray';

/**
 * X-ray inside the canvas (FLR-T-14.5):
 *
 * - **The systems**: @floorspec/mesh's pieces as a handful of meshes — one per system, level and style
 *   (xrayMeshes) — each one draw call, untextured (Lambert in the system's colour: no texture unit
 *   taken from the 16 the view's lamps and maps share, lights.ts). Translucent sheets for sheathing
 *   and insulation, so what runs in a cavity shows through its batts; a drain's dashes in the muted
 *   colour. Drawn inside the house's group, so the section box (FLR-T-14.6) cuts them as it cuts the
 *   house — "a section box to cut into a corner". Never picked: a click goes through to the wall.
 * - **The fade**: every material of the house (`fade`, main's parts and furniture) is drawn
 *   translucent at 1 − fade, without writing depth, so the systems inside read through it; and put
 *   back as it was when X-ray goes off.
 */

/** A system's colours, read from the theme (modes.css): its own and the muted one of a drain's dashes. */
export type XrayColours = Readonly<Record<XraySystem, string>> & { readonly dash: string };

/** Sheathing and insulation, translucent; everything else opaque. */
const SHEET_OPACITY: Readonly<Partial<Record<XraySystem, number>>> = { framing: 0.35, insulation: 0.45 };

const noRaycast = (): void => undefined;
const HIDDEN = new THREE.MeshBasicMaterial({ visible: false });

/** Every mesh material under a group put back as it was before the fade. */
function restore(root: THREE.Object3D | null): void {
  root?.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const m = o.material as THREE.Material | THREE.Material[];
    for (const x of Array.isArray(m) ? m : [m]) fadeMaterial(x, null);
  });
}

interface Base {
  transparent: boolean;
  opacity: number;
  depthWrite: boolean;
}

/** Fade a material, remembering what it was; or put it back. */
function fadeMaterial(m: THREE.Material, keep: number | null): void {
  const u = m.userData as { xray?: Base };
  if (keep === null) {
    const b = u.xray;
    if (b === undefined) return;
    if (m.transparent !== b.transparent) m.needsUpdate = true;
    m.transparent = b.transparent;
    m.opacity = b.opacity;
    m.depthWrite = b.depthWrite;
    delete u.xray;
    return;
  }
  u.xray ??= { transparent: m.transparent, opacity: m.opacity, depthWrite: m.depthWrite };
  const o = u.xray.opacity * keep;
  if (!m.transparent) m.needsUpdate = true;
  m.transparent = true;
  m.opacity = o;
  m.depthWrite = false;
}

export function XrayScene({ plan, origin, state, levels, fade, colours }: {
  plan: XrayPlan | null;
  origin: Vec3;
  state: XrayState;
  /** The levels the view shows now (FLR-T-13.2): X-ray draws what is in them. */
  levels: ReadonlySet<string>;
  /** What the finishes are: main's house, faded while X-ray is on. */
  fade: { current: THREE.Object3D | null };
  colours: XrayColours;
}) {
  const invalidate = useThree((s) => s.invalidate);
  const meshes = useMemo<{ mesh: XrayMesh; geometry: THREE.BufferGeometry }[]>(() => {
    if (plan === null || !state.on) return [];
    return xrayMeshes(plan, origin).map((mesh) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(mesh.normals, 3));
      g.computeBoundingSphere();
      return { mesh, geometry: g };
    });
  }, [plan, origin, state.on]);
  useEffect(() => () => { for (const m of meshes) m.geometry.dispose(); }, [meshes]);

  const materials = useMemo(() => {
    const out = new Map<string, THREE.MeshLambertMaterial>();
    for (const system of XRAY_SYSTEMS) {
      out.set(`${system}:solid`, new THREE.MeshLambertMaterial({ color: colours[system] }));
      out.set(`${system}:dash`, new THREE.MeshLambertMaterial({ color: colours.dash }));
      out.set(`${system}:sheet`, new THREE.MeshLambertMaterial({ color: colours[system], transparent: true, opacity: SHEET_OPACITY[system] ?? 0.5, depthWrite: false, side: THREE.DoubleSide }));
    }
    for (const m of out.values()) m.userData = { xray: 'system' };
    return out;
  }, [colours]);
  useEffect(() => () => { for (const m of materials.values()) m.dispose(); }, [materials]);
  useEffect(() => { invalidate(); }, [meshes, materials, state, levels, invalidate]);

  // The fade, on every material of the house, each frame (new parts bring new materials).
  const keep = state.on ? Math.max(0, 1 - state.fade) : null;
  useFrame(() => {
    fade.current?.traverse((o) => {
      // Meshes only: the selection's outline (lines) stays as bright as ever.
      if (!(o instanceof THREE.Mesh)) return;
      const m = o.material as THREE.Material | THREE.Material[];
      for (const x of Array.isArray(m) ? m : [m]) fadeMaterial(x, keep);
    });
  });
  // Off, or gone: the house's materials as they were.
  useEffect(() => {
    if (keep !== null) return;
    restore(fade.current);
    invalidate();
  }, [keep, fade, invalidate]);
  useEffect(() => () => {
    restore(fade.current);
  }, [fade]);

  if (!state.on) return null;
  return (
    <group name="xray">
      {meshes.map(({ mesh, geometry }) => (
        <mesh
          key={`${mesh.system}:${mesh.level}:${mesh.style}`}
          geometry={geometry}
          material={materials.get(`${mesh.system}:${mesh.style}`) ?? HIDDEN}
          visible={state.systems[mesh.system] && levels.has(mesh.level)}
          userData={{ xray: mesh.system, level: mesh.level, style: mesh.style, pieces: mesh.pieces }}
          raycast={noRaycast}
          renderOrder={mesh.style === 'sheet' ? 0.5 : 0}
        />
      ))}
    </group>
  );
}
