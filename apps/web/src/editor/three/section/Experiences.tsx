import { useEffect, useId, type ComponentType, type KeyboardEvent, type ReactNode } from 'react';
import { Button, IconButton, Menu, MenuContent, MenuItem, MenuTrigger, Switch, Tooltip, useToast } from '@d3cloud/ui';
import { Camera, Columns2, Crop, Crosshair, Move, Pause, Play, Ruler, UnfoldVertical, X } from 'lucide-react';
import type { EditorStore } from '../../store';
import { prettyLen, type UnitSystem } from '../../units';
import { sunOf, useSunState } from '../sun/study';
import { threeOf, useThreeState } from '../mode';
import { planeFrom, sizeOf, SPREAD_MAX, SPREAD_MIN, type Box, type Face, type SectionMode } from './section';
import { download, stillName, stillPng, stillSvg, styleOf, type StillFormat } from './still';
import type { SectionRig } from './rig';
import type { Drawing } from './SectionOverlay';
import { toggleCompare, useCompareChoices } from '../compare/CompareOverlay';
import { XrayButton } from '../xray/XrayPanel';
import './section.css';

/**
 * The 3D view's second toolbar cluster (FLR-P-14, the read-me "14.9 · Experiences — one system"): the
 * experiences beside the view — Section box (X), X-ray (⌥X, FLR-T-14.5), Compare (⌥C, FLR-T-14.4),
 * Edit in 3D (E) and the tape measure (⇧M); Daylight (⌥D) slots into `EXPERIENCES` as FLR-T-14.7
 * lands. Section opens a floating panel anchored to it, as Camera and Sun do on the first cluster;
 * Compare its bar under the view and its Comparing panel in the right column.
 *
 * FLR-T-14.6's two panels: Section (the box, the plane, its caps and its outside, the board's frame
 * "14.6 · Section box") and Exploded view (the frame "14.6 · Exploded axonometric", on the Section
 * tool: its panel's "Exploded view", and the cluster's first button while it shows).
 */

const UNITS = 1_280_000;
const len = (metres: number, units: UnitSystem): string => prettyLen(Math.round(metres * UNITS), units);

/** What the experiences need of the view: its rig, its units, where the house is and what the selection spans. */
export interface ExperienceContext {
  store: EditorStore;
  rig: SectionRig;
  units: UnitSystem;
  project: string;
  /** Where a new box starts (around the selection, or the current level), where Reset puts it (the level), and where a new plane starts. */
  defaults: () => { box: Box; reset: Box; plane: { face: Face; at: number } } | null;
  /** The box around the selection, or null with nothing selected in 3D. */
  fit: () => Box | null;
  /** Turn the camera to frame a box, as it is facing now — in what is left of the view right of `beside` CSS pixels (a panel over its left). */
  frame: (box: Box, beside?: number) => void;
  /** The house's bounds, metres. */
  house: Box;
  /** The level whose floor a height stands on. */
  levelName: (z: number) => string | null;
  /** The exploded view's drawing (labels, plumb lines) as it is now, for its still. */
  drawing: { current: Drawing | null };
}

/** An experience on the cluster: its button. Its panel is drawn by the view beside the others. */
interface Experience {
  id: string;
  Button: ComponentType<{ ctx: ExperienceContext }>;
}

const EXPERIENCES: readonly Experience[] = [
  { id: 'section', Button: SectionButton },
  { id: 'xray', Button: XrayButton },
  // FLR-T-14.7 Daylight comes here.
  { id: 'compare', Button: CompareButton },
  { id: 'edit', Button: EditButton },
  { id: 'tape', Button: TapeButton },
];

export function ExperiencesToolbar({ ctx }: { ctx: ExperienceContext }) {
  return (
    <div className="fs-three__tools fs-three__tools--experiences" role="toolbar" aria-label="Experiences">
      {EXPERIENCES.map(({ id, Button: B }) => (
        <B key={id} ctx={ctx} />
      ))}
    </div>
  );
}

/** Close what shares the panels' place over the view: the sun, the lighting, the camera. */
function closeOthers(store: EditorStore): void {
  sunOf(store).set({ open: false, playing: false, lapse: false });
  threeOf(store).set({ lightingOpen: false, cameraOpen: false });
}

/** Open the Section panel; with no section on, the box starts where `defaults` says. */
export function openSection(ctx: ExperienceContext): void {
  const three = threeOf(ctx.store);
  const s = three.get().section;
  closeOthers(ctx.store);
  if (three.get().explode.open) three.toggleExplode(false);
  if (s.mode === 'off') {
    const d = ctx.defaults();
    if (d !== null) three.setSection({ mode: 'box', box: s.box ?? d.box, plane: s.plane ?? d.plane });
  }
  three.set({ sectionOpen: true });
}

