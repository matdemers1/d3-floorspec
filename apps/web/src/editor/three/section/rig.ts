import * as THREE from 'three';
import type { Vec3 } from './section';

/**
 * What the canvas and the overlays over it share for the section box and the exploded view
 * (FLR-T-14.6), outside React so a drag or a frame of the animation re-renders nothing: how far apart
 * the layers are and the objects that rise with each, the camera the overlays project through, and
 * the still and the probe the canvas side provides.
 */

/** A part of the house the exploded view lifts: a level's or a roof's layer, by its key. */
export class SectionRig {
  /** 0: together, 1: apart. */
  progress = 0;
  from = 0;
  to = 0;
  start = 0;
  /** Each layer's lift when fully apart, metres. */
  lifts = new Map<string, number>();
  private readonly objects = new Map<THREE.Object3D, string>();
  /** The camera the overlays project through, and the canvas's size (CSS pixels). */
  camera: THREE.Camera | null = null;
  size = { width: 1, height: 1 };
  /** Called by the canvas after every frame is drawn: the overlays move their handles and labels. */
  readonly overlays = new Set<() => void>();
  invalidate: () => void = () => undefined;
  /** The canvas's picture as drawn now (FLR-T-14.6's still): set by the canvas side. */
  capture: ((o: { transparent: boolean }) => HTMLCanvasElement | null) | null = null;
  /** Under automation: the share of a small render the caps cover (0–1). Set by the canvas side. */
  probe: (() => number) | null = null;
  private readonly v = new THREE.Vector3();

  /** How far a layer is lifted now, metres. */
  liftOf(layer: string): number {
    return (this.lifts.get(layer) ?? 0) * this.progress;
  }

  attach(o: THREE.Object3D, layer: string): void {
    this.objects.set(o, layer);
    o.position.z = this.liftOf(layer);
  }

  detach(o: THREE.Object3D): void {
    this.objects.delete(o);
  }

  /** Move every attached object to its layer's lift. */
  apply(): void {
    for (const [o, layer] of this.objects) {
      const z = this.liftOf(layer);
      if (o.position.z !== z) {
        o.position.z = z;
        o.updateMatrixWorld();
      }
    }
  }

  /** A point in the view's frame on screen: CSS pixels within the canvas, and whether it is in front of the camera. */
  project(p: Vec3): { x: number; y: number; front: boolean } {
    const cam = this.camera;
    if (cam === null) return { x: 0, y: 0, front: false };
    const v = this.v.set(p[0], p[1], p[2]).project(cam);
    return { x: ((v.x + 1) / 2) * this.size.width, y: ((1 - v.y) / 2) * this.size.height, front: v.z < 1 && v.z > -1 };
  }

  /** The pointer's ray through the camera, from a point in CSS pixels within the canvas. */
  ray(x: number, y: number): { origin: Vec3; dir: Vec3 } | null {
    const cam = this.camera;
    if (cam === null) return null;
    const r = new THREE.Raycaster();
    r.setFromCamera(new THREE.Vector2((x / this.size.width) * 2 - 1, 1 - (y / this.size.height) * 2), cam);
    return { origin: [r.ray.origin.x, r.ray.origin.y, r.ray.origin.z], dir: [r.ray.direction.x, r.ray.direction.y, r.ray.direction.z] };
  }

  /** The eye: where the camera stands (for an orthographic camera, far back along its axis). */
  eye(): Vec3 {
    const cam = this.camera;
    if (cam === null) return [0, 0, 0];
    return [cam.position.x, cam.position.y, cam.position.z];
  }
}
