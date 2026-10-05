/**
 * The decompiler: a rectilinear Floorspec document → DSL text that compiles back to the same rooms.
 *
 * A document is rectilinear here when, on every level, each room's face is an axis-aligned
 * rectangle of wall location lines and the level's walls and separators are exactly the plane graph
 * of those rectangles — what the compiler draws. Rooms become rectangles placed by relations where
 * an edge of one meets an edge of another exactly (`east-of`, `aligned north`), and by `at` where none
 * does; separators become `open`, openings `door`/`window`/`opening` measured from a room corner,
 * the program `brief:` and `adjacent`/`near`/`apart`.
 *
 * What the DSL cannot say — materials, finishes, the site, joins, wall tops, extension elements —
 * is left out; geometry it cannot say is a DecompileError, never a silently different plan.
 */
import { evaluate } from '@floorspec/engine';
import { formatLength } from '@floorspec/ops';
import { DecompileError } from './diagnostics.js';
import { inferFunction, itemName, nameFromHandle } from './functions.js';
import { oriented, pieceKey, pieces, sideOfVector, type Piece, type Rect } from './layout.js';
import { KEYWORDS, type Side } from './syntax.js';

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const coll = (doc: Json, name: string): Record<string, Json> => (isObject(doc[name]) ? (doc[name] as Record<string, Json>) : {});
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const big = (v: unknown): bigint => BigInt(v as number);

/** A length the DSL parses back exactly: imperial to 1/256", else millimetres. */
export function formatExact(v: bigint): string {
  if (v === 0n) return '0';
  if (v % 127n === 0n) return formatLength(v, { denominator: 256 });
  return formatLength(v, { system: 'metric' });
}

const SQ_FT = 152_212_340_736n;
const SQ_MM = 1_638_400n;
/** An area the DSL parses back exactly: square feet when whole, else square millimetres (always a terminating decimal). */
export function formatArea(v: bigint): string {
  if (v % SQ_FT === 0n) return `${v / SQ_FT} sq ft`;
  const scaled = (v * 10n ** 16n) / SQ_MM;
  const whole = scaled / 10n ** 16n;
  const frac = (scaled % 10n ** 16n).toString().padStart(16, '0').replace(/0+$/, '');
  return `${whole}${frac === '' ? '' : `.${frac}`} mm2`;
}

const quote = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const size = (w: bigint, h: bigint): string => `${formatExact(w)} x ${formatExact(h)}`;

/** A handle for a name: lower case, words joined by `_`, starting with a letter, not a keyword, unique. */
function handles(): (name: string | undefined, fallback: string) => string {
  const used = new Set<string>();
  return (name, fallback) => {
    let h = (name ?? fallback)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
    if (h === '' || !/^[a-z_]/.test(h)) h = `r_${h || fallback.toLowerCase()}`;
    if (KEYWORDS.has(h)) h = `${h}_`;
    let out = h;
    for (let n = 2; used.has(out); n++) out = `${h}_${n}`;
    used.add(out);
    return out;
  };
}

interface Edge {
  readonly id: string;
  readonly separator: boolean;
  readonly start: readonly [bigint, bigint];
  readonly end: readonly [bigint, bigint];
  readonly piece: Pick<Piece, 'axis' | 'at' | 'lo' | 'hi'>;
}

/** The DSL text for a document. Throws DecompileError when its plan is not rectilinear as above. */
export function toDsl(input: string | Uint8Array | object): string {
  const ev = evaluate(input);
  if (!ev.valid || !ev.document) throw new DecompileError(`the document is not valid: ${ev.diagnostics.filter((d) => d.severity === 'error').map((d) => d.code).join(', ')}`);
  const doc = ev.document as unknown as Json;
  return new Decompiler(doc).run();
}

class Decompiler {
  private readonly out: string[] = [];
  private readonly levelHandle = new Map<string, string>();
  private readonly roomHandle = new Map<string, string>();
  private readonly itemHandle = new Map<string, string>();
  private readonly rects = new Map<string, Rect>();
  private readonly edges = new Map<string, Edge>();
  private readonly pieceOf = new Map<string, Piece>(); // edge ID → piece

  constructor(private readonly doc: Json) {}

