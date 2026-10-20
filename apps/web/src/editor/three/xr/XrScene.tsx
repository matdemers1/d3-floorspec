import { useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { HouseMesh } from '@floorspec/mesh';
import { labelOf, type EditorModel } from '../../model';
import type { EditorStore } from '../../store';
import { threeOf } from '../mode';
import { roomAt, type World } from '../walk';
import { aim, levelAt, levelTarget, moveRig, NO_TELEPORT, rigPose, startOf, stickTurn, turnRig, type Rig, type TeleportCheck, type Vec3 } from './xr';
import { buttonAt, drawMenu, menuLayout, MENU_PX, MENU_WIDTH_M, type MenuAction, type MenuButton, type MenuColours } from './menu';
import { useXr, xrOf, type XrStore } from './state';

/**
 * The walk in the headset (FLR-T-14.3, the board's "In the headset" frame), inside the 3D view's
 * canvas while a WebXR session runs: three.js's own WebXR (`renderer.xr`), no other library.
 *
 * The house is the 3D view's, drawn as Draft draws it (the view drops Presentation, lamps and fresh
 * shadows while the headset shows it: a headset wants 72–90 frames a second). The headset's
 * reference space is put in the house by an offset (`rigPose`): standing on the floor where the walk
 * starts, at 1:1. Pull a trigger (or pinch — on Vision Pro, look and pinch) and an arc (a controller)
 * or a ray (a pointer) shows where you would land; let go on a floor and the view fades through dark
 * and you stand there. A stick turns you 30° a push. A menu at your side, re-placed as you go, names
 * where you are and switches level, the roofs, and exits; X/Y (or A/B) hides and shows it.
 */

const FADE_S = 0.15;
const HINT = 'Trigger or pinch · teleport   Stick · turn   Y · menu';
const AXIS = new THREE.Vector3(0, 0, -1);

export type XrColours = MenuColours;

/** The design system's colours, for the arc, the target and the menu: read where the view is. */
export function xrColours(): XrColours {
  const s = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => s.getPropertyValue(name).trim() || fallback;
  return {
    surface: v('--color-surface-raised', 'dimgray'),
    border: v('--color-border', 'gray'),
    fg: v('--color-fg', 'white'),
    muted: v('--color-fg-muted', 'silver'),
    accent: v('--color-accent', 'slateblue'),
    accentFg: v('--color-accent-contrast', 'white'),
    danger: v('--color-danger', 'crimson'),
  };
}

export function XrScene({ store, world, model, mesh }: { store: EditorStore; world: World; model: EditorModel; mesh: HouseMesh }) {
  const session = useXr(store, (s) => s.session);
  return session === null ? null : <XrSession session={session} store={store} world={world} model={model} mesh={mesh} />;
}

function XrSession({ session, store, world, model, mesh }: { session: XRSession; store: EditorStore; world: World; model: EditorModel; mesh: HouseMesh }) {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const driver = useMemo(() => new Driver(gl, scene, session, store, world, model, mesh), [gl, scene, session, store, world, model, mesh]);
  useEffect(() => driver.start(), [driver]);
  useFrame((_, dt, frame) => { driver.frame(dt, frame); });
  return null;
}

interface Hand {
  index: number;
  group: THREE.Group;
  source: XRInputSource | null;
  ray: THREE.Line;
  /** The stick has come back since its last snap; the menu button was down last frame. */
  armed: boolean;
  menuDown: boolean;
  /** The trigger went down on the menu: its release teleports nowhere. */
  onMenu: boolean;
}

class Driver {
  private rig: Rig;
  private base: XRReferenceSpace | null = null;
  private calibrate: boolean;
  private stopped = false;
  private ended = false;
  private head: Vec3;
  private headYaw: number;
  private readonly hands: Hand[] = [];
  private aiming: number | null = null;
  private check: TeleportCheck | null = null;
  private fade = 0;
  private fadeTo = 0;
  private then: (() => void) | null = null;
  private turning = false;
  private placeMenuNext = true;
  private readonly x: XrStore;
  private readonly colours = xrColours();
  private readonly objects: THREE.Object3D[] = [];
  private readonly arc: THREE.Points;
  private readonly ring: THREE.Mesh;
  private readonly veil: THREE.Mesh;
  private readonly veilUniforms = { uFade: { value: 0 }, uVignette: { value: 0 } };
  private readonly menu: { canvas: HTMLCanvasElement; texture: THREE.CanvasTexture; mesh: THREE.Mesh; buttons: MenuButton[]; hover: MenuAction | null; at: Vec3 | null; note: string };
  private readonly unsubscribe: (() => void)[] = [];

  constructor(
    private readonly gl: THREE.WebGLRenderer,
    private readonly scene: THREE.Scene,
    private readonly session: XRSession,
    private readonly store: EditorStore,
    private readonly world: World,
    private readonly model: EditorModel,
    mesh: HouseMesh,
  ) {
    this.x = xrOf(store);
    const st = this.x.get();
    const s = startOf(world, model, mesh, st.start, store.get().level) ?? { x: 0, y: 0, floor: world.base, yaw: 0 };
    this.rig = { x: s.x, y: s.y, floor: s.floor, yaw: s.yaw, lift: 0 };
    this.calibrate = st.seated;
    this.head = [s.x, s.y, s.floor + 1.6];
    this.headYaw = s.yaw;

    // The arc: dots along it, in the accent where it may land, muted where it may not.
    const dots = new THREE.BufferGeometry();
    dots.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3 * 256), 3));
    this.arc = new THREE.Points(dots, new THREE.PointsMaterial({ size: 0.035, sizeAttenuation: true, color: new THREE.Color(this.colours.accent), transparent: true, opacity: 0.95 }));
    this.arc.frustumCulled = false;
    this.arc.visible = false;
    // Where you would land: a ring on the floor.
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.2, 0.27, 48), new THREE.MeshBasicMaterial({ color: new THREE.Color(this.colours.accent), side: THREE.DoubleSide, transparent: true, opacity: 0.9, depthWrite: false }));
    this.ring.visible = false;
    // The comfort veil about the head: dark all over while a teleport fades, round the edge while turning smoothly.
    this.veil = new THREE.Mesh(
      new THREE.SphereGeometry(0.3, 24, 16),
      new THREE.ShaderMaterial({
        uniforms: this.veilUniforms,
        side: THREE.BackSide,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        vertexShader: 'varying vec3 vView; void main() { vec4 mv = modelViewMatrix * vec4(position, 1.0); vView = mv.xyz; gl_Position = projectionMatrix * mv; }',
        fragmentShader:
          'uniform float uFade; uniform float uVignette; varying vec3 vView; void main() { float off = 1.0 + normalize(vView).z; float a = max(uFade, uVignette * smoothstep(0.12, 0.4, off)); if (a <= 0.001) discard; gl_FragColor = vec4(0.0, 0.0, 0.0, a); }',
      }),
    );
    this.veil.renderOrder = 1000;
    this.veil.frustumCulled = false;
    // The menu: a canvas drawn as a panel at your side.
    const canvas = document.createElement('canvas');
    canvas.width = MENU_PX.width;
    canvas.height = 256;
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: texture, transparent: true, side: THREE.DoubleSide, depthWrite: false }));
    panel.renderOrder = 900;
    this.menu = { canvas, texture, mesh: panel, buttons: [], hover: null, at: null, note: HINT };
    this.objects.push(this.arc, this.ring, this.veil, panel);
  }

  /** Set the session going; the cleanup ends what this added. */
  start(): () => void {
    for (const o of this.objects) this.scene.add(o);
    for (const index of [0, 1]) {
      const group = this.gl.xr.getController(index);
      const ray = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1.5)]), new THREE.LineBasicMaterial({ color: new THREE.Color(this.colours.fg), transparent: true, opacity: 0.6 }));
      ray.visible = false;
      group.add(ray);
      this.scene.add(group);
      const hand: Hand = { index, group, source: null, ray, armed: true, menuDown: false, onMenu: false };
      this.hands.push(hand);
      // A controller's events carry its input source as `data`.
      const target = group as unknown as { addEventListener(type: string, fn: (e: { data?: XRInputSource }) => void): void; removeEventListener(type: string, fn: (e: { data?: XRInputSource }) => void): void };
      const on = (type: string, fn: (e: { data?: XRInputSource }) => void) => {
        target.addEventListener(type, fn);
        this.unsubscribe.push(() => { target.removeEventListener(type, fn); });
      };
      on('connected', (e) => { hand.source = e.data ?? null; });
      on('disconnected', () => { hand.source = null; hand.ray.visible = false; if (this.aiming === index) this.stopAiming(); });
      on('selectstart', (e) => { this.selectStart(hand, e.data ?? null); });
      on('selectend', () => { this.selectEnd(hand); });
    }
    this.unsubscribe.push(
      this.x.subscribe(() => {
        const st = this.x.get();
        if (st.goTo !== null) {
          const level = st.goTo;
          this.x.set({ goTo: null });
          this.press({ kind: 'level', level });
        }
        this.drawMenu();
      }),
    );
    const ended = () => { this.ended = true; };
    this.session.addEventListener('end', ended);
    this.unsubscribe.push(() => { this.session.removeEventListener('end', ended); });
    this.drawMenu();
    void this.connect();
    return () => { this.stop(); };
  }

  private async connect(): Promise<void> {
    const gl = this.gl;
    try {
      // A space whose origin is on the floor; failing that, one whose origin is the head, lifted to eye height.
      let type: XRReferenceSpaceType = 'local-floor';
      try {
        await this.session.requestReferenceSpace('local-floor');
      } catch {
        type = 'local';
        this.calibrate = true;
      }
      if (this.stopped) return;
      gl.xr.setReferenceSpaceType(type);
      gl.xr.setFoveation(1);
      await gl.xr.setSession(this.session);
      if (this.isStopped()) return;
      this.base = gl.xr.getReferenceSpace();
      this.apply();
      // The house does not move in VR: its shadows are drawn once, not twice a frame.
      gl.shadowMap.autoUpdate = false;
      gl.shadowMap.needsUpdate = true;
      this.locate();
    } catch (caught) {
      this.x.set({ error: `The headset could not show the house: ${caught instanceof Error ? caught.message : String(caught)}` });
      void this.session.end().catch(() => undefined);
    }
  }

  private isStopped(): boolean {
    return this.stopped;
  }

  private stop(): void {
    this.stopped = true;
    // The 3D view closed under the headset (back to the plan): the session ends with it.
    if (!this.ended) void this.session.end().catch(() => undefined);
    for (const u of this.unsubscribe) u();
    for (const h of this.hands) {
      h.group.remove(h.ray);
      h.ray.geometry.dispose();
      this.scene.remove(h.group);
    }
    for (const o of this.objects) this.scene.remove(o);
    for (const g of [this.arc.geometry, this.ring.geometry, this.veil.geometry, this.menu.mesh.geometry]) g.dispose();
    for (const m of [this.arc.material, this.ring.material, this.veil.material, this.menu.mesh.material]) (m as THREE.Material).dispose();
    this.menu.texture.dispose();
    this.gl.shadowMap.autoUpdate = true;
    this.gl.shadowMap.needsUpdate = true;
  }

  /** Put the headset's space where the rig says. */
  private apply(): void {
    if (this.base === null) return;
    const { position: p, orientation: q } = rigPose(this.rig);
    const pose = new XRRigidTransform({ x: p[0], y: p[1], z: p[2] }, { x: q[0], y: q[1], z: q[2], w: q[3] });
    this.gl.xr.setReferenceSpace(this.base.getOffsetReferenceSpace(pose.inverse));
  }

  frame(dt: number, frame: XRFrame | undefined): void {
    if (this.base === null || frame === undefined) return;
    const ref = this.gl.xr.getReferenceSpace();
    if (ref === null) return;
    const pose = frame.getViewerPose(ref);
    if (pose !== undefined) {
      const p = pose.transform.position;
      this.head = [p.x, p.y, p.z];
      const o = pose.transform.orientation;
      const ahead = AXIS.clone().applyQuaternion(new THREE.Quaternion(o.x, o.y, o.z, o.w));
      if (Math.hypot(ahead.x, ahead.y) > 1e-3) this.headYaw = Math.atan2(ahead.y, ahead.x);
    }
    // Seated, or a space with its origin at the head: lift it so the eye is at the walkthrough's eye height.
    if (this.calibrate) {
      const local = frame.getViewerPose(this.base);
      if (local === undefined) return;
      this.rig = { ...this.rig, lift: threeOf(this.store).get().eyeHeight - local.transform.position.y };
      this.calibrate = false;
      this.apply();
      this.placeMenuNext = true;
      return;
    }
    if (this.placeMenuNext) {
      this.placeMenuNext = false;
      this.placeMenu();
    }
    const st = this.x.get();
    // The sticks and buttons.
    let hover: MenuAction | null = null;
    this.turning = false;
    for (const h of this.hands) {
      const src = h.source;
      if (src === null) continue;
      const gp = src.gamepad;
      if (gp !== undefined) {
        const other = this.hands.find((o) => o !== h && o.source?.handedness === 'right');
        if (src.handedness !== 'left' || other === undefined) {
          const axis = gp.axes[2] ?? gp.axes[0] ?? 0;
          const t = stickTurn(axis, h.armed, st.snap, dt);
          h.armed = t.armed;
          if (!st.snap && Math.abs(axis) > 0.2) this.turning = true;
          if (t.delta !== 0) this.turn(t.delta);
        }
        const pressed = (gp.buttons[4]?.pressed ?? false) || (gp.buttons[5]?.pressed ?? false);
        if (pressed && !h.menuDown) this.toggleMenu();
        h.menuDown = pressed;
      }
      const { origin, direction } = this.rayOf(h);
      const pointer = src.targetRayMode === 'tracked-pointer';
      h.ray.visible = pointer && this.aiming !== h.index;
      if (hover === null && this.aiming !== h.index) hover = this.menuHit(origin, direction)?.action ?? null;
    }
    if (!sameAction(hover, this.menu.hover)) {
      this.menu.hover = hover;
      this.drawMenu();
    }
    // Aiming: the arc (or ray), and where it would land.
    if (this.aiming !== null) {
      const h = this.hands[this.aiming];
      if (h?.source === null || h === undefined) this.stopAiming();
      else {
        const { origin, direction } = this.rayOf(h);
        const r = aim(this.world, { x: this.head[0], y: this.head[1], feet: this.rig.floor }, [origin.x, origin.y, origin.z], [direction.x, direction.y, direction.z], h.source.targetRayMode === 'tracked-pointer');
        this.check = r.check;
        this.showArc(r.path.points, r.check);
        const note = r.check.ok ? HINT : NO_TELEPORT[r.check.reason];
        if (note !== this.menu.note) {
          this.menu.note = note;
          this.drawMenu();
        }
      }
    }
    // The veil: a teleport's fade, a smooth turn's vignette.
    const step = dt / FADE_S;
    this.fade = this.fadeTo > this.fade ? Math.min(this.fadeTo, this.fade + step) : Math.max(this.fadeTo, this.fade - step);
    if (this.fade >= 1 && this.then !== null) {
      const then = this.then;
      this.then = null;
      then();
    }
    this.veilUniforms.uFade.value = this.fade;
    this.veilUniforms.uVignette.value = st.vignette && this.turning ? 0.85 : 0;
    this.veil.position.set(this.head[0], this.head[1], this.head[2]);
    // The menu follows lazily: placed again once you have walked away from it.
    const at = this.menu.at;
    if (at !== null && Math.hypot(this.head[0] - at[0], this.head[1] - at[1]) > 1.5) this.placeMenu();
  }

  private rayOf(h: Hand): { origin: THREE.Vector3; direction: THREE.Vector3 } {
    h.group.updateMatrixWorld(true);
    const origin = h.group.getWorldPosition(new THREE.Vector3());
    const direction = AXIS.clone().applyQuaternion(h.group.getWorldQuaternion(new THREE.Quaternion()));
    return { origin, direction };
  }

  private selectStart(h: Hand, source: XRInputSource | null): void {
    if (source !== null) h.source = source;
    const { origin, direction } = this.rayOf(h);
    const hit = this.menuHit(origin, direction);
    if (hit !== null) {
      h.onMenu = true;
      this.press(hit.action);
      return;
    }
    h.onMenu = false;
    this.aiming = h.index;
    this.check = null;
  }

  private selectEnd(h: Hand): void {
    if (h.onMenu) {
      h.onMenu = false;
      return;
    }
    if (this.aiming !== h.index) return;
    const check = this.check;
    this.stopAiming();
    if (check?.ok === true) this.teleport({ x: check.x, y: check.y, floor: check.floor });
  }

  private stopAiming(): void {
    this.aiming = null;
    this.check = null;
    this.arc.visible = false;
    this.ring.visible = false;
    if (this.menu.note !== HINT) {
      this.menu.note = HINT;
      this.drawMenu();
    }
  }

  private showArc(points: readonly Vec3[], check: TeleportCheck): void {
    const attr = this.arc.geometry.getAttribute('position') as THREE.BufferAttribute;
    const max = attr.count;
    // Dots every few centimetres along the path.
    let n = 0;
    for (let i = 1; i < points.length && n < max; i++) {
      const a = points[i - 1];
      const b = points[i];
      if (a === undefined || b === undefined) continue;
      const k = Math.max(1, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / 0.12));
      for (let j = 0; j < k && n < max; j++, n++) attr.setXYZ(n, a[0] + ((b[0] - a[0]) * j) / k, a[1] + ((b[1] - a[1]) * j) / k, a[2] + ((b[2] - a[2]) * j) / k);
    }
    attr.needsUpdate = true;
    this.arc.geometry.setDrawRange(0, n);
    const colour = new THREE.Color(check.ok ? this.colours.accent : this.colours.muted);
    (this.arc.material as THREE.PointsMaterial).color.copy(colour);
    this.arc.visible = true;
    this.ring.visible = check.ok;
    if (check.ok) {
      (this.ring.material as THREE.MeshBasicMaterial).color.copy(colour);
      this.ring.position.set(check.x, check.y, check.floor + 0.01);
    }
  }

  /** Stand somewhere: through dark, with comfort on; at once with it off. */
  private teleport(to: { x: number; y: number; floor: number }): void {
    const go = () => {
      const eye = this.head[2] - this.rig.floor;
      this.rig = moveRig(this.rig, { x: this.head[0], y: this.head[1] }, to);
      this.head = [to.x, to.y, to.floor + eye];
      this.apply();
      this.locate(to);
      this.placeMenuNext = true;
    };
    if (this.x.get().vignette) {
      this.fadeTo = 1;
      this.then = () => {
        go();
        this.fadeTo = 0;
      };
    } else go();
  }

  private turn(delta: number): void {
    this.rig = turnRig(this.rig, { x: this.head[0], y: this.head[1] }, delta);
    this.headYaw += delta;
    this.apply();
    this.placeMenuNext = true;
  }

  /** Where you are, for the menu and the screen beside the headset. */
  private locate(at: { x: number; y: number; floor: number } = { x: this.head[0], y: this.head[1], floor: this.rig.floor }): void {
    const level = levelAt(this.world, { x: at.x, y: at.y, feet: at.floor });
    const room = roomAt(this.world, at.x, at.y, at.floor);
    this.x.set({ level, room: room?.id ?? null });
  }

  private press(action: MenuAction): void {
    if (action.kind === 'exit') {
      void this.session.end().catch(() => undefined);
      return;
    }
    if (action.kind === 'roofs') {
      this.x.set({ roofs: !this.x.get().roofs });
      return;
    }
    const t = levelTarget(this.world, action.level, { x: this.head[0], y: this.head[1] });
    if (t !== null) this.teleport(t);
  }

  private toggleMenu(): void {
    this.menu.mesh.visible = !this.menu.mesh.visible;
    if (this.menu.mesh.visible) this.placeMenu();
  }

  /** At your side: ahead and a little to the left, below the eye, turned to face you. */
  private placeMenu(): void {
    const [hx, hy, hz] = this.head;
    const fx = Math.cos(this.headYaw);
    const fy = Math.sin(this.headYaw);
    const x = hx + fx * 0.45 - fy * 0.2;
    const y = hy + fy * 0.45 + fx * 0.2;
    const z = Math.max(this.rig.floor + 0.6, hz - 0.4);
    const m = this.menu.mesh;
    m.position.set(x, y, z);
    m.up.set(0, 0, 1);
    m.lookAt(hx, hy, hz);
    this.menu.at = [hx, hy, hz];
  }

  private menuHit(origin: THREE.Vector3, direction: THREE.Vector3): MenuButton | null {
    const m = this.menu.mesh;
    if (!m.visible) return null;
    const ray = new THREE.Raycaster(origin, direction.clone().normalize(), 0, 3);
    const hit = ray.intersectObject(m, false)[0];
    if (hit?.uv === undefined) return null;
    return buttonAt(this.menu.buttons, hit.uv.x * MENU_PX.width, (1 - hit.uv.y) * this.menu.canvas.height);
  }

  private drawMenu(): void {
    const st = this.x.get();
    const ctx = this.menu.canvas.getContext('2d');
    if (ctx === null) return;
    const levels = [...this.world.levels].sort((a, b) => b.elevation - a.elevation);
    const levelName = levels.find((l) => l.id === st.level)?.name ?? '';
    const roomName = st.room === null ? null : labelOf(this.model, st.room);
    const model = { house: this.model.document.project.name, where: roomName === null ? levelName : `${roomName} · ${levelName}`, levels, current: st.level, roofs: st.roofs, note: this.menu.note };
    const height = menuLayout({ levels }).height;
    if (this.menu.canvas.height !== height) {
      this.menu.canvas.height = height;
      const ratio = height / MENU_PX.width;
      this.menu.mesh.scale.set(MENU_WIDTH_M, MENU_WIDTH_M * ratio, 1);
    }
    this.menu.buttons = drawMenu(ctx, model, this.colours, this.menu.hover).buttons;
    this.menu.texture.needsUpdate = true;
  }
}

function sameAction(a: MenuAction | null, b: MenuAction | null): boolean {
  if (a === null || b === null) return a === b;
  return a.kind === b.kind && (a.kind !== 'level' || (b.kind === 'level' && a.level === b.level));
}
