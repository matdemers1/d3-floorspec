import { useRef, useState } from 'react';
import { Button, Modal, Select } from '@d3cloud/ui';
import { embedOps, libraryChoices } from './library';
import { Download, Plus, Ruler, Upload } from 'lucide-react';
import { MAP_MEDIA_TYPES, type FloorspecDocument } from '@floorspec/engine';
import { useEditor, type EditorStore } from './store';
import { labelOf, type EditorModel } from './model';
import { IntField, LengthField, Row, Section } from './fields';
import { prettyLen, type UnitSystem } from './units';
import { setProperty, unsetProperty, type Batch, type BatchBuilder } from './ops';
import { nextIds } from './optionOps';
import { messageOf } from '../lib/api';
import { ACCEPT, assetHref, documentAsset, uploadTexture } from '../materials/api';
import { CalibrateTexture } from '../materials/CalibrateDialog';
import type { UploadedAsset } from '../materials/calibrate';
import '../materials/materials.css';

/**
 * Materials (Core 0.3, 18.1–18.2; FLR-T-8.1): the project's materials as the board's "13 · Materials
 * & textures" lists them — a swatch, the PBR factors, the real-world tile size and what uses each —
 * and the inspector's fields for one: colour, metallic and roughness in thousandths, and a texture
 * laid from an asset already in the project. A photo is uploaded here into the content-addressed
 * asset store and calibrated to its real-world size (FLR-T-8.2, the board's frame 13b).
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

/** The width of surface a material card's swatch shows: 2 ft, so a 12" tile repeats twice across it. */
const SWATCH_WIDTH = 2 * 390_144;

/** A material card's or a swatch's background: its colour map, tiled at its real-world size, over its colour. */
export function swatchStyle(projectId: string, document: FloorspecDocument, m: Json | undefined, width = SWATCH_WIDTH): React.CSSProperties | undefined {
  const color = str(m?.['color']);
  const tex = m?.['texture'] as Json | undefined;
  const asset = str(tex?.['asset']);
  const sha = asset === undefined ? undefined : str((document.assets as Record<string, Json | undefined> | undefined)?.[asset]?.['sha256']);
  const size = tex?.['size'] as [number, number] | undefined;
  if (sha === undefined || size === undefined) return color === undefined ? undefined : { background: color };
  return {
    backgroundColor: color,
    backgroundImage: `url("${assetHref(projectId, sha)}")`,
    backgroundSize: `${String((size[0] / width) * 100)}% auto`,
    backgroundPosition: 'left bottom',
  };
}

