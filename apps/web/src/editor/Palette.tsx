import { useMemo, useState, type ReactNode } from 'react';
import { CommandPalette, CommandPaletteHint, type CommandPaletteGroup, type CommandPaletteItem } from '@d3cloud/ui';
import { ArrowRightLeft, Check, History, Layers, Move, Ruler, Search, Sparkles, X } from 'lucide-react';
import { useEditor, type EditorStore } from './store';
import type { ToolController } from './tools';
import { COMMANDS, type Command } from './commands';
import { kindOf, labelOf, type EditorModel } from './model';
import { formatArea, formatLen, parseLen, parsePoint, prettyLen } from './units';
import { moveJunction, moveWall } from './ops';
import { accept, openReview, reject } from './review';
import { DoorIcon, JunctionIcon, RoomIcon, SelectIcon, SeparatorIcon, WallIcon, WindowIcon } from './icons';

/**
 * The command palette (FLR-T-3.7), ⌘K, the board's "07 · Editor — command palette": every command
 * in the registry, and around them what the model offers — each level, each proposal and its
 * accept and reject, each unnamed space to name, and (once something is typed) every element on
 * the level to go to. A few commands take a value in a second step, typed into the same input:
 * the nudge step, a point to draw walls from, a distance to move the selected wall, a point to
 * move the selected junction to.
 */

type Step =
  | { kind: 'nudge' }
  | { kind: 'drawFrom' }
  | { kind: 'moveWall'; id: string }
  | { kind: 'moveJunction'; id: string };

const ICONS: Partial<Record<string, ReactNode>> = {
  'tool.select': <SelectIcon />,
  'tool.wall': <WallIcon />,
  'tool.door': <DoorIcon />,
  'tool.window': <WindowIcon />,
  'tool.room': <RoomIcon />,
  'tool.separator': <SeparatorIcon />,
  'edit.addDoor': <DoorIcon />,
  'edit.addWindow': <WindowIcon />,
  'edit.nameRoom': <RoomIcon />,
  'history.toggle': <History />,
  'history.compareLast': <ArrowRightLeft />,
  'review.open': <Sparkles />,
  'review.accept': <Check />,
  'review.reject': <X />,
};

const matches = (query: string, ...texts: (string | undefined)[]) => {
  const hay = texts.filter((t) => t !== undefined).join(' ').toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w !== '')
    .every((w) => hay.includes(w));
};

