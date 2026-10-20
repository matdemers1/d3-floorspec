import { setGroundLook } from '../terrain/ground';
import { siteDrawingOf } from '../../site/Layer';
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { exposureFactor, sunkenOutlines, type HouseMesh } from '@floorspec/mesh';
import { useThreeState } from '../mode';
import type { EditorStore } from '../../store';
import type { EditorModel } from '../../model';
import { mapsFor, skyBounce, skyExposure, skyField, skyHarmonics, skyLight, sunDay, sunsetPlace, type Look, type SkyLight, type SkyPreset } from '@floorspec/mesh/sky';
import { placedSite, shadowMapSize, siteOf, studyOf, sunOf, useLook, useSunState, weatherUnder, type Study } from './study';
import { instantOfClock, midnightOf } from './clock';
import { BOUNCE_LUX, LIT_EXPOSURE, toneMappingExposure } from '../lights';
import { useSkyMaps } from '../sky/maps';
import { Lawn, SkyDome, SkyProbe } from '../sky/SkyScene';
import { setHighlightExposure } from '../highlight';

/**
 * The 3D view's lights (FLR-T-8.6, FLR-T-13.4, FLR-T-13.9): the sky the project is seen under —
 * @floorspec/mesh's presets, the same skies the headless render and the path tracers draw. In the
 * studio, the even light the view has always had. Under any other sky: its HDRI dome round the
 * view, its image-based light (a light probe of its harmonics), the lawn out to the hazy horizon,
 * and its sun — placed by the NOAA algorithm from the site's latitude, longitude and true north at
 * the panel's date and time (an assumed site when the document records none) — as a directional
 * light casting shadows from walls, roofs, slabs and stairs onto floors and the lawn. Past sunset a
 * clear sky darkens through dusk into night and the moon takes the sun's place, too faint to cast.
 * The view is exposed for its sky (`skyExposure`), or for its lamps when the Lights are on, at dusk.
 *
 * The shadow camera is fitted to the house: an orthographic box around its bounding sphere,
 * looking along the sunlight, so every shadow the house casts lands inside it (a receiver in shadow
 * lies on a ray from its occluder, so it shares the occluder's place in the light's view). The
 * shadow map is sized to the house — about 2 cm a texel, between 1024 and 4096 — and halved in the
 * split view.
 */

// What the house is lit by, not interface colour.
const SKY_GROUND = '#b8b1a4'; // d3-allow: the hemisphere light's bounce from the ground
const SUN = '#fff4e2'; // d3-allow: sunlight's warmth in the 3D model, not chrome
const LAMP_BOUNCE = '#fff1e0'; // d3-allow: warm-white lamplight bounced about a room in the 3D model, not chrome

interface Frame {
  centre: THREE.Vector3;
  radius: number;
  /** The ground plane's height, metres in the mesh's frame: just under the lowest level. */
  ground: number;
  /** FLR-T-15.2: where the lawn opens for a sunken pool — each one's outline, metres in the mesh's frame. */
  holes: [number, number][][];
}

function frameOf(model: EditorModel, mesh: HouseMesh): Frame | null {
  const box = shadedBox(mesh);
  if (box === null) return null;
  const k = mesh.unitsPerMetre;
  const o = mesh.origin;
  const min = new THREE.Vector3((box.min[0] - o[0]) / k, (box.min[1] - o[1]) / k, (box.min[2] - o[2]) / k);
  const max = new THREE.Vector3((box.max[0] - o[0]) / k, (box.max[1] - o[1]) / k, (box.max[2] - o[2]) / k);
  const centre = min.clone().add(max).multiplyScalar(0.5);
  const radius = Math.max(1, min.distanceTo(max) / 2);
  const lowest = model.levels.reduce((z, l) => Math.min(z, l.elevation), Infinity);
  const floor = Number.isFinite(lowest) ? (lowest - o[2]) / k : min.z;
  // FLR-T-15.1: on a surveyed site the lawn runs on beyond the terrain at its lowest ground.
  const terrain = siteDrawingOf(model);
  const low = terrain.surface === null ? null : Math.min(terrain.surface.low, ...terrain.graded.map((g) => g.elevation));
  // FLR-T-15.2: a sunken pool's floor is not the ground, and the lawn opens over it.
  const sunken = sunkenOutlines(model.document, model.derived);
  const grade = gradeOf(mesh, floor, new Set(sunken.map((s) => s.id)));
  const holes = sunken.map((s) => s.ring.map((p): [number, number] => [(p[0] - o[0]) / k, (p[1] - o[1]) / k]));
  return { centre, radius, ground: (low === null ? grade : Math.min(grade, (low - o[2]) / k - 0.05)) - 0.005, holes };
}

