import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { evaluate } from '@floorspec/engine';
import {
  CONSTRUCTION_DOOR,
  DARK_PULL,
  DEFAULT_READER,
  PLAN_STYLES,
  STYLES,
  contrast,
  defaultStyle,
  floorFinishOf,
  floorPatternSvg,
  isPlanStyle,
  legibleUnder,
  materialTone,
  mix,
  planTheme,
  renderEvaluation,
  sceneOf,
  wallClassOf,
  type RenderOptions,
} from '../src/index.js';

/** The Courtyard House: library floors (white oak, porcelain, terrazzo, epoxy), bluestone and concrete slabs, three wall types, furniture and a garden. */
const HOUSE = JSON.parse(readFileSync(new URL('../../../apps/worker/test/fixtures/courtyard-house.json', import.meta.url), 'utf8')) as object;
const EV = evaluate(HOUSE, DEFAULT_READER);
const render = (options: Omit<RenderOptions, 'design' | 'reader'> = {}): string => renderEvaluation(EV, options);

const IN = 32_512;

describe('plan styles (FLR-T-18.5)', { timeout: 60_000 }, () => {
  it('four styles, each named; Construction defaults to Technical', () => {
    expect(PLAN_STYLES).toEqual(['colour', 'presentation', 'technical', 'blueprint']);
    for (const s of PLAN_STYLES) expect(STYLES[s].label).not.toBe('');
    expect(defaultStyle('construction')).toBe('technical');
    expect(defaultStyle('decorator')).toBe('colour');
    expect(defaultStyle(null)).toBe('colour');
    expect(isPlanStyle('blueprint')).toBe(true);
    expect(isPlanStyle('sepia')).toBe(false);
  });

  it('a floor’s pattern comes from its library item at true size, scaled by its own texture, turned by its rotation', () => {
    const oak = floorFinishOf({ id: 'oak', item: 'white-oak-plank', color: '#B9A283' });
    expect(oak).toMatchObject({ color: '#b9a283', pattern: { kind: 'plank', width: 7 * IN }, rotation: 0 });
    const big = floorFinishOf({ id: 'oak', item: 'white-oak-plank', size: [2 * 2_176_000, 2 * 2_176_000], rotation: 90_000_000 });
    expect(big.pattern).toMatchObject({ kind: 'plank', width: 14 * IN });
    expect(big.rotation).toBe(90_000_000);
    expect(floorFinishOf({ id: 't', item: 'porcelain-warm-stone' }).pattern).toMatchObject({ kind: 'tile', w: 12 * IN, bond: 'grid' });
    expect(floorFinishOf({ id: 'p', item: 'bluestone-pavers' }).pattern).toMatchObject({ kind: 'tile', bond: 'running' });
    // Not the library's: its name says what it is.
    expect(floorFinishOf({ id: 'x', name: 'Maple hardwood' }).pattern.kind).toBe('plank');
    expect(floorFinishOf({ id: 'x', name: 'Slate tile' }).pattern.kind).toBe('tile');
    expect(floorFinishOf({ id: 'x', name: 'Polished concrete' }).pattern.kind).toBe('slab');
    expect(floorFinishOf({ id: 'x', name: 'Mystery' }).pattern.kind).toBe('plain');
  });

  it('a pattern too fine for the scale is left out: the floor is its colour', () => {
    const oak = floorFinishOf({ id: 'oak', item: 'white-oak-plank', color: '#b9a283' });
    const t = planTheme('colour', 'light');
    expect(floorPatternSvg('p', oak, oak.color, { k: 24 / 390_144, origin: [0, 0] }, t)).toContain('<pattern id="p"');
    expect(floorPatternSvg('p', oak, oak.color, { k: 1 / 390_144, origin: [0, 0] }, t)).toBe('');
  });

  it('a dark colour plan pulls each material colour 38 % toward the canvas', () => {
    const dark = planTheme('colour', 'dark');
    expect(DARK_PULL).toBe(0.38);
    expect(materialTone('#b9a283', dark)).toBe(legibleUnder(mix('#b9a283', dark.paper, 0.38), dark.text));
    expect(materialTone('#b9a283', planTheme('colour', 'light'))).toBe('#b9a283');
  });

  it('every floor keeps the plan’s text at 4.5:1: a pale stone in the dark, a dark wood in the light', () => {
    for (const style of ['colour', 'presentation'] as const)
      for (const theme of ['light', 'dark'] as const) {
        const t = planTheme(style, theme);
        for (const c of ['#dfe1dd', '#f4f1ea', '#b9a283', '#8a6440', '#5f666a', '#2f3e55', '#9c5a3c', '#ffffff', '#000000']) expect(contrast(t.text, materialTone(c, t)), `${style} ${theme} ${c}`).toBeGreaterThanOrEqual(4.5);
        for (const c of [t.floorPlain, t.room, t.tread]) expect(contrast(t.text, c), `${style} ${theme} plain`).toBeGreaterThanOrEqual(4.5);
      }
  });

  it('wall types are outside or inside by their layers', () => {
    const doc = HOUSE as { types: Record<string, unknown> };
    expect(wallClassOf(doc.types['wall-2x6-exterior-brick-veneer'])).toBe('exterior');
    expect(wallClassOf(doc.types['wall-2x4-interior'])).toBe('interior');
    const scene = sceneOf(EV);
    expect(scene.wallTypes.size).toBe(4);
    expect(scene.walls.get('W1')).toMatchObject({ type: 'wall-2x6-exterior-brick-veneer', cls: 'exterior' });
    expect(scene.rooms.get('R7')?.floor).toMatchObject({ id: 'white-oak-floor', item: 'white-oak-plank' });
    expect(scene.slabs.get('SL1')?.material).toMatchObject({ id: 'bluestone-pavers' });
  });

  it('Colour: each floor in its finish, slabs in theirs, walls one poché, names on pills', () => {
    const svg = render({ style: 'colour' });
    expect(svg).toMatch(/<path data-id="R7" data-floor="white-oak-floor" d="[^"]+" fill="url\(#fs-floor-white-oak-floor\)"/);
    expect(svg).toContain('<pattern id="fs-floor-white-oak-floor"');
    expect(svg).toContain('<pattern id="fs-floor-terrazzo"');
    expect(svg).toContain('<pattern id="fs-floor-bluestone-pavers"');
    expect(svg).toMatch(/<path data-id="SL1" data-purpose="patio" d="[^"]+" fill="url\(#fs-floor-bluestone-pavers\)"/);
    expect(svg).toContain('data-wall-class="exterior"');
    expect(svg).not.toContain('fs-wall-hatch');
    expect(svg).toContain('data-pill=""');
    expect(svg).not.toContain('fs-shadow');
    // A colour plan is a picture: no dimension strings unless asked.
    expect(svg).not.toContain('id="dimensions"');
    expect(svg).toContain('>Great room<');
    expect(svg).not.toMatch(/NaN|Infinity/);
    // The same plan, the same bytes.
    expect(render({ style: 'colour' })).toBe(svg);
  });

  it('turning a detail off: plain floors, no pills', () => {
    const svg = render({ style: 'colour', details: { patterns: false, pills: false } });
    expect(svg).not.toContain('<pattern id="fs-floor-');
    expect(svg).toMatch(/<path data-id="R7" data-floor="white-oak-floor" d="[^"]+" fill="#b9a283"/);
    expect(svg).not.toContain('data-pill');
  });

  it('Presentation: charcoal walls and a soft shadow under walls and furniture', () => {
    const svg = render({ style: 'presentation' });
    expect(svg).toContain('<filter id="fs-shadow"');
    expect(svg).toContain('data-shadow="walls" filter="url(#fs-shadow)"');
    expect(svg).toContain('<g id="fallbacks" filter="url(#fs-shadow)"');
    expect(render({ style: 'presentation', details: { shadows: false } })).not.toContain('fs-shadow');
  });

  it('Technical: exterior walls hatched, interior solid, wet rooms gridded, names in capitals, dimensions', () => {
    const svg = render({ style: 'technical' });
    expect(svg).toContain('<pattern id="fs-wall-hatch"');
    expect(svg).toMatch(/data-wall-class="exterior" d="[^"]+" fill="#ffffff"[^>]*\/><path d="[^"]+" fill="url\(#fs-wall-hatch\)"/);
    expect(svg).toMatch(/data-wall-class="interior" d="[^"]+" fill="#101117"/);
    // The guest bath and the mudroom (laundry) gridded; the great room not.
    expect(svg).toContain('data-grid="R2"');
    expect(svg).toContain('data-grid="R10"');
    expect(svg).not.toContain('data-grid="R7"');
    expect(svg).toContain('>GREAT ROOM<');
    expect(svg).toContain('id="dimensions"');
    expect(svg).not.toContain('fs-floor-');
  });

  it('Blueprint: white on blue over a 2 ft grid', () => {
    const svg = render({ style: 'blueprint' });
    expect(svg).toContain('data-grid="2ft"');
    expect(svg).toContain(`fill="${planTheme('blueprint', 'light').paper}"`);
    expect(render({ style: 'blueprint', theme: 'dark' })).toContain(`fill="${planTheme('blueprint', 'dark').paper}"`);
  });

  it('Construction mode: walls by type, each in its colour, doors in amber, and a legend', () => {
    const svg = render({ style: 'technical', mode: 'construction', theme: 'dark' });
    expect(svg).toContain('id="wall-legend"');
    for (const t of ['wall-2x6-exterior-brick-veneer', 'wall-2x6-exterior-fibre-cement', 'wall-2x4-interior']) expect(svg).toContain(`data-wall-type="${t}"`);
    expect(svg).toContain('2x6 exterior wall, brick veneer');
    expect(svg).toContain(`stroke="${CONSTRUCTION_DOOR.dark}"`);
    // Without a style the construction plan is drawn as it always was.
    expect(render({ mode: 'construction' })).not.toContain('wall-legend');
  });

  it('every style is legible in both themes: names on their pills, and text on the paper, at 4.5:1 or better', () => {
    for (const style of PLAN_STYLES)
      for (const theme of ['light', 'dark'] as const) {
        const t = planTheme(style, theme);
        expect(contrast(t.text, t.paper), `${style} ${theme}`).toBeGreaterThanOrEqual(4.5);
        if (t.pill !== null) expect(contrast(t.text, t.pill.fill), `${style} ${theme} pill`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(t.muted, t.pill?.fill ?? t.paper), `${style} ${theme} area`).toBeGreaterThanOrEqual(4.5);
      }
  });
});