  run(): string {
    const doc = this.doc;
    const project = isObject(doc['project']) ? doc['project'] : {};
    if (typeof project['name'] === 'string') this.out.push(`project ${quote(project['name'])}`);
    const buildings = Object.entries(coll(doc, 'buildings'));
    if (buildings.length > 1) throw new DecompileError('the DSL describes one building');
    const bname = buildings[0]?.[1]['name'];
    if (typeof bname === 'string' && bname !== 'House') this.out.push(`building ${quote(bname)}`);

    const levels = Object.entries(coll(doc, 'levels')).sort(([a, x], [b, y]) => Number(big(x['elevation'] ?? 0) - big(y['elevation'] ?? 0)) || cmp(a, b));
    const handle = handles();
    for (const [id, l] of levels) this.levelHandle.set(id, handle(typeof l['name'] === 'string' ? l['name'] : undefined, id));
    const itemHandle = handles();
    const program = isObject(doc['program']) ? doc['program'] : {};
    const items = Object.entries(isObject(program['items']) ? (program['items'] as Record<string, Json>) : {}).sort(([a], [b]) => cmp(a, b));
    for (const [id, it] of items) this.itemHandle.set(id, itemHandle(typeof it['name'] === 'string' ? it['name'] : undefined, id));
    // Written in order of handle, not ID: the text does not depend on the document's IDs.
    items.sort(([a], [b]) => cmp(this.itemHandle.get(a)!, this.itemHandle.get(b)!));

    this.geometry();
    if (this.out.length > 0) this.out.push('');
    this.wallTypes();

    const roomHandle = handles();
    const rooms = Object.entries(coll(doc, 'rooms')).sort(([a], [b]) => cmp(a, b));
    for (const [id, r] of rooms) this.roomHandle.set(id, roomHandle(typeof r['name'] === 'string' ? r['name'] : undefined, id));

    if (items.length > 0) this.brief(items, program);
    for (const [lid, l] of levels) {
      const h = this.levelHandle.get(lid)!;
      const name = typeof l['name'] === 'string' && l['name'] !== nameFromHandle(h) ? ` ${quote(l['name'])}` : '';
      this.out.push('', `level ${h}${name} at ${formatExact(big(l['elevation'] ?? 0))} height ${formatExact(big(l['height']))}`);
      this.rooms(rooms.filter(([, r]) => r['level'] === lid));
    }
    this.openings();
    return `${this.out.join('\n').replace(/^\n+/, '')}\n`;
  }

