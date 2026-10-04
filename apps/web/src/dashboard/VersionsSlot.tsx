import { useEffect, useState } from 'react';
import { Avatar, EmptyState, Skeleton } from '@d3cloud/ui';
import { RotateCcw } from 'lucide-react';
import { api } from '../lib/api';
import { timeAgo } from '../projects/model';
import { DashCard } from './DashCard';
import { describeOps } from './describe';

/**
 * PLACEHOLDER REGION — "Versions". The design calls it "Recent changes" with a quiet "History"
 * action; the lead wires it to versions/history when that endpoint lands.
 *
 * Until then it reads the op log that exists today (`GET /api/projects/:id/ops`, newest first) and
 * shows the last three entries. If the op log does not answer, the card says so and the rest of
 * the dashboard is unaffected. Keep `region="versions"`: tests find it by that.
 */

interface OpRow {
  seq: number;
  authorKind: 'account' | 'agent';
  authorAgent?: string | null;
  ops: { op: string }[];
  createdAt: string;
}

const SHOWN = 3;

export function VersionsSlot({ projectId, you }: { projectId: string; you: string }) {
  const [rows, setRows] = useState<OpRow[] | null | 'failed'>(null);

  useEffect(() => {
    api
      .get<{ ops: OpRow[] }>(`/api/projects/${projectId}/ops`)
      .then(({ ops }) => { setRows(ops.slice(0, SHOWN)); })
      .catch(() => { setRows('failed'); });
  }, [projectId]);

  return (
    <DashCard region="versions" icon={<RotateCcw aria-hidden="true" />} title="Recent changes">
      {rows === null ? (
        <Skeleton variant="text" lines={3} />
      ) : rows === 'failed' ? (
        <EmptyState kind="error" size="row" heading="The history did not load" />
      ) : rows.length === 0 ? (
        <EmptyState kind="empty" size="row" heading="No changes yet" />
      ) : (
        <ul className="fs-list">
          {rows.map((row) => {
            const who = row.authorKind === 'agent' ? (row.authorAgent ?? 'Claude') : you;
            return (
              <li key={row.seq} className="fs-change">
                <Avatar name={who} size="xs" />
                <span className="fs-change__what">{describeOps(row.ops)}</span>
                <span className="fs-change__when">{timeAgo(row.createdAt)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </DashCard>
  );
}
