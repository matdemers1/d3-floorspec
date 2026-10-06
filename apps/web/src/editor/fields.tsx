import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Input } from '@d3cloud/ui';
import { formatLen, parseLen, type UnitSystem } from './units';

/**
 * Inspector fields. A length field takes anything the Ops reference grammar does — `12'6-1/2"`,
 * `3810mm`, `3.81 m` — parsed by `@floorspec/ops` itself, and commits an exact integer on Enter or
 * when focus leaves (FLR-T-3.4). Nothing is sent until the value parses.
 */

export function Row({ label, htmlFor, children }: { label: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="fs-row">
      <label className="fs-row__label" htmlFor={htmlFor}>
        {label}
      </label>
      <div className="fs-row__control">{children}</div>
    </div>
  );
}

export function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="fs-section" aria-label={title}>
      <div className="fs-section__head">
        <h3 className="fs-overline">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

interface LengthFieldProps {
  label: string;
  value: number | undefined;
  units: UnitSystem;
  onCommit: (value: number | null) => void;
  /** Empty is allowed and means "unset": the default applies. */
  allowEmpty?: boolean;
  placeholder?: string;
  disabled?: boolean;
  /** Accept only values greater than zero. */
  positive?: boolean;
  /** Accept zero but not negative. */
  nonNegative?: boolean;
  hint?: string;
  autoFocus?: boolean;
}

export function LengthField({ label, value, units, onCommit, allowEmpty = false, placeholder, disabled, positive, nonNegative, hint, autoFocus }: LengthFieldProps) {
  const id = useId();
  const shown = value === undefined ? '' : formatLen(value, units);
  const [text, setText] = useState(shown);
  const [error, setError] = useState<string | null>(null);
  const editing = useRef(false);
  /** The text last sent, so Enter followed by blur sends once. */
  const sent = useRef<string | null>(null);
  useEffect(() => {
    sent.current = null;
    if (!editing.current) {
      setText(shown);
      setError(null);
    }
  }, [shown]);

  const commit = () => {
    editing.current = false;
    if (text.trim() === shown || text === sent.current) {
      setError(null);
      return;
    }
    if (text.trim() === '') {
      if (allowEmpty) {
        setError(null);
        sent.current = text;
        onCommit(null);
      } else {
        setText(shown);
      }
      return;
    }
    const parsed = parseLen(text, units);
    if (!parsed.ok) {
      setError(parsed.reason);
      return;
    }
    if (positive === true && parsed.value <= 0) {
      setError('Must be greater than zero');
      return;
    }
    if (nonNegative === true && parsed.value < 0) {
      setError('Cannot be negative');
      return;
    }
    setError(null);
    const formatted = formatLen(parsed.value, units);
    // A field with no value of its own (“Move by”) is an action: it empties once sent.
    setText(value === undefined ? '' : formatted);
    sent.current = value === undefined ? '' : formatted;
    if (parsed.value !== value) onCommit(parsed.value);
  };

  return (
    <Row label={label} htmlFor={id}>
      <Input
        id={id}
        appearance="filled"
        className="fs-mono-input"
        value={text}
        placeholder={placeholder}
        disabled={disabled}
        invalid={error !== null}
        autoFocus={autoFocus}
        aria-describedby={error !== null || hint !== undefined ? `${id}-help` : undefined}
        spellCheck={false}
        autoComplete="off"
        onFocus={() => {
          editing.current = true;
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
      ) : hint !== undefined ? (
        <p id={`${id}-help`} className="fs-field-hint">
          {hint}
        </p>
      ) : null}
    </Row>
  );
}

