import * as THREE from 'three';

/**
 * The geometry buffer Presentation's screen-space passes read (FLR-T-13.7): for each pixel, the
 * surface's view-space normal (as three.js's MeshNormalMaterial packs it — what GTAO reads) and, in
 * alpha, what kind of reflector it is, with the depth beside it. Drawn in one pass of the scene with
 * every mesh's material swapped for a small one of its own, which costs no lights and no shadows.
 *
 * Alpha:
 *  - 0…1   a dielectric, its roughness (per pixel, from its roughness map where it has one);
 *  - 2…3   a metal, roughness + 2;
 *  - 4…5   glass, roughness + 4 — reflects, and is left out of the ambient occlusion;
 *  - 8     reflects nothing worth tracing (matte, unlit, or not a surface);
 *  - 12    a light: a lamp's lit lens — what blooms;
 *  - 16    nothing: the sky (the clear value).
 */

export const SURFACE = { metal: 2, glass: 4, matte: 8, light: 12, sky: 16 } as const;
/** Rougher than this, a surface's reflection is the sky's prefiltered light alone: nothing is traced. */
export const TRACE_ROUGHNESS = 0.6;

const VERTEX = /* glsl */ `
#include <common>
#include <batching_pars_vertex>
#include <uv_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
varying vec3 vN;
varying vec2 vRUv;
uniform mat3 rTransform;
void main() {
  #include <uv_vertex>
  #include <batching_vertex>
  #include <beginnormal_vertex>
  #include <morphnormal_vertex>
  #include <skinbase_vertex>
  #include <skinnormal_vertex>
  #include <defaultnormal_vertex>
  vN = normalize( transformedNormal );
  #ifdef USE_UV
    vRUv = ( rTransform * vec3( uv, 1.0 ) ).xy;
  #else
    vRUv = vec2( 0.0 );
  #endif
  #include <begin_vertex>
  #include <morphtarget_vertex>
  #include <skinning_vertex>
  #include <project_vertex>
}`;

const FRAGMENT = /* glsl */ `
uniform float code;
uniform float roughness;
uniform sampler2D rMap;
varying vec3 vN;
varying vec2 vRUv;
void main() {
  vec3 n = normalize( vN );
  if ( ! gl_FrontFacing ) n = - n;
  float a = code;
  if ( code < 6.5 ) {
    float r = roughness;
    #ifdef USE_RMAP
      r *= texture2D( rMap, vRUv ).g;
    #endif
    a = code + clamp( r, 0.0, 1.0 );
  }
  gl_FragColor = vec4( n * 0.5 + 0.5, a );
}`;

interface Stand {
  material: THREE.ShaderMaterial;
  map: THREE.Texture | null;
}

/** What a material is to the passes: a reflector's kind and roughness, or not one. */
export function surfaceOf(m: THREE.Material): { code: number; roughness: number; map: THREE.Texture | null } | null {
  if (!m.visible || !m.colorWrite) return null;
  const u = m.userData as { glass?: boolean; gbuffer?: false; lens?: boolean };
  if (u.gbuffer === false) return null;
  if (u.lens === true) return { code: SURFACE.light, roughness: 1, map: null };
  if (u.glass === true) return { code: SURFACE.glass, roughness: m instanceof THREE.MeshStandardMaterial ? m.roughness : 0.05, map: null };
  // A transparent overlay (a highlight, an envelope) is not a surface.
  if (m.transparent && m.opacity < 0.95) return null;
  if (m instanceof THREE.MeshStandardMaterial) {
    const map = m.roughnessMap;
    const metal = m.metalness >= 0.35 && m.metalnessMap === null;
    return { code: metal ? SURFACE.metal : 0, roughness: m.roughness, map };
  }
  return { code: SURFACE.matte, roughness: 1, map: null };
}

export class GBuffer {
  readonly target: THREE.WebGLRenderTarget;
  private readonly stands = new Map<string, Stand>();
  private readonly swapped: { mesh: THREE.Mesh; material: THREE.Material | THREE.Material[] }[] = [];
  private readonly hidden: THREE.Object3D[] = [];
  private readonly identity = new THREE.Matrix3();