  /** Rooms as rectangles, and the check that the level is exactly their plane graph. */
  private geometry(): void {
    const doc = this.doc;
    const junctions = coll(doc, 'junctions');
    const pos = (j: unknown): readonly [bigint, bigint] => {
      const p = junctions[j as string]!['position'] as [number, number];
      return [big(p[0]), big(p[1])];
    };
    const byLevel = new Map<string, Edge[]>();
    for (const [kind, separator] of [
      ['walls', false],
      ['separators', true],
    ] as const)
      for (const [id, e] of Object.entries(coll(doc, kind))) {
        const s = pos(e['start']);
        const t = pos(e['end']);
        let piece: Edge['piece'];
        if (s[1] === t[1]) piece = { axis: 'h', at: s[1], lo: s[0] < t[0] ? s[0] : t[0], hi: s[0] < t[0] ? t[0] : s[0] };
        else if (s[0] === t[0]) piece = { axis: 'v', at: s[0], lo: s[1] < t[1] ? s[1] : t[1], hi: s[1] < t[1] ? t[1] : s[1] };
        else throw new DecompileError(`${separator ? 'separator' : 'wall'} ${id} is not horizontal or vertical`);
        const edge: Edge = { id, separator, start: s, end: t, piece };
        this.edges.set(id, edge);
        const lid = e['level'] as string;
        byLevel.set(lid, [...(byLevel.get(lid) ?? []), edge]);
      }
    const roomsByLevel = new Map<string, [string, Json][]>();
    for (const [id, r] of Object.entries(coll(doc, 'rooms'))) roomsByLevel.set(r['level'] as string, [...(roomsByLevel.get(r['level'] as string) ?? []), [id, r]]);
    for (const lid of new Set([...byLevel.keys(), ...roomsByLevel.keys()])) {
      const edges = byLevel.get(lid) ?? [];
      const rects = new Map<string, Rect>();
      for (const [id, r] of roomsByLevel.get(lid) ?? []) {
        const [ax, ay] = (r['anchor'] as [number, number]).map(big) as [bigint, bigint];
        let x0: bigint | undefined, x1: bigint | undefined, y0: bigint | undefined, y1: bigint | undefined;
        for (const e of edges) {
          const p = e.piece;
          if (p.axis === 'v' && p.lo <= ay && ay <= p.hi) {
            if (p.at > ax && (x1 === undefined || p.at < x1)) x1 = p.at;
            if (p.at < ax && (x0 === undefined || p.at > x0)) x0 = p.at;
          }
          if (p.axis === 'h' && p.lo <= ax && ax <= p.hi) {
            if (p.at > ay && (y1 === undefined || p.at < y1)) y1 = p.at;
            if (p.at < ay && (y0 === undefined || p.at > y0)) y0 = p.at;
          }
        }
        if (x0 === undefined || x1 === undefined || y0 === undefined || y1 === undefined) throw new DecompileError(`room ${id} is not enclosed by horizontal and vertical walls`);
        rects.set(id, { x0, y0, x1, y1 });
      }
      const list = [...rects];
      for (let i = 0; i < list.length; i++)
        for (let j = 0; j < i; j++) {
          const [ia, a] = list[i]!;
          const [ib, b] = list[j]!;
          if (a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1) throw new DecompileError(`rooms ${ib} and ${ia} are not rectangles of their own`);
        }
      const ps = pieces(rects);
      const want = new Map(ps.map((p) => [pieceKey(p), p]));
      const have = new Map(edges.map((e) => [pieceKey(e.piece), e]));
      for (const [k, e] of have) {
        const p = want.get(k);
        if (!p) throw new DecompileError(`${e.separator ? 'separator' : 'wall'} ${e.id} is not a side of a rectangular room (or its room is not a rectangle)`);
        if (e.separator && (p.high === undefined || p.low === undefined)) throw new DecompileError(`separator ${e.id} does not divide two rooms`);
        this.pieceOf.set(e.id, p);
      }
      for (const k of want.keys()) if (!have.has(k)) throw new DecompileError(`a room on level ${lid} is not a rectangle of walls and separators`);
      for (const [id, r] of rects) this.rects.set(id, r);
    }
  }

  /** The exterior and interior wall: one assembly and justification each, drawn the way the compiler draws them. */
  private wallTypes(): void {
    const doc = this.doc;
    const walls = coll(doc, 'walls');
    const types = coll(doc, 'types');
    for (const scope of ['exterior', 'interior'] as const) {
      let spec: string | undefined;
      let line: string | undefined;
      for (const [id, w] of Object.entries(walls).sort(([a], [b]) => cmp(a, b))) {
        const p = this.pieceOf.get(id)!;
        const exterior = p.high === undefined || p.low === undefined;
        if (exterior !== (scope === 'exterior')) continue;
        const own = Array.isArray(w['layers']) ? (w['layers'] as Json[]) : undefined;
        const typeId = own === undefined && typeof w['type'] === 'string' ? w['type'] : undefined;
        const layers = own ?? (typeId !== undefined ? (types[typeId]!['layers'] as Json[]) : []);
        const justification = typeof w['justification'] === 'string' ? w['justification'] : 'center';
        const key = JSON.stringify([typeId ?? null, layers, justification]);
        if (spec !== undefined && key !== spec) throw new DecompileError(`the ${scope} walls are not all one assembly and justification (wall ${id} differs)`);
        if (justification !== 'center') {
          const e = this.edges.get(id)!;
          const o = oriented(p);
          if (o.from[0] !== e.start[0] || o.from[1] !== e.start[1]) throw new DecompileError(`wall ${id} is justified ${justification} but drawn ${scope === 'exterior' ? 'counter-clockwise' : 'from its high end'}`);
        }
        if (spec === undefined) {
          spec = key;
          const name = typeId !== undefined && typeof types[typeId]!['name'] === 'string' ? ` ${quote(types[typeId]!['name'])}` : '';
          const ls = layers.map((l) => `${l['function'] === 'airGap' ? 'airGap' : String(l['function'])} ${formatExact(big(l['thickness']))}`).join(', ');
          const just = { center: '', exteriorFace: ' justify exterior-face', interiorFace: ' justify interior-face', coreFace: ' justify core-face' }[justification as 'center'];
          line = `wall ${scope}${typeId !== undefined ? ` ${typeId}` : ''}${name}: ${ls}${just}`;
        }
      }
      if (line) this.out.push(line);
    }
  }

