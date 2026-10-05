import { useMemo, useRef, useState } from 'react';
import { Button, Modal, Select, Switch } from '@d3cloud/ui';
import { ArrowLeft, Upload } from 'lucide-react';
import { useEditor, type EditorStore } from '../editor/store';
import { labelOf } from '../editor/model';
import { Row, TextField } from '../editor/fields';
import { MODEL_ACCEPT, SYMBOL_ACCEPT, uploadAsset } from './api';
import { faceXFromZ, GltfError, modelBox, outlineSymbol, type Box } from './gltf';
import { CATEGORIES, categoryLabel, defaultEnvelopes, KINDS, type FurnitureKind } from './library';
import { placeIn, targetRoom } from './actions';
import { ClearancePreview, sizeText } from './Preview';
import { furnitureOf, useFurniture } from './state';
import { hostText } from './Browser';

/**
 * "Upload glTF" (FLR-T-8.3): a model of your own — a .glb, or a .gltf with its buffers embedded —
 * and, if you have one, its plan symbol (SVG or PNG). The box is read from the model's bounds
 * (gltf.ts) and placed as Core 12.6 says; a model made facing +Z is turned to face +X by putting its
 * scene under one node, as Core 12.6's note says, before it is uploaded. Its category gives it
 * FS_furniture's default envelopes (4.2). The server reads what each file is from its bytes and
 * sanitizes an SVG; nothing is placed until both are stored. Without a symbol, the item gets an
 * outline of its footprint, since every FS_furniture kind requires one.
 */

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const baseName = (n: string) => n.replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').trim().slice(0, 120);

