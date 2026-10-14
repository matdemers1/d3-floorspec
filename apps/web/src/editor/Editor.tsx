import './editor.css';
import { useEffect, useMemo, type ReactNode } from 'react';
import { Avatar, Button, EmptyState, IconButton, Modal, Select, Skeleton, Spinner, StatusDot, Tooltip, TooltipProvider, useToast } from '@d3cloud/ui';
import { ArrowLeft, CircleCheck, Command as CommandIcon, Hand, History as HistoryIcon, Palette as PaletteIcon, PanelLeft, Redo2, Sparkles, Table as TableIcon, TriangleAlert, Undo2, WandSparkles, Waypoints } from 'lucide-react';
import { OptionCompareCanvas, OptionComparePanel, OptionsChip, OptionsPanel } from './Options';
import { MaterialsModal } from './Materials';
import { FurnitureLibrary } from '../furniture/Browser';
import { furnitureOf, useFurniture } from '../furniture/state';
import { navigate, takeParam } from '../lib/router';
import { EditorStore, useEditor, type ToolId } from './store';
import { ToolController } from './tools';
import { PlanCanvas } from './Canvas';
import { ProjectTree } from './Tree';
import { Inspector } from './Inspector';
import { RejectionBanner } from './Diagnostics';
import { COMMANDS, codeOf, commandById, commandFor, commandForCode, keyOf } from './commands';
import { arrangeKey, useClipboard } from './arrange/commands';
import { cycleFocus, drawersOf, escapeDrawer, setFullScreen, summonDrawer } from './drawers';
import { Drawer, DrawerHead, Edges, FullScreenButton, PinButton, useChrome } from './EdgeDrawers';
import { confirmPrompt, newLevel, switchUnits } from './actions';
import { connectLive } from './live';
import { ProposalPanel } from './Proposal';
import { ComparePanel, HistoryPanel } from './HistoryPanel';
import { Palette } from './Palette';
import { isArrow, nudge, nudgeable } from './nudge';
import { roomKey } from './rooms/keys';
import { endCompare, toggleHistory } from './history';
import { openReview } from './review';
import { proposerOf } from './api';
import { labelOf, sortedLevels } from './model';
import { formatLen } from './units';
import { SnapStatus } from './precision/SnapMenu';
import { useAltHover } from './precision/commands';
import { kindById, type SystemId } from './systems/catalog';
import { ExportButton } from '../exports/ExportButton';
import { Views, ViewSwitch } from './three/Views';
import { DEVICE_ICONS, ModeStatus, ModeSwitcher, SaveModeDialog, useModeChoices } from './ModeSwitcher';
import { modesOf, useModes, type RailItem } from './modes';
import { useThreeState } from './three/mode';
import { FindingsPanel, openAtFinding } from '../findings/Panel';
import { findingsSource, useFindings } from '../findings/source';
import { CommentsButton, EditorComments, OwnerPins, ShareButton, useCommentsOpen } from '../share/editor';
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
  ArcWallIcon,
  WindowIcon,
  PencilIcon,
  SlabIcon,
} from './icons';

/**
 * `/projects/:id/editor` — the 2D plan editor (FLR-T-3.3, 3.4, 3.8), laid out as the board's
 * "07 · Editor" frames: a top bar, the tool rail, the project tree, the canvas, the inspector and a
 * status bar. On a tablet the tree folds away and the inspector floats over the canvas. The top bar,
 * the rail with the tree, and the inspector are the edge drawers (FLR-T-18.2): pinned by default,
 * collapsible to their edge, and summoned from it in full screen (F).
 */
