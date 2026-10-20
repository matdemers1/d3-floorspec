import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { MeshPart } from '@floorspec/mesh';
import type { Look } from '../parts';
import type { ThreeStore } from '../mode';
import type { SectionRig } from './rig';
import { SECTION_ROOT } from '../compare/compare';
import {
  EXPLODE_MS,
  FACE_AXIS,
  faceRect,
  flipped,
  GHOST_OPACITY,
  layerLifts,
  planeRect,
  progressAt,
  sectionPlanes,
  uprightPlanes,
  type Box,
  type ClipPlane,
  type ExplodeState,
  type Layer,
  type SectionState,
  type Vec3,
} from './section';

/**
 * The section box and the exploded view inside the canvas (FLR-T-14.6):
 *
 * - **The cut.** Every material of the house (the parts and the furniture under `house`) is given the
 *   section's planes as three.js clipping planes — shadows clipped too, so what is cut away casts
 *   none — and keeps only what is inside the box or behind the plane.
 * - **The caps.** A cut face is closed where it passes through something solid, by the stencil
 *   technique: for each cutting plane the house's solids (watertight, @floorspec/mesh `closed`) are
 *   drawn into the stencil buffer only, clipped by that plane, their back faces counting up and their
 *   front faces down; where the count is not zero the plane is inside a solid, and the cap — the face's
 *   rectangle — is drawn there, in fill-quiet with a 45° hatch in fg-muted every 8 px (the board's
 *   P14/Cut cap), clearing the stencil as it goes. No texture: the hatch is computed, so the caps take no
 *   texture unit (the 16-unit budget, lights.ts).
 * - **The ghost.** What the cut takes away is drawn again at 15 %, clipped to keep exactly what the
 *   section cuts away (each plane turned round, any of them keeping it) — the frame's "Ghosted".
 * - **The lift.** The exploded view's layers rise by the rig's lift (rig.ts), eased in and out.
 *
 * Everything here is made per layer, so a lifted layer's stencil and ghost rise with it; the upright
 * planes still cut a lifted layer where they cut it below, since it only moves up.
 */

/** A part as the view drew it: its mesh part, the geometry drawn and how it is drawn. */
export interface SectionPart {
  part: MeshPart;
  geometry: THREE.BufferGeometry;
  look: Look;
}

export interface SectionColours {
  /** The cap's fill and hatch: fill-quiet and fg-muted. */
  fill: string;
  hatch: string;
  /** A ghosted part without colours of its own. */
  ghost: string;
}

const noRaycast = (): void => undefined;

/** Where each cutting plane's stencil and cap are drawn: after the house (0) and its glass (1). */
const ORDER = 10;

const solidLook = (look: Look): boolean => look === 'solid' || look === 'floor' || look === 'ceiling';

/** The watertight solids of a layer, merged into one indexed geometry: positions only, for the stencil. */
function solidsOf(parts: readonly SectionPart[]): THREE.BufferGeometry | null {
  const solids = parts.filter((p) => p.part.closed && solidLook(p.look));
  if (solids.length === 0) return null;
  let vertices = 0;
  let indices = 0;
  for (const s of solids) {
    vertices += s.part.mesh.positions.length / 3;
    indices += s.part.mesh.indices.length;
  }
  const position = new Float32Array(vertices * 3);
  const index = new Uint32Array(indices);
  let v = 0;
  let i = 0;
  for (const s of solids) {
    const m = s.part.mesh;
    position.set(m.positions, v * 3);
    for (let k = 0; k < m.indices.length; k++) index[i + k] = (m.indices[k] ?? 0) + v;
    v += m.positions.length / 3;
    i += m.indices.length;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(position, 3));
  g.setIndex(new THREE.BufferAttribute(index, 1));
  g.computeBoundingSphere();
  return g;
}

