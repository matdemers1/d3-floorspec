import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from '../src/index.js';

describe('@floorspec/cli', () => {
  it('names itself', () => {
    expect(PACKAGE_NAME).toBe('@floorspec/cli');
  });
});