  constructor(width: number, height: number) {
    const depth = new THREE.DepthTexture(width, height);
    depth.type = THREE.UnsignedIntType;
    this.target = new THREE.WebGLRenderTarget(width, height, {
      type: THREE.HalfFloatType,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthTexture: depth,
      depthBuffer: true,
    });
  }

  setSize(width: number, height: number): void {
    this.target.setSize(width, height);
  }

  private stand(m: THREE.Material): THREE.Material | null {
    const s = surfaceOf(m);
    if (s === null) return null;
    const map = s.map;
    const key = `${String(s.code)}|${s.roughness.toFixed(3)}|${String(m.side)}|${map?.uuid ?? ''}`;
    let stand = this.stands.get(key);
    if (stand === undefined) {
      const material = new THREE.ShaderMaterial({
        vertexShader: VERTEX,
        fragmentShader: FRAGMENT,
        uniforms: {
          code: { value: s.code },
          roughness: { value: s.roughness },
          rMap: { value: map },
          rTransform: { value: new THREE.Matrix3() },
        },
        defines: map === null ? {} : { USE_RMAP: '', USE_UV: '' },
        side: m.side,
      });
      stand = { material, map };
      this.stands.set(key, stand);
    }
    const t = stand.material.uniforms['rTransform'];
    if (t !== undefined) {
      if (map !== null) {
        if (map.matrixAutoUpdate) map.updateMatrix();
        (t.value as THREE.Matrix3).copy(map.matrix);
      } else (t.value as THREE.Matrix3).copy(this.identity);
    }
    return stand.material;
  }

  /** Draw the scene's normals, reflectors and depth into `target`; everything is put back after. */
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): void {
    scene.traverseVisible((o) => {
      const u = o.userData as { sky?: boolean };
      if (u.sky === true || o instanceof THREE.Line || o instanceof THREE.Points || o instanceof THREE.Sprite) {
        if (o.visible) {
          o.visible = false;
          this.hidden.push(o);
        }
        return;
      }
      if (!(o instanceof THREE.Mesh)) return;
      const mesh = o as THREE.Mesh;
      const original = mesh.material;
      if (Array.isArray(original)) {
        const stands = original.map((m) => this.stand(m));
        if (stands.every((s) => s === null)) {
          mesh.visible = false;
          this.hidden.push(mesh);
          return;
        }
        this.swapped.push({ mesh, material: original });
        // A group whose material is not a surface draws nothing: an invisible material in its place.
        mesh.material = stands.map((s) => s ?? NOTHING);
      } else {
        const s = this.stand(original);
        if (s === null) {
          mesh.visible = false;
          this.hidden.push(mesh);
          return;
        }
        this.swapped.push({ mesh, material: original });
        mesh.material = s;
      }
    });
    const background = scene.background;
    const environment = scene.environment;
    const fog = scene.fog;
    scene.background = null;
    scene.environment = null;
    scene.fog = null;
    const clear = renderer.getClearColor(new THREE.Color());
    const alpha = renderer.getClearAlpha();
    const shadows = renderer.shadowMap.enabled;
    renderer.shadowMap.enabled = false;
    renderer.setRenderTarget(this.target);
    // Clear: a normal facing the camera, and "sky" in alpha.
    renderer.setClearColor(new THREE.Color(0.5, 0.5, 1), SURFACE.sky);
    renderer.clear(true, true, false);
    renderer.render(scene, camera);
    renderer.shadowMap.enabled = shadows;
    renderer.setClearColor(clear, alpha);
    scene.background = background;
    scene.environment = environment;
    scene.fog = fog;
    for (const s of this.swapped) s.mesh.material = s.material;
    for (const o of this.hidden) o.visible = true;
    this.swapped.length = 0;
    this.hidden.length = 0;
  }

  dispose(): void {
    this.target.depthTexture?.dispose();
    this.target.dispose();
    for (const s of this.stands.values()) s.material.dispose();
    this.stands.clear();
  }
}

const NOTHING = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
