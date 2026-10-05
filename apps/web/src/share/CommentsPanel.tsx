import './share.css';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Alert, Avatar, Badge, Button, EmptyState, Spinner, StatusDot, Textarea } from '@d3cloud/ui';
import { CircleCheck, LogIn, MapPin, MessageSquare, RotateCcw, X } from 'lucide-react';
import { useEditor, type EditorStore } from '../editor/store';
import { labelOf, type EditorModel } from '../editor/model';
import { numbered, useComments, type CommentsStore, type PinTarget } from './comments';
import { placeOf } from './pins';
import { Markdown } from './Markdown';
import type { CommentView, Thread } from './api';

/**
 * The comments column (FLR-T-9.6; the board's "20 · Comments — architect review"): every thread,
 * numbered as its pin is, with its element, its replies, and whether it is resolved or detached; and
 * a box that replies to the thread in focus or starts a new one pinned to what is selected on the
 * plan. A viewer who is not signed in reads them and is offered the way to sign in; the owner, in
 * the editor, resolves and reopens threads and may remove any comment.
 */

export interface CommentsPanelProps {
  comments: CommentsStore;
  editor: EditorStore;
  /** `viewer`: through a share link. `owner`: in the editor. */
  as: 'viewer' | 'owner';
  /** Whether this reader may write: a signed-in viewer of a link that takes comments, or the owner. */
  canWrite: boolean;
  /** Where a new thread would be pinned: the selection. Null when nothing pinnable is selected. */
  target: PinTarget | null;
  /** For a viewer who is not signed in. */
  onSignIn?: () => void;
}

const when = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

