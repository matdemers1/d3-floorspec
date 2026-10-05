import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { apply } from '@floorspec/ops';
import { canonicalize } from '@floorspec/engine';
import { documentToBatch } from '../src/projects/fromDocument';

/** Templates and imports land as one batch of Floorspec Ops on a blank project (FLR-ADR-008). */
describe('a document as a batch', () => {
  const template = JSON.parse(readFileSync(new URL('../src/projects/templates/three-room-house.floorspec.json', import.meta.url), 'utf8')) as Record<string, unknown>;

  it('turns the empty document into the template, byte for byte, under the chosen name', () => {
    const blank = { floorspec: '0.1', project: { name: 'My house' } };
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
});
