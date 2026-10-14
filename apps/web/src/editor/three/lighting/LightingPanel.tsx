import { useId, useMemo, useRef, useState } from 'react';
import { Badge, Button, IconButton, Input, Menu, MenuContent, MenuItem, MenuTrigger, Switch, Tooltip } from '@d3cloud/ui';
import { Ellipsis, LampCeiling, Lightbulb, LightbulbOff, X } from 'lucide-react';
import { kelvinColor, settingOf, type FixtureLight, type NamedScene } from '@floorspec/mesh';
import { useEditor, type EditorStore } from '../../store';
import { labelOf, type EditorModel } from '../../model';
import { sunOf } from '../sun/study';
import { threeOf, useThreeState } from '../mode';
import {
  cannotSave,
  census,
  controlsOf,
  deleteScene,
  houseLights,
  luminaireOf,
  nameProblem,
  overwriteScene,
  panelScenes,
  renameScene,
  saveNewScene,
  unchanged,
} from './lighting';
import './lighting.css';

/**
 * Lighting design in the 3D view (FLR-T-13.12, the board's "Editor — 3D lighting scenes" frame):
 * the toolbar's Lighting button, the panel it opens over the view — the scenes ("All on", the
 * project's own, "Off") as a radio group, saving the view's lighting as a scene of the document
 * (FS_lighting, FLR-ADR-043), renaming and deleting one, and the selected light's dimmer and colour
 * temperature — and the chip that stands for the panel when it is closed. Which lights are on is
 * the view's (mode.ts): a switch clicked in the view, a lamp, a dimmer; a scene is saved only when a
 * person saves it.
 */

const FIXTURE_NAMES: Readonly<Record<string, string>> = {
  ceiling: 'Ceiling light',
  recessed: 'Recessed light',
  pendant: 'Pendant',
  wall: 'Sconce',
  track: 'Track light',
  underCabinet: 'Under-cabinet light',
  fan: 'Fan light',
  exterior: 'Exterior light',
  floorLamp: 'Floor lamp',
  tableLamp: 'Table lamp',
};