export function Palette({ store, tools }: { store: EditorStore; tools: ToolController }) {
  const open = useEditor(store, (s) => s.palette);
  const [query, setQuery] = useState('');
  const [step, setStep] = useState<Step | null>(null);
  // Re-render whenever the store does while open, so enabled states are current.
  const state = useEditor(store, (s) => s);
  const units = store.units;

  const close = (next: boolean) => {
    store.set({ palette: next });
    if (!next) {
      setQuery('');
      setStep(null);
    }
  };

  const groups = useMemo<CommandPaletteGroup[]>(() => {
    if (!open) return [];
    if (step !== null) return stepGroups(store, tools, step, query, () => { close(false); });
    const model = state.model;
    const run = (c: Command) => () => {
      c.run(store, tools);
    };
    const item = (c: Command): CommandPaletteItem => ({
      id: c.id,
      label: c.label,
      ...(c.hint === undefined ? {} : { shortcut: c.hint }),
      ...(ICONS[c.id] === undefined ? {} : { leading: ICONS[c.id] }),
      disabled: c.enabled !== undefined && !c.enabled(store),
      onSelect: run(c),
    });
    const out: CommandPaletteGroup[] = [];
    const pick = (c: Command) => matches(query, c.label, c.group, c.keywords, c.id);

    // Selection first: what can be done to what is selected.
    const sel = state.selection;
    const kind = model === null || sel === null ? null : kindOf(model, sel);
    const selItems: CommandPaletteItem[] = [];
    if (model !== null && sel !== null && kind !== null && state.compare === null) {
      const name = labelOf(model, sel);
      if (kind === 'wall') selItems.push({ id: 'sel.moveWall', label: `Move ${name} by…`, description: 'a typed distance, sideways', leading: <Move />, onSelect: () => { setStep({ kind: 'moveWall', id: sel }); setQuery(''); return false; } });
      if (kind === 'junction') selItems.push({ id: 'sel.moveJunction', label: `Move ${name} to…`, description: 'a typed point x, y', leading: <Move />, onSelect: () => { setStep({ kind: 'moveJunction', id: sel }); setQuery(''); return false; } });
    }
    const selCommands = COMMANDS.filter((c) => ['edit.addDoor', 'edit.addWindow', 'edit.rename', 'edit.delete', 'edit.selectNone'].includes(c.id) && (c.enabled === undefined || c.enabled(store)));
    const selectionGroup = [...selItems, ...selCommands.map(item)].filter((i) => matches(query, i.label, 'selection'));
    if (selectionGroup.length > 0) out.push({ id: 'selection', label: model !== null && sel !== null ? `Selection · ${labelOf(model, sel)}` : 'Selection', items: selectionGroup });

    // Proposals.
    const proposalItems: (CommandPaletteItem & { words: string })[] = [];
    for (const p of state.proposals) {
      const reviewing = state.review?.id === p.id;
      const by = p.createdBy ?? 'agent';
      proposalItems.push({ id: `p.open.${p.id}`, label: `Review “${p.name}”`, description: `${by} · ${String(p.ops ?? 0)} ops`, leading: <Sparkles />, words: by, onSelect: () => void openReview(store, p.id) });
      const r = state.review;
      if (reviewing && r !== null) {
        proposalItems.push({ id: `p.accept.${p.id}`, label: `Accept “${p.name}”`, leading: <Check />, words: by, disabled: r.busy !== null || r.loading, onSelect: () => void accept(store) });
        proposalItems.push({ id: `p.reject.${p.id}`, label: `Reject “${p.name}”`, leading: <X />, words: by, disabled: r.busy !== null, onSelect: () => void reject(store) });
      }
    }
    const proposals = proposalItems.filter((i) => matches(query, i.label, 'proposal changeset claude', i.words)).map(({ words: _words, ...i }) => i);
    if (proposals.length > 0) out.push({ id: 'proposals', label: 'Proposals', items: proposals });

    for (const group of ['Tools', 'Edit', 'Review', 'History', 'View', 'Model'] as const) {
      const items = COMMANDS.filter((c) => c.group === group && !selCommands.includes(c) && c.id !== 'view.palette' && pick(c)).map(item);
      if (group === 'Model' && matches(query, 'nudge step arrow settings')) {
        items.push({ id: 'set.nudge', label: 'Set the nudge step…', description: `now ${prettyLen(store.nudgeStep, units)} · Shift × ${units === 'metric' ? '10' : '12'}`, leading: <Ruler />, onSelect: () => { setStep({ kind: 'nudge' }); setQuery(''); return false; } });
      }
      if (group === 'Tools' && matches(query, 'draw walls from point start typed coordinates')) {
        items.push({ id: 'draw.from', label: 'Draw walls from a point…', description: 'type x, y', leading: <WallIcon />, disabled: state.level === null || state.readOnly !== null || state.compare !== null, onSelect: () => { setStep({ kind: 'drawFrom' }); setQuery(''); return false; } });
      }
      if (items.length > 0) out.push({ id: group, label: group, items });
    }

    if (model !== null) {
      const levels = model.levels
        .filter((l) => matches(query, 'go to level', l.name))
        .map((l): CommandPaletteItem => ({ id: `level.${l.id}`, label: `Go to ${l.name}`, description: `${formatLen(l.elevation, units)} · ${String(l.rooms.length)} rooms`, leading: <Layers />, disabled: l.id === state.level, onSelect: () => { store.setLevel(l.id); } }));
      if (levels.length > 0) out.push({ id: 'levels', label: 'Levels', items: levels });

      const spaces = state.compare === null && state.readOnly === null
        ? tools.unnamedSpaces().map((f, i): CommandPaletteItem => ({ id: `space.${String(i)}`, label: `Name a room in unnamed space ${String(i + 1)}`, description: formatArea(f.area2, units), leading: <RoomIcon />, onSelect: () => { tools.nameRoomIn(f); } })).filter((i) => matches(query, i.label, 'add room'))
        : [];
      if (spaces.length > 0) out.push({ id: 'spaces', label: 'Rooms', items: spaces });

      if (query.trim() !== '') {
        const found = elementsOnLevel(model, state.level).filter((e) => matches(query, e.label, e.id, e.kind)).slice(0, 12);
        if (found.length > 0) out.push({ id: 'goto', label: 'Go to', items: found.map((e) => ({ id: `goto.${e.id}`, label: e.label, description: e.id, leading: <Search />, onSelect: () => { store.select(e.id); } })) });
      }
    }
    return out;
  }, [open, step, query, state, store, tools, units]);

  return (
    <CommandPalette
      open={open}
      onOpenChange={close}
      query={query}
      onQueryChange={setQuery}
      groups={groups}
      label="Search commands and the plan"
      placeholder={step === null ? 'Type a command, a level, a room…' : step.kind === 'nudge' ? 'A length: 1", 1/2", 10mm' : step.kind === 'moveWall' ? 'A distance: 6", -1\'' : 'A point: x, y'}
      emptyMessage={step === null ? `Nothing matches “${query}”` : 'Type a value'}
      footer={
        <>
          <CommandPaletteHint keys={['↑', '↓']}>navigate</CommandPaletteHint>
          <CommandPaletteHint keys={['↵']}>run</CommandPaletteHint>
          <CommandPaletteHint keys={['esc']}>close</CommandPaletteHint>
          <span className="fs-palette__note">Every command is a Floorspec op — undo appends its inverse.</span>
        </>
      }
    />
  );
}

