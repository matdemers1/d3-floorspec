import './tour.css';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { AuthLayout, EmptyState, IconButton, SegmentedControl, Spinner, useTheme, useToast } from '@d3cloud/ui';
import { ArrowUp, Hand, Map as MapIcon, Rotate3d, Share, X } from 'lucide-react';
import type { TourLevel, TourManifest, TourRoom } from '@floorspec/mesh';
import { fetchTour, tourFile, type TourAnswer } from './api';
import { Panorama } from './panorama';
import { clampLook, dragged, FOV_DEFAULT, fromOrientation, onScreen, PITCH_DEFAULT, type Look } from './view';

/**
 * `/s/<token>/tour` — a virtual tour, walked (FLR-T-14.2; the board's "14.2 · Tour viewer — phone, in
 * the kitchen", "the plan sheet" and "light theme"). For anybody with the link, no account: the room's
 * panorama, dragged (or the phone turned) to look around, pinched or scrolled to zoom, the arrow keys
 * on a computer; a hotspot at each doorway — a button named for the room it leads to — that walks
 * there, still facing the way you were going; the room's name and its place in the tour; a map of the
 * level with you on it and the way you face; and the plan sheet, every toured room a tap away. Each
 * panorama is fetched when it is first wanted, and its neighbours just after.
 */

type Phase = { status: 'loading' } | TourAnswer;

