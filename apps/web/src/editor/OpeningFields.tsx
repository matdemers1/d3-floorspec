import { useEffect, useId, useRef, useState } from 'react';
import { Alert, Button, Input } from '@d3cloud/ui';
import { useEditor, type EditorStore } from './store';
import type { EditorModel } from './model';
import { LengthField, Row } from './fields';
import type { UnitSystem } from './units';
import { CURRENT_CORE, clearAreaText, formatClearArea, parseClearArea, upgradePauses, upgradeTo03, type ClearOpening } from './openings';

/**
 * The inspector's fields for Floorspec Core 0.3's door and window data: the offer to upgrade a 0.2
 * (or 0.1) plan, and a clear opening's width, height and — for a window — area, typed as declared.
 */

/**
 * The offer to upgrade a plan to Floorspec 0.3: one op, `setProperty $document /floorspec "0.3"`,
 * which changes nothing else and which Undo takes back. A plan that uses an official extension is
 * told what the upgrade pauses: the extensions at 0.1.0 check Floorspec 0.2 plans only.
 */
export function CoreUpgradeNotice({ store, model, what }: { store: EditorStore; model: EditorModel; what: string }) {
  const readOnly = useEditor(store, (s) => s.readOnly);
  const pending = useEditor(store, (s) => s.pending);
  const paused = upgradePauses(model.document);
  return (
    <Alert tone="info" title={`This plan is Floorspec ${model.document.floorspec}`}>
      <p>
        {what} are part of Floorspec {CURRENT_CORE}. Upgrading changes nothing else in the plan, and Undo takes it back.
        {paused.length > 0 ? ` This plan uses ${paused.join(', ')}, which at 0.1.0 checks only Floorspec 0.2 plans: after upgrading, its devices are still placed and drawn, but their circuits, loads and checks wait until it takes 0.3.` : ''}
      </p>
      <Button size="sm" variant="primary" loading={pending !== null} disabled={readOnly !== null} onClick={() => void store.apply(`Upgrade to Floorspec ${CURRENT_CORE}`, upgradeTo03())}>
        Upgrade to Floorspec {CURRENT_CORE}
      </Button>
    </Alert>
  );
}

/**
 * A clear opening's fields. Width and height are both required (Core 8.4), so a clear opening that
 * does not exist yet is drafted here until both are typed; then it is sent whole. Area is offered
 * for a window only, may be left empty — "not declared", never width × height — and clears with
 * an empty field.
 */
export function ClearOpeningFields({
  value,
  isWindow,
  units,
  disabled,
  onSet,
  labelPrefix = 'Clear',
}: {
  value: ClearOpening | undefined;
  isWindow: boolean;
  units: UnitSystem;
  disabled: boolean;
  onSet: (next: ClearOpening | undefined, label: string) => void;
  labelPrefix?: string;
}) {
  const [draft, setDraft] = useState<{ width?: number; height?: number }>({});
  useEffect(() => {
    if (value !== undefined) setDraft({});
  }, [value]);
  const width = value?.width ?? draft.width;
  const height = value?.height ?? draft.height;
  const commit = (key: 'width' | 'height', v: number | null) => {
    if (v === null) {
      if (value !== undefined) onSet(undefined, 'Remove the clear opening');
      else setDraft((d) => ({ ...d, [key]: undefined }));
      return;
    }
    if (value !== undefined) {
      onSet({ ...value, [key]: v }, `Set the clear ${key}`);
      return;
    }
    const next = { ...draft, [key]: v };
    if (next.width !== undefined && next.height !== undefined) onSet({ width: next.width, height: next.height }, 'Declare the clear opening');
    else setDraft(next);
  };
  const incomplete = value === undefined && (draft.width !== undefined) !== (draft.height !== undefined);
  return (
    <>
      <LengthField
        label={`${labelPrefix} width`}
        value={width}
        units={units}
        allowEmpty
        positive
        disabled={disabled}
        placeholder="Not declared"
        {...(incomplete && draft.width !== undefined ? { hint: 'Type the clear height too: a clear opening has both' } : {})}
        onCommit={(v) => { commit('width', v); }}
      />
      <LengthField
        label={`${labelPrefix} height`}
        value={height}
        units={units}
        allowEmpty
        positive
        disabled={disabled}
        placeholder="Not declared"
        {...(incomplete && draft.height !== undefined ? { hint: 'Type the clear width too: a clear opening has both' } : {})}
        onCommit={(v) => { commit('height', v); }}
      />
      {isWindow ? (
        <ClearAreaField
          label={`${labelPrefix} area`}
          value={value?.area}
          units={units}
          disabled={disabled || value === undefined}
          onCommit={(v) => {
            if (value === undefined) return;
            const rest = { width: value.width, height: value.height };
            onSet(v === undefined ? rest : { ...rest, area: v }, v === undefined ? 'Clear the clear area' : 'Set the clear area');
          }}
        />
      ) : null}
    </>
  );
}

/** A declared clear area: typed in the Ops area grammar or as a bare number in ft² or m²; empty clears it. */
function ClearAreaField({ label, value, units, onCommit, disabled }: { label: string; value: number | undefined; units: UnitSystem; onCommit: (v: number | undefined) => void; disabled: boolean }) {
  const id = useId();
  const shown = value === undefined ? '' : formatClearArea(value, units);
  const [text, setText] = useState(shown);
  const [error, setError] = useState<string | null>(null);
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) {
      setText(shown);
      setError(null);
    }
  }, [shown]);
  const commit = () => {
    editing.current = false;
    if (text.trim() === shown) return;
    if (text.trim() === '') {
      setError(null);
      if (value !== undefined) onCommit(undefined);
      return;
    }
    const parsed = parseClearArea(text, units);
    if (!parsed.ok) {
      setError(parsed.reason);
      return;
    }
    setError(null);
    setText(formatClearArea(parsed.value, units));
    if (parsed.value !== value) onCommit(parsed.value);
  };
  return (
    <Row label={label} htmlFor={id}>
      <Input
        id={id}
        appearance="filled"
        className="fs-mono-input"
        value={text}
        placeholder="Not declared"
        disabled={disabled}
        invalid={error !== null}
        aria-describedby={`${id}-help`}
        autoComplete="off"
        spellCheck={false}
        onFocus={() => {
          editing.current = true;
          if (value !== undefined) setText(clearAreaText(value, units));
        }}
        onChange={(e) => {
          editing.current = true;
          setText(e.target.value);
          if (error !== null) setError(null);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') {
            editing.current = false;
            setText(shown);
            setError(null);
            (e.target as HTMLInputElement).blur();
          }
          e.stopPropagation();
        }}
      />
      {error !== null ? (
        <p id={`${id}-help`} className="fs-field-error" role="alert">
          {error}
        </p>
      ) : (
        <p id={`${id}-help`} className="fs-field-hint">
          As the maker declares it; never width × height
        </p>
      )}
    </Row>
  );
}
