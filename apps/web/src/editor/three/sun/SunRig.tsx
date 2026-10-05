import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { HouseMesh } from '@floorspec/mesh';
import type { EditorStore } from '../../store';
import type { EditorModel } from '../../model';
import { shadowMapSize, sunOf, useStudy, useSunState, type Study } from './study';

/**
 * The 3D view's lights (FLR-T-8.6). With the sun off — or no site location to place it from — the
 * even studio light the view has always had. With it on: a directional light from the sun's
 * azimuth and altitude turned into the project's frame by the site's true north, casting shadows
 * from walls, roofs, slabs and stairs onto floors and onto a disc of ground under the house; a sky
 * light that fades with the sun; below the horizon, a dim night with no sun at all.
 *
 * The shadow camera is fitted to the house: an orthographic box around its bounding sphere,
 * looking along the sunlight, so every shadow the house casts lands inside it (a receiver in shadow
 * lies on a ray from its occluder, so it shares the occluder's place in the light's view). The
 * shadow map is sized to the house — about 2 cm a texel, between 1024 and 4096 — and halved in the
 * split view.
 */

// What the house is lit by, not interface colour.
const SKY_GROUND = '#b8b1a4'; // d3-allow: the hemisphere light's bounce from the ground
const DAY_SKY = '#ffffff'; // d3-allow: skylight in the 3D model, not chrome
const NIGHT_SKY = '#8ea3c8'; // d3-allow: moonlit skylight in the 3D model, not chrome
const SUN = '#fff4e2'; // d3-allow: sunlight's warmth in the 3D model, not chrome
const GROUND = '#cdc8bd'; // d3-allow: the ground the house stands on in the 3D model, not chrome

interface Frame {
  centre: THREE.Vector3;
  radius: number;
  /** The ground plane's height, metres in the mesh's frame: just under the lowest level. */
  ground: number;
}

function frameOf(model: EditorModel, mesh: HouseMesh): Frame | null {
  const box = mesh.bbox;
  if (box === null) return null;
  const k = mesh.unitsPerMetre;
  const o = mesh.origin;
  const min = new THREE.Vector3((box.min[0] - o[0]) / k, (box.min[1] - o[1]) / k, (box.min[2] - o[2]) / k);
  const max = new THREE.Vector3((box.max[0] - o[0]) / k, (box.max[1] - o[1]) / k, (box.max[2] - o[2]) / k);
  const centre = min.clone().add(max).multiplyScalar(0.5);
  const radius = Math.max(1, min.distanceTo(max) / 2);
  const lowest = model.levels.reduce((z, l) => Math.min(z, l.elevation), Infinity);
  const ground = (Number.isFinite(lowest) ? (lowest - o[2]) / k : min.z) - 0.005;
  return { centre, radius, ground };
}

export interface SunProbe {
  light: THREE.DirectionalLight | null;
  study: Study | null;
  size: number;
  gl: THREE.WebGLRenderer | null;
  scene: THREE.Scene | null;
}

const probes = new WeakMap<EditorStore, SunProbe>();

/** What the rig drew last, for the test hook. */
export function probeOf(store: EditorStore): SunProbe {
  let p = probes.get(store);
  if (p === undefined) {
    p = { light: null, study: null, size: 0, gl: null, scene: null };
    probes.set(store, p);
  }
  return p;
}

const noRaycast = (): void => undefined;

