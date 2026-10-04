import type { ReactNode } from 'react';
import { Card } from '@d3cloud/ui';

/**
 * A titled card on the dashboard: an icon, a heading, and anything that belongs at the right of the
 * heading (a badge, a quiet action). Every card is a `section` with an `h2` under the page's `h1`, so
 * the dashboard reads as an outline to a screen reader.
 */
export function DashCard({
  icon,
  title,
  aside,
  children,
  region,
}: {
  icon: ReactNode;
  title: string;
  aside?: ReactNode;
  children?: ReactNode;
  /** A stable name for the region, for tests and for the slots later phases fill. */
  region: string;
}) {
  const id = `fs-dash-${region}`;
  return (
    <Card as="section" className="fs-card" aria-labelledby={id} data-region={region}>
      <div className="fs-card-head">
        {icon}
        <h2 id={id} className="fs-card-head__title">
          {title}
        </h2>
        <span className="fs-spacer" />
        {aside}
      </div>
      {children}
    </Card>
  );
}
