import * as THREE from 'three';
import { GLASS_F0, GLASS_GLSL, paneTransmission } from '@floorspec/mesh';
import { glow } from './highlight';
import type { Look } from './parts';
import type { MapRef } from './surfaces';
import { assetUrl } from '../../lib/assets';
import { libraryUrl } from '../../materials/library';

/** A `#rrggbb` as linear RGB. */
const linearOf = (hex: string): [number, number, number] => {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
};

/** A textured material with no colour of its own, before its image arrives: a quiet neutral. */
const FALLBACK = '#d9d6cf'; // d3-allow: a default material colour of the 3D model, not chrome

/**
 * The most metallic the editor draws a surface (FLR-T-13.6). Its sky lights the house by a light
 * probe — diffuse light only — and it traces no reflections, so a fully metallic surface, all of
 * whose colour is what it reflects, would be black but for a lamp's or the sun's glint. Held to half,
 * brushed steel reads as steel; the path tracer and the GPU still draw metals as they are.
 */
export const EDITOR_METALNESS_MAX = 0.5;

/**
 * Where a texture's bytes are: the material library's bundled file for a library digest (FLR-T-13.6),
 * else the project's asset route for its owner, or the link's own in the shared viewer (FLR-T-9.6) —
 * the same rule as every stored file the editor shows (lib/assets.ts).
 */
export const textureUrl = (store: string, sha256: string): string => libraryUrl(sha256) ?? assetUrl(store, sha256);

type Kind = 'albedo' | 'data';

/**
 * The most texture units a surface's own maps take in the 3D view (FLR-T-13.17): its base colour,
 * its normals, its occlusion-roughness-metalness map read through one sampler (`packOrm`), and an
 * occlusion map of its own when a document's material has one apart from its metallic-roughness
 * map. What a fragment shader has left over is the lamps' and the sun's shadow maps' (lights.ts).
 */
export const MATERIAL_TEXTURE_UNITS = 4;

/**
 * Glass in the 3D view (FLR-T-13.17, @floorspec/mesh glass.ts): what is behind a pane is multiplied
 * by what the pane lets through — about 90%, a little green, from the glass's colour — and the pane
 * adds only what its face reflects: a faint sheen of the light on it and the sun's and lamps'
 * glints. Blended as `behind × pane + reflection` (a constant blend colour), not as a pale
 * surface laid over the view at 38% — which turned the lawn and sky seen through a window teal.
 */
export function paneMaterial(color: readonly [number, number, number], options: { vertexColors?: boolean } = {}): THREE.MeshStandardMaterial {
  const pane = paneTransmission(color);
  const m = new THREE.MeshStandardMaterial({
    vertexColors: options.vertexColors === true,
    // The face's reflection of the light about it: F0 of a white surface's, in the pane's colour.
    color: new THREE.Color(GLASS_F0 * 1.5, GLASS_F0 * 1.5, GLASS_F0 * 1.5),
    roughness: 0.05,
    metalness: 0,
    transparent: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.ConstantColorFactor,
  });
  // The canvas holds sRGB: the blend's constant is the pane's transmission encoded as the canvas is.
  const enc = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
  m.blendColor.setRGB(enc(pane[0]), enc(pane[1]), enc(pane[2]));
  return m;
}

/**
 * Glass in Presentation (FLR-T-13.7), as @floorspec/mesh's glass.ts has it, per pixel and in linear
 * light: two passes over the pane. The first multiplies what is behind it by what it lets through at
 * the angle it is seen at (`glassTransmission`: less, and a little greener, at a slant); the second
 * adds what its face reflects — the sky's prefiltered light and the sun's and lamps' glints, by
 * Fresnel (a black dielectric: reflection only), which the screen-space reflections then make the
 * room's where they can. Front faces only, as Draft's pane: a glazing modelled as a slab is one pane,
 * not two.
 */
export interface PresentationPane {
  transmit: THREE.ShaderMaterial;
  reflect: THREE.MeshStandardMaterial;
}