/** The X key and the button: the panel open or closed (closing leaves the section as it is). */
export function toggleSection(ctx: ExperienceContext): void {
  const three = threeOf(ctx.store);
  if (three.get().sectionOpen) three.set({ sectionOpen: false });
  else openSection(ctx);
}

function SectionButton({ ctx }: { ctx: ExperienceContext }) {
  const three = threeOf(ctx.store);
  const open = useThreeState(ctx.store, (s) => s.sectionOpen);
  const on = useThreeState(ctx.store, (s) => s.section.mode !== 'off');
  const exploded = useThreeState(ctx.store, (s) => s.explode.open);
  if (exploded) {
    return (
      <Tooltip content="Close the exploded view">
        <IconButton label="Exploded view" icon={<UnfoldVertical />} size="sm" pressed onClick={() => { three.toggleExplode(false); }} />
      </Tooltip>
    );
  }
  return (
    <Tooltip content={open ? 'Close the section (X)' : 'Section box: cut the house anywhere (X)'}>
      <IconButton label="Section box" icon={<Crop />} size="sm" pressed={open || on} onClick={() => { toggleSection(ctx); }} />
    </Tooltip>
  );
}

/** FLR-T-14.4: Compare (⌥C) — A and B from one camera, with a swipe divider or side by side. */
function CompareButton({ ctx }: { ctx: ExperienceContext }) {
  const open = useThreeState(ctx.store, (s) => s.compare.open);
  const exploded = useThreeState(ctx.store, (s) => s.explode.open);
  const choices = useCompareChoices(ctx.store);
  return (
    <Tooltip content={open ? 'Close Compare (⌥C)' : 'Compare: this design beside a changeset, an option or a version, from one camera (⌥C)'}>
      <IconButton label="Compare" icon={<Columns2 />} size="sm" pressed={open} disabled={exploded} aria-keyshortcuts="Alt+C" onClick={() => { toggleCompare(ctx.store, choices); }} />
    </Tooltip>
  );
}

/** FLR-T-14.8: Edit in 3D (E) — drag items on their host and openings along their walls. */
function EditButton({ ctx }: { ctx: ExperienceContext }) {
  const three = threeOf(ctx.store);
  const on = useThreeState(ctx.store, (s) => s.edit === 'move');
  // Not while exploded, nor while comparing: what is dragged would be one side's.
  const exploded = useThreeState(ctx.store, (s) => s.explode.open || s.compare.open);
  return (
    <Tooltip content={on ? 'Stop editing in 3D (E)' : 'Edit in 3D: drag furniture, fixtures and openings (E)'}>
      <IconButton label="Edit in 3D" icon={<Move />} size="sm" pressed={on} disabled={exploded} aria-keyshortcuts="E" onClick={() => { three.setEdit(on ? null : 'move'); }} />
    </Tooltip>
  );
}

/** FLR-T-14.8: the tape measure (⇧M) — click points on the house to measure between them. */
function TapeButton({ ctx }: { ctx: ExperienceContext }) {
  const three = threeOf(ctx.store);
  const on = useThreeState(ctx.store, (s) => s.edit === 'tape');
  const exploded = useThreeState(ctx.store, (s) => s.explode.open || s.compare.open);
  return (
    <Tooltip content={on ? 'Put the tape away (⇧M)' : 'Tape measure: click two points on the house (⇧M)'}>
      <IconButton label="Tape measure" icon={<Ruler />} size="sm" pressed={on} disabled={exploded} aria-keyshortcuts="Shift+M" onClick={() => { three.setEdit(on ? null : 'tape'); }} />
    </Tooltip>
  );
}

/** A row of choices drawn as buttons, the chosen one filled (the frame's Box | Plane | Off). */
function Choices<T extends string>({ label, value, items, onChange }: { label: string; value: T; items: readonly { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="fs-section__choices" role="group" aria-label={label}>
      {items.map((i) => (
        <Button key={i.value} size="sm" variant={i.value === value ? 'primary' : 'secondary'} aria-pressed={i.value === value} onClick={() => { onChange(i.value); }}>
          {i.label}
        </Button>
      ))}
    </div>
  );
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="fs-section__row">
      <span className="fs-section__key">{label}</span>
      <span className="fs-spacer" />
      <span className="fs-section__value">{value}</span>
    </div>
  );
}