export default function TourViewer({ token }: { token: string }) {
  const [phase, setPhase] = useState<Phase>({ status: 'loading' });

  useEffect(() => {
    let live = true;
    let timer = 0;
    const look = () => {
      void fetchTour(token).then((answer) => {
        if (!live) return;
        setPhase(answer);
        // Being made: asked again now and then, until it is.
        if (answer.status === 'ok' && (answer.tour.status === 'queued' || answer.tour.status === 'rendering')) timer = window.setTimeout(look, 3000);
      });
    };
    look();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [token]);

  if (phase.status === 'loading') return <Spinner label="Opening the tour" />;
  if (phase.status === 'missing') return <Notice heading="This link does not open a tour">It may have been mistyped, or the tour it named is not shared any more.</Notice>;
  if (phase.status === 'gone') return <Notice heading={phase.reason === 'expired' ? 'This tour’s link has expired' : 'This tour’s link was revoked'}>Ask whoever shared it for a new link.</Notice>;
  if (phase.status === 'failed') return <Notice heading="The tour did not open">{phase.message}</Notice>;
  const tour = phase.tour;
  if (tour.status === 'failed') return <Notice heading={tour.cancelled ? 'This tour was cancelled' : 'This tour was not made'}>Ask whoever shared it to render it again.</Notice>;
  if (tour.status !== 'done') {
    return (
      <AuthLayout title="The tour is being made" description={`${String(tour.panos)} rooms, path-traced one after another. This page opens the tour as soon as it is ready.`}>
        <div className="fs-tour-wait" role="status" aria-live="polite">
          <progress className="fs-tour-wait__bar" max={Math.max(1, tour.panos)} value={tour.done} aria-label="Panoramas made" />
          <span>{tour.status === 'queued' ? 'Waiting for the renderer' : `Panorama ${String(Math.min(tour.panos, tour.done + 1))} of ${String(tour.panos)}`}</span>
        </div>
      </AuthLayout>
    );
  }
  const first = tour.manifest.rooms.find((r) => r.id === tour.manifest.start) ?? tour.manifest.rooms[0];
  if (first === undefined) return <Notice heading="This tour has no rooms">Ask whoever shared it to render it again.</Notice>;
  return <Walk token={token} manifest={tour.manifest} first={first} />;
}

function Notice({ heading, children }: { heading: string; children: string }) {
  return (
    <div className="fs-tour-notice">
      <EmptyState kind="error" heading={heading}>
        {children}
      </EmptyState>
    </div>
  );
}

/** The panoramas fetched so far, by file. */
function usePanoramas(token: string) {
  const cache = useRef(new Map<string, Promise<HTMLImageElement>>());
  return useCallback(
    (path: string): Promise<HTMLImageElement> => {
      let got = cache.current.get(path);
      if (got === undefined) {
        const img = new Image();
        img.decoding = 'async';
        img.src = tourFile(token, path);
        got = img.decode().then(() => img);
        got.catch(() => { cache.current.delete(path); });
        cache.current.set(path, got);
      }
      return got;
    },
    [token],
  );
}

function roomFromHash(manifest: TourManifest): string {
  const want = decodeURIComponent(window.location.hash.replace(/^#/, ''));
  return manifest.rooms.some((r) => r.id === want) ? want : manifest.start;
}

function Walk({ token, manifest, first }: { token: string; manifest: TourManifest; first: TourRoom }) {
  const toast = useToast();
  const { resolved } = useTheme();
  const rooms = manifest.rooms;
  const [roomId, setRoomId] = useState(() => roomFromHash(manifest));
  const room = rooms.find((r) => r.id === roomId) ?? first;
  const [look, setLook] = useState<Look>(() => ({ yaw: room.heading, pitch: PITCH_DEFAULT, fov: FOV_DEFAULT }));
  const [shown, setShown] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [sheet, setSheet] = useState(false);
  const [hint, setHint] = useState(true);
  const [gyro, setGyro] = useState(false);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const surface = useRef<HTMLDivElement | null>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const pano = useRef<Panorama | null>(null);
  const mapButton = useRef<HTMLButtonElement | null>(null);
  const panorama = usePanoramas(token);
  const levels = new Map(manifest.levels.map((l) => [l.id, l]));
  const level = levels.get(room.level);
  const index = rooms.findIndex((r) => r.id === room.id) + 1;

  // The canvas: WebGL, at the device's pixels (at most two a CSS pixel).
  useEffect(() => {
    const c = canvas.current;
    if (c === null) return;
    try {
      pano.current = Panorama.on(c);
    } catch {
      pano.current = null;
    }
    if (pano.current === null) setFailed('This browser cannot draw the panorama (it has no WebGL).');
    const ro = new ResizeObserver(() => {
      const box = surface.current?.getBoundingClientRect();
      if (box !== undefined) setSize({ width: Math.round(box.width), height: Math.round(box.height) });
    });
    if (surface.current !== null) ro.observe(surface.current);
    return () => {
      ro.disconnect();
      pano.current?.dispose();
      pano.current = null;
    };
  }, []);

  // The room's panorama, fetched (once) and shown; then its neighbours, ahead of a tap.
  useEffect(() => {
    let live = true;
    panorama(room.pano)
      .then((img) => {
        if (!live || pano.current === null) return;
        pano.current.show(img);
        setShown(room.id);
        for (const h of room.hotspots) {
          const next = rooms.find((r) => r.id === h.to);
          if (next !== undefined) void panorama(next.pano).catch(() => undefined);
        }
      })
      .catch(() => { if (live) setFailed(`The panorama of the ${room.name} did not load. Reload to try again.`); });
    window.history.replaceState(window.history.state, '', `#${encodeURIComponent(room.id)}`);
    return () => { live = false; };
  }, [room, rooms, panorama]);

  // Drawn whenever the view or the room changes.
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  useEffect(() => {
    const c = canvas.current;
    if (c === null || pano.current === null || size.width === 0) return;
    const w = Math.round(size.width * dpr);
    const h = Math.round(size.height * dpr);
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    const frame = requestAnimationFrame(() => { pano.current?.draw(look, w, h); });
    return () => { cancelAnimationFrame(frame); };
  }, [look, size, dpr, shown]);

  const walkTo = useCallback((to: TourRoom, heading?: number) => {
    setHint(false);
    setSheet(false);
    setRoomId(to.id);
    // Through a doorway: still facing the way you were walking. From the plan: the room's own heading.
    setLook((l) => clampLook({ yaw: heading ?? to.heading, pitch: PITCH_DEFAULT, fov: l.fov }));
  }, []);

  // Dragging, pinching and the wheel.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ distance: number; fov: number } | null>(null);
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button, a') !== null) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()] as [{ x: number; y: number }, { x: number; y: number }];
      pinch.current = { distance: Math.hypot(a.x - b.x, a.y - b.y), fov: look.fov };
    }
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const was = pointers.current.get(e.pointerId);
    if (was === undefined) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size >= 2 && pinch.current !== null) {
      const [a, b] = [...pointers.current.values()] as [{ x: number; y: number }, { x: number; y: number }];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const start = pinch.current;
      setLook((l) => clampLook({ ...l, fov: start.fov * (start.distance / Math.max(1, d)) }));
      return;
    }
    setHint(false);
    setGyro(false);
    setLook((l) => dragged(l, e.clientX - was.x, e.clientY - was.y, size.height));
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
  };
  useEffect(() => {
    const el = surface.current;
    if (el === null) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      setLook((l) => clampLook({ ...l, fov: l.fov * Math.exp(e.deltaY * 0.001) }));
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => { el.removeEventListener('wheel', wheel); };
  }, []);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 15 : 5;
    const turn: Record<string, Partial<Look>> = {
      ArrowLeft: { yaw: look.yaw - step },
      ArrowRight: { yaw: look.yaw + step },
      ArrowUp: { pitch: look.pitch + step },
      ArrowDown: { pitch: look.pitch - step },
      '+': { fov: look.fov / 1.15 },
      '=': { fov: look.fov / 1.15 },
      '-': { fov: look.fov * 1.15 },
    };
    const change = turn[e.key];
    if (change === undefined) return;
    e.preventDefault();
    setHint(false);
    setLook(clampLook({ ...look, ...change }));
  };

  // Turning the phone (FLR-T-14.2: gyro optional): asked for on a tap, as iOS requires.
  useEffect(() => {
    if (!gyro) return;
    let start: { alpha: number; yaw: number } | null = null;
    const onTurn = (e: DeviceOrientationEvent) => {
      if (e.alpha === null || e.beta === null) return;
      const alpha = e.alpha;
      const beta = e.beta;
      setLook((l) => {
        start ??= { alpha, yaw: l.yaw };
        return fromOrientation(alpha, beta, start, l.fov);
      });
    };
    window.addEventListener('deviceorientation', onTurn);
    return () => { window.removeEventListener('deviceorientation', onTurn); };
  }, [gyro]);
  const toggleGyro = async () => {
    if (gyro) {
      setGyro(false);
      return;
    }
    const Orientation = (window as unknown as { DeviceOrientationEvent?: { requestPermission?: () => Promise<string> } }).DeviceOrientationEvent;
    if (Orientation === undefined || !('ontouchstart' in window)) {
      toast.show({ message: 'This device has no motion sensor: drag to look around.' });
      return;
    }
    try {
      if (typeof Orientation.requestPermission === 'function' && (await Orientation.requestPermission()) !== 'granted') {
        toast.show({ message: 'Motion was not allowed: drag to look around.' });
        return;
      }
    } catch {
      return;
    }
    setHint(false);
    setGyro(true);
  };

  const share = async () => {
    const url = `${window.location.origin}/s/${token}/tour`;
    const nav = navigator as Navigator & { share?: (data: { title: string; url: string }) => Promise<void> };
    if (typeof nav.share === 'function') {
      try {
        await nav.share({ title: `${manifest.project} — a virtual tour`, url });
        return;
      } catch {
        // Dismissed, or not allowed here: copy it instead.
      }
    }
    navigator.clipboard.writeText(url).then(
      () => { toast.show({ message: 'The tour’s link is copied.' }); },
      () => { toast.show({ message: url }); },
    );
  };

  const ready = shown === room.id;
  const spots = size.width === 0 || !ready ? [] : room.hotspots.map((h) => ({ h, at: onScreen(look, h, size.width, size.height) }));

  return (
    <main className="fs-tour" data-room={room.id} data-ready={ready} data-yaw={look.yaw.toFixed(1)} data-fov={look.fov.toFixed(1)}>
      <div
        ref={surface}
        className="fs-tour__surface"
        tabIndex={0}
        role="application"
        aria-roledescription="panorama"
        aria-label={`Panorama of the ${room.name}. Drag, or use the arrow keys, to look around; + and − zoom.`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
      >
        <canvas ref={canvas} className="fs-tour__canvas" aria-hidden="true" />
        {spots.map(({ h, at }) =>
          at === null ? null : (
            <div key={`${h.to}:${h.via}`} className="fs-tour-hotspot" style={{ left: `${String(at.x)}px`, top: `${String(at.y)}px` }}>
              <span className="fs-tour-hotspot__ring" aria-hidden="true" />
              <button type="button" className="fs-tour-hotspot__pill" aria-label={`Go to the ${h.label}`} onClick={() => { const to = rooms.find((r) => r.id === h.to); if (to !== undefined) walkTo(to, h.yaw); }}>
                <span className="fs-tour-hotspot__arrow" aria-hidden="true">
                  <ArrowUp />
                </span>
                {h.label}
              </button>
            </div>
          ),
        )}
        {!ready && failed === null ? (
          <div className="fs-tour__veil" role="status">
            <Spinner label={`Walking to the ${room.name}`} />
          </div>
        ) : null}
      </div>

      <header className="fs-tour-card">
        <div className="fs-tour-card__text">
          <h1 className="fs-tour-card__room">{room.name}</h1>
          <p className="fs-tour-card__where">{`${manifest.project} · ${level?.name ?? room.level} · ${String(index)} of ${String(rooms.length)}`}</p>
        </div>
        <IconButton label="Share the tour" icon={<Share />} variant="ghost" onClick={() => { void share(); }} />
      </header>

      {failed !== null ? (
        <p className="fs-tour-hint fs-tour-hint--problem" role="alert">
          {failed}
        </p>
      ) : hint ? (
        <p className="fs-tour-hint">
          <Hand aria-hidden="true" />
          Drag or turn your phone to look · tap a doorway
        </p>
      ) : null}

      {level === undefined ? null : (
        <MiniMap level={level} room={room} yaw={look.yaw} theme={resolved} token={token} buttonRef={mapButton} onOpen={() => { setSheet(true); }} />
      )}

      <div className="fs-tour-tools">
        <IconButton label={gyro ? 'Stop looking by turning the phone' : 'Look by turning your phone'} aria-pressed={gyro} icon={<Rotate3d />} variant="secondary" onClick={() => { void toggleGyro(); }} />
        <IconButton label="Open the plan" icon={<MapIcon />} variant="secondary" onClick={() => { setSheet(true); }} />
      </div>

      {sheet && level !== undefined ? <PlanSheet manifest={manifest} room={room} start={level} theme={resolved} token={token} onGo={(r) => { walkTo(r); }} onClose={() => { setSheet(false); }} /> : null}
    </main>
  );
}

