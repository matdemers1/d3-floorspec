import { useMemo } from 'react';
import { qrShape } from '../lib/qr';

/**
 * The otpauth URI as a QR code. A QR must be dark on light to scan, so it sits in a light-theme
 * island (`data-theme="light"`) in either theme.
 */
export function TotpQr({ uri }: { uri: string }) {
  const { size, path } = useMemo(() => qrShape(uri), [uri]);
  return (
    <div className="fs-totp-qr" data-theme="light">
      <svg role="img" aria-label="QR code for your authenticator app" viewBox={`0 0 ${String(size)} ${String(size)}`} shapeRendering="crispEdges">
        <rect className="fs-totp-qr__light" width={size} height={size} />
        <path className="fs-totp-qr__dark" d={path} />
      </svg>
    </div>
  );
}