  private brief(items: [string, Json][], program: Json): void {
    const parts = items.map(([id, it]) => {
      const h = this.itemHandle.get(id)!;
      const name = typeof it['name'] === 'string' && it['name'] !== itemName(h) ? ` ${quote(it['name'])}` : '';
      const count = typeof it['count'] === 'number' && it['count'] !== 1 ? `${it['count']} ` : '';
      const fn = typeof it['function'] === 'string' ? it['function'] : 'unspecified';
      const inferred = inferFunction(h, typeof it['name'] === 'string' ? it['name'] : itemName(h));
      return [
        `${count}${h}${name}`,
        it['targetArea'] !== undefined ? ` ${formatArea(big(it['targetArea']))}` : '',
        it['minArea'] !== undefined ? ` min ${formatArea(big(it['minArea']))}` : '',
        typeof it['level'] === 'string' ? ` on ${this.levelHandle.get(it['level'])!}` : '',
        fn !== inferred ? ` as ${fn}` : '',
      ].join('');
    });
    this.out.push('', `brief: ${parts.join(', ')}`);
    const words = { required: 'adjacent', preferred: 'near', forbidden: 'apart' } as const;
    for (const a of Array.isArray(program['adjacency']) ? (program['adjacency'] as Json[]) : [])
      this.out.push(`${words[a['kind'] as keyof typeof words]} ${this.itemHandle.get(a['a'] as string)!}-${this.itemHandle.get(a['b'] as string)!}`);
  }

  /** Room lines, each placed by relations to rooms already written where it can be. */
  private rooms(rooms: [string, Json][]): void {
    const placed: string[] = [];
    // Geometry decides the order, never IDs: the text is the same whatever the document's IDs are.
    const remaining = rooms
      .map(([id]) => id)
      .sort((a, b) => {
        const p = this.rects.get(a)!;
        const q = this.rects.get(b)!;
        return p.y0 !== q.y0 ? (p.y0 < q.y0 ? -1 : 1) : p.x0 !== q.x0 ? (p.x0 < q.x0 ? -1 : 1) : cmp(a, b);
      });
    const lines = new Map<string, string>();
    const relate = (id: string): string | undefined => {
      const b = this.rects.get(id)!;
      // One relation and its alignment.
      for (const aid of placed) {
        const a = this.rects.get(aid)!;
        const h = this.roomHandle.get(aid)!;
        if (b.x0 === a.x1 || b.x1 === a.x0) {
          const dir = b.x0 === a.x1 ? 'east-of' : 'west-of';
          if (b.y0 === a.y0) return `${dir} ${h}`;
          if (b.y1 === a.y1) return `${dir} ${h} aligned north`;
          if (b.y0 + b.y1 === a.y0 + a.y1) return `${dir} ${h} aligned center`;
        }
        if (b.y0 === a.y1 || b.y1 === a.y0) {
          const dir = b.y0 === a.y1 ? 'north-of' : 'south-of';
          if (b.x0 === a.x0) return `${dir} ${h}`;
          if (b.x1 === a.x1) return `${dir} ${h} aligned east`;
          if (b.x0 + b.x1 === a.x0 + a.x1) return `${dir} ${h} aligned center`;
        }
      }
      // Two relations, one per axis.
      let x: string | undefined;
      let y: string | undefined;
      for (const aid of placed) {
        const a = this.rects.get(aid)!;
        const h = this.roomHandle.get(aid)!;
        x ??= b.x0 === a.x1 ? `east-of ${h}` : b.x1 === a.x0 ? `west-of ${h}` : undefined;
        y ??= b.y0 === a.y1 ? `north-of ${h}` : b.y1 === a.y0 ? `south-of ${h}` : undefined;
      }
      return x !== undefined && y !== undefined ? `${x} ${y}` : undefined;
    };
    while (remaining.length > 0) {
      let pick = remaining.findIndex((id) => placed.length > 0 && relate(id) !== undefined);
      let where: string;
      if (pick < 0) {
        // The south-west-most room not yet written, by its own coordinates.
        pick = 0;
        for (let i = 1; i < remaining.length; i++) {
          const r = this.rects.get(remaining[i]!)!;
          const p = this.rects.get(remaining[pick]!)!;
          if (r.y0 < p.y0 || (r.y0 === p.y0 && r.x0 < p.x0)) pick = i;
        }
        const r = this.rects.get(remaining[pick]!)!;
        where = `at ${formatExact(r.x0)}, ${formatExact(r.y0)}`;
      } else where = relate(remaining[pick]!)!;
      const id = remaining.splice(pick, 1)[0]!;
      placed.push(id);
      const room = coll(this.doc, 'rooms')[id]!;
      const h = this.roomHandle.get(id)!;
      const r = this.rects.get(id)!;
      const name = typeof room['name'] === 'string' && room['name'] !== nameFromHandle(h) ? ` ${quote(room['name'])}` : '';
      const fn = typeof room['function'] === 'string' ? room['function'] : 'unspecified';
      const inferred = inferFunction(typeof room['name'] === 'string' ? room['name'] : nameFromHandle(h), h);
      const brief = typeof room['brief'] === 'string' ? ` for ${this.itemHandle.get(room['brief'])!}` : '';
      lines.set(id, `${h}${name} ${size(r.x1 - r.x0, r.y1 - r.y0)} ${where}${fn !== inferred ? ` as ${fn}` : ''}${brief}`);
      this.out.push(lines.get(id)!);
    }
    // Open boundaries between rooms of this level.
    const ids = new Set(rooms.map(([id]) => id));
    const opens: string[] = [];
    for (const sid of Object.keys(coll(this.doc, 'separators'))) {
      const p = this.pieceOf.get(sid)!;
      if (!ids.has(p.high!)) continue;
      opens.push(`open ${this.roomHandle.get(p.low!)!}-${this.roomHandle.get(p.high!)!}`);
    }
    this.out.push(...opens.sort(cmp));
  }

