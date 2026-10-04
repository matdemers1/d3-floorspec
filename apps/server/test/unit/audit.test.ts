import { describe, expect, it } from 'vitest';
import { scrub } from '../../src/domain/audit.js';

describe('audit detail', () => {
  it('never records secrets, wherever they are nested', () => {
    expect(scrub({ name: 'a', password: 'p', nested: { totpSecret: 's', code: '123456' } })).toEqual({
      name: 'a',
      password: '[redacted]',
      nested: { totpSecret: '[redacted]', code: '[redacted]' },
    });
  });
});
