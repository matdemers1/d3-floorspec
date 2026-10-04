import { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, Cluster, DataList, DataListRow, EmptyState, Section, Spinner, Stack, useToast } from '@d3cloud/ui';
import { api, ApiError, messageOf } from '../lib/api';

interface ChangesetRow {
  id: string;
  name: string;
  ops: number | null;
  createdBy: string | null;
  createdAt: string;
  fastForward: boolean | null;
}

interface Diagnostic {
  code: string;
  message: string;
  elements: string[];
}

interface Refusal {
  name: string;
  message: string;
  diagnostics: Diagnostic[];
}

/**
 * Pending changesets (FLR-T-2.5): what agents have proposed, waiting for you. Accept merges one
 * into the plan — straight on when the plan has not moved, otherwise by replaying it onto the plan
 * as it is now — and reject discards it. The full review, with the proposal drawn over the plan,
 * is the editor's (FLR-T-3.5).
 */
export function Changesets({ projectId, onDecided, bare = false }: { projectId: string; onDecided: () => void; bare?: boolean }) {
  const toast = useToast();
  const [rows, setRows] = useState<ChangesetRow[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);

  const load = useCallback(() => {
    api
      .get<{ changesets: ChangesetRow[] }>(`/api/projects/${projectId}/changesets`)
      .then((body) => { setRows(body.changesets); })
      .catch((caught: unknown) => { setError(messageOf(caught)); });
  }, [projectId]);
  useEffect(load, [load]);

  const decide = (row: ChangesetRow, verb: 'accept' | 'reject') => {
    setError(null);
    setRefusal(null);
    setBusy(`${row.id}:${verb}`);
    api
      .post<{ mode?: string }>(`/api/projects/${projectId}/changesets/${row.id}/${verb}`)
      .then((body) => {
        toast.show({
          message: verb === 'accept' ? `“${row.name}” is in the plan${body.mode === 'replay' ? ', replayed onto your latest changes' : ''}.` : `“${row.name}” was discarded.`,
        });
        load();
        onDecided();
      })
      .catch((caught: unknown) => {
        const body = caught instanceof ApiError ? (caught.body as { diagnostics?: Diagnostic[]; detail?: string } | undefined) : undefined;
        if (caught instanceof ApiError && caught.status === 409 && body?.diagnostics !== undefined) {
          setRefusal({ name: row.name, message: body.detail ?? caught.message, diagnostics: body.diagnostics });
        } else setError(messageOf(caught));
      })
      .finally(() => { setBusy(null); });
  };

  const body = (
      <Stack gap="16">
        {error === null ? null : (
          <Alert tone="danger" dynamic>
            {error}
          </Alert>
        )}
        {refusal === null ? null : (
          <Alert tone="danger" title={`“${refusal.name}” no longer applies`} dynamic>
            {refusal.message}
            <ul>
              {refusal.diagnostics.map((d, i) => (
                <li key={i}>
                  <span className="fs-mono">{d.code}</span> {d.message}
                </li>
              ))}
            </ul>
          </Alert>
        )}
        {rows === null ? (
          <Spinner label="Loading proposed changes" />
        ) : (
          <DataList empty={<EmptyState kind="empty" size="inline" heading="Nothing proposed" />}>
            {rows.map((row) => (
              <DataListRow
                key={row.id}
                title={row.name}
                description={`${String(row.ops ?? 0)} op${row.ops === 1 ? '' : 's'} · ${row.createdBy ?? 'unknown'} · ${new Date(row.createdAt).toLocaleString()}`}
                meta={<Badge tone={row.fastForward === true ? 'attention' : 'neutral'}>{row.fastForward === true ? 'applies cleanly' : 'will replay'}</Badge>}
                actions={
                  <Cluster gap="8">
                    <Button size="sm" variant="primary" loading={busy === `${row.id}:accept`} disabled={busy !== null} onClick={() => { decide(row, 'accept'); }}>
                      Accept
                    </Button>
                    <Button size="sm" variant="secondary" loading={busy === `${row.id}:reject`} disabled={busy !== null} onClick={() => { decide(row, 'reject'); }}>
                      Reject
                    </Button>
                  </Cluster>
                }
              />
            ))}
          </DataList>
        )}
      </Stack>
  );
  // Inside the dashboard's card, the card is the heading; on its own, it is a Section.
  if (bare) return body;
  return (
    <Section title="Proposed changes" description="Changesets from agents. Nothing in them is in the plan until you accept it.">
      {body}
    </Section>
  );
}
