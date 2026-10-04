import { describe, expect, it } from 'vitest';
import { PRODUCT_NAME } from '../src/lib/product';

describe('the editor', () => {
  it('knows its name', () => {
    expect(PRODUCT_NAME).toBe('D3 Floorspec');
  });
});
