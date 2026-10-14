import './planStyle.css';
import { useState, type CSSProperties } from 'react';
import { Button, Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, SegmentedControl, Switch, useToast } from '@d3cloud/ui';
import { Check, ChevronDown, Download, Palette as PaletteIcon } from 'lucide-react';
import type { FloorspecDocument } from '@floorspec/engine';
import { useEditor, type EditorStore, type Viewport } from './store';
import type { LevelView, Point, Ring } from './model';
import { centroid, inFace } from './geometry';
import { toScreen } from './viewport';
import { formatArea, type UnitSystem } from './units';
import { Section } from './fields';
import { PLAN_STYLES, STYLES, planStylesOf, useCurrentStyle, useDocumentTheme, usePlanStyles, type LevelPaint, type PlanLook, type PlanStyle, type StyleDetails } from './planStyle';

/**
 * Plan styles in the page (FLR-T-18.5), after the board's "18.5" frames: the style dropdown in the
 * top bar; the "Plan style" section of the inspector when nothing is selected — the four styles,
 * their details as switches, whether the choice is for the project or only an export, and "Export a
 * still (PNG)"; and, on the canvas, the walls in their style (by type in Construction mode, with its
 * legend), the room names on pills, and the floors' patterns (render2d's markup, planStyle.ts).
 */

const S = (v: Viewport, p: Point) => toScreen(v, p);
const ringD = (v: Viewport, r: Ring): string => `M${r.map((p) => S(v, p).map((n) => n.toFixed(1)).join(' ')).join('L')}Z`;

/** The `<pattern>`s and hatches the level's fills name: render2d's markup, numbers and colours only. */
export function PlanStyleDefs({ paint }: { paint: LevelPaint }) {
  return paint.defs === '' ? null : <defs dangerouslySetInnerHTML={{ __html: paint.defs }} />;
}

/**
 * The walls in a style: one poché with its edge under it, so pieces join without seams; then each
 * class of wall in its fill — Technical's exterior walls hatched over the paper — or, in
 * Construction mode, each wall type in its colour.
 */
export function StyledWalls({ view, level, paint }: { view: Viewport; level: LevelView; paint: LevelPaint }) {
  const t = paint.look.theme;
  const pieces = [...level.walls.map((w) => ({ id: w.id, ring: w.ring })), ...level.fills.map((f) => ({ id: f.id, ring: f.ring }))];
  const groups = new Map<string, { fill: string; hatch: boolean; tag: Record<string, string>; d: string }>();
  for (const p of pieces) {
    const w = paint.wall(p.id);
    const key = w.type === undefined ? w.cls : `type:${w.type}`;
    const g = groups.get(key) ?? { fill: w.fill, hatch: w.hatch, tag: w.type === undefined ? { 'data-wall-class': w.cls } : { 'data-wall-type': w.type }, d: '' };
    g.d += ringD(view, p.ring);
    groups.set(key, g);
  }
  const all = pieces.map((p) => ringD(view, p.ring)).join('');
  return (
    <g className="fs-plan2__walls fs-plan2__walls--styled">
      <path className="fs-plan2__wall-edge" d={all} style={{ fill: t.wallEdge, stroke: t.wallEdge, strokeWidth: 2 * t.weights.wall }} strokeLinejoin="round" />
      {[...groups.values()]
        .sort((a, b) => Number(b.hatch) - Number(a.hatch))
        .map((g) => (
          <g key={`${g.fill}:${String(g.d.length)}`}>
            <path {...g.tag} d={g.d} style={{ fill: g.fill, stroke: g.fill, strokeWidth: 0.5 }} strokeLinejoin="round" />
            {g.hatch ? <path d={g.d} fill="url(#fsx-wall-hatch)" /> : null}
          </g>
        ))}
    </g>
  );
}

