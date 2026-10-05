import { Button, IconButton, Select, StatusDot } from '@d3cloud/ui';
import { RotateCcw, RotateCw, Plus, X } from 'lucide-react';
import { jsonEqual, type ClearanceEnvelope } from '@floorspec/engine';
import { labelOf } from '../editor/model';
import { IntField, ReadOnlyField, Row, Section, TextField } from '../editor/fields';
import { setOrUnset } from '../editor/ops';
import { PlacementSection, type SystemsCtx } from '../editor/systems/Panels';
import type { DeviceView } from '../editor/systems/view';
import { assetHref } from './api';
import { CATEGORIES, categoryLabel, defaultEnvelopes, KINDS, type FurnitureKind } from './library';
import { EXTENSION, setMember, turnFurniture } from './ops';
import { ClearancePreview, reachText, sizeText } from './Preview';
import { bytesText, filesOf, lintsOf, lintText } from './view';
import type { Box } from './gltf';

/**
 * The inspector of an FS_furniture element (FLR-T-8.3): what it is (category, name, catalogue,
 * seats), what it belongs with (`with`, 4.3) and what serves it (an appliance's `connections`, 4.4);
 * where it is (the systems' placement section, plus a turn of 90°); its clearances, and the notes
 * the engine has about it — FS_furniture's interference lints (4.5) in a person's words; and its
 * fallback files. Every field is an Op on the element.
 */

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

const QUARTER = 90_000_000;

