import { useEffect, useState } from 'react';
import { Avatar, EmptyState, Skeleton } from '@d3cloud/ui';
import { RotateCcw } from 'lucide-react';
import { api } from '../lib/api';
import { timeAgo } from '../projects/model';
import { DashCard } from './DashCard';
import { describeOps } from './describe';
import { useLiveTick } from './live';

/**
 * "Recent changes": the newest entries of main's history (`GET /api/projects/:id/history`), who
 * made each — you, a token, or an agent by name — and when. Live (FLR-T-3.5): an edit in the
 * editor, an undo or an accepted changeset shows up here as it lands. The full history, with the
 * version diff, is the editor's (FLR-T-3.6). Keep `region="versions"`: tests find it by that.
 */

interface OpRow {
  seq: number;
  kind: 'create' | 'apply' | 'undo' | 'redo' | 'merge';
  author: { kind: 'account' | 'agent' | 'token'; name: string | null };
  ops: { op: string }[];
  undoOf: number | null;
  changeset: { name: string } | null;
  at: string;
}

const SHOWN = 3;

function what(row: OpRow): string {
  if (row.kind === 'undo') return `Undid v${String(row.undoOf ?? '?')}`;
  if (row.kind === 'redo') return `Redid v${String(row.undoOf ?? '?')}`;
  if (row.changeset !== null) return `Accepted “${row.changeset.name}”`;
  return describeOps(row.ops);
}

export function VersionsSlot({ projectId, you }: { projectId: string; you: string }) {
  const [rows, setRows] = useState<OpRow[] | null | 'failed'>(null);
  const tick = useLiveTick(projectId);

  useEffect(() => {
    api
      .get<{ ops: OpRow[] }>(`/api/projects/${projectId}/history?limit=${String(SHOWN)}`)
      .then(({ ops }) => { setRows(ops.slice(0, SHOWN)); })
      .catch(() => { setRows('failed'); });
  }, [projectId, tick]);

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
            const who = row.author.kind === 'account' ? you : (row.author.name ?? (row.author.kind === 'agent' ? 'Claude' : 'A token'));
            return (
              <li key={row.seq} className="fs-change">
                <Avatar name={who} size="xs" />
                <span className="fs-change__what">{what(row)}</span>
                <span className="fs-change__when">{timeAgo(row.at)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </DashCard>
  );
}
