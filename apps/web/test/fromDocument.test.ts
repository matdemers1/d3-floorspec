import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { apply } from '@floorspec/ops';
import { canonicalize } from '@floorspec/engine';
import { documentToBatch } from '../src/projects/fromDocument';

/** Templates and imports land as one batch of Floorspec Ops on a blank project (FLR-ADR-008). */
describe('a document as a batch', () => {
  const template = JSON.parse(readFileSync(new URL('../src/projects/templates/three-room-house.floorspec.json', import.meta.url), 'utf8')) as Record<string, unknown>;

  it('turns the empty document into the template, byte for byte, under the chosen name', () => {
    // What the server creates: a new project is Core 0.2.
    const blank = { floorspec: '0.2', project: { name: 'My house' } };
    const result = apply(blank, { batch: documentToBatch(template, 'My house') });
    expect(result.status).toBe('committed');
    if (result.status !== 'committed') return;
    const expected = { ...template, project: { ...(template['project'] as object), name: 'My house' } };
    expect(result.document).toBe(canonicalize(expected));
  });

  it('only adds elements and sets document members', () => {
    const ops = new Set(documentToBatch(template, 'x').map((o) => o.op));
    expect([...ops].sort()).toEqual(['addElement', 'setProperty']);
  });

  it('is Core 0.2, as a new project is', () => {
    expect(template['floorspec']).toBe('0.2');
  });

  it('carries a brief — items, the rooms that fulfil them, the bubble diagram — and extension elements', () => {
    const withBrief = apply(template, {
      batch: [
        { op: 'addProgramItem', id: 'P1', function: 'living', name: 'Living', targetArea: '300 sq ft' },
        { op: 'addProgramItem', id: 'P2', function: 'kitchen', name: 'Kitchen', count: 1 },
        { op: 'addProgramItem', id: 'P3', function: 'sleeping', level: 'MAIN' },
        { op: 'setAdjacency', a: 'P2', b: 'P1', kind: 'required', weight: 8 },
        { op: 'setAdjacency', a: 'P3', b: 'P2', kind: 'forbidden' },
        { op: 'setRoomBrief', room: 'LIV', item: 'P1' },
        { op: 'setProperty', id: '$document', path: '/extensionsUsed/FS_electrical', value: '0.1.0' },
        {
          op: 'placeElement',
          extension: 'FS_electrical',
          collection: 'devices',
          host: { mode: 'surface', room: 'LIV', surface: 'floor', at: ["3'", "4'"] },
          element: { name: 'Floor outlet', fallback: { box: { min: [0, -51200, 0], max: [25600, 51200, 128000] } }, device: 'receptacle' },
        },
      ],
    });
    expect(withBrief.status, JSON.stringify(withBrief.status === 'rejected' ? withBrief.diagnostics : [])).toBe('committed');
    if (withBrief.status !== 'committed') return;
    const source = JSON.parse(withBrief.document) as Record<string, unknown>;
    const blank = { floorspec: '0.2', project: { name: 'Imported' } };
    const result = apply(blank, { batch: documentToBatch(source, 'Imported') });
    expect(result.status, JSON.stringify(result.status === 'rejected' ? result.diagnostics : [])).toBe('committed');
    if (result.status !== 'committed') return;
    expect(result.document).toBe(canonicalize({ ...source, project: { ...(source['project'] as object), name: 'Imported' } }));
  });
});
