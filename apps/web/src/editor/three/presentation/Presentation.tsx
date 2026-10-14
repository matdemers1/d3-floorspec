import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame, useStore, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { PresentationPipeline, ACCUMULATE } from './pipeline';
import { draftShadow, installPresentationShadows, presentationShadow, type Shadowed } from './shadows';
import { untoneMap } from './tone';
import type { PresentationStats, StatsStore } from './stats';
import { indoorMap } from './indoor';
import { installReflectorCodes, keepAlpha, LIGHT, PRESENTATION, restoreAlpha } from './reflectors';
import type { HouseMesh } from '@floorspec/mesh';
import type { EditorModel } from '../../model';

/**
 * The 3D view in Presentation (FLR-T-13.7), loaded only when it is chosen: three.js's post-processing
 * and these passes stay out of the editor's bundle and out of Draft. Mounted inside the canvas, it
 * takes over drawing the frame (a `useFrame` of priority 1) and gives it back when it unmounts —
 * every material, light and setting it touched put back as Draft had it.
 *
 * What it does to the scene, every frame, before drawing it:
 *  - every lit material is compiled with `FLOORSPEC_PRESENTATION`: soft shadows (shadows.ts), the
 *    prefiltered sky for reflections only — the sky's light probe still lights the house, so the
 *    view's light is Draft's — and its kind of reflector written into alpha (reflectors.ts); a lit
 *    lens with `FLOORSPEC_LIGHT`; what is blended over the house (a highlight, an outline) and the
 *    sky's dome keep the alpha under them;
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
installReflectorCodes();

/**
 * How far over the curve's white a lit lens is drawn (the curve's input, after the exposure): a lamp's
 * lens is far brighter than anything it lights (an LED downlight's is some 10⁴ cd/m², a room's walls
 * 50) — so it, and not the surfaces under it, blooms (pipeline.ts BLOOM_THRESHOLD).
 */
export const LENS_OVER_WHITE = 48;
/** Frames per second the view aims for while moving, and the fewest drawn pixels it will go to. */
export const TARGET_FPS = 40;
export const MIN_SCALE = 0.4;
/**
 * Pixels a moving frame starts at: on a laptop's Retina display the drawing buffer is 5–6 million
 * pixels, and every pass is paid per pixel. Moving frames start at about two million and adapt from
 * there; a still frame is always drawn at the full resolution.
 */
export const MOVING_PIXELS = 2.2e6;
/** Milliseconds after the last movement before the full-resolution, refining frames begin. */
export const SETTLE_MS = 140;
/**
 * Milliseconds what every material compiles to must stay the same, the camera still, before the
 * scene is drawn whole to warm the driver (pipeline.ts `warm`). A house's textures arrive one by one
 * — some 250 of them — each changing a material: warmed on every one, the view would draw the whole
 * house unculled again and again and barely refine while they load.
 */
export const WARM_STABLE_MS = 600;

declare global {
  interface Window {
    __floorspecQuality?: PresentationStats & { quality: 'presentation' };
    /** Set by a test: `view` a pass alone (pipeline.ts `debugView`), `scale` the resolution moving, `skip` passes left out. */
    __floorspecQualityTest?: { view?: number; scale?: number; skip?: string[] };
  }
}