/** Room names in a style: on pills in a colour plan, in spaced capitals in a technical one. */
export function StyledRoomLabels({ view, level, document, units, look }: { view: Viewport; level: LevelView; document: FloorspecDocument; units: UnitSystem; look: PlanLook }) {
  const caps = look.theme.caps;
  const pills = look.theme.colour && look.details.pills;
  return (
    <g className="fs-plan2__labels fs-plan2__labels--styled" data-pills={pills ? 'on' : undefined}>
      {level.rooms.map((room) => {
        const xs = room.outer.map((p) => p[0]);
        const width = (Math.max(...xs) - Math.min(...xs)) * view.s;
        if (width < 36) return null;
        const c = centroid(room.outer);
        const at = inFace(c, room) ? c : room.anchor;
        const [x, y] = S(view, at);
        const source = document.rooms?.[room.id];
        const raw = typeof source?.name === 'string' ? source.name : room.id;
        const name = caps ? raw.toUpperCase() : raw;
        const area = formatArea(room.area2, units);
        const small = width < 90;
        const w = Math.max(name.length * (caps ? 7.4 : 6.9), small ? 0 : area.length * 6.1) + 16;
        const h = small ? 20 : 34;
        return (
          <g key={room.id} data-room-label={room.id}>
            {pills ? <rect className="fs-plan2__pill" x={x - w / 2} y={y - h / 2} width={w} height={h} rx={6} /> : null}
            <text x={x} y={y + (small ? 4 : -3)} textAnchor="middle">
              <tspan className="fs-plan2__name">{name}</tspan>
              {small ? null : (
                <tspan className="fs-plan2__area" x={x} dy="15">
                  {area}
                </tspan>
              )}
            </text>
          </g>
        );
      })}
    </g>
  );
}

/** Construction mode's legend (FLR-T-18.3, 18.5): each wall type on the level in its colour, and the doors' amber. */
export function WallTypeLegend({ paint }: { paint: LevelPaint }) {
  if (!paint.look.byType || paint.legend.length === 0) return null;
  return (
    <div className="fs-wall-legend" role="group" aria-label="Wall types">
      <p className="fs-wall-legend__title">Wall types</p>
      <ul>
        {paint.legend.map((l) => (
          <li key={l.id}>
            <span className="fs-wall-legend__swatch" style={{ background: l.colour }} aria-hidden="true" />
            {l.name}
          </li>
        ))}
        <li>
          <span className="fs-wall-legend__swatch" style={{ background: 'var(--fsx-door)' }} aria-hidden="true" />
          Door leaves and swings
        </li>
      </ul>
    </div>
  );
}

// ─── The top bar's dropdown ─────────────────────────────────────────────────────────────────

