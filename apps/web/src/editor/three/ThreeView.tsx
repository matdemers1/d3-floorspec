import './three.css';
import { filteredModel, useRenovationFilter, useRenovationStyles } from '../renovation';
import type { RenovationStyle } from '@floorspec/render2d';
import { lazy, Suspense, useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import { DEFAULT_COLOURS, flatShaded, lensGlows, lightsOf, ROLE_LOOKS, settingOf, type HouseMesh, type LensGlow, type MeshPart, type Vec3 } from '@floorspec/mesh';
import { Button, EmptyState, IconButton, SegmentedControl, Select, Spinner, Tooltip } from '@d3cloud/ui';
import { Box, Footprints, House, Lightbulb, Orbit as OrbitIcon, RotateCcw, X } from 'lucide-react';
import { LightingButton, LightingChip, LightingPanel } from './lighting/LightingPanel';
import { controlsOf, houseLights, switchHint } from './lighting/lighting';
import { useEditor, type EditorState, type EditorStore } from '../store';
import { labelOf, type EditorModel, type LevelView } from '../model';
import { formatLen } from '../units';
import { compass, PRESET_ORDER, PRESETS, type PresetId } from './camera';
import { FOV, ThreeController } from './controller';
import { useHouseMesh } from './meshing';
import { threeOf, useThreeState, type LevelsShown, type Quality, type ThreeStore, type WalkStart } from './mode';
import { castsShadow, describeScene, faceColours, isVisible, levelChoiceOf, levelChoices, levelOrder, linear, lookOf, parseLevelChoice, partSelected, type Look } from './parts';
import { isSurfacePart, mappedPartBuffers, surfaceBuffers, type MapRef } from './surfaces';
import { EDITOR_METALNESS_MAX, MATERIAL_TEXTURE_UNITS, paneMaterial, presentationPane, TextureLibrary } from './textures';
import { blocked, entryOf, eyeAt, groundAt, placeAt, roomAt, standAt, WALK, type World } from './walk';
import { SunButton, SunChip, SunPanel, useSunNight } from './sun/SunPanel';
import { StillButton } from './still/StillDialog';
import { orbitCamera } from './still/gpu/cameras';
import { SunRig } from './sun/SunRig';
import { CameraButton, CameraChip, CameraPanel, Framing, type CameraRig } from './shot/CameraPanel';
import { FixtureLights } from './FixtureLights';
import { FilmTimeline } from './film/FilmTimeline';
import { FilmJobCard } from './film/FilmJobCard';
import { FilmMarks, FilmMarksTracker, FilmPathLine, useFilmPath } from './film/FilmPath';
import { useFilmState } from './film/films';
import { eyeOf } from './camera';
import { glow } from './highlight';
import { softwareWebGL } from './software';
import { PRESENTATION_SCENE_TEXTURE_UNITS, SCENE_TEXTURE_UNITS, shadowBudget, viewLights } from './lights';
import { ACCUMULATE, StatsStore, useStats, type PresentationStats } from './presentation/stats';
import { FurnitureScene, useFurnitureModels, visibleExtensionIds, withoutModelled } from '../../furniture/Furniture3D';

/**
 * The 3D view (FLR-T-7.5, FLR-REQ-113, 114), laid out as the board's "08 · Editor — 3D cutaway",
 * "split view" and "Walkthrough" frames: the house as @floorspec/mesh builds it, drawn with three.js
 * through React Three Fiber — orbited, shown whole or cut away by level or one level alone (the
 * "3D levels: whole house" frame, FLR-T-13.2), and walked through at eye height.
 *
 * Selection is the editor's one selection: clicking a part selects its element (a wall, an opening,
 * a room's floor, a stair's flight), which the plan, the tree and the inspector show; selecting
 * anywhere else lights the element's parts here. This module is loaded only when a 3D view is
 * opened — three.js is most of its weight.
 */

const UNITS = 1_280_000;

/**
 * Presentation (FLR-T-13.7): its passes and three.js's post-processing, loaded the first time it is
 * chosen — never in Draft, never in the editor's bundle.
 */
const Presentation = lazy(() => import('./presentation/Presentation'));

/** What the 3D view draws: the ghost of an edit in progress, a proposal under review, the newer side of a comparison, or main. */
function shownModel(s: EditorState): EditorModel | null {
  if (s.preview?.model) return s.preview.model;
  if (s.compare !== null) return s.compare.toModel ?? s.model;
  if (s.side === 'review' && s.review !== null) return s.review.rebased?.model ?? s.review.proposed ?? s.model;
  return s.model;
}

interface Tokens {
  background: string;
  accent: string;
  /** FLR-T-18.13: what is to be demolished, ghosted in it. */
  danger: string;
}

/** The design system's colours, read where the view sits — so the canvas follows the theme. */
function useTokens(host: { current: HTMLElement | null }): Tokens {
  const read = useCallback((): Tokens => {
    const el = host.current ?? document.documentElement;
    const style = getComputedStyle(el);
    return {
      background: style.getPropertyValue('--color-bg-sunken').trim() || 'black',
      accent: style.getPropertyValue('--color-accent').trim() || 'slateblue',
      danger: style.getPropertyValue('--color-danger').trim() || 'crimson',
    };
  }, [host]);
  const [tokens, setTokens] = useState<Tokens>({ background: 'black', accent: 'slateblue', danger: 'crimson' });
  useEffect(() => {
    const update = () => { setTokens(read()); };
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    query.addEventListener('change', update);
    return () => {
      observer.disconnect();
      query.removeEventListener('change', update);
    };
  }, [read]);
  return tokens;
}

// Glass and daylight are what the house is made of and lit by, not interface colour.
const SKY = '#d6e4f0'; // d3-allow: daylight behind the windows in a walkthrough, not chrome
const NIGHT = '#1d2433'; // d3-allow: the night sky behind the windows when the sun study is below the horizon

interface Built {
  part: MeshPart;
  geometry: THREE.BufferGeometry;
  look: Look;
  triangles: number;
  /**
   * A finished surface's draw groups (FLR-T-8.2): slot i draws geometry group i — vertex colours
   * where `null`, a texture's map otherwise. Absent: one material for the whole part.
   */
  slots?: (MapRef | null)[];
}

function buildParts(model: EditorModel, mesh: HouseMesh): Built[] {
  const walls = new Map(model.levels.flatMap((l) => l.walls.map((w) => [w.id, w] as const)));
  return mesh.parts.map((part) => {
    const look = lookOf(part);
    // Walls, floors and ceilings: by finished surface, with texture coordinates in world units (Core 18.3).
    if (isSurfacePart(part) && model.derived !== null) {
      const b = surfaceBuffers(model, mesh, part);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(b.positions, 3));
      geometry.setAttribute('normal', new THREE.BufferAttribute(b.normals, 3));
      geometry.setAttribute('color', new THREE.BufferAttribute(b.colors, 3));
      geometry.setAttribute('uv', new THREE.BufferAttribute(b.uvs, 2));
      b.groups.forEach((g, i) => { geometry.addGroup(g.start, g.count, i); });
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      return { part, geometry, look, triangles: b.positions.length / 9, slots: b.groups.map((g) => g.map) };
    }
    // A roof, a slab, a gable end in a mapped material, and a model's piece the material library
    // dresses (FLR-T-13.6): flat-shaded, with world-scale coordinates.
    const mapped = look === 'pick' || look === 'lens' ? null : mappedPartBuffers(model, mesh, part, (n) => faceColours(model, part, n, walls));
    if (mapped !== null) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(mapped.positions, 3));
      geometry.setAttribute('normal', new THREE.BufferAttribute(mapped.normals, 3));
      geometry.setAttribute('color', new THREE.BufferAttribute(mapped.colors, 3));
      geometry.setAttribute('uv', new THREE.BufferAttribute(mapped.uvs, 2));
      mapped.groups.forEach((g, i) => { geometry.addGroup(g.start, g.count, i); });
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      return { part, geometry, look, triangles: mapped.positions.length / 9, slots: mapped.groups.map((g) => g.map) };
    }
    const { positions, normals } = flatShaded(part.mesh);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    if (look !== 'pick' && (look !== 'glass' || part.model !== undefined)) geometry.setAttribute('color', new THREE.BufferAttribute(faceColours(model, part, normals, walls), 3));
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return { part, geometry, look, triangles: positions.length / 9 };
  });
}

/** Metres, relative to the mesh's origin, of a box in base units. */
function metresBox(mesh: HouseMesh, box: { min: Vec3; max: Vec3 }): { min: Vec3; max: Vec3 } {
  const k = mesh.unitsPerMetre;
  const o = mesh.origin;
  return {
    min: [(box.min[0] - o[0]) / k, (box.min[1] - o[1]) / k, (box.min[2] - o[2]) / k],
    max: [(box.max[0] - o[0]) / k, (box.max[1] - o[1]) / k, (box.max[2] - o[2]) / k],
  };
}

