import { readFileSync } from 'node:fs';
import { InvalidDocumentError, check } from '@floorspec/engine';
import { describe, expect, it } from 'vitest';
import { ACCENT, PACKAGE_NAME, PALETTES, buildScene, feetInches, inches, labelPoint, num, renderPlan, squareFeet } from '../src/index.js';

const HOUSES = ['three-room-house', 'two-bedroom-ranch', 'l-shaped-house'] as const;
const FT = 390144;

type Doc = Record<string, unknown> & {
  junctions: Record<string, { level: string; position: [number, number]; join?: unknown }>;
  walls: Record<string, Record<string, unknown>>;
  openings: Record<string, Record<string, unknown>>;
  rooms: Record<string, Record<string, unknown>>;
};

const load = (name: string): Doc => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Doc;

/** The same document with every object's members inserted in reverse order. */
function reversed(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(reversed);
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.entries(v)
        .reverse()
        .map(([k, x]) => [k, reversed(x)]),
    );
  return v;
}

/** A changeset on the ranch: a wall moved, a freestanding wall added, a window replaced. */
function ranchChangeset(): { before: Doc; after: Doc } {
  const before = load('two-bedroom-ranch');
  const after = structuredClone(before);
  after.junctions['B14']!.position = [29 * FT, 16 * FT];
  after.junctions['E14']!.position = [44 * FT, 16 * FT];
  delete after.openings['W2E'];
  after.openings['W2N'] = { wall: 'E2', offset: 3 * FT, fill: 'W3636' };
  after.junctions['P1'] = { level: 'MAIN', position: [6 * FT, 4 * FT] };
  after.junctions['P2'] = { level: 'MAIN', position: [12 * FT, 4 * FT] };
  after.walls['PW'] = { level: 'MAIN', start: 'P1', end: 'P2', type: 'INT24' };
  return { before, after };
}

describe('@floorspec/render2d', () => {
  it('names itself', () => {
    expect(PACKAGE_NAME).toBe('@floorspec/render2d');
  });

  it('draws only valid sample houses', () => {
    for (const h of HOUSES) expect(check(load(h)).valid).toBe(true);
  });
});

describe('golden SVG', () => {
  for (const h of HOUSES)
    for (const theme of ['light', 'dark'] as const)
      it(`${h}, ${theme}`, async () => {
        await expect(renderPlan(load(h), { theme })).toMatchFileSnapshot(`./golden/${h}-${theme}.svg`);
      });

  it('a changeset on the ranch, ghosted, light', async () => {
    const { before, after } = ranchChangeset();
    expect(check(after).valid).toBe(true);
    await expect(renderPlan(after, { theme: 'light', ghost: { before } })).toMatchFileSnapshot('./golden/two-bedroom-ranch-changeset-light.svg');
  });
});

describe('determinism', () => {
  it('gives identical bytes for identical input, and for the same document with its members in another order', () => {
    for (const h of HOUSES) {
      const doc = load(h);
      const a = renderPlan(doc, { theme: 'dark' });
      expect(renderPlan(structuredClone(doc), { theme: 'dark' })).toBe(a);
      expect(renderPlan(reversed(doc) as object, { theme: 'dark' })).toBe(a);
      expect(renderPlan(JSON.stringify(doc), { theme: 'dark' })).toBe(a);
      expect(renderPlan(new TextEncoder().encode(JSON.stringify(doc)), { theme: 'dark' })).toBe(a);
    }
  });

  it('writes no float noise: every number has at most two decimals', () => {
    const svg = renderPlan(load('l-shaped-house'));
    expect(svg).not.toMatch(/\d\.\d{3,}/);
    expect(svg).not.toMatch(/NaN|Infinity|-0[^.\d]/);
  });
});