/** Where a point (metres) is on a level's plan, in its SVG pixels. */
const onPlan = (level: TourLevel, p: readonly [number, number, number]) => ({ x: level.plan.frame.x0 + level.plan.frame.s * p[0], y: level.plan.frame.y0 - level.plan.frame.s * p[1] });

/** CSS pixels a plan's SVG pixel takes in the map: about thirteen metres across its width. */
const MAP_SCALE = 0.3;
const MAP_W = 150;
const MAP_H = 118;

function MiniMap({ level, room, yaw, theme, token, onOpen, buttonRef }: { level: TourLevel; room: TourRoom; yaw: number; theme: 'light' | 'dark'; token: string; onOpen: () => void; buttonRef: React.RefObject<HTMLButtonElement | null> }) {
  const at = onPlan(level, room.eye);
  const left = MAP_W / 2 - at.x * MAP_SCALE;
  const top = MAP_H / 2 - at.y * MAP_SCALE;
  return (
    <button ref={buttonRef} type="button" className="fs-tour-map" aria-label={`Map of the ${level.name}: you are in the ${room.name}. Open the plan.`} onClick={onOpen}>
      <img className="fs-tour-map__plan" alt="" src={tourFile(token, theme === 'dark' ? level.plan.dark : level.plan.light)} style={{ left: `${String(left)}px`, top: `${String(top)}px`, width: `${String(level.plan.width * MAP_SCALE)}px`, height: `${String(level.plan.height * MAP_SCALE)}px` }} draggable={false} />
      <svg className="fs-tour-map__you" viewBox="-40 -40 80 80" aria-hidden="true" data-heading={yaw.toFixed(0)}>
        <path className="fs-tour-map__cone" d="M0 0 L-17 -34 A38 38 0 0 1 17 -34 Z" transform={`rotate(${yaw.toFixed(2)})`} />
        <circle className="fs-tour-map__ring" r="7.5" />
        <circle className="fs-tour-map__dot" r="5" />
      </svg>
    </button>
  );
}