// ─── The view ────────────────────────────────────────────────────────────────────────────────

export default function ThreeView({ store, compact = false }: { store: EditorStore; compact?: boolean }) {
  const three = threeOf(store);
  const fullModel = useEditor(store, shownModel);
  // FLR-T-18.13: a remodel in 3D is its renovation plan's state — the house as it stands, or as it will be —
  // with what is to be demolished ghosted in red in the Demolition and Combined plans.
  const renoFilter = useRenovationFilter(store, fullModel);
  const renoStyles = useRenovationStyles(fullModel, renoFilter);
  const model = useMemo(() => (fullModel === null ? null : filteredModel(fullModel, renoFilter)), [fullModel, renoFilter]);
  const project = useEditor(store, (s) => s.model?.document.project.name ?? s.project?.name ?? 'the house');
  const selection = useEditor(store, (s) => s.selection);
  const levelId = useEditor(store, (s) => s.level);
  const walking = useThreeState(store, (s) => s.walking);
  const walkFrom = useThreeState(store, (s) => s.walkFrom);
  const levels = useThreeState(store, (s) => s.levels);
  const roof = useThreeState(store, (s) => s.roof);
  const preset = useThreeState(store, (s) => s.preset);
  const lightsOn = useThreeState(store, (s) => s.lights);
  const lighting = useThreeState(store, (s) => s.lighting);
  const quality = useThreeState(store, (s) => s.quality);
  const presenting = quality === 'presentation';
  // What Presentation reports: whether its first full frame is drawn, and its frame rate moving.
  const stats = useMemo(() => new StatsStore(), []);
  const originRef = useRef<Vec3 | null>(null);
  const state = useHouseMesh(model, originRef);
  const host = useRef<HTMLDivElement>(null);
  const label = useRef<HTMLDivElement>(null);
  const tokens = useTokens(host);
  const ctl = useMemo(() => new ThreeController(three), [three]);
  const describedBy = useId();
  const night = useSunNight(store, model);
  // The GPU still's "view you are looking at" (FLR-T-13.13): the orbit now, in the glTF export's frame.
  const currentView = useCallback(() => (ctl.orbit === null || originRef.current === null ? null : orbitCamera(ctl.orbit, originRef.current, FOV)), [ctl]);
  // FLR-T-13.10: where the camera is, for saving a view, and going to a saved one.
  const rig = useMemo<CameraRig>(
    () => ({
      current: () => (ctl.orbit === null || originRef.current === null ? null : { orbit: ctl.orbit, origin: originRef.current }),
      goTo: (o) => { ctl.setOrbit(o); },
      // FLR-T-14.1: the camera as a film's keyframe — the walker's eye and a point 3 m ahead of it while walking.
      look: () => {
        const w = ctl.walker;
        if (three.get().walking && w !== null) {
          const [x, y, z] = eyeAt(w, three.get().eyeHeight);
          const c = Math.cos(w.pitch);
          return { eye: [x, y, z], target: [x + 3 * c * Math.cos(w.yaw), y + 3 * c * Math.sin(w.yaw), z + 3 * Math.sin(w.pitch)] };
        }
        return ctl.orbit === null ? null : { eye: eyeOf(ctl.orbit), target: [...ctl.orbit.target] };
      },
    }),
    [ctl, three],
  );
  const size = useSize(host);
  // The lens and frame changed (FLR-T-13.10): draw again, so the camera takes them up.
  const shot = useThreeState(store, (s) => s.shot);
  useEffect(() => { ctl.invalidate(); }, [shot, ctl]);

  const ready = state.status === 'ready' ? state : null;
  // FLR-T-14.1: the film's timeline, and its path and keyframes drawn over the view while it is open.
  const filmOpen = useFilmState(store, (s) => s.open);
  const filmPath = useFilmPath(store, ready?.model ?? null, ready?.mesh.origin ?? null);
  const filmMarks = useRef<HTMLDivElement>(null);
  const built = useMemo(() => (ready === null ? [] : buildParts(ready.model, ready.mesh)), [ready]);
  const textures = useMemo(() => new TextureLibrary(store.projectId, () => { ctl.invalidate(); }), [store, ctl]);
  // The texture units a fragment shader may sample on this GPU: 16 on most, and what decides how many lamps cast shadows.
  const [textureUnits, setTextureUnits] = useState(16);
  useEffect(() => () => { textures.dispose(); }, [textures]);
  useEffect(() => () => { for (const b of built) b.geometry.dispose(); }, [built]);

  // The physics follows the mesh; the first mesh frames the camera.
  useEffect(() => {
    if (ready === null) return;
    ctl.world = ready.world;
    ctl.mesh = ready.mesh;
    if (ctl.orbit === null && ready.mesh.bbox !== null) {
      ctl.fit(metresBox(ready.mesh, ready.mesh.bbox));
      // The canvas may not have measured itself yet: frame again once it has.
      if (ctl.size.width <= 1) ctl.reframeOnResize = true;
    }
    ctl.invalidate();
  }, [ready, ctl]);

  // Into or out of the split view: the canvas changes shape, so the house is framed again for it.
  const shaped = useRef(compact);
  useEffect(() => {
    if (shaped.current === compact) return;
    shaped.current = compact;
    ctl.reframeOnResize = true;
  }, [compact, ctl]);

  // Walking: start where asked, or at the entry; stop and the orbit camera is where it was.
  useEffect(() => {
    if (!walking) {
      ctl.walker = null;
      ctl.keys.clear();
      ctl.invalidate();
      return;
    }
    if (ready === null) return;
    if (walkFrom !== null) {
      ctl.walker = startAt(ready.world, ready.mesh, ready.model, walkFrom);
      three.set({ walkFrom: null });
    } else if (ctl.walker === null) {
      ctl.walker = entryOf(ready.world, ready.model, ready.mesh, levelId);
    }
    if (ctl.walker === null) three.stopWalking();
    ctl.invalidate();
  }, [walking, walkFrom, ready, ctl, three, levelId]);

  const order = useMemo(() => (ready === null ? new Map<string, number>() : levelOrder(ready.model)), [ready]);
  const visible = useMemo(
    () => built.filter((b) => isVisible(b.part, { walking, levels, roof, level: levelId, order })),
    [built, walking, levels, roof, levelId, order],
  );
  // FLR-T-12.22: the light fixtures as lamps, on the levels shown, when the Lights toggle is on.
  const lamps = useMemo(
    () => {
      if (ready === null || !lightsOn) return [];
      // Presentation samples the sky's reflection map beside a surface's maps: one shadowed lamp fewer (FLR-T-13.7).
      const budget = shadowBudget(textureUnits, MATERIAL_TEXTURE_UNITS, presenting ? PRESENTATION_SCENE_TEXTURE_UNITS : SCENE_TEXTURE_UNITS);
      const lit = viewLights(ready.model, ready.mesh, { level: levelId, cutaway: levels !== 'house' && !walking, order }, lighting, budget);
      // One level alone (FLR-T-13.2): its own lamps only — the cutaway's, less those below it.
      return levels === 'only' && !walking ? lit.filter((l) => l.level === levelId) : lit;
    },
    [ready, lightsOn, levelId, levels, walking, order, lighting, textureUnits, presenting],
  );
  // FLR-T-13.12: every light of the house, and the lenses the lighting turns off, dims or recolours.
  const allLights = useMemo(() => (ready === null ? [] : houseLights(ready.model)), [ready]);
  const glows = useMemo(
    () => (ready === null || ready.model.derived === null || !lightsOn ? new Map<string, LensGlow>() : lensGlows(allLights, lightsOf(ready.model.view, ready.model.derived, lighting))),
    [ready, allLights, lightsOn, lighting],
  );
  const allIds = useMemo(() => allLights.map((l) => l.id), [allLights]);
  // A switch's hover tip, and what the last flip did (spoken, and shown for a moment).
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  const [flipped, setFlipped] = useState<string | null>(null);
  useEffect(() => {
    if (flipped === null) return;
    const t = window.setTimeout(() => { setFlipped(null); }, 2500);
    return () => { window.clearTimeout(t); };
  }, [flipped]);
  /** Flip what a switch (or a lamp) controls, when the view's lights are on: true when it was one. */
  const flip = (id: string): boolean => {
    if (ready === null || !lightsOn) return false;
    const controls = controlsOf(ready.model, id, allLights);
    if (controls === null) return false;
    const now = three.get().lighting;
    const before = controls.some((c) => settingOf(now, c) !== null);
    three.flipSwitch(controls, allIds);
    setFlipped(`${labelOf(ready.model, id)}: ${String(controls.length)} light${controls.length === 1 ? '' : 's'} ${before ? 'off' : 'on'}`);
    setTip(null);
    return true;
  };
  const summary = useMemo(() => (ready === null ? '' : describeScene(ready.model, visible.map((b) => b.part))), [ready, visible]);
  // Furniture (FLR-T-8.3): each item's glTF model in place of its fallback box, once the model is drawn.
  const furniture = useFurnitureModels(store.projectId, ready?.model ?? null);
  const partsShown = useMemo(() => withoutModelled(visible, furniture.drawn), [visible, furniture.drawn]);
  const extensionIds = useMemo(() => visibleExtensionIds(visible), [visible]);
  const clearancesShown = useEditor(store, (s) => s.layers.clearances);
  const triangles = visible.reduce((n, b) => n + b.triangles, 0);
  // What casts a shadow, as one value: a new one when the parts, the furniture or the lamps drawn change.
  const shadowKey = useMemo(() => ({ partsShown, drawn: furniture.drawn, lamps }), [partsShown, furniture.drawn, lamps]);

  useTestHook(store, three, ctl, ready, host, built, visible, textures);

  // ── Orbit: pointer, wheel and keys on the canvas.
  const pointers = useRef(new Map<number, { x: number; y: number; button: number; shift: boolean }>());
  const travelled = useRef(0);
  const pinch = useRef<number | null>(null);
  const locked = useRef(false);

  const onPointerDown = (e: React.PointerEvent) => {
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY, button: e.button, shift: e.shiftKey });
    if (pointers.current.size === 1) travelled.current = 0;
    pinch.current = null;
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (locked.current) return;
    const p = pointers.current.get(e.pointerId);
    if (p === undefined) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    travelled.current += Math.hypot(dx, dy);
    // Captured only once it is a drag: a click must still reach the scene's own picking.
    if (travelled.current > 5 && !(e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    if (pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      if (a !== undefined && b !== undefined) {
        const before = Math.hypot(a.x - b.x, a.y - b.y);
        p.x = e.clientX;
        p.y = e.clientY;
        const after = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch.current !== null && before > 0 && after > 0 && !walking) ctl.zoom(before / after);
        pinch.current = after;
        if (walking) ctl.lookBy(dx / 2, dy / 2);
        else ctl.pan(dx / 2, dy / 2);
      }
      return;
    }
    p.x = e.clientX;
    p.y = e.clientY;
    if (walking) ctl.lookBy(dx, dy);
    else if (p.button === 2 || p.button === 1 || p.shift || e.shiftKey) ctl.pan(dx, dy);
    else ctl.rotate(dx, dy);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    // A click with a mouse while walking takes the pointer for mouse-look (Esc gives it back).
    if (walking && e.pointerType === 'mouse' && travelled.current < 5 && document.pointerLockElement === null) {
      const gl = host.current?.querySelector('canvas');
      try {
        const asked = gl?.requestPointerLock();
        asked?.catch(() => undefined);
      } catch {
        // Pointer lock refused (an embedded frame, a headless browser): dragging still looks around.
      }
    }
  };
  const dragged = () => travelled.current > 5;

  useEffect(() => {
    const el = host.current?.querySelector<HTMLElement>('.fs-three__gl');
    if (el === null || el === undefined) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (!three.get().walking) ctl.zoom(Math.exp((e.deltaY * (e.deltaMode === 1 ? 20 : 1)) * 0.0015));
    };
    const onLock = () => {
      locked.current = document.pointerLockElement !== null && el.contains(document.pointerLockElement);
    };
    const onMouse = (e: MouseEvent) => {
      if (locked.current) ctl.lookBy(e.movementX, e.movementY);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    document.addEventListener('pointerlockchange', onLock);
    document.addEventListener('mousemove', onMouse);
    return () => {
      el.removeEventListener('wheel', onWheel);
      document.removeEventListener('pointerlockchange', onLock);
      document.removeEventListener('mousemove', onMouse);
    };
  }, [ctl, three, ready]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (walking || e.metaKey || e.ctrlKey || e.altKey) return;
    const step = Math.PI / 18;
    const handled = (() => {
      if (e.shiftKey && e.key.startsWith('Arrow')) {
        const px = 40;
        const moves: Record<string, [number, number]> = { ArrowLeft: [px, 0], ArrowRight: [-px, 0], ArrowUp: [0, px], ArrowDown: [0, -px] };
        const m = moves[e.key];
        if (m !== undefined) ctl.pan(m[0], m[1]);
        return m !== undefined;
      }
      switch (e.key) {
        case 'Enter': return selection !== null && flip(selection);
        case 'ArrowLeft': ctl.orbitBy(step, 0); return true;
        case 'ArrowRight': ctl.orbitBy(-step, 0); return true;
        case 'ArrowUp': ctl.orbitBy(0, step / 2); return true;
        case 'ArrowDown': ctl.orbitBy(0, -step / 2); return true;
        case '+': case '=': ctl.zoom(0.8); return true;
        case '-': case '_': ctl.zoom(1.25); return true;
        case 'Home': case '0':
          if (ready?.mesh.bbox) ctl.fit(metresBox(ready.mesh, ready.mesh.bbox));
          return true;
        default: return false;
      }
    })();
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  // ── Walking keys: on the window, ahead of the editor's own shortcuts, while walking.
  useEffect(() => {
    if (!walking) return;
    const MOVE = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight']);
    const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));
    const down = (e: KeyboardEvent) => {
      if (typing(e.target) || e.metaKey || e.ctrlKey || e.altKey || document.querySelector('[role="dialog"]') !== null) return;
      if (e.key === 'Escape') {
        if (document.pointerLockElement !== null) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        three.stopWalking();
        return;
      }
      if (!MOVE.has(e.code)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      ctl.keys.add(e.code);
      ctl.invalidate();
    };
    const up = (e: KeyboardEvent) => {
      if (!MOVE.has(e.code)) return;
      ctl.keys.delete(e.code);
      e.stopImmediatePropagation();
    };
    const blur = () => { ctl.keys.clear(); };
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    window.addEventListener('blur', blur);
    host.current?.querySelector<HTMLElement>('.fs-three__gl')?.focus();
    return () => {
      window.removeEventListener('keydown', down, true);
      window.removeEventListener('keyup', up, true);
      window.removeEventListener('blur', blur);
      ctl.keys.clear();
      if (document.pointerLockElement !== null) document.exitPointerLock();
    };
  }, [walking, ctl, three]);

  // ── Picking.
  const onClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    if (dragged()) return;
    const id = (e.object.userData as { id?: string }).id;
    // FLR-T-13.12: with the lights on, a switch turns its lights on or off, and a lamp itself — walking too.
    if (id !== undefined) flip(id);
    if (walking) return;
    if (id !== undefined) store.select(id);
  };
  const onHover = (e: ThreeEvent<PointerEvent>) => {
    const id = (e.object.userData as { id?: string }).id;
    const controls = ready === null || id === undefined || !lightsOn ? null : controlsOf(ready.model, id, allLights);
    const box = host.current?.getBoundingClientRect();
    if (controls === null || id === undefined || ready === null || box === undefined) {
      if (tip !== null) setTip(null);
      return;
    }
    e.stopPropagation();
    setTip({ x: e.nativeEvent.clientX - box.left, y: e.nativeEvent.clientY - box.top, text: `${labelOf(ready.model, id)} — ${switchHint(lighting, lightsOn, controls)}` });
  };
  const onDoubleClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    if (ready === null || walking) return;
    const kind = (e.object.userData as { kind?: string }).kind;
    if (kind !== 'floor' && kind !== 'slab' && kind !== 'stairFlight' && kind !== 'stairLanding') return;
    const yaw = ctl.orbit === null ? 0 : ctl.orbit.azimuth + Math.PI;
    ctl.walker = standAt(ready.world, e.point.x, e.point.y, yaw, e.point.z);
    three.set({ walking: true, walkFrom: null });
  };

  const name = walking ? `Walkthrough of ${project}` : `3D view of ${project}`;
  const hint = walking
    ? 'W, A, S and D or the arrow keys walk and turn; drag to look around; Shift walks faster; Escape ends the walk.'
    : 'Arrow keys orbit, Shift and the arrows pan, plus and minus zoom, Page Up and Page Down change the level, Home frames the house. Use the plan view for full keyboard editing.';

  let body: ReactNode;
  if (model === null || state.status === 'loading') {
    body = (
      <div className="fs-three__message">
        <Spinner size="lg" label="Building the 3D model" />
      </div>
    );
  } else if (state.status === 'invalid' || state.status === 'empty' || state.status === 'error') {
    body = (
      <div className="fs-three__message">
        <EmptyState
          kind={state.status === 'error' ? 'error' : 'empty'}
          size="inline"
          icon={<Box />}
          heading={state.status === 'invalid' ? 'Nothing to show in 3D' : state.status === 'empty' ? 'Nothing to show in 3D yet' : 'The 3D view could not start'}
          action={
            <Button variant="secondary" size="sm" onClick={() => { three.setMode('plan'); }}>
              Back to the plan
            </Button>
          }
        >
          {state.status === 'invalid'
            ? 'This version of the model does not validate, so nothing is derived to build in 3D. The plan shows what is wrong.'
            : state.status === 'empty'
              ? 'Draw walls, a slab, a roof or a stair on the plan and they appear here.'
              : `This browser could not build or draw the model in 3D (${state.message}).`}
        </EmptyState>
      </div>
    );
  } else {
    body = (
      <Canvas
        className="fs-three__canvas"
        frameloop={walking ? 'always' : 'demand'}
        dpr={[1, 2]}
        shadows={softwareWebGL() ? 'basic' : 'percentage'}
        gl={{ antialias: true, powerPreference: 'high-performance' }}
        camera={{ fov: FOV, near: 0.05, far: 4000, position: [0, -20, 10], up: [0, 0, 1] }}
        onPointerMissed={(e: MouseEvent) => {
          if (!dragged() && !walking && e.type === 'click') store.select(null);
        }}
        onCreated={({ gl }) => {
          gl.domElement.setAttribute('aria-hidden', 'true');
          setTextureUnits(gl.capabilities.maxTextures);
        }}
      >
        <color attach="background" args={[walking ? (night || lightsOn ? NIGHT : SKY) : tokens.background]} />
        {ready !== null ? <SunRig store={store} model={ready.model} mesh={ready.mesh} compact={compact} walking={walking} lamps={lightsOn} casters={shadowKey} /> : null}
        <FixtureLights lights={lamps} />
        <Rig ctl={ctl} />
        <SceneBridge />
        <Parts visible={partsShown} reno={renoStyles} danger={tokens.danger} selection={walking ? null : selection} accent={tokens.accent} textures={textures} lit={lightsOn} glows={glows} quality={quality} onClick={onClick} onDoubleClick={onDoubleClick} onHover={onHover} onLeave={() => { if (tip !== null) setTip(null); }} />
        {ready !== null ? <FurnitureScene furniture={furniture} mesh={ready.mesh} visibleIds={extensionIds} selection={walking ? null : selection} accent={tokens.accent} clearances={clearancesShown && !walking} onClick={onClick} /> : null}
        {!walking ? <LabelTracker built={visible} selection={selection} el={label} /> : null}
        {!walking && filmPath !== null ? (
          <>
            <FilmPathLine points={filmPath.points} color={tokens.accent} />
            <FilmMarksTracker marks={filmPath.marks} el={filmMarks} />
          </>
        ) : null}
        {presenting ? (
          <Suspense fallback={null}>
            <Presentation stats={stats} model={ready?.model ?? null} mesh={ready?.mesh ?? null} />
          </Suspense>
        ) : null}
      </Canvas>
    );
  }

  const selectedLabel = selection === null || ready === null || !built.some((b) => partSelected(b.part, selection)) ? null : labelOf(ready.model, selection);

  return (
    <div className="fs-three" ref={host} data-walking={walking ? 'on' : undefined} data-compact={compact ? 'on' : undefined}>
      <div
        className="fs-three__gl"
        role="application"
        aria-label={name}
        aria-describedby={describedBy}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onContextMenu={(e) => { e.preventDefault(); }}
      >
        {body}
      </div>
      <div id={describedBy} className="fs-three__sr">
        {summary} {selectedLabel === null ? '' : `Selected: ${selectedLabel}.`} {hint}
      </div>
      <div className="fs-three__sr" role="status" aria-live="polite">
        {flipped ?? ''}
      </div>
      {tip !== null ? (
        <div className="fs-three__switch-tip" style={{ left: tip.x + 14, top: tip.y + 18 }} aria-hidden="true">
          {tip.text}
        </div>
      ) : null}
      {flipped !== null ? (
        <div className="fs-three__chip fs-three__flipped" aria-hidden="true">
          <Lightbulb aria-hidden="true" />
          {flipped}
        </div>
      ) : null}
      {ready !== null && !walking ? <Framing store={store} model={ready.model} width={size.width} height={size.height} /> : null}
      {ready !== null && !walking && filmPath !== null ? <FilmMarks store={store} marks={filmPath.marks} el={filmMarks} /> : null}
      {ready !== null && !walking && selectedLabel !== null ? (
        <div className="fs-three__label" ref={label} aria-hidden="true">
          {selectedLabel}
        </div>
      ) : null}
      {ready !== null && !walking && !compact ? (
        <>
          <Toolbar store={store} three={three} ctl={ctl} mesh={ready.mesh} levels={levels} roof={roof} lights={lightsOn} />
          <LevelsControl store={store} three={three} model={ready.model} order={order} levels={levels} level={levelId} />
          <ViewCube ctl={ctl} preset={preset} />
          <StillButton store={store} preset={preset} level={levels === 'house' ? null : levelId} only={levels === 'only'} roof={roof} current={currentView} />
          <SunPanel store={store} model={ready.model} />
          <LightingPanel store={store} model={ready.model} />
          <CameraPanel store={store} model={ready.model} rig={rig} />
          <SunChip store={store} />
          {!filmOpen ? (
            <div className="fs-three__chips-left">
              <QualityControl three={three} quality={quality} />
              <StatsChip quality={quality} stats={stats} parts={visible.length} triangles={triangles} />
              <LightingChip store={store} model={ready.model} />
              <CameraChip store={store} model={ready.model} />
            </div>
          ) : null}
          <FilmJobCard store={store} />
        </>
      ) : null}
      {ready !== null && !compact ? <FilmTimeline store={store} model={ready.model} rig={rig} /> : null}
      {ready !== null && !walking && compact ? (
        <>
          <div className="fs-three__chip fs-three__pane-label" role="note">
            <Box aria-hidden="true" />
            3D · {preset === null ? 'free' : PRESETS[preset].label}
          </div>
          <LevelsControl store={store} three={three} model={ready.model} order={order} levels={levels} level={levelId} />
        </>
      ) : null}
      {ready !== null && walking ? <WalkOverlay store={store} three={three} ctl={ctl} world={ready.world} model={ready.model} mesh={ready.mesh} /> : null}
    </div>
  );
}

