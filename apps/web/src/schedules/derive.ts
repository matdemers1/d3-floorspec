import { roomsBeside } from '../editor/geometry';
import { labelOf, openingWidth, type EditorModel, type LevelView } from '../editor/model';
import { formatArea, formatLen, type UnitSystem } from '../editor/units';
import { kindLabel, words } from '../editor/systems/catalog';
import { compareIds, elementsOfExtension, recordsOf } from '../editor/systems/view';

/**
 * The schedules (FLR-T-5.8, FLR-REQ-091): rooms, doors, windows, plumbing fixtures and receptacles,
 * each a table derived from one version of the model by the engine — net areas (Core 6.4), sizes
 * from a type and the opening's own overrides (Core 7.2), the rooms either side of a wall, a
 * device's room and circuits as its extension derives them (FS_electrical 6.1, FS_plumbing 5.1).
 * Nothing here is entered by hand, and nothing the document does not hold is shown: a column whose
 * data Core has no member for (hardware, notes) is not here, and the name column appears only when
 * something has a name.
 */

type Json = Record<string, unknown>;

/** A cell: what it says, and what it sorts by. */
export interface Cell {
  text: string;
  value: string | number;
}

export interface ScheduleColumn {
  key: string;
  header: string;
  numeric?: boolean;
}

export interface ScheduleRow {
  key: string;
  cells: Record<string, Cell>;
}

