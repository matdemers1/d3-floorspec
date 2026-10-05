import { describe, expect, it } from 'vitest';
import { boundsOfOverlay, breakOf, locate, namedShapes, overlayOf, pointAt, ringPath, slice, spacingRuns, spacingSpans, stretchesOf, type LevelLike, type Pt } from '../src/findings/geometry';
import { counts, filterFindings, findingKey, findingsCsv, groupFindings, needsText, NOTICE, notEvaluatedByReason, shortReason, stateOf } from '../src/findings/model';
import type { Finding, FindingsReport } from '../src/findings/types';

/** FLR-T-6.9: the findings report's grouping and export, and the overlay geometry. */

const FT = 390_144;

function finding(over: Partial<Finding> & Pick<Finding, 'rule' | 'severity' | 'subject'>): Finding {
  return {
    pack: 'example',
    version: '0.1.0',
    title: 'A synthetic rule',
    citation: { code: 'TEST-CODE', edition: '2024', section: '§1.2', link: 'https://example.org/test-code/2024/1.2' },
    measures: [],
    elements: [over.subject.id],
    location: { level: 'L1', shapes: [] },
    message: `${over.subject.id} may not meet TEST-CODE 2024 §1.2 (A synthetic rule).`,
    ...over,
  };
}

const SMALL = finding({
  rule: 'ROOM-SIZE',
  severity: 'mayNotMeet',
  subject: { kind: 'room', id: 'R3' },
  measures: [{ target: { kind: 'room', id: 'R3' }, measure: 'roomNetArea', type: 'area', value: '1', display: '85.00 sq ft', op: '>=', threshold: 1, thresholdDisplay: '100.00 sq ft', holds: false }],
  location: { level: 'L1', shapes: [{ kind: 'polygon', outer: [[0, 0], [10, 0], [10, 10], [0, 10]], holes: [] }] },
});
const PANEL = finding({
  rule: 'WORKSPACE',
  severity: 'check',
  subject: { kind: 'element', id: 'X1' },
  candidates: [{ kind: 'envelope', id: 'X1', envelope: 'working' }],
  citation: { code: 'TEST-ELEC', edition: '2026', section: '§4.2' },
  elements: ['X1', 'X2'],
  location: {
    level: 'L1',
    shapes: [
      { kind: 'polygon', outer: [[0, 0], [2, 0], [2, 1], [0, 1]], holes: [] },
      { kind: 'polygon', outer: [[0, 1], [2, 1], [2, 5], [0, 5]], holes: [] },
      { kind: 'polygon', outer: [[1, 2], [2, 2], [2, 3], [1, 3]], holes: [] },
    ],
  },
});
const NOTE = finding({ rule: 'NOTE', severity: 'note', subject: { kind: 'opening', id: 'O1' }, location: { level: 'L1', shapes: [{ kind: 'segment', points: [[0, 0], [3, 0]] }] } });

