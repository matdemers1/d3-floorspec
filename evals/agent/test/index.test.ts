import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from '../src/index.js';

describe('@d3-floorspec/agent-eval', () => {
  it('names itself', () => {
    expect(PACKAGE_NAME).toBe('@d3-floorspec/agent-eval');
  });
});
