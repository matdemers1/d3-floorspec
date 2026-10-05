import { useState } from 'react';
import { Button, Modal, Select } from '@d3cloud/ui';
import { embedOps, libraryChoices } from './library';
import { Plus } from 'lucide-react';
import { MAP_MEDIA_TYPES, type FloorspecDocument } from '@floorspec/engine';
import { useEditor, type EditorStore } from './store';
import { labelOf, type EditorModel } from './model';
import { IntField, LengthField, Row, Section } from './fields';
import { prettyLen, type UnitSystem } from './units';
import { setProperty, unsetProperty, type Batch, type BatchBuilder } from './ops';
import { nextIds } from './optionOps';

/**
 * Materials (Core 0.3, 18.1–18.2; FLR-T-8.1): the project's materials as the board's "13 · Materials
 * & textures" lists them — a swatch, the PBR factors, the real-world tile size and what uses each —
 * and the inspector's fields for one: colour, metallic and roughness in thousandths, and a texture
 * laid from an asset already in the project (uploading is FLR-T-8.2's asset store).
 */

type Json = Record<string, unknown>;

/** 12" — a tile's size until one is typed (Core 18.2: `size` is always present). */
const DEFAULT_TILE = 390_144;

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

/** What refers to each material — rooms' finishes, wall faces and regions, layers, slabs, roofs — by material. */
export function materialUses(model: EditorModel): Map<string, string[]> {
  const out = new Map<string, Set<string>>();
  const add = (m: unknown, by: string) => {
    if (typeof m !== 'string') return;
    out.set(m, (out.get(m) ?? new Set()).add(by));
  };
  const doc = model.document as unknown as Record<string, Record<string, Json> | undefined>;
  for (const [id, r] of Object.entries(doc['rooms'] ?? {})) for (const k of ['wallFinish', 'floorFinish', 'ceilingFinish']) add(r[k], id);
  for (const [id, w] of Object.entries(doc['walls'] ?? {})) {
    for (const l of (w['layers'] as Json[] | undefined) ?? []) add(l['material'], id);
    const f = w['finishes'] as Record<string, Json | undefined> | undefined;
    for (const face of Object.values(f ?? {})) {
      add(face?.['material'], id);
      for (const r of (face?.['regions'] as Json[] | undefined) ?? []) add(r['material'], id);
    }
  }
  for (const [id, t] of Object.entries(doc['types'] ?? {})) for (const l of (t['layers'] as Json[] | undefined) ?? []) add(l['material'], id);
  for (const c of ['slabs', 'roofs']) for (const [id, e] of Object.entries(doc[c] ?? {})) add(e['material'], id);
  return new Map([...out].map(([k, v]) => [k, [...v].sort()]));
}

/** The images of a project a texture's map may use (Core 18.2.2). */
export function imageAssets(document: FloorspecDocument): { id: string; label: string }[] {
  return Object.entries((document.assets ?? {}) as Record<string, Json | undefined>)
    .filter(([, a]) => MAP_MEDIA_TYPES.includes(str(a?.['mediaType']) ?? ''))
    .map(([id, a]) => ({ id, label: str(a?.['name']) ?? str(a?.['path']) ?? str(a?.['uri']) ?? id }));
}

/** A new material: a name, matte and non-metallic until said otherwise (Core 18.1); its colour is chosen next. */
export function addMaterial(model: EditorModel, name: string): BatchBuilder {
  return (attempt) => {
    const [id] = nextIds(model, 'M', 1, attempt) as [string];
    return [{ op: 'addElement', collection: 'materials', id, element: { name } }] as Batch;
  };
}

function tileText(tex: Json | undefined, units: UnitSystem): string | null {
  const size = tex?.['size'] as [number, number] | undefined;
  return size === undefined ? null : `${prettyLen(size[0], units)} × ${prettyLen(size[1], units)} tile`;
}

function factors(m: Json): string {
  const r = num(m['roughness']);
  const k = num(m['metallic']);
  return [k === undefined ? null : `metallic ${String(k / 10)}%`, r === undefined ? null : `roughness ${String(r / 10)}%`].filter((x) => x !== null).join(' · ') || 'matte';
}

