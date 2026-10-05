import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { dayKey, weekKey } from '../../src/maintenance/runs.js';

/** FLR-T-12.1: the schedule's idempotency keys, and the new settings' defaults. */

describe('maintenance keys', () => {
  it('names the UTC day', () => {
    expect(dayKey(new Date('2026-10-05T23:59:59Z'))).toBe('2026-10-05');
    expect(dayKey(new Date('2026-10-06T00:00:00Z'))).toBe('2026-10-06');
  });

  it('names the ISO 8601 week, across a year boundary', () => {
    expect(weekKey(new Date('2026-10-05T08:00:00Z'))).toBe('2026-W41');
    expect(weekKey(new Date('2026-01-01T00:00:00Z'))).toBe('2026-W01');
    expect(weekKey(new Date('2027-01-01T12:00:00Z'))).toBe('2026-W53');
    expect(weekKey(new Date('2025-12-29T12:00:00Z'))).toBe('2026-W01');
  });
});

describe('backup and alert settings', () => {
  const base = {
    PUBLIC_URL: 'http://localhost:3400',
    DATABASE_URL: 'postgresql://u:p@localhost/db',
    KEK: Buffer.alloc(32, 1).toString('base64'),
    PEPPER: Buffer.alloc(32, 2).toString('base64'),
  };

  it('defaults to a 07:00 UTC backup kept 30 days, no asset store, and no relay', () => {
    const config = loadConfig(base);
    expect(config.BACKUP_HOUR_UTC).toBe(7);
    expect(config.BACKUP_RETENTION_DAYS).toBe(30);
    expect(config.ASSET_DIR).toBeUndefined();
    expect(config.MAIL_RELAY_URL).toBeUndefined();
    expect(config.BACKUP_SCHEDULE).toBeUndefined();
  });

  it('treats empty values in an env file as unset, and refuses a recipient that is not an address', () => {
    const empty = loadConfig({ ...base, MAIL_RELAY_URL: '', MAIL_RELAY_TOKEN: '', ALERT_TO: '', BACKUP_HOUR_UTC: '', BACKUP_RETENTION_DAYS: '', BACKUP_SCHEDULE: '', ASSET_DIR: '' });
    expect(empty.ALERT_TO).toBeUndefined();
    expect(empty.BACKUP_HOUR_UTC).toBe(7);
    expect(empty.BACKUP_RETENTION_DAYS).toBe(30);
    expect(empty.ASSET_DIR).toBeUndefined();
    expect(() => loadConfig({ ...base, ALERT_TO: 'not-an-address' })).toThrow(/ALERT_TO/);
    expect(() => loadConfig({ ...base, BACKUP_HOUR_UTC: '24' })).toThrow(/BACKUP_HOUR_UTC/);
  });
});
