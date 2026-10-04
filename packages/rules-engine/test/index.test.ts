import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from '../src/index.js';

describe('@floorspec/rules-engine', () => {
  it('names itself', () => {
    expect(PACKAGE_NAME).toBe('@floorspec/rules-engine');
  });
});
