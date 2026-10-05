import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { apply } from '@floorspec/ops';
import { OFFICIAL_READER } from '@floorspec/engine';
import { readModel } from '../src/editor/model';
import { doorsSchedule, fixturesSchedule, receptaclesSchedule, roomsSchedule, schedules, toCsv, windowsSchedule, type Schedule } from '../src/schedules/derive';

/**
 * The schedules (FLR-T-5.8, FLR-REQ-091), derived from the template house and from the same house
 * with the P5 devices on it: each column from what the document holds or the engine derives,
 * optional columns only when something fills them, and the CSV quoted as RFC 4180 says.
 */

const IN = 32_512;
const FT = 12 * IN;
const TEMPLATE = readFileSync(new URL('../src/projects/templates/three-room-house.floorspec.json', import.meta.url), 'utf8');
/**
 * The template house as a Core 0.2 plan: the official extensions at 0.1.0 are evaluated only for
 * documents that declare "0.2" (each one's 1.2; `officialExtensionsEvaluatedFor`), and these tests
 * are about what they check and derive. When the extensions take Core 0.3, use TEMPLATE as it is.
 */
const HOUSE = TEMPLATE.replace('"floorspec": "0.3"', '"floorspec": "0.2"');
const PLATE = { min: [0, -51200, -76800], max: [32000, 51200, 76800] };

const text = (s: Schedule) => s.rows.map((r) => Object.fromEntries(s.columns.map((c) => [c.key, r.cells[c.key]?.text])));

function withDevices(): string {
  const r = apply(
    HOUSE,
    {
      batch: [
        { op: 'setProperty', id: '$document', path: '/extensionsUsed/FS_electrical', value: '0.1.0' },
        { op: 'setProperty', id: '$document', path: '/extensionsUsed/FS_plumbing', value: '0.1.0' },
        { op: 'placeElement', id: 'X1', extension: 'FS_electrical', collection: 'panels', host: { mode: 'wallFace', wall: 'WW', side: 'right', at: "4'", height: "5'" }, element: { name: 'P1', fallback: { box: { min: [0, -256000, -512000], max: [128000, 256000, 512000] } }, volts: [120, 240], rating: 200, spaces: 40 } },
        { op: 'placeElement', id: 'X2', extension: 'FS_electrical', collection: 'receptacles', host: { mode: 'wallFace', wall: 'WN2', toward: 'Kitchen', at: "3'", height: '42"' }, element: { fallback: { box: PLATE }, features: ['gfci', 'tamperResistant'], amps: 20, name: 'Counter, "left"' } },
        { op: 'placeElement', id: 'X3', extension: 'FS_electrical', collection: 'receptacles', host: { mode: 'wallFace', wall: 'WW', side: 'right', at: "10'", height: '12"' }, element: { fallback: { box: PLATE } } },
        { op: 'placeElement', id: 'X4', extension: 'FS_plumbing', collection: 'waterHeaters', host: { mode: 'surface', room: 'LIV', surface: 'floor', at: [2 * FT, 22 * FT] }, element: { fallback: { box: { min: [-358400, -358400, 0], max: [358400, 358400, 1920000] } }, heater: 'storage', energy: 'electric' } },
        { op: 'placeElement', id: 'X5', extension: 'FS_plumbing', collection: 'fixtures', host: { mode: 'surface', room: 'BED', surface: 'floor', at: [30 * FT, 6 * FT] }, element: { fallback: { box: { min: [0, -243200, 0], max: [896000, 243200, 1024000] } }, fixture: 'lavatory', supply: ['cold', 'hot'], hotFrom: 'X4' } },
        { op: 'setProperty', id: '$document', path: '/extensions/FS_electrical/circuits/C5', value: { panel: 'X1', breaker: 20, volts: 120, loads: ['X2'] } },
      ],
    },
    OFFICIAL_READER,
  );
  if (r.status !== 'committed') throw new Error(r.diagnostics.map((d) => d.message).join('; '));
  return r.document;
}