export function FurnitureBody({ ctx, device }: { ctx: SystemsCtx; device: DeviceView | undefined }) {
  const { model, id, element, readOnly, units, store } = ctx;
  const at = model.ext.get(id);
  if (at === undefined) return null;
  const kind = at.collection as FurnitureKind;
  const label = labelOf(model, id);
  const category = str(element['category']) ?? 'other';
  const fallback = isObject(element['fallback']) ? element['fallback'] : {};
  const box = fallback['box'] as Box | undefined;
  const clearances = (isObject(element['clearances']) ? element['clearances'] : {}) as Record<string, ClearanceEnvelope>;
  const files = filesOf(model.document, element);
  const lints = lintsOf(model, id);
  const host = isObject(element['host']) ? element['host'] : null;
  const turnable = host !== null && (host['mode'] === 'surface' || host['mode'] === 'free');
  const set = (member: string, value: unknown, what: string) => { ctx.edit(`Set ${what} of ${label}`, setMember(id, member, value, element[member] !== undefined)); };

  // Its groups (4.3): another FS_furniture element that is with nothing — not itself, and not one with it.
  const own = model.levels.flatMap((l) => l.devices).filter((d) => d.extension === EXTENSION);
  const withOptions = own.filter((d) => d.id !== id && d.element['with'] === undefined && !own.some((o) => o.element['with'] === id && o.id === d.id));
  const isGroupHead = own.some((o) => o.element['with'] === id);
  // Connections (4.4): elements of another extension.
  const connections = Array.isArray(element['connections']) ? (element['connections'] as string[]) : [];
  const others = [...model.ext].filter(([, x]) => x.extension !== EXTENSION).map(([eid]) => eid).filter((eid) => !connections.includes(eid));

  const categoryChange = (next: string) => {
    if (next === category || box === undefined) return;
    // Its envelopes follow the category when they are still the old category's defaults.
    const untouched = jsonEqual(clearances, defaultEnvelopes(category, box));
    const after = defaultEnvelopes(next, box);
    ctx.edit(`Make ${label} a ${categoryLabel(next).toLowerCase()}`, [
      ...setMember(id, 'category', next, true),
      ...(untouched ? setMember(id, 'clearances', Object.keys(after).length === 0 ? undefined : after, element['clearances'] !== undefined) : []),
    ]);
  };

  return (
    <>
      {lints.length > 0 ? (
        <Section title="Notes">
          <ul className="fs-furn-notes" aria-label={`Notes on ${label}`}>
            {lints.map((d) => (
              <li key={`${d.code}:${d.elements.join(',')}`}>
                <StatusDot tone="warning" size="sm">{d.code}</StatusDot>
                <span>{lintText(model, d, id, (e) => labelOf(model, e))}</span>
              </li>
            ))}
          </ul>
          <p className="fs-note">Notes are lints: the model stays valid, and nothing is blocked.</p>
        </Section>
      ) : null}
      {box !== undefined ? (
        <div className="fs-furn__stage fs-furn__stage--inspector">
          <ClearancePreview box={box} clearances={clearances} symbol={files.symbol === null ? null : assetHref(store.projectId, files.symbol.sha256)} units={units} label={`${label}: plan symbol and clearance envelopes`} />
        </div>
      ) : null}
      <PlacementSection ctx={ctx} device={device} />
      {turnable && !readOnly ? (
        <div className="fs-furn__turn" role="group" aria-label="Turn">
          <Button size="sm" variant="ghost" icon={<RotateCcw />} onClick={() => { const b = turnFurniture(id, host, QUARTER); if (b !== null) ctx.edit(`Turn ${label}`, b); }}>Turn left 90°</Button>
          <Button size="sm" variant="ghost" icon={<RotateCw />} onClick={() => { const b = turnFurniture(id, host, -QUARTER); if (b !== null) ctx.edit(`Turn ${label}`, b); }}>Turn right 90°</Button>
          <span className="fs-mono-small">[ and ] turn it, ⇧ by 15°</span>
        </div>
      ) : null}
      <Section title="Item">
        <TextField label="Name" value={str(element['name']) ?? ''} disabled={readOnly} placeholder="No name" onCommit={(v) => { ctx.edit(`Rename ${id}`, setOrUnset(id, '/name', v, element['name'] !== undefined)); }} />
        <ReadOnlyField label="Kind" value={KINDS.find((k) => k.kind === kind)?.singular ?? kind} />
        <Row label="Category">
          <Select
            aria-label="Category"
            appearance="filled"
            options={(CATEGORIES[kind] as readonly string[] | undefined ?? ['other']).map((c) => ({ value: c, label: categoryLabel(c) }))}
            value={category}
            disabled={readOnly}
            onValueChange={categoryChange}
          />
        </Row>
        <TextField label="Catalogue" value={str(element['catalogue']) ?? ''} disabled={readOnly} placeholder="A library item or model number" onCommit={(v) => { set('catalogue', v === '' ? undefined : v, 'the catalogue'); }} />
        {kind === 'pieces' ? (
          <IntField label="Seats" value={typeof element['seats'] === 'number' ? element['seats'] : undefined} min={1} max={100} allowEmpty placeholder="Not stated" disabled={readOnly} onCommit={(v) => { set('seats', v ?? undefined, 'the seats'); }} />
        ) : null}
        <Row label="With">
          <Select
            aria-label="With"
            appearance="filled"
            options={[{ value: '', label: isGroupHead ? 'Nothing (others are with it)' : 'Nothing' }, ...withOptions.map((d) => ({ value: d.id, label: labelOf(model, d.id) }))]}
            value={str(element['with']) ?? ''}
            disabled={readOnly || isGroupHead}
            onValueChange={(v) => { set('with', v === '' ? undefined : v, 'what it is with'); }}
          />
        </Row>
      </Section>
      {kind === 'appliances' ? (
        <Section
          title="Connections"
          aside={
            readOnly || others.length === 0 ? undefined : (
              <Select
                aria-label="Add a connection"
                appearance="filled"
                placeholder="Add…"
                options={others.map((eid) => ({ value: eid, label: `${labelOf(model, eid)} · ${model.ext.get(eid)?.extension ?? ''}` }))}
                value=""
                onValueChange={(v) => { if (v !== '') set('connections', [...connections, v], 'the connections'); }}
              />
            )
          }
        >
          {connections.length === 0 ? (
            <p className="fs-note">What serves it — its water, drain, gas or receptacle — from FS_plumbing, FS_mechanical or FS_electrical.</p>
          ) : (
            <ul className="fs-reflist">
              {connections.map((c) => (
                <li key={c}>
                  <button type="button" className="fs-linkish" onClick={() => { store.select(c); }}>{labelOf(model, c)}</button>
                  <span className="fs-spacer" />
                  {!readOnly ? <IconButton size="sm" label={`Disconnect ${labelOf(model, c)}`} icon={<X />} onClick={() => { set('connections', connections.filter((x) => x !== c), 'the connections'); }} /> : null}
                </li>
              ))}
            </ul>
          )}
        </Section>
      ) : null}
      <Section
        title="Clearances"
        aside={
          readOnly || box === undefined || jsonEqual(defaultEnvelopes(category, box), clearances) || Object.keys(defaultEnvelopes(category, box)).length === 0 ? undefined : (
            <Button size="sm" variant="ghost" icon={<Plus />} onClick={() => { set('clearances', defaultEnvelopes(category, box), 'the clearances'); }}>Defaults</Button>
          )
        }
      >
        {Object.keys(clearances).length === 0 ? (
          <p className="fs-note">None.</p>
        ) : (
          <ul className="fs-reflist">
            {Object.entries(clearances).map(([name, e]) => (
              <li key={name}>
                <span>
                  {name} · {e.purpose} · {box === undefined ? '' : reachText(box, e, units)}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="fs-note">Shown on the plan and in 3D with the Clearances layer.</p>
      </Section>
      <Section title="Fallback">
        {box !== undefined ? <ReadOnlyField label="Box" value={sizeText(box, units)} /> : null}
        <Row label="Model">
          {files.model === null ? (
            <span className="fs-note">None</span>
          ) : (
            <a className="fs-linkish" href={`${assetHref(store.projectId, files.model.sha256)}?download`} download>
              {files.model.name ?? files.model.id} · {bytesText(files.model.byteLength)}
            </a>
          )}
        </Row>
        <Row label="Symbol">
          {files.symbol === null ? <span className="fs-note">None</span> : <span className="fs-mono-small">{files.symbol.name ?? files.symbol.id} · {files.symbol.mediaType}</span>}
        </Row>
        <p className="fs-note">What a reader without {EXTENSION} draws: the box, the model and the symbol (Floorspec Core 12.6).</p>
      </Section>
    </>
  );
}
