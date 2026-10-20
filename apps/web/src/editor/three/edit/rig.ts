import * as THREE from 'three';
import type { Vec3 } from '@floorspec/mesh';
import { moved, type Motion } from './motion';

/**
 * The 3D view's moving parts (FLR-T-14.8), outside React so a drag re-renders nothing: each element's
 * objects — its parts, its outline when selected, its furniture model — registered by its ID, and
 * the motion each is drawn with now. Two sources are merged: the model's (what the shown model has
 * moved since the house was meshed, motion.ts) and the live drag's (an opening slid before any
 * preview of it exists), the live one winning.
 */
export class MotionRig {
  private readonly objects = new Map<string, Set<THREE.Object3D>>();
  private model = new Map<string, Motion>();
  private live = new Map<string, Motion>();
  private readonly matrices = new Map<string, THREE.Matrix4>();
  invalidate: () => void = () => undefined;

  /** Draw `o` as element `id`'s: moved with it from now on. Returns the cleanup. */
  register(id: string, o: THREE.Object3D): () => void {
    let set = this.objects.get(id);
    if (set === undefined) {
      set = new Set();
      this.objects.set(id, set);
    }
    set.add(o);
    const m = this.matrices.get(id);
    if (m !== undefined) place(o, m);
    return () => {
      const s = this.objects.get(id);
      if (s === undefined) return;
      s.delete(o);
      if (s.size === 0) this.objects.delete(id);
    };
  }

  /** What the shown model has moved since the meshed one. */
  setModel(moves: Map<string, Motion>): void {
    if (moves.size === 0 && this.model.size === 0) return;
    this.model = moves;
    this.apply();
  }

  /** What a drag is moving now, ahead of any preview. */
  setLive(moves: Map<string, Motion>): void {
    if (moves.size === 0 && this.live.size === 0) return;
    this.live = moves;
    this.apply();
  }

  /** The motion element `id` is drawn with now; null when it is where the mesh has it. */
  of(id: string): Motion | null {
    return this.live.get(id) ?? this.model.get(id) ?? null;
  }

  /** A point of element `id`'s, metres in the mesh's frame, where it is drawn now. */
  at(id: string, p: Vec3): Vec3 {
    const m = this.of(id);
    return m === null ? p : moved(m, p);
  }

  /** The IDs drawn somewhere else than the mesh has them. */
  ids(): string[] {
    return [...this.matrices.keys()].sort();
  }

  private apply(): void {
    const next = new Map<string, THREE.Matrix4>();
    for (const [id, m] of [...this.model, ...this.live]) next.set(id, matrixOf(m));
    for (const id of this.matrices.keys()) {
      if (next.has(id)) continue;
      for (const o of this.objects.get(id) ?? []) unplace(o);
    }
    for (const [id, m] of next) for (const o of this.objects.get(id) ?? []) place(o, m);
    this.matrices.clear();
    for (const [id, m] of next) this.matrices.set(id, m);
    this.invalidate();
  }
}

function matrixOf(m: Motion): THREE.Matrix4 {
  return new THREE.Matrix4().makeRotationZ(m.turn).setPosition(m.t[0], m.t[1], m.t[2]);
}

/** An object drawn with a motion: its matrix is the motion's, not its position's. */
function place(o: THREE.Object3D, m: THREE.Matrix4): void {
  o.matrixAutoUpdate = false;
  o.matrix.copy(m);
  o.matrixWorldNeedsUpdate = true;
}

/** Back where its position puts it (the parts of the house have none: they are meshed in place). */
function unplace(o: THREE.Object3D): void {
  o.matrixAutoUpdate = true;
  o.updateMatrix();
  o.matrixWorldNeedsUpdate = true;
}