describe('what a plan draws', () => {
  const svg = renderPlan(load('three-room-house'));

  it('is a standalone SVG sized from the scale', () => {
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="')).toBe(true);
    expect(svg).not.toMatch(/var\(--/);
    const w = Number(/width="(\d+)"/.exec(svg)![1]);
    const big = renderPlan(load('three-room-house'), { scale: 48 });
    const w2 = Number(/width="(\d+)"/.exec(big)![1]);
    // 36' 2-3/8" of building: 24 more pixels a foot is about 868 more pixels.
    expect(w2 - w).toBeGreaterThan(860);
    expect(w2 - w).toBeLessThan(880);
  });

  it('cuts every opening from the walls, through one mask', () => {
    expect(svg).toContain('<g id="walls" mask="url(#fs-cuts)">');
    const mask = /<mask id="fs-cuts"[^]*?<\/mask>/.exec(svg)![0];
    expect(mask.match(/fill="#000"/g)).toHaveLength(6);
  });

  it('draws a door leaf and a dashed quarter swing for each door, and glazing for each window', () => {
    for (const id of ['FD', 'BD']) {
      const g = new RegExp(`<g data-id="${id}">(.*?)</g>`).exec(svg)![1]!;
      expect(g).toMatch(/A\d+(\.\d+)? \d+(\.\d+)? 0 0 [01] /);
      expect(g).toContain('stroke-dasharray="3 2"');
    }
    for (const id of ['LW1', 'LW2', 'KW', 'BW']) {
      const g = new RegExp(`<g data-id="${id}">(.*?)</g>`).exec(svg)![1]!;
      expect(g).toContain(`stroke="${PALETTES.light.window}"`);
      expect(g.match(/M/g)!.length).toBe(2 + 4);
    }
  });

  it('draws separators dashed', () => {
    expect(svg).toMatch(/<path data-id="SK" d="[^"]+" stroke="#747888" stroke-width="1.25" stroke-dasharray="6 4"/);
  });

  it('labels rooms with name, net area in ft², ft-in dimensions and ID', () => {
    const label = /<g data-id="LIV" [^>]*>(.*?)<\/g>/.exec(svg)![1]!;
    expect(label).toContain('>Living room<');
    expect(label).toContain('>446.3 ft²<');
    expect(label).toContain(`>19' 6" × 23' 0"<`);
    expect(label).toContain('>LIV<');
  });

  it('dimensions the building overall in ft-in, and draws a north arrow turned to true north', () => {
    expect(svg).toContain(`>36' 2-3/8"<`);
    expect(svg).toContain(`>24' 2-3/8"<`);
    // trueNorth −12.5° (clockwise of project north): the arrow turns 12.5° clockwise.
    expect(svg).toMatch(/<g id="north" transform="translate\([\d.]+ [\d.]+\) rotate\(12.5\)">/);
  });

  it('leaves out dimensions and labels when asked', () => {
    const bare = renderPlan(load('three-room-house'), { dimensions: false, labels: false });
    expect(bare).not.toContain('id="dimensions"');
    expect(bare).not.toContain('id="labels"');
  });

  it('hatches and labels an unanchored face', () => {
    const l = renderPlan(load('l-shaped-house'));
    expect(l).toContain('fill="url(#fs-hatch)"');
    expect(l).toContain('>Unanchored<');
  });

  it('resolves every colour to fixed hex per theme', () => {
    const dark = renderPlan(load('three-room-house'), { theme: 'dark' });
    expect(dark).toContain(`fill="${PALETTES.dark.paper}"`);
    expect(dark).toContain(`fill="${PALETTES.dark.room}"`);
    expect(svg).toContain(`fill="${PALETTES.light.paper}"`);
    expect(ACCENT).toBe('#b5d84a');
  });

  it('highlights elements in the accent', () => {
    const h = renderPlan(load('three-room-house'), { highlight: ['WI1', 'KIT', 'BD'] });
    expect(h).toMatch(new RegExp(`<path data-id="WI1" d="[^"]+" fill="${ACCENT}"`));
    expect(h).toMatch(new RegExp(`<g data-id="BD">.*?stroke="${ACCENT}"`));
    expect(h).toContain(`fill="${ACCENT}" fill-opacity="0.16"`);
  });
});

describe('changeset ghosting', () => {
  const { before, after } = ranchChangeset();
  const svg = renderPlan(after, { ghost: { before } });
  const ghosts = /<g id="ghosts">(.*?)<\/g><g id="labels"/.exec(svg)![1]!;

  it('draws what was added in the accent', () => {
    expect(svg).toMatch(new RegExp(`<path data-id="PW" d="[^"]+" fill="${ACCENT}"`));
    expect(svg).toMatch(new RegExp(`<g data-id="W2N">.*?stroke="${ACCENT}"`));
    expect(ghosts).not.toContain('data-ghost="PW"');
  });

  it('draws what was removed dashed and faded', () => {
    expect(ghosts).toMatch(/<g data-ghost="W2E"><path d="[^"]+" stroke="#747888" stroke-width="1.25" stroke-dasharray="5 3"/);
    expect(svg).not.toContain('data-id="W2E"');
  });

  it('draws what moved in the accent, with its old outline ghosted', () => {
    for (const id of ['I8', 'I4', 'I5', 'E1', 'E2']) {
      expect(svg).toMatch(new RegExp(`<path data-id="${id}" d="[^"]+" fill="${ACCENT}"`));
      expect(ghosts).toContain(`data-ghost="${id}"`);
    }
    // The door D1 rides on I5, which moved: it is ghosted where it was.
    expect(ghosts).toContain('data-ghost="D1"');
  });

  it('leaves what did not change alone', () => {
    for (const id of ['N1', 'S3', 'W1', 'FD', 'SEP']) expect(ghosts).not.toContain(`data-ghost="${id}"`);
    expect(svg).not.toMatch(new RegExp(`data-id="N1" d="[^"]+" fill="${ACCENT}"`));
  });

  it('marks rooms whose polygon changed, and ghosts only the rings that changed', () => {
    // LIV gained a hole (the new freestanding wall): its outer ring is unchanged.
    expect(ghosts).not.toContain('data-ghost="LIV"');
    expect(ghosts).toContain('data-ghost="BED1"');
    expect(svg).toMatch(new RegExp(`<rect [^>]*fill="${ACCENT}"/><text [^>]*>BED1<`));
  });

  it('with an empty before side, everything is added', () => {
    const doc = load('three-room-house');
    const empty = { floorspec: '0.1', project: { name: 'Empty' } };
    const s = renderPlan(doc, { ghost: { before: empty } });
    expect(s).toMatch(new RegExp(`<path data-id="WW" d="[^"]+" fill="${ACCENT}"`));
    expect(s).not.toContain('data-ghost=');
  });
});

describe('errors', () => {
  it('refuses an invalid document with the engine’s diagnostics', () => {
    const doc = load('three-room-house');
    (doc.rooms['LIV'] as { anchor: number[] }).anchor = [-FT, -FT];
    expect(() => renderPlan(doc)).toThrow(InvalidDocumentError);
  });

  it('refuses a level the document does not have', () => {
    expect(() => renderPlan(load('three-room-house'), { level: 'ATTIC' })).toThrow(RangeError);
  });

  it('refuses a scale that is not a positive number', () => {
    expect(() => renderPlan(load('three-room-house'), { scale: 0 })).toThrow(RangeError);
  });
});

describe('scene', () => {
  it('keeps the engine’s derived values: face ends, fills, room polygons, opening points', () => {
    const doc = load('three-room-house');
    const derived = check(doc).derived!;
    const s = buildScene(doc);
    expect(s.walls.get('WW')!.outline).toEqual([derived.walls['WW']!.startRight, derived.walls['WW']!.endRight, derived.walls['WW']!.endLeft, derived.walls['WW']!.startLeft]);
    expect(s.fills.get('TM')).toEqual(derived.junctionFills['TM']);
    expect(s.rooms.get('LIV')!.outer).toEqual(derived.rooms['LIV']!.outer);
    expect(s.openings.get('FD')!.start).toEqual(derived.openings['FD']!.start);
    expect([...s.walls.keys()]).toEqual([...s.walls.keys()].sort());
  });
});

describe('formatting', () => {
  it('writes drawing numbers with at most two decimals and never -0', () => {
    expect(num(1)).toBe('1');
    expect(num(1.006)).toBe('1.01');
    expect(num(12.3456)).toBe('12.35');
    expect(num(-0.001)).toBe('0');
    expect(num(-2.5)).toBe('-2.5');
  });

  it('writes lengths in feet and inches to 1/16 inch', () => {
    expect(feetInches(0)).toBe(`0' 0"`);
    expect(feetInches(12 * FT + 6 * 32512)).toBe(`12' 6"`);
    expect(feetInches(233680)).toBe(`0' 7-3/16"`);
    expect(feetInches(FT + 32512 / 2)).toBe(`1' 1/2"`);
    // Half a sixteenth rounds to even: 1016 base units is exactly 1/32 inch.
    expect(feetInches(1016)).toBe(`0' 0"`);
    expect(feetInches(3048)).toBe(`0' 1/8"`);
    expect(inches(146304)).toBe('4-1/2"');
  });

  it('writes net areas in ft² with one decimal, exactly', () => {
    expect(squareFeet('152212340736')).toBe('1.0');
    expect(squareFeet('67939026960384')).toBe('446.3');
    expect(squareFeet('0.5')).toBe('0.0');
  });
});

describe('label placement', () => {
  it('puts a label inside an L, away from its re-entrant corner', () => {
    const L: [number, number][] = [
      [0, 0],
      [10, 0],
      [10, 4],
      [4, 4],
      [4, 10],
      [0, 10],
    ];
    const p = labelPoint(L, []);
    expect(p.clear).toBeGreaterThan(1.5);
    expect(p.x < 4 || p.y < 4).toBe(true);
  });

  it('keeps out of a hole', () => {
    const outer: [number, number][] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ];
    const hole: [number, number][] = [
      [3, 3],
      [3, 7],
      [7, 7],
      [7, 3],
    ];
    const p = labelPoint(outer, [hole]);
    expect(p.x > 3 && p.x < 7 && p.y > 3 && p.y < 7).toBe(false);
  });
});