export function UploadFurniture({ store }: { store: EditorStore }) {
  const f = furnitureOf(store);
  const model = useEditor(store, (s) => s.model);
  const units = useEditor(store, () => store.units);
  const chosenRoom = useFurniture(store, (s) => s.room);
  const [file, setFile] = useState<{ name: string; bytes: Uint8Array } | null>(null);
  const [symbol, setSymbol] = useState<File | null>(null);
  const [facesZ, setFacesZ] = useState(false);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<FurnitureKind>('pieces');
  const [category, setCategory] = useState('other');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const modelInput = useRef<HTMLInputElement>(null);
  const symbolInput = useRef<HTMLInputElement>(null);

  const read = useMemo((): { box: Box; bytes: Uint8Array } | { error: string } | null => {
    if (file === null) return null;
    try {
      const bytes = facesZ ? faceXFromZ(file.bytes) : file.bytes;
      return { box: modelBox(bytes), bytes };
    } catch (e) {
      return { error: e instanceof GltfError ? e.message : `this model could not be read (${messageOf(e)})` };
    }
  }, [file, facesZ]);
  const box = read !== null && 'box' in read ? read.box : null;
  const clearances = box === null ? {} : defaultEnvelopes(category, box);

  if (model === null) return null;
  const level = store.levelView;
  const room = chosenRoom !== null && level?.rooms.some((r) => r.id === chosenRoom) ? chosenRoom : targetRoom(store, kind);
  const back = () => { f.set({ uploading: false }); };
  const close = () => { f.set({ uploading: false, open: false }); };

  const choose = (picked: File | undefined) => {
    if (picked === undefined) return;
    setError(null);
    void picked.arrayBuffer().then((buf) => {
      setFile({ name: picked.name, bytes: new Uint8Array(buf) });
      if (name === '') setName(baseName(picked.name));
    });
  };

  const submit = async () => {
    if (read === null || !('box' in read) || room === null) return;
    setBusy(true);
    setError(null);
    try {
      const label = name === '' ? categoryLabel(category) : name;
      const stored = await uploadAsset(store.projectId, new Blob([read.bytes as BlobPart]), file?.name ?? 'model.glb', 'model');
      const symbolBlob = symbol ?? new Blob([outlineSymbol(read.box, label)], { type: 'image/svg+xml' });
      const storedSymbol = await uploadAsset(store.projectId, symbolBlob, symbol?.name ?? `${baseName(file?.name ?? 'model') || 'model'}.svg`, 'symbol');
      const ok = await placeIn(store, room, { kind, category, name: label, box: read.box, clearances, model: stored, symbol: storedSymbol });
      if (ok) close();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      size="lg"
      className="fs-furn fs-furn--upload"
      onOpenChange={(o) => { if (!o) close(); }}
      title="Upload a model"
      description="A glTF 2.0 model (.glb, or .gltf with its buffers embedded) and, optionally, its plan symbol. Its box is read from the model; its category gives it default clearances."
      footer={
        <>
          <Button variant="ghost" icon={<ArrowLeft />} onClick={back}>Back to the library</Button>
          <Button variant="primary" icon={<Upload />} loading={busy} disabled={box === null || room === null || busy} onClick={() => void submit()}>
            {room === null ? 'Name a room first' : `Upload and place in ${labelOf(model, room)}`}
          </Button>
        </>
      }
    >
      <div className="fs-furn__body fs-furn__body--upload">
        <div className="fs-furn__form">
          <Row label="Model">
            <div className="fs-furn__file">
              <Button variant="secondary" size="sm" onClick={() => modelInput.current?.click()}>{file === null ? 'Choose a .glb or .gltf' : 'Choose another'}</Button>
              <span className="fs-mono-small">{file === null ? 'No model chosen' : `${file.name} · ${String(Math.round(file.bytes.length / 1024))} KB`}</span>
              <input
                ref={modelInput}
                type="file"
                accept={MODEL_ACCEPT}
                className="fs-file-input"
                aria-label="Model file"
                tabIndex={-1}
                onChange={(e) => {
                  choose(e.currentTarget.files?.[0]);
                  e.currentTarget.value = '';
                }}
              />
            </div>
          </Row>
          <Switch checked={facesZ} onCheckedChange={setFacesZ}>Model faces +Z — rotate it to face +X (Core 12.6)</Switch>
          <Row label="Plan symbol">
            <div className="fs-furn__file">
              <Button variant="secondary" size="sm" onClick={() => symbolInput.current?.click()}>{symbol === null ? 'Choose an SVG or PNG' : 'Choose another'}</Button>
              <span className="fs-mono-small">{symbol === null ? 'None: an outline of its footprint is drawn' : symbol.name}</span>
              <input
                ref={symbolInput}
                type="file"
                accept={SYMBOL_ACCEPT}
                className="fs-file-input"
                aria-label="Plan symbol file"
                tabIndex={-1}
                onChange={(e) => {
                  setSymbol(e.currentTarget.files?.[0] ?? null);
                  e.currentTarget.value = '';
                }}
              />
            </div>
          </Row>
          <TextField label="Name" value={name} placeholder={categoryLabel(category)} onCommit={setName} />
          <Row label="Kind">
            <Select
              aria-label="Kind"
              appearance="filled"
              options={KINDS.map((k) => ({ value: k.kind, label: k.singular }))}
              value={kind}
              onValueChange={(v) => {
                setKind(v as FurnitureKind);
                if (!CATEGORIES[v as FurnitureKind].includes(category)) setCategory('other');
              }}
            />
          </Row>
          <Row label="Category">
            <Select aria-label="Category" appearance="filled" options={CATEGORIES[kind].map((c) => ({ value: c, label: categoryLabel(c) }))} value={category} onValueChange={setCategory} />
          </Row>
          {level !== undefined && level.rooms.length > 0 ? (
            <Row label="Place in">
              <Select aria-label="Room to place in" appearance="filled" options={level.rooms.map((r) => ({ value: r.id, label: labelOf(model, r.id) }))} value={room ?? ''} onValueChange={(v) => { f.set({ room: v }); }} />
            </Row>
          ) : null}
          {read !== null && 'error' in read ? <p className="fs-furn__error" role="alert">{read.error}</p> : null}
          {error !== null ? <p className="fs-furn__error" role="alert">{error}</p> : null}
          <p className="fs-note">Stored by its SHA-256 in this project. A model must be one file; an SVG symbol is kept only as drawing — scripts, links and styles are removed.</p>
        </div>
        <section className="fs-furn__detail" aria-label="The model, as it will be placed">
          {box === null ? (
            <p className="fs-note">Choose a model to see its size and clearances.</p>
          ) : (
            <>
              <div className="fs-furn__stage">
                <ClearancePreview box={box} clearances={clearances} symbol={null} units={units} label={`Footprint and clearance envelopes of ${name === '' ? 'the model' : name}`} />
              </div>
              <dl className="fs-furn__facts">
                <div><dt>Size</dt><dd data-testid="upload-size">{sizeText(box, units)}</dd></div>
                <div><dt>Clearance</dt><dd>{Object.keys(clearances).length === 0 ? `none for ${categoryLabel(category).toLowerCase()}` : Object.entries(clearances).map(([n, e]) => `${n} (${e.purpose})`).join(', ')}</dd></div>
                <div><dt>Host</dt><dd>{hostText(category)}</dd></div>
              </dl>
            </>
          )}
        </section>
      </div>
    </Modal>
  );
}
