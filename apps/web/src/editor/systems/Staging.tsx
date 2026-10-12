import { useState } from 'react';
import { Button } from '@d3cloud/ui';
import { GitPullRequestArrow, Sparkles } from 'lucide-react';
import type { EditorStore } from '../store';
import { api, messageOf } from '../../lib/api';
import { openReview, refreshProposals } from '../review';
import { Section } from '../fields';

/**
 * "Stage this room" (FLR-T-13.11, the board's "Editor — Stage this room"): the staging assistant
 * (`@floorspec/assistant-staging`), run by the server on main, dresses the room around its
 * furniture with the FS_furniture starter library's decor and opens what it proposes as a pending
 * changeset, which then opens for review. Nothing touches main until it is accepted (FLR-ADR-016).
 */

interface Staged {
  changeset: { id: string } | null;
  proposal: { added: unknown[]; notes: string[] };
}

/** Ask the server to stage rooms; open the changeset for review, or say there was nothing to add. */
export async function stageRooms(store: EditorStore, rooms: readonly string[]): Promise<void> {
  try {
    const answer = await api.post<Staged>(`/api/projects/${store.projectId}/assistants/staging`, { rooms });
    if (answer.changeset === null) store.set({ notice: { tone: 'info', text: 'Nothing to stage: the room has no furniture to dress, and no free wall, window or corner for decor.' } });
    else {
      await refreshProposals(store);
      await openReview(store, answer.changeset.id);
    }
  } catch (error) {
    store.set({ notice: { tone: 'danger', text: messageOf(error) } });
  }
}

/** The room inspector's Staging section. */
export function StagingSection({ store, room, readOnly }: { store: EditorStore; room: string; readOnly: boolean }) {
  const [busy, setBusy] = useState(false);
  if (readOnly) return null;
  return (
    <Section title="Staging">
      <div className="fs-assistant">
        <h3 className="fs-assistant__title">
          <Sparkles aria-hidden="true" />
          Stage this room
        </h3>
        <p>
          Dresses the room around its furniture: a rug under the seating group, art over the sofa, lamps beside it and on nightstands, plants in free corners, cushions and throws,
          curtains or blinds on the windows, accessories on tables and counters.
        </p>
        <p className="fs-assistant__note">From the FS_furniture starter library (CC0). Opens as a changeset to review — main is unchanged until you accept it.</p>
        <Button
          size="sm"
          variant="primary"
          icon={<GitPullRequestArrow />}
          loading={busy}
          onClick={() => {
            setBusy(true);
            void stageRooms(store, [room]).finally(() => {
              setBusy(false);
            });
          }}
        >
          Stage this room
        </Button>
      </div>
    </Section>
  );
}
