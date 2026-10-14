/**
 * FS_renovation's helpers (FLR-T-18.13): statuses with their default, the views of the two states,
 * a state as a plain document, and the filters' styles — on the suite's kitchen remodel.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluate, OFFICIAL_EXTENSIONS, OFFICIAL_EXTENSION_NAMES, renovation } from '../src/index.js';
import type { FloorspecDocument } from '../src/model/document.js';
import { deriveExtensions } from '../src/extensions/official.js';

const remodel = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', 'standard', 'conformance', 'ext', 'FS_renovation', '0.1.0', 'examples', '001-kitchen-remodel', 'input.json'), 'utf8'),
) as FloorspecDocument;
// The remodel's casework carries no model or symbol, which FS_furniture's kinds ask for: it is read without FS_furniture known.
const reader = { extensions: OFFICIAL_EXTENSION_NAMES, knownExtensions: OFFICIAL_EXTENSIONS.filter((e) => e.name !== 'FS_furniture') as unknown as readonly unknown[] };

describe('FS_renovation helpers', () => {
  it('gives every element its status, existing by default, and none to a junction', () => {
    const st = renovation.renovationStatuses(remodel);
    expect(st.get('W1')).toBe('existing');
    expect(st.get('W8')).toBe('demolish');
    expect(st.get('W12')).toBe('new');
    expect(st.get('X1')).toBe('demolish');
    expect(st.get('X3')).toBe('existing');
    expect(st.has('J7')).toBe(false);
    expect(renovation.statusOf(remodel, 'O6')).toBe('new');
    expect(renovation.statusOf(remodel, 'J1')).toBeUndefined();
  });

  it('views each state, dropping a join through a removed wall', () => {
    const existing = renovation.stateView(remodel, 'existing');
    const proposed = renovation.stateView(remodel, 'proposed');
    expect(Object.keys(existing.walls!)).toContain('W8');
    expect(Object.keys(existing.walls!)).not.toContain('W12');
    expect(Object.keys(proposed.walls!)).not.toContain('W8');
    expect(proposed.junctions!['J7']!.join).toBeUndefined();
    expect(remodel.junctions!['J7']!.join).toBeDefined();
  });

  it('makes each state a plain, valid document with nothing left to renovate', () => {
    for (const state of ['existing', 'proposed'] as const) {
      const d = renovation.stateDocument(remodel, state);
      expect(Object.keys(d.extensionsUsed ?? {})).not.toContain('FS_renovation');
      const ev = evaluate(d, reader);
      expect(ev.diagnostics.filter((x) => x.severity === 'error')).toEqual([]);
    }
    expect(Object.keys(renovation.stateDocument(remodel, 'proposed').rooms!).sort()).toEqual(['R1', 'R2', 'R4']);
  });

  it('draws each status in each filter as chapter 3 says', () => {
    expect(renovation.filterStyle('existing', 'demolish')).toBe('plain');
    expect(renovation.filterStyle('existing', 'new')).toBe('hidden');
    expect(renovation.filterStyle('demolition', 'demolish')).toBe('demolished');
    expect(renovation.filterStyle('proposed', 'demolish')).toBe('hidden');
    expect(renovation.filterStyle('proposed', 'new')).toBe('new');
    expect(renovation.filterStyle('combined', 'existing')).toBe('existing');
    expect(renovation.filterState('demolition')).toBe('existing');
    expect(renovation.filterState('combined')).toBeUndefined();
  });

  it('measures the remodel: quantities and both states’ areas', () => {
    const ev = evaluate(remodel, reader);
    expect(ev.valid).toBe(true);
    const x = deriveExtensions(ev.extensions ?? []).FS_renovation!;
    expect(x.quantities.demolish).toMatchObject({ walls: 1, openings: 1, rooms: 1, elements: 1 });
    expect(x.quantities.new.slabArea).toBe(String(56n * 390144n * 390144n));
    expect(Object.keys(x.states.proposed.rooms)).toEqual(['R1', 'R2', 'R4']);
    expect(x.states.proposed.area).toBe(x.states.existing.area);
  });
});
