// A QR code as SVG path data, computed in the browser from the otpauth URI — ported from Postroom.
// Nothing is fetched and no image URL is made, so the secret never leaves the page.
import qrcode from 'qrcode-generator';

/** The quiet zone the QR specification asks for: four modules of light on every side. */
export const QUIET_ZONE = 4;

export interface QrShape {
  readonly size: number;
  readonly path: string;
}

export function qrShape(text: string): QrShape {
  const code = qrcode(0, 'M');
  code.addData(text);
  code.make();
  const count = code.getModuleCount();
  const parts: string[] = [];
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (code.isDark(row, col)) parts.push(`M${String(col + QUIET_ZONE)} ${String(row + QUIET_ZONE)}h1v1h-1z`);
    }
  }
  return { size: count + 2 * QUIET_ZONE, path: parts.join('') };
}