describe('the findings report', () => {
  it('groups by severity, by room and by code, keeping the report’s order within a group', () => {
    const all = [SMALL, PANEL, NOTE];
    expect(groupFindings(all, 'severity', () => null).map((g) => [g.title, g.findings.map((f) => f.rule)])).toEqual([
      ['May not meet', ['ROOM-SIZE']],
      ['Check', ['WORKSPACE']],
      ['Notes', ['NOTE']],
    ]);
    const room = (f: Finding) => (f.subject.id === 'R3' ? { id: 'R3', label: 'Bedroom 2' } : f.subject.id === 'O1' ? { id: 'R1', label: 'Bedroom 1' } : null);
    expect(groupFindings(all, 'room', room).map((g) => g.title)).toEqual(['Bedroom 1', 'Bedroom 2', 'Not in a room']);
    expect(groupFindings(all, 'code', room).map((g) => [g.title, g.findings.length])).toEqual([
      ['TEST-CODE 2024', 2],
      ['TEST-ELEC 2026', 1],
    ]);
  });

  it('filters by severity and by code, and counts', () => {
    expect(filterFindings([SMALL, PANEL, NOTE], { severity: 'check', code: 'all' }).map((f) => f.rule)).toEqual(['WORKSPACE']);
    expect(filterFindings([SMALL, PANEL, NOTE], { severity: 'all', code: 'TEST-CODE 2024' }).map((f) => f.rule)).toEqual(['ROOM-SIZE', 'NOTE']);
    expect(counts([SMALL, PANEL, NOTE])).toEqual({ mayNotMeet: 1, check: 1, note: 1, total: 3 });
  });

  it('reads a measured condition as measured against its threshold', () => {
    expect(shortReason(SMALL)).toBe('85.00 sq ft — needs ≥ 100.00 sq ft');
    expect(needsText({ op: '<=', thresholdDisplay: '6\' 0"' })).toBe('≤ 6\' 0"');
    expect(findingKey(PANEL)).toBe('example/WORKSPACE/element:X1');
  });

  const report: FindingsReport = {
    head: 'main',
    hash: 'h',
    findings: [SMALL],
    rulePacks: [{ name: 'example', version: '0.1.0', title: 'Example' }],
    note: NOTICE,
    notice: NOTICE,
    profile: 'Nowhere County',
    profileId: 'p1',
    coverageUrl: 'https://floorspec.example.test/rule-packs',
    evaluated: [{ pack: 'example', version: '0.1.0', rule: 'ROOM-SIZE', citation: SMALL.citation, subjects: 2, exempt: 0, findings: 1 }],
    notEvaluated: [
      { pack: 'example', version: '0.1.0', rule: 'STAIR-RISER', reason: 'deferred' },
      { pack: 'example', version: '0.1.0', rule: 'SMOKE-ALARM', reason: 'edition' },
    ],
  };

  it('says honestly what the report as a whole is', () => {
    expect(stateOf(report)).toBe('findings');
    expect(stateOf({ ...report, findings: [] })).toBe('no-findings');
    expect(stateOf({ ...report, evaluated: [], findings: [] })).toBe('none-evaluated');
    expect(stateOf({ ...report, rulePacks: [] })).toBe('none-installed');
    expect(notEvaluatedByReason(report).map((g) => g.reason)).toEqual(['edition', 'deferred']);
  });

  it('exports CSV that opens with the notice, the profile and the coverage link (FLR-REQ-105)', () => {
    const csv = findingsCsv(report, (id) => (id === 'R3' ? 'Bedroom 2' : id));
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe(`Notice,"${NOTICE}"`);
    expect(lines[1]).toBe('Profile,Nowhere County');
    expect(lines[3]).toBe('Coverage,https://floorspec.example.test/rule-packs');
    expect(lines[6]).toContain('May not meet,R3 may not meet TEST-CODE 2024 §1.2 (A synthetic rule).,TEST-CODE,2024,§1.2');
    expect(lines[6]).toContain('Bedroom 2');
    expect(csv).not.toMatch(/\bcomplian|\bcomplies\b|passes code/i);
  });
});

