import { useEffect, useId, useRef, useState } from 'react';
import { Alert, Button, Input } from '@d3cloud/ui';
import { useEditor, type EditorStore } from './store';
import type { EditorModel } from './model';
import { LengthField, Row } from './fields';
import type { UnitSystem } from './units';
import { CURRENT_CORE, clearAreaText, formatClearArea, parseClearArea, upgradeTo03, type ClearOpening } from './openings';

/**
 * The inspector's fields for Floorspec Core 0.3's door and window data: the offer to upgrade a 0.2
 * (or 0.1) plan, and a clear opening's width, height and — for a window — area, typed as declared.
 */

/**
 * The offer to upgrade a plan to Floorspec 0.3: one op, `setProperty $document /floorspec "0.3"`,
 * which changes nothing else and which Undo takes back.
 */
export function CoreUpgradeNotice({ store, model, what }: { store: EditorStore; model: EditorModel; what: string }) {
  const readOnly = useEditor(store, (s) => s.readOnly);
  const pending = useEditor(store, (s) => s.pending);
  return (
    <Alert tone="info" title={`This plan is Floorspec ${model.document.floorspec}`}>
      <p>
        {what} are part of Floorspec {CURRENT_CORE}. Upgrading changes nothing else in the plan, and Undo takes it back.
      </p>
      <Button size="sm" variant="primary" loading={pending !== null} disabled={readOnly !== null} onClick={() => void store.apply(`Upgrade to Floorspec ${CURRENT_CORE}`, upgradeTo03())}>
        Upgrade to Floorspec {CURRENT_CORE}
      </Button>
    </Alert>
  );
}

/**
 * Clear openings being drafted — one dimension typed, the other not yet — by element. Kept outside
 * the component: the inspector re-renders, and may remount, as the plan's live events arrive, and a
 * half-typed clear opening must not be lost to that.
 */
const drafts = new Map<string, { width?: number; height?: number }>();

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
  draftKey,
}: {
  /** Which element's clear opening this is: a draft survives the inspector being redrawn. */
  draftKey: string;
  value: ClearOpening | undefined;
  isWindow: boolean;
  units: UnitSystem;
  disabled: boolean;
  onSet: (next: ClearOpening | undefined, label: string) => void;
  labelPrefix?: string;
}) {
  const [draft, setDraftState] = useState<{ width?: number; height?: number }>(() => drafts.get(draftKey) ?? {});
  const setDraft = (next: { width?: number; height?: number }) => {
    if (next.width === undefined && next.height === undefined) drafts.delete(draftKey);
    else drafts.set(draftKey, next);
    setDraftState(next);
  };
  useEffect(() => {
    setDraftState(drafts.get(draftKey) ?? {});
  }, [draftKey]);
  useEffect(() => {
    if (value !== undefined && drafts.has(draftKey)) setDraft({});
  }, [value, draftKey]);
  const width = value?.width ?? draft.width;
  const height = value?.height ?? draft.height;
  const commit = (key: 'width' | 'height', v: number | null) => {
    // The draft as it stands now — kept by element, so a closure from an earlier render cannot lose
    // the other dimension.
    const current = drafts.get(draftKey) ?? {};
    if (v === null) {
      if (value !== undefined) onSet(undefined, 'Remove the clear opening');
      else if (current[key] !== undefined) setDraft({ ...current, [key]: undefined });
      return;
    }
    if (value !== undefined) {
      onSet({ ...value, [key]: v }, `Set the clear ${key}`);
      return;
    }
    const next = { ...current, [key]: v };
    if (next.width !== undefined && next.height !== undefined) {
      setDraft({});
      onSet({ width: next.width, height: next.height }, 'Declare the clear opening');
    } else setDraft(next);
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
