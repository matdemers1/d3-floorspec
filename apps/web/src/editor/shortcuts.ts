import { COMMANDS, type Command } from './commands';

/**
 * The editor's keys as people read them (FLR-T-18.16): the shortcut sheet (?) and every tooltip,
 * menu and palette row that shows a command's keys take them from the command registry — a
 * command's `hint` — so a key is written once. Beside the registry are the keys that work only in
 * context (the arrows on a selection, a focused handle, a ghost being placed): they are not commands,
 * so the sheet lists them from CONTEXT_KEYS below, kept with the handlers that read them in mind.
 *
 * Hints are written in the Mac's glyphs (⌘ ⌥ ⇧), as the board draws them. What assistive technology
 * hears is spelled out for the platform: "Command Z" on a Mac, "Control Z" elsewhere.
 */

export interface SheetRow {
  id: string;
  label: string;
  /** The keys as shown: "⌥H", "⇧1", "Arrows". */
  keys: string;
  /** More words the search matches on. */
  words?: string;
}

export interface SheetGroup {
  id: string;
  label: string;
  rows: SheetRow[];
}

/** The registry's groups as the sheet orders them, and what each is called there. */
const GROUP_ORDER: readonly [Command['group'], string][] = [
  ['Tools', 'Tools'],
  ['Edit', 'Editing'],
  ['View', 'View and navigation'],
  ['History', 'History'],
  ['Review', 'Review'],
  ['Model', 'Model'],
];

/**
 * Keys read in context by the editor's handlers, not by the registry: the plan with a selection,
 * a focused handle, drawing, placing, the magic wand, the drawers, the element list.
 */
export const CONTEXT_KEYS: readonly SheetGroup[] = [
  {
    id: 'plan',
    label: 'On the plan',
    rows: [
      { id: 'plan.nudge', label: 'Nudge the selection by the nudge step (with nothing selected: pan)', keys: '← ↑ → ↓', words: 'arrows move' },
      { id: 'plan.nudgeBig', label: 'Nudge twelve steps (ten in metric)', keys: '⇧ ← ↑ → ↓', words: 'arrows shift' },
      { id: 'plan.roomOut', label: 'Push a selected room’s side out by the nudge step', keys: '⌥ ← ↑ → ↓', words: 'room resize edge' },
      { id: 'plan.roomIn', label: 'Pull a selected room’s side in', keys: '⌥⇧ ← ↑ → ↓', words: 'room resize edge' },
      { id: 'plan.handles', label: 'Move into the selection’s handles', keys: 'Tab', words: 'resize handle keyboard' },
      { id: 'plan.pan', label: 'Pan while held, with a drag', keys: 'Space', words: 'hand drag' },
      { id: 'plan.enter', label: 'Finish what is being drawn, or place it', keys: '↵', words: 'enter return' },
      { id: 'plan.escape', label: 'Cancel, clear the selection, then leave full screen', keys: 'Esc', words: 'escape' },
    ],
  },
  {
    id: 'handles',
    label: 'A focused handle',
    rows: [
      { id: 'handles.next', label: 'The next handle, or the one before', keys: 'Tab ⇧Tab' },
      { id: 'handles.grow', label: 'Move the handle out: bigger by the snap step', keys: '→ ↑', words: 'resize grow larger' },
      { id: 'handles.shrink', label: 'Move the handle in: smaller by the snap step', keys: '← ↓', words: 'resize shrink smaller' },
      { id: 'handles.coarse', label: 'Four snap steps at a time', keys: '⇧ ← ↑ → ↓', words: 'resize coarse' },
      { id: 'handles.rotate', label: 'Turn the item 15° at a time (⇧ for 1°), on the rotate handle', keys: '← →', words: 'rotate turn' },
      { id: 'handles.type', label: 'Type an exact size', keys: '↵', words: 'width depth inspector' },
      { id: 'handles.back', label: 'Back to the plan', keys: 'Esc' },
    ],
  },
  {
    id: 'drawing',
    label: 'Drawing',
    rows: [
      { id: 'draw.length', label: 'Type a length, then Enter to place it', keys: '0–9 ↵', words: 'wall length typed' },
      { id: 'draw.aim', label: 'Aim the next wall', keys: '← ↑ → ↓', words: 'arrows direction' },
      { id: 'draw.radius', label: 'Switch between the sagitta and the radius of an arc', keys: 'Tab', words: 'arc bulge' },
      { id: 'draw.wand', label: 'The next space the magic wand could mean', keys: 'Tab ⇧Tab', words: 'room wand' },
    ],
  },
  {
    id: 'placing',
    label: 'Placing from the library',
    rows: [
      { id: 'place.turn', label: 'Turn the ghost 90°', keys: 'R  [  ]', words: 'rotate' },
      { id: 'place.fine', label: 'Turn the ghost 15°', keys: '⇧[  ⇧]', words: 'rotate fine' },
      { id: 'place.move', label: 'Move the ghost by the nudge step (⇧ for ten)', keys: '← ↑ → ↓', words: 'arrows' },
      { id: 'place.here', label: 'Place it there', keys: '↵', words: 'enter' },
      { id: 'place.stop', label: 'Stop placing', keys: 'Esc' },
    ],
  },
  {
    id: 'panels',
    label: 'Drawers and lists',
    rows: [
      { id: 'panels.cycle', label: 'Move between the plan and the drawers', keys: 'F6 ⇧F6', words: 'focus region' },
      { id: 'panels.back', label: 'Put a drawer away and come back to the plan', keys: 'Esc' },
      { id: 'panels.list', label: 'In the element list: move, select, add to the selection', keys: '↑ ↓  Space  ⇧/⌘ Space', words: 'elements list select multi' },
      { id: 'panels.extend', label: 'In the element list: extend the selection', keys: '⇧↑ ⇧↓', words: 'elements list select multi' },
    ],
  },
];

