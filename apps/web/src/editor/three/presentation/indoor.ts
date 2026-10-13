import * as THREE from 'three';
import type { HouseMesh } from '@floorspec/mesh';
import type { EditorModel } from '../../model';

/**
 * Where the house is indoors, for Presentation's reflections (FLR-T-13.7): a top-down map of the
 * rooms' footprints, each texel holding the lowest floor and the highest ceiling of the rooms over
 * it (metres, the 3D view's frame). A surface inside that span is in a room.
 *
 * The editor lights the house with its sky's light probe, and reflections with the sky's
 * prefiltered map — right outside, where a glossy patio or a car's paint does reflect the sky; wrong
 * inside, where a floor reflects the room. So indoors the resolve takes the sky's reflection out of a
 * surface again and puts back only what the screen-space trace finds of the room; outside it takes
 * the sky's reflection out only where the trace finds something in the way. Built from the model,
 * not the drawn parts, so a cutaway — which takes the ceilings and the roof off — is still indoors.
 */

export interface Indoor {
  texture: THREE.DataTexture;
  /** Metres, the view's frame: the map's corners. */
  min: THREE.Vector2;
  max: THREE.Vector2;
}

/** The texels across the map's longer side. */
export const INDOOR_SIZE = 512;

function inside(x: number, y: number, ring: readonly (readonly [number, number])[]): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (a === undefined || b === undefined) continue;
    if (a[1] > y !== b[1] > y && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) hit = !hit;
  }
  return hit;
}

export function indoorMap(model: EditorModel, mesh: HouseMesh): Indoor | null {
  const k = mesh.unitsPerMetre;
  const [ox, oy, oz] = mesh.origin;
  const rooms = model.levels.flatMap((level) =>
    level.rooms.map((room) => {
      const ring = room.outer.map(([x, y]) => [(x - ox) / k, (y - oy) / k] as [number, number]);
      const holes = room.holes.map((h) => h.map(([x, y]) => [(x - ox) / k, (y - oy) / k] as [number, number]));
      const bottom = ((room.floorTop ?? level.elevation) - oz) / k;
      const top = (Math.max(level.elevation + level.height, room.ceiling?.high ?? -Infinity) - oz) / k;
      return { ring, holes, bottom, top };
    }),
  );
  if (rooms.length === 0) return null;
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const r of rooms)
    for (const [x, y] of r.ring) {
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
  const pad = 0.25;
  [x0, y0, x1, y1] = [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
  const span = Math.max(x1 - x0, y1 - y0);
  const w = Math.max(2, Math.round((INDOOR_SIZE * (x1 - x0)) / span));
  const h = Math.max(2, Math.round((INDOOR_SIZE * (y1 - y0)) / span));
  const data = new Float32Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[4 * i] = Infinity;
    data[4 * i + 1] = -Infinity;
  }
  for (const r of rooms) {
    let [rx0, ry0, rx1, ry1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [x, y] of r.ring) {
      rx0 = Math.min(rx0, x);
      ry0 = Math.min(ry0, y);
      rx1 = Math.max(rx1, x);
      ry1 = Math.max(ry1, y);
    }
    const i0 = Math.max(0, Math.floor(((rx0 - x0) / (x1 - x0)) * w));
    const i1 = Math.min(w - 1, Math.ceil(((rx1 - x0) / (x1 - x0)) * w));
    const j0 = Math.max(0, Math.floor(((ry0 - y0) / (y1 - y0)) * h));
    const j1 = Math.min(h - 1, Math.ceil(((ry1 - y0) / (y1 - y0)) * h));
    for (let j = j0; j <= j1; j++) {
      const y = y0 + ((j + 0.5) / h) * (y1 - y0);
      for (let i = i0; i <= i1; i++) {
        const x = x0 + ((i + 0.5) / w) * (x1 - x0);
        if (!inside(x, y, r.ring) || r.holes.some((hole) => inside(x, y, hole))) continue;
        const o = 4 * (j * w + i);
        data[o] = Math.min(data[o] ?? Infinity, r.bottom);
        data[o + 1] = Math.max(data[o + 1] ?? -Infinity, r.top);
      }
    }
  }
  // Outdoors: an empty span.
  for (let i = 0; i < w * h; i++) {
    if (!Number.isFinite(data[4 * i] ?? Infinity)) {
      data[4 * i] = 0;
      data[4 * i + 1] = -1;
    }
    data[4 * i + 3] = 1;
  }
  const texture = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.FloatType);
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return { texture, min: new THREE.Vector2(x0, y0), max: new THREE.Vector2(x1, y1) };
}
