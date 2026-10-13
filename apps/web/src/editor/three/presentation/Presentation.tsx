import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame, useStore, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { PresentationPipeline, ACCUMULATE } from './pipeline';
import { draftShadow, installPresentationShadows, presentationShadow, type Shadowed } from './shadows';
import { untoneMap } from './tone';
import type { PresentationStats, StatsStore } from './stats';
import { indoorMap } from './indoor';
import type { HouseMesh } from '@floorspec/mesh';
import type { EditorModel } from '../../model';

/**
 * The 3D view in Presentation (FLR-T-13.7), loaded only when it is chosen: three.js's post-processing
 * and these passes stay out of the editor's bundle and out of Draft. Mounted inside the canvas, it
 * takes over drawing the frame (a `useFrame` of priority 1) and gives it back when it unmounts —
 * every material, light and setting it touched put back as Draft had it.
 *
 * What it does to the scene, every frame, before drawing it:
 *  - every lit material is compiled with `FLOORSPEC_PRESENTATION`: soft shadows (shadows.ts), and the
 *    prefiltered sky for reflections only — the sky's light probe still lights the house, so the
 *    view's light is Draft's;
 *  - the sky's dome is prefiltered (three.js's PMREM) into `scene.environment` whenever it changes;
 *  - a colour that must reach the screen as it is (`toneMapped: false`: a selection's outline, an
 *    opening's highlight, the backdrop) is drawn as what the tone curve turns back into it; a lit lens
 *    is drawn as a light (`userData.lens`), far over the curve's white, so it blooms;
 *  - the lights that cast shadows get PCSS's sizes.
 *
 * Moving, it draws at a lower resolution when the GPU cannot keep up (it measures); a moment after
 * the camera stops, it draws at full resolution and keeps refining (pipeline.ts).
 */

installPresentationShadows();

/**
 * How far over the curve's white a lit lens is drawn (the curve's input, after the exposure): a lamp's
 * lens is far brighter than anything it lights (an LED downlight's is some 10⁴ cd/m², a room's walls
 * 50) — so it, and not the surfaces under it, blooms (pipeline.ts BLOOM_THRESHOLD).
 */
export const LENS_OVER_WHITE = 48;
/** Frames per second the view aims for while moving, and the fewest drawn pixels it will go to. */
export const TARGET_FPS = 40;
export const MIN_SCALE = 0.5;
/** Milliseconds after the last movement before the full-resolution, refining frames begin. */
export const SETTLE_MS = 140;

declare global {
  interface Window {
    __floorspecQuality?: PresentationStats & { quality: 'presentation' };
    /** Set by a test: `view` a pass alone (pipeline.ts `debugView`), `scale` the resolution moving, `skip` passes left out. */
    __floorspecQualityTest?: { view?: number; scale?: number; skip?: string[] };
  }
}

const DEFINE = 'FLOORSPEC_PRESENTATION';
const lit = (m: THREE.Material): boolean => m instanceof THREE.MeshStandardMaterial || m instanceof THREE.MeshLambertMaterial || m instanceof THREE.MeshPhongMaterial;
const materialsOf = (o: THREE.Object3D): THREE.Material[] => {
  const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
  return m === undefined ? [] : Array.isArray(m) ? m : [m];
};

interface State {
  dirty: boolean;
  lastMove: number;
  k: number;
  scale: number;
  frames: number[];
  camera: THREE.Matrix4;
  projection: THREE.Matrix4;
  settle: ReturnType<typeof setTimeout> | 0;
  stats: PresentationStats;
  reported: string;
  envKey: string;
  env: THREE.WebGLRenderTarget | null;
  defined: Set<THREE.Material>;
  compiled: number;
  compiling: boolean;
  shown: Map<THREE.Material, Shown>;
  lights: Set<Shadowed>;
  background: { own: THREE.Color; drawn: THREE.Color } | null;
  orig: ((frames?: number) => void) | null;
}