export default function Editor({ id, you }: { id: string; you: string }) {
  const store = useMemo(() => {
    const created = new EditorStore(id);
    // `?review=<changeset>`: open with that proposal under review (a layout candidate, FLR-T-4.3).
    created.wanted = takeParam('review');
    // `?finding=<key>` or `?findings=open`: open with the findings panel, focused on that finding (FLR-T-6.9).
    const finding = takeParam('finding');
    if (finding !== null || takeParam('findings') !== null) openAtFinding(created, findingsSource(id), finding);
    // The mode this project was left in (FLR-T-18.3), its layers applied before the plan first draws.
    modesOf(created);
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
  const idle = useEditor(store, (s) => s.selection === null && s.tool === 'select' && s.compare === null && !(s.side === 'review' && s.review !== null) && !s.findingsOpen && s.side !== 'options' && s.optionCompare === null);
  const left = useEditor(store, (s) => s.left);
  const right = useEditor(store, (s) =>
    s.compare !== null ? 'compare' : s.optionCompare !== null ? 'optionCompare' : s.side === 'review' && s.review !== null ? 'review' : s.findingsOpen ? 'findings' : s.side === 'options' ? 'options' : 'inspector',
  );
  const optionCompare = useEditor(store, (s) => s.optionCompare !== null);
  const toast = useToast();
  const viewMode = useThreeState(store, (s) => s.mode);
  const walking = useThreeState(store, (s) => s.walking);
  // Comments from share links (FLR-T-9.6) take the inspector's place while they are open.
  const comments = useCommentsOpen(store) && right === 'inspector';
  // Full screen and the edge drawers (FLR-T-18.2): the frame carries which chrome and each drawer's state.
  const chrome = useChrome(store);
  // A proposal, the findings, a comparison or the comments asked for: a hidden right drawer comes out to show them.
  const showing = comments ? 'comments' : right;
  useEffect(() => {
    if (showing !== 'inspector') drawersOf(store).reveal('right');
  }, [showing, store]);

  useEffect(() => {
    if (notice === null) return;
    toast.show({ message: notice.text });
    store.set({ notice: null });
  }, [notice, toast, store]);

  useKeyboard(store, tools);
  useClipboard(store);
  useAltHover(store);

  const rightLabel = comments ? 'Comments' : right === 'review' ? 'Proposal' : right === 'compare' ? 'Comparison' : right === 'findings' ? 'Findings' : right === 'options' || right === 'optionCompare' ? 'Design options' : 'Inspector';

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
    <div className="fs-editor" tabIndex={-1} {...chrome} data-tree={treeOpen ? 'open' : 'closed'} data-inspector={idle && !comments ? 'idle' : 'active'} data-walk={walking ? 'on' : undefined}>
      <Drawer store={store} side="top">
        <TopBar store={store} tools={tools} you={you} />
      </Drawer>
      <Drawer store={store} side="left">
        <ToolRail store={store} tools={tools} />
        <aside className="fs-editor__tree">{status === 'loading' ? <TreeSkeleton /> : left === 'history' ? <HistoryPanel store={store} you={you} /> : <ProjectTree store={store} />}</aside>
      </Drawer>
      <main className="fs-editor__canvas" aria-label={viewMode === '3d' || walking ? '3D view' : viewMode === 'split' ? 'Plan and 3D view' : 'Plan'}>
        {status === 'loading' ? (
          <div className="fs-canvas fs-canvas--loading">
            <Spinner size="lg" label="Loading the model" />
          </div>
        ) : optionCompare ? (
          <OptionCompareCanvas store={store} />
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
      <Drawer store={store} side="right">
        <aside className="fs-editor__inspector" aria-label={rightLabel}>
          <DrawerHead store={store} side="right" title={rightLabel} />
          {status === 'loading' ? (
            <TreeSkeleton />
          ) : comments ? (
            <EditorComments store={store} />
          ) : right === 'compare' ? (
            <ComparePanel store={store} />
          ) : right === 'optionCompare' ? (
            <OptionComparePanel store={store} />
          ) : right === 'review' ? (
            <ProposalPanel store={store} />
          ) : right === 'findings' ? (
            <FindingsPanel store={store} />
          ) : right === 'options' ? (
            <OptionsPanel store={store} />
          ) : (
            <Inspector store={store} tools={tools} />
          )}
        </aside>
      </Drawer>
      <MaterialsModal store={store} />
      <FurnitureLibrary store={store} />
      <StatusBar store={store} />
      <PromptModal store={store} />
      <SaveModeDialog store={store} />
      {status === 'ready' ? <Palette store={store} tools={tools} /> : null}
      <Edges store={store} />
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
      <Views
        store={store}
        plan={
          <>
            <PlanCanvas store={store} tools={tools} />
            <OwnerPins store={store} />
          </>
        }
      />
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
    // FLR-T-18.9: the measure tool.
    measure: (
      <>
        <span>Click point to point</span> <span className="fs-hint__faint">· the first again for an area</span> <kbd>Enter</kbd> <span className="fs-hint__faint">end</span> <kbd>Esc</kbd> <span className="fs-hint__faint">clear</span>
      </>
    ),
    hand: (
      <>
        <span>Drag to pan</span> <span className="fs-hint__faint">· double-click to zoom in,</span> <kbd>⌥</kbd> <span className="fs-hint__faint">out</span> <kbd>V</kbd> <span className="fs-hint__faint">select</span>
      </>
    ),
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

function TopBar({ store, tools, you }: { store: EditorStore; tools: ToolController; you: string }) {
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
  const modeChoices = useModeChoices(store);
  return (
    <header className="fs-topbar">
      <IconButton label="Back to the project" icon={<ArrowLeft />} onClick={() => { navigate(project === null ? '/' : `/projects/${project.id}`); }} />
      <IconButton className="fs-topbar__tree" label={treeOpen ? 'Hide the project tree' : 'Show the project tree'} pressed={treeOpen} icon={<PanelLeft />} onClick={() => { store.set({ treeOpen: !treeOpen }); }} />
      <div className="fs-topbar__title">
        <h1>{model?.document.project.name ?? project?.name ?? 'Loading…'}</h1>
        <p aria-live="polite">{subtitle}</p>
      </div>
      <ModeSwitcher store={store} tools={tools} />
      {levels.length > 0 ? (
        <Select
          className="fs-topbar__level"
          aria-label="Level"
          options={levels.map(({ id }) => ({ value: id, label: model === null ? id : labelOf(model, id) }))}
          value={level ?? ''}
          onValueChange={(v) => { store.setLevel(v); }}
        />
      ) : null}
      <OptionsChip store={store} />
      <span className="fs-spacer" />
      <ViewSwitch store={store} />
      <Tooltip content="Rooms, doors, windows, receptacles and fixtures, live">
        <Button className="fs-topbar__brief" size="sm" variant="ghost" icon={<TableIcon />} onClick={() => { navigate(project === null ? '/' : `/projects/${project.id}/schedules`); }}>
          Schedules
        </Button>
      </Tooltip>
      <Tooltip content="The project's materials: colour, metallic, roughness and tile size">
        <Button className="fs-topbar__brief" size="sm" variant="ghost" icon={<PaletteIcon />} onClick={() => { store.set({ materialsOpen: true }); }}>
          Materials
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
      <Tooltip content={`History (${commandById('history.toggle')?.hint ?? ''})`}>
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
      <CommentsButton store={store} />
      <Avatar className="fs-topbar__avatar" name={you} size="sm" />
      {project !== null ? <ShareButton projectId={project.id} projectName={model?.document.project.name ?? project.name} versionLabel={history.seq === null ? null : `v${String(history.seq)}`} /> : null}
      {project !== null ? <ExportButton projectId={project.id} projectName={model?.document.project.name ?? project.name} versionLabel={history.seq === null ? null : `v${String(history.seq)}`} levels={levels.map(({ id }) => ({ id, name: model === null ? id : labelOf(model, id) }))} optionSets={model?.optionSets} modes={modeChoices} /> : null}
      <span className="fs-topbar__rule" />
      <span className="fs-topbar__pin">
        <PinButton store={store} side="top" />
      </span>
      <FullScreenButton store={store} />
    </header>
  );
}

// ─── Tool rail ───────────────────────────────────────────────────────────────────────────────

const RAIL: { tool?: ToolId; label: string; icon: ReactNode; later?: string }[] = [
  { tool: 'select', label: 'Select', icon: <SelectIcon /> },
  // FLR-T-18.6: the hand, under Select as in the board's rail.
  { tool: 'hand', label: 'Hand', icon: <Hand /> },
  { tool: 'wall', label: 'Draw walls', icon: <WallIcon /> },
  { tool: 'arc', label: 'Draw arc walls', icon: <ArcWallIcon /> },
  { tool: 'door', label: 'Place a door', icon: <DoorIcon /> },
  { tool: 'window', label: 'Place a window', icon: <WindowIcon /> },
  { tool: 'room', label: 'Name a room', icon: <RoomAnchorIcon /> },
  // FLR-T-18.10: one click inside walls makes the room, with its name and function.
  { tool: 'wand', label: 'Make a room (magic wand)', icon: <WandSparkles /> },
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
  const furnitureOpen = useFurniture(store, (f) => f.open);
  // A trade mode offers its own tools (FLR-T-18.3); without one, every tool.
  const rail = useModes(store, () => modesOf(store).rail());
  if (rail !== null) {
    return (
      <nav className="fs-rail" aria-label="Tools">
        {rail.map((item) => (
          <RailButton key={'tool' in item ? item.tool : 'device' in item ? item.device : 'library'} store={store} tools={tools} item={item} canDraw={canDraw} />
        ))}
        <span className="fs-rail__rule" />
        <MeasureButton store={store} tools={tools} />
        <span className="fs-spacer" />
        <span className="fs-rail__pin">
          <PinButton store={store} side="left" />
        </span>
      </nav>
    );
  }
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
              disabled={t.tool === undefined || (t.tool !== 'select' && t.tool !== 'hand' && !canDraw)}
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
      <Tooltip content="Furniture and appliances (I)" side="right">
        <IconButton label="Furniture and appliances" icon={<SofaIcon />} pressed={furnitureOpen} disabled={!canDraw} onClick={() => { furnitureOf(store).set({ open: true, uploading: false }); }} />
      </Tooltip>
      <span className="fs-rail__rule" />
      <MeasureButton store={store} tools={tools} />
      <span className="fs-spacer" />
      {/* The left drawer's pin (FLR-T-18.2): on the rail, the one part of the drawer every state shows. */}
      <span className="fs-rail__pin">
        <PinButton store={store} side="left" />
      </span>
    </nav>
  );
}

/** The measure tool (FLR-T-18.9, ⇧M): in every rail, a mode's included — measuring changes nothing. */
function MeasureButton({ store, tools }: { store: EditorStore; tools: ToolController }) {
  const on = useEditor(store, (s) => s.tool === 'measure');
  const level = useEditor(store, (s) => s.level);
  return (
    <Tooltip content={`Measure (${commandById('tool.measure')?.hint ?? ''})`} side="right">
      <IconButton label="Measure" icon={<MeasureIcon />} pressed={on} disabled={level === null} onClick={() => { tools.setTool(on ? 'select' : 'measure'); }} />
    </Tooltip>
  );
}

/** One tool of a trade mode's rail (FLR-T-18.3): a drawing tool, a device kind, or the furniture library. */
function RailButton({ store, tools, item, canDraw }: { store: EditorStore; tools: ToolController; item: RailItem; canDraw: boolean }) {
  const tool = useEditor(store, (s) => s.tool);
  const device = useEditor(store, (s) => s.draw.device);
  const furnitureOpen = useFurniture(store, (f) => f.open);
  if ('library' in item) {
    return (
      <Tooltip content="Insert from the library (I)" side="right">
        <IconButton label="Furniture and appliances" icon={<SofaIcon />} pressed={furnitureOpen} disabled={!canDraw} onClick={() => { furnitureOf(store).set({ open: true, uploading: false }); }} />
      </Tooltip>
    );
  }
  if ('device' in item) {
    const kind = kindById(item.device);
    const label = kind?.label ?? item.device;
    const command = kind === undefined ? undefined : commandById(`tool.${kind.system}`);
    return (
      <Tooltip content={`${label}${command?.hint === undefined ? '' : ` (${command.hint})`}`} side="right">
        <IconButton label={`Place a ${label.toLowerCase()}`} icon={DEVICE_ICONS[item.device] ?? <PlugIcon />} pressed={tool === 'device' && device === item.device} disabled={!canDraw} onClick={() => { tools.useDevice(item.device); }} />
      </Tooltip>
    );
  }
  const t = RAIL.find((r) => r.tool === item.tool);
  if (t === undefined) return null;
  const command = commandById(`tool.${item.tool}`);
  return (
    <Tooltip content={`${t.label} (${command?.hint ?? ''})`} side="right">
      <IconButton label={t.label} icon={t.icon} pressed={tool === item.tool} disabled={item.tool !== 'select' && item.tool !== 'hand' && !canDraw} onClick={() => { tools.setTool(item.tool); }} />
    </Tooltip>
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
  // The model's own lints (Core chapter 10), listed in the project panel; and the advisory code
  // findings of the rule packs (FLR-T-6.9), drawn on the plan and listed in the findings panel.
  const lints = model?.diagnostics.length ?? 0;
  const findingsOpen = useEditor(store, (s) => s.findingsOpen);
  const showing = useEditor(store, (s) => s.layers.findings);
  const [rules] = useFindings(store.projectId);
  const findings = rules.report?.findings.length ?? 0;
  return (
    <footer className="fs-statusbar">
      <span className="fs-statusbar__mono fs-statusbar__cursor">{cursor === null ? 'Cursor —' : `Cursor ${formatLen(Math.round(cursor[0]), units)}, ${formatLen(Math.round(cursor[1]), units)}`}</span>
      {/* FLR-T-18.9: what snaps, and the menu to change it. */}
      <SnapStatus store={store} />
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
      <ModeStatus store={store} />
      {model !== null ? (
        <button
          type="button"
          className="fs-statusbar__item fs-statusbar__findings"
          title="The model's own checks, listed in the project panel"
          onClick={() => {
            store.set({ findingsOpen: false });
            store.select(null);
            store.setTool('select');
          }}
        >
          {model.valid ? <CircleCheck className="fs-ok" aria-hidden="true" /> : <TriangleAlert className="fs-bad" aria-hidden="true" />}
          {model.valid ? 'Model valid' : 'Model invalid'}
          {lints > 0 ? ` · ${String(lints)} ${lints === 1 ? 'note' : 'notes'}` : ''}
        </button>
      ) : null}
      <button
        type="button"
        className="fs-statusbar__item fs-statusbar__findings"
        aria-pressed={findingsOpen}
        title="Advisory code findings: not a plan review"
        // Opening the findings brings them over a proposal under review; the proposal stays in the top bar.
        onClick={() => { store.set(findingsOpen ? { findingsOpen: false } : { findingsOpen: true, side: 'inspector' }); }}
      >
        <TriangleAlert className={findings > 0 ? 'fs-warn' : 'fs-faint'} aria-hidden="true" />
        {rules.report === null ? 'Findings' : findings === 1 ? '1 finding' : `${String(findings)} findings`}
        {findings > 0 && showing ? ' · on the plan' : ''}
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
      // Esc in a drawer — on anything but a text field, a closed picker included — puts it away
      // and comes back to the canvas (FLR-T-18.2). A menu that took the Esc to close itself marks it handled.
      if (e.key === 'Escape' && !e.defaultPrevented && !(target !== null && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) && document.querySelector('[role="dialog"]') === null && escapeDrawer(store, target)) {
        e.preventDefault();
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
      // Shift+F in the arc-wall tool's bulge step flips the bulge (Core 0.4, 21), before F's own shortcut.
      if (e.key.toLowerCase() === 'f' && e.shiftKey && !mod && !e.altKey && tools.flipArc()) {
        e.preventDefault();
        return;
      }
      // A length being typed while drawing takes the key before any shortcut does.
      if (!mod && !e.altKey && tools.typeKey(e.key)) {
        e.preventDefault();
        return;
      }
      // Tab in the arc-wall tool's bulge step switches between typing the sagitta and the radius (Core 0.4, 21).
      if (e.key === 'Tab' && !mod && !e.altKey && !e.shiftKey && tools.arcField()) {
        e.preventDefault();
        return;
      }
      // Tab (⇧Tab back) with the magic wand's prompt up: the next space the click could mean (FLR-T-18.10).
      if (e.key === 'Tab' && !mod && !e.altKey && tools.cycleWand(e.shiftKey)) {
        e.preventDefault();
        return;
      }
      if (e.key === 'Enter' && tools.enter()) {
        e.preventDefault();
        return;
      }
      if (e.key === 'Escape') {
        // A menu or a listbox took this Esc to close itself (Radix marks it handled).
        if (e.defaultPrevented) return;
        e.preventDefault();
        const s = store.get();
        const quiet = s.tool === 'select' && s.selection === null && s.rejection === null && s.picking === null && (s.draft === null || (s.draft.tool === 'select' && s.draft.drag === null && s.draft.typed === ''));
        if (s.compare !== null && s.draft === null) endCompare(store);
        // With nothing left to escape, Esc leaves full screen.
        else if (quiet && drawersOf(store).get().full) setFullScreen(store, false);
        else tools.escape();
        return;
      }
      // FLR-T-18.10: ⌥ and an arrow push a selected room's side out, ⌥⇧ pull it in.
      if (roomKey(store, e)) {
        e.preventDefault();
        return;
      }
      // FLR-T-18.8: ⌥A array, ⌥⇧H/⌥⇧V distribute, ⇧H/⇧V mirror, the arrows moving several at once.
      if (arrangeKey(store, e, mac)) {
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
      // A key a modifier changes the character of (⇧1, ⌥H, ⇧N) is read by its place first (FLR-T-18.6).
      const command = commandForCode(codeOf(e, mac)) ?? commandFor(keyOf(e, mac));
      if (command === undefined) return;
      if (command.enabled !== undefined && !command.enabled(store)) return;
      e.preventDefault();
      command.run(store, tools);
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.key === ' ') tools.space = false;
    };
    // The edge drawers' keys reach them from anywhere, a field that keeps its keys to itself
    // included — so they are read on the way down (FLR-T-18.2): ⌘\ left, ⌘⌥\ top, ⌘⇧\ right, by
    // the key's place since ⌥ and ⇧ change the character it types; F6 and ⇧F6 to cycle.
    const onDrawerKey = (e: KeyboardEvent) => {
      if (document.querySelector('[role="dialog"]') !== null) return;
      if ((mac ? e.metaKey : e.ctrlKey) && (e.code === 'Backslash' || e.key === '\\' || e.key === '|')) {
        e.preventDefault();
        e.stopPropagation();
        summonDrawer(store, e.altKey ? 'top' : e.shiftKey ? 'right' : 'left');
      } else if (e.key === 'F6') {
        e.preventDefault();
        e.stopPropagation();
        cycleFocus(store, e.shiftKey);
      }
    };
    window.addEventListener('keydown', onDrawerKey, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onUp);
    return () => {
      window.removeEventListener('keydown', onDrawerKey, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onUp);
    };
  }, [store, tools]);
}

export { COMMANDS };
