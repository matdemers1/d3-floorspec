import { useEffect, useLayoutEffect, useMemo } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { GRASS_TILE, grassTexture, HORIZON_BAND, lawnMacro, type SkyField, type SkyMap, type SkyMapId } from '@floorspec/mesh/sky';

/**
 * The sky and the ground in the editor's 3D view (FLR-T-13.4): @floorspec/mesh's sky drawn as the
 * renderers draw it — the HDRI dome, turned to the sun and scaled to cd/m², over a lawn at true
 * scale that runs out to the horizon and fades into the haze — and its image-based light, the sky's
 * nine spherical harmonics, as a three.js light probe (which lights the Lambert materials the house
 * is drawn with). The view's exposure (the renderer's `toneMappingExposure`) is the sky's.
 *
 * Everything is in the 3D view's frame: x east, y project north, z up, metres from the mesh's origin.
 */

// ─── The dome ────────────────────────────────────────────────────────────────────────────────

const domeTextures = new Map<SkyMapId, THREE.DataTexture>();

/** A map as a texture: half floats, rows from the zenith, wrapping round the horizon. */
function domeTexture(map: SkyMap): THREE.DataTexture {
  const hit = domeTextures.get(map.id);
  if (hit !== undefined) return hit;
  const n = map.width * map.height;
  const data = new Uint16Array(4 * n);
  for (let i = 0; i < n; i++) {
    data[4 * i] = THREE.DataUtils.toHalfFloat((map.data[3 * i] ?? 0));
    data[4 * i + 1] = THREE.DataUtils.toHalfFloat((map.data[3 * i + 1] ?? 0));
    data[4 * i + 2] = THREE.DataUtils.toHalfFloat((map.data[3 * i + 2] ?? 0));
    data[4 * i + 3] = 0x3c00; // 1.0
  }
  const t = new THREE.DataTexture(data, map.width, map.height, THREE.RGBAFormat, THREE.HalfFloatType);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  t.colorSpace = THREE.LinearSRGBColorSpace;
  t.needsUpdate = true;
  domeTextures.set(map.id, t);
  return t;
}

const VERTEX = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