/** Upload state shared by the modal's button and its drop zone. */
function useUpload(projectId: string, done: (asset: UploadedAsset) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = (file: File | undefined) => {
    if (file === undefined) return;
    setBusy(true);
    setError(null);
    uploadTexture(projectId, file)
      .then((asset) => {
        setBusy(false);
        done(asset);
      })
      .catch((e: unknown) => {
        setBusy(false);
        setError(messageOf(e));
      });
  };
  return { busy, error, send };
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
  const selection = useEditor(store, (s) => s.selection);
  const [pick, setPick] = useState<string | null>(null);
  const [calibrating, setCalibrating] = useState<UploadedAsset | null>(null);
  const [over, setOver] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const upload = useUpload(store.projectId, setCalibrating);
  if (!open || model === null) return null;
  const close = () => {
    setCalibrating(null);
    store.set({ materialsOpen: false });
  };
  if (calibrating !== null)
    return (
      <CalibrateTexture
        asset={calibrating}
        model={model}
        units={units}
        selection={selection}
        onClose={close}
        apply={(label, batch) => store.apply(label, batch)}
      />
    );
  const images = (Object.entries((model.document.assets ?? {}) as Record<string, Json | undefined>))
    .filter(([, a]) => MAP_MEDIA_TYPES.includes(str(a?.['mediaType']) ?? '') && str(a?.['path']) !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
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
      {!readOnly ? (
        <div
          className="fs-materials__drop"
          data-over={over}
          data-testid="texture-drop"
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes('Files')) return;
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => { setOver(false); }}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            upload.send(e.dataTransfer.files[0]);
          }}
        >
          <span>Drop a photo of a tile, a plank or a stone here — PNG, JPEG, WebP or KTX2 — then say how big it is.</span>
          <Button variant="primary" icon={<Upload />} disabled={upload.busy} onClick={() => file.current?.click()}>
            {upload.busy ? 'Uploading…' : 'Upload texture'}
          </Button>
          <input
            ref={file}
            type="file"
            accept={ACCEPT}
            className="fs-file-input"
            aria-label="Texture image file"
            tabIndex={-1}
            onChange={(e) => {
              upload.send(e.currentTarget.files?.[0]);
              e.currentTarget.value = '';
            }}
          />
          <span className="fs-mono-small">Stored by its SHA-256; location and camera metadata are removed first.</span>
        </div>
      ) : null}
      {upload.error !== null ? <p className="fs-materials__error" role="alert">{upload.error}</p> : null}
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
                  <span className="fs-material-card__swatch" style={swatchStyle(store.projectId, model.document, m)} data-textured={tex?.['asset'] !== undefined} aria-hidden="true" />
                  <span className="fs-material-card__name">{labelOf(model, id)}</span>
                  <span className="fs-material-card__meta">{[tileText(tex, units), factors(m ?? {})].filter((x) => x !== null).join(' · ')}</span>
                  <span className="fs-material-card__uses">{used.length === 0 ? 'Not used' : used.slice(0, 4).map((u) => labelOf(model, u)).join(', ') + (used.length > 4 ? ` +${String(used.length - 4)}` : '')}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {images.length > 0 ? (
        <>
          <h3 className="fs-overline fs-materials__images-head">Images · {String(images.length)}</h3>
          <ul className="fs-materials__images" aria-label="Images">
            {images.map(([id, a]) => {
              const sha = str(a?.['sha256']) ?? '';
              const name = str(a?.['name']) ?? str(a?.['path']) ?? id;
              return (
                <li key={id}>
                  <span className="fs-materials__thumb" style={{ backgroundImage: `url("${assetHref(store.projectId, sha)}")` }} aria-hidden="true" />
                  <span className="fs-materials__image-name">{name}</span>
                  <span className="fs-mono-small fs-materials__path" title={str(a?.['path'])}>{str(a?.['path'])}</span>
                  <a className="fs-linkish" href={`${assetHref(store.projectId, sha)}?download`} download aria-label={`Download ${name}`}>
                    <Download size={14} aria-hidden="true" />
                  </a>
                </li>
              );
            })}
          </ul>
          <p className="fs-note">Saved beside model.json at these paths, they make the model&rsquo;s package (Core 18.4).</p>
        </>
      ) : null}
    </Modal>
  );
}

/** The inspector's fields for a material: its PBR factors and its texture (Core 18.1, 18.2). */
export function MaterialSurface({ store, id, element, model, units, readOnly, edit }: { store: EditorStore; id: string; element: Json; model: EditorModel; units: UnitSystem; readOnly: boolean; edit: (label: string, batch: Batch) => void }) {
  const name = labelOf(model, id);
  const [calibrating, setCalibrating] = useState<UploadedAsset | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const upload = useUpload(store.projectId, setCalibrating);
  const selection = useEditor(store, (s) => s.selection);
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
        {images.length === 0 ? <p className="fs-note">No images in this project yet. A material without a map shows its colour.</p> : null}
        {!readOnly ? (
          <div className="fs-materials__head">
            <Button size="sm" variant="secondary" icon={<Upload />} disabled={upload.busy} onClick={() => file.current?.click()}>
              {upload.busy ? 'Uploading…' : 'Upload a photo'}
            </Button>
            <input
              ref={file}
              type="file"
              accept={ACCEPT}
              className="fs-file-input"
              aria-label={`Texture image file for ${name}`}
              tabIndex={-1}
              onChange={(e) => {
                upload.send(e.currentTarget.files?.[0]);
                e.currentTarget.value = '';
              }}
            />
            {tex !== undefined && str(tex['asset']) !== undefined ? (
              <Button
                size="sm"
                variant="ghost"
                icon={<Ruler />}
                onClick={() => {
                  const a = documentAsset(store.projectId, model.document.assets, str(tex['asset']) ?? '');
                  if (a !== null) setCalibrating(a);
                }}
              >
                Calibrate
              </Button>
            ) : null}
          </div>
        ) : null}
        {upload.error !== null ? <p className="fs-materials__error" role="alert">{upload.error}</p> : null}
        {calibrating !== null ? (
          <CalibrateTexture
            asset={calibrating}
            model={model}
            units={units}
            selection={selection === id ? null : selection}
            material={id}
            onClose={() => { setCalibrating(null); }}
            apply={(label, batch) => store.apply(label, batch)}
          />
        ) : null}
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