interface Shown {
  /** The colour as the material had it. */
  own: THREE.Color;
  /** What this view set. */
  drawn: THREE.Color;
}

export default function Presentation({ stats, model, mesh }: { stats?: StatsStore; model: EditorModel | null; mesh: HouseMesh | null }) {
  const indoor = useMemo(() => (model === null || mesh === null ? null : indoorMap(model, mesh)), [model, mesh]);
  useEffect(() => () => { indoor?.texture.dispose(); }, [indoor]);
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const r3f = useStore();
  const pipeline = useMemo(() => new PresentationPipeline(gl), [gl]);
  const pmrem = useMemo(() => new THREE.PMREMGenerator(gl), [gl]);
  const state = useRef<State>({
    dirty: true,
    lastMove: -Infinity,
    k: 0,
    scale: 1,
    frames: [],
    camera: new THREE.Matrix4(),
    projection: new THREE.Matrix4(),
    settle: 0,
    stats: { ready: false, fps: null, scale: 1, refined: 0, passes: pipeline.passes, env: false },
    reported: '',
    envKey: '',
    env: null,
    defined: new Set(),
    compiled: 0,
    compiling: false,
    shown: new Map(),
    lights: new Set(),
    background: null,
    orig: null,
  });

  // Every invalidate from elsewhere (a texture arriving, a lamp switched, a selection) starts the
  // refinement again; the view's own refining frames do not.
  useLayoutEffect(() => {
    const s = state.current;
    const orig = r3f.getState().invalidate;
    s.orig = orig;
    r3f.setState({
      invalidate: (frames?: number) => {
        s.dirty = true;
        orig(frames);
      },
    });
    return () => { r3f.setState({ invalidate: orig }); };
  }, [r3f]);

  useEffect(() => {
    const s = state.current;
    gl.shadowMap.needsUpdate = true;
    s.orig?.();
    return () => {
      if (s.settle !== 0) clearTimeout(s.settle);
      for (const m of s.defined) {
        m.defines = Object.fromEntries(Object.entries(m.defines ?? {}).filter(([k]) => k !== DEFINE));
        m.needsUpdate = true;
      }
      for (const [m, c] of s.shown) if ((m as THREE.MeshBasicMaterial).color.equals(c.drawn)) (m as THREE.MeshBasicMaterial).color.copy(c.own);
      for (const l of s.lights) draftShadow(l);
      if (s.background !== null && scene.background instanceof THREE.Color && scene.background.equals(s.background.drawn)) scene.background.copy(s.background.own);
      if (scene.environment === s.env?.texture) scene.environment = null;
      s.env?.dispose();
      pmrem.dispose();
      pipeline.dispose();
      gl.shadowMap.needsUpdate = true;
      if (window.__floorspecQuality?.passes === pipeline.passes) delete window.__floorspecQuality;
      stats?.set(null);
    };
  }, [gl, scene, pipeline, pmrem, stats]);

  useFrame((three) => {
    const s = state.current;
    const camera = three.camera as THREE.PerspectiveCamera;
    const now = performance.now();
    // Under automation: a pass shown on its own, or a fixed resolution while moving.
    if (navigator.webdriver) {
      const t = window.__floorspecQualityTest;
      pipeline.debugView = t?.view ?? 0;
      pipeline.skip = new Set(t?.skip ?? []);
      if (t?.scale !== undefined) s.scale = t.scale;
    }
    const env0 = s.envKey;
    const made0 = pipeline.created;
    prepare(s, scene, gl, pmrem);
    const t0 = performance.now();
    // Every program the scene will need, compiled off the frame (KHR_parallel_shader_compile where
    // the GPU has it): turning to face a room not yet drawn must not stall on compiling its shaders.
    if (s.compiled !== s.defined.size && !s.compiling) {
      s.compiling = true;
      const size = s.defined.size;
      gl.compileAsync(scene, camera)
        .catch(() => undefined)
        .finally(() => {
          s.compiled = size;
          s.compiling = false;
        });
    }

    camera.updateMatrixWorld();
    const moved = !s.camera.equals(camera.matrixWorld) || !s.projection.equals(camera.projectionMatrix);
    s.camera.copy(camera.matrixWorld);
    s.projection.copy(camera.projectionMatrix);
    const invalidate = s.orig ?? three.invalidate;

    if (moved) {
      // Moving: as fast as the GPU allows, at the resolution it can keep up with.
      if (now - s.lastMove < 250) s.frames.push(now);
      else s.frames = [now];
      if (s.frames.length > 30) s.frames.shift();
      s.lastMove = now;
      s.k = 0;
      s.dirty = false;
      const fps = s.frames.length >= 6 ? (1000 * (s.frames.length - 1)) / ((s.frames[s.frames.length - 1] ?? now) - (s.frames[0] ?? now)) : null;
      if (fps !== null) {
        s.stats.fps = Math.round(fps);
        const fixed = navigator.webdriver && window.__floorspecQualityTest?.scale !== undefined;
        if (fixed) {
          // A test holds the resolution.
        } else if (fps < TARGET_FPS * 0.9 && s.scale > MIN_SCALE) s.scale = Math.max(MIN_SCALE, Math.round(s.scale * 0.8 * 100) / 100);
        else if (fps > TARGET_FPS * 1.6 && s.scale < 1) s.scale = Math.min(1, Math.round((s.scale / 0.8) * 100) / 100);
        s.frames = s.frames.slice(-3);
      }
      pipeline.render(scene, camera, { scale: s.scale, env: s.env?.texture ?? null, envIntensity: 1, indoor, accumulate: null });
      s.stats.refined = 0;
      if (s.settle !== 0) clearTimeout(s.settle);
      s.settle = setTimeout(() => { s.settle = 0; invalidate(); }, SETTLE_MS);
    } else {
      if (s.dirty) {
        s.k = 0;
        s.dirty = false;
      }
      if (now - s.lastMove < SETTLE_MS) {
        // Just stopped: keep the last frame up until the settle timer asks for the full one.
        pipeline.present();
      } else if (s.k < ACCUMULATE) {
        s.k = pipeline.render(scene, camera, { scale: 1, env: s.env?.texture ?? null, envIntensity: 1, indoor, accumulate: s.k });
        s.stats.refined = s.k;
        s.stats.ready = true;
        if (s.k < ACCUMULATE) requestAnimationFrame(() => { invalidate(); });
      } else {
        pipeline.present();
      }
    }
    s.stats.scale = s.scale;
    s.stats.env = s.env !== null;
    if (navigator.webdriver) {
      const dt = performance.now() - now;
      const trace = ((window as unknown as { __floorspecQualityTrace?: unknown[] }).__floorspecQualityTrace ??= []);
      if (dt > 40) trace.push({ at: Math.round(now), ms: Math.round(dt), prepare: Math.round(t0 - now), moved, k: s.k, scale: s.scale, made: pipeline.created - made0, env: env0 !== s.envKey });
    }
    const key = `${String(s.stats.ready)}|${String(s.stats.fps)}|${String(s.stats.scale)}|${String(s.stats.refined >= ACCUMULATE)}`;
    if (key !== s.reported) {
      s.reported = key;
      stats?.set({ ...s.stats });
    }
    if (navigator.webdriver) window.__floorspecQuality = Object.assign(s.stats, { quality: 'presentation' as const });
  }, 1);

  return null;
}