/** An element's size, CSS pixels, as it changes: the frame the framing guides are drawn in (FLR-T-13.10). */
function useSize(el: { current: HTMLElement | null }): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const node = el.current;
    if (node === null) return;
    const measure = () => {
      const r = node.getBoundingClientRect();
      setSize((s) => (s.width === r.width && s.height === r.height ? s : { width: r.width, height: r.height }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(node);
    return () => { ro.disconnect(); };
  }, [el]);
  return size;
}

/** Stand at a requested point: on the floor of its level, facing the given way or into the house. */
function startAt(world: World, mesh: HouseMesh, model: EditorModel, from: WalkStart) {
  const k = mesh.unitsPerMetre;
  const x = (from.x - mesh.origin[0]) / k;
  const y = (from.y - mesh.origin[1]) / k;
  const level = from.level === null ? undefined : model.levels.find((l) => l.id === from.level);
  const near = level === undefined ? Infinity : (level.elevation - mesh.origin[2]) / k;
  let yaw = from.yaw;
  if (yaw === null) {
    // Towards the middle of the house, or east when standing in it.
    const box = mesh.bbox === null ? null : metresBox(mesh, mesh.bbox);
    const cx = box === null ? 0 : (box.min[0] + box.max[0]) / 2;
    const cy = box === null ? 0 : (box.min[1] + box.max[1]) / 2;
    yaw = Math.hypot(cx - x, cy - y) < 0.5 ? 0 : Math.atan2(cy - y, cx - x);
  }
  return standAt(world, x, y, yaw, near);
}