function PlanSheet({ manifest, room, start, theme, token, onGo, onClose }: { manifest: TourManifest; room: TourRoom; start: TourLevel; theme: 'light' | 'dark'; token: string; onGo: (room: TourRoom) => void; onClose: () => void }) {
  const [levelId, setLevelId] = useState(room.level);
  const level = manifest.levels.find((l) => l.id === levelId) ?? start;
  const here = manifest.rooms.filter((r) => r.level === level.id);
  const elsewhere = manifest.levels.filter((l) => l.id !== level.id).map((l) => ({ l, rooms: manifest.rooms.filter((r) => r.level === l.id) })).filter((x) => x.rooms.length > 0);
  const box = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const titleId = 'fs-tour-sheet-title';

  useEffect(() => {
    const el = box.current;
    if (el === null) return;
    const ro = new ResizeObserver(() => { setWidth(el.getBoundingClientRect().width); });
    ro.observe(el);
    return () => { ro.disconnect(); };
  }, []);
  // Focus into the sheet; Escape closes it.
  const sheet = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    sheet.current?.querySelector<HTMLElement>('[aria-current="true"], button')?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      before?.focus();
    };
  }, [onClose]);

  const k = width === 0 ? 0 : width / level.plan.width;
  const pins = useMemo(() => here.map((r) => ({ r, at: onPlan(level, r.eye) })), [here, level]);
  const facts = `Panoramas are ${String(manifest.width)} × ${String(manifest.height)}, path-traced on Jun 21 at 3:00 pm.`;

  return (
    <div className="fs-tour-sheet__scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={sheet} className="fs-tour-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <span className="fs-tour-sheet__handle" aria-hidden="true" />
        <div className="fs-tour-sheet__head">
          <h2 id={titleId} className="fs-tour-sheet__title">{manifest.project}</h2>
          {manifest.levels.length > 1 ? (
            <SegmentedControl aria-label="Level" size="sm" value={level.id} onValueChange={setLevelId} items={manifest.levels.map((l) => ({ value: l.id, label: l.name }))} />
          ) : null}
          <IconButton label="Close the plan" icon={<X />} size="sm" variant="ghost" onClick={onClose} />
        </div>
        <div ref={box} className="fs-tour-sheet__plan" style={{ height: `${String(level.plan.height * k)}px` }}>
          <img alt={`Plan of the ${level.name}`} src={tourFile(token, theme === 'dark' ? level.plan.dark : level.plan.light)} width={level.plan.width * k} height={level.plan.height * k} draggable={false} />
          {k === 0
            ? null
            : pins.map(({ r, at }) => (
                <button
                  key={r.id}
                  type="button"
                  className="fs-tour-pin"
                  aria-current={r.id === room.id}
                  tabIndex={-1}
                  aria-hidden="true"
                  style={{ left: `${String(at.x * k)}px`, top: `${String(at.y * k)}px` }}
                  onClick={() => { onGo(r); }}
                >
                  <span className="fs-tour-pin__dot" />
                  {r.name}
                </button>
              ))}
        </div>
        <nav aria-label={`Rooms on the ${level.name}`}>
          <ul className="fs-tour-chips">
            {here.map((r) => (
              <li key={r.id}>
                <button type="button" className="fs-tour-chip" aria-current={r.id === room.id} onClick={() => { onGo(r); }}>
                  {r.name}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <p className="fs-tour-sheet__note">
          {elsewhere.map((x) => `${x.l.name}: ${x.rooms.map((r) => r.name).join(', ')} — switch level above. `).join('')}
          {facts}
        </p>
      </div>
    </div>
  );
}
