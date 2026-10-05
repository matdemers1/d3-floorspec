import './share.css';
import { useMemo, useState, useSyncExternalStore } from 'react';
import { Button, IconButton, Tooltip } from '@d3cloud/ui';
import { MessageSquare, Share, X } from 'lucide-react';
import type { EditorStore } from '../editor/store';
import { ownerEndpoint } from './api';
import { commentsAt, useComments } from './comments';
import { CommentsPanel } from './CommentsPanel';
import { CommentPins } from './CommentPins';
import { ShareDialog } from './ShareDialog';

/**
 * Sharing in the owner's editor (FLR-T-9.6): the top bar's Share button and its dialog, a Comments
 * button with the count of open threads, the comments column in place of the inspector — every
 * thread from every link, live — and their pins on the plan. Whether the column is open is kept
 * beside the editor's store rather than in it.
 */

class Open {
  value = false;
  private readonly listeners = new Set<() => void>();
  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => { this.listeners.delete(l); };
  };
  get = () => this.value;
  set(value: boolean) {
    this.value = value;
    for (const l of this.listeners) l();
  }
}

const opens = new WeakMap<EditorStore, Open>();
function openOf(store: EditorStore): Open {
  let open = opens.get(store);
  if (open === undefined) {
    open = new Open();
    opens.set(store, open);
  }
  return open;
}

export function useCommentsOpen(store: EditorStore): boolean {
  const open = openOf(store);
  return useSyncExternalStore(open.subscribe, open.get);
}

export function setCommentsOpen(store: EditorStore, value: boolean): void {
  // The comments take the right column: the findings panel and a proposal step aside.
  if (value) store.set({ findingsOpen: false, side: 'inspector' });
  openOf(store).set(value);
}

const ownerComments = (projectId: string) => commentsAt(ownerEndpoint(projectId));

export function CommentsButton({ store }: { store: EditorStore }) {
  const comments = useMemo(() => ownerComments(store.projectId), [store]);
  const state = useComments(comments);
  const open = useCommentsOpen(store);
  const unresolved = state.threads.filter((t) => t.resolved === null && !t.deleted).length;
  return (
    <Tooltip content="Comments from share links, pinned to the plan">
      <Button
        className="fs-topbar__comments"
        size="sm"
        variant={open ? 'secondary' : 'ghost'}
        icon={<MessageSquare />}
        aria-pressed={open}
        onClick={() => { setCommentsOpen(store, !open); }}
      >
        {unresolved > 0 ? `Comments · ${String(unresolved)}` : 'Comments'}
      </Button>
    </Tooltip>
  );
}

export function ShareButton({ projectId, projectName, versionLabel }: { projectId: string; projectName: string; versionLabel: string | null }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button className="fs-topbar__share" size="sm" variant="secondary" icon={<Share />} onClick={() => { setOpen(true); }}>
        Share
      </Button>
      <ShareDialog projectId={projectId} projectName={projectName} versionLabel={versionLabel} open={open} onOpenChange={setOpen} />
    </>
  );
}

/** The comments column: the owner answers, resolves and reopens, and may remove any comment. */
export function EditorComments({ store }: { store: EditorStore }) {
  const comments = useMemo(() => ownerComments(store.projectId), [store]);
  return (
    <div className="fs-editor-comments">
      <IconButton className="fs-editor-comments__close" size="sm" label="Close the comments" icon={<X />} onClick={() => { setCommentsOpen(store, false); }} />
      <CommentsPanel comments={comments} editor={store} as="owner" canWrite target={null} />
    </div>
  );
}

/** Pins on the owner's plan, while the comments column is open. */
export function OwnerPins({ store }: { store: EditorStore }) {
  const open = useCommentsOpen(store);
  const comments = useMemo(() => ownerComments(store.projectId), [store]);
  if (!open) return null;
  return <CommentPins editor={store} comments={comments} />;
}