// ─── Inside the canvas ───────────────────────────────────────────────────────────────────────

function Rig({ ctl }: { ctl: ThreeController }) {
  const invalidate = useThree((s) => s.invalidate);
  const size = useThree((s) => s.size);
  useEffect(() => {
    ctl.invalidate = () => { invalidate(); };
    invalidate();
  }, [ctl, invalidate]);
  useEffect(() => {
    ctl.size = { width: size.width, height: size.height };
    if (ctl.reframeOnResize && ctl.mesh?.bbox) {
      ctl.reframeOnResize = false;
      ctl.reframe(metresBox(ctl.mesh, ctl.mesh.bbox));
    }
    invalidate();
  }, [ctl, size, invalidate]);
  useFrame((state, dt) => {
    ctl.frame(state.camera, dt);
  });
  return null;
}

function Parts({
  visible,
  reno,
  danger,
  selection,
  accent,
  textures,
  lit,
  glows,
  quality,
  onClick,
  onDoubleClick,
  onHover,
  onLeave,
}: {
  visible: Built[];
  /** FLR-T-18.13: each element's renovation style; a demolished one is ghosted in red. */
  reno: ReadonlyMap<string, RenovationStyle> | null;
  danger: string;
  selection: string | null;
  accent: string;
  textures: TextureLibrary;
  /** The light fixtures are on: a lens glows; off, it is matte like the rest. */
  lit: boolean;
  /** FLR-T-13.12: the lenses the lighting turns off (null) or dims and recolours (a scale per channel). */
  glows: ReadonlyMap<string, LensGlow>;
  quality: Quality;
  onClick: (e: ThreeEvent<MouseEvent>) => void;
  onDoubleClick: (e: ThreeEvent<MouseEvent>) => void;
  onHover: (e: ThreeEvent<PointerEvent>) => void;
  onLeave: () => void;
}) {
  const presenting = quality === 'presentation';
  const materials = useMemo(() => (presenting ? presentationMaterials() : draftMaterials()), [presenting]);
  useEffect(() => () => { for (const m of Object.values(materials)) m.dispose(); }, [materials]);
  // Presentation's untextured model pieces in their role's finish (FLR-T-13.7): a glossy counter, a matte sofa.
  const roles = useMemo(() => new Map<string, THREE.MeshStandardMaterial>(), [materials]);
  useEffect(() => () => { for (const m of roles.values()) m.dispose(); }, [roles]);
  // Presentation's panes: a transmitting pass, and a reflecting one drawn over it.
  const panes = useMemo(() => (presenting ? { glass: presentationPane(linear(DEFAULT_COLOURS.glass)), model: presentationPane(linear(ROLE_LOOKS.glass.color)) } : null), [presenting]);
  useEffect(() => () => { if (panes !== null) for (const p of [panes.glass, panes.model]) { p.transmit.dispose(); p.reflect.dispose(); } }, [panes]);
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    materials.solidOn.emissive.set(accent);
    materials.ceilingOn.emissive.set(accent);
    materials.floorOn.emissive.set(accent);
    materials.lensOn.emissive.set(accent);
    materials.glassOn.color.set(accent);
    materials.pickOn.color.set(accent);
    materials.edges.color.set(accent);
    textures.setAccent(accent);
    invalidate();
  }, [accent, materials, textures, invalidate]);

  const selected = useMemo(() => visible.filter((b) => partSelected(b.part, selection)), [visible, selection]);
  const outlines = useMemo(() => selected.map((b) => ({ key: b.part.key, geometry: new THREE.EdgesGeometry(b.geometry, 30) })), [selected]);
  useEffect(() => () => { for (const o of outlines) o.geometry.dispose(); }, [outlines]);
  useEffect(() => { invalidate(); }, [visible, selection, invalidate, materials]);

  // A dimmed or recoloured lens: the lit lens's material, its colour scaling the vertex colours.
  const dimmed = useMemo(() => new Map<string, THREE.MeshBasicMaterial>(), []);
  useEffect(() => () => { for (const m of dimmed.values()) m.dispose(); }, [dimmed]);
  const lensOf = (id: string): THREE.Material => {
    const g = glows.get(id);
    if (g === undefined) return materials.lens;
    if (g === null) return materials.lensOff;
    const key = g.map((c) => c.toFixed(3)).join(',');
    let m = dimmed.get(key);
    if (m === undefined) {
      // A dimmer dragged makes a material a step; keep the last few.
      if (dimmed.size > 96) {
        const first = dimmed.keys().next().value;
        if (first !== undefined) dimmed.delete(first);
      }
      m = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false, color: new THREE.Color(g[0], g[1], g[2]) });
      // A light, not a colour: Presentation draws it over the tone curve's white, and it blooms.
      m.userData = { lens: true };
      dimmed.set(key, m);
    }
    return m;
  };
  useEffect(() => { invalidate(); }, [glows, invalidate]);
  const roleMaterial = (b: Built): THREE.Material => {
    const role = b.part.model?.role;
    if (!presenting || role === undefined) return materials.solid;
    let m = roles.get(role);
    if (m === undefined) {
      const look = ROLE_LOOKS[role];
      m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: look.roughness, metalness: Math.min(EDITOR_METALNESS_MAX, look.metallic) });
      roles.set(role, m);
    }
    return m;
  };
  const demolished = useMemo(() => new THREE.MeshLambertMaterial({ transparent: true, opacity: 0.38, depthWrite: false }), []);
  useEffect(() => () => { demolished.dispose(); }, [demolished]);
  useEffect(() => { demolished.color.set(danger); }, [demolished, danger]);
  const ghosted = (b: Built, on: boolean): boolean => !on && reno?.get(b.part.id) === 'demolished';
  const materialOf = (b: Built, on: boolean) => {
    if (ghosted(b, on)) return demolished;
    if (b.look === 'glass') return on ? materials.glassOn : panes !== null ? (b.part.model !== undefined ? panes.model : panes.glass).transmit : b.part.model !== undefined ? materials.modelGlass : materials.glass;
    if (b.look === 'lens') return on ? materials.lensOn : lit ? lensOf(b.part.id) : materials.lensOff;
    if (b.look === 'pick') return on ? materials.pickOn : materials.pick;
    if (b.look === 'ceiling') return on ? materials.ceilingOn : materials.ceiling;
    if (b.look === 'floor') return on ? materials.floorOn : materials.floor;
    return on ? materials.solidOn : roleMaterial(b);
  };
  /** Presentation: a textured slot in library glass gets the reflecting pass over its transmitting one. */
  const slotOf = (b: Built, m: MapRef | null, on: boolean): THREE.Material => {
    if (m === null || ghosted(b, on)) return materialOf(b, on);
    if (panes !== null && !on && (m.glass === true || b.look === 'glass')) return panes.glass.transmit;
    return textures.material(m, b.look, on);
  };
  const reflects = (b: Built): boolean => panes !== null && !partSelected(b.part, selection) && (b.look === 'glass' || (b.slots ?? []).some((m) => m?.glass === true));

  return (
    <group onClick={onClick} onDoubleClick={onDoubleClick} onPointerMove={onHover} onPointerOut={onLeave}>
      {visible.map((b) => (
        <mesh
          key={b.part.key}
          geometry={b.geometry}
          material={b.slots === undefined ? materialOf(b, partSelected(b.part, selection)) : b.slots.map((m) => slotOf(b, m, partSelected(b.part, selection)))}
          userData={{ id: b.part.id, kind: b.part.kind, key: b.part.key }}
          castShadow={castsShadow(b.part, b.look)}
          receiveShadow={b.look !== 'glass' && b.look !== 'pick'}
          renderOrder={b.look === 'glass' || b.look === 'pick' ? 1 : 0}
        />
      ))}
      {panes !== null
        ? visible.filter(reflects).map((b) => (
            <mesh
              key={`reflect:${b.part.key}`}
              geometry={b.geometry}
              material={b.slots === undefined ? (b.part.model !== undefined ? panes.model : panes.glass).reflect : b.slots.map((m) => (m?.glass === true || b.look === 'glass' ? panes.glass.reflect : HIDDEN))}
              renderOrder={1.5}
              raycast={noRaycast}
            />
          ))
        : null}
      {outlines.map((o) => (
        <lineSegments key={`edges:${o.key}`} geometry={o.geometry} material={materials.edges} renderOrder={2} raycast={noRaycast} />
      ))}
    </group>
  );
}

