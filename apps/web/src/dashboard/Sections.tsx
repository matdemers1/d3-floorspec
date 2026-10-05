import { Badge, Button, EmptyState } from '@d3cloud/ui';
import type { Derived, FloorspecDocument } from '@floorspec/engine';
import { navigate } from '../lib/router';
import { formatArea, readProgram } from '../program/model';
import { unitsOf } from '../editor/units';
import { GitBranch, LayoutGrid, Share, TriangleAlert, Waypoints } from 'lucide-react';
import { DashCard } from './DashCard';

/**
 * The dashboard's sections that later phases fill. Each says what it will hold and when, in plain
 * words, so a section that is not built yet reads as a plan rather than a broken screen. The phase
 * badges are the FLR phases that build them.
 */

const Phase = ({ n }: { n: number }) => (
  <Badge tone="neutral" size="sm">
    Phase {n}
  </Badge>
);

/**
 * Brief and program (FLR-T-4.2): what the house must have, checked against the plan by the engine
 * (Core 0.2, 11.3 and 11.4) — each item met or not, each line of the bubble diagram met or not.
 */
export function BriefCard({ projectId, document, derived }: { projectId: string; document: FloorspecDocument | null; derived: Derived | null }) {
  const view = document === null ? null : readProgram({ document, derived });
  const open = () => { navigate(`/projects/${projectId}/program`); };
  if (view === null || view.items.length === 0) {
    return (
      <DashCard region="brief" icon={<Waypoints aria-hidden="true" />} title="Brief">
        <EmptyState
          kind="empty"
          size="row"
          heading="No brief yet"
          action={
            <Button size="sm" variant="secondary" disabled={document === null} onClick={open}>
              Write the brief
            </Button>
          }
        >
          A brief lists what the house must have — rooms, sizes, which rooms sit together — and is checked against the plan.
        </EmptyState>
      </DashCard>
    );
  }
  const unmet = view.unmet.items + view.unmet.edges;
  return (
    <DashCard
      region="brief"
      icon={<Waypoints aria-hidden="true" />}
      title="Brief"
      aside={
        <Badge tone={unmet === 0 ? 'neutral' : 'attention'} size="sm">
          {unmet === 0 ? 'All met' : `${String(unmet)} unmet`}
        </Badge>
      }
    >
      <p className="fs-brief-card__summary">
        {view.items.length} {view.items.length === 1 ? 'item' : 'items'} · {view.edges.length} {view.edges.length === 1 ? 'adjacency' : 'adjacencies'}
        {view.target > 0 ? ` · ${formatArea(view.target, unitsOf(document))} target` : ''}
      </p>
      <ul className="fs-brief-card__items">
        {view.items.slice(0, 6).map((item) => (
          <li key={item.id}>
            <span>{item.label}</span>
            {item.count > 1 ? <span className="fs-brief-card__count">×{item.count}</span> : null}
            <span className="fs-spacer" />
            <Badge size="sm" tone={item.need.tone}>
              {item.need.label}
            </Badge>
          </li>
        ))}
      </ul>
      {view.items.length > 6 ? <p className="fs-brief-card__more">and {view.items.length - 6} more</p> : null}
      <div className="fs-brief-card__actions">
        <Button size="sm" variant="secondary" icon={<Waypoints />} onClick={open}>
          Open the brief
        </Button>
        <Button size="sm" variant="ghost" icon={<LayoutGrid />} onClick={() => { navigate(`/projects/${projectId}/layouts`); }}>
          Layouts
        </Button>
      </div>
    </DashCard>
  );
}

/** Findings (FLR-P-6): advisory code rules. Rules advise and never block (FLR-ADR-011). */
export function FindingsCard() {
  return (
    <DashCard region="findings" icon={<TriangleAlert aria-hidden="true" />} title="Findings" aside={<Phase n={6} />}>
      <EmptyState kind="empty" size="row" heading="No rule packs installed yet">
        Install a rule pack for your jurisdiction and findings appear here, each with its code citation. They advise; they never block a change.
      </EmptyState>
    </DashCard>
  );
}

/** Option sets (FLR-P-8): alternatives compared side by side. */
export function OptionsCard() {
  return (
    <DashCard region="options" icon={<GitBranch aria-hidden="true" />} title="Options" aside={<Phase n={8} />}>
      <EmptyState kind="empty" size="row" heading="No option sets">
        Keep two kitchens, or two stair positions, in one model and switch between them.
      </EmptyState>
    </DashCard>
  );
}

/** Share (FLR-P-9): a read-only link for an architect or builder. */
export function ShareCard() {
  return (
    <DashCard region="share" icon={<Share aria-hidden="true" />} title="Share" aside={<Phase n={9} />}>
      <EmptyState kind="empty" size="row" heading="Not shared">
        A read-only link lets an architect or builder see the plan and comment, without an account.
      </EmptyState>
    </DashCard>
  );
}

/** Exports (FLR-T-9.3): the model, the dimensioned PDF and the DXF drawings — see exports/ExportsCard. */
export { ExportsCard } from '../exports/ExportsCard';
