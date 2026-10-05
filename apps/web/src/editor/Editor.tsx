import './editor.css';
import { useEffect, useMemo, type ReactNode } from 'react';
import { Avatar, Button, EmptyState, IconButton, Modal, SegmentedControl, Select, Skeleton, Spinner, StatusDot, Tooltip, TooltipProvider, useToast } from '@d3cloud/ui';
import { ArrowLeft, CircleCheck, Command as CommandIcon, Download, History as HistoryIcon, PanelLeft, Redo2, Share, Sparkles, Table as TableIcon, TriangleAlert, Undo2, Waypoints } from 'lucide-react';
import { navigate, takeParam } from '../lib/router';
import { EditorStore, useEditor, type ToolId } from './store';
import { ToolController } from './tools';
import { PlanCanvas } from './Canvas';
import { ProjectTree } from './Tree';
import { Inspector } from './Inspector';
import { RejectionBanner } from './Diagnostics';
import { COMMANDS, commandById, commandFor, keyOf } from './commands';
import { confirmPrompt, newLevel, switchUnits } from './actions';
import { connectLive } from './live';
import { ProposalPanel } from './Proposal';
import { ComparePanel, HistoryPanel } from './HistoryPanel';
import { Palette } from './Palette';
import { isArrow, nudge, nudgeable } from './nudge';
import { endCompare, toggleHistory } from './history';
import { openReview } from './review';
import { proposerOf } from './api';
import { labelOf, sortedLevels } from './model';
import { formatLen, gridStepLabel } from './units';
import { kindById, type SystemId } from './systems/catalog';
import {
  AirIcon,
  DataIcon,
  DoorIcon,
  DropIcon,
  MeasureIcon,
  PlugIcon,
  RoofIcon,
  RoomAnchorIcon,
  SelectIcon,
  SeparatorIcon,
  SofaIcon,
  StairIcon,
  WallIcon,
  WindowIcon,
  PencilIcon,
  SlabIcon,
} from './icons';

/**
 * `/projects/:id/editor` — the 2D plan editor (FLR-T-3.3, 3.4, 3.8), laid out as the board's
 * "07 · Editor" frames: a top bar, the tool rail, the project tree, the canvas, the inspector and a
 * status bar. On a tablet the tree folds away and the inspector floats over the canvas.
 */
export default function Editor({ id, you }: { id: string; you: string }) {
  const store = useMemo(() => {
    const created = new EditorStore(id);
    // `?review=<changeset>`: open with that proposal under review (a layout candidate, FLR-T-4.3).
    created.wanted = takeParam('review');
    return created;
  }, [id]);
  const tools = useMemo(() => new ToolController(store), [store]);
  // Subscribe first, load on `ready` (FLR-T-3.5).
  useEffect(() => connectLive(store), [store]);
  return (
    <TooltipProvider>
      <EditorFrame store={store} tools={tools} you={you} />
    </TooltipProvider>
  );
}

