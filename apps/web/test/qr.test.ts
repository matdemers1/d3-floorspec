import { describe, expect, it } from 'vitest';
import { QUIET_ZONE, qrShape } from '../src/lib/qr';

describe('the TOTP QR code', () => {
  it('draws the otpauth URI with a quiet zone, computed locally', () => {
    const { size, path } = qrShape('otpauth://totp/D3%20Floorspec:a%40example.test?secret=JBSWY3DPEHPK3PXP');
    expect(size).toBeGreaterThan(2 * QUIET_ZONE + 20);
    expect(path).toMatch(/^M\d+ \d+h1v1h-1z/);
  });
});