export function presentationPane(color: readonly [number, number, number]): PresentationPane {
  const pane = paneTransmission(color);
  const transmit = new THREE.ShaderMaterial({
    uniforms: { pane: { value: new THREE.Vector3(pane[0], pane[1], pane[2]) } },
    vertexShader: /* glsl */ `
      #include <common>
      #include <batching_pars_vertex>
      varying vec3 vNormalV;
      varying vec3 vViewPos;
      void main() {
        #include <batching_vertex>
        #include <beginnormal_vertex>
        #include <defaultnormal_vertex>
        vNormalV = normalize( transformedNormal );
        #include <begin_vertex>
        #include <project_vertex>
        vViewPos = mvPosition.xyz;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 pane;
      varying vec3 vNormalV;
      varying vec3 vViewPos;
      ${GLASS_GLSL}
      void main() {
        float c = abs( dot( normalize( vNormalV ), normalize( - vViewPos ) ) );
        gl_FragColor = vec4( glassTransmission( pane, c ), 1.0 );
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.ZeroFactor,
    blendDst: THREE.SrcColorFactor,
  });
  // Not a reflector of its own: the reflecting pass stands for the pane in the geometry buffer.
  transmit.userData = { gbuffer: false };
  const reflect = new THREE.MeshStandardMaterial({
    color: 0x000000,
    roughness: 0.04,
    metalness: 0,
    transparent: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
  });
  reflect.userData = { glass: true };
  return { transmit, reflect };
}

/**
 * Read metalness — and occlusion, when it is the same image — from the roughness map's sampler:
 * the library's ORM file is all three (glTF's channels: occlusion red, roughness green, metalness
 * blue), so one texture unit serves where three.js would bind it three times.
 */
export function packOrm(m: THREE.MeshStandardMaterial, occlusion: boolean): void {
  m.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <metalnessmap_pars_fragment>', '#ifdef USE_METALNESSMAP\n#define metalnessMap roughnessMap\n#endif');
    if (occlusion) shader.fragmentShader = shader.fragmentShader.replace('#include <aomap_pars_fragment>', '#ifdef USE_AOMAP\n#define aoMap roughnessMap\nuniform float aoMapIntensity;\n#endif');
  };
  m.customProgramCacheKey = () => (occlusion ? 'floorspec-orm' : 'floorspec-rm');
}

/**
 * The 3D view's textures (FLR-T-8.2, FLR-T-13.6): each map loaded once — the library's from the
 * editor's own files, a project's from its asset route, immutable either way, so the browser caches
 * it by its digest — a base colour map as sRGB, a normal or occlusion-roughness-metalness map as
 * data, each repeating; and one physically based material per maps, look and selection state: the
 * base colour map drawn over white vertex colours (surfaces.ts) — or, for a colour-agnostic material,
 * no base colour map, its colour in the vertex colours — its normal map's relief, its roughness and
 * metalness from the ORM map's green and blue under Core 18.1's factors, and its occlusion from the
 * red. Until a map arrives — or if it never does — the material shows the Floorspec material's own
 * colour (Core 18.1: the colour to show where the map is not drawn), and the view is redrawn the
 * moment each image lands.
 */
export class TextureLibrary {
  private readonly textures = new Map<string, THREE.Texture>();
  private readonly materials = new Map<string, THREE.MeshStandardMaterial>();
  private readonly loader = new THREE.TextureLoader();
  /** Set from the theme's accent token before anything is selected (setAccent). */
  private accent = '';
  /** Digests whose image has arrived, and those that failed: for the e2e hook and for the fallback. */
  readonly loaded = new Set<string>();
  readonly failed = new Set<string>();
  private readonly waiting = new Map<string, (() => void)[]>();
  /** The maps, by kind and digest, that have arrived. */
  private readonly ready = new Set<string>();

  constructor(
    private readonly projectId: string,
    private readonly redraw: () => void,
  ) {
    this.loader.setWithCredentials(true);
  }

  texture(sha256: string, kind: Kind = 'albedo'): THREE.Texture {
    const key = `${kind}:${sha256}`;
    let tex = this.textures.get(key);
    if (tex !== undefined) return tex;
    tex = this.loader.load(
      textureUrl(this.projectId, sha256),
      () => {
        this.loaded.add(sha256);
        this.ready.add(key);
        for (const done of this.waiting.get(key) ?? []) done();
        this.waiting.delete(key);
        this.redraw();
      },
      undefined,
      () => {
        this.failed.add(sha256);
        this.redraw();
      },
    );
    tex.colorSpace = kind === 'albedo' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 8;
    this.textures.set(key, tex);
    return tex;
  }

  /** Call `done` once the map with this digest has arrived (now, if it has). */
  private whenLoaded(sha256: string, kind: Kind, done: () => void): THREE.Texture {
    const tex = this.texture(sha256, kind);
    if (this.ready.has(`${kind}:${sha256}`)) done();
    else {
      const key = `${kind}:${sha256}`;
      this.waiting.set(key, [...(this.waiting.get(key) ?? []), done]);
    }
    return tex;
  }

  /** The material that draws a part's maps in this look; `on` for the selected element. */
  material(ref: MapRef, look: Look, on: boolean): THREE.MeshStandardMaterial {
    const key = `${ref.key}|${look}|${on ? 'on' : 'off'}`;
    let m = this.materials.get(key);
    if (m !== undefined) return m;
    const glass = ref.glass === true || look === 'glass';
    if (glass && !on) {
      // Library glass: a pane (paneMaterial), in its own colour's transmission.
      const pane = paneMaterial(linearOf(ref.color ?? FALLBACK));
      this.materials.set(key, pane);
      return pane;
    }
    m = new THREE.MeshStandardMaterial({
      vertexColors: true,
      color: ref.sha256 === '' ? 0xffffff : (ref.color ?? FALLBACK),
      roughness: ref.roughness,
      metalness: Math.min(EDITOR_METALNESS_MAX, ref.metalness),
      ...(glass ? { transparent: true, opacity: 0.38, depthWrite: false } : {}),
      ...(look === 'floor' ? { polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 } : {}),
      ...(look === 'ceiling' ? { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -6 } : {}),
      ...(on ? { emissiveIntensity: 0.55 } : {}),
    });
    // One sampler for the ORM map (FLR-T-13.17): three.js gives roughness, metalness and occlusion a
    // texture unit each even when they are one image, and with the lamps' shadow maps a textured
    // floor ran out of units — its program failed to link and it was not drawn at all.
    if (ref.orm !== undefined) packOrm(m, ref.occlusion === undefined);
    if (on && this.accent !== '') m.emissive.set(this.accent);
    if (on) glow(m);
    this.materials.set(key, m);
    const mat = m;
    const changed = () => {
      mat.needsUpdate = true;
    };
    if (ref.sha256 !== '') {
      const t = this.whenLoaded(ref.sha256, 'albedo', () => {
        // The image has arrived: it is the colour now.
        mat.map = t;
        mat.color.set(0xffffff);
        changed();
      });
    }
    if (ref.normal !== undefined) {
      const t = this.whenLoaded(ref.normal, 'data', () => {
        mat.normalMap = t;
        changed();
      });
    }
    if (ref.orm !== undefined) {
      const t = this.whenLoaded(ref.orm, 'data', () => {
        // glTF's channels: occlusion red (when it is the occlusion map too), roughness green, metalness blue.
        mat.roughnessMap = t;
        mat.metalnessMap = t;
        if (ref.occlusion === undefined) mat.aoMap = t;
        changed();
      });
    }
    if (ref.occlusion !== undefined) {
      const t = this.whenLoaded(ref.occlusion, 'data', () => {
        mat.aoMap = t;
        changed();
      });
    }
    return m;
  }

  /** The selection's glow, which follows the theme's accent. */
  setAccent(accent: string): void {
    this.accent = accent;
    for (const [key, m] of this.materials) if (key.endsWith('|on')) m.emissive.set(accent);
  }

  dispose(): void {
    for (const m of this.materials.values()) m.dispose();
    for (const t of this.textures.values()) t.dispose();
    this.materials.clear();
    this.textures.clear();
  }
}