describe('Core 0.2: fallbacks and clearance envelopes', () => {
  /** The three-room house as a 0.2 document, with a sofa in the living room and a swing on its entry door. */
  function furnished(): Doc {
    const d = load('three-room-house');
    d.floorspec = '0.2';
    const types = d.types as Record<string, Record<string, unknown>>;
    types['D36']!.clearances = { swing: { purpose: 'swing', shape: 'box', min: [0, -585216, 0], max: [1170432, 585216, 2600960] } };
    const anchor = d.rooms['LIV']!.anchor as [number, number];
    d.extensionsUsed = { FS_furniture: '0.1' };
    d.extensions = {
      FS_furniture: {
        collections: {
          pieces: {
            SOFA: {
              fallback: { level: 'MAIN', box: { min: [-1066800, -457200, 0], max: [1066800, 457200, 838200] } },
              host: { mode: 'surface', room: 'LIV', surface: 'floor', position: anchor, rotation: 90000000 },
            },
          },
        },
      },
    };
    return d;
  }

  it('draws every extension element on the level as its fallback footprint', () => {
    const d = furnished();
    expect(check(d).valid).toBe(true);
    const svg = renderPlan(d);
    expect(svg).toContain('<g id="fallbacks">');
    expect(svg).toMatch(/data-id="SOFA" data-kind="FS_furniture:pieces"/);
    expect(svg).not.toContain('id="clearances"');
  });

  it('draws clearance envelopes only when asked', () => {
    const svg = renderPlan(furnished(), { clearances: true });
    expect(svg).toMatch(/<g id="clearances"><path data-owner="[A-Z0-9]+" data-name="swing" data-purpose="swing"/);
    expect(renderPlan(furnished(), { clearances: true })).toBe(svg);
  });

  it('leaves a 0.1 drawing byte-for-byte as it was', () => {
    const d = load('three-room-house');
    expect(renderPlan(d, { clearances: true })).toBe(renderPlan(d));
  });
});

