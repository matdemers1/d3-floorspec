import './share.css';
import { useCallback, useEffect, useState } from 'react';
import { Button, EmptyState } from '@d3cloud/ui';
import { Link2, Share } from 'lucide-react';
import { DashCard } from '../dashboard/DashCard';
import { listShares, type ShareLinkRow } from './api';
import { describeLink, ShareDialog } from './ShareDialog';

/**
 * The dashboard's Share card (FLR-T-9.6): the live links, what each has been used for, and the
 * dialog that makes and revokes them.
 */
export function ShareCard({ projectId, projectName, versionLabel }: { projectId: string; projectName: string; versionLabel: string | null }) {
  const [links, setLinks] = useState<ShareLinkRow[] | null>(null);
  const [open, setOpen] = useState(false);
  const load = useCallback(() => {
    listShares(projectId).then(setLinks, () => { setLinks([]); });
  }, [projectId]);
  useEffect(load, [load]);
  const active = (links ?? []).filter((l) => l.state === 'active');
  const button = (
    <Button size="sm" variant="secondary" icon={<Share />} onClick={() => { setOpen(true); }}>
      Share
    </Button>
  );
  return (
    <DashCard region="share" icon={<Share aria-hidden="true" />} title="Share" aside={active.length > 0 ? button : undefined}>
      {active.length === 0 ? (
        <EmptyState kind="empty" size="row" heading="Not shared" action={button}>
          A read-only link lets an architect or builder see the plan, the 3D view and the findings without an account — and pin comments once signed in.
        </EmptyState>
      ) : (
        <ul className="fs-share-links fs-share-links--card">
          {active.map((link) => (
            <li key={link.id} className="fs-share-links__row">
              <Link2 aria-hidden="true" />
              <div className="fs-share-links__text">
                <span className="fs-share-links__name">{link.label ?? `Link ${link.prefix}…`}</span>
                <span className="fs-note">{describeLink(link)}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
      <ShareDialog projectId={projectId} projectName={projectName} versionLabel={versionLabel} open={open} onOpenChange={setOpen} onChanged={load} />
    </DashCard>
  );
}
