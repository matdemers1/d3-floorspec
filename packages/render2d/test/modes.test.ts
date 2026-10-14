import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ALL_ON, GHOST_OPACITY, LAYER_LABELS, MODE_IDS, MODES, PLAN_LAYERS, isModeId, layerOfElement, layerStates, renderPlan } from '../src/index.js';

/** The Courtyard House: walls, rooms, furniture, casework, every trade's devices and a garden. */
const HOUSE = JSON.parse(readFileSync(new URL('../../../apps/worker/test/fixtures/courtyard-house.json', import.meta.url), 'utf8')) as object;

/** The group `id` opens, with what it holds up to its matching close — enough to look inside. */
const has = (svg: string, id: string) => svg.includes(`id="${id}"`);
const ghostOf = (svg: string, layer: string) => svg.includes(`data-ghost="${layer}"`);

describe('trade modes (FLR-T-18.3)', () => {
  it('every mode sets every layer, and names its drawing', () => {
    expect(MODE_IDS).toHaveLength(7);
    for (const id of MODE_IDS) {
      const mode = MODES[id];
      expect(Object.keys(mode.layers).sort()).toEqual([...PLAN_LAYERS].sort());
      expect(mode.plan).toMatch(/ plan$/);
    }
    for (const l of PLAN_LAYERS) expect(LAYER_LABELS[l]).not.toBe('');
    expect(MODES.electrical.layers.electrical).toBe('on');
    expect(MODES.electrical.layers.walls).toBe('ghost');
    expect(MODES.decorator.layers.furniture).toBe('on');
    expect(MODES.construction.layers.furniture).toBe('off');
    expect(isModeId('plumbing')).toBe(true);
    expect(isModeId('kitchen')).toBe(false);
  });

  it('a person’s overrides sit over the preset; nonsense is ignored', () => {
    const s = layerStates('electrical', { walls: 'on', plumbing: 'ghost', nonsense: 'on', rooms: 'maybe' });
    expect(s.walls).toBe('on');
    expect(s.plumbing).toBe('ghost');
    expect(s.rooms).toBe(MODES.electrical.layers.rooms);
    expect(layerStates(null)).toEqual(ALL_ON);
  });

  it('each extension element belongs to its trade', () => {
    expect(layerOfElement('FS_electrical', 'receptacles')).toBe('electrical');
    expect(layerOfElement('FS_lighting', 'luminaires')).toBe('electrical');
    expect(layerOfElement('FS_furniture', 'casework')).toBe('casework');
    expect(layerOfElement('FS_furniture', 'appliances')).toBe('casework');
    expect(layerOfElement('FS_furniture', 'pieces')).toBe('furniture');
    expect(layerOfElement('FS_landscape', 'plants')).toBe('landscape');
    expect(layerOfElement('FS_acme', 'widgets')).toBeNull();
  });

  it('without a mode the plan is drawn exactly as before', () => {
    expect(renderPlan(HOUSE, {})).toBe(renderPlan(HOUSE));
    expect(renderPlan(HOUSE)).not.toContain('data-ghost=');
  });

  it('an electrical plan: devices drawn, the building ghosted in grey, other trades left out', () => {
    const svg = renderPlan(HOUSE, { mode: 'electrical' });
    expect(svg).toContain('<filter id="fs-ghost"');
    expect(ghostOf(svg, 'walls')).toBe(true);
    expect(ghostOf(svg, 'openings')).toBe(true);
    expect(ghostOf(svg, 'furniture')).toBe(true);
    expect(svg).toContain(`opacity="${String(GHOST_OPACITY)}"`);
    // Its own devices are in the plain fallbacks group; plumbing fixtures and the garden are gone.
    expect(svg).toContain('FS_electrical:receptacles');
    expect(has(svg, 'fallbacks-electrical')).toBe(false);
    expect(has(svg, 'fallbacks-furniture')).toBe(true);
    expect(svg).not.toContain('FS_plumbing:fixtures');
    expect(has(svg, 'plants')).toBe(false);
    expect(has(svg, 'dimensions')).toBe(false);
  });

  it('a furniture plan keeps the furniture in colour and leaves the wiring out', () => {
    const svg = renderPlan(HOUSE, { mode: 'decorator' });
    expect(svg).toContain('FS_furniture:pieces');
    expect(ghostOf(svg, 'furniture')).toBe(false);
    expect(ghostOf(svg, 'walls')).toBe(true);
    expect(svg).not.toContain('FS_electrical:receptacles');
  });

  it('a layer turned off over the mode is not drawn at all', () => {
    const svg = renderPlan(HOUSE, { mode: 'electrical', layers: { walls: 'off', openings: 'off' } });
    expect(has(svg, 'walls')).toBe(false);
    expect(has(svg, 'openings')).toBe(false);
    // The frame is the same in every mode, so plans of different trades lie over one another.
    const box = (s: string) => /viewBox="([^"]+)"/.exec(s)?.[1];
    expect(box(svg)).toBe(box(renderPlan(HOUSE)));
  });
});