/** A slot the reflecting pass leaves undrawn. */
const HIDDEN = new THREE.MeshBasicMaterial({ visible: false });

/** Draft's materials (as the view has always drawn): Lambert's even diffuse, the panes blended in one pass. */
function draftMaterials() {
  const solid = new THREE.MeshLambertMaterial({ vertexColors: true });
  const solidOn = glow(new THREE.MeshLambertMaterial({ vertexColors: true }));
  // Floors and ceilings win where they share a plane with something else (parts.ts, lookOf).
  const floor = new THREE.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
  const floorOn = glow(new THREE.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }));
  const ceiling = new THREE.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -6 });
  const ceilingOn = glow(new THREE.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -6 }));
  // Glass lets through what is behind it, about 90% and a little green, and reflects a sheen (FLR-T-13.17).
  const glass = paneMaterial(linear(DEFAULT_COLOURS.glass));
  // A model's glass (a window's, a shower's screen): its role's; a luminaire's lens unshaded, as if
  // lit, when the lights are on (FLR-T-12.22), and shaded like the rest when they are off.
  const modelGlass = paneMaterial(linear(ROLE_LOOKS.glass.color));
  const lensOff = new THREE.MeshLambertMaterial({ vertexColors: true });
  const lensOn = glow(new THREE.MeshLambertMaterial({ vertexColors: true }));
  const glassOn = new THREE.MeshLambertMaterial({ transparent: true, opacity: 0.6, depthWrite: false });
  return { solid, solidOn, floor, floorOn, ceiling, ceilingOn, glass, glassOn, modelGlass, lensOff, lensOn, ...overlayMaterials() };
}

/**
 * Presentation's (FLR-T-13.7): physically based — walls, floors and ceilings with a roughness each,
 * reflecting the sky's prefiltered light by Fresnel as the textured surfaces already do — and the
 * panes in two passes (presentationPane), drawn in Parts.
 */