function EditorFrame({ store, tools, you }: { store: EditorStore; tools: ToolController; you: string }) {
  const status = useEditor(store, (s) => s.status);
  const error = useEditor(store, (s) => s.error);
  const treeOpen = useEditor(store, (s) => s.treeOpen);
  const readOnly = useEditor(store, (s) => s.readOnly);
  const notice = useEditor(store, (s) => s.notice);
  const idle = useEditor(store, (s) => s.selection === null && s.tool === 'select' && s.compare === null && !(s.side === 'review' && s.review !== null));
  const left = useEditor(store, (s) => s.left);
  const right = useEditor(store, (s) => (s.compare !== null ? 'compare' : s.side === 'review' && s.review !== null ? 'review' : 'inspector'));
  const toast = useToast();

  useEffect(() => {
    if (notice === null) return;
    toast.show({ message: notice.text });
    store.set({ notice: null });
  }, [notice, toast, store]);

  useKeyboard(store, tools);

  if (status === 'missing' || status === 'error') {
    return (
      <div className="fs-editor fs-editor--message">
        <EmptyState
          kind={status === 'missing' ? 'no-access' : 'error'}
          heading={status === 'missing' ? 'No such project' : 'The editor could not open this model'}
          action={
            <Button variant="secondary" onClick={() => {
              if (status === 'missing') navigate('/');
              else void store.load();
            }}>
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
    <div className="fs-editor" tabIndex={-1} data-tree={treeOpen ? 'open' : 'closed'} data-inspector={idle ? 'idle' : 'active'}>
      <TopBar store={store} you={you} />
      <ToolRail store={store} tools={tools} />
      <aside className="fs-editor__tree">{status === 'loading' ? <TreeSkeleton /> : left === 'history' ? <HistoryPanel store={store} you={you} /> : <ProjectTree store={store} />}</aside>
      <main className="fs-editor__canvas" aria-label="Plan">
        {status === 'loading' ? (
          <div className="fs-canvas fs-canvas--loading">
            <Spinner size="lg" label="Loading the model" />
          </div>
        ) : (
          <CanvasArea store={store} tools={tools} />
        )}
        {readOnly !== null && status === 'ready' ? (
          <div className="fs-readonly-banner" role="status">
            <StatusDot tone="warning" size="sm">View only</StatusDot>
            <span>{readOnly}</span>
          </div>
        ) : null}
      </main>
      <aside className="fs-editor__inspector" aria-label={right === 'review' ? 'Proposal' : right === 'compare' ? 'Comparison' : 'Inspector'}>
        {status === 'loading' ? <TreeSkeleton /> : right === 'compare' ? <ComparePanel store={store} /> : right === 'review' ? <ProposalPanel store={store} /> : <Inspector store={store} tools={tools} />}
      </aside>
      <StatusBar store={store} />
      <PromptModal store={store} />
      {status === 'ready' ? <Palette store={store} tools={tools} /> : null}
    </div>
  );
}

function TreeSkeleton() {
  return (
    <div className="fs-skeleton" aria-hidden="true">
      {Array.from({ length: 8 }, (_, i) => (
        <Skeleton key={i} variant="text" />
      ))}
    </div>
  );
}

function CanvasArea({ store, tools }: { store: EditorStore; tools: ToolController }) {
  const model = useEditor(store, (s) => s.model);
  const level = useEditor(store, (s) => s.level);
  const readOnly = useEditor(store, (s) => s.readOnly);
  const tool = useEditor(store, (s) => s.tool);
  const pending = useEditor(store, (s) => s.pending);
  const empty = model !== null && model.levels.length === 0;
  const view = model?.levels.find((l) => l.id === level);
  const blank = view !== undefined && view.walls.length === 0 && view.separators.length === 0;
  return (
    <>
      <PlanCanvas store={store} tools={tools} />
      <RejectionBanner store={store} />
      <ToolHint store={store} />
      {empty ? (
        <div className="fs-empty-level">
          <EmptyState
            kind="empty"
            size="inline"
            icon={<WallIcon />}
            heading="This project has no levels yet"
            action={
              readOnly === null ? (
                <Button variant="primary" loading={pending !== null} onClick={() => { newLevel(store); }}>
                  Add Level 1
                </Button>
              ) : undefined
            }
          >
            A level is a floor of the house: walls, openings and rooms are drawn on one. Adding it is an edit like any other, so Undo takes it back.
          </EmptyState>
        </div>
      ) : blank && tool === 'select' ? (
        <div className="fs-empty-hint" role="note">
          <span>Nothing drawn on {view.name} yet.</span>
          {readOnly === null ? (
            <Button size="sm" variant="primary" icon={<WallIcon />} onClick={() => { tools.setTool('wall'); }}>
              Draw walls
            </Button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function ToolHint({ store }: { store: EditorStore }) {
  const tool = useEditor(store, (s) => s.tool);
  const rejection = useEditor(store, (s) => s.rejection);
  if (rejection !== null) return null;
  const hints: Partial<Record<ToolId, ReactNode>> = {
    wall: (
      <>
        <span>Type a length</span> <kbd>Enter</kbd> <span className="fs-hint__faint">place</span> <kbd>Esc</kbd> <span className="fs-hint__faint">finish</span> <kbd>⇧</kbd>{' '}
        <span className="fs-hint__faint">45°</span>
      </>
    ),
    separator: (
      <>
        <span>Type a length</span> <kbd>Enter</kbd> <span className="fs-hint__faint">place</span> <kbd>Esc</kbd> <span className="fs-hint__faint">finish</span>
      </>
    ),
    door: (
      <>
        <span>Point at a wall</span> <span className="fs-hint__faint">· type an offset</span> <kbd>Enter</kbd>
      </>
    ),
    window: (
      <>
        <span>Point at a wall</span> <span className="fs-hint__faint">· type an offset</span> <kbd>Enter</kbd>
      </>
    ),
    room: <span>Click inside a closed space to name it</span>,
    device: (
      <>
        <span>Point at a wall, a floor or a ceiling</span> <span className="fs-hint__faint">· type an offset</span> <kbd>Enter</kbd>
      </>
    ),
  };
  const hint = hints[tool];
  if (hint === undefined) {
    return (
      <div className="fs-hint fs-hint--touch" aria-hidden="true">
        <PencilIcon /> <span>Pencil draws · finger pans · two fingers zoom</span>
      </div>
    );
  }
  return (
    <div className="fs-hint" role="note">
      {hint}
    </div>
  );
}

// ─── Top bar ─────────────────────────────────────────────────────────────────────────────────

function TopBar({ store, you }: { store: EditorStore; you: string }) {
  const project = useEditor(store, (s) => s.project);
  const model = useEditor(store, (s) => s.model);
  const level = useEditor(store, (s) => s.level);
  const history = useEditor(store, (s) => s.history);
  const pending = useEditor(store, (s) => s.pending);
  const readOnly = useEditor(store, (s) => s.readOnly);
  const treeOpen = useEditor(store, (s) => s.treeOpen);
  const proposals = useEditor(store, (s) => s.proposals);
  const review = useEditor(store, (s) => s.review);
  const left = useEditor(store, (s) => s.left);
  const comparing = useEditor(store, (s) => s.compare !== null);
  const levels = model === null ? [] : sortedLevels(model.document);
  const building = model === null || level === null ? null : (model.document.levels?.[level]?.building ?? '');
  const subtitle = [building === null || building === '' || model === null ? null : labelOf(model, building), history.seq === null ? null : `v${String(history.seq)}`, pending !== null ? `${pending}…` : readOnly !== null ? 'view only' : 'saved']
    .filter((x) => x !== null)
    .join(' · ');
  const editable = readOnly === null && pending === null && !comparing;
  const proposer = proposals[0] === undefined ? null : proposerOf(proposals[0].createdBy);
  return (
    <header className="fs-topbar">
      <IconButton label="Back to the project" icon={<ArrowLeft />} onClick={() => { navigate(project === null ? '/' : `/projects/${project.id}`); }} />
      <IconButton className="fs-topbar__tree" label={treeOpen ? 'Hide the project tree' : 'Show the project tree'} pressed={treeOpen} icon={<PanelLeft />} onClick={() => { store.set({ treeOpen: !treeOpen }); }} />
      <div className="fs-topbar__title">
        <h1>{model?.document.project.name ?? project?.name ?? 'Loading…'}</h1>
        <p aria-live="polite">{subtitle}</p>
      </div>
      {levels.length > 0 ? (
        <Select
          className="fs-topbar__level"
          aria-label="Level"
          options={levels.map(({ id }) => ({ value: id, label: model === null ? id : labelOf(model, id) }))}
          value={level ?? ''}
          onValueChange={(v) => { store.setLevel(v); }}
        />
      ) : null}
      <span className="fs-spacer" />
      <SegmentedControl
        aria-label="View"
        className="fs-topbar__views"
        value="2d"
        items={[
          { value: '2d', label: '2D plan' },
          { value: '3d', label: '3D', disabled: true },
          { value: 'split', label: 'Split', disabled: true },
        ]}
        onValueChange={() => undefined}
      />
      <Tooltip content="Rooms, doors, windows, receptacles and fixtures, live">
        <Button className="fs-topbar__brief" size="sm" variant="ghost" icon={<TableIcon />} onClick={() => { navigate(project === null ? '/' : `/projects/${project.id}/schedules`); }}>
          Schedules
        </Button>
      </Tooltip>
      <Tooltip content="The brief and its bubble diagram">
        <Button className="fs-topbar__brief" size="sm" variant="ghost" icon={<Waypoints />} onClick={() => { navigate(project === null ? '/' : `/projects/${project.id}/program`); }}>
          Brief
        </Button>
      </Tooltip>
      <span className="fs-spacer" />
      {proposals.length > 0 ? (
        <button
          type="button"
          className="fs-topbar__proposals"
          aria-pressed={review !== null && store.get().side === 'review'}
          onClick={() => void openReview(store, review?.id ?? (proposals[0]?.id as string))}
        >
          <Sparkles aria-hidden="true" />
          <span>
            {proposer ?? 'Agent'} · {proposals.length === 1 ? '1 proposal' : `${String(proposals.length)} proposals`}
          </span>
        </button>
      ) : null}
      <Tooltip content="History (H)">
        <IconButton label={left === 'history' ? 'Hide the history' : 'Show the history'} pressed={left === 'history'} icon={<HistoryIcon />} onClick={() => { toggleHistory(store); }} />
      </Tooltip>
      <Tooltip content="Commands (⌘K)">
        <IconButton label="Command palette" icon={<CommandIcon />} onClick={() => { store.set({ palette: true }); }} />
      </Tooltip>
      <Tooltip content="Undo (⌘Z)">
        <IconButton label="Undo" icon={<Undo2 />} disabled={!editable || history.undo === null} onClick={() => void store.undo('undo')} />
      </Tooltip>
      <Tooltip content="Redo (⇧⌘Z)">
        <IconButton label="Redo" icon={<Redo2 />} disabled={!editable || history.redo === null} onClick={() => void store.undo('redo')} />
      </Tooltip>
      <Avatar className="fs-topbar__avatar" name={you} size="sm" />
      <Tooltip content="Sharing arrives with P9">
        <Button className="fs-topbar__share" size="sm" variant="secondary" icon={<Share />} disabled>
          Share
        </Button>
      </Tooltip>
      {project !== null ? (
        <a className="fs-topbar__export" href={`/api/projects/${project.id}/model.json`} download>
          <Download aria-hidden="true" />
          Export
        </a>
      ) : null}
    </header>
  );
}

// ─── Tool rail ───────────────────────────────────────────────────────────────────────────────

const RAIL: { tool?: ToolId; label: string; icon: ReactNode; later?: string }[] = [
  { tool: 'select', label: 'Select', icon: <SelectIcon /> },
  { tool: 'wall', label: 'Draw walls', icon: <WallIcon /> },
  { tool: 'door', label: 'Place a door', icon: <DoorIcon /> },
  { tool: 'window', label: 'Place a window', icon: <WindowIcon /> },
  { tool: 'room', label: 'Name a room', icon: <RoomAnchorIcon /> },
  { tool: 'separator', label: 'Draw a room separator', icon: <SeparatorIcon /> },
  { tool: 'slab', label: 'Draw a slab', icon: <SlabIcon /> },
  { tool: 'stair', label: 'Place a stair', icon: <StairIcon /> },
  { tool: 'roof', label: 'Draw a roof', icon: <RoofIcon /> },
];
/** The building systems below the rule (FLR-T-5.7): each starts the device tool with that system's first kind. */
const RAIL_SYSTEMS: { system: SystemId; label: string; icon: ReactNode; first: string }[] = [
  { system: 'electrical', label: 'Electrical', icon: <PlugIcon />, first: 'receptacle' },
  { system: 'plumbing', label: 'Plumbing', icon: <DropIcon />, first: 'toilet' },
  { system: 'mechanical', label: 'Mechanical', icon: <AirIcon />, first: 'supply' },
  { system: 'lowvoltage', label: 'Low-voltage', icon: <DataIcon />, first: 'dataOutlet' },
];

/** The kind last used in each system, so the rail goes back to it. */
const lastKind = new Map<SystemId, string>();

function ToolRail({ store, tools }: { store: EditorStore; tools: ToolController }) {
  const tool = useEditor(store, (s) => s.tool);
  const draw = useEditor(store, (s) => s.draw);
  useEffect(() => {
    const k = kindById(draw.device);
    if (k !== undefined) lastKind.set(k.system, k.id);
  }, [draw.device]);
  const level = useEditor(store, (s) => s.level);
  const readOnly = useEditor(store, (s) => s.readOnly);
  const canDraw = level !== null && readOnly === null;
  return (
    <nav className="fs-rail" aria-label="Tools">
      {RAIL.map((t) => {
        const command = t.tool === undefined ? undefined : commandById(`tool.${t.tool}`);
        const tip = t.later !== undefined ? `${t.label} — arrives in ${t.later}` : `${t.label} (${command?.hint ?? ''})`;
        return (
          <Tooltip key={t.label} content={tip} side="right">
            <IconButton
              label={t.label}
              icon={t.icon}
              pressed={t.tool !== undefined && tool === t.tool}
              disabled={t.tool === undefined || (t.tool !== 'select' && !canDraw)}
              className={t.later !== undefined ? 'fs-rail__later' : undefined}
              onClick={() => {
                if (t.tool !== undefined) tools.setTool(t.tool);
              }}
            />
          </Tooltip>
        );
      })}
      <span className="fs-rail__rule" />
      {RAIL_SYSTEMS.map((t) => {
        const current = kindById(draw.device);
        const on = tool === 'device' && current?.system === t.system;
        const command = commandById(`tool.${t.system}`);
        return (
          <Tooltip key={t.label} content={`${t.label} devices${command?.hint === undefined ? '' : ` (${command.hint})`}`} side="right">
            <IconButton
              label={`Place ${t.label.toLowerCase()} devices`}
              icon={t.icon}
              pressed={on}
              disabled={!canDraw}
              onClick={() => { tools.useDevice(current?.system === t.system ? current.id : (lastKind.get(t.system) ?? t.first)); }}
            />
          </Tooltip>
        );
      })}
      <Tooltip content="Furniture — arrives in P8" side="right">
        <IconButton label="Furniture" icon={<SofaIcon />} disabled className="fs-rail__later" />
      </Tooltip>
      <span className="fs-rail__rule" />
      <Tooltip content="Measure — arrives with dimensions in P4" side="right">
        <IconButton label="Measure" icon={<MeasureIcon />} disabled className="fs-rail__later" />
      </Tooltip>
    </nav>
  );
}

// ─── Status bar ──────────────────────────────────────────────────────────────────────────────

function StatusBar({ store }: { store: EditorStore }) {
  const cursor = useEditor(store, (s) => s.cursor);
  const model = useEditor(store, (s) => s.model);
  const history = useEditor(store, (s) => s.history);
  const readOnly = useEditor(store, (s) => s.readOnly);
  const units = useEditor(store, () => store.units);
  const live = useEditor(store, (s) => s.live);
  const proposals = useEditor(store, (s) => s.proposals.length);
  const findings = model?.diagnostics.length ?? 0;
  return (
    <footer className="fs-statusbar">
      <span className="fs-statusbar__mono fs-statusbar__cursor">{cursor === null ? 'Cursor —' : `Cursor ${formatLen(Math.round(cursor[0]), units)}, ${formatLen(Math.round(cursor[1]), units)}`}</span>
      <span className="fs-statusbar__mono fs-statusbar__wide">Snap · junctions, walls + {gridStepLabel(units)}</span>
      <button
        type="button"
        className="fs-statusbar__mono fs-statusbar__units"
        disabled={readOnly !== null}
        title={units === 'metric' ? 'Show feet and inches' : 'Show metric'}
        onClick={() => { switchUnits(store, units === 'metric' ? 'imperial' : 'metric'); }}
      >
        {units === 'metric' ? 'mm' : 'ft-in'}
      </button>
      <span className="fs-spacer" />
      {model !== null ? (
        <span className="fs-statusbar__item">
          {model.valid ? <CircleCheck className="fs-ok" aria-hidden="true" /> : <TriangleAlert className="fs-bad" aria-hidden="true" />}
          {model.valid ? 'Model valid' : 'Model invalid'}
        </span>
      ) : null}
      <button
        type="button"
        className="fs-statusbar__item fs-statusbar__findings"
        onClick={() => {
          store.select(null);
          store.setTool('select');
        }}
      >
        <TriangleAlert className={findings > 0 ? 'fs-warn' : 'fs-faint'} aria-hidden="true" />
        {findings === 1 ? '1 finding' : `${String(findings)} findings`}
      </button>
      {proposals > 0 ? (
        <span className="fs-statusbar__item fs-statusbar__proposals">
          <Sparkles aria-hidden="true" />
          {proposals === 1 ? '1 proposal' : `${String(proposals)} proposals`}
        </span>
      ) : null}
      <span className="fs-statusbar__item" title={live === 'live' ? 'Changes made elsewhere appear here as they happen' : 'Reconnecting to live updates'}>
        <StatusDot tone={live === 'live' ? 'attention' : live === 'reconnecting' ? 'warning' : 'idle'} size="sm">
          {live === 'live' ? 'Live' : live === 'reconnecting' ? 'Reconnecting' : 'Connecting'}
        </StatusDot>
      </span>
      <span className="fs-statusbar__mono">{history.seq === null ? '' : `v${String(history.seq)}`}</span>
    </footer>
  );
}

// ─── Prompts ─────────────────────────────────────────────────────────────────────────────────

function PromptModal({ store }: { store: EditorStore }) {
  const prompt = useEditor(store, (s) => s.prompt);
  const model = useEditor(store, (s) => s.model);
  if (prompt === null || model === null) return null;
  const close = () => { store.set({ prompt: null }); };
  if (prompt.kind === 'keep') {
    const [a, b] = prompt.rooms;
    return (
      <Modal
        open
        onOpenChange={(open) => {
        if (!open) close();
      }}
        title={`Remove ${labelOf(model, prompt.wall)}?`}
        description={`It divides ${labelOf(model, a)} from ${labelOf(model, b)}. Without it they are one space, and one room has to keep it (Floorspec Ops 4.7).`}
        footer={
          <>
            <Button variant="ghost" onClick={close}>Cancel</Button>
            <Button variant="secondary" onClick={() => { confirmPrompt(store, b); }}>Keep {labelOf(model, b)}</Button>
            <Button variant="primary" onClick={() => { confirmPrompt(store, a); }}>Keep {labelOf(model, a)}</Button>
          </>
        }
      >
        <p className="fs-note">The other room’s name, function and finishes are removed with the wall. Undo brings both back.</p>
      </Modal>
    );
  }
  return (
    <Modal
      open
      destructive
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={prompt.title}
      description={prompt.detail}
      footer={
        <>
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button variant="danger" onClick={() => { confirmPrompt(store); }}>Remove</Button>
        </>
      }
    >
      {null}
    </Modal>
  );
}

// ─── Keyboard ────────────────────────────────────────────────────────────────────────────────

function useKeyboard(store: EditorStore, tools: ToolController) {
  useEffect(() => {
    const mac = /Mac|iPhone|iPad/.test(navigator.platform);
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      // ⌘K reaches the palette from anywhere, a field included (FLR-T-3.7).
      if ((mac ? e.metaKey : e.ctrlKey) && e.key.toLowerCase() === 'k' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        store.set({ palette: !store.get().palette });
        return;
      }
      const typing = target !== null && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.getAttribute('role') === 'combobox');
      if (typing || store.get().prompt !== null || document.querySelector('[role="dialog"]') !== null) return;
      if (e.key === ' ' && !e.repeat) {
        tools.space = true;
        e.preventDefault();
        return;
      }
      const mod = mac ? e.metaKey : e.ctrlKey;
      // A length being typed while drawing takes the key before any shortcut does.
      if (!mod && !e.altKey && tools.typeKey(e.key)) {
        e.preventDefault();
        return;
      }
      if (e.key === 'Enter' && tools.enter()) {
        e.preventDefault();
        return;
      }
      if (e.key === 'Escape') {
        if (store.get().compare !== null && store.get().draft === null) endCompare(store);
        else tools.escape();
        e.preventDefault();
        return;
      }
      // Arrows: aim the next wall while drawing; nudge the selection; otherwise pan.
      if (isArrow(e.key) && !mod && !e.altKey) {
        if (tools.aim(e.key) || (nudgeable(store) && store.get().tool === 'select' && nudge(store, e.key, e.shiftKey))) {
          e.preventDefault();
          return;
        }
      }
      const view = store.get().view;
      const arrows: Record<string, [number, number]> = { ArrowLeft: [80, 0], ArrowRight: [-80, 0], ArrowUp: [0, 80], ArrowDown: [0, -80] };
      const pan = arrows[e.key];
      if (pan !== undefined && view !== null && !mod) {
        store.set({ view: { ...view, cx: view.cx - pan[0] / view.s, cy: view.cy + pan[1] / view.s } });
        e.preventDefault();
        return;
      }
      const command = commandFor(keyOf(e, mac));
      if (command === undefined) return;
      if (command.enabled !== undefined && !command.enabled(store)) return;
      e.preventDefault();
      command.run(store, tools);
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.key === ' ') tools.space = false;
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onUp);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onUp);
    };
  }, [store, tools]);
}

export { COMMANDS };
