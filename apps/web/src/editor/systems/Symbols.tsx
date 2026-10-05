import type { ReactNode } from 'react';
import type { Derived, FloorspecDocument } from '@floorspec/engine';
import type { Layers, Viewport } from '../store';
import type { LevelView, Point, Ring } from '../model';
import { toScreen } from '../viewport';
import { asGlyph, glyphCentre, GLYPH_R, visible } from './hit';
import { anchorOf, facingVector, recordsOf, type DeviceView } from './view';
import { angleOf, type DeviceHover } from './placement';
import { membersFor, systemOfExtension, type DeviceKind, type ReceptacleOptions } from './catalog';
import { compareIds } from './view';

/**
 * The building systems on the plan (FLR-T-5.7): each device as its symbol — a receptacle's circle
 * and slots, a switch's S, a light's ⊗, a fixture's outline — circuits' home runs as dashed lines
 * from their panel, and clearance envelopes when that layer is on. With "Show as core-only" every
 * element is drawn as a reader without its extension draws it: its fallback box and nothing else
 * (Core 1.6.9, 12.6). Every colour is a token (editor.css); everything here is aria-hidden, the
 * inspector and the tree being where it is read.
 */

type Json = Record<string, unknown>;

const S = (v: Viewport, p: Point) => toScreen(v, p);
const pts = (v: Viewport, ring: Ring) => ring.map((p) => S(v, p).map((n) => n.toFixed(1)).join(',')).join(' ');
const f1 = (n: number) => n.toFixed(1);

/** A point in a device's frame, in plan: its placement's origin, forward and to the left (Core 13.1). */
function frameOf(d: DeviceView): (x: number, y: number) => Point {
  const o = d.placement?.point ?? [0, 0];
  const u = d.placement === null ? ([1, 0] as Point) : facingVector(d.placement.facing);
  return (x, y) => [o[0] + x * u[0] - y * u[1], o[1] + x * u[1] + y * u[0]];
}

const boxOf = (d: DeviceView): { min: number[]; max: number[] } | null => {
  const b = (d.element['fallback'] as Json | undefined)?.['box'] as { min: number[]; max: number[] } | undefined;
  return b !== undefined && Array.isArray(b.min) && Array.isArray(b.max) ? b : null;
};

/** An ellipse in a device's frame, as a ring of plan points. */
function ellipse(at: (x: number, y: number) => Point, cx: number, cy: number, rx: number, ry: number, n = 20): Point[] {
  return Array.from({ length: n }, (_, i) => at(cx + rx * Math.cos((2 * Math.PI * i) / n), cy + ry * Math.sin((2 * Math.PI * i) / n)));
}

const SWITCH_TEXT: Record<string, string> = { single: 'S', threeWay: 'S3', fourWay: 'S4', dimmer: 'SD', timer: 'ST', occupancy: 'SO', smart: 'S' };
const ABBREVIATION: Partial<Record<string, string>> = {
  furnace: 'F', airHandler: 'AH', heatPump: 'HP', airConditioner: 'AC', boiler: 'B', miniSplit: 'MS', fanCoil: 'FC', erv: 'ERV', hrv: 'HRV', dehumidifier: 'DH', humidifier: 'H',
};