function presentationMaterials() {
  const std = (roughness: number, offset?: [number, number]) =>
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness, metalness: 0, ...(offset === undefined ? {} : { polygonOffset: true, polygonOffsetFactor: offset[0], polygonOffsetUnits: offset[1] }) });
  const solid = std(0.85);
  const solidOn = glow(std(0.85));
  const floor = std(0.5, [-1, -2]);
  const floorOn = glow(std(0.5, [-1, -2]));
  const ceiling = std(0.95, [-2, -6]);
  const ceilingOn = glow(std(0.95, [-2, -6]));
  // Draft's single-pass panes stay for nothing here but the shape of the set; Parts draws presentationPane.
  const glass = paneMaterial(linear(DEFAULT_COLOURS.glass));
  const modelGlass = paneMaterial(linear(ROLE_LOOKS.glass.color));
  const lensOff = std(ROLE_LOOKS.lens.roughness);
  const lensOn = glow(std(ROLE_LOOKS.lens.roughness));
  const glassOn = new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.6, depthWrite: false, roughness: 0.2 });
  return { solid, solidOn, floor, floorOn, ceiling, ceilingOn, glass, glassOn, modelGlass, lensOff, lensOn, ...overlayMaterials() };
}

/** What is drawn the same in both: the lit lens, the pick targets and the selection's outline. */
function overlayMaterials() {
  // Not tone-mapped: a lit lens is as bright as the screen shows, whatever the view's exposure (FLR-T-13.1);
  // in Presentation, a light over the curve's white (`lens`).
  const lens = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
  lens.userData = { lens: true };
  // A door's or an empty opening's cut: nothing drawn, still a target for the pointer.
  const pick = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false });
  // Not tone-mapped: the selection's outline and an opening's highlight read the same under every sky.
  const pickOn = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.4, depthWrite: false, toneMapped: false });
  const edges = new THREE.LineBasicMaterial({ depthTest: false, transparent: true, opacity: 0.95, toneMapped: false });
  return { lens, pick, pickOn, edges };
}

/** Outlines are drawn over the house, not picked through it. */
const noRaycast = (): void => undefined;

/** The selection's label, kept over the top of its parts as the camera moves. */
function LabelTracker({ built, selection, el }: { built: Built[]; selection: string | null; el: { current: HTMLDivElement | null } }) {
  const box = useMemo(() => {
    const parts = built.filter((b) => partSelected(b.part, selection));
    if (parts.length === 0) return null;
    const b = new THREE.Box3();
    for (const p of parts) if (p.geometry.boundingBox !== null) b.union(p.geometry.boundingBox);
    return b;
  }, [built, selection]);
  const v = useMemo(() => new THREE.Vector3(), []);
  useFrame(({ camera, size }) => {
    const node = el.current;
    if (node === null) return;
    if (box === null) {
      node.style.visibility = 'hidden';
      return;
    }
    v.set((box.min.x + box.max.x) / 2, (box.min.y + box.max.y) / 2, box.max.z).project(camera);
    const inView = v.z < 1 && Math.abs(v.x) <= 1.05 && Math.abs(v.y) <= 1.05;
    node.style.visibility = inView ? 'visible' : 'hidden';
    node.style.transform = `translate(${((v.x + 1) / 2) * size.width}px, ${((1 - v.y) / 2) * size.height}px) translate(-50%, calc(-100% - 8px))`;
  });
  return null;
}

// ─── Overlays ────────────────────────────────────────────────────────────────────────────────

function Toolbar({ store, three, ctl, mesh, levels, roof, lights }: { store: EditorStore; three: ThreeStore; ctl: ThreeController; mesh: HouseMesh; levels: LevelsShown; roof: boolean; lights: boolean }) {
  const whole = levels === 'house';
  const selection = useEditor(store, (s) => s.selection);
  return (
    <div className="fs-three__tools" role="toolbar" aria-label="3D view">
      <Tooltip content="Orbit: drag to turn, right-drag or Shift-drag to pan, scroll to zoom">
        <IconButton label="Orbit" icon={<OrbitIcon />} pressed size="sm" onClick={() => { focusCanvas(ctl); }} />
      </Tooltip>
      <Tooltip content="Frame the house (Home)">
        <IconButton label="Frame the house" icon={<RotateCcw />} size="sm" onClick={() => { if (mesh.bbox !== null) ctl.fit(metresBox(mesh, mesh.bbox)); }} />
      </Tooltip>
      <Tooltip content={selection === null ? 'Walk through from the entry (4)' : 'Walk through (4) — or double-click a floor'}>
        <IconButton label="Walk through" icon={<Footprints />} size="sm" onClick={() => { three.walk(null); }} />
      </Tooltip>
      <SunButton store={store} />
      <Tooltip content={lights ? 'Turn the lights off' : 'Turn the lights on: each light fixture lights its room, at dusk'}>
        <IconButton label="Lights" icon={<Lightbulb />} size="sm" pressed={lights} onClick={() => { three.toggleLights(); }} />
      </Tooltip>
      <LightingButton store={store} />
      <CameraButton store={store} />
      <Tooltip content={!whole ? 'Cut away, this level’s roof is off — show the whole house to see it' : roof ? 'Hide the roofs' : 'Show the roofs'}>
        <IconButton label="Roof" icon={<House />} size="sm" pressed={roof && whole} disabled={!whole} onClick={() => { three.set({ roof: !roof }); }} />
      </Tooltip>
    </div>
  );
}

/**
 * Draft or Presentation (FLR-T-13.7), the board's "08 · Editor — 3D presentation quality" frame: a
 * radio group in the chips at the bottom left. Kept in this browser. Where WebGL is drawn in software
 * Presentation is offered but not the default, and says why it will be slow.
 */
function QualityControl({ three, quality }: { three: ThreeStore; quality: Quality }) {
  const software = softwareWebGL();
  const tip = software
    ? 'Presentation: ambient occlusion, soft shadows, bloom on lamps, reflections — slow here: this browser draws WebGL in software'
    : quality === 'presentation'
      ? 'Presentation: ambient occlusion, soft shadows, bloom on lamps, reflections. Draft is lighter on the battery.'
      : 'Draft: fast and light. Presentation adds ambient occlusion, soft shadows, bloom on lamps and reflections.';
  return (
    <Tooltip content={tip}>
      <div className="fs-three__quality">
        <SegmentedControl
          aria-label="Quality"
          size="sm"
          value={quality}
          onValueChange={(v) => { three.setQuality(v === 'presentation' ? 'presentation' : 'draft'); }}
          items={[
            { value: 'draft', label: 'Draft' },
            { value: 'presentation', label: 'Presentation' },
          ]}
        />
      </div>
    </Tooltip>
  );
}

/** The stats chip: the renderer, the quality, and in Presentation its state or frame rate. */
function StatsChip({ quality, stats, parts, triangles }: { quality: Quality; stats: StatsStore; parts: number; triangles: number }) {
  const s = useStats(stats);
  return (
    <div className="fs-three__chip fs-three__stats" role="note">
      <Box aria-hidden="true" />
      {statsLine(quality, quality === 'presentation' ? s : null, parts, triangles)}
    </div>
  );
}

function statsLine(quality: Quality, stats: PresentationStats | null, parts: number, triangles: number): string {
  const tris = triangles >= 1000 ? `${(triangles / 1000).toFixed(1)}k` : String(triangles);
  if (quality === 'draft') return `WebGL · Draft · ${String(parts)} parts · ${tris} triangles`;
  if (stats === null || !stats.ready) return 'WebGL · Preparing presentation…';
  const refining = stats.refined < ACCUMULATE ? ' · refining' : '';
  return `WebGL · Presentation${stats.fps === null ? '' : ` · ${String(stats.fps)} fps`}${refining} · ${tris} triangles`;
}

/**
 * Which levels the view shows (FLR-T-13.2), the board's "3D levels: whole house" frame: the whole
 * house, each level cut away ("Level 2 and below") or alone ("Only Level 2"). Picking a level makes
 * it the editor's current level, as the top bar's picker does, so the plan follows; Page Up and
 * Page Down step the level and the cutaway or isolate goes with it.
 */
function LevelsControl({ store, three, model, order, levels, level }: { store: EditorStore; three: ThreeStore; model: EditorModel; order: ReadonlyMap<string, number>; levels: LevelsShown; level: string | null }) {
  const choices = useMemo(() => levelChoices(model.levels, order), [model, order]);
  return (
    <div className="fs-three__levels">
      <Select
        aria-label="Levels in 3D"
        size="sm"
        options={choices}
        value={levelChoiceOf(levels, level, order)}
        onValueChange={(value) => {
          const next = parseLevelChoice(value);
          if (next.level !== null && next.level !== store.get().level) store.setLevel(next.level);
          three.setLevels(next.levels);
        }}
      />
    </div>
  );
}