describe('the overlay', () => {
  it('names each shape: the subject, a clearance zone, and what stands in it', () => {
    expect(namedShapes(PANEL).map((s) => s.kind)).toEqual(['element', 'zone', 'involved']);
    expect(namedShapes(SMALL).map((s) => s.kind)).toEqual(['room']);
    expect(namedShapes(NOTE)).toEqual([{ kind: 'opening', line: [[0, 0], [3, 0]] }]);
    const o = overlayOf(SMALL, null);
    expect(o.anchor).toEqual([5, 5]);
    expect(boundsOfOverlay(o)).toEqual({ minX: 0, minY: 0, maxX: 10, maxY: 10 });
  });

  // A 12' × 10' room, counter-clockwise from the origin: perimeter 44'.
  const ROOM: Pt[] = [[0, 0], [12 * FT, 0], [12 * FT, 10 * FT], [0, 10 * FT]];

  it('walks a room’s ring: positions, points and slices that wrap', () => {
    const path = ringPath(ROOM);
    expect(path.total).toBe(44 * FT);
    expect(locate(path, [6 * FT, -100])).toEqual({ t: 6 * FT, distance: 100 });
    expect(pointAt(path, 13 * FT)).toEqual([12 * FT, FT]);
    expect(slice(path, 40 * FT, 46 * FT)).toEqual([[0, 4 * FT], [0, 0], [2 * FT, 0]]);
    // A doorway's two ends make the shorter arc, even across the ring's start.
    expect(breakOf(path, [0, FT], [FT, 0])).toEqual([43 * FT, 45 * FT]);
  });

  it('breaks the wall line at doorways into stretches; one closed stretch with none', () => {
    const path = ringPath(ROOM);
    expect(stretchesOf(path, [])).toEqual([{ start: 0, length: 44 * FT, closed: true }]);
    expect(stretchesOf(path, [[2 * FT, 5 * FT]])).toEqual([{ start: 5 * FT, length: 41 * FT, closed: false }]);
    expect(stretchesOf(path, [[43 * FT, 45 * FT], [10 * FT, 11 * FT]])).toEqual([
      { start: 11 * FT, length: 32 * FT, closed: false },
      { start: FT, length: 9 * FT, closed: false },
    ]);
  });

  it('draws the runs between receptacles that are too long, and the parts beyond a receptacle’s reach', () => {
    const path = ringPath(ROOM);
    const open = stretchesOf(path, [[0, 3 * FT]]); // 41' of wall from 3' to 44'
    // Receptacles at 10' and 30': runs of 7', 20' and 14'.
    expect(spacingSpans(path, open, [10 * FT, 30 * FT], 'wallRunBetweenReceptacles', 12 * FT)).toEqual([
      [10 * FT, 30 * FT],
      [30 * FT, 44 * FT],
    ]);
    // Reach of 6': from 3' to 4' is beyond the first; 16' to 24' between them; 36' to 44' after the last.
    expect(spacingSpans(path, open, [10 * FT, 30 * FT], 'receptacleReach', 6 * FT)).toEqual([
      [3 * FT, 4 * FT],
      [16 * FT, 24 * FT],
      [36 * FT, 44 * FT],
    ]);
    // A closed wall line with one receptacle: the run all the way round.
    expect(spacingSpans(path, stretchesOf(path, []), [FT], 'wallRunBetweenReceptacles', 12 * FT)).toEqual([[FT, 45 * FT]]);
    // No receptacle at all: the whole stretch is beyond reach.
    expect(spacingSpans(path, open, [], 'receptacleReach', 6 * FT)).toEqual([[3 * FT, 44 * FT]]);
  });

  it('finds a spacing finding’s runs on the level: its room, its doorways, its counted receptacles', () => {
    const level: LevelLike = {
      rooms: [{ id: 'R1', outer: ROOM }],
      walls: [{ id: 'W1', thickness: 4 * 32_512 }],
      openings: [
        { id: 'D1', wall: 'W1', kind: 'door', start: [0, 0], end: [3 * FT, 0] },
        { id: 'N1', wall: 'W1', kind: 'window', start: [5 * FT, 0], end: [8 * FT, 0] },
      ],
      devices: [
        { id: 'X4', placement: { point: [12 * FT, 2 * FT] } },
        { id: 'X9', placement: { point: [6 * FT, 10 * FT] } },
      ],
    };
    const f = finding({
      rule: 'SPACING',
      severity: 'mayNotMeet',
      subject: { kind: 'room', id: 'R1' },
      measures: [{ target: { kind: 'room', id: 'R1' }, measure: 'wallRunBetweenReceptacles', type: 'length', value: 0, display: '', op: '<=', threshold: 12 * FT, thresholdDisplay: '12\' 0"', holds: false, involved: ['X4'] }],
    });
    // Only X4 counts (at 14'): the runs are 3'→14' (11') and 14'→44' (30').
    const runs = spacingRuns(f, level);
    expect(runs.map((r) => r.length / FT)).toEqual([30]);
    expect(runs[0]?.line[0]).toEqual([12 * FT, 2 * FT]);
    expect(runs[0]?.line.at(-1)).toEqual([0, 0]);
  });
});
