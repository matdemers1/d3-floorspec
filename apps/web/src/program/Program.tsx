import '../editor/editor.css';
import './program.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Avatar, Button, EmptyState, IconButton, SegmentedControl, Spinner, StatusDot, Tooltip, TooltipProvider, useToast } from '@d3cloud/ui';
import { ArrowLeft, Download, Redo2, Undo2 } from 'lucide-react';
import { navigate } from '../lib/router';
import { EditorStore, useEditor } from '../editor/store';
import { connectProgramLive } from './live';
import { readProgram, type ProgramView } from './model';
import { BriefPanel } from './Brief';
import { BubbleCanvas, type Selection } from './Bubbles';
import { ProgramInspector } from './ProgramInspector';
import { Layouts } from './Layouts';

export type ProgramScreen = 'brief' | 'layouts';

/**
 * `/projects/:id/program` and `/projects/:id/layouts` — the brief and the layouts it gives (FLR-T-4.2,
 * FLR-T-4.3), laid out as the board's "05 · Program & bubble diagram" and "06 · Layout candidates":
 * a top bar whose view switch goes Brief · Layouts · Plan, then the brief table, the bubble canvas
 * and the inspector — or the candidates, each a changeset.
 *
 * The model, its history and its one write path are the editor's own store (FLR-ADR-008): every
 * edit here is a batch of Floorspec Ops sent with If-Match, undone by the same Undo.
 */
export default function Program({ id, screen, you }: { id: string; screen: ProgramScreen; you: string }) {
  const store = useMemo(() => new EditorStore(id), [id]);
  const [tick, setTick] = useState(0);
  useEffect(() => connectProgramLive(store, () => { setTick((t) => t + 1); }), [store]);
  return (
    <TooltipProvider>
      <Frame store={store} screen={screen} you={you} tick={tick} />
    </TooltipProvider>
  );
}