export function MaterialsModal({ store }: { store: EditorStore }) {
  const open = useEditor(store, (s) => s.materialsOpen);
  const model = useEditor(store, (s) => s.model);
  const readOnly = useEditor(store, (s) => s.readOnly) !== null;
  const units = useEditor(store, () => store.units);
  const [pick, setPick] = useState<string | null>(null);
  if (!open || model === null) return null;
  const close = () => { store.set({ materialsOpen: false }); };
  const library = libraryChoices(model.document, 'material');
  const uses = materialUses(model);
  const materials = Object.entries((model.document.materials ?? {}) as Record<string, Json | undefined>).sort(([a], [b]) => a.localeCompare(b));
  return (
    <Modal
      open
      size="lg"
      onOpenChange={(o) => { if (!o) close(); }}
      title={`Materials · ${String(materials.length)}`}
      description="PBR materials with a real-world tile size, so a 12 × 24 tile renders at 12 × 24 in. Rooms' finishes reach the walls around them; a wall face or a region of it can override."
      footer={
        <>
          {!readOnly ? (
            <Button
              variant="secondary"
              icon={<Plus />}
              onClick={() => {
                void store.apply('Add a material', addMaterial(model, `Material ${String(materials.length + 1)}`), {
                  select: (created) => created[0] ?? null,
                });
                close();
              }}
            >
              New material
            </Button>
          ) : null}
          <Button variant="ghost" onClick={close}>Close</Button>
        </>
      }
    >
      {!readOnly && library.length > 0 ? (
        <section className="fs-materials__library" aria-label="US starter library">
          <h3 className="fs-overline">From the US starter library · CC0</h3>
          <div className="fs-materials__library-row">
            <Select
              aria-label="Library material"
              appearance="filled"
              options={library.map((i) => ({ value: i.id, label: i.name, ...(i.summary['description'] === undefined ? {} : { description: i.summary['description'] }) }))}
              value={pick ?? library[0]?.id ?? ''}
              onValueChange={setPick}
            />
            <Button
              variant="secondary"
              onClick={() => {
                const item = library.find((i) => i.id === (pick ?? library[0]?.id ?? ''));
                if (item !== undefined) void store.apply(`Add ${item.name}`, embedOps(model.document, item));
              }}
            >
              Add
            </Button>
          </div>
        </section>
      ) : null}
      {materials.length === 0 ? (
        <p className="fs-note">This project has no materials yet. Add one, then choose it as a room&rsquo;s floor, wall or ceiling finish.</p>
      ) : (
        <ul className="fs-materials" aria-label="Materials">
          {materials.map(([id, m]) => {
            const used = uses.get(id) ?? [];
            const tex = m?.['texture'] as Json | undefined;
            const color = str(m?.['color']);
            return (
              <li key={id}>
                <button
                  type="button"
                  className="fs-material-card"
                  onClick={() => {
                    close();
                    store.select(id);
                  }}
                >
                  <span className="fs-material-card__swatch" style={color === undefined ? undefined : { background: color }} aria-hidden="true" />
                  <span className="fs-material-card__name">{labelOf(model, id)}</span>
                  <span className="fs-material-card__meta">{[tileText(tex, units), factors(m ?? {})].filter((x) => x !== null).join(' · ')}</span>
                  <span className="fs-material-card__uses">{used.length === 0 ? 'Not used' : used.slice(0, 4).map((u) => labelOf(model, u)).join(', ') + (used.length > 4 ? ` +${String(used.length - 4)}` : '')}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Modal>
  );
}

/** The inspector's fields for a material: its PBR factors and its texture (Core 18.1, 18.2). */
export function MaterialSurface({ id, element, model, units, readOnly, edit }: { id: string; element: Json; model: EditorModel; units: UnitSystem; readOnly: boolean; edit: (label: string, batch: Batch) => void }) {
  const name = labelOf(model, id);
  const tex = element['texture'] as Json | undefined;
  const images = imageAssets(model.document);
  const size = (tex?.['size'] as [number, number] | undefined) ?? [DEFAULT_TILE, DEFAULT_TILE];
  const maps = ['asset', 'normal', 'metallicRoughness', 'occlusion'].filter((k) => tex?.[k] !== undefined);
  const [w, h] = size;
  const thousandths = (key: 'metallic' | 'roughness', label: string) => (
    <IntField
      label={label}
      unit="‰"
      value={num(element[key])}
      min={0}
      max={1000}
      allowEmpty
      placeholder={key === 'metallic' ? '0 (not metal)' : '1000 (matte)'}
      disabled={readOnly}
      onCommit={(v) => { edit(`Set ${key} of ${name}`, v === null ? unsetProperty(id, `/${key}`) : setProperty(id, `/${key}`, v)); }}
    />
  );
  const setMap = (key: string, asset: string) => {
    if (asset === '') {
      const rest = maps.filter((k) => k !== key);
      edit(`Clear the ${key === 'asset' ? 'colour' : key} map of ${name}`, rest.length === 0 ? unsetProperty(id, '/texture') : unsetProperty(id, `/texture/${key}`));
    } else if (tex === undefined) edit(`Texture ${name}`, setProperty(id, '/texture', { [key]: asset, size: [DEFAULT_TILE, DEFAULT_TILE] }));
    else edit(`Set the ${key === 'asset' ? 'colour' : key} map of ${name}`, setProperty(id, `/texture/${key}`, asset));
  };
  const mapSelect = (key: string, label: string) => (
    <Row label={label}>
      <Select
        aria-label={`${label} of ${name}`}
        appearance="filled"
        options={[{ value: '', label: 'None' }, ...images.map((a) => ({ value: a.id, label: a.label }))]}
        value={str(tex?.[key]) ?? ''}
        disabled={readOnly || images.length === 0}
        onValueChange={(v) => { setMap(key, v); }}
      />
    </Row>
  );
  return (
    <>
      <Section title="Surface">
        {thousandths('metallic', 'Metallic')}
        {thousandths('roughness', 'Roughness')}
        <p className="fs-note">Thousandths, as glTF's metallic-roughness model: 0 metallic is paint, wood, tile or stone; 1000 roughness is fully matte.</p>
      </Section>
      <Section title="Texture">
        {mapSelect('asset', 'Colour map')}
        {mapSelect('normal', 'Normal map')}
        {images.length === 0 ? <p className="fs-note">No images in this project yet: uploading arrives with the asset store. A material without a map shows its colour.</p> : null}
        {tex !== undefined ? (
          <>
            <LengthField label="Tile width" value={w} units={units} positive disabled={readOnly} onCommit={(v) => { if (v !== null && v !== w) edit(`Set tile size of ${name}`, setProperty(id, '/texture/size', [v, h])); }} />
            <LengthField label="Tile height" value={h} units={units} positive disabled={readOnly} onCommit={(v) => { if (v !== null && v !== h) edit(`Set tile size of ${name}`, setProperty(id, '/texture/size', [w, v])); }} />
            <p className="fs-note">The real-world size of one tile: the image covers {prettyLen(w, units)} by {prettyLen(h, units)} of every surface it is on (Core 18.2).</p>
          </>
        ) : null}
      </Section>
    </>
  );
}
