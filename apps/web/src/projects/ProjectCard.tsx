import { Card, Skeleton, StatusDot } from '@d3cloud/ui';
import { PencilRuler, TriangleAlert } from 'lucide-react';
import { PlanThumbnail } from '../components/PlanThumbnail';
import { describeModel, plural, timeAgo, type ModelSummary } from './model';

export interface ProjectRow {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  head: string | null;
}

/** What is known about a project's head model: still loading, loaded, or failed to load. */
export type ModelState = { status: 'loading' } | { status: 'ready'; summary: ModelSummary | null } | { status: 'failed' };

/**
 * One project on the list: a plan of its lowest level, its name, what the engine derived from it,
 * and when it last changed. The whole card is the link to its dashboard — nothing inside it is a
 * second control.
 */
export function ProjectCard({ project, model }: { project: ProjectRow; model: ModelState }) {
  const summary = model.status === 'ready' ? model.summary : null;
  return (
    <Card interactive href={`/projects/${project.id}`} className="fs-project-card">
      <div className="fs-plan-well">
        <Thumbnail project={project} model={model} />
      </div>
      <div className="fs-project-card__body">
        <h2 className="fs-project-card__name">{project.name}</h2>
        <p className="fs-caption">
          {model.status === 'loading' ? 'Reading the model…' : model.status === 'failed' ? 'The model did not load' : summary === null ? 'No model yet' : describeModel(summary)}
        </p>
        <div className="fs-row">
          <Status model={model} />
          <span className="fs-spacer" />
          <span className="fs-caption">Edited {timeAgo(project.updatedAt)}</span>
        </div>
      </div>
    </Card>
  );
}

function Thumbnail({ project, model }: { project: ProjectRow; model: ModelState }) {
  if (model.status === 'loading') return <Skeleton variant="block" width="100%" height="100%" />;
  const summary = model.status === 'ready' ? model.summary : null;
  if (summary !== null && summary.document !== null && summary.derived !== null && !summary.empty) {
    return <PlanThumbnail document={summary.document} derived={summary.derived} title={`Plan of ${project.name}`} />;
  }
  if (summary !== null && !summary.valid) {
    return (
      <span className="fs-well-note">
        <TriangleAlert aria-hidden="true" />
        Needs fixing before it can be drawn
      </span>
    );
  }
  return (
    <span className="fs-well-note">
      <PencilRuler aria-hidden="true" />
      Nothing drawn yet
    </span>
  );
}

function Status({ model }: { model: ModelState }) {
  if (model.status === 'loading') return <Skeleton variant="text" width={96} />;
  if (model.status === 'failed') return <StatusDot tone="warning">Not checked</StatusDot>;
  const summary = model.summary;
  if (summary !== null && !summary.valid) {
    const errors = summary.diagnostics.filter((d) => d.severity === 'error').length;
    return <StatusDot tone="danger">{plural(errors, 'error')}</StatusDot>;
  }
  if (summary === null || summary.empty) return <StatusDot tone="idle">Empty</StatusDot>;
  return <StatusDot tone="neutral">Valid</StatusDot>;
}