/** Focus the canvas: the orbit button's action, since orbiting is what the canvas does by default. */
function focusCanvas(ctl: ThreeController): void {
  ctl.invalidate();
  document.querySelector<HTMLElement>('.fs-three__gl')?.focus();
}

function ViewCube({ ctl, preset }: { ctl: ThreeController; preset: PresetId | null }) {
  const next = PRESET_ORDER[(preset === null ? -1 : PRESET_ORDER.indexOf(preset)) + 1] ?? 'sw';
  return (
    <Tooltip content={`Next view: ${PRESETS[next].label}`}>
      <button type="button" className="fs-three__cube" aria-label={`View: ${preset === null ? 'free orbit' : PRESETS[preset].label}. Step to ${PRESETS[next].label}`} onClick={() => { ctl.toPreset(next); }}>
        <Box aria-hidden="true" />
        <span>{preset === null ? 'Free' : PRESETS[preset].label}</span>
      </button>
    </Tooltip>
  );
}

function WalkOverlay({ store, three, ctl, world, model, mesh }: { store: EditorStore; three: ThreeStore; ctl: ThreeController; world: World; model: EditorModel; mesh: HouseMesh }) {
  const eye = useThreeState(store, (s) => s.eyeHeight);
  const units = useEditor(store, () => store.units);
  // Re-rendered by `onWalk`; the walker itself is read from the controller.
  const [, setTick] = useState(0);
  // The location and the map, a few times a second rather than every frame.
  useEffect(() => {
    let last = 0;
    ctl.onWalk = () => {
      const now = performance.now();
      if (now - last > 120) {
        last = now;
        setTick((t) => t + 1);
      }
    };
    return () => { ctl.onWalk = null; };
  }, [ctl]);
  const w = ctl.walker;
  // What is underfoot: a room's floor, a stair's step or landing, a slab — or nothing, outside.
  const place = w === null ? null : placeAt(world, w.x, w.y, w.feet);
  const levelId = place?.level ?? (w === null ? null : [...world.levels].reverse().find((l) => l.elevation <= w.feet + WALK.stepUp)?.id ?? null);
  const level = model.levels.find((l) => l.id === levelId) ?? null;
  const where = place === null ? 'Outside' : labelOf(model, place.id);
  const eyeLabel = formatLen(Math.round(eye * UNITS), units);
  const coarse = useCoarse();
  return (
    <>
      {level !== null && w !== null ? <MiniMap level={level} mesh={mesh} x={w.x} y={w.y} yaw={w.yaw} where={where} /> : null}
      <div className="fs-three__chip fs-three__where" role="status">
        <Footprints aria-hidden="true" />
        {where}
        {level === null ? '' : ` · ${level.name}`} · eye height {eyeLabel}
      </div>
      <div className="fs-three__exit">
        <Button size="sm" variant="secondary" icon={<X />} onClick={() => { three.stopWalking(); }}>
          Exit walkthrough
        </Button>
      </div>
      <div className="fs-three__keys" role="note" aria-label="Walkthrough controls">
        {coarse ? (
          <>
            <span className="fs-three__key-label">Stick walks</span>
            <span className="fs-three__key-label">Drag to look</span>
          </>
        ) : (
          <>
            <kbd>W A S D</kbd> <span className="fs-three__key-label">move</span>
            <kbd>← →</kbd> <span className="fs-three__key-label">turn</span>
            <kbd>Drag</kbd> <span className="fs-three__key-label">look</span>
            <kbd>Shift</kbd> <span className="fs-three__key-label">faster</span>
            <kbd>Esc</kbd> <span className="fs-three__key-label">exit</span>
          </>
        )}
      </div>
      <Joystick ctl={ctl} />
    </>
  );
}

function useCoarse(): boolean {
  const [coarse, setCoarse] = useState(() => typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches);
  useEffect(() => {
    const query = window.matchMedia('(pointer: coarse)');
    const update = () => { setCoarse(query.matches); };
    query.addEventListener('change', update);
    return () => { query.removeEventListener('change', update); };
  }, []);
  return coarse;
}

/** A thumb stick for touch: drag from its centre to walk; the rest of the screen looks around. */
function Joystick({ ctl }: { ctl: ThreeController }) {
  const knob = useRef<HTMLDivElement>(null);
  const active = useRef<number | null>(null);
  const R = 48;
  const move = (e: React.PointerEvent<HTMLDivElement>) => {
    if (active.current !== e.pointerId) return;
    const r = e.currentTarget.getBoundingClientRect();
    let dx = e.clientX - (r.left + r.width / 2);
    let dy = e.clientY - (r.top + r.height / 2);
    const d = Math.hypot(dx, dy);
    if (d > R) {
      dx = (dx / d) * R;
      dy = (dy / d) * R;
    }
    ctl.joystick = [dx / R, -dy / R];
    if (knob.current !== null) knob.current.style.transform = `translate(${String(dx)}px, ${String(dy)}px)`;
    ctl.invalidate();
  };
  const end = (e: React.PointerEvent<HTMLDivElement>) => {
    if (active.current !== e.pointerId) return;
    active.current = null;
    ctl.joystick = [0, 0];
    if (knob.current !== null) knob.current.style.transform = '';
  };
  return (
    <div
      className="fs-three__stick"
      aria-hidden="true"
      onPointerDown={(e) => {
        e.stopPropagation();
        active.current = e.pointerId;
        e.currentTarget.setPointerCapture(e.pointerId);
        move(e);
      }}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
    >
      <div className="fs-three__knob" ref={knob} />
    </div>
  );
}

/** The level being walked, from above, with where you stand and which way you face. */
function MiniMap({ level, mesh, x, y, yaw, where }: { level: LevelView; mesh: HouseMesh; x: number; y: number; yaw: number; where: string }) {
  const k = mesh.unitsPerMetre;
  const [ox, oy] = mesh.origin;
  const b = level.bounds;
  const shapes = useMemo(() => {
    const pts = (ring: readonly (readonly [number, number])[]) => ring.map(([px, py]) => `${(((px - ox) / k)).toFixed(2)},${(-(py - oy) / k).toFixed(2)}`).join(' ');
    return {
      rooms: level.rooms.map((r) => ({ id: r.id, points: pts(r.outer) })),
      walls: level.walls.map((w) => ({ id: w.id, points: pts(w.ring) })),
      fills: level.fills.map((f) => ({ id: f.id, points: pts(f.ring) })),
    };
  }, [level, ox, oy, k]);
  if (b === null) return null;
  const pad = 0.6;
  const minX = (b.minX - ox) / k - pad;
  const maxX = (b.maxX - ox) / k + pad;
  const minY = -(b.maxY - oy) / k - pad;
  const maxY = -(b.minY - oy) / k + pad;
  const cone = 1.4;
  const a1 = yaw + 0.5;
  const a2 = yaw - 0.5;
  return (
    <svg className="fs-three__map" viewBox={`${minX.toFixed(2)} ${minY.toFixed(2)} ${(maxX - minX).toFixed(2)} ${(maxY - minY).toFixed(2)}`} role="img" aria-label={`Map of ${level.name}: you are in ${where}, facing ${compass(yaw)}`}>
      {shapes.rooms.map((r) => <polygon key={r.id} className="fs-three__map-room" points={r.points} />)}
      {shapes.walls.map((w) => <polygon key={w.id} className="fs-three__map-wall" points={w.points} />)}
      {shapes.fills.map((f) => <polygon key={f.id} className="fs-three__map-wall" points={f.points} />)}
      <polygon className="fs-three__map-cone" points={`${x},${-y} ${x + cone * Math.cos(a1)},${-(y + cone * Math.sin(a1))} ${x + cone * Math.cos(a2)},${-(y + cone * Math.sin(a2))}`} />
      <circle className="fs-three__map-you" cx={x} cy={-y} r={0.28} />
    </svg>
  );
}

// ─── The test hook ───────────────────────────────────────────────────────────────────────────

interface Hook {
  ready: boolean;
  /** FLR-T-13.10: the three.js camera's vertical field of view, degrees, its lens shift (half-heights) and the exposure it is drawn at. */
  camera: { fov: number; shift: number; toneExposure: number } | null;
  parts: number;
  /** The mesh's parts by kind (packages/mesh's PartKind): how many of each are drawn. */
  kinds: Record<string, number>;
  /** The parts showing now (FLR-T-13.2), counted by "level:kind": what the levels control leaves in. */
  shown: Record<string, number>;
  walking: boolean;
  /** The walker, in metres in the document's frame; null when not walking. */
  walker: { x: number; y: number; feet: number; eye: number; ground: number; yaw: number; room: string | null; blocked: string | null } | null;
  /** The mesh's origin, base units. */
  origin: Vec3 | null;
  /** A point on screen (client pixels) where the element's part is the first thing the pointer hits. */
  screenPoint(id: string): { x: number; y: number } | null;
  walk(from: WalkStart | null): void;
  face(yawDegrees: number): void;
  /**
   * The textured surfaces drawn (FLR-T-8.2): each part with a map, the material and the image's
   * digest, whether the image has arrived, and the texture coordinates' range — in tiles.
   */
  textured: { part: string; material: string; sha256: string; loaded: boolean; u: [number, number]; v: [number, number] }[];
  /** FLR-T-12.22: whether the light fixtures are on, and the lamps drawn — each fixture's ID, kind and whether it casts shadows. */
  lights: { on: boolean; lamps: { id: string; kind: 'point' | 'spot'; shadow: boolean; intensity: number }[] };
  /**
   * FLR-T-13.17: every shader program the view has compiled — whether it linked, and how many
   * texture units its fragment shader samples — against the GPU's limit. A program over the limit
   * fails to link and three.js draws nothing with it.
   */
  programs: { units: number; list: { name: string; linked: boolean; samplers: number }[] };
}