/** Export still…: a PNG or an SVG of the view as drawn now (still.ts). */
function ExportStill({ ctx, what, caption }: { ctx: ExperienceContext; what: 'section' | 'exploded'; caption: string }) {
  const toast = useToast();
  const save = async (format: StillFormat) => {
    const picture = ctx.rig.capture?.({ transparent: what === 'exploded' }) ?? null;
    if (picture === null) {
      toast.show({ message: 'The view is not drawn yet: try again in a moment.' });
      return;
    }
    const style = styleOf(document.querySelector('.fs-three') ?? document.documentElement);
    const drawing = what === 'exploded' ? ctx.drawing.current : null;
    const blob = format === 'png' ? await stillPng(picture, drawing, style) : stillSvg(picture, drawing, style);
    download(blob, stillName(ctx.project, what, format));
  };
  return (
    <div className="fs-section__foot">
      <Menu>
        <MenuTrigger>
          <Button size="sm" variant="primary" icon={<Camera />}>
            Export still…
          </Button>
        </MenuTrigger>
        <MenuContent align="start">
          <MenuItem onSelect={() => { void save('png'); }}>PNG image</MenuItem>
          <MenuItem onSelect={() => { void save('svg'); }}>SVG, labels as vectors</MenuItem>
        </MenuContent>
      </Menu>
      <span className="fs-section__caption">{caption}</span>
    </div>
  );
}

const PLANE_FACES: readonly { value: Face; label: string }[] = [
  { value: 'north', label: 'N' },
  { value: 'east', label: 'E' },
  { value: 'south', label: 'S' },
  { value: 'west', label: 'W' },
  { value: 'top', label: 'Above' },
];

export function SectionPanel({ ctx }: { ctx: ExperienceContext }) {
  const three = threeOf(ctx.store);
  const open = useThreeState(ctx.store, (s) => s.sectionOpen);
  const section = useThreeState(ctx.store, (s) => s.section);
  const ids = { title: useId() };
  // The panels share one place over the view: the camera, the lighting or the sun opened, this one goes.
  const other = useThreeState(ctx.store, (s) => s.cameraOpen || s.lightingOpen);
  const sun = useSunState(ctx.store, (s) => s.open);
  useEffect(() => {
    if (other || sun) three.set({ sectionOpen: false });
  }, [other, sun, three]);
  if (!open) return null;
  const close = () => {
    three.set({ sectionOpen: false });
    document.querySelector<HTMLElement>('.fs-three__gl')?.focus();
  };
  const setMode = (mode: SectionMode) => {
    const d = ctx.defaults();
    if (mode === 'box') three.setSection({ mode, box: section.box ?? d?.box ?? null });
    else if (mode === 'plane') three.setSection({ mode, plane: section.plane ?? d?.plane ?? null });
    else three.setSection({ mode });
  };
  const box = section.box;
  const size = box === null ? null : sizeOf(box);
  const height = box === null || size === null ? null : `${len(size[2], ctx.units)}${(() => {
    const l = ctx.levelName(box.min[2]);
    return l === null ? '' : ` (${l})`;
  })()}`;
  const fit = ctx.fit();
  return (
    <section
      className="fs-sun fs-section"
      aria-labelledby={ids.title}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          close();
        }
        e.stopPropagation();
      }}
    >
      <header className="fs-sun__head">
        <Crop aria-hidden="true" />
        <h2 className="fs-sun__title" id={ids.title}>
          Section
        </h2>
        <IconButton label="Close the section" icon={<X />} size="sm" onClick={close} />
      </header>
      <div className="fs-section__body">
        <Choices<SectionMode>
          label="Cut with"
          value={section.mode}
          items={[
            { value: 'box', label: 'Box' },
            { value: 'plane', label: 'Plane' },
            { value: 'off', label: 'Off' },
          ]}
          onChange={setMode}
        />
        <span className="fs-overline">Cut faces</span>
        <Switch checked={section.caps} disabled={section.mode === 'off'} onCheckedChange={(on) => { three.setSection({ caps: on }); }} className="fs-section__switch">
          Cap cut faces
        </Switch>
        <Switch checked={section.hatch && section.caps} disabled={section.mode === 'off' || !section.caps} onCheckedChange={(on) => { three.setSection({ hatch: on }); }} className="fs-section__switch">
          Hatch the caps
        </Switch>
        <span className="fs-overline">{section.mode === 'plane' ? 'Past the plane' : 'Outside the box'}</span>
        <Choices<'ghost' | 'hidden'>
          label={section.mode === 'plane' ? 'Past the plane' : 'Outside the box'}
          value={section.outside}
          items={[
            { value: 'ghost', label: 'Ghosted 15 %' },
            { value: 'hidden', label: 'Hidden' },
          ]}
          onChange={(v) => { three.setSection({ outside: v }); }}
        />
        {section.mode === 'plane' && section.plane !== null ? (
          <>
            <span className="fs-overline">Plane</span>
            <Choices<Face>
              label="Cut away from"
              value={section.plane.face}
              items={PLANE_FACES}
              onChange={(f) => { three.setSection({ plane: planeFrom(ctx.house, f) }); }}
            />
            <Row label="Cutting away" value={section.plane.face === 'top' ? 'everything above' : `the ${section.plane.face} side`} />
          </>
        ) : (
          <>
            <span className="fs-overline">Box</span>
            <Row label="Width" value={size === null ? '—' : len(size[0], ctx.units)} />
            <Row label="Depth" value={size === null ? '—' : len(size[1], ctx.units)} />
            <Row label="Height" value={height ?? '—'} />
            <div className="fs-section__actions">
              <Button
                size="sm"
                variant="secondary"
                icon={<Crosshair />}
                disabled={fit === null || section.mode !== 'box'}
                onClick={() => {
                  if (fit === null) return;
                  three.setSection({ box: fit });
                  ctx.frame(fit);
                }}
              >
                Fit to selection
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={section.mode !== 'box'}
                onClick={() => {
                  const d = ctx.defaults();
                  if (d !== null) three.setSection({ box: d.reset });
                }}
              >
                Reset
              </Button>
            </div>
          </>
        )}
        <span className="fs-overline">Diagram</span>
        <Button size="sm" variant="secondary" icon={<UnfoldVertical />} onClick={() => { three.toggleExplode(true); }}>
          Exploded view
        </Button>
      </div>
      <ExportStill ctx={ctx} what="section" caption="PNG or SVG, as shown" />
    </section>
  );
}

