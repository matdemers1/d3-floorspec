import { Sparkles } from 'lucide-react';
import { Changesets } from '../screens/Changesets';
import { DashCard } from './DashCard';

/**
 * Proposed changes: pending changesets from agent tokens, which write changesets and never main
 * (FLR-ADR-016). Accept fast-forwards or replays onto main; a replay that no longer applies shows
 * its diagnostics and changes nothing. Keep `region="changesets"`: tests find it by that.
 */
export function ChangesetsSlot({ projectId, onDecided }: { projectId: string; onDecided: () => void }) {
  return (
    <DashCard region="changesets" icon={<Sparkles aria-hidden="true" />} title="Changesets">
      <Changesets projectId={projectId} onDecided={onDecided} bare />
    </DashCard>
  );
}
