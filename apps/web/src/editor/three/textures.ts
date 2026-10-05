import * as THREE from 'three';
import type { Look } from './parts';
import type { MapRef } from './surfaces';
import { assetUrl } from '../../lib/assets';

/** A textured material with no colour of its own, before its image arrives: a quiet neutral. */
const FALLBACK = '#d9d6cf'; // d3-allow: a default material colour of the 3D model, not chrome

/**
 * Where a texture's bytes are: the project's asset route for its owner, or the link's own in the
 * shared viewer (FLR-T-9.6) — the same rule as every stored file the editor shows (lib/assets.ts).
 */
export const textureUrl = assetUrl;

/**
 * The 3D view's textures (FLR-T-8.2): each base colour map loaded once from the project's asset
 * route — immutable, so the browser caches it by its digest — as an sRGB texture that repeats, and
 * one three.js material per map, look and selection state. A material draws its map over white
 * vertex colours (surfaces.ts), so the map is the colour. Until the image arrives — or if it never
 * does — the material shows the Floorspec material's own colour (Core 18.1: the colour to show
 * where the map is not drawn), and the view is redrawn the moment each image lands.
 */
export class TextureLibrary {
  private readonly textures = new Map<string, THREE.Texture>();
  private readonly materials = new Map<string, THREE.MeshLambertMaterial>();
  private readonly loader = new THREE.TextureLoader();
  /** Set from the theme's accent token before anything is selected (setAccent). */
  private accent = '';
  /** Digests whose image has arrived, and those that failed: for the e2e hook and for the fallback. */
  readonly loaded = new Set<string>();
  readonly failed = new Set<string>();

  constructor(
    private readonly projectId: string,
    private readonly redraw: () => void,
  ) {
    this.loader.setWithCredentials(true);
  }

  private readonly waiting = new Map<string, THREE.MeshLambertMaterial[]>();

  texture(sha256: string): THREE.Texture {
    let tex = this.textures.get(sha256);
    if (tex !== undefined) return tex;
    tex = this.loader.load(
      textureUrl(this.projectId, sha256),
      (t) => {
        this.loaded.add(sha256);
        for (const m of this.waiting.get(sha256) ?? []) this.show(m, t);
        this.waiting.delete(sha256);
        this.redraw();
      },
      undefined,
      () => {
        this.failed.add(sha256);
        this.redraw();
      },
    );
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 8;
    this.textures.set(sha256, tex);
    return tex;
  }

  /** The material that draws a map on a part of this look; `on` for the selected element. */
  material(ref: MapRef, look: Look, on: boolean): THREE.MeshLambertMaterial {
    const key = `${ref.key}|${look}|${on ? 'on' : 'off'}`;
    let m = this.materials.get(key);
    if (m !== undefined) return m;
    m = new THREE.MeshLambertMaterial({
      vertexColors: true,
      color: ref.color ?? FALLBACK,
      ...(look === 'floor' ? { polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 } : {}),
      ...(look === 'ceiling' ? { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -6 } : {}),
      ...(on ? { emissiveIntensity: 0.55 } : {}),
    });
    if (on && this.accent !== '') m.emissive.set(this.accent);
    this.materials.set(key, m);
    const tex = this.texture(ref.sha256);
    if (this.loaded.has(ref.sha256)) this.show(m, tex);
    else this.waiting.set(ref.sha256, [...(this.waiting.get(ref.sha256) ?? []), m]);
    return m;
  }

  /** The image has arrived: it is the colour now. */
  private show(m: THREE.MeshLambertMaterial, tex: THREE.Texture): void {
    m.map = tex;
    m.color.set(0xffffff);
    m.needsUpdate = true;
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