declare global {
  interface Window {
    __floorspec3d?: Hook;
  }
}

/**
 * Under automation only (navigator.webdriver), the e2e suite reads the walker and asks where on
 * screen an element can be clicked. Nothing is exposed to a person's browser.
 */
function useTestHook(store: EditorStore, three: ThreeStore, ctl: ThreeController, ready: { mesh: HouseMesh; world: World } | null, el: { current: HTMLDivElement | null }, built: readonly Built[], visible: readonly Built[], textures: TextureLibrary) {
  useEffect(() => {
    if (!navigator.webdriver) return;
    const hook: Hook = {
      get ready() {
        return ready !== null && ctl.orbit !== null && el.current?.querySelector('canvas') !== null;
      },
      get parts() {
        return ready?.mesh.parts.length ?? 0;
      },
      get camera() {
        const canvas = el.current?.querySelector('canvas');
        const at = canvas === null || canvas === undefined ? undefined : sceneOf.get(canvas);
        const cam = at?.camera;
        if (at === undefined || !(cam instanceof THREE.PerspectiveCamera)) return null;
        const v = cam.view;
        return { fov: cam.fov, shift: v === null || !v.enabled ? 0 : (-2 * v.offsetY) / v.fullHeight, toneExposure: at.gl.toneMappingExposure };
      },
      get kinds() {
        const k: Record<string, number> = {};
        for (const p of ready?.mesh.parts ?? []) k[p.kind] = (k[p.kind] ?? 0) + 1;
        return k;
      },
      get shown() {
        const k: Record<string, number> = {};
        for (const { part } of visible) k[`${part.level}:${part.kind}`] = (k[`${part.level}:${part.kind}`] ?? 0) + 1;
        return k;
      },
      get walking() {
        return three.get().walking && ctl.walker !== null;
      },
      get walker() {
        const w = ctl.walker;
        if (w === null || ready === null || !three.get().walking) return null;
        const eye = three.get().eyeHeight;
        const ground = groundAt(ready.world, w.x, w.y, w.feet + 1e-6).z;
        // In the document's own frame, in metres: the origin added back.
        const [ox, oy, oz] = ready.mesh.origin.map((v) => v / ready.mesh.unitsPerMetre) as [number, number, number];
        return {
          x: w.x + ox,
          y: w.y + oy,
          feet: w.feet + oz,
          eye: w.feet + eye + oz,
          ground: ground + oz,
          yaw: (w.yaw * 180) / Math.PI,
          room: roomAt(ready.world, w.x, w.y, w.feet)?.id ?? null,
          blocked: blocked(ready.world, w.x, w.y, w.feet),
        };
      },
      get origin() {
        return ready?.mesh.origin ?? null;
      },
      screenPoint: (id) => screenPoint(el.current, id),
      get lights() {
        const lamps: Hook['lights']['lamps'] = [];
        const canvas = el.current?.querySelector('canvas');
        const at = canvas === null || canvas === undefined ? undefined : sceneOf.get(canvas);
        at?.scene.traverse((o) => {
          const id = (o.userData as { fixture?: string }).fixture;
          if (id !== undefined && o instanceof THREE.Light) lamps.push({ id, kind: o instanceof THREE.SpotLight ? 'spot' : 'point', shadow: o.castShadow, intensity: o.intensity });
        });
        return { on: three.get().lights, lamps: lamps.sort((a, b) => (a.id < b.id ? -1 : 1)) };
      },
      get programs() {
        const canvas = el.current?.querySelector('canvas');
        const at = canvas === null || canvas === undefined ? undefined : sceneOf.get(canvas);
        if (at === undefined) return { units: 0, list: [] };
        const g = at.gl.getContext();
        const SAMPLERS = new Set<number>([g.SAMPLER_2D, g.SAMPLER_CUBE, (g as WebGL2RenderingContext).SAMPLER_2D_SHADOW, (g as WebGL2RenderingContext).SAMPLER_CUBE_SHADOW, (g as WebGL2RenderingContext).SAMPLER_3D, (g as WebGL2RenderingContext).SAMPLER_2D_ARRAY]);
        const list = (at.gl.info.programs ?? []).map((p) => {
          const program = p.program as WebGLProgram;
          const linked = g.getProgramParameter(program, g.LINK_STATUS) === true;
          let samplers = 0;
          const n = linked ? (g.getProgramParameter(program, g.ACTIVE_UNIFORMS) as number) : 0;
          for (let i = 0; i < n; i++) {
            const u = g.getActiveUniform(program, i);
            if (u !== null && SAMPLERS.has(u.type)) samplers += u.size;
          }
          return { name: p.name, linked, samplers };
        });
        return { units: at.gl.capabilities.maxTextures, list };
      },
      walk: (from) => { three.walk(from); },
      face: (deg) => {
        if (ctl.walker !== null) ctl.walker = { ...ctl.walker, yaw: (deg * Math.PI) / 180 };
      },
      get textured() {
        return built.flatMap((b) =>
          (b.slots ?? []).flatMap((m, i) => {
            // A document material's maps (a model's piece in its role's library material is the view's own).
            if (m === null || m.material.startsWith('role:')) return [];
            const g = b.geometry.groups[i];
            const uv = b.geometry.getAttribute('uv');
            let [u0, u1, v0, v1] = [Infinity, -Infinity, Infinity, -Infinity];
            for (let k = g?.start ?? 0; k < (g?.start ?? 0) + (g?.count ?? 0); k++) {
              u0 = Math.min(u0, uv.getX(k));
              u1 = Math.max(u1, uv.getX(k));
              v0 = Math.min(v0, uv.getY(k));
              v1 = Math.max(v1, uv.getY(k));
            }
            return [{ part: b.part.key, material: m.material, sha256: m.sha256, loaded: textures.loaded.has(m.sha256), u: [u0, u1] as [number, number], v: [v0, v1] as [number, number] }];
          }),
        );
      },
    };
    window.__floorspec3d = hook;
    return () => {
      if (window.__floorspec3d === hook) delete window.__floorspec3d;
    };
  }, [store, three, ctl, ready, el, built, visible, textures]);
}

/** Registered by the scene: what screenPoint needs from inside the canvas. */
const sceneOf = new WeakMap<HTMLCanvasElement, { scene: THREE.Scene; camera: THREE.Camera; gl: THREE.WebGLRenderer }>();

export function SceneBridge() {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  useEffect(() => {
    sceneOf.set(gl.domElement, { scene, camera, gl });
  }, [gl, scene, camera]);
  return null;
}

function screenPoint(root: HTMLElement | null, id: string): { x: number; y: number } | null {
  const canvas = root?.querySelector('canvas');
  if (canvas === null || canvas === undefined) return null;
  const at = sceneOf.get(canvas);
  if (at === undefined) return null;
  const rect = canvas.getBoundingClientRect();
  const ray = new THREE.Raycaster();
  const targets: THREE.Mesh[] = [];
  at.scene.traverse((o) => {
    if (o instanceof THREE.Mesh) targets.push(o as THREE.Mesh);
  });
  const ndc = new THREE.Vector2();
  const v = new THREE.Vector3();
  for (const mesh of targets) {
    if ((mesh.userData as { id?: string }).id !== id) continue;
    const pos = (mesh.geometry).getAttribute('position');
    const tris = pos.count / 3;
    const stride = Math.max(1, Math.floor(tris / 300));
    for (let t = 0; t < tris; t += stride) {
      v.set(0, 0, 0);
      for (let k = 0; k < 3; k++) v.add(new THREE.Vector3(pos.getX(3 * t + k), pos.getY(3 * t + k), pos.getZ(3 * t + k)));
      v.divideScalar(3).project(at.camera);
      if (v.z >= 1 || Math.abs(v.x) > 0.9 || Math.abs(v.y) > 0.9) continue;
      ndc.set(v.x, v.y);
      ray.setFromCamera(ndc, at.camera);
      const hit = ray.intersectObjects(targets, false)[0];
      if (hit !== undefined && (hit.object.userData as { id?: string }).id === id) {
        return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height };
      }
    }
  }
  return null;
}
