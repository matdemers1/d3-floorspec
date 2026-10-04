import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from '../src/index.js';

describe('@floorspec/mcp-stdio', () => {
  it('names itself', () => {
    expect(PACKAGE_NAME).toBe('@floorspec/mcp-stdio');
  });
});
