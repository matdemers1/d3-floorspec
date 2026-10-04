import { describe, expect, it } from 'vitest';
import { ENGINE_VERSION } from '../src/index.js';

describe('@floorspec/engine', () => {
  it('reports a draft version', () => {
    expect(ENGINE_VERSION).toBe('0.1.0-draft');
  });
});
