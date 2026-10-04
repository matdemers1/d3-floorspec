import '../components/screens.css';
import { Button, EmptyState, Link, Page } from '@d3cloud/ui';
import { PencilRuler } from 'lucide-react';
import { navigate } from '../lib/router';

/**
 * `/projects/:id/editor` until the plan canvas lands (FLR-T-3.3). The route exists now so "Open
 * editor" on the dashboard has somewhere honest to go.
 */
export function EditorPlaceholder({ id }: { id: string }) {
  return (
    <Page className="fs-screen">
      <EmptyState
        kind="empty"
        icon={<PencilRuler />}
        heading="The editor arrives in FLR-T-3.3"
        action={
          <Button variant="secondary" onClick={() => { navigate(`/projects/${id}`); }}>
            Back to the dashboard
          </Button>
        }
      >
        Drawing walls, openings and rooms comes with the plan canvas. Until then the dashboard shows the model, and{' '}
        <Link href={`/api/projects/${id}/model.json`}>model.json</Link> downloads it.
      </EmptyState>
    </Page>
  );
}