const words = (query: string) =>
  query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w !== '');

const matches = (query: string, ...texts: (string | undefined)[]) => {
  const hay = texts.filter((t) => t !== undefined).join(' ').toLowerCase();
  return words(query).every((w) => hay.includes(w));
};

/**
 * The sheet: every command in the registry that has keys, by group, then the keys in context —
 * each narrowed to what a search matches (a command's label, keys, group and keywords).
 */
export function sheetGroups(query = '', commands: readonly Command[] = COMMANDS): SheetGroup[] {
  const out: SheetGroup[] = [];
  for (const [group, label] of GROUP_ORDER) {
    const rows = commands
      .filter((c) => c.group === group && c.hint !== undefined)
      .map((c): SheetRow => ({ id: c.id, label: c.label, keys: c.hint as string, ...(c.keywords === undefined ? {} : { words: c.keywords }) }))
      .filter((r) => matches(query, r.label, r.keys, label, r.words));
    if (rows.length > 0) out.push({ id: group, label, rows });
  }
  for (const g of CONTEXT_KEYS) {
    const rows = g.rows.filter((r) => matches(query, r.label, r.keys, g.label, r.words));
    if (rows.length > 0) out.push({ ...g, rows });
  }
  return out;
}

const SPOKEN: Readonly<Record<string, string>> = {
  '⇧': 'Shift',
  '⌫': 'Delete',
  '↵': 'Enter',
  '←': 'Left arrow',
  '→': 'Right arrow',
  '↑': 'Up arrow',
  '↓': 'Down arrow',
  '−': 'Minus',
  '-': 'Minus',
  '+': 'Plus',
  '[': 'Left bracket',
  ']': 'Right bracket',
  '/': 'Slash',
  '\\': 'Backslash',
  '?': 'Question mark',
  Esc: 'Escape',
  PgUp: 'Page Up',
  PgDn: 'Page Down',
};

/** What a screen reader should say for a hint: "Option H", "Shift 1", "Control Z" off a Mac. */
export function spokenKeys(hint: string, mac: boolean): string {
  const out: string[] = [];
  for (const token of hint.split(/(\s+|[⌘⌥⇧⌫↵←→↑↓−])/u).filter((t) => t.trim() !== '')) {
    if (token === '⌘') out.push(mac ? 'Command' : 'Control');
    else if (token === '⌥') out.push(mac ? 'Option' : 'Alt');
    else out.push(SPOKEN[token] ?? token);
  }
  return out.join(' ');
}

/**
 * A hint as `aria-keyshortcuts` writes it ("Meta+K", "Alt+1", "Shift+?"), for a control that runs
 * the command; undefined for a hint that is not one chord (an arrow set, two alternatives).
 */
export function ariaKeys(hint: string | undefined, mac: boolean): string | undefined {
  if (hint === undefined || /\s/.test(hint.trim())) return undefined;
  const mods: string[] = [];
  let rest = hint;
  for (;;) {
    const c = rest[0];
    if (c === '⌘') mods.push(mac ? 'Meta' : 'Control');
    else if (c === '⌥') mods.push('Alt');
    else if (c === '⇧') mods.push('Shift');
    else break;
    rest = rest.slice(1);
  }
  if (rest === '') return undefined;
  const key = rest === '⌫' ? 'Backspace' : rest === '−' ? '-' : rest === 'PgUp' ? 'PageUp' : rest === 'PgDn' ? 'PageDown' : rest === '↵' ? 'Enter' : rest;
  return [...mods.sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b)), key].join('+');
}

const ORDER = ['Control', 'Meta', 'Alt', 'Shift'];

/** Whether this browser is on a Mac (⌘ is Command there, Control elsewhere). */
export const onMac = (): boolean => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/** A command's keys from the registry, for a tooltip: "⌥H"; undefined for a command without keys. */
export const keyHint = (id: string): string | undefined => COMMANDS.find((c) => c.id === id)?.hint;

/** A tooltip naming a control and its command's keys: "Undo (⌘Z)", or just "Undo". */
export const withKeys = (label: string, id: string): string => {
  const hint = keyHint(id);
  return hint === undefined ? label : `${label} (${hint})`;
};