/** A layer's opaque parts as drawn, merged: positions, normals and colours, for the ghost. */
function ghostOf(parts: readonly SectionPart[], fallback: THREE.Color): THREE.BufferGeometry | null {
  const shown = parts.filter((p) => solidLook(p.look));
  if (shown.length === 0) return null;
  const flat = shown.map((p) => (p.geometry.index === null ? p.geometry : p.geometry.toNonIndexed()));
  const count = flat.reduce((n, g) => n + g.getAttribute('position').count, 0);
  const position = new Float32Array(count * 3);
  const normal = new Float32Array(count * 3);
  const color = new Float32Array(count * 3);
  let at = 0;
  for (const g of flat) {
    const p = g.getAttribute('position');
    const n = g.getAttribute('normal') as THREE.BufferAttribute | undefined;
    const c = g.getAttribute('color') as THREE.BufferAttribute | undefined;
    for (let k = 0; k < p.count; k++) {
      const o = (at + k) * 3;
      position[o] = p.getX(k);
      position[o + 1] = p.getY(k);
      position[o + 2] = p.getZ(k);
      normal[o] = n?.getX(k) ?? 0;
      normal[o + 1] = n?.getY(k) ?? 0;
      normal[o + 2] = n?.getZ(k) ?? 1;
      color[o] = c?.getX(k) ?? fallback.r;
      color[o + 1] = c?.getY(k) ?? fallback.g;
      color[o + 2] = c?.getZ(k) ?? fallback.b;
    }
    at += p.count;
  }
  for (const [i, g] of flat.entries()) if (g !== shown[i]?.geometry) g.dispose();
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(position, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  g.setAttribute('color', new THREE.BufferAttribute(color, 3));
  g.computeBoundingSphere();
  return g;
}

const CAP_VERTEX = /* glsl */ `
void main() {
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

/** The cap: fill-quiet, hatched at 45° every `spacing` device pixels in fg-muted; magenta for the probe. */
const CAP_FRAGMENT = /* glsl */ `
uniform vec3 fill;
uniform vec3 line;
uniform float spacing;
uniform float width;
uniform float hatch;
uniform float probe;
void main() {
  // Lines rising at 45 degrees, spacing apart along a row (8 px, as the board's P14/Cut cap), width across.
  float d = mod( gl_FragCoord.x - gl_FragCoord.y, spacing );
  float e = min( d, spacing - d ) * 0.70710678;
  float a = hatch * ( 1.0 - smoothstep( width * 0.5 - 0.5, width * 0.5 + 0.5, e ) );
  vec3 c = mix( fill, line, a );
  if ( probe > 0.5 ) c = vec3( 1.0, 0.0, 1.0 );
  gl_FragColor = vec4( c, 1.0 );
  #include <colorspace_fragment>
}
`;

function capMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      fill: { value: new THREE.Color() },
      line: { value: new THREE.Color() },
      spacing: { value: 8 },
      width: { value: 1 },
      hatch: { value: 1 },
      probe: { value: 0 },
    },
    vertexShader: CAP_VERTEX,
    fragmentShader: CAP_FRAGMENT,
    side: THREE.DoubleSide,
    stencilWrite: true,
    stencilRef: 0,
    stencilFunc: THREE.NotEqualStencilFunc,
    stencilFail: THREE.ReplaceStencilOp,
    stencilZFail: THREE.ReplaceStencilOp,
    stencilZPass: THREE.ReplaceStencilOp,
  });
}

function stencilMaterial(side: THREE.Side, op: THREE.StencilOp): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    side,
    colorWrite: false,
    depthWrite: false,
    depthTest: false,
    stencilWrite: true,
    stencilFunc: THREE.AlwaysStencilFunc,
    stencilFail: op,
    stencilZFail: op,
    stencilZPass: op,
  });
}

const setPlane = (to: THREE.Plane, c: ClipPlane) => {
  to.normal.set(c.normal[0], c.normal[1], c.normal[2]);
  to.constant = c.constant;
};

export interface SectionSceneProps {
  rig: SectionRig;
  three: ThreeStore;
  /** The parts shown, each with its layer. */
  parts: readonly SectionPart[];
  /** The exploded view's layers, bottom up, and a part's. */
  layers: readonly Layer[];
  layerOfPart: (part: MeshPart) => string;
  /** What carries the house's own materials: the parts and the furniture. */
  house: { current: THREE.Group | null };
  section: SectionState;
  explode: ExplodeState;
  walking: boolean;
  /** The house's bounds, metres. */
  bounds: Box | null;
  colours: SectionColours;
  reduced: boolean;
}

/** The planes cutting now: the section's, none while walking, the upright ones (or none) in the exploded view. */
export function cuttingPlanes(section: SectionState, explode: ExplodeState, walking: boolean): ClipPlane[] {
  if (walking) return [];
  const planes = sectionPlanes(section);
  if (!explode.active) return planes;
  return explode.keep ? uprightPlanes(planes) : [];
}

export function SectionScene({ rig, three, parts, layers, layerOfPart, house, section, explode, walking, bounds, colours, reduced }: SectionSceneProps) {
  const invalidate = useThree((s) => s.invalidate);
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const sectionRoot = useRef<THREE.Group>(null);
  const planes = useMemo(() => cuttingPlanes(section, explode, walking), [section, explode, walking]);
  const count = planes.length;

  // The planes as three.js's, made again only when their number changes (a new program); moved in place.
  const housePlanes = useMemo(() => Array.from({ length: count }, () => new THREE.Plane()), [count]);
  const ghostPlanes = useMemo(() => Array.from({ length: count }, () => new THREE.Plane()), [count]);
  const stencilPlanes = useMemo(() => Array.from({ length: count }, () => new THREE.Plane()), [count]);
  useEffect(() => {
    planes.forEach((p, i) => {
      const h = housePlanes[i];
      const g = ghostPlanes[i];
      const s = stencilPlanes[i];
      if (h !== undefined) setPlane(h, p);
      if (g !== undefined) setPlane(g, flipped(p));
      if (s !== undefined) setPlane(s, p);
    });
    invalidate();
  }, [planes, housePlanes, ghostPlanes, stencilPlanes, invalidate]);

  // Per layer: its solids for the stencil and its parts for the ghost.
  const ghostColour = useMemo(() => new THREE.Color(colours.ghost), [colours.ghost]);
  const byLayer = useMemo(() => {
    const m = new Map<string, SectionPart[]>();
    for (const p of parts) {
      const k = layerOfPart(p.part);
      m.set(k, [...(m.get(k) ?? []), p]);
    }
    return m;
  }, [parts, layerOfPart]);
  const capping = count > 0 && section.caps;
  const ghosting = count > 0 && section.outside === 'ghost';
  const solids = useMemo(() => (capping ? [...byLayer].map(([k, ps]) => ({ key: k, geometry: solidsOf(ps) })) : []), [capping, byLayer]);
  const ghosts = useMemo(() => (ghosting ? [...byLayer].map(([k, ps]) => ({ key: k, geometry: ghostOf(ps, ghostColour) })) : []), [ghosting, byLayer, ghostColour]);
  useEffect(() => () => { for (const s of solids) s.geometry?.dispose(); }, [solids]);
  useEffect(() => () => { for (const g of ghosts) g.geometry?.dispose(); }, [ghosts]);

  // The materials: a cap, and a stencil pair, for each plane; one ghost.
  const caps = useMemo(() => Array.from({ length: count }, () => capMaterial()), [count]);
  const stencils = useMemo(
    () =>
      stencilPlanes.map((plane) => {
        const back = stencilMaterial(THREE.BackSide, THREE.IncrementWrapStencilOp);
        const front = stencilMaterial(THREE.FrontSide, THREE.DecrementWrapStencilOp);
        back.clippingPlanes = [plane];
        front.clippingPlanes = [plane];
        return { back, front };
      }),
    [stencilPlanes],
  );
  const ghost = useMemo(() => {
    const m = new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, opacity: GHOST_OPACITY, depthWrite: false });
    m.clippingPlanes = ghostPlanes;
    // A box keeps what all its planes keep: its outside is what any one of them, turned round, keeps.
    m.clipIntersection = ghostPlanes.length > 1;
    return m;
  }, [ghostPlanes]);
  useEffect(() => () => {
    for (const c of caps) c.dispose();
    for (const s of stencils) {
      s.back.dispose();
      s.front.dispose();
    }
    ghost.dispose();
  }, [caps, stencils, ghost]);
  useEffect(() => {
    const ratio = gl.getPixelRatio();
    for (const c of caps) {
      (c.uniforms['fill']?.value as THREE.Color).set(colours.fill);
      (c.uniforms['line']?.value as THREE.Color).set(colours.hatch);
      const u = c.uniforms;
      if (u['hatch'] !== undefined) u['hatch'].value = section.hatch ? 1 : 0;
      if (u['spacing'] !== undefined) u['spacing'].value = 8 * ratio;
      if (u['width'] !== undefined) u['width'].value = ratio;
    }
    invalidate();
  }, [caps, colours, section.hatch, gl, invalidate]);

  // The cap rectangles: one quad each, moved in place as the box moves or the layers lift.
  const quads = useMemo(
    () =>
      Array.from({ length: count }, () => {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3));
        g.setIndex([0, 1, 2, 0, 2, 3]);
        return g;
      }),
    [count],
  );
  useEffect(() => () => { for (const q of quads) q.dispose(); }, [quads]);

  // The exploded view's layers: their lifts when fully apart.
  useEffect(() => {
    rig.lifts = layerLifts(layers, explode.spread);
    rig.apply();
    invalidate();
  }, [rig, layers, explode.spread, invalidate]);

  // Materials' own clipping planes (three.js's local clipping): off by default.
  useEffect(() => {
    gl.localClippingEnabled = true;
  }, [gl]);

  // Apart or together, open or closed: draw, so the lift moves.
  useEffect(() => { invalidate(); }, [explode.active, explode.apart, explode.open, invalidate]);

  const closing = useRef(false);
  useFrame((state) => {
    // The lift: towards apart while the exploded view is open and apart, else down.
    const to = explode.active && explode.apart ? 1 : 0;
    const now = performance.now();
    if (rig.to !== to) {
      rig.from = rig.progress;
      rig.to = to;
      rig.start = now;
    }
    rig.progress = progressAt(rig.from, rig.to, rig.start, now, EXPLODE_MS, reduced);
    rig.apply();
    if (rig.progress !== rig.to) invalidate();
    else if (explode.active && !explode.open && rig.progress === 0 && !closing.current) {
      // Down: out of the exploded view, back to the view's own camera.
      closing.current = true;
      three.setExplode({ active: false });
    }
    if (explode.open) closing.current = false;

    // The cut, on every material of the house.
    const root = house.current;
    const list = count === 0 ? null : housePlanes;
    root?.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      if (m === undefined) return;
      for (const x of Array.isArray(m) ? m : [m]) {
        if (x.clippingPlanes !== list) {
          x.clippingPlanes = list;
          x.clipShadows = true;
        }
      }
    });

    // The caps' rectangles: each face's, an upright one reaching up past every lifted layer.
    const top = Math.max(0, ...[...rig.lifts.values()]) * rig.progress;
    planes.forEach((p, i) => {
      const q = quads[i];
      if (q === undefined) return;
      let rect: Vec3[] | null = null;
      if (section.mode === 'box' && section.box !== null) {
        const box = top > 0 && FACE_AXIS[p.face].axis !== 2 ? { min: section.box.min, max: [section.box.max[0], section.box.max[1], section.box.max[2] + top] as Vec3 } : section.box;
        rect = faceRect(box, p.face);
      } else if (section.mode === 'plane' && section.plane !== null && bounds !== null) {
        rect = planeRect(top > 0 ? { min: bounds.min, max: [bounds.max[0], bounds.max[1], bounds.max[2] + top] } : bounds, section.plane);
      }
      if (rect === null) return;
      const a = q.getAttribute('position') as THREE.BufferAttribute;
      rect.forEach((v, k) => { a.setXYZ(k, v[0], v[1], v[2]); });
      a.needsUpdate = true;
      q.computeBoundingSphere();
    });

    rig.camera = state.camera;
    rig.size = { width: state.size.width, height: state.size.height };
    for (const f of rig.overlays) f();
  });

  // The still and the probe: the scene drawn now, to the screen, and read back at once.
  useEffect(() => {
    const draw = (transparent: boolean) => {
      const camera = rig.camera;
      if (camera === null) return false;
      const hidden: THREE.Object3D[] = [];
      const background = scene.background;
      const clear = gl.getClearColor(new THREE.Color());
      const alpha = gl.getClearAlpha();
      if (transparent) {
        // Only the house: the sky's dome and the lawn are left out, and the backdrop is clear.
        const keep = new Set<THREE.Object3D>();
        house.current?.traverse((o) => keep.add(o));
        sectionRoot.current?.traverse((o) => keep.add(o));
        scene.traverse((o) => {
          if ((o instanceof THREE.Mesh || o instanceof THREE.Line || o instanceof THREE.Points || o instanceof THREE.Sprite) && o.visible && !keep.has(o)) {
            o.visible = false;
            hidden.push(o);
          }
        });
        scene.background = null;
        gl.setClearColor(new THREE.Color(0, 0, 0), 0);
      }
      gl.setRenderTarget(null);
      gl.render(scene, camera);
      for (const o of hidden) o.visible = true;
      scene.background = background;
      gl.setClearColor(clear, alpha);
      return true;
    };
    rig.capture = ({ transparent }) => {
      if (!draw(transparent)) return null;
      const out = document.createElement('canvas');
      out.width = gl.domElement.width;
      out.height = gl.domElement.height;
      out.getContext('2d')?.drawImage(gl.domElement, 0, 0);
      invalidate();
      return out;
    };
    rig.probe = () => {
      for (const c of caps) if (c.uniforms['probe'] !== undefined) c.uniforms['probe'].value = 1;
      let share = 0;
      if (draw(false)) {
        const g = gl.getContext();
        const w = g.drawingBufferWidth;
        const h = g.drawingBufferHeight;
        const px = new Uint8Array(w * h * 4);
        g.readPixels(0, 0, w, h, g.RGBA, g.UNSIGNED_BYTE, px);
        let n = 0;
        for (let i = 0; i < px.length; i += 4) if ((px[i] ?? 0) > 200 && (px[i + 1] ?? 255) < 60 && (px[i + 2] ?? 0) > 200) n++;
        share = n / (w * h);
      }
      for (const c of caps) if (c.uniforms['probe'] !== undefined) c.uniforms['probe'].value = 0;
      invalidate();
      return share;
    };
    rig.invalidate = invalidate;
    return () => {
      rig.capture = null;
      rig.probe = null;
    };
  }, [rig, gl, scene, house, caps, invalidate]);

  const capped = planes.map((p, i) => ({ p, i })).filter(({ p }) => capping && bounds !== null && cuts(bounds, p));

  return (
    <group ref={sectionRoot} name={SECTION_ROOT}>
      {[...new Set([...solids.map((s) => s.key), ...ghosts.map((g) => g.key)])].map((key) => {
        const solid = solids.find((s) => s.key === key)?.geometry ?? null;
        const shade = ghosts.find((g) => g.key === key)?.geometry ?? null;
        return (
          <group
            key={key}
            ref={(g) => {
              if (g === null) return;
              rig.attach(g, key);
              return () => { rig.detach(g); };
            }}
          >
            {shade !== null ? <mesh geometry={shade} material={ghost} renderOrder={3} raycast={noRaycast} userData={{ ghost: key }} /> : null}
            {solid !== null
              ? capped.map(({ i }) => {
                  const s = stencils[i];
                  if (s === undefined) return null;
                  return (
                    <group key={i}>
                      <mesh geometry={solid} material={s.back} renderOrder={ORDER + 3 * i} raycast={noRaycast} />
                      <mesh geometry={solid} material={s.front} renderOrder={ORDER + 3 * i} raycast={noRaycast} />
                    </group>
                  );
                })
              : null}
          </group>
        );
      })}
      {capped.map(({ i, p }) => {
        const q = quads[i];
        const m = caps[i];
        return q === undefined || m === undefined ? null : <mesh key={`cap:${String(i)}`} geometry={q} material={m} renderOrder={ORDER + 3 * i + 1} raycast={noRaycast} frustumCulled={false} userData={{ cap: p.face }} />;
      })}
    </group>
  );
}

/** Whether a plane passes through the house at all: a face outside it caps nothing. */
export function cuts(bounds: Box, p: ClipPlane): boolean {
  const { axis, sign } = FACE_AXIS[p.face];
  const at = sign * p.constant;
  return at > bounds.min[axis] && at < bounds.max[axis];
}