// The dome as @floorspec/mesh's sky.ts \`dome\` and \`skyRadiance\` compute it, in cd/m².
const FRAGMENT = /* glsl */ `
uniform sampler2D mapA;
uniform sampler2D mapB;
uniform vec3 kA;
uniform vec3 kB;
uniform vec3 tintA;
uniform vec3 tintB;
uniform float vScale;
uniform float trueNorth;
uniform vec3 ground;
uniform vec3 horizon;
uniform float band;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  vec3 L;
  if (d.z >= 0.0) {
    float az = degrees(atan(d.x, d.y)) + trueNorth;
    float el = degrees(asin(clamp(d.z, 0.0, 1.0)));
    float v = (90.0 - el) * vScale;
    L = kA.x * tintA * texture2D(mapA, vec2(kA.y + az / 360.0, v)).rgb + kB.x * tintB * texture2D(mapB, vec2(kB.y + az / 360.0, v)).rgb;
    L = mix(horizon, L, smoothstep(0.0, band, el));
  } else {
    L = mix(ground, horizon, 1.0 - smoothstep(0.5, 8.0, -degrees(asin(clamp(d.z, -1.0, 0.0)))));
  }
  gl_FragColor = vec4(L, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const blank = new THREE.DataTexture(new Uint16Array([0, 0, 0, 0x3c00]), 1, 1, THREE.RGBAFormat, THREE.HalfFloatType);
blank.needsUpdate = true;

export function SkyDome({ field }: { field: SkyField }) {
  const invalidate = useThree((s) => s.invalidate);
  const mesh = useMemo(() => {
    const material = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: {
        mapA: { value: blank },
        mapB: { value: blank },
        kA: { value: new THREE.Vector3() },
        kB: { value: new THREE.Vector3() },
        tintA: { value: new THREE.Vector3(1, 1, 1) },
        tintB: { value: new THREE.Vector3(1, 1, 1) },
        vScale: { value: 0 },
        trueNorth: { value: 0 },
        ground: { value: new THREE.Vector3() },
        horizon: { value: new THREE.Vector3() },
        band: { value: HORIZON_BAND },
      },
      side: THREE.BackSide,
      depthTest: false,
      depthWrite: false,
      fog: false,
    });
    const m = new THREE.Mesh(new THREE.SphereGeometry(3000, 64, 32), material);
    m.frustumCulled = false;
    m.renderOrder = -10;
    m.raycast = () => undefined;
    m.userData = { sky: true };
    // Always round the camera: the sky is at infinity.
    m.onBeforeRender = (_r, _s, camera) => { m.position.copy(camera.position); m.updateMatrixWorld(); };
    return m;
  }, []);
  useEffect(() => () => { mesh.geometry.dispose(); mesh.material.dispose(); }, [mesh]);
  useLayoutEffect(() => {
    const all = mesh.material.uniforms;
    const u = (name: string): THREE.IUniform => all[name] ?? { value: null };
    const vec = (name: string): THREE.Vector3 => u(name).value as THREE.Vector3;
    const layers = field.light.layers.filter((l) => l.weight > 0 && field.maps[l.map] !== undefined).slice(0, 2);
    const set = (i: 0 | 1) => {
      const l = layers[i];
      const map = l === undefined ? undefined : field.maps[l.map];
      const tex = u(i === 0 ? 'mapA' : 'mapB');
      const k = vec(i === 0 ? 'kA' : 'kB');
      if (l === undefined || map === undefined) {
        tex.value = blank;
        k.set(0, 0, 0);
        return;
      }
      tex.value = domeTexture(map);
      k.set((l.lux / map.illuminance) * l.weight, l.u0, 0);
      vec(i === 0 ? 'tintA' : 'tintB').set(...l.tint);
      u('vScale').value = map.width / 2 / 180 / map.height;
    };
    set(0);
    set(1);
    u('trueNorth').value = field.light.trueNorth;
    vec('ground').set(...field.ground);
    vec('horizon').set(...field.horizon);
    invalidate();
  }, [field, mesh, invalidate]);
  return <primitive object={mesh} />;
}

// ─── The image-based light ───────────────────────────────────────────────────────────────────

export function SkyProbe({ sh }: { sh: Float64Array }) {
  const invalidate = useThree((s) => s.invalidate);
  const probe = useMemo(() => new THREE.LightProbe(), []);
  useLayoutEffect(() => {
    probe.sh.fromArray(Array.from(sh));
    probe.intensity = 1;
    invalidate();
  }, [probe, sh, invalidate]);
  return <primitive object={probe} />;
}

// ─── The lawn ────────────────────────────────────────────────────────────────────────────────

let lawnTexture: THREE.DataTexture | null = null;

/** The lawn's tile as an sRGB texture with mipmaps, so the far lawn is its mean and does not shimmer. */
function lawnMap(anisotropy: number): THREE.DataTexture {
  if (lawnTexture !== null) return lawnTexture;
  const g = grassTexture();
  const n = g.width * g.height;
  const data = new Uint8Array(4 * n);
  const enc = (c: number) => Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.min(1, c) ** (1 / 2.4) - 0.055));
  // The tile's rows run from v = 1 down (as @floorspec/mesh's lawnAt reads them); a DataTexture's first row is v = 0.
  for (let i = 0; i < n; i++) {
    const from = 3 * ((g.height - 1 - Math.floor(i / g.width)) * g.width + (i % g.width));
    data[4 * i] = enc((g.data[from] ?? 0));
    data[4 * i + 1] = enc((g.data[from + 1] ?? 0));
    data[4 * i + 2] = enc((g.data[from + 2] ?? 0));
    data[4 * i + 3] = 255;
  }
  const t = new THREE.DataTexture(data, g.width, g.height, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = anisotropy;
  t.needsUpdate = true;
  lawnTexture = t;
  return t;
}

/**
 * The lawn: a disc of rings, fine near the house and coarse far off, out to 2.5 km — where the haze
 * has it all — at true scale (a tile every `GRASS_TILE` metres, by world position), its colour
 * varied across the site, and pushed back in depth so slabs, patios and driveways at grade sit on
 * it cleanly. FLR-T-13.5's planting and paving draws over it the same way.
 */
function lawnGeometry(cx: number, cy: number): THREE.BufferGeometry {
  const radii: number[] = [0];
  for (let r = 0.25; r < 40; r += 0.25) radii.push(r);
  for (let r = 40; r < 2500; r *= 1.06) radii.push(r);
  radii.push(2500);
  const SEG = 240;
  const pos: number[] = [];
  const uv: number[] = [];
  const col: number[] = [];
  const index: number[] = [];
  for (let i = 0; i < radii.length; i++) {
    const r = radii[i] ?? 0;
    const ring = i === 0 ? 1 : SEG;
    for (let j = 0; j < ring; j++) {
      const a = (j / SEG) * 2 * Math.PI;
      const x = cx + r * Math.cos(a);
      const y = cy + r * Math.sin(a);
      pos.push(x - cx, y - cy, 0);
      uv.push(x / GRASS_TILE, y / GRASS_TILE);
      const m = lawnMacro(x, y);
      col.push(m, m, m);
    }
  }
  const start = (i: number) => (i === 0 ? 0 : 1 + (i - 1) * SEG);
  for (let j = 0; j < SEG; j++) index.push(0, start(1) + j, start(1) + ((j + 1) % SEG));
  for (let i = 1; i + 1 < radii.length; i++)
    for (let j = 0; j < SEG; j++) {
      const a = start(i) + j;
      const b = start(i) + ((j + 1) % SEG);
      const c = start(i + 1) + j;
      const d = start(i + 1) + ((j + 1) % SEG);
      index.push(a, c, b, b, c, d);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(new Array<number>(pos.length).fill(0).map((_, k) => (k % 3 === 2 ? 1 : 0)), 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(index);
  g.computeBoundingSphere();
  return g;
}

const noRaycast = (): void => undefined;

export function Lawn({ centre, ground, field }: { centre: THREE.Vector3; ground: number; field: SkyField }) {
  const gl = useThree((s) => s.gl);
  const invalidate = useThree((s) => s.invalidate);
  // Rebuilt only when the house moves by a tile or more: the lawn's pattern belongs to the site.
  const cx = Math.round(centre.x / GRASS_TILE) * GRASS_TILE;
  const cy = Math.round(centre.y / GRASS_TILE) * GRASS_TILE;
  const geometry = useMemo(() => lawnGeometry(cx, cy), [cx, cy]);
  const haze = useMemo(() => ({ hazeColor: { value: new THREE.Vector3() }, hazeNear: { value: 200 }, hazeFar: { value: 2400 } }), []);
  const material = useMemo(() => {
    const m = new THREE.MeshLambertMaterial({ map: lawnMap(gl.capabilities.getMaxAnisotropy()), vertexColors: true, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 6, fog: false });
    // The haze (@floorspec/mesh hazeAt): the lawn's light fades into the horizon's with distance, in
    // cd/m² before the tone curve — as the path tracer mixes it — so the far lawn meets the sky.
    m.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, haze);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying float vHazeDistance;')
        .replace('#include <project_vertex>', '#include <project_vertex>\nvHazeDistance = length( mvPosition.xyz );');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vHazeDistance;\nuniform vec3 hazeColor;\nuniform float hazeNear;\nuniform float hazeFar;')
        .replace('#include <opaque_fragment>', '#include <opaque_fragment>\ngl_FragColor.rgb = mix( gl_FragColor.rgb, hazeColor, smoothstep( hazeNear, hazeFar, vHazeDistance ) );');
    };
    m.customProgramCacheKey = () => 'floorspec-lawn-haze';
    return m;
  }, [gl, haze]);
  useLayoutEffect(() => {
    haze.hazeColor.value.set(...field.horizon);
    haze.hazeNear.value = field.light.haze.near;
    haze.hazeFar.value = field.light.haze.far;
    invalidate();
  }, [field, haze, invalidate]);
  useEffect(() => () => { geometry.dispose(); }, [geometry]);
  useEffect(() => () => { material.dispose(); }, [material]);
  return <mesh geometry={geometry} material={material} position={[cx, cy, ground]} receiveShadow raycast={noRaycast} userData={{ ground: true, lawn: true }} renderOrder={-1} />;
}

// ─── The tone curve ──────────────────────────────────────────────────────────────────────────

/**
 * Under a sky the view is tone-mapped as the path tracer and the headless render are (FLR-T-13.4):
 * Narkowicz's fit of the ACES filmic curve, per channel, on what the exposure gives it — three.js's
 * `CustomToneMapping`, which this fills in. (three.js's own ACES is the full RRT and ODT fit, a stop
 * darker in the mid-tones, and would make the editor's sky a different picture from the renders'.)
 * `toneMappingExposure` keeps its meaning: the exposure times 0.6 (lights.ts).
 */
THREE.ShaderChunk.tonemapping_pars_fragment = THREE.ShaderChunk.tonemapping_pars_fragment.replace(
  'vec3 CustomToneMapping( vec3 color ) { return color; }',
  'vec3 CustomToneMapping( vec3 color ) { color *= toneMappingExposure / 0.6; return saturate( ( color * ( 2.51 * color + 0.03 ) ) / ( color * ( 2.43 * color + 0.59 ) + 0.14 ) ); }',
);