const SPREAD_STEP = 0.1524;

export function ExplodedPanel({ ctx }: { ctx: ExperienceContext }) {
  const three = threeOf(ctx.store);
  const explode = useThreeState(ctx.store, (s) => s.explode);
  const sectionOn = useThreeState(ctx.store, (s) => s.section.mode !== 'off');
  const ids = { title: useId(), spread: useId() };
  if (!explode.open) return null;
  const close = () => {
    three.toggleExplode(false);
    document.querySelector<HTMLElement>('.fs-three__gl')?.focus();
  };
  const animate = () => { three.setExplode({ apart: !three.get().explode.apart }); };
  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === ' ' && !(e.target instanceof HTMLButtonElement || e.target instanceof HTMLInputElement)) {
      e.preventDefault();
      animate();
    }
    e.stopPropagation();
  };
  return (
    <section className="fs-sun fs-section fs-explode" aria-labelledby={ids.title} onKeyDown={onKey}>
      <header className="fs-sun__head">
        <UnfoldVertical aria-hidden="true" />
        <h2 className="fs-sun__title" id={ids.title}>
          Exploded view
        </h2>
        <IconButton label="Close the exploded view" icon={<X />} size="sm" onClick={close} />
      </header>
      <div className="fs-section__body">
        <div className="fs-section__row">
          <label className="fs-section__label" htmlFor={ids.spread}>
            Spread
          </label>
          <span className="fs-spacer" />
          <span className="fs-section__value fs-section__value--muted">{len(explode.spread, ctx.units)} between levels</span>
        </div>
        <input
          id={ids.spread}
          className="fs-sun__slider fs-section__slider"
          type="range"
          min={SPREAD_MIN}
          max={SPREAD_MAX}
          step={SPREAD_STEP}
          value={explode.spread}
          aria-valuetext={`${len(explode.spread, ctx.units)} between levels`}
          onChange={(e) => { three.setExplode({ spread: Number(e.currentTarget.value) }); }}
        />
        <div className="fs-section__row">
          <IconButton label={explode.apart ? 'Animate in: bring the levels together' : 'Animate out: lift the levels apart'} icon={explode.apart ? <Pause /> : <Play />} size="sm" variant="secondary" onClick={animate} />
          <span className="fs-section__key fs-section__key--strong">Animate in / out</span>
          <span className="fs-spacer" />
          <kbd className="fs-section__kbd" aria-hidden="true">
            Space
          </kbd>
        </div>
        <span className="fs-overline">Show</span>
        <Switch checked={explode.labels} onCheckedChange={(on) => { three.setExplode({ labels: on }); }} className="fs-section__switch">
          Leader labels
        </Switch>
        <Switch checked={explode.plumb} onCheckedChange={(on) => { three.setExplode({ plumb: on }); }} className="fs-section__switch">
          Plumb lines
        </Switch>
        <Switch checked={explode.roofs} onCheckedChange={(on) => { three.setExplode({ roofs: on }); }} className="fs-section__switch">
          Roofs
        </Switch>
        <Switch checked={explode.keep && sectionOn} disabled={!sectionOn} onCheckedChange={(on) => { three.setExplode({ keep: on }); }} className="fs-section__switch">
          Only what the section box keeps
        </Switch>
      </div>
      <ExportStill ctx={ctx} what="exploded" caption="PNG/SVG · transparent" />
    </section>
  );
}
