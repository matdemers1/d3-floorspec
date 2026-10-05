import { Sparkles } from 'lucide-react';
import { Changesets } from '../screens/Changesets';
import { DashCard } from './DashCard';
import { useLiveTick } from './live';

/**
 * Proposed changes: pending changesets from agent tokens, which write changesets and never main
 * (FLR-ADR-016). Accept fast-forwards or replays onto main; a replay that no longer applies shows
 * its diagnostics and changes nothing. Keep `region="changesets"`: tests find it by that.
 */
export function ChangesetsSlot({ projectId, onDecided }: { projectId: string; onDecided: () => void }) {
  // Live (FLR-T-3.5): an agent's proposal appears here as it is made, and goes when it is decided.
  const tick = useLiveTick(projectId);
  return (
    <DashCard region="changesets" icon={<Sparkles aria-hidden="true" />} title="Changesets">
      <Changesets key={tick} projectId={projectId} onDecided={onDecided} bare />
    </DashCard>
  );
}