function Frame({ store, screen, you, tick }: { store: EditorStore; screen: ProgramScreen; you: string; tick: number }) {
  const status = useEditor(store, (s) => s.status);
  const error = useEditor(store, (s) => s.error);
  const model = useEditor(store, (s) => s.model);
  const notice = useEditor(store, (s) => s.notice);
  const toast = useToast();
  const view = useMemo(() => (model === null ? null : readProgram(model)), [model]);
  const [selection, setSelection] = useState<Selection>(null);

  useEffect(() => {
    if (notice === null) return;
    toast.show({ message: notice.text });
    store.set({ notice: null });
  }, [notice, toast, store]);

  // A selection whose item or line is gone (an undo, somebody else's edit) is dropped. One made for
  // an item or line an edit is still adding (relate, add) is not there yet: it waits for the next
  // model before it can be missing, so a slow round trip does not undo the selection it was made for.
  const madeIn = useRef<{ selection: Selection; view: ProgramView | null }>({ selection: null, view: null });
  useEffect(() => {
    if (view === null || selection === null) return;
    if (madeIn.current.selection !== selection) madeIn.current = { selection, view };
    const exists = selection.kind === 'item' ? view.items.some((i) => i.id === selection.id) : view.edges.some((e) => e.key === selection.key);
    if (!exists && view !== madeIn.current.view) setSelection(null);
  }, [view, selection]);

  useUndoKeys(store);

  if (status === 'missing' || status === 'error') {
    return (
      <div className="fs-editor fs-editor--message">
        <EmptyState
          kind={status === 'missing' ? 'no-access' : 'error'}
          heading={status === 'missing' ? 'No such project' : 'The brief could not open this model'}
          action={
            <Button variant="secondary" onClick={() => { if (status === 'missing') navigate('/'); else void store.load(); }}>
              {status === 'missing' ? 'Back to projects' : 'Try again'}
            </Button>
          }
        >
          {error ?? ''}
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="fs-program" data-screen={screen} data-selected={selection === null ? 'none' : selection.kind}>
      <TopBar store={store} screen={screen} you={you} />
      {status === 'loading' || model === null || view === null ? (
        <main className="fs-program__loading" aria-label="Brief">
          <Spinner size="lg" label="Loading the brief" />
        </main>
      ) : screen === 'brief' ? (
        <BriefScreen store={store} view={view} selection={selection} onSelect={setSelection} />
      ) : (
        <Layouts store={store} view={view} tick={tick} />
      )}
    </div>
  );
}

function BriefScreen({ store, view, selection, onSelect }: { store: EditorStore; view: ProgramView; selection: Selection; onSelect: (s: Selection) => void }) {
  const [relating, setRelating] = useState<string | null>(null);
  const select = useCallback(
    (s: Selection) => {
      setRelating(null);
      onSelect(s);
    },
    [onSelect],
  );
  return (
    <>
      <aside className="fs-program__brief" aria-label="Brief table">
        <BriefPanel store={store} view={view} selection={selection} onSelect={select} />
      </aside>
      <main className="fs-program__canvas" aria-label="Bubble diagram">
        <BubbleCanvas store={store} view={view} selection={selection} onSelect={select} relating={relating} onRelating={setRelating} />
      </main>
      <aside className="fs-program__inspector" aria-label="Brief inspector">
        <ProgramInspector store={store} view={view} selection={selection} onSelect={select} onRelating={setRelating} />
      </aside>
    </>
  );
}

function TopBar({ store, screen, you }: { store: EditorStore; screen: ProgramScreen; you: string }) {
  const project = useEditor(store, (s) => s.project);
  const model = useEditor(store, (s) => s.model);
  const history = useEditor(store, (s) => s.history);
  const pending = useEditor(store, (s) => s.pending);
  const readOnly = useEditor(store, (s) => s.readOnly);
  const live = useEditor(store, (s) => s.live);
  const editable = readOnly === null && pending === null;
  const id = store.projectId;
  const subtitle = [screen === 'brief' ? 'Brief' : 'Layouts', history.seq === null ? null : `v${String(history.seq)}`, pending !== null ? `${pending}…` : readOnly !== null ? 'view only' : 'saved'].filter((x) => x !== null).join(' · ');
  return (
    <header className="fs-topbar">
      <IconButton label="Back to the project" icon={<ArrowLeft />} onClick={() => { navigate(`/projects/${id}`); }} />
      <div className="fs-topbar__title">
        <h1>{model?.document.project.name ?? project?.name ?? 'Loading…'}</h1>
        <p aria-live="polite">{subtitle}</p>
      </div>
      <span className="fs-spacer" />
      <SegmentedControl
        aria-label="View"
        className="fs-program__views"
        value={screen}
        activationMode="manual"
        items={[
          { value: 'brief', label: 'Brief' },
          { value: 'layouts', label: 'Layouts' },
          { value: 'plan', label: 'Plan' },
        ]}
        onValueChange={(v) => { navigate(v === 'plan' ? `/projects/${id}/editor` : `/projects/${id}/${v === 'brief' ? 'program' : 'layouts'}`); }}
      />
      <span className="fs-spacer" />
      <span className="fs-program__live" title={live === 'live' ? 'Changes made elsewhere appear here as they happen' : 'Reconnecting to live updates'}>
        <StatusDot tone={live === 'live' ? 'attention' : live === 'reconnecting' ? 'warning' : 'idle'} size="sm">
          {live === 'live' ? 'Live' : live === 'reconnecting' ? 'Reconnecting' : 'Connecting'}
        </StatusDot>
      </span>
      <Tooltip content="Undo (⌘Z)">
        <IconButton label="Undo" icon={<Undo2 />} disabled={!editable || history.undo === null} onClick={() => void store.undo('undo')} />
      </Tooltip>
      <Tooltip content="Redo (⇧⌘Z)">
        <IconButton label="Redo" icon={<Redo2 />} disabled={!editable || history.redo === null} onClick={() => void store.undo('redo')} />
      </Tooltip>
      <Avatar className="fs-topbar__avatar" name={you} size="sm" />
      <a className="fs-topbar__export" href={`/api/projects/${id}/model.json`} download>
        <Download aria-hidden="true" />
        Export
      </a>
    </header>
  );
}

/** ⌘Z and ⇧⌘Z, as in the plan — not while a field has the keys. */
function useUndoKeys(store: EditorStore) {
  useEffect(() => {
    const mac = /Mac|iPhone|iPad/.test(navigator.platform);
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = target !== null && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.getAttribute('role') === 'combobox');
      if (typing || document.querySelector('[role="dialog"]') !== null) return;
      if ((mac ? e.metaKey : e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        const { readOnly, pending } = store.get();
        if (readOnly !== null || pending !== null) return;
        void store.undo(e.shiftKey ? 'redo' : 'undo');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); };
  }, [store]);
}
