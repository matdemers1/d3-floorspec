import { useEffect, useId, useRef, useState } from 'react';
import { Button, Input, SegmentedControl, Select, Switch } from '@d3cloud/ui';
import { ImagePlus, Move, Replace, Ruler, Trash } from 'lucide-react';
import { useEditor, type EditorStore } from '../store';
import type { LayerState } from '../modes';
import { labelOf } from '../model';
import { prettyLen } from '../units';
import { messageOf } from '../../lib/api';
import { placeUnderlay, readPicked, UNDERLAY_ACCEPT, UnderlayError, applyRotation, type Picked } from './actions';
import { neighbourLevel, underlayOf, useUnderlay, type ReferenceSide } from './state';
import { planWidth } from './transform';

/**
 * Trace and reference in the Layers drawer (FLR-T-18.12), under the layers' On · Ghost · Off: the
 * level's **Underlay** — imported from a PNG, JPEG or WebP, or a PDF's page — On, Ghost or Off; and
 * the **Reference**, the level below or above drawn in a ghost colour. With an underlay, its
 * controls: set its scale from two clicks and a typed length, move it by a point, turn it, its
 * opacity, lock it; replace or remove it.
 */

const UNDERLAY_STATES: { value: LayerState; label: string }[] = [
  { value: 'on', label: 'On' },
  { value: 'ghost', label: 'Ghost' },
  { value: 'off', label: 'Off' },
];

/** A picked PDF of more than one page, waiting for its page to be chosen. */
interface Pending {
  picked: Extract<Picked, { kind: 'pdf' }>;
  page: number;
}

