import { useEffect, useSyncExternalStore } from 'react';
import { messageOf } from '../../../lib/api';
import type { EditorStore } from '../../store';

/**
 * Walk it in VR (FLR-T-14.3): the editor's VR state, beside the 3D view's and like it one per editor.
 * Whether this browser offers an immersive VR session at all (the "Enter VR" pill shows only when it
 * does — no dead button), the panel's choices — where to start, the eye height, the comfort options —
 * and, while a session runs, the session itself and where in the house the person is. View state:
 * VR is read-only, and nothing here is written to the document.
 */

export interface XrState {
  /** `navigator.xr.isSessionSupported('immersive-vr')`; null until it has answered. */
  supported: boolean | null;
  /** The "Walk it in VR" panel is open over the 3D view. */
  open: boolean;
  /** Asked for and not yet given. */
  starting: boolean;
  session: XRSession | null;
  /** Where to start: a room's ID, or null for where the walkthrough starts (the entry). */
  start: string | null;
  /** The eye height: the headset's own (standing), or seated, lifted to the walkthrough's eye height. */
  seated: boolean;
  /** Snap turn 30°, or a smooth turn. */
  snap: boolean;
  /** Comfort: fade through dark on a teleport, and a vignette while turning smoothly. */
  vignette: boolean;
  /** The roofs drawn in the headset (the wrist menu's switch). */
  roofs: boolean;
  /** Where the person is, while a session runs: the level and the room (IDs). */
  level: string | null;
  room: string | null;
  /** A level asked for from the screen beside the headset (the 2D page's overlay), until the headset takes it. */
  goTo: string | null;
  error: string | null;
}

const INITIAL: XrState = { supported: null, open: false, starting: false, session: null, start: null, seated: false, snap: true, vignette: true, roofs: true, level: null, room: null, goTo: null, error: null };

export class XrStore {
  private state: XrState = INITIAL;
  private readonly listeners = new Set<() => void>();

  get = (): XrState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  set(patch: Partial<XrState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }
}

const stores = new WeakMap<EditorStore, XrStore>();

export function xrOf(store: EditorStore): XrStore {
  let x = stores.get(store);
  if (x === undefined) {
    x = new XrStore();
    stores.set(store, x);
  }
  return x;
}

export function useXr<T>(store: EditorStore, selector: (s: XrState) => T): T {
  const x = xrOf(store);
  return useSyncExternalStore(x.subscribe, () => selector(x.get()), () => selector(x.get()));
}

/** The optional features a VR walk asks for: a floor-level space, a room's bounds, and hands. */
export const SESSION_FEATURES = ['local-floor', 'bounded-floor', 'hand-tracking'];

/**
 * Whether this browser offers immersive VR, asked once and again when a headset is connected or
 * disconnected (`devicechange`): a desktop browser with no headset says no, and the pill never shows.
 */
export function useXrSupport(store: EditorStore): boolean {
  const x = xrOf(store);
  const supported = useXr(store, (s) => s.supported === true);
  useEffect(() => {
    const system = typeof navigator === 'undefined' ? undefined : navigator.xr;
    if (system === undefined) {
      x.set({ supported: false });
      return;
    }
    let live = true;
    const ask = () => {
      system.isSessionSupported('immersive-vr').then(
        (yes) => { if (live) x.set({ supported: yes }); },
        () => { if (live) x.set({ supported: false }); },
      );
    };
    ask();
    system.addEventListener('devicechange', ask);
    return () => {
      live = false;
      system.removeEventListener('devicechange', ask);
    };
  }, [x]);
  return supported;
}

/**
 * Ask for an immersive VR session. Called from the click itself — a browser gives a session only to a
 * person's gesture — and the 3D view takes the session up from the store.
 */
export function enterVr(store: EditorStore): void {
  const x = xrOf(store);
  const system = navigator.xr;
  if (system === undefined || x.get().session !== null || x.get().starting) return;
  x.set({ starting: true, error: null });
  system.requestSession('immersive-vr', { optionalFeatures: SESSION_FEATURES }).then(
    (session) => {
      session.addEventListener('end', () => { x.set({ session: null, level: null, room: null, goTo: null }); });
      x.set({ session, starting: false, open: false });
    },
    (caught: unknown) => { x.set({ starting: false, error: `The headset did not start: ${messageOf(caught)}` }); },
  );
}

/** End the session: the headset goes back to the browser, the 3D view to the orbit it had. */
export function exitVr(store: EditorStore): void {
  const session = xrOf(store).get().session;
  if (session !== null) void session.end().catch(() => undefined);
}