describe('Core 0.3: slabs and ceilings that are not flat', () => {
  /** The three-room house as a 0.3 document, with a patio, a tray in the living room and a vault in the bedroom. */
  function layered(): Doc {
    const d = load('three-room-house');
    d.floorspec = '0.3';
    (d.rooms['LIV'] as Record<string, unknown>).ceiling = { kind: 'tray', border: FT, depth: 195072 };
    (d.rooms['BED'] as Record<string, unknown>).ceiling = { kind: 'vaulted', ridge: [[7 * FT, 6 * FT], [36 * FT, 6 * FT]], pitch: { rise: 4, run: 12 }, height: 3_500_000 };
    d.slabs = { PAT: { level: 'MAIN', boundary: [[0, -10 * FT], [12 * FT, -10 * FT], [12 * FT, -2 * FT], [0, -2 * FT]], thickness: 130048, purpose: 'patio' } };
    return d;
  }

  it('builds them into the scene from what the engine derived', () => {
    const scene = buildScene(layered());
    expect(scene.slabs.get('PAT')).toMatchObject({ purpose: 'patio', outline: [[0, -10 * FT], [12 * FT, -10 * FT], [12 * FT, -2 * FT], [0, -2 * FT]] });
    expect(scene.rooms.get('LIV')?.ceiling?.kind).toBe('tray');
    expect(scene.rooms.get('BED')?.ceiling).toMatchObject({ kind: 'vaulted', ridge: [[7 * FT, 6 * FT], [36 * FT, 6 * FT]] });
    expect(scene.rooms.get('KIT')?.ceiling?.kind).toBe('flat');
  });

  it('draws the slab under the rooms, the tray centre and the ridge, and names the ceiling on the label', () => {
    const svg = renderPlan(layered());
    expect(svg).toContain('<g id="slabs">');
    expect(svg.indexOf('<g id="slabs">')).toBeLessThan(svg.indexOf('<g id="floors">'));
    expect(svg).toContain('data-purpose="patio"');
    expect(svg).toContain('data-id="LIV:tray"');
    expect(svg).toContain('data-id="BED:ridge"');
    expect(svg).toContain('Tray ceiling');
    expect(svg).toContain('Vaulted ceiling');
    // A plan with neither draws no group for them.
    const plain = renderPlan(load('three-room-house'));
    expect(plain).not.toContain('<g id="slabs">');
    expect(plain).not.toContain('<g id="ceilings">');
  });
});