/** A device drawn as a small glyph, centred in front of its face. */
function Glyph({ view, d, className }: { view: Viewport; d: DeviceView; className: string }) {
  const c = S(view, glyphCentre(d, view.s));
  const [x, y] = c;
  const r = GLYPH_R;
  const symbol = d.kind?.symbol;
  const facing = d.placement === null ? 0 : (d.placement.facing / 1_000_000) * (Math.PI / 180);
  // Along the wall, in screen space (y down).
  const tx = -Math.sin(facing);
  const ty = -Math.cos(facing);
  const parts: ReactNode[] = [];
  const text = (t: string, size = 9) => (
    <text key="t" className="fs-sym__text" x={f1(x)} y={f1(y + size * 0.36)} textAnchor="middle" fontSize={size}>
      {t}
    </text>
  );
  switch (symbol) {
    case 'receptacle': {
      parts.push(<circle key="c" cx={x} cy={y} r={r} />);
      const v240 = d.element['volts'] === 240;
      for (const k of v240 ? [-3, 0, 3] : [-2.5, 2.5])
        parts.push(<line key={`s${String(k)}`} className="fs-sym__mark" x1={f1(x + tx * k - ty * 2.5)} y1={f1(y + ty * k + tx * 2.5)} x2={f1(x + tx * k + ty * 2.5)} y2={f1(y + ty * k - tx * 2.5)} />);
      const features = Array.isArray(d.element['features']) ? (d.element['features'] as string[]) : [];
      if (features.includes('gfci')) parts.push(<text key="g" className="fs-sym__tag" x={f1(x + r + 2)} y={f1(y - r + 2)} fontSize={8}>G</text>);
      break;
    }
    case 'switch':
      parts.push(text(SWITCH_TEXT[typeof d.element['control'] === 'string' ? d.element['control'] : 'single'] ?? 'S', 10));
      break;
    case 'light':
      parts.push(<circle key="c" cx={x} cy={y} r={r} />, <line key="a" className="fs-sym__mark" x1={x - r * 0.7} y1={y - r * 0.7} x2={x + r * 0.7} y2={y + r * 0.7} />, <line key="b" className="fs-sym__mark" x1={x - r * 0.7} y1={y + r * 0.7} x2={x + r * 0.7} y2={y - r * 0.7} />);
      break;
    case 'alarm':
      parts.push(<circle key="c" cx={x} cy={y} r={r} />, <circle key="i" cx={x} cy={y} r={r * 0.45} />);
      break;
    case 'data':
      parts.push(<path key="p" d={`M${f1(x)},${f1(y - r)}L${f1(x + r)},${f1(y + r * 0.75)}L${f1(x - r)},${f1(y + r * 0.75)}Z`} />);
      break;
    case 'panel':
    case 'headEnd':
      parts.push(<rect key="r" className="fs-sym__solid" x={x - r} y={y - r * 0.6} width={r * 2} height={r * 1.2} />);
      break;
    default: {
      const label =
        symbol === 'ev' ? 'EV' : symbol === 'toilet' ? 'WC' : symbol === 'basin' ? 'L' : symbol === 'shower' ? 'SH' : symbol === 'tub' ? 'T' : symbol === 'heater' ? 'WH'
          : symbol === 'drain' ? 'FD' : symbol === 'equipment' ? (ABBREVIATION[String(d.element['equipment'])] ?? 'M') : symbol === 'supply' ? 'SR' : symbol === 'return' ? 'RG'
            : symbol === 'exhaust' ? 'EF' : symbol === 'range' ? 'R' : '?';
      parts.push(<rect key="r" x={x - r} y={y - r} width={r * 2} height={r * 2} rx={2} />, text(label, label.length > 2 ? 6 : 7.5));
    }
  }
  return <g className={className}>{parts}</g>;
}

/** A device drawn by its outline, with the detail its kind has in plan. */
function Outlined({ view, d, className }: { view: Viewport; d: DeviceView; className: string }) {
  const b = boxOf(d);
  const at = frameOf(d);
  const symbol = d.kind?.symbol;
  const parts: ReactNode[] = [<polygon key="o" points={pts(view, d.footprint)} />];
  if (b !== null) {
    const [x0, y0] = [b.min[0] ?? 0, b.min[1] ?? 0];
    const [x1, y1] = [b.max[0] ?? 0, b.max[1] ?? 0];
    const dx = x1 - x0;
    const dy = y1 - y0;
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const ring = (r: Point[], key: string, cls = 'fs-sym__mark') => parts.push(<polygon key={key} className={cls} points={pts(view, r)} />);
    const line = (a: Point, c: Point, key: string) => {
      const A = S(view, a);
      const C = S(view, c);
      parts.push(<line key={key} className="fs-sym__mark" x1={f1(A[0])} y1={f1(A[1])} x2={f1(C[0])} y2={f1(C[1])} />);
    };
    const label = (t: string) => {
      const p = S(view, at(cx, cy));
      parts.push(<text key="l" className="fs-sym__text" x={f1(p[0])} y={f1(p[1] + 3.5)} textAnchor="middle" fontSize={9}>{t}</text>);
    };
    switch (symbol) {
      case 'toilet':
        ring([at(x0, y0 + dy * 0.1), at(x0 + dx * 0.25, y0 + dy * 0.1), at(x0 + dx * 0.25, y1 - dy * 0.1), at(x0, y1 - dy * 0.1)], 'tank');
        ring(ellipse(at, x0 + dx * 0.62, cy, dx * 0.34, dy * 0.4), 'bowl');
        break;
      case 'basin':
        ring(ellipse(at, x0 + dx * 0.55, cy, dx * 0.32, dy * 0.36), 'bowl');
        break;
      case 'tub':
        ring([at(x0 + dx * 0.1, y0 + dy * 0.06), at(x1 - dx * 0.1, y0 + dy * 0.06), at(x1 - dx * 0.1, y1 - dy * 0.06), at(x0 + dx * 0.1, y1 - dy * 0.06)], 'inner');
        break;
      case 'shower':
        line(at(x0, y0), at(x1, y1), 'a');
        line(at(x0, y1), at(x1, y0), 'b');
        break;
      case 'heater':
        ring(ellipse(at, cx, cy, dx * 0.42, dy * 0.42), 'tank');
        label('WH');
        break;
      case 'drain':
        line(at(x0, cy), at(x1, cy), 'a');
        line(at(cx, y0), at(cx, y1), 'b');
        break;
      case 'supply':
      case 'return':
        for (let i = 1; i < 4; i++) line(at(x0 + (dx * i) / 4, y0), at(x0 + (dx * i) / 4, y1), `g${String(i)}`);
        break;
      case 'exhaust':
        ring(ellipse(at, cx, cy, dx * 0.4, dy * 0.4), 'fan');
        label('EF');
        break;
      case 'range':
        for (const [i, j] of [[0.3, 0.27], [0.3, 0.73], [0.7, 0.27], [0.7, 0.73]] as const) ring(ellipse(at, x0 + dx * i, y0 + dy * j, dx * 0.13, dy * 0.13, 12), `b${String(i)}${String(j)}`);
        break;
      case 'equipment':
        label(ABBREVIATION[String(d.element['equipment'])] ?? 'M');
        break;
      case 'panel':
      case 'headEnd':
      case 'ev':
        parts[0] = <polygon key="o" className="fs-sym__solid" points={pts(view, d.footprint)} />;
        break;
      default:
        break;
    }
  }
  return <g className={className}>{parts}</g>;
}

