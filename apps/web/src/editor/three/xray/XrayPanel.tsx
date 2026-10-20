import { useId, useRef, type CSSProperties } from 'react';
import { Button, IconButton, Switch, Tooltip } from '@d3cloud/ui';
import { Crop, ScanEye, X } from 'lucide-react';
import type { XrayPlan, XraySystem } from '@floorspec/mesh';
import { threeOf, useThreeState } from '../mode';
import type { ExperienceContext } from '../section/Experiences';
import type { Box } from '../section/section';
import { colourVar, countOf, XRAY_LOOKS, XRAY_SYSTEMS, type XrayPattern } from './xray';
import './xray.css';

/**
 * X-ray's button on the Experiences cluster (⌥X) and its panel (FLR-T-14.5): the board's frame
 * "14.5 · X-ray — inside the kitchen wall" — Fade finishes, the systems each with its swatch (the
 * board's P14/System row: its colour and its pattern), what it counts and its switch, where it all
 * comes from, and "Section box here" to cut into a corner (FLR-T-14.6's box).
 */

/** How far past the selection "Section box here" cuts, metres. */
const REACH = 1;

export function XrayButton({ ctx }: { ctx: ExperienceContext }) {
  const three = threeOf(ctx.store);
  const on = useThreeState(ctx.store, (s) => s.xray.on);
  // Not with the exploded view up: X-ray draws the house where it stands.
  const exploded = useThreeState(ctx.store, (s) => s.explode.open);
  return (
    <Tooltip content={on ? 'Close X-ray (⌥X)' : 'X-ray: see inside the walls — framing, insulation, plumbing, wiring and ducts (⌥X)'}>
      <IconButton label="X-ray" icon={<ScanEye />} size="sm" pressed={on} disabled={exploded} aria-keyshortcuts="Alt+X" onClick={() => { three.toggleXray(); }} />
    </Tooltip>
  );
}

/** A system's swatch: its colour drawn in its pattern — colour is never the only cue. */
export function Swatch({ system, className }: { system: XraySystem; className?: string }) {
  const pattern: XrayPattern = XRAY_LOOKS[system].pattern;
  const style = { '--fs-xray-colour': `var(${colourVar(system)})` } as CSSProperties;
  return (
    <svg className={`fs-xray__swatch${className === undefined ? '' : ` ${className}`}`} viewBox="0 0 20 8" width="20" height="8" aria-hidden="true" style={style} data-pattern={pattern}>
      {pattern === 'bar' ? <rect x="1" y="1.5" width="18" height="5" rx="1" /> : null}
      {pattern === 'zigzag' ? <polyline points="1,6.5 4,1.5 7,6.5 10,1.5 13,6.5 16,1.5 19,6.5" /> : null}
      {pattern === 'line' ? <line x1="1" y1="4" x2="19" y2="4" /> : null}
      {pattern === 'dash' ? <line x1="1" y1="4" x2="19" y2="4" strokeDasharray="4 2.5" /> : null}
      {pattern === 'dots' ? (
        <>
          <line x1="1" y1="4" x2="19" y2="4" />
          <rect x="4" y="2" width="4" height="4" />
          <rect x="13" y="2" width="4" height="4" />
        </>
      ) : null}
      {pattern === 'double' ? (
        <>
          <line x1="1" y1="1.5" x2="19" y2="1.5" />
          <line x1="1" y1="6.5" x2="19" y2="6.5" />
        </>
      ) : null}
    </svg>
  );
}

function SystemRow({ ctx, system, plan }: { ctx: ExperienceContext; system: XraySystem; plan: XrayPlan | null }) {
  const three = threeOf(ctx.store);
  const on = useThreeState(ctx.store, (s) => s.xray.systems[system]);
  const ids = { name: useId(), count: useId() };
  return (
    <div className="fs-xray__row" data-system={system}>
      <Swatch system={system} />
      <span className="fs-xray__name" id={ids.name}>
        {XRAY_LOOKS[system].label}
      </span>
      <span className="fs-xray__count" id={ids.count}>
        {plan === null ? '—' : countOf(plan, system)}
      </span>
      <Switch
        aria-labelledby={ids.name}
        aria-describedby={ids.count}
        checked={on}
        onCheckedChange={(v) => { three.setXray({ systems: { ...three.get().xray.systems, [system]: v } }); }}
      />
    </div>
  );
}

export function XrayPanel({ ctx, plan }: { ctx: ExperienceContext; plan: XrayPlan | null }) {
  const three = threeOf(ctx.store);
  const on = useThreeState(ctx.store, (s) => s.xray.on);
  const fade = useThreeState(ctx.store, (s) => s.xray.fade);
  const ids = { title: useId(), fade: useId() };
  const self = useRef<HTMLElement>(null);
  if (!on) return null;
  const close = () => {
    three.toggleXray(false);
    document.querySelector<HTMLElement>('.fs-three__gl')?.focus();
  };
  const percent = Math.round(fade * 100);
  // FLR-T-14.6's box, around the selection and a metre more each way — the corner of the room it is
  // in — at its level, with what is outside it hidden: the frame's cut-away corner.
  const cut = () => {
    const fit = ctx.fit();
    const box = fit === null ? (ctx.defaults()?.box ?? null) : { min: [fit.min[0] - REACH, fit.min[1] - REACH, fit.min[2]], max: [fit.max[0] + REACH, fit.max[1] + REACH, fit.max[2]] } satisfies Box;
    if (box === null) return;
    three.setSection({ mode: 'box', box, outside: 'hidden' });
    // Framed beside this panel, not under it.
    const view = document.querySelector('.fs-three__gl')?.getBoundingClientRect();
    const panel = self.current?.getBoundingClientRect();
    ctx.frame(box, view === undefined || panel === undefined ? 0 : panel.right - view.left + 16);
  };
  return (
    <section
      ref={self}
      className="fs-sun fs-section fs-xray"
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
        <ScanEye aria-hidden="true" />
        <h2 className="fs-sun__title" id={ids.title}>
          X-ray
        </h2>
        <IconButton label="Close X-ray" icon={<X />} size="sm" onClick={close} />
      </header>
      <div className="fs-section__body">
        <div className="fs-section__row">
          <label className="fs-section__label" htmlFor={ids.fade}>
            Fade finishes
          </label>
          <span className="fs-spacer" />
          <span className="fs-section__value">{percent} %</span>
        </div>
        <input
          id={ids.fade}
          className="fs-sun__slider fs-section__slider"
          type="range"
          min={0}
          max={100}
          step={5}
          value={percent}
          aria-valuetext={`${String(percent)} % faded`}
          onChange={(e) => { three.setXray({ fade: Number(e.currentTarget.value) / 100 }); }}
        />
        <span className="fs-overline">Systems</span>
        <div className="fs-xray__rows" role="group" aria-label="Systems">
          {XRAY_SYSTEMS.map((s) => (
            <SystemRow key={s} ctx={ctx} system={s} plan={plan} />
          ))}
        </div>
        <p className="fs-xray__note">
          Drawn from the model, not shop drawings: studs at each wall’s framing (16″ on centre where none is recorded); runs routed from FS_plumbing, FS_electrical and FS_mechanical’s connections.
        </p>
      </div>
      <div className="fs-section__foot">
        <Button size="sm" variant="secondary" icon={<Crop />} onClick={cut}>
          Section box here
        </Button>
        <span className="fs-section__caption">X opens the box to cut into a corner</span>
      </div>
    </section>
  );
}