export function TraceLayers({ store }: { store: EditorStore }) {
  const level = useEditor(store, (s) => s.level);
  const model = useEditor(store, (s) => s.model);
  const readOnly = useEditor(store, (s) => s.readOnly);
  const units = useEditor(store, () => store.units);
  const underlay = useUnderlay(store, (s) => (level === null ? undefined : s.levels[level]));
  const reference = useUnderlay(store, (s) => s.reference);
  const working = useUnderlay(store, (s) => s.interaction?.kind ?? null);
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const id = useId();
  // A pending PDF is closed when it is no longer wanted (imported, cancelled, or another file picked).
  const pendingPdf = pending?.picked.pdf;
  useEffect(() => () => { void pendingPdf?.close(); }, [pendingPdf]);
  if (model === null || level === null) return null;
  const u = underlayOf(store);
  const below = neighbourLevel(store, level, 'below');
  const above = neighbourLevel(store, level, 'above');
  const shown: ReferenceSide = reference === 'below' && below !== null ? 'below' : reference === 'above' && above !== null ? 'above' : 'off';
  const levelName = labelOf(model, level);

  const place = async (picked: Picked, page = 1) => {
    setBusy(true);
    setError(null);
    try {
      await placeUnderlay(store, level, picked, page);
    } catch (e) {
      setError(e instanceof UnderlayError ? e.message : messageOf(e));
    } finally {
      setBusy(false);
    }
  };
  const pick = async (f: File | undefined) => {
    if (f === undefined) return;
    setError(null);
    setPending(null);
    let picked: Picked;
    setBusy(true);
    try {
      picked = await readPicked(f);
    } catch (e) {
      setBusy(false);
      setError(e instanceof UnderlayError ? e.message : messageOf(e));
      return;
    }
    setBusy(false);
    if (picked.kind === 'pdf' && picked.pdf.pages > 1) {
      setPending({ picked, page: 1 });
      return;
    }
    await place(picked);
    if (picked.kind === 'pdf') void picked.pdf.close();
  };

  const locked = underlay?.locked === true;
  const hidden = underlay?.state === 'off';
  return (
    <section className="fs-trace" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`} className="fs-trace__title fs-overline">
        Trace and reference
      </h3>
      <ul className="fs-layers__rows" aria-label="Trace and reference layers">
        <li className="fs-layers__row" data-state={underlay?.state ?? 'off'}>
          <span className="fs-layers__name">Underlay</span>
          {underlay === undefined ? (
            <span className="fs-layers__empty">None on {levelName}</span>
          ) : (
            <SegmentedControl aria-label="Underlay layer" size="sm" value={underlay.state} items={UNDERLAY_STATES} onValueChange={(v) => { u.update(level, { state: v as LayerState }); }} />
          )}
        </li>
        <li className="fs-layers__row" data-state={shown === 'off' ? 'off' : 'on'}>
          <span className="fs-layers__name">Reference</span>
          <SegmentedControl
            aria-label="Reference level"
            size="sm"
            value={shown}
            items={[
              { value: 'below', label: 'Below', disabled: below === null },
              { value: 'above', label: 'Above', disabled: above === null },
              { value: 'off', label: 'Off' },
            ]}
            onValueChange={(v) => { u.setReference(v as ReferenceSide); }}
          />
        </li>
      </ul>
      {shown !== 'off' ? (
        <p className="fs-trace__note">
          <span className="fs-trace__swatch" aria-hidden="true" />
          {labelOf(model, (shown === 'below' ? below : above)?.id ?? level)} drawn for reference: snapped to, never edited.
        </p>
      ) : null}

      <input
        ref={file}
        type="file"
        accept={UNDERLAY_ACCEPT}
        className="fs-visually-hidden"
        tabIndex={-1}
        aria-label={underlay === undefined ? 'Import an underlay' : 'Replace the underlay'}
        data-testid="underlay-file"
        onChange={(e) => {
          const f = e.currentTarget.files?.[0];
          e.currentTarget.value = '';
          void pick(f);
        }}
      />

      {pending !== null ? (
        <div className="fs-trace__pages" role="group" aria-label="Choose the PDF’s page">
          <p className="fs-trace__meta">
            {pending.picked.file.name} has {String(pending.picked.pdf.pages)} pages.
          </p>
          <div className="fs-trace__actions">
            <Select
              size="sm"
              aria-label="Page"
              className="fs-trace__page"
              options={Array.from({ length: pending.picked.pdf.pages }, (_, i) => ({ value: String(i + 1), label: `Page ${String(i + 1)}` }))}
              value={String(pending.page)}
              onValueChange={(v) => { setPending({ ...pending, page: Number(v) }); }}
            />
            <Button
              size="sm"
              variant="secondary"
              loading={busy}
              onClick={() => {
                const { picked, page } = pending;
                void place(picked, page).then(() => { setPending(null); });
              }}
            >
              Import page {String(pending.page)}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => { setPending(null); }}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      {underlay === undefined ? (
        pending === null ? (
          <div className="fs-trace__import">
            <Button size="sm" variant="secondary" icon={<ImagePlus />} loading={busy} disabled={readOnly !== null} onClick={() => file.current?.click()}>
              Import a plan to trace…
            </Button>
            <p className="fs-note">A PNG, JPEG or WebP image, or one page of a PDF — a listing’s plan or a sketch — under {levelName}.</p>
          </div>
        ) : null
      ) : (
        <div className="fs-trace__controls">
          <p className="fs-trace__meta" title={underlay.name ?? undefined}>
            <span className="fs-trace__file">{underlay.name ?? 'Underlay'}</span>
            <span data-testid="underlay-size">
              {String(underlay.width)} × {String(underlay.height)} px · {prettyLen(Math.round(planWidth(underlay, underlay.width)), units)} wide
            </span>
          </p>
          <div className="fs-trace__actions">
            <Button size="sm" variant="secondary" icon={<Ruler />} pressed={working === 'calibrate'} disabled={locked || hidden} onClick={() => { u.begin(working === 'calibrate' ? null : 'calibrate'); }}>
              Set scale
            </Button>
            <Button size="sm" variant="secondary" icon={<Move />} pressed={working === 'move'} disabled={locked || hidden} onClick={() => { u.begin(working === 'move' ? null : 'move'); }}>
              Move
            </Button>
          </div>
          <RotationField
            key={`${level}:${String(underlay.rotation)}`}
            rotation={underlay.rotation}
            disabled={locked}
            onCommit={(deg) => { applyRotation(store, level, deg); }}
          />
          <div className="fs-trace__slider-row">
            <label htmlFor={`${id}-opacity`} className="fs-row__label">
              Opacity
            </label>
            <span className="fs-trace__value" aria-hidden="true">
              {String(Math.round(underlay.opacity * 100))} %
            </span>
          </div>
          <input
            id={`${id}-opacity`}
            className="fs-sun__slider fs-trace__slider"
            type="range"
            min={5}
            max={100}
            step={5}
            value={Math.round(underlay.opacity * 100)}
            aria-valuetext={`${String(Math.round(underlay.opacity * 100))} percent`}
            onChange={(e) => { u.update(level, { opacity: Math.min(1, Math.max(0.05, Number(e.target.value) / 100)) }); }}
          />
          <Switch checked={locked} onCheckedChange={(on) => { u.update(level, { locked: on }); if (on) u.begin(null); }}>
            Lock the underlay
          </Switch>
          <div className="fs-trace__actions">
            <Button size="sm" variant="ghost" icon={<Replace />} loading={busy} disabled={readOnly !== null} onClick={() => file.current?.click()}>
              Replace…
            </Button>
            <Button size="sm" variant="ghost" icon={<Trash />} onClick={() => { u.remove(level); }}>
              Remove
            </Button>
          </div>
        </div>
      )}
      {error !== null ? (
        <p className="fs-trace__error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

/** The underlay's turn, typed in degrees: Enter or leaving the field applies it, Esc puts it back. */
function RotationField({ rotation, disabled, onCommit }: { rotation: number; disabled: boolean; onCommit: (deg: number) => void }) {
  const id = useId();
  const [text, setText] = useState(String(rotation));
  const commit = () => {
    const deg = Number(text.replace('°', '').trim());
    if (text.trim() === '' || !Number.isFinite(deg)) setText(String(rotation));
    else if (deg !== rotation) onCommit(deg);
  };
  return (
    <div className="fs-trace__field">
      <label htmlFor={`${id}-rot`} className="fs-row__label">
        Rotation
      </label>
      <Input
        id={`${id}-rot`}
        size="sm"
        inputMode="decimal"
        className="fs-trace__number"
        value={text}
        disabled={disabled}
        trailing="°"
        onChange={(e) => { setText(e.target.value); }}
        onBlur={commit}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            setText(String(rotation));
          }
        }}
      />
    </div>
  );
}