export interface Schedule {
  id: 'rooms' | 'doors' | 'windows' | 'fixtures' | 'receptacles';
  label: string;
  columns: ScheduleColumn[];
  rows: ScheduleRow[];
  /** How its values were derived, said under the table. */
  footnote: string;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
const text = (t: string, value: string | number = t): Cell => ({ text: t, value });
const none = text('—', '');

/** Keep a column only when some row says something in it. */
function present(columns: ScheduleColumn[], rows: ScheduleRow[], optional: readonly string[]): ScheduleColumn[] {
  return columns.filter((c) => !optional.includes(c.key) || rows.some((r) => (r.cells[c.key]?.text ?? '—') !== '—'));
}

function levelOfWall(model: EditorModel, wall: string): LevelView | undefined {
  return model.levels.find((l) => l.walls.some((w) => w.id === wall));
}

const roomName = (model: EditorModel, id: string | null): string => (id === null ? 'Exterior' : labelOf(model, id));

export function roomsSchedule(model: EditorModel, units: UnitSystem): Schedule {
  const doc = model.document;
  const finish = (r: Json, member: string) => {
    const m = str(r[member]);
    return m === undefined ? none : text(labelOf(model, m));
  };
  const rows: ScheduleRow[] = model.levels.flatMap((level) =>
    level.rooms.map((room) => {
      const r = (doc.rooms?.[room.id] ?? {}) as Json;
      const brief = str(r['brief']);
      return {
        key: room.id,
        cells: {
          name: text(room.name),
          function: text(words(str(r['function']) ?? 'unspecified')),
          area: { text: formatArea(room.area2, units), value: Number(room.area2) },
          level: text(level.name),
          brief: brief === undefined ? none : text(labelOf(model, brief)),
          floor: finish(r, 'floorFinish'),
          walls: finish(r, 'wallFinish'),
          ceiling: finish(r, 'ceilingFinish'),
        },
      };
    }),
  );
  const columns: ScheduleColumn[] = [
    { key: 'name', header: 'Room' },
    { key: 'function', header: 'Function' },
    { key: 'area', header: 'Net area', numeric: true },
    { key: 'level', header: 'Level' },
    { key: 'brief', header: 'Brief item' },
    { key: 'floor', header: 'Floor' },
    { key: 'walls', header: 'Walls' },
    { key: 'ceiling', header: 'Ceiling' },
  ];
  return {
    id: 'rooms',
    label: 'Rooms',
    columns: present(columns, rows, ['brief', 'floor', 'walls', 'ceiling']),
    rows,
    footnote: 'Net areas inside the finished wall faces, derived by the engine (Floorspec Core 6.4).',
  };
}

function openingRows(model: EditorModel, units: UnitSystem, kind: 'doorType' | 'windowType'): ScheduleRow[] {
  const doc = model.document;
  return Object.entries((doc.openings ?? {}) as Record<string, Json | undefined>)
    .filter((e): e is [string, Json] => e[1] !== undefined)
    .filter(([, o]) => {
      const fill = str(o['fill']);
      return fill !== undefined && (doc.types?.[fill] as Json | undefined)?.['kind'] === kind;
    })
    .sort(([a], [b]) => compareIds(a, b))
    .map(([id, o]) => {
      const fill = str(o['fill']) as string;
      const type = (doc.types?.[fill] ?? {}) as Json;
      const width = openingWidth(doc, o) ?? 0;
      const height = num(o['height']) ?? num(type['height']) ?? 0;
      const sill = num(o['sill']) ?? num(type['sill']) ?? 0;
      const wall = String(o['wall']);
      const level = levelOfWall(model, wall);
      const sides = level === undefined ? { left: null, right: null } : roomsBeside(level, wall);
      const swing = o['swing'] === 'left' ? 'left' : 'right';
      const into = swing === 'left' ? sides.left : sides.right;
      const from = swing === 'left' ? sides.right : sides.left;
      const name = str(o['name']);
      return {
        key: id,
        cells: {
          mark: text(id),
          name: name === undefined ? none : text(name),
          type: text(str(type['name']) ?? fill),
          size: { text: `${formatLen(width, units)} × ${formatLen(height, units)}`, value: width * 1e9 + height },
          swing: text(`Hinged at the ${o['hinge'] === 'end' ? 'end' : 'start'} jamb`),
          between: kind === 'doorType' ? text(`${roomName(model, from)} → ${roomName(model, into)}`) : text([roomName(model, sides.left), roomName(model, sides.right)].sort().join(' · ')),
          sill: { text: formatLen(sill, units), value: sill },
          wall: text(wall),
        },
      };
    });
}

export function doorsSchedule(model: EditorModel, units: UnitSystem): Schedule {
  const rows = openingRows(model, units, 'doorType');
  return {
    id: 'doors',
    label: 'Doors',
    columns: present(
      [
        { key: 'mark', header: 'Mark' },
        { key: 'name', header: 'Name' },
        { key: 'type', header: 'Type' },
        { key: 'size', header: 'Size (W × H)' },
        { key: 'swing', header: 'Swing' },
        { key: 'between', header: 'Between (swings into)' },
        { key: 'wall', header: 'Wall' },
      ],
      rows,
      ['name'],
    ),
    rows,
    footnote: 'Sizes from the door type, overridden by the opening’s own width and height (Floorspec Core 7.2); the rooms either side of its wall as the plan derives them.',
  };
}

export function windowsSchedule(model: EditorModel, units: UnitSystem): Schedule {
  const rows = openingRows(model, units, 'windowType');
  return {
    id: 'windows',
    label: 'Windows',
    columns: present(
      [
        { key: 'mark', header: 'Mark' },
        { key: 'name', header: 'Name' },
        { key: 'type', header: 'Type' },
        { key: 'size', header: 'Size (W × H)' },
        { key: 'sill', header: 'Sill', numeric: true },
        { key: 'between', header: 'Between' },
        { key: 'wall', header: 'Wall' },
      ],
      rows,
      ['name'],
    ),
    rows,
    footnote: 'Sizes and sills from the window type, overridden by the opening’s own (Floorspec Core 7.2). Core holds no window operation, so none is listed.',
  };
}

/** A device's room, as its extension derives it. */
function roomOfDevice(model: EditorModel, extension: string, id: string): string | null {
  const rooms = (model.derived?.extensions as Record<string, { rooms?: Record<string, string[]> } | undefined> | undefined)?.[extension]?.rooms ?? {};
  return Object.entries(rooms).find(([, ids]) => ids.includes(id))?.[0] ?? null;
}

export function fixturesSchedule(model: EditorModel): Schedule {
  const doc = model.document;
  const rows: ScheduleRow[] = (['fixtures', 'waterHeaters', 'drains'] as const).flatMap((collection) =>
    elementsOfExtension(doc, 'FS_plumbing', collection).map(([id, e]) => {
      const room = roomOfDevice(model, 'FS_plumbing', id);
      const hot = str(e['hotFrom']);
      const drain = str(e['drain']);
      const supply = Array.isArray(e['supply']) ? (e['supply'] as string[]) : null;
      const name = str(e['name']);
      return {
        key: id,
        cells: {
          mark: text(id),
          name: name === undefined ? none : text(name),
          kind: text(kindLabel('FS_plumbing', collection, e)),
          room: room === null ? none : text(labelOf(model, room)),
          supply: supply === null ? none : text(supply.map(words).join(', ')),
          hot: hot === undefined ? none : text(labelOf(model, hot)),
          drain: drain === undefined ? none : text(labelOf(model, drain)),
        },
      };
    }),
  ).sort((a, b) => compareIds(a.key, b.key));
  return {
    id: 'fixtures',
    label: 'Fixtures',
    columns: present(
      [
        { key: 'mark', header: 'Mark' },
        { key: 'name', header: 'Name' },
        { key: 'kind', header: 'Fixture' },
        { key: 'room', header: 'Room' },
        { key: 'supply', header: 'Supply' },
        { key: 'hot', header: 'Hot water from' },
        { key: 'drain', header: 'Drains to' },
      ],
      rows,
      ['name'],
    ),
    rows,
    footnote: 'FS_plumbing’s fixtures, water heaters and drains, with the room each is in as the extension derives it (FS_plumbing 5.1).',
  };
}

const FEATURE: Record<string, string> = { gfci: 'GFCI', afci: 'AFCI', usb: 'USB', tamperResistant: 'Tamper-resistant', weatherResistant: 'Weather-resistant' };

export function receptaclesSchedule(model: EditorModel, units: UnitSystem): Schedule {
  const doc = model.document;
  const circuits = recordsOf(doc, 'FS_electrical', 'circuits');
  const rows: ScheduleRow[] = elementsOfExtension(doc, 'FS_electrical', 'receptacles').map(([id, e]) => {
    const on = circuits.filter(([, c]) => Array.isArray(c['loads']) && (c['loads'] as unknown[]).includes(id));
    const panels = [...new Set(on.map(([, c]) => str(c['panel'])).filter((p): p is string => p !== undefined))];
    const host = e['host'] as Json | undefined;
    const room = roomOfDevice(model, 'FS_electrical', id);
    const features = Array.isArray(e['features']) ? (e['features'] as string[]) : [];
    const volts = num(e['volts']) ?? 120;
    const amps = num(e['amps']) ?? 15;
    const name = str(e['name']);
    return {
      key: id,
      cells: {
        mark: text(id),
        name: name === undefined ? none : text(name),
        circuit: on.length === 0 ? none : text(on.map(([cid]) => cid).join(', ')),
        panel: panels.length === 0 ? none : text(panels.map((p) => labelOf(model, p)).join(', ')),
        rating: { text: `${String(amps)} A · ${String(volts)} V`, value: volts * 1000 + amps },
        features: features.length === 0 ? none : text(features.map((f) => FEATURE[f] ?? f).join(', ')),
        room: room === null ? none : text(labelOf(model, room)),
        wall: host?.['mode'] === 'wallFace' ? text(`${String(host['wall'])} · ${host['side'] === 'left' ? 'left' : 'right'} face`) : none,
        height: host?.['mode'] === 'wallFace' ? { text: formatLen(Number(host['height']), units), value: Number(host['height']) } : none,
      },
    };
  });
  return {
    id: 'receptacles',
    label: 'Receptacles',
    columns: present(
      [
        { key: 'mark', header: 'Mark' },
        { key: 'name', header: 'Name' },
        { key: 'circuit', header: 'Circuit' },
        { key: 'panel', header: 'Panel' },
        { key: 'rating', header: 'Rating' },
        { key: 'features', header: 'Type' },
        { key: 'room', header: 'Room' },
        { key: 'wall', header: 'Wall' },
        { key: 'height', header: 'Height', numeric: true },
      ],
      rows,
      ['name'],
    ),
    rows,
    footnote: 'FS_electrical’s receptacles, with the circuits that list them and the room each is in as the extension derives it (FS_electrical 6.1); heights above the wall’s base.',
  };
}

/** Every schedule, in the board's order. */
export function schedules(model: EditorModel, units: UnitSystem): Schedule[] {
  return [roomsSchedule(model, units), doorsSchedule(model, units), windowsSchedule(model, units), receptaclesSchedule(model, units), fixturesSchedule(model)];
}

/** A schedule as CSV (RFC 4180): its columns, and each row's text. */
export function toCsv(s: Schedule): string {
  const field = (t: string) => (/[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t);
  const lines = [s.columns.map((c) => field(c.header)).join(','), ...s.rows.map((r) => s.columns.map((c) => field(r.cells[c.key]?.text === '—' ? '' : (r.cells[c.key]?.text ?? ''))).join(','))];
  return `${lines.join('\r\n')}\r\n`;
}
