import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { apply } from '@floorspec/ops';
import { OFFICIAL_READER } from '@floorspec/engine';
import { readModel } from '../src/editor/model';
import { addOptionSet, mayBeInOption, nextIds } from '../src/editor/optionOps';
import { setFinishes, withFace } from '../src/editor/finishOps';

/** FLR-T-8.4 and 8.1: the editor's batches for design options and finishes, applied by @floorspec/ops. */

const kitchen = readFileSync(new URL('../../../packages/engine/standard/conformance/core/0.3/options/001-kitchen-a-and-b/input.json', import.meta.url), 'utf8');

describe('design options in the editor', () => {
  it('reads every design: the primary by default, another on request, and only that design on the plan', () => {
    const a = readModel('h', kitchen);
    expect(a.optionSets.map((s) => [s.id, s.primary, s.options.map((o) => o.id)])).toEqual([['KS', 'KA', ['KA', 'KB']]]);
    expect(a.design).toEqual({ KS: 'KA' });
    const b = readModel('h', kitchen, { KS: 'KB' });
    expect(b.design).toEqual({ KS: 'KB' });
    const wallsOf = (m: typeof a) => m.levels.flatMap((l) => l.walls.map((w) => w.id));
    expect(wallsOf(a)).toContain('WA');
    expect(wallsOf(a)).not.toContain('SB');
    expect(wallsOf(b)).not.toContain('WA');
    // The tree and the inspector still see every element.
    expect(b.index.has('WA')).toBe(true);
    // A choice that is not the document's is dropped.
    expect(readModel('h', kitchen, { KS: 'nope' }).design).toEqual({ KS: 'KA' });
  });

  it('creates an option set and its options under named IDs, which the applier commits', () => {
    const m = readModel('h', kitchen);
    expect(nextIds(m, 'OS', 1, 0)).toEqual(['OS1']);
    const batch = addOptionSet(m, 'Deck', ['None', 'Cedar'])(0);
    const r = apply(kitchen, { batch }, OFFICIAL_READER);
    expect(r.status).toBe('committed');
    const doc = JSON.parse((r as { document: string }).document) as { optionSets: Record<string, { primary: string; name: string }>; options: Record<string, { set: string; name: string }> };
    expect(doc.optionSets['OS1']).toEqual({ primary: 'OP1', name: 'Deck' });
    expect(doc.options['OP2']).toEqual({ set: 'OS1', name: 'Cedar' });
    expect(mayBeInOption(m, 'WA')).toBe(true);
    expect(mayBeInOption(m, 'KS')).toBe(false);
  });
});

describe('a wall face finish in the editor', () => {
  it('sets a whole finishes object, keeps the other face and unsets an empty one', () => {
    const region = { from: 0, to: 10, bottom: 0, top: 10, material: 'M' };
    const f = withFace({ right: { material: 'P' } }, 'left', { regions: [region] });
    expect(f).toEqual({ right: { material: 'P' }, left: { regions: [region] } });
    expect(withFace(f, 'right', {})).toEqual({ left: { regions: [region] } });
    expect(setFinishes('W1', {})).toEqual([{ op: 'unsetProperty', id: 'W1', path: '/finishes' }]);
    expect(setFinishes('W1', f)).toEqual([{ op: 'setProperty', id: 'W1', path: '/finishes', value: f }]);
  });
});
