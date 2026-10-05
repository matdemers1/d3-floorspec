import { useEffect, useId, useRef, useState } from 'react';
import { Button, Input } from '@d3cloud/ui';
import type { EditorStore } from '../../store';
import type { EditorModel } from '../../model';
import { setProperty, unsetProperty } from '../../ops';
import { Row, Section } from '../../fields';
import { MICRO, siteOf } from './study';
import { formatDegrees, parseDegrees, type Axis } from './degrees';

/**
 * The site's place on the earth (Core 1.8, FLR-T-8.6): latitude and longitude (WGS 84) and the
 * angle from project north to true north — what the sun study places the sun from. Each is a
 * `setProperty` on `$site` (the Ops create the site when the document has none); `location` is set
 * whole, because Core requires both of its members together.
 */

function DegreesField({ label, axis, value, onCommit, disabled, hint }: { label: string; axis: Axis; value: number | null; onCommit: (micro: number) => void; disabled: boolean; hint?: string | undefined }) {
  const id = useId();
  const shown = value === null ? '' : formatDegrees(value, axis);
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
    if (text.trim() === shown.trim()) return;
    if (text.trim() === '') {
      setText(shown);
      return;
    }
    const parsed = parseDegrees(text, axis);
    if ('error' in parsed) {
      setError(parsed.error);
      return;
    }
    setError(null);
    onCommit(parsed.value);
  };
  const described = [error !== null ? `${id}-error` : null, hint !== undefined ? `${id}-hint` : null].filter((x) => x !== null).join(' ');
  return (
    <Row label={label} htmlFor={id}>
      <Input
        id={id}
        appearance="filled"
        className="fs-mono-input"
        value={text}
        disabled={disabled}
        invalid={error !== null}
        placeholder={axis === 'latitude' ? '42.36 N' : axis === 'longitude' ? '71.06 W' : '0'}
        aria-describedby={described === '' ? undefined : described}
        autoComplete="off"
        spellCheck={false}
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
        <p id={`${id}-error`} className="fs-field-error" role="alert">
          {error}
        </p>
      ) : null}
      {hint !== undefined ? (
        <p id={`${id}-hint`} className="fs-note">
          {hint}
        </p>
      ) : null}
    </Row>
  );
}

/**
 * The site's fields. Latitude and longitude are one Core member: until the document has a location,
 * the first one typed waits here for the other, and both are set in one batch.
 */
export function SiteFields({ store, model, readOnly }: { store: EditorStore; model: EditorModel; readOnly: boolean }) {
  const site = siteOf(model);
  const [pending, setPending] = useState<{ latitude: number | null; longitude: number | null }>({ latitude: null, longitude: null });
  const located = site.latitude !== null && site.longitude !== null;
  useEffect(() => {
    if (located) setPending({ latitude: null, longitude: null });
  }, [located]);

  const setLocation = (axis: 'latitude' | 'longitude', micro: number) => {
    const lat = axis === 'latitude' ? micro : site.latitude !== null ? Math.round(site.latitude * MICRO) : pending.latitude;
    const lon = axis === 'longitude' ? micro : site.longitude !== null ? Math.round(site.longitude * MICRO) : pending.longitude;
    if (lat === null || lon === null) {
      setPending({ latitude: lat, longitude: lon });
      return;
    }
    void store.apply(located ? `Set the site's ${axis}` : "Set the site's location", setProperty('$site', '/location', { latitude: lat, longitude: lon }));
  };
  const waiting = !located && (pending.latitude !== null) !== (pending.longitude !== null);
  const lat = site.latitude ?? (pending.latitude === null ? null : pending.latitude / MICRO);
  const lon = site.longitude ?? (pending.longitude === null ? null : pending.longitude / MICRO);

  return (
    <>
      <DegreesField label="Latitude" axis="latitude" value={lat} disabled={readOnly} onCommit={(v) => { setLocation('latitude', v); }} hint={waiting && pending.latitude !== null ? 'Add the longitude to place the site.' : undefined} />
      <DegreesField label="Longitude" axis="longitude" value={lon} disabled={readOnly} onCommit={(v) => { setLocation('longitude', v); }} hint={waiting && pending.longitude !== null ? 'Add the latitude to place the site.' : undefined} />
      <DegreesField
        label="True north"
        axis="north"
        value={site.trueNorth}
        disabled={readOnly}
        onCommit={(v) => { void store.apply('Set true north', setProperty('$site', '/trueNorth', v)); }}
        hint="From the plan's up (+Y) to true north, anticlockwise positive."
      />
      {located && !readOnly ? (
        <Button variant="ghost" size="sm" className="fs-sun__clear" onClick={() => { void store.apply("Clear the site's location", unsetProperty('$site', '/location')); }}>
          Clear the location
        </Button>
      ) : null}
    </>
  );
}

/** The inspector's "Site" section, with nothing selected: the project's place and orientation. */
export function SiteSection({ store, model, readOnly }: { store: EditorStore; model: EditorModel; readOnly: boolean }) {
  return (
    <Section title="Site">
      <SiteFields store={store} model={model} readOnly={readOnly} />
      <p className="fs-note">The 3D view's sun and shadow study places the sun from these.</p>
    </Section>
  );
}
