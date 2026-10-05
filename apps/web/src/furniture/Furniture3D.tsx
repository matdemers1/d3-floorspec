import { useEffect, useMemo, useState } from 'react';
import { useThree, type ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { HouseMesh } from '@floorspec/mesh';
import type { EditorModel } from '../editor/model';
import { facingVector, type DeviceView } from '../editor/systems/view';
import { assetHref } from './api';
import { filesOf, isFurniture } from './view';

/**
 * Furniture in the 3D view (FLR-T-8.3): each FS_furniture element's glTF model, loaded once per
 * file from the project's asset route with three's GLTFLoader (pinned with three r186), placed in
 * the element's frame exactly as Core 12.6 says — the frame's origin, its x the element's front —
 * by two groups: the frame (at the placement, turned by its facing about +Z), and inside it the
 * glTF axes turned onto Floorspec's, so the model point (X, Y, Z) is the local point (X, −Z, Y).
 * The model is drawn as it is, never stretched to its box.
 *
 * An element whose model has not arrived, or will not, keeps the fallback box the mesher draws for
 * every extension element (Core 12.6); the 3D view leaves that box out only once a model is drawn.
 * Clicking a model selects its element; the selection is outlined by the element's box. With the
 * Clearances layer on, each item's envelopes are drawn as translucent boxes in its frame.
 */

type Json = Record<string, unknown>;

/**
 * Every model file, loaded once per page: its URL → the parsed scene. Keyed by where it was read
 * from, not its digest alone, so the owner's editor and a share link (FLR-T-9.6: the link's own
 * asset route) never answer for each other.
 */
const cache = new Map<string, Promise<THREE.Group>>();
const loaded = new Set<string>();
const failed = new Set<string>();

function loadModel(projectId: string, sha256: string): Promise<THREE.Group> {
  const url = assetHref(projectId, sha256);
  let p = cache.get(url);
  if (p === undefined) {
    p = fetch(url, { credentials: 'same-origin' })
      .then(async (res) => {
        if (!res.ok) throw new Error(`the model answered ${String(res.status)}`);
        const buffer = await res.arrayBuffer();
        return new Promise<THREE.Group>((resolve, reject) => {
          new GLTFLoader().parse(buffer, '', (gltf) => { resolve(gltf.scene); }, (e: unknown) => { reject(e instanceof Error ? e : new Error('the model could not be parsed')); });
        });
      })
      .then(
        (scene) => {
          loaded.add(url);
          return scene;
        },
        (e: unknown) => {
          failed.add(url);
          throw e;
        },
      );
    cache.set(url, p);
  }
  return p;
}

export interface FurnitureModel {
  id: string;
  sha256: string;
  level: string;
  /** The frame's origin in base units, and its facing in microdegrees (Core 13.1, 13.4). */
  origin: [number, number, number];
  facing: number;
  box: { min: number[]; max: number[] } | null;
  clearances: { min: number[]; max: number[] }[];
}

/** The furniture with a model on every level of the shown model. */
export function furnitureModels(model: EditorModel): FurnitureModel[] {
  const out: FurnitureModel[] = [];
  for (const level of model.levels)
    for (const d of level.devices) {
      if (!isFurniture(d)) continue;
      const file = filesOf(model.document, d.element).model;
      if (file === null) continue;
      out.push({
        id: d.id,
        sha256: file.sha256,
        level: d.level,
        origin: d.placement === null ? [0, 0, level.elevation] : [d.placement.point[0], d.placement.point[1], d.placement.z],
        facing: d.placement?.facing ?? 0,
        box: boxOf(d),
        clearances: Object.values((d.element['clearances'] ?? {}) as Record<string, { min: number[]; max: number[] }>),
      });
    }
  return out;
}

const boxOf = (d: DeviceView): { min: number[]; max: number[] } | null => {
  const b = (d.element['fallback'] as Json | undefined)?.['box'] as { min: number[]; max: number[] } | undefined;
  return b !== undefined && Array.isArray(b.min) && Array.isArray(b.max) ? b : null;
};

/**
 * The models, loading: which elements' models are drawn (so their fallback boxes can be left out),
 * re-read as each file arrives.
 */
export function useFurnitureModels(projectId: string, model: EditorModel | null): { items: FurnitureModel[]; scenes: Map<string, THREE.Group>; drawn: Set<string> } {
  const items = useMemo(() => (model === null ? [] : furnitureModels(model)), [model]);
  const [scenes, setScenes] = useState(() => new Map<string, THREE.Group>());
  useEffect(() => {
    let live = true;
    for (const sha of new Set(items.map((i) => i.sha256))) {
      if (scenes.has(sha) || failed.has(assetHref(projectId, sha))) continue;
      loadModel(projectId, sha).then(
        (scene) => {
          if (live) setScenes((m) => new Map(m).set(sha, scene));
        },
        () => {
          // A model that does not load leaves its element's fallback box in place.
        },
      );
    }
    return () => {
      live = false;
    };
  }, [items, projectId, scenes]);
  const drawn = useMemo(() => new Set(items.filter((i) => scenes.has(i.sha256)).map((i) => i.id)), [items, scenes]);
  useTestHook(projectId, items, drawn);
  return { items, scenes, drawn };
}

const HALF_PI = Math.PI / 2;

/** One element's model in its frame; its box outlined when selected; its envelopes when shown. */
function Item({ item, scene, mesh, selected, accent, clearances, onClick }: { item: FurnitureModel; scene: THREE.Group; mesh: HouseMesh; selected: boolean; accent: string; clearances: boolean; onClick: (e: ThreeEvent<MouseEvent>) => void }) {
  const k = mesh.unitsPerMetre;
  const position = useMemo(() => new THREE.Vector3((item.origin[0] - mesh.origin[0]) / k, (item.origin[1] - mesh.origin[1]) / k, (item.origin[2] - mesh.origin[2]) / k), [item, mesh, k]);
  const yaw = useMemo(() => {
    const [x, y] = facingVector(item.facing);
    return Math.atan2(y, x);
  }, [item.facing]);
  // One copy per element: geometry and materials are shared with the file's scene.
  const copy = useMemo(() => {
    const c = scene.clone(true);
    c.traverse((o) => {
      o.userData = { id: item.id, kind: 'furniture' };
    });
    return c;
  }, [scene, item.id]);
  const outline = useMemo(() => (item.box === null ? null : boxEdges(item.box, k)), [item.box, k]);
  const envelopes = useMemo(() => (clearances ? item.clearances.map((e) => boxSolid(e, k)) : []), [clearances, item.clearances, k]);
  useEffect(() => () => { outline?.geometry.dispose(); }, [outline]);
  useEffect(() => () => { for (const e of envelopes) e.geometry.dispose(); }, [envelopes]);
  const lineMaterial = useMemo(() => new THREE.LineBasicMaterial({ depthTest: false, transparent: true, opacity: 0.95 }), []);
  const envelopeMaterial = useMemo(() => new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.18, depthWrite: false }), []);
  useEffect(() => {
    lineMaterial.color.set(accent);
    envelopeMaterial.color.set(accent);
  }, [accent, lineMaterial, envelopeMaterial]);
  useEffect(() => () => {
    lineMaterial.dispose();
    envelopeMaterial.dispose();
  }, [lineMaterial, envelopeMaterial]);
  return (
    <group position={position} rotation={[0, 0, yaw]}>
      {/* glTF's +Y up, −Z left: turned +90° about x, (X, Y, Z) → (X, −Z, Y) (Core 12.6). */}
      <group rotation={[HALF_PI, 0, 0]} onClick={onClick}>
        <primitive object={copy} />
      </group>
      {selected && outline !== null ? <lineSegments geometry={outline.geometry} position={outline.centre} material={lineMaterial} renderOrder={2} raycast={noRaycast} /> : null}
      {envelopes.map((e, i) => (
        <mesh key={i} geometry={e.geometry} position={e.centre} material={envelopeMaterial} renderOrder={1} raycast={noRaycast} userData={{ envelope: item.id }} />
      ))}
    </group>
  );
}