/**
 * What the shadow map covers: every part but a street's (FLR-T-15.3) — a street runs on past the
 * neighbours' lots and casts no shade worth a texel, while the neighbours and the trees beyond the lot
 * shade the house and stay inside it.
 */
export function shadedBox(mesh: HouseMesh): HouseMesh['bbox'] {
  let out: HouseMesh['bbox'] = null;
  for (const p of mesh.parts) {
    if (p.kind === 'context' && p.model?.kind === 'street') continue;
    const b = p.bbox;
    out = out === null ? { min: [...b.min], max: [...b.max] } : { min: [Math.min(out.min[0], b.min[0]), Math.min(out.min[1], b.min[1]), Math.min(out.min[2], b.min[2])], max: [Math.max(out.max[0], b.max[0]), Math.max(out.max[1], b.max[1]), Math.max(out.max[2], b.max[2])] };
  }
  return out;
}

/**
 * Where the lawn lies (FLR-T-13.4), metres in the view's frame: at the lowest floor — or under
 * whatever is laid at grade a little below it, a slab, a patio, FS_landscape's lawns, beds and
 * pavers (FLR-T-13.5, whose tops sit a few centimetres under the floor) — so the lawn never covers
 * them. Only tops within 0.6 m under the floor count: a basement's is not the ground — nor a sunken
 * pool's water (`skip`, FLR-T-15.2), which the lawn opens for instead.
 */
export function gradeOf(mesh: HouseMesh, floor: number, skip: ReadonlySet<string> = new Set()): number {
  let grade = floor;
  for (const part of mesh.parts) {
    if (part.kind !== 'slab' && part.kind !== 'extension') continue;
    if (skip.has(part.id)) continue;
    const p = part.mesh.positions;
    let top = -Infinity;
    for (let i = 2; i < p.length; i += 3) top = Math.max(top, p[i] ?? -Infinity);
    if (top < floor && top >= floor - 0.6) grade = Math.min(grade, top);
  }
  return grade;
}

export interface SunProbe {
  light: THREE.DirectionalLight | null;
  study: Study | null;
  sky: SkyLight | null;
  /** What the tone curve is given per cd/m²; null in the studio. */
  exposure: number | null;
  /** The document records the site's location. */
  located: boolean;
  size: number;
  gl: THREE.WebGLRenderer | null;
  scene: THREE.Scene | null;
}

const probes = new WeakMap<EditorStore, SunProbe>();

/** What the rig drew last, for the test hook. */
export function probeOf(store: EditorStore): SunProbe {
  let p = probes.get(store);
  if (p === undefined) {
    p = { light: null, study: null, sky: null, exposure: null, located: false, size: 0, gl: null, scene: null };
    probes.set(store, p);
  }
  return p;
}


/**
 * The sky the view is seen under, its sun placed from the site at the clock (FLR-T-13.4, 13.9):
 * `light` is null for the studio, which the 3D view draws its own way; `full` is the sky every
 * renderer draws, the studio's even dome included. `override` asks for another preset at the same
 * date and time (the GPU still's choice).
 */