export function DeviceShape({ view, d, className = 'fs-sym' }: { view: Viewport; d: DeviceView; className?: string }) {
  return asGlyph(d, view.s) ? <Glyph view={view} d={d} className={className} /> : <Outlined view={view} d={d} className={className} />;
}

/** Circuit colours: the categorical tones the design system has, in turn. */
export const RUN_TONES = 6;

/** Each circuit's home run on this level: from its panel through its loads, nearest next. */
export function homeRuns(document: FloorspecDocument, level: LevelView): { circuit: string; tone: number; points: Point[] }[] {
  const devices = new Map(level.devices.map((d) => [d.id, d]));
  const out: { circuit: string; tone: number; points: Point[] }[] = [];
  recordsOf(document, 'FS_electrical', 'circuits').forEach(([cid, c], index) => {
    const panel = typeof c['panel'] === 'string' ? devices.get(c['panel']) : undefined;
    if (panel === undefined) return;
    const left = (Array.isArray(c['loads']) ? (c['loads'] as string[]) : []).map((l) => devices.get(l)).filter((d): d is DeviceView => d !== undefined);
    const points: Point[] = [anchorOf(panel)];
    while (left.length > 0) {
      const last = points[points.length - 1] as Point;
      let k = 0;
      for (let i = 1; i < left.length; i++) if (Math.hypot(anchorOf(left[i] as DeviceView)[0] - last[0], anchorOf(left[i] as DeviceView)[1] - last[1]) < Math.hypot(anchorOf(left[k] as DeviceView)[0] - last[0], anchorOf(left[k] as DeviceView)[1] - last[1])) k = i;
      points.push(anchorOf(left.splice(k, 1)[0] as DeviceView));
    }
    if (points.length > 1) out.push({ circuit: cid, tone: (index % RUN_TONES) + 1, points });
  });
  return out.sort((a, b) => compareIds(a.circuit, b.circuit));
}