const noRaycast = (): void => undefined;

function boxParts(b: { min: number[]; max: number[] }, k: number): { size: [number, number, number]; centre: THREE.Vector3 } {
  const size: [number, number, number] = [0, 1, 2].map((i) => ((b.max[i] ?? 0) - (b.min[i] ?? 0)) / k) as [number, number, number];
  const centre = new THREE.Vector3(...[0, 1, 2].map((i) => ((b.max[i] ?? 0) + (b.min[i] ?? 0)) / 2 / k));
  return { size, centre };
}

function boxEdges(b: { min: number[]; max: number[] }, k: number): { geometry: THREE.BufferGeometry; centre: THREE.Vector3 } {
  const { size, centre } = boxParts(b, k);
  const solid = new THREE.BoxGeometry(...size);
  const geometry = new THREE.EdgesGeometry(solid);
  solid.dispose();
  return { geometry, centre };
}

function boxSolid(b: { min: number[]; max: number[] }, k: number): { geometry: THREE.BufferGeometry; centre: THREE.Vector3 } {
  const { size, centre } = boxParts(b, k);
  return { geometry: new THREE.BoxGeometry(...size), centre };
}

/** The furniture's models in the scene, for the elements whose fallback parts are visible. */
export function FurnitureScene({
  furniture,
  mesh,
  visibleIds,
  selection,
  accent,
  clearances,
  onClick,
}: {
  furniture: { items: FurnitureModel[]; scenes: Map<string, THREE.Group> };
  mesh: HouseMesh;
  visibleIds: ReadonlySet<string>;
  selection: string | null;
  accent: string;
  clearances: boolean;
  onClick: (e: ThreeEvent<MouseEvent>) => void;
}) {
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => { invalidate(); }, [furniture, selection, clearances, visibleIds, invalidate]);
  return (
    <group>
      {furniture.items.map((item) => {
        const scene = furniture.scenes.get(item.sha256);
        if (scene === undefined || !visibleIds.has(item.id)) return null;
        return <Item key={item.id} item={item} scene={scene} mesh={mesh} selected={selection === item.id} accent={accent} clearances={clearances} onClick={onClick} />;
      })}
    </group>
  );
}

