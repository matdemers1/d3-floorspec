import { useSyncExternalStore } from 'react';
import { useEditor, type EditorStore } from '../editor/store';
import { toScreen } from '../editor/viewport';
import { labelOf } from '../editor/model';
import { numbered, type CommentsStore } from './comments';
import { placeOf } from './pins';

/**
 * Comment pins on the plan (FLR-T-9.6; the board's "20 · Comments — architect review"): a numbered
 * marker for each thread on the level shown, where its element is now — or, for an element that is
 * gone, where it last was, outlined as detached. Pressing one brings its thread into focus and
 * selects its element. Drawn over the canvas as buttons, so a keyboard reaches them too.
 */
export function CommentPins({ editor, comments }: { editor: EditorStore; comments: CommentsStore }) {
  const view = useEditor(editor, (s) => s.view);
  const level = useEditor(editor, (s) => s.level);
  const model = useEditor(editor, (s) => s.model);
  const state = useSyncExternalStore(comments.subscribe, comments.get);
  if (view === null || state.threads.length === 0) return null;
  const pins = numbered(state.threads).flatMap(({ thread, n }) => {
    const place = placeOf(model, thread);
    if (place?.point === null || place === null || place.level !== level || thread.pin === null) return [];
    const [x, y] = toScreen(view, place.point);
    if (x < -20 || y < -20 || x > view.w + 20 || y > view.h + 20) return [];
    const what = model !== null && model.index.has(thread.pin.element) ? labelOf(model, thread.pin.element) : thread.pin.element;
    return [{ thread, n, x, y, detached: place.detached, what }];
  });
  if (pins.length === 0) return null;
  return (
    <div className="fs-pins" role="group" aria-label="Comment pins">
      {pins.map(({ thread, n, x, y, detached, what }) => (
        <button
          key={thread.id}
          type="button"
          className="fs-pin"
          style={{ left: x, top: y }}
          data-resolved={thread.resolved !== null ? 'true' : undefined}
          data-detached={detached ? 'true' : undefined}
          data-focus={state.focus === thread.id ? 'true' : undefined}
          aria-pressed={state.focus === thread.id}
          aria-label={`Comment ${String(n)} by ${thread.author.name} on ${what}${detached ? ', detached: no longer in the plan' : ''}${thread.resolved !== null ? ', resolved' : ''}`}
          onClick={() => {
            comments.set({ focus: thread.id });
            if (!detached && thread.pin !== null) editor.select(thread.pin.element);
          }}
        >
          {n}
        </button>
      ))}
    </div>
  );
}