export function CommentsPanel({ comments, editor, as, canWrite, target, onSignIn }: CommentsPanelProps) {
  const state = useComments(comments);
  const model = useEditor(editor, (s) => s.model);
  const [text, setText] = useState('');
  const list = useRef<HTMLOListElement>(null);
  const focus = state.focus;
  const threads = numbered(state.threads);
  const focused = threads.find((t) => t.thread.id === focus);
  const open = state.threads.filter((t) => t.resolved === null).length;

  // A thread brought into focus (from its pin) is scrolled to.
  useEffect(() => {
    if (focus === null) return;
    list.current?.querySelector(`[data-thread="${focus}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [focus]);

  const replying = focused !== undefined && !focused.thread.deleted;
  const starting = !replying && target !== null && as === 'viewer';

  const submit = () => {
    const body = text.trim();
    if (body === '' || state.busy) return;
    const done = (ok: boolean) => { if (ok) setText(''); };
    if (replying) void comments.reply(focused.thread.id, body).then(done);
    else if (starting) void comments.create(body, target).then((id) => { done(id !== null); });
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
    if (e.key === 'Escape' && focus !== null) {
      e.stopPropagation();
      comments.set({ focus: null });
    }
  };

  const placeholder = replying
    ? `Reply to comment ${String(focused.n)}…`
    : starting
      ? `Comment on ${label(model, target.element)}…`
      : as === 'viewer'
        ? 'Reply, or click the plan to pin a new comment…'
        : 'Choose a comment to reply to it…';

  return (
    <section className="fs-comments" aria-labelledby="fs-comments-title">
      <header className="fs-comments__head">
        <h2 id="fs-comments-title" className="fs-comments__title">
          Comments · {state.threads.length}
        </h2>
        {open > 0 && open !== state.threads.length ? <span className="fs-note">{open} open</span> : null}
      </header>
      {state.error === null ? null : (
        <Alert tone="danger" title="That did not work" dynamic>
          {state.error}
        </Alert>
      )}
      <div className="fs-comments__body">
        {state.status === 'loading' ? (
          <Spinner label="Loading the comments" />
        ) : state.threads.length === 0 ? (
          <EmptyState kind="empty" size="inline" icon={<MessageSquare />} heading="No comments yet">
            {as === 'viewer' ? 'Select a wall, a window or a room on the plan, then write what you think. Your comment is pinned to it.' : 'Comments made through a share link appear here, pinned to the plan.'}
          </EmptyState>
        ) : (
          <ol className="fs-comments__list" ref={list}>
            {threads.map(({ thread, n }) => (
              <ThreadCard key={thread.id} thread={thread} n={n} model={model} focused={thread.id === focus} as={as} canWrite={canWrite} comments={comments} editor={editor} />
            ))}
          </ol>
        )}
      </div>
      <footer className="fs-comments__compose">
        {!canWrite ? (
          as === 'viewer' && onSignIn !== undefined ? (
            <div className="fs-comments__signin">
              <p className="fs-note">Commenting needs an account: sign in and you come straight back here.</p>
              <Button variant="primary" icon={<LogIn />} onClick={onSignIn}>
                Sign in to comment
              </Button>
            </div>
          ) : null
        ) : (
          <>
            {replying ? (
              <div className="fs-comments__context">
                <span>Replying to comment {focused.n}</span>
                <Button size="sm" variant="ghost" icon={<X />} onClick={() => { comments.set({ focus: null }); }}>
                  Cancel
                </Button>
              </div>
            ) : starting ? (
              <div className="fs-comments__context">
                <MapPin aria-hidden="true" />
                <span>
                  Pinned to <strong>{label(model, target.element)}</strong>
                </span>
              </div>
            ) : null}
            <Textarea
              aria-label={replying ? `Reply to comment ${String(focused.n)}` : starting ? `Comment on ${label(model, target.element)}` : 'Comment'}
              placeholder={placeholder}
              value={text}
              rows={3}
              maxLength={4000}
              disabled={!replying && !starting}
              onChange={(e) => { setText(e.target.value); }}
              onKeyDown={onKey}
            />
            <div className="fs-comments__actions">
              <span className="fs-note">⌘↵ sends · **bold** *italic* `code`</span>
              <Button variant="primary" size="sm" loading={state.busy} disabled={text.trim() === '' || (!replying && !starting)} onClick={submit}>
                {replying ? 'Reply' : 'Comment'}
              </Button>
            </div>
          </>
        )}
      </footer>
    </section>
  );
}

function label(model: EditorModel | null, id: string): string {
  return model !== null && model.index.has(id) ? labelOf(model, id) : id;
}

function ThreadCard({ thread, n, model, focused, as, canWrite, comments, editor }: { thread: Thread; n: number; model: EditorModel | null; focused: boolean; as: 'viewer' | 'owner'; canWrite: boolean; comments: CommentsStore; editor: EditorStore }) {
  const place = placeOf(model, thread);
  const detached = place?.detached === true;
  const element = thread.pin?.element ?? '';
  const select = () => {
    comments.set({ focus: thread.id });
    if (place !== null && !detached) {
      editor.select(element);
      if (place.level !== editor.get().level) editor.setLevel(place.level);
      editor.select(element);
    }
  };
  return (
    <li className="fs-thread" data-thread={thread.id} data-focus={focused ? 'true' : undefined} data-resolved={thread.resolved !== null ? 'true' : undefined}>
      <button type="button" className="fs-thread__head" onClick={select} aria-pressed={focused} aria-label={`Comment ${String(n)} by ${thread.author.name} on ${label(model, element)}: show it on the plan`}>
        <span className="fs-thread__n" aria-hidden="true">{n}</span>
        <Avatar name={thread.author.name} size="xs" tint="auto" />
        <span className="fs-thread__who">{thread.author.name}</span>
        <span className="fs-spacer" />
        <span className="fs-thread__el">{element}</span>
      </button>
      <Comment comment={thread} as={as} canWrite={canWrite} comments={comments} />
      {detached ? (
        <StatusDot tone="warning" size="sm">
          Detached: {element} is no longer in the plan
        </StatusDot>
      ) : null}
      {thread.replies.length > 0 ? (
        <ul className="fs-thread__replies">
          {thread.replies.map((reply) => (
            <li key={reply.id} className="fs-reply">
              <Avatar name={reply.author.name} size="xs" tint="auto" />
              <div className="fs-reply__body">
                <span className="fs-thread__who">{reply.author.name}</span>
                <Comment comment={reply} as={as} canWrite={canWrite} comments={comments} />
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="fs-thread__foot">
        {thread.resolved !== null ? <Badge size="sm">Resolved</Badge> : null}
        <span className="fs-note">{when(thread.createdAt)}</span>
        <span className="fs-spacer" />
        {as === 'owner' ? (
          thread.resolved === null ? (
            <Button size="sm" variant="ghost" icon={<CircleCheck />} disabled={thread.deleted} onClick={() => void comments.resolve(thread.id, 'resolve')} aria-label={`Resolve comment ${String(n)}`}>
              Resolve
            </Button>
          ) : (
            <Button size="sm" variant="ghost" icon={<RotateCcw />} onClick={() => void comments.resolve(thread.id, 'reopen')} aria-label={`Reopen comment ${String(n)}`}>
              Reopen
            </Button>
          )
        ) : null}
        {canWrite && !thread.deleted ? (
          <Button size="sm" variant="ghost" onClick={select} aria-label={`Reply to comment ${String(n)}`}>
            Reply
          </Button>
        ) : null}
      </div>
    </li>
  );
}

/** One comment's text, and — for its author, or the owner — edit and delete. */
function Comment({ comment, as, canWrite, comments }: { comment: CommentView; as: 'viewer' | 'owner'; canWrite: boolean; comments: CommentsStore }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  if (comment.deleted) return <p className="fs-comment__deleted">This comment was deleted.</p>;
  const mine = canWrite && comment.author.you;
  const canDelete = mine || as === 'owner';
  if (editing !== null) {
    return (
      <div className="fs-comment__edit">
        <Textarea aria-label="Edit the comment" value={editing} rows={3} maxLength={4000} onChange={(e) => { setEditing(e.target.value); }} />
        <div className="fs-comments__actions">
          <span className="fs-spacer" />
          <Button size="sm" variant="ghost" onClick={() => { setEditing(null); }}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" disabled={editing.trim() === ''} onClick={() => void comments.edit(comment.id, editing).then((ok) => { if (ok) setEditing(null); })}>
            Save
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="fs-comment">
      <Markdown className="fs-comment__text" text={comment.body} />
      {comment.editedAt !== null ? <span className="fs-note">(edited)</span> : null}
      {mine || canDelete ? (
        <div className="fs-comment__tools">
          {mine ? (
            <button type="button" className="fs-linkish" onClick={() => { setEditing(comment.body); }}>
              Edit
            </button>
          ) : null}
          {canDelete ? (
            <button
              type="button"
              className="fs-linkish fs-linkish--danger"
              onClick={() => {
                if (!confirm) {
                  setConfirm(true);
                  return;
                }
                void comments.remove(comment.id);
              }}
              onBlur={() => { setConfirm(false); }}
            >
              {confirm ? 'Delete it?' : 'Delete'}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