export function useSkyLight(store: EditorStore, model: EditorModel | null, lamps: boolean, override?: SkyPreset): { light: SkyLight | null; full: SkyLight; study: Study | null; preset: SkyPreset; look: Look } {
  const chosen = useSunState(store, (s) => s.sky);
  const sky = override ?? chosen;
  const clock = useSunState(store, (s) => s.clock);
  // FLR-T-15.4: the season and the weather — the weather the sky drawn is seen in (rain and snow over an overcast one).
  const picked = useLook(store, model);
  const weather = weatherUnder(lamps ? chosen : sky, picked.weather);
  const season = picked.season;
  const site = placedSite(siteOf(model));
  // The light fixtures on (FLR-T-12.22): dusk, so the pools of light the lamps make read — unless it is night.
  const preset: SkyPreset = lamps ? (sky === 'night' ? 'night' : 'dusk') : sky;
  const key = `${String(site.latitude)},${String(site.longitude)},${String(site.trueNorth)}`;
  const minute = instantOfClock(clock);
  const midnight = midnightOf(clock);
  return useMemo(() => {
    const look: Look = { season, weather };
    if (preset === 'studio') return { light: null, full: skyLight('studio', null, site.trueNorth, look), study: null, preset, look };
    const study = studyOf(site, clock);
    const lat = site.latitude ?? 0;
    const lon = site.longitude ?? 0;
    const place = preset === 'dusk' ? (sunsetPlace(sunDay(midnight, lat, lon), lat, lon) ?? null) : study === null ? null : { azimuth: study.position.azimuth, altitude: study.position.altitude };
    const light = skyLight(preset, place, site.trueNorth, look);
    return { light, full: light, study, preset, look };
    // The site by its key and the clock by its minute: a new model with the same site keeps the same sky.
  }, [preset, key, minute, midnight, season, weather]);
}

export function SunRig({ store, model, mesh, compact, walking, lamps = false, casters }: { store: EditorStore; model: EditorModel; mesh: HouseMesh; compact: boolean; walking: boolean; lamps?: boolean; casters?: unknown }) {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const invalidate = useThree((s) => s.invalidate);
  const { light: sky, study } = useSkyLight(store, model, lamps);
  const located = !placedSite(siteOf(model)).assumed;
  const maps = useSkyMaps(sky === null ? [] : mapsFor(sky));
  const field = useMemo(() => (sky === null || maps === null ? null : skyField(sky, maps)), [sky, maps]);
  const sh = useMemo(() => (field === null ? null : skyHarmonics(field)), [field]);
  // FLR-T-15.1: the site's terrain wears the lawn's ground — its season's tint, or snow.
  const groundLook = field?.light.ground ?? null;
  useEffect(() => { setGroundLook(store, groundLook); }, [store, groundLook]);
  useEffect(() => () => { setGroundLook(store, null); }, [store]);
  const exposure = lamps ? LIT_EXPOSURE : field === null || sky === null ? null : skyExposure(sky, field.maps);
  // Exposure compensation (FLR-T-13.10): the camera's, on top of the sky's exposure.
  const compensation = useThreeState(store, (s) => (s.shot === null || s.walking ? 0 : s.shot.exposure));
  const toneExposure = (exposure === null ? 1 : toneMappingExposure(exposure)) * exposureFactor(compensation);
  const direct = sky?.direct ?? null;
  const bounce: { lux: number; color: [number, number, number] } = sky === null ? { lux: 0, color: [1, 1, 1] } : skyBounce(sky);
  // The sun casts shadows; the moon is too faint to.
  const casting = direct !== null && direct.kind === 'sun';
  const frame = useMemo(() => frameOf(model, mesh), [model, mesh]);
  const light = useRef<THREE.DirectionalLight>(null);
  const target = useMemo(() => new THREE.Object3D(), []);
  const size = frame === null ? 1024 : shadowMapSize(frame.radius, { compact: compact && !walking, max: gl.capabilities.maxTextureSize });

  // Place the sun (or the moon) and fit its shadow camera to the house.
  useLayoutEffect(() => {
    const l = light.current;
    const probe = probeOf(store);
    probe.study = study;
    probe.sky = sky;
    probe.gl = gl;
    probe.scene = scene;
    probe.exposure = exposure;
    probe.located = located;
    if (l === null || direct === null || frame === null) {
      probe.light = null;
      invalidate();
      return;
    }
    const { centre, radius } = frame;
    const [x, y, z] = direct.dir;
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
    const reach = direct.place.altitude > 0.5 ? (2 * radius) / Math.tan((direct.place.altitude * Math.PI) / 180) : 20 * radius;
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
  }, [study, sky, direct, frame, size, target, store, gl, scene, invalidate, exposure, located]);

  useEffect(() => () => {
    const probe = probeOf(store);
    probe.light = null;
    probe.study = null;
    probe.sky = null;
  }, [store]);

  useSunTestHook(store);

  // Shadows are drawn again only when what casts them or what lights them changes — not every frame
  // of a walk or an orbit, when only the camera moves (a 4096² sun map and the lamps' maps, redrawn
  // per frame, are most of a frame's time in software WebGL).
  useLayoutEffect(() => {
    gl.shadowMap.autoUpdate = false;
    gl.shadowMap.needsUpdate = true;
    return () => { gl.shadowMap.autoUpdate = true; };
  }, [gl]);
  useLayoutEffect(() => {
    gl.shadowMap.needsUpdate = true;
    invalidate();
  }, [gl, casters, study, sky, frame, size, lamps, walking, invalidate]);

  // The view is exposed for its sky (FLR-T-13.4) — or for lamplight, in lux and candela as the path
  // tracer is (FLR-T-13.1) — and back to the studio's when it is the studio. A selection's glow is
  // given back what the exposure takes, so it reads the same under every sky.
  // Under a sky, the renderers' filmic curve (SkyScene's CustomToneMapping); in the studio, three.js's ACES.
  const curve = field === null && !lamps ? THREE.ACESFilmicToneMapping : THREE.CustomToneMapping;
  useLayoutEffect(() => {
    gl.toneMappingExposure = toneExposure;
    gl.toneMapping = curve;
    setHighlightExposure(toneExposure);
    invalidate();
    return () => { gl.toneMappingExposure = 1; gl.toneMapping = THREE.ACESFilmicToneMapping; setHighlightExposure(1); };
  }, [gl, toneExposure, curve, invalidate]);

  // The studio: the even light the view has always had, on the theme's own backdrop.
  if (sky === null || frame === null) {
    return (
      <>
        <hemisphereLight args={[0xffffff, SKY_GROUND, 1.6]} position={[0, 0, 1]} />
        <ambientLight intensity={0.5} />
        <directionalLight position={[-30, -45, 70]} intensity={1.7} />
      </>
    );
  }
  // The sky's maps on their way: its even light meanwhile, so the house is never dark.
  if (field === null || sh === null) {
    return (
      <>
        <hemisphereLight args={[0xffffff, SKY_GROUND, 1.6]} position={[0, 0, 1]} />
        <ambientLight intensity={0.5} />
      </>
    );
  }
  return (
    <>
      <SkyDome field={field} />
      <SkyProbe sh={sh} />
      {lamps ? <ambientLight color={LAMP_BOUNCE} intensity={BOUNCE_LUX} /> : null}
      {bounce.lux > 0 ? <ambientLight color={new THREE.Color(bounce.color[0], bounce.color[1], bounce.color[2])} intensity={bounce.lux} /> : null}
      <primitive object={target} />
      <directionalLight
        ref={light}
        color={direct === null ? SUN : new THREE.Color(direct.color[0], direct.color[1], direct.color[2])}
        intensity={direct === null ? 0 : direct.lux}
        castShadow={casting}
        target={target}
      />
      <Lawn centre={frame.centre} ground={frame.ground} field={field} holes={frame.holes} />
    </>
  );
}