export function SunRig({ store, model, mesh, compact, walking }: { store: EditorStore; model: EditorModel; mesh: HouseMesh; compact: boolean; walking: boolean }) {
  const on = useSunState(store, (s) => s.on);
  const clock = useSunState(store, (s) => s.clock);
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const invalidate = useThree((s) => s.invalidate);
  const study = useStudy(model, on, clock);
  const frame = useMemo(() => frameOf(model, mesh), [model, mesh]);
  const light = useRef<THREE.DirectionalLight>(null);
  const target = useMemo(() => new THREE.Object3D(), []);
  const size = frame === null ? 1024 : shadowMapSize(frame.radius, { compact: compact && !walking, max: gl.capabilities.maxTextureSize });

  // Place the sun and fit its shadow camera to the house.
  useLayoutEffect(() => {
    const l = light.current;
    const probe = probeOf(store);
    probe.study = study;
    probe.gl = gl;
    probe.scene = scene;
    if (l === null || study === null || frame === null) {
      probe.light = null;
      invalidate();
      return;
    }
    const { centre, radius } = frame;
    const [x, y, z] = study.vector;
    const back = radius * 3;
    target.position.copy(centre);
    target.updateMatrixWorld();
    l.position.set(centre.x + x * back, centre.y + y * back, centre.z + z * back);
    l.updateMatrixWorld();
    // Against acne on flat-shaded faces lit edge-on, without peter-panning walls off their floors.
    l.shadow.bias = -0.0004;
    l.shadow.normalBias = 0.03;
    l.shadow.radius = 2;
    const cam = l.shadow.camera;
    const r = radius * 1.05;
    cam.left = -r;
    cam.right = r;
    cam.top = r;
    cam.bottom = -r;
    cam.near = Math.max(0.1, back - radius * 1.1);
    // Beyond the house, along the light: as far as a low sun's shadows reach across the ground.
    const reach = study.position.altitude > 0.5 ? (2 * radius) / Math.tan((study.position.altitude * Math.PI) / 180) : 20 * radius;
    cam.far = back + radius * 1.1 + Math.min(reach, 20 * radius);
    cam.updateProjectionMatrix();
    if (l.shadow.mapSize.x !== size) {
      l.shadow.mapSize.set(size, size);
      l.shadow.map?.dispose();
      l.shadow.map = null;
    }
    l.shadow.needsUpdate = true;
    probe.light = l;
    probe.size = size;
    invalidate();
  }, [study, frame, size, target, store, gl, scene, invalidate]);

  useEffect(() => () => {
    const probe = probeOf(store);
    probe.light = null;
    probe.study = null;
  }, [store]);

  useSunTestHook(store);

  if (study === null || frame === null) {
    return (
      <>
        <hemisphereLight args={[0xffffff, SKY_GROUND, 1.6]} position={[0, 0, 1]} />
        <ambientLight intensity={0.5} />
        <directionalLight position={[-30, -45, 70]} intensity={1.7} />
      </>
    );
  }

  // Twilight from 6° below the horizon (civil) up to sunrise; daylight a few degrees above it.
  const twilight = Math.min(1, Math.max(0, (study.position.altitude + 6) / 6));
  const d = study.daylight;
  // Night stays legible: the house in moonlight, not gone.
  const sky = study.night ? 0.7 + 0.4 * twilight : 0.75 + 0.45 * d;
  return (
    <>
      <hemisphereLight args={[study.night ? NIGHT_SKY : DAY_SKY, SKY_GROUND, sky]} position={[0, 0, 1]} />
      <ambientLight intensity={study.night ? 0.22 : 0.2 + 0.1 * d} />
      <primitive object={target} />
      <directionalLight
        ref={light}
        color={SUN}
        intensity={study.night ? 0 : 2.6 * d}
        castShadow={!study.night}
        target={target}
      />
      <mesh position={[frame.centre.x, frame.centre.y, frame.ground]} receiveShadow raycast={noRaycast} userData={{ ground: true }}>
        <circleGeometry args={[frame.radius * 3, 96]} />
        <meshLambertMaterial color={GROUND} />
      </mesh>
    </>
  );
}

// ─── The test hook ───────────────────────────────────────────────────────────────────────────

export interface SunHook {
  on: boolean;
  located: boolean;
  /** What the solar module computed: degrees, and the unit vector towards the sun in the project's frame. */
  study: { azimuth: number; altitude: number; vector: [number, number, number]; night: boolean; instant: string } | null;
  /** The directional light as three.js has it: towards the light from its target, unit length. */
  light: { direction: [number, number, number]; intensity: number; castShadow: boolean; mapSize: number; frustum: number } | null;
  shadowMap: boolean;
  /** Parts of the house casting and receiving shadows, and whether the ground plane receives. */
  casters: number;
  receivers: number;
  ground: boolean;
  /** Set the clock: local date and time at the site, and the offset (minutes east of UTC). */
  set(clock: { date?: string; minutes?: number; offset?: number | 'auto' }): void;
}

declare global {
  interface Window {
    __floorspecSun?: SunHook;
  }
}

/** Under automation only (navigator.webdriver): the sun's computed and drawn direction. */
function useSunTestHook(store: EditorStore) {
  useEffect(() => {
    if (!navigator.webdriver) return;
    const sun = sunOf(store);
    const probe = probeOf(store);
    const count = (pick: (m: THREE.Mesh) => boolean) => {
      let n = 0;
      probe.scene?.traverse((o) => {
        if (o instanceof THREE.Mesh && (o.userData as { id?: string }).id !== undefined && pick(o as THREE.Mesh)) n++;
      });
      return n;
    };
    const hook: SunHook = {
      get on() { return sun.get().on; },
      get located() { return probe.study !== null; },
      get study() {
        const s = probe.study;
        return s === null ? null : { azimuth: s.position.azimuth, altitude: s.position.altitude, vector: s.vector, night: s.night, instant: new Date(s.instant).toISOString() };
      },
      get light() {
        const l = probe.light;
        if (l === null) return null;
        l.updateMatrixWorld();
        l.target.updateMatrixWorld();
        const from = new THREE.Vector3().setFromMatrixPosition(l.matrixWorld);
        const to = new THREE.Vector3().setFromMatrixPosition(l.target.matrixWorld);
        const dir = from.sub(to).normalize();
        return { direction: [dir.x, dir.y, dir.z] as [number, number, number], intensity: l.intensity, castShadow: l.castShadow, mapSize: l.shadow.mapSize.x, frustum: l.shadow.camera.right - l.shadow.camera.left };
      },
      get shadowMap() { return probe.gl?.shadowMap.enabled ?? false; },
      get casters() { return count((m) => m.castShadow); },
      get receivers() { return count((m) => m.receiveShadow); },
      get ground() {
        let found = false;
        probe.scene?.traverse((o) => {
          if (o instanceof THREE.Mesh && (o.userData as { ground?: boolean }).ground === true && o.receiveShadow) found = true;
        });
        return found;
      },
      set: (clock) => { sun.setClock(clock); },
    };
    window.__floorspecSun = hook;
    return () => {
      if (window.__floorspecSun === hook) delete window.__floorspecSun;
    };
  }, [store]);
}
