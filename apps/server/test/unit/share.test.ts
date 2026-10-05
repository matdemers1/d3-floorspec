import { describe, expect, it } from 'vitest';
import { cleanBody } from '../../src/share/comments.js';
import { Limiter, shareLimits } from '../../src/share/limit.js';
import { hasElement, hasLevel, mintShareToken, SHARE_TOKEN, stateOf } from '../../src/share/links.js';

/** FLR-T-9.6: the pieces of sharing that need no database. */

describe('share tokens', () => {
  it('are 256 random bits in 43 URL-safe characters, never twice the same', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const token = mintShareToken();
      expect(token).toMatch(SHARE_TOKEN);
      seen.add(token);
    }
    expect(seen.size).toBe(200);
    for (const bad of ['', 'a'.repeat(42), 'a'.repeat(44), `${'a'.repeat(42)}/`, `${'a'.repeat(42)}.`, `fls_${'a'.repeat(39)}`.replace('_', '!')]) {
      expect(SHARE_TOKEN.test(bad), bad).toBe(false);
    }
  });

  it('name a link that is live, expired or revoked', () => {
    const now = Date.parse('2026-10-05T12:00:00Z');
    expect(stateOf({ revokedAt: null, expiresAt: new Date(now + 1) }, now)).toBe('active');
    expect(stateOf({ revokedAt: null, expiresAt: new Date(now) }, now)).toBe('expired');
    expect(stateOf({ revokedAt: new Date(now - 1), expiresAt: new Date(now + 1) }, now)).toBe('revoked');
  });
});

describe('what a comment may be pinned to', () => {
  const doc = {
    floorspec: '0.3',
    project: { name: 'A house' },
    levels: { L1: { building: 'B1', elevation: 0 } },
    walls: { W1: { level: 'L1' } },
    rooms: { R1: { level: 'L1' } },
    types: { WT: { kind: 'wallType' } },
    extensions: { FS_electrical: { devices: { X1: { kind: 'receptacle' } } } },
  };

  it('is an element on the plan or an extension element, never a level, a type or a key of the document', () => {
    for (const id of ['W1', 'R1', 'X1']) expect(hasElement(doc, id), id).toBe(true);
    for (const id of ['L1', 'WT', 'B1', 'name', 'project', 'floorspec', 'devices', '__proto__', 'constructor', 'toString']) expect(hasElement(doc, id), id).toBe(false);
    expect(hasLevel(doc, 'L1')).toBe(true);
    expect(hasLevel(doc, 'W1')).toBe(false);
    expect(hasLevel(doc, 'hasOwnProperty')).toBe(false);
    expect(hasElement(null, 'W1')).toBe(false);
  });
});

describe('comment text', () => {
  it('drops the characters that make text read other than it says, and keeps the rest as typed', () => {
    expect(cleanBody('  Look\u202E here\u200B\u0000!  ')).toBe('Look here!');
    expect(cleanBody('one\r\ntwo\r\n\r\n\r\n\r\nthree   \nfour')).toBe('one\ntwo\n\nthree\nfour');
    expect(cleanBody('<script>alert(1)</script> **bold**')).toBe('<script>alert(1)</script> **bold**');
    expect(cleanBody('\u2066\u2067\u2068\u2069\uFEFF')).toBe('');
    expect(cleanBody('tab\tstays')).toBe('tab\tstays');
  });
});

describe('the rate limiter', () => {
  it('counts per key per window, and starts again after it', () => {
    const limiter = new Limiter(2, 1000);
    expect(limiter.take('a', 0)).toBe(true);
    expect(limiter.take('a', 10)).toBe(true);
    expect(limiter.take('a', 20)).toBe(false);
    expect(limiter.allows('a', 30)).toBe(false);
    expect(limiter.retryAfter('a', 30)).toBe(1);
    expect(limiter.take('b', 30)).toBe(true);
    expect(limiter.take('a', 1000)).toBe(true);
  });

  it('holds a bounded number of keys however many clients there are', () => {
    const limiter = new Limiter(1, 60_000, 100);
    for (let i = 0; i < 1000; i++) limiter.take(`ip-${String(i)}`, 0);
    expect((limiter as unknown as { windows: Map<string, unknown> }).windows.size).toBeLessThanOrEqual(100);
  });

  it('has budgets that let a viewer work and stop a guesser', () => {
    const limits = shareLimits();
    expect(limits.reads.limit).toBeGreaterThanOrEqual(100);
    expect(limits.misses.limit).toBeLessThanOrEqual(50);
  });
});