describe('schedules', () => {
  const house = readModel('h', HOUSE);

  it('lists rooms with their net areas, levels and only the finishes the plan has', () => {
    const s = roomsSchedule(house, 'imperial');
    expect(s.columns.map((c) => c.key)).toEqual(['name', 'function', 'area', 'level', 'floor', 'walls']);
    expect(text(s)).toEqual([
      { name: 'Bedroom', function: 'Sleeping', area: '173 ft²', level: 'Main floor', floor: 'White oak strip', walls: 'Eggshell paint, "Sea Salt"' },
      { name: 'Kitchen', function: 'Kitchen', area: '175 ft²', level: 'Main floor', floor: 'Porcelain tile 12 x 24', walls: '—' },
      { name: 'Living room', function: 'Living', area: '446 ft²', level: 'Main floor', floor: 'White oak strip', walls: '—' },
    ]);
    expect(roomsSchedule(house, 'metric').rows[0]?.cells['area']?.text).toBe('16.1 m²');
  });

  it('lists doors with their type, size, hinge and the rooms they open between', () => {
    const s = doorsSchedule(house, 'imperial');
    expect(s.columns.map((c) => c.key)).toEqual(['mark', 'name', 'type', 'size', 'swing', 'between', 'wall']);
    expect(text(s)).toEqual([
      { mark: 'BD', name: '—', type: '32 in interior door', size: '2\'-8" × 6\'-8"', swing: 'Hinged at the end jamb', between: 'Living room → Bedroom', wall: 'WI1' },
      { mark: 'FD', name: 'Front door', type: '36 in entry door', size: '3\'-0" × 6\'-8"', swing: 'Hinged at the start jamb', between: 'Living room → Exterior', wall: 'WS2' },
    ]);
  });

  it('lists windows with sizes and sills from their type and their own overrides', () => {
    const s = windowsSchedule(house, 'imperial');
    expect(s.columns.map((c) => c.key)).toEqual(['mark', 'name', 'type', 'size', 'sill', 'between', 'wall']);
    // LW2 overrides its type's width: 6' wide, a 48 x 48 window type.
    expect(text(s).find((r) => r['mark'] === 'LW2')).toEqual({ mark: 'LW2', name: 'Picture window', type: '48 x 48 in window', size: '6\'-0" × 4\'-0"', sill: '3\'-0"', between: 'Exterior · Living room', wall: 'WN1' });
    expect(s.rows).toHaveLength(4);
  });

  it('adds operation and clear opening columns for a Core 0.3 plan that declares them — as declared, never computed', () => {
    const r = apply(TEMPLATE, {
      batch: [
        { op: 'setProperty', id: 'D32', path: '/operation', value: 'pocket' },
        { op: 'setProperty', id: 'D32', path: '/clearOpening', value: { width: 29 * IN, height: 79 * IN } },
        { op: 'setProperty', id: 'W4848', path: '/operation', value: 'casement' },
        { op: 'setProperty', id: 'W4848', path: '/clearOpening', value: { width: 20 * IN, height: 44 * IN, area: 6 * 144 * IN * IN } },
        // LW2 overrides its clear opening whole: a width and a height, and no area.
        { op: 'setProperty', id: 'LW2', path: '/clearOpening', value: { width: 30 * IN, height: 44 * IN } },
      ],
    });
    if (r.status !== 'committed') throw new Error(r.diagnostics.map((d) => `${d.code} ${d.message}`).join('; '));
    const m = readModel('h3', r.document);
    const doors = doorsSchedule(m, 'imperial');
    expect(doors.columns.map((c) => c.key)).toEqual(['mark', 'name', 'type', 'size', 'operation', 'clear', 'swing', 'between', 'wall']);
    expect(text(doors).map((d) => [d['mark'], d['operation'], d['clear']])).toEqual([
      ['BD', 'Pocket', '2\'-5" × 6\'-7"'],
      ['FD', '—', '—'],
    ]);
    const windows = windowsSchedule(m, 'imperial');
    expect(windows.columns.map((c) => c.key)).toEqual(['mark', 'name', 'type', 'size', 'sill', 'operation', 'clear', 'clearArea', 'between', 'wall']);
    const by: Record<string, Record<string, string | undefined>> = Object.fromEntries(text(windows).map((w) => [w['mark'] ?? '', w]));
    expect(by['LW1']).toMatchObject({ operation: 'Casement', clear: '1\'-8" × 3\'-8"', clearArea: '6.00 ft²' });
    expect(by['LW2']).toMatchObject({ operation: 'Casement', clear: '2\'-6" × 3\'-8" (own)', clearArea: '—' });
    expect(by['KW']).toMatchObject({ operation: '—', clear: '—', clearArea: '—' });
  });

  it('lists receptacles with their circuit, panel, rating, type, room, wall and height', () => {
    const m = readModel('h', withDevices());
    const s = receptaclesSchedule(m, 'imperial');
    expect(text(s)).toEqual([
      { mark: 'X2', name: 'Counter, "left"', circuit: 'C5', panel: 'P1', rating: '20 A · 120 V', features: 'GFCI, Tamper-resistant', room: 'Kitchen', wall: 'WN2 · right face', height: '3\'-6"' },
      { mark: 'X3', name: '—', circuit: '—', panel: '—', rating: '15 A · 120 V', features: '—', room: 'Living room', wall: 'WW · right face', height: '1\'-0"' },
    ]);
  });

  it('lists fixtures and water heaters with their room, supply, hot water and drain', () => {
    const s = fixturesSchedule(readModel('h', withDevices()));
    expect(s.columns.map((c) => c.key)).toEqual(['mark', 'kind', 'room', 'supply', 'hot', 'drain']);
    expect(text(s)).toEqual([
      { mark: 'X4', kind: 'Water heater', room: 'Living room', supply: '—', hot: '—', drain: '—' },
      { mark: 'X5', kind: 'Lavatory', room: 'Bedroom', supply: 'Cold, Hot', hot: 'Water heater X4', drain: '—' },
    ]);
  });

  it('follows the plan: a moved wall changes the areas, a new receptacle a row', () => {
    const before = schedules(readModel('a', withDevices()), 'imperial');
    const moved = apply(withDevices(), { batch: [{ op: 'moveWall', wall: 'WI2', by: "1'" }, { op: 'placeElement', id: 'X9', extension: 'FS_electrical', collection: 'receptacles', host: { mode: 'wallFace', wall: 'WE1', side: 'right', at: "2'", height: '42"' }, element: { fallback: { box: PLATE } } }] }, OFFICIAL_READER);
    if (moved.status !== 'committed') throw new Error('rejected');
    const after = schedules(readModel('b', moved.document), 'imperial');
    const area = (s: Schedule[], room: string) => s[0]?.rows.find((r) => r.key === room)?.cells['area']?.text;
    expect(area(before, 'KIT')).toBe('175 ft²');
    expect(area(after, 'KIT')).toBe('160 ft²');
    expect(after.find((s) => s.id === 'receptacles')?.rows.map((r) => r.key)).toEqual(['X2', 'X3', 'X9']);
  });

  it('exports a schedule as CSV, quoting what needs it', () => {
    const csv = toCsv(receptaclesSchedule(readModel('h', withDevices()), 'imperial'));
    expect(csv.split('\r\n')[0]).toBe('Mark,Name,Circuit,Panel,Rating,Type,Room,Wall,Height');
    expect(csv.split('\r\n')[1]).toBe('X2,"Counter, ""left""",C5,P1,20 A · 120 V,"GFCI, Tamper-resistant",Kitchen,WN2 · right face,"3\'-6"""');
    expect(csv.split('\r\n')[2]).toBe('X3,,,,15 A · 120 V,,Living room,WW · right face,"1\'-0"""');
  });
});
