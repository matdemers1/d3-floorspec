import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from '../src/index.js';

describe('@floorspec/render2d', () => {
  it('names itself', () => {
    expect(PACKAGE_NAME).toBe('@floorspec/render2d');
  });
});