// ─── The test hook ───────────────────────────────────────────────────────────────────────────

export interface SunHook {
  on: boolean;
  /** The document records the site's location (otherwise the sky is placed from an assumed one). */
  located: boolean;
  /** The sky preset drawn (null in the studio), its band, and the exposure the view is given per cd/m². */
  sky: { preset: SkyPreset; band: 'day' | 'dusk' | 'night'; direct: 'sun' | 'moon' | null; exposure: number | null; dome: boolean; lawn: boolean; ibl: number | null; look: Look; snow: boolean; lawnColor: [number, number, number] | null } | null;
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
      get located() { return probe.located; },
      get sky() {
        const s = probe.sky;
        if (s === null) return null;
        let dome = false;
        let lawn = false;
        let snow = false;
        let lawnColor: [number, number, number] | null = null;
        probe.scene?.traverse((o) => {
          const u = o.userData as { sky?: boolean; lawn?: boolean; snow?: boolean };
          if (u.sky === true) dome = true;
          if (u.lawn === true) {
            lawn = true;
            snow = u.snow === true;
            const m = (o as THREE.Mesh).material as THREE.MeshLambertMaterial;
            lawnColor = [m.color.r, m.color.g, m.color.b];
          }
        });
        let ibl: number | null = null;
        probe.scene?.traverse((o) => {
          if (o instanceof THREE.LightProbe) ibl = (o.sh.coefficients[0]?.y ?? 0) * o.intensity;
        });
        return { preset: s.preset, band: s.band, direct: s.direct?.kind ?? null, exposure: probe.exposure, dome, lawn, ibl, look: s.look, snow, lawnColor };
      },
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