export function TextField({ label, value, onCommit, disabled, placeholder, autoFocus, maxLength = 200 }: { label: string; value: string; onCommit: (value: string) => void; disabled?: boolean; placeholder?: string; autoFocus?: boolean | undefined; maxLength?: number }) {
  const id = useId();
  const [text, setText] = useState(value);
  const editing = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!editing.current) setText(value);
  }, [value]);
  useEffect(() => {
    if (autoFocus === true) {
      input.current?.focus();
      input.current?.select();
    }
  }, [autoFocus]);
  const commit = () => {
    editing.current = false;
    if (text !== value) onCommit(text.trim());
  };
  return (
    <Row label={label} htmlFor={id}>
      <Input
        ref={input}
        id={id}
        appearance="filled"
        value={text}
        disabled={disabled}
        placeholder={placeholder}
        maxLength={maxLength}
        onFocus={() => {
          editing.current = true;
        }}
        onChange={(e) => {
          editing.current = true;
          setText(e.target.value);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            (e.target as HTMLInputElement).blur();
          } else if (e.key === 'Escape') {
            editing.current = false;
            setText(value);
            (e.target as HTMLInputElement).blur();
          }
          e.stopPropagation();
        }}
      />
    </Row>
  );
}

/**
 * A read-only value in the field's shape: dashed, as the board draws a derived value. `wrap` lets a
 * value longer than the field run onto a second line instead of being cut off.
 */
export function ReadOnlyField({ label, value, wrap = false }: { label: string; value: string; wrap?: boolean }) {
  return (
    <Row label={label}>
      <div className={wrap ? 'fs-readonly fs-readonly--wrap' : 'fs-readonly'}>{value}</div>
    </Row>
  );
}

/**
 * A whole number in a compact input with no row of its own — a table cell, named by `label` —
 * committed on Enter or blur once it parses and is in range; empty commits null.
 */
export function InlineIntInput({ label, value, onCommit, disabled, min, max, placeholder }: { label: string; value: number | undefined; onCommit: (value: number | null) => void; disabled?: boolean; min: number; max: number; placeholder?: string | undefined }) {
  const id = useId();
  const shown = value === undefined ? '' : String(value);
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
    const t = text.trim();
    if (t === shown) return;
    if (t === '') {
      onCommit(null);
      return;
    }
    const n = Number(t);
    if (!/^\d+$/.test(t) || n < min || n > max) {
      setError(`From ${String(min)} to ${String(max)}`);
      return;
    }
    setError(null);
    if (n !== value) onCommit(n);
  };
  return (
    <div className="fs-inline-int">
      <Input
        id={id}
        size="sm"
        appearance="filled"
        className="fs-mono-input"
        inputMode="numeric"
        aria-label={label}
        value={text}
        placeholder={placeholder}
        disabled={disabled}
        invalid={error !== null}
        aria-describedby={error !== null ? `${id}-help` : undefined}
        autoComplete="off"
        onFocus={() => { editing.current = true; }}
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
      ) : null}
    </div>
  );
}

/** A whole number — volts, amperes, watts, spaces — committed on Enter or blur once it parses and is in range. */
export function IntField({ label, value, onCommit, disabled, min, max, unit, placeholder, allowEmpty = false }: { label: string; value: number | undefined; onCommit: (value: number | null) => void; disabled?: boolean; min?: number | undefined; max?: number | undefined; unit?: string | undefined; placeholder?: string | undefined; allowEmpty?: boolean }) {
  const id = useId();
  const shown = value === undefined ? '' : String(value);
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
    const t = text.trim();
    if (t === shown) return;
    if (t === '') {
      if (allowEmpty) onCommit(null);
      else setText(shown);
      return;
    }
    if (!/^-?\d+$/.test(t)) {
      setError('A whole number');
      return;
    }
    const n = Number(t);
    if ((min !== undefined && n < min) || (max !== undefined && n > max) || !Number.isSafeInteger(n)) {
      setError(min !== undefined && max !== undefined ? `From ${String(min)} to ${String(max)}` : min !== undefined ? `At least ${String(min)}` : `At most ${String(max)}`);
      return;
    }
    setError(null);
    if (n !== value) onCommit(n);
  };
  return (
    <Row label={unit === undefined ? label : `${label} (${unit})`} htmlFor={id}>
      <Input
        id={id}
        appearance="filled"
        className="fs-mono-input"
        inputMode="numeric"
        value={text}
        placeholder={placeholder}
        disabled={disabled}
        invalid={error !== null}
        aria-describedby={error !== null ? `${id}-help` : undefined}
        autoComplete="off"
        onFocus={() => { editing.current = true; }}
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
      ) : null}
    </Row>
  );
}