// ─── The test hook ───────────────────────────────────────────────────────────────────────────

interface Hook {
  /** Elements whose model is drawn in 3D. */
  drawn: string[];
  /** Elements with a model, drawn or not. */
  items: string[];
  failed: string[];
}

declare global {
  interface Window {
    __floorspecFurniture3d?: Hook;
  }
}

/** Under automation only (navigator.webdriver): which models are drawn. Nothing is exposed to a person's browser. */
function useTestHook(projectId: string, items: FurnitureModel[], drawn: Set<string>): void {
  useEffect(() => {
    if (!navigator.webdriver) return;
    const hook: Hook = {
      drawn: [...drawn].sort(),
      items: items.map((i) => i.id).sort(),
      failed: items.filter((i) => failed.has(assetHref(projectId, i.sha256))).map((i) => i.id).sort(),
    };
    window.__floorspecFurniture3d = hook;
    return () => {
      if (window.__floorspecFurniture3d === hook) delete window.__floorspecFurniture3d;
    };
  }, [projectId, items, drawn]);
}

/** Leave out the fallback boxes the mesher drew for elements whose model is drawn instead. */
export function withoutModelled<T extends { part: { kind: string; id: string } }>(parts: readonly T[], drawn: ReadonlySet<string>): T[] {
  return drawn.size === 0 ? [...parts] : parts.filter((b) => !(b.part.kind === 'extension' && drawn.has(b.part.id)));
}

/** The extension elements whose fallback part is showing: the furniture models follow the same cutaway. */
export function visibleExtensionIds(parts: readonly { part: { kind: string; id: string } }[]): Set<string> {
  return new Set(parts.filter((b) => b.part.kind === 'extension').map((b) => b.part.id));
}

export { loaded as loadedModels };