/** The style dropdown (the board's "Presentation ▾"): the four styles, and the Plan style section. */
export function PlanStyleMenu({ store }: { store: EditorStore }) {
  const current = useCurrentStyle(store);
  const styles = planStylesOf(store);
  return (
    <Menu>
      <MenuTrigger>
        <Button className="fs-style-menu__trigger" size="sm" variant="secondary" icon={<PaletteIcon />} aria-label={`Plan style: ${STYLES[current].label}`}>
          <span className="fs-style-menu__label">{STYLES[current].label}</span>
          <ChevronDown className="fs-style-menu__chevron" aria-hidden="true" />
        </Button>
      </MenuTrigger>
      <MenuContent align="start" className="fs-style-menu">
        <MenuLabel>Plan style</MenuLabel>
        {PLAN_STYLES.map((s) => (
          <MenuItem key={s} icon={s === current ? <Check /> : <span className="fs-style-menu__blank" />} onSelect={() => { styles.choose(s); }}>
            <span className="fs-style-menu__row">
              <span>{STYLES[s].label}</span>
              <span className="fs-style-menu__summary">{STYLES[s].summary}</span>
            </span>
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuItem
          onSelect={() => {
            // The Plan style section is the inspector's when nothing is selected.
            store.set({ selection: null, selected: [], side: 'inspector' });
            requestAnimationFrame(() => document.getElementById('fs-plan-style')?.scrollIntoView({ block: 'start' }));
          }}
        >
          Details, exports and a still…
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

// ─── The inspector's section ────────────────────────────────────────────────────────────────

const DETAILS: readonly { key: keyof StyleDetails; label: string; only?: readonly PlanStyle[] }[] = [
  { key: 'shadows', label: 'Soft shadows', only: ['presentation'] },
  { key: 'patterns', label: 'Floor patterns to scale', only: ['colour', 'presentation'] },
  { key: 'furniture', label: 'Furniture in colour', only: ['colour', 'presentation'] },
  { key: 'pills', label: 'Room labels on pills', only: ['colour', 'presentation'] },
  { key: 'landscape', label: 'Lawn and paving' },
];

/** The board's "Plan style" page: styles, details, what the choice is for, and a still of the plan. */
export function PlanStyleSection({ store }: { store: EditorStore }) {
  const current = useCurrentStyle(store);
  const details = usePlanStyles(store, (s) => s.details);
  const exportStyle = usePlanStyles(store, (s) => s.exportStyle);
  const styles = planStylesOf(store);
  const [useFor, setUseFor] = useState<'project' | 'export'>(exportStyle === null ? 'project' : 'export');
  const shown = useFor === 'export' ? (exportStyle ?? current) : current;
  return (
    <Section title="Plan style">
      <div id="fs-plan-style" className="fs-plan-style">
        <div className="fs-plan-style__choices" role="radiogroup" aria-label="Plan style">
          {PLAN_STYLES.map((s) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={s === shown}
              className="fs-plan-style__choice"
              onClick={() => { styles.choose(s, useFor); }}
            >
              <span className="fs-plan-style__label">{STYLES[s].label}</span>
              <span className="fs-plan-style__summary">{STYLES[s].summary}</span>
              {s === shown ? <Check className="fs-plan-style__check" aria-hidden="true" /> : null}
            </button>
          ))}
        </div>
        <p className="fs-overline fs-plan-style__head">Details</p>
        {DETAILS.map((d) => {
          const applies = d.only === undefined || d.only.includes(shown);
          return (
            <Switch key={d.key} checked={details[d.key] && applies} disabled={!applies} onCheckedChange={(on) => { styles.setDetail(d.key, on); }}>
              {d.label}
            </Switch>
          );
        })}
        <p className="fs-overline fs-plan-style__head">Use for</p>
        <SegmentedControl
          aria-label="Use the style for"
          size="sm"
          value={useFor}
          items={[{ value: 'project', label: 'This project' }, { value: 'export', label: 'PDF export only' }]}
          onValueChange={(v) => { setUseFor(v as 'project' | 'export'); }}
        />
        <StillButton store={store} style={shown} />
      </div>
    </Section>
  );
}

/** "Download a still (PNG)": the level's plan in this style and the page's theme, from the plan render. */
function StillButton({ store, style }: { store: EditorStore; style: PlanStyle }) {
  const theme = useDocumentTheme();
  const level = useEditor(store, (s) => s.level);
  const name = useEditor(store, (s) => s.model?.document.project.name ?? 'plan');
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      className="fs-plan-style__still"
      size="sm"
      variant="primary"
      icon={<Download />}
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void stillOf(store.projectId, { style, theme, level })
          .then((blob) => {
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${name.replace(/[^\w.-]+/g, '-')}-${style}-plan.png`;
            a.click();
            setTimeout(() => { URL.revokeObjectURL(url); }, 1000);
          })
          .catch((e: unknown) => { toast.show({ message: `The still could not be made: ${e instanceof Error ? e.message : String(e)}` }); })
          .finally(() => { setBusy(false); });
      }}
    >
      {busy ? 'Rendering…' : 'Download a still (PNG)'}
    </Button>
  );
}

/** The plan render as a PNG blob: one level, in a style and theme. */
export async function stillOf(projectId: string, o: { style: PlanStyle; theme: 'light' | 'dark'; level: string | null }): Promise<Blob> {
  const q = new URLSearchParams({ view: 'plan', style: o.style, theme: o.theme, width: '2400' });
  if (o.level !== null) q.set('level', o.level);
  const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/render?${q.toString()}`, { credentials: 'same-origin', headers: { accept: 'image/png' } });
  if (!res.ok) throw new Error(`${String(res.status)} ${res.statusText}`);
  return res.blob();
}

/** The canvas's custom properties for a look: what planStyle.css draws from. */
export const lookStyle = (look: PlanLook | null): CSSProperties | undefined => (look === null ? undefined : (look.vars));