/** The systems layer: clearances, home runs, devices, and panel callouts. */
export function SystemsLayer({ view, level, document, derived, layers, selection }: { view: Viewport; level: LevelView; document: FloorspecDocument; derived: Derived | null; layers: Layers; selection: string | null }) {
  const shown = level.devices.filter((d) => visible(d, layers));
  if (layers.coreOnly) {
    return (
      <g className="fs-systems fs-systems--core" aria-hidden="true">
        {shown.map((d) => <polygon key={d.id} className="fs-fallback" points={pts(view, d.footprint)} />)}
      </g>
    );
  }
  const overlapping = new Set((derived?.clearanceOverlaps ?? []).flatMap(([a, b]) => [`${a[0]}/${a[1]}`, `${b[0]}/${b[1]}`]));
  const runs = layers.electrical ? homeRuns(document, level) : [];
  const selectedCircuit = selection !== null && runs.some((r) => r.circuit === selection) ? selection : null;
  return (
    <g className="fs-systems" aria-hidden="true">
      {layers.clearances ? (
        <g className="fs-clearances">
          {shown.flatMap((d) => d.clearances.map((c) => <polygon key={`${d.id}/${c.name}`} className={overlapping.has(`${d.id}/${c.name}`) ? 'fs-clearance fs-clearance--overlap' : 'fs-clearance'} points={pts(view, c.ring)} />))}
          {Object.entries(derived?.clearances ?? {})
            .filter(([owner]) => level.openings.some((o) => o.id === owner))
            .flatMap(([owner, envs]) => Object.entries(envs).map(([name, c]) => <polygon key={`${owner}/${name}`} className={overlapping.has(`${owner}/${name}`) ? 'fs-clearance fs-clearance--overlap' : 'fs-clearance'} points={pts(view, c.footprint)} />))}
        </g>
      ) : null}
      <g className="fs-runs">
        {runs.map((r) => (
          <polyline key={r.circuit} className={`fs-run fs-run--${String(r.tone)}${selectedCircuit === r.circuit ? ' is-selected' : ''}`} points={r.points.map((p) => S(view, p).map(f1).join(',')).join(' ')} />
        ))}
      </g>
      {/* FS_furniture draws its own items, with their plan symbols (furniture/Plan.tsx). */}
      {shown.filter((d) => d.extension !== 'FS_furniture').map((d) => <DeviceShape key={d.id} view={view} d={d} className={`fs-sym fs-sym--${d.system ?? 'other'}`} />)}
      {layers.electrical ? <PanelCallouts view={view} level={level} /> : null}
    </g>
  );
}

function PanelCallouts({ view, level }: { view: Viewport; level: LevelView }) {
  return (
    <g className="fs-callouts">
      {level.devices
        .filter((d) => d.extension === 'FS_electrical' && d.collection === 'panels')
        .map((d) => {
          const p = S(view, glyphCentre(d, view.s));
          const text = `${typeof d.element['name'] === 'string' ? d.element['name'] : d.id} · ${typeof d.element['rating'] === 'number' ? String(d.element['rating']) : '—'} A`;
          const w = text.length * 6.2 + 12;
          return (
            <g key={d.id}>
              <rect className="fs-callout-tag" x={p[0] - w / 2} y={p[1] - 30} width={w} height={18} rx={4} />
              <text className="fs-callout-tag__text" x={p[0]} y={p[1] - 17.5} textAnchor="middle">
                {text}
              </text>
            </g>
          );
        })}
    </g>
  );
}

/** The device tool's ghost: what would be placed, where, drawn as the device will be. */
export function DeviceGhost({ view, level, hover, kind, receptacle }: { view: Viewport; level: string; hover: DeviceHover; kind: DeviceKind; receptacle: ReceptacleOptions }) {
  const facing = angleOf(hover.facing);
  const u = facingVector(facing);
  const at = (x: number, y: number): Point => [hover.point[0] + x * u[0] - y * u[1], hover.point[1] + x * u[1] + y * u[0]];
  const b = kind.box;
  const footprint: Point[] = [at(b.min[0], b.min[1]), at(b.max[0], b.min[1]), at(b.max[0], b.max[1]), at(b.min[0], b.max[1])];
  const d: DeviceView = {
    id: '~ghost',
    extension: kind.extension,
    collection: kind.collection,
    system: systemOfExtension(kind.extension),
    kind,
    kindLabel: kind.label,
    element: { ...membersFor(kind, receptacle), fallback: { box: b } },
    level,
    footprint,
    bottom: 0,
    top: 0,
    placement: { point: hover.point, z: 0, facing },
    host: { mode: hover.host.mode },
    clearances: [],
  };
  return <DeviceShape view={view} d={d} className={hover.problem === undefined ? 'fs-sym fs-sym--ghost' : 'fs-sym fs-sym--ghost fs-sym--bad'} />;
}

/** A device's highlight: a ring around its glyph, or its outline. */
export function DeviceOutline({ view, d, className }: { view: Viewport; d: DeviceView; className: string }) {
  if (asGlyph(d, view.s)) {
    const p = S(view, glyphCentre(d, view.s));
    return <circle className={className} cx={p[0]} cy={p[1]} r={GLYPH_R + 4} />;
  }
  return <polygon className={className} points={pts(view, d.footprint)} />;
}
