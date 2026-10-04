import { useState } from 'react';
import { Button, EmptyState, SegmentedControl } from '@d3cloud/ui';
import { Grid3x3, Pencil } from 'lucide-react';
import { firstLevel, PlanThumbnail } from '../components/PlanThumbnail';
import { Diagnostics } from '../projects/ImportFile';
import { formatSquareFeet, plural, type ModelSummary } from '../projects/model';
import { navigate } from '../lib/router';
import { DashCard } from './DashCard';

/**
 * The plan of the head model, one level at a time, and the counts the engine derived for it. When
 * the house has more than one level, a segmented control switches between them.
 */
export function PlanCard({ projectId, name, summary }: { projectId: string; name: string; summary: ModelSummary | null }) {
  const document = summary?.document ?? null;
  const [level, setLevel] = useState<string | undefined>(() => (document === null ? undefined : firstLevel(document)));
  const levels = summary?.levels ?? [];
  const current = levels.find((l) => l.id === level);

  const aside =
    levels.length > 1 ? (
      <SegmentedControl
        aria-label="Level"
        value={level ?? ''}
        onValueChange={setLevel}
        items={levels.map((l) => ({ value: l.id, label: l.name }))}
      />
    ) : current !== undefined ? (
      <span className="fs-caption">{current.name}</span>
    ) : null;

  return (
    <DashCard region="plan" icon={<Grid3x3 aria-hidden="true" />} title="Plan" aside={aside}>
      <div className="fs-plan-well fs-dashboard-plan">
        <Picture projectId={projectId} name={name} summary={summary} level={level} />
      </div>
      {summary !== null && summary.valid && !summary.empty ? (
        <ul className="fs-plan-facts" aria-label="What the plan holds">
          <li>{plural(current?.rooms ?? summary.rooms, 'room')}</li>
          <li>{plural(current?.walls ?? summary.walls, 'wall')}</li>
          <li>{plural(current?.openings ?? summary.openings, 'opening')}</li>
          {current === undefined ? null : <li>{formatSquareFeet(current.area2)} ft² on this level</li>}
        </ul>
      ) : null}
      {summary !== null && !summary.valid ? <Diagnostics diagnostics={summary.diagnostics} /> : null}
    </DashCard>
  );
}

function Picture({ projectId, name, summary, level }: { projectId: string; name: string; summary: ModelSummary | null; level: string | undefined }) {
  const openEditor = (
    <Button variant="secondary" size="sm" icon={<Pencil />} onClick={() => { navigate(`/projects/${projectId}/editor`); }}>
      Open editor
    </Button>
  );
  if (summary !== null && (!summary.valid || summary.document === null || summary.derived === null)) {
    const errors = summary.diagnostics.filter((d) => d.severity === 'error').length;
    return (
      <EmptyState kind="error" size="inline" heading="This model does not validate">
        The engine found {plural(errors, 'error')}, listed below. The plan is drawn once they are fixed.
      </EmptyState>
    );
  }
  if (summary === null || summary.empty || summary.document === null || summary.derived === null) {
    return (
      <EmptyState kind="empty" size="inline" heading="Nothing drawn yet" action={openEditor}>
        Walls, rooms and openings drawn in the editor appear here.
      </EmptyState>
    );
  }
  return <PlanThumbnail document={summary.document} derived={summary.derived} level={level} labels title={`Plan of ${name}`} />;
}