const DEFINES = new Set([PRESENTATION, LIGHT]);
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
  /** The last movement held well over the target: the next may draw a step finer. */
  headroom: boolean;
  camera: THREE.Matrix4;
  projection: THREE.Matrix4;
  settle: ReturnType<typeof setTimeout> | 0;
  stats: PresentationStats;
  reported: string;
  envKey: string;
  env: THREE.WebGLRenderTarget | null;
  defined: Set<THREE.Material>;
  /** What every material compiles to, as a sum of their versions and counts; when it last changed; and the last warmed. */
  signature: string;
  changed: { signature: string; at: number };
  warmed: string;
  warm: ReturnType<typeof setTimeout> | 0;
  /** Materials drawn keeping the alpha under them (reflectors.ts keepAlpha). */
  kept: Set<THREE.Material>;
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
    scale: 0,
    frames: [],
    headroom: false,
    camera: new THREE.Matrix4(),
    projection: new THREE.Matrix4(),
    settle: 0,
    stats: { ready: false, fps: null, scale: 1, refined: 0, passes: pipeline.passes, env: false, warms: 0 },
    reported: '',
    envKey: '',
    env: null,
    defined: new Set(),
    signature: '',
    changed: { signature: '', at: 0 },
    warmed: '',
    warm: 0,
    kept: new Set(),
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
      if (s.warm !== 0) clearTimeout(s.warm);
      for (const m of s.defined) {
        m.defines = Object.fromEntries(Object.entries(m.defines ?? {}).filter(([k]) => !DEFINES.has(k)));
        m.needsUpdate = true;
      }
      for (const m of s.kept) restoreAlpha(m);
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
    if (s.scale === 0) {
      const b = gl.getDrawingBufferSize(new THREE.Vector2());
      s.scale = Math.max(MIN_SCALE, Math.min(1, Math.round(Math.sqrt(MOVING_PIXELS / Math.max(1, b.x * b.y)) * 20) / 20));
    }
    // Under automation: a pass shown on its own, or a fixed resolution while moving.
    if (navigator.webdriver) {
      const t = window.__floorspecQualityTest;
      pipeline.debugView = t?.view ?? 0;
      pipeline.skip = new Set(t?.skip ?? []);
      if (t?.scale !== undefined) s.scale = t.scale;
    }
    prepare(s, scene, gl, pmrem);
    const invalidate = s.orig ?? three.invalidate;

    camera.updateMatrixWorld();
    const moved = !s.camera.equals(camera.matrixWorld) || !s.projection.equals(camera.projectionMatrix);
    s.camera.copy(camera.matrixWorld);
    s.projection.copy(camera.projectionMatrix);

    // Anything that changes what a material compiles to (Presentation's first frame, a lamp turned
    // on, a texture or a model arrived): every object drawn once into the passes' buffers, so the
    // driver's pipelines and vertex arrays for the new programs exist before they are needed — once
    // the materials have settled (WARM_STABLE_MS) and the camera is still, not on every change.
    if (s.signature !== s.changed.signature) {
      s.changed = { signature: s.signature, at: now };
      if (s.warm !== 0) clearTimeout(s.warm);
      s.warm = s.signature === s.warmed ? 0 : setTimeout(() => { s.warm = 0; invalidate(); }, WARM_STABLE_MS);
    }
    if (s.signature !== s.warmed && !moved && now - s.lastMove >= SETTLE_MS && now - s.changed.at >= WARM_STABLE_MS) {
      pipeline.warm(scene, camera);
      s.warmed = s.signature;
      s.stats.warms++;
    }

    if (moved) {
      // Moving: as fast as the GPU allows, at the resolution it can keep up with.
      // The resolution changes as little as it can: each change makes the buffers' memory again, a
      // stall of its own. Within a movement it only steps down; a movement that had room to spare
      // lets the next one start a step up. A frame that paid for a change is not measured.
      // Frames of one movement: a slow GPU's frames are far apart, and must still count as one.
      const fixed = navigator.webdriver && window.__floorspecQualityTest?.scale !== undefined;
      if (now - s.lastMove >= 1000) {
        s.frames = [now];
        if (s.headroom && s.scale < 1 && !fixed) {
          s.scale = Math.min(1, Math.round((s.scale / 0.8) * 100) / 100);
          s.frames = [];
        }
        s.headroom = false;
      } else s.frames.push(now);
      if (s.frames.length > 30) s.frames.shift();
      s.lastMove = now;
      s.k = 0;
      s.dirty = false;
      // Over six frames — or three, when they are far too slow to wait for six: the first turn in a
      // room must not spend seconds finding its resolution.
      const n = s.frames.length;
      const fps = n >= 3 ? (1000 * (n - 1)) / Math.max(1, (s.frames[n - 1] ?? now) - (s.frames[0] ?? now)) : null;
      if (fps !== null && n >= 6) s.stats.fps = Math.round(fps);
      if (fps !== null && !fixed) {
        if (fps < TARGET_FPS * 0.9 && s.scale > MIN_SCALE && (n >= 6 || fps < TARGET_FPS * 0.5)) {
          // A frame's cost goes with its pixels, the square of the scale: a step as far as the shortfall asks, between 0.5 and 0.8.
          const step = Math.min(0.8, Math.max(0.5, Math.sqrt(fps / TARGET_FPS)));
          s.scale = Math.max(MIN_SCALE, Math.round(s.scale * step * 100) / 100);
          s.frames = [];
          s.headroom = false;
        } else if (n >= 15) s.headroom = fps > TARGET_FPS * 1.6;
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
  const sig = { meshes: 0, versions: 0, lights: 0 };
  scene.traverse((o) => {
    if (o instanceof THREE.Mesh) sig.meshes++;
    if (o instanceof THREE.Light) sig.lights += o.castShadow ? 1001 : 1;
    if ((o.userData as { sky?: boolean }).sky === true) dome = o as THREE.Mesh;
    if (o instanceof THREE.Light && o.castShadow) {
      const light = o as Shadowed;
      const before = light.shadow?.mapSize.x;
      presentationShadow(light);
      s.lights.add(light);
      if (light.shadow !== undefined && light.shadow.mapSize.x !== before) resized.shadows = true;
    }
    // Not a surface: lines, points and sprites (an outline, a marker) and the sky's dome keep the
    // reflector's code under them, as does whatever is blended normally over the house.
    const overlay = o instanceof THREE.Line || o instanceof THREE.Points || o instanceof THREE.Sprite || (o.userData as { sky?: boolean }).sky === true;
    for (const m of materialsOf(o)) {
      sig.versions += m.version;
      if (overlay || (m.transparent && (m.blending === THREE.NormalBlending || s.kept.has(m)))) {
        if (!s.kept.has(m) && keepAlpha(m)) s.kept.add(m);
      } else if (s.kept.has(m)) {
        restoreAlpha(m);
        s.kept.delete(m);
      }
      const define = lit(m) ? PRESENTATION : (m.userData as { lens?: boolean }).lens === true ? LIGHT : null;
      if (define !== null && !s.defined.has(m)) {
        m.defines = { ...(m.defines ?? {}), [define]: '' };
        m.needsUpdate = true;
        s.defined.add(m);
      }
      if (!lit(m) && !m.toneMapped && 'color' in m && m.color instanceof THREE.Color) {
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
  s.signature = `${String(sig.meshes)}|${String(sig.versions)}|${String(sig.lights)}|${String(scene.environment?.uuid)}`;
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
    // Drawn as it is, not keeping an alpha under it (reflectors.ts keepAlpha): there is nothing under it here.
    material.blending = THREE.NormalBlending;
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