/** Per frame: defines, display colours, lamp lenses, light sizes and the sky's reflections. */
function prepare(s: State, scene: THREE.Scene, gl: THREE.WebGLRenderer, pmrem: THREE.PMREMGenerator): void {
  const exposure = gl.toneMappingExposure;
  const mapping = gl.toneMapping;
  let dome: THREE.Mesh | null = null;
  const resized = { shadows: false };
  scene.traverse((o) => {
    if ((o.userData as { sky?: boolean }).sky === true) dome = o as THREE.Mesh;
    if (o instanceof THREE.Light && o.castShadow) {
      const light = o as Shadowed;
      const before = light.shadow?.mapSize.x;
      presentationShadow(light);
      s.lights.add(light);
      if (light.shadow !== undefined && light.shadow.mapSize.x !== before) resized.shadows = true;
    }
    for (const m of materialsOf(o)) {
      if (lit(m)) {
        if (!s.defined.has(m)) {
          m.defines = { ...(m.defines ?? {}), [DEFINE]: '' };
          m.needsUpdate = true;
          s.defined.add(m);
        }
      } else if (!m.toneMapped && 'color' in m && m.color instanceof THREE.Color) {
        const color = m.color;
        let shown = s.shown.get(m);
        // Changed since this view set it (a new accent, a dimmer): that is its own colour now.
        if (shown !== undefined && !color.equals(shown.drawn)) shown = undefined;
        const own = shown?.own ?? color.clone();
        const want = (m.userData as { lens?: boolean }).lens === true ? own.clone().multiplyScalar((LENS_OVER_WHITE * 0.6) / Math.max(exposure, 1e-9)) : new THREE.Color(...untoneMap([own.r, own.g, own.b], mapping, exposure));
        if (shown === undefined || !shown.drawn.equals(want)) {
          color.copy(want);
          s.shown.set(m, { own, drawn: want.clone() });
        }
      }
    }
  });
  if (resized.shadows) gl.shadowMap.needsUpdate = true;
  // The backdrop (the studio's theme colour, or the walkthrough's sky without one).
  if (scene.background instanceof THREE.Color) {
    const bg = scene.background;
    let b = s.background;
    if (b !== null && !bg.equals(b.drawn)) b = null;
    const own = b?.own ?? bg.clone();
    const want = new THREE.Color(...untoneMap([own.r, own.g, own.b], mapping, exposure));
    if (b === null || !b.drawn.equals(want)) {
      bg.copy(want);
      s.background = { own, drawn: want.clone() };
    }
  }
  // The sky's dome, prefiltered for reflections, again whenever it changes.
  const d = dome as THREE.Mesh | null;
  if (d === null) {
    if (s.env !== null && scene.environment === s.env.texture) scene.environment = null;
    s.envKey = '';
    return;
  }
  const u = (d.material as THREE.ShaderMaterial).uniforms;
  const key = ['mapA', 'mapB', 'kA', 'kB', 'tintA', 'tintB', 'trueNorth', 'ground', 'horizon']
    .map((k) => {
      const v = u[k]?.value as { uuid?: string; toArray?: () => number[] } | number | undefined;
      if (typeof v === 'number') return v.toFixed(4);
      if (v?.uuid !== undefined) return v.uuid;
      return v?.toArray?.().map((x) => x.toPrecision(5)).join(',') ?? '';
    })
    .join('|');
  if (key !== s.envKey) {
    s.envKey = key;
    const sky = new THREE.Scene();
    // The dome as it is now, held under half float's largest value: the sky by the sun can pass it,
    // and an infinity in the cube would spread through the prefiltering as NaN.
    const material = (d.material as THREE.ShaderMaterial).clone();
    material.fragmentShader = material.fragmentShader.replace('gl_FragColor = vec4(L, 1.0);', 'gl_FragColor = vec4(min(L, vec3(6.0e4)), 1.0);');
    const copy = new THREE.Mesh(d.geometry, material);
    copy.frustumCulled = false;
    sky.add(copy);
    const before = s.env;
    s.env = pmrem.fromScene(sky, 0, 0.1, 4000, { size: 256 });
    material.dispose();
    scene.environment = s.env.texture;
    before?.dispose();
  } else if (s.env !== null && scene.environment !== s.env.texture) {
    scene.environment = s.env.texture;
  }
}
