import { Badge, Button, EmptyState } from '@d3cloud/ui';
import { Download, FileBox, GitBranch, Share, TriangleAlert, Waypoints } from 'lucide-react';
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

/** Brief and program (FLR-P-4): what the house must have, checked against the plan. */
export function BriefCard() {
  return (
    <DashCard region="brief" icon={<Waypoints aria-hidden="true" />} title="Brief" aside={<Phase n={4} />}>
      <EmptyState kind="empty" size="row" heading="No brief yet">
        A brief lists what the house must have — rooms, sizes, which rooms sit together — and is checked against the plan.
      </EmptyState>
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

/**
 * Exports. `model.json` works today: the canonical bytes of the head version. The rest arrive with
 * FLR-P-9 (Interop & Handoff).
 */
export function ExportsCard({ projectId, hasModel }: { projectId: string; hasModel: boolean }) {
  return (
    <DashCard region="exports" icon={<FileBox aria-hidden="true" />} title="Exports">
      <ul className="fs-list">
        <li className="fs-export">
          <span>
            <span className="fs-mono">model.json</span> · the canonical model
          </span>
          {/* A navigation, not a fetch: the API answers Content-Disposition: attachment, so the
              browser saves the file under the name the API gives it and the page stays put. */}
          <Button
            variant="secondary"
            size="sm"
            icon={<Download />}
            disabled={!hasModel}
            onClick={() => { window.location.assign(`/api/projects/${projectId}/model.json`); }}
          >
            Download
          </Button>
        </li>
        <li className="fs-export">
          <span>Floorspec package, IFC, PDF plan set</span>
          <Phase n={9} />
        </li>
      </ul>
    </DashCard>
  );
}
