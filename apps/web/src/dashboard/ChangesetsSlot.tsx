import { EmptyState } from '@d3cloud/ui';
import { Sparkles } from 'lucide-react';
import { DashCard } from './DashCard';

/**
 * PLACEHOLDER REGION — "Changesets". The lead wires this to the changesets list (pending proposals
 * from agent tokens, which write changesets and never main — FLR-ADR-016).
 *
 * The design (Figma "04 · Project dashboard", card "Claude has a proposal") shows the newest pending
 * changeset: a quote of its summary, "Changeset · CS-n · k ops", "Proposed · when · by whom", a
 * primary "Review changes" (sm, eye icon) and a ghost "Reject", with an attention Badge "Pending".
 * With nothing pending it is this empty state. Keep `region="changesets"`: tests find it by that.
 */
export function ChangesetsSlot(_props: { projectId: string }) {
  return (
    <DashCard region="changesets" icon={<Sparkles aria-hidden="true" />} title="Changesets">
      <EmptyState kind="empty" size="row" heading="No proposals waiting">
        When Claude proposes changes over MCP they wait here, as a changeset, until you accept or reject them.
      </EmptyState>
    </DashCard>
  );
}