  private openings(): void {
    const doc = this.doc;
    const types = coll(doc, 'types');
    const openings = Object.entries(coll(doc, 'openings'));
    if (openings.length > 0) this.out.push('');
    const lines: string[] = [];
    for (const [, o] of openings) {
      const e = this.edges.get(o['wall'] as string)!;
      const p = this.pieceOf.get(e.id)!;
      const fill = typeof o['fill'] === 'string' ? types[o['fill']] : undefined;
      const what = fill?.['kind'] === 'doorType' ? 'door' : fill?.['kind'] === 'windowType' ? 'window' : 'opening';
      const width = big(o['width'] ?? fill?.['width']);
      const height = big(o['height'] ?? fill?.['height']);
      const sill = big(o['sill'] ?? fill?.['sill'] ?? 0);
      const ax = p.axis === 'h' ? 0 : 1;
      const forward = e.start[ax] < e.end[ax];
      const offset = big(o['offset']);
      const start = forward ? e.start[ax] + offset : e.start[ax] - offset - width;
      let where: string;
      let lo: bigint;
      if (p.high !== undefined && p.low !== undefined) {
        where = `${this.roomHandle.get(p.low)!}-${this.roomHandle.get(p.high)!}`;
        lo = p.lo;
      } else {
        const room = (p.high ?? p.low)!;
        const side: Side = p.axis === 'h' ? (p.high !== undefined ? 'south' : 'north') : p.high !== undefined ? 'west' : 'east';
        where = `${this.roomHandle.get(room)!} ${side}`;
        const r = this.rects.get(room)!;
        lo = p.axis === 'h' ? r.x0 : r.y0;
      }
      const from = p.axis === 'h' ? 'west' : 'south';
      const parts = [`${what} ${where} ${size(width, height)}`, `at ${formatExact(start - lo)} from ${from}`];
      if (what === 'window' || (what === 'opening' && sill > 0n)) parts.push(`sill ${formatExact(sill)}`);
      if (what === 'door') {
        const dx = e.end[0] - e.start[0];
        const dy = e.end[1] - e.start[1];
        const dir = sideOfVector(dx, dy);
        const back = sideOfVector(-dx, -dy);
        const left = sideOfVector(-dy, dx);
        const right = sideOfVector(dy, -dx);
        parts.push(`hinge ${o['hinge'] === 'end' ? dir : back}`, `swing ${o['swing'] === 'left' ? left : right}`);
      }
      if (typeof o['name'] === 'string') parts.push(quote(o['name']));
      lines.push(parts.join(' '));
    }
    this.out.push(...lines.sort(cmp));
  }
}