function elementsOnLevel(model: EditorModel, levelId: string | null): { id: string; label: string; kind: string }[] {
  const level = model.levels.find((l) => l.id === levelId);
  if (level === undefined) return [];
  const ids = [...level.rooms.map((r) => r.id), ...level.walls.map((w) => w.id), ...level.openings.map((o) => o.id), ...level.separators.map((s) => s.id), ...level.junctions.map((j) => j.id)];
  return ids.map((id) => ({ id, label: labelOf(model, id), kind: kindOf(model, id) ?? '' }));
}

/** The second step: one item that applies the typed value, or says why it cannot. */
function stepGroups(store: EditorStore, tools: ToolController, step: Step, query: string, done: () => void): CommandPaletteGroup[] {
  const units = store.units;
  const model = store.get().model;
  const items: CommandPaletteItem[] = [];
  if (step.kind === 'nudge') {
    const parsed = parseLen(query, units);
    items.push(
      parsed.ok && parsed.value > 0
        ? { id: 'nudge.set', label: `Nudge by ${prettyLen(parsed.value, units)}`, description: `Shift: ${prettyLen(parsed.value * (units === 'metric' ? 10 : 12), units)}`, leading: <Ruler />, onSelect: () => { store.setNudge(parsed.value); } }
        : { id: 'nudge.bad', label: query.trim() === '' ? 'Type the step' : parsed.ok ? 'A step is longer than zero' : parsed.reason, disabled: true, onSelect: () => undefined },
    );
    items.push({ id: 'nudge.reset', label: `Back to the default (${units === 'metric' ? '10 mm' : '1"'})`, leading: <Ruler />, onSelect: () => { store.setNudge(null); } });
    return [{ id: 'nudge', label: 'Nudge step', items }];
  }
  if (step.kind === 'moveWall') {
    const parsed = parseLen(query, units);
    const name = model === null ? step.id : labelOf(model, step.id);
    items.push(
      parsed.ok && parsed.value !== 0
        ? { id: 'mv', label: `Move ${name} ${formatLen(parsed.value, units)} ${parsed.value > 0 ? 'to its exterior side' : 'to its interior side'}`, leading: <Move />, onSelect: () => void store.apply(`Move ${name}`, moveWall(step.id, parsed.value), { select: () => step.id }) }
        : { id: 'bad', label: query.trim() === '' ? 'Type a distance; negative moves it inward' : parsed.ok ? 'Type a distance other than zero' : parsed.reason, disabled: true, onSelect: () => undefined },
    );
    return [{ id: 'move', label: 'Move wall', items }];
  }
  const parsed = parsePoint(query, units);
  if (step.kind === 'moveJunction') {
    const name = model === null ? step.id : labelOf(model, step.id);
    items.push(
      parsed.ok
        ? { id: 'mj', label: `Move ${name} to ${formatLen(parsed.value[0], units)}, ${formatLen(parsed.value[1], units)}`, leading: <JunctionIcon />, onSelect: () => void store.apply(`Move ${name}`, moveJunction(step.id, parsed.value), { select: () => step.id }) }
        : { id: 'bad', label: query.trim() === '' ? 'Type a point: x, y' : parsed.reason, disabled: true, onSelect: () => undefined },
    );
    return [{ id: 'move', label: 'Move junction', items }];
  }
  items.push(
    parsed.ok
      ? {
          id: 'df',
          label: `Draw walls from ${formatLen(parsed.value[0], units)}, ${formatLen(parsed.value[1], units)}`,
          description: 'then arrows to aim, a length and Enter',
          leading: <WallIcon />,
          onSelect: () => {
            tools.startChainAt(parsed.value);
            done();
          },
        }
      : { id: 'bad', label: query.trim() === '' ? 'Type a point: x, y' : parsed.reason, disabled: true, onSelect: () => undefined },
  );
  return [{ id: 'draw', label: 'Draw walls', items }];
}