/** `#rrggbb` of a colour temperature, for the colour-temperature track's ends. */
function kelvinHex(k: number): string {
  const c = kelvinColor(k);
  const m = Math.max(c[0], c[1], c[2]);
  const s = (x: number) => Math.round(255 * Math.min(1, (x / m) ** (1 / 2.2)));
  return `#${[s(c[0]), s(c[1]), s(c[2])].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** The scene the view was last set to, among the panel's. */
function chosenOf(scenes: readonly NamedScene[], scene: { id: string | null; name: string }): NamedScene | undefined {
  return scenes.find((s) => (scene.id !== null ? s.id === scene.id : s.id === null && s.name === scene.name));
}

// ─── The toolbar button and the chip ─────────────────────────────────────────────────────────

export function LightingButton({ store }: { store: EditorStore }) {
  const three = threeOf(store);
  const open = useThreeState(store, (s) => s.lightingOpen);
  return (
    <Tooltip content={open ? 'Close the lighting' : 'Lighting: scenes, switches and dimmers'}>
      <IconButton
        label="Lighting"
        icon={<LampCeiling />}
        size="sm"
        pressed={open}
        onClick={() => {
          if (!open) sunOf(store).set({ open: false, playing: false, lapse: false });
          three.set({ lightingOpen: !open, ...(open ? {} : { lights: true, cameraOpen: false }) });
        }}
      />
    </Tooltip>
  );
}

export function LightingChip({ store, model }: { store: EditorStore; model: EditorModel }) {
  const three = threeOf(store);
  const lights = useThreeState(store, (s) => s.lights);
  const open = useThreeState(store, (s) => s.lightingOpen);
  const lighting = useThreeState(store, (s) => s.lighting);
  const scene = useThreeState(store, (s) => s.scene);
  const all = useMemo(() => houseLights(model), [model]);
  const scenes = useMemo(() => panelScenes(model), [model]);
  if (!lights || open || all.length === 0) return null;
  const chosen = chosenOf(scenes, scene);
  const summary = `Lighting · ${chosen?.name ?? scene.name}${unchanged(lighting, chosen, all) ? '' : ' (changed)'}`;
  return (
    <button
      type="button"
      className="fs-three__chip fs-lighting__chip"
      onClick={() => {
        sunOf(store).set({ open: false, playing: false, lapse: false });
        three.set({ lightingOpen: true, cameraOpen: false });
      }}
      aria-label={`${summary}. Open the lighting`}
    >
      <Lightbulb aria-hidden="true" />
      {summary}
    </button>
  );
}

// ─── The panel ───────────────────────────────────────────────────────────────────────────────

export function LightingPanel({ store, model }: { store: EditorStore; model: EditorModel }) {
  const three = threeOf(store);
  const open = useThreeState(store, (s) => s.lightingOpen);
  const lightsOn = useThreeState(store, (s) => s.lights);
  const lighting = useThreeState(store, (s) => s.lighting);
  const scene = useThreeState(store, (s) => s.scene);
  const selection = useEditor(store, (s) => s.selection);
  const readOnly = useEditor(store, (s) => s.readOnly !== null || s.compare !== null);
  const all = useMemo(() => houseLights(model), [model]);
  const ids = useMemo(() => all.map((l) => l.id), [all]);
  const scenes = useMemo(() => panelScenes(model), [model]);
  const [naming, setNaming] = useState<{ mode: 'new' } | { mode: 'rename'; id: string; was: string } | null>(null);
  const [name, setName] = useState('');
  const nameId = useId();
  const statusId = useId();
  const radios = useRef<(HTMLButtonElement | null)[]>([]);
  if (!open) return null;

  const chosen = chosenOf(scenes, scene);
  const changed = lightsOn && !unchanged(lighting, chosen, all);
  const count = census(lightsOn ? lighting : { on: {} }, all);
  const blocked = cannotSave(model);
  const close = () => {
    three.set({ lightingOpen: false });
    document.querySelector<HTMLElement>('.fs-three__gl')?.focus();
  };
  const choose = (s: NamedScene) => { three.chooseScene(s); };
  const pick = (i: number) => {
    const next = scenes[(i + scenes.length) % scenes.length];
    if (next === undefined) return;
    choose(next);
    radios.current[scenes.indexOf(next)]?.focus();
  };
  const problem = naming === null ? null : nameProblem(model, name, naming.mode === 'rename' ? naming.id : null);
  const submit = () => {
    if (naming === null || problem !== null) return;
    const n = name.trim();
    if (naming.mode === 'rename') {
      void store.apply(`Rename the scene “${naming.was}” to “${n}”`, renameScene(naming.id, n)).then((ok) => {
        if (ok && scene.id === naming.id) three.set({ scene: { id: naming.id, name: n } });
      });
    } else {
      const snapshot = lighting;
      let id = '';
      void store
        .apply(`Save the lighting scene “${n}”`, (attempt) => {
          const made = saveNewScene(model, n, snapshot, all, attempt);
          id = made.id;
          return made.batch;
        })
        .then((ok) => {
          if (ok) three.set({ scene: { id, name: n } });
        });
    }
    setNaming(null);
  };

  // The selected light, or a selected switch's lights.
  const selectedLight = selection === null ? undefined : all.find((l) => l.id === selection);
  const switched = selection === null || selectedLight !== undefined ? null : controlsOf(model, selection, all);

  return (
    <section
      className="fs-sun fs-lighting"
      aria-label="Lighting"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && naming === null) {
          e.preventDefault();
          close();
        }
        e.stopPropagation();
      }}
    >
      <header className="fs-sun__head">
        {lightsOn ? <Lightbulb aria-hidden="true" /> : <LightbulbOff aria-hidden="true" />}
        <h2 className="fs-sun__title">Lighting</h2>
        <IconButton label="Close the lighting" icon={<X />} size="sm" onClick={close} />
      </header>

      <p id={statusId} className="fs-sun__status" role="status" aria-live="polite">
        {all.length === 0
          ? 'This house has no lights yet: add FS_electrical lights, or a floor or table lamp.'
          : `${String(count.on)} of ${String(count.total)} light${count.total === 1 ? '' : 's'} on${count.dimmed > 0 ? ` · ${String(count.dimmed)} dimmed` : ''}`}
      </p>

      <span className="fs-overline">Scenes</span>
      <div className="fs-lighting__scenes" role="radiogroup" aria-label="Lighting scene" aria-describedby={statusId}>
        {scenes.map((s, i) => {
          const checked = lightsOn && chosen === s;
          return (
            <div key={s.id ?? `builtin:${s.name}`} className="fs-lighting__scene" data-checked={checked ? 'true' : undefined}>
              <button
                ref={(el) => { radios.current[i] = el; }}
                type="button"
                role="radio"
                aria-checked={checked}
                tabIndex={checked || (!lightsOn && i === 0) ? 0 : -1}
                className="fs-lighting__radio"
                onClick={() => { choose(s); }}
                onKeyDown={(e) => {
                  const by = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0;
                  if (by !== 0) {
                    e.preventDefault();
                    pick(i + by);
                  }
                }}
              >
                <span className="fs-lighting__dot" aria-hidden="true" />
                <span className="fs-lighting__name">{s.name}</span>
                {s.id === null ? <span className="fs-lighting__builtin">Built in</span> : null}
                {checked && changed ? <Badge tone="warning">Changed</Badge> : null}
              </button>
              {s.id !== null && !readOnly ? (() => { const sid = s.id; return (
                <Menu>
                  <MenuTrigger>
                    <IconButton variant="ghost" size="sm" icon={<Ellipsis />} label={`More for ${s.name}`} />
                  </MenuTrigger>
                  <MenuContent align="end">
                    <MenuItem
                      onSelect={() => {
                        setNaming({ mode: 'rename', id: sid, was: s.name });
                        setName(s.name);
                      }}
                    >
                      Rename…
                    </MenuItem>
                    <MenuItem
                      tone="danger"
                      onSelect={() => {
                        void store.apply(`Delete the scene “${s.name}”`, deleteScene(sid));
                      }}
                    >
                      Delete
                    </MenuItem>
                  </MenuContent>
                </Menu>
              ); })() : null}
            </div>
          );
        })}
      </div>

      {!readOnly && all.length > 0 ? (
        naming === null ? (
          <div className="fs-lighting__save">
            {changed && chosen !== undefined && chosen.id !== null ? (
              <Button size="sm" variant="secondary" disabled={blocked !== null} onClick={() => { if (chosen.id !== null) void store.apply(`Save the lighting scene “${chosen.name}”`, overwriteScene(chosen.id, lighting, all)); }}>
                Save “{chosen.name}”
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              disabled={blocked !== null || !lightsOn}
              onClick={() => {
                setNaming({ mode: 'new' });
                setName('');
              }}
            >
              {changed && chosen?.id !== null ? 'Save as new…' : 'Save as scene…'}
            </Button>
          </div>
        ) : (
          <form
            className="fs-lighting__naming"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                setNaming(null);
              }
            }}
          >
            <label htmlFor={nameId} className="fs-row__label">
              {naming.mode === 'new' ? 'New scene' : `Rename “${naming.was}”`}
            </label>
            <Input id={nameId} appearance="filled" value={name} autoFocus maxLength={200} placeholder="Evening" onChange={(e) => { setName(e.target.value); }} aria-invalid={problem !== null && name !== '' ? true : undefined} />
            {problem !== null && name !== '' ? <p className="fs-lighting__problem">{problem}</p> : null}
            <div className="fs-lighting__save">
              <Button size="sm" variant="primary" type="submit" disabled={problem !== null}>
                Save
              </Button>
              <Button size="sm" variant="ghost" onClick={() => { setNaming(null); }}>
                Cancel
              </Button>
            </div>
          </form>
        )
      ) : null}
      {blocked !== null && !readOnly ? <p className="fs-lighting__hint">{blocked}</p> : null}

      <span className="fs-overline">Selected light</span>
      {selectedLight !== undefined ? (
        <LightControls store={store} model={model} light={selectedLight} ids={ids} />
      ) : switched !== null && selection !== null ? (
        <SwitchControls store={store} model={model} id={selection} controls={switched} all={all} ids={ids} />
      ) : (
        <p className="fs-lighting__hint">Select a light or a switch to dim it.</p>
      )}

      <p className="fs-lighting__hint">Click a switch in the view to turn its lights on or off; click a lamp to toggle it.</p>
    </section>
  );
}

/** A light's on switch, dimmer and colour temperature. */
function LightControls({ store, model, light, ids }: { store: EditorStore; model: EditorModel; light: FixtureLight; ids: readonly string[] }) {
  const three = threeOf(store);
  const lightsOn = useThreeState(store, (s) => s.lights);
  const lighting = useThreeState(store, (s) => s.lighting);
  const setting = lightsOn ? settingOf(lighting, light.id) : null;
  const { data, range, tunable } = luminaireOf(model, light);
  const dimId = useId();
  const cctId = useId();
  const output = setting?.output ?? 100;
  const cct = Math.min(range[1], Math.max(range[0], setting?.cct ?? light.ownKelvin));
  const controlledBy = light.switches.map((s) => labelOf(model, s));
  return (
    <div className="fs-lighting__light">
      <div className="fs-lighting__light-head">
        <span className="fs-lighting__light-name">{FIXTURE_NAMES[light.fixture] ?? 'Light'}{light.room === null ? '' : ` · ${labelOf(model, light.room)}`}</span>
        <span className="fs-lighting__light-id">{light.id}</span>
      </div>
      <Switch checked={setting !== null} onCheckedChange={(on) => { three.setLightsOn([light.id], on, ids); }}>
        On
      </Switch>
      <div className="fs-lighting__slider-row">
        <label htmlFor={dimId} className="fs-row__label">
          Dimmer
        </label>
        <span className="fs-lighting__value" aria-hidden="true">{String(output)} %</span>
      </div>
      <input
        id={dimId}
        className="fs-sun__slider fs-lighting__slider"
        type="range"
        min={1}
        max={100}
        step={1}
        value={output}
        disabled={data.dimmable === false}
        aria-valuetext={`${String(output)} percent`}
        onChange={(e) => { three.setLight(light.id, { output: Number(e.target.value) }, ids); }}
      />
      {data.dimmable === false ? <p className="fs-lighting__hint">Not dimmable, as its luminaire record says.</p> : null}
      <div className="fs-lighting__slider-row">
        <label htmlFor={cctId} className="fs-row__label">
          Colour temperature
        </label>
        <span className="fs-lighting__value" aria-hidden="true">{String(cct)} K</span>
      </div>
      <input
        id={cctId}
        className="fs-sun__slider fs-lighting__slider fs-lighting__cct"
        type="range"
        min={range[0]}
        max={range[1]}
        step={50}
        value={cct}
        aria-valuetext={`${String(cct)} kelvin`}
        style={{ ['--fs-cct-from' as string]: kelvinHex(range[0]), ['--fs-cct-to' as string]: kelvinHex(range[1]) }}
        onChange={(e) => { three.setLight(light.id, { cct: Number(e.target.value) }, ids); }}
      />
      <p className="fs-lighting__hint">
        {tunable ? `Tunable ${String(range[0])}–${String(range[1])} K` : data.cct !== undefined ? `Its lamp is ${String(data.cct)} K; another is a view of a different lamp` : `A typical ${String(light.ownKelvin)} K lamp`}
        {' · '}
        {controlledBy.length > 0 ? `Controlled by ${controlledBy.join(' and ')}` : light.fixture === 'floorLamp' || light.fixture === 'tableLamp' ? 'Plugged in: click it to turn it on or off' : 'No switch controls it'}
      </p>
    </div>
  );
}

/** A selected switch's lights, each with its on switch. */
function SwitchControls({ store, model, id, controls, all, ids }: { store: EditorStore; model: EditorModel; id: string; controls: readonly string[]; all: readonly FixtureLight[]; ids: readonly string[] }) {
  const three = threeOf(store);
  const lightsOn = useThreeState(store, (s) => s.lights);
  const lighting = useThreeState(store, (s) => s.lighting);
  const any = lightsOn && controls.some((c) => settingOf(lighting, c) !== null);
  return (
    <div className="fs-lighting__light">
      <div className="fs-lighting__light-head">
        <span className="fs-lighting__light-name">{labelOf(model, id)}</span>
        <span className="fs-lighting__light-id">{id}</span>
      </div>
      <Button size="sm" variant="secondary" onClick={() => { three.flipSwitch(controls, ids); }}>
        Turn its {String(controls.length)} light{controls.length === 1 ? '' : 's'} {any ? 'off' : 'on'}
      </Button>
      <ul className="fs-lighting__list">
        {controls.map((c) => {
          const l = all.find((x) => x.id === c);
          const on = lightsOn && settingOf(lighting, c) !== null;
          return (
            <li key={c}>
              <Switch checked={on} onCheckedChange={(v) => { three.setLightsOn([c], v, ids); }}>
                {l === undefined ? c : `${FIXTURE_NAMES[l.fixture] ?? 'Light'} ${c}`}
              </Switch>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
