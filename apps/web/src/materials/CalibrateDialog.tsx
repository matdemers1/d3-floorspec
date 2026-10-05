import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button, Modal, Select } from '@d3cloud/ui';
import { Check, MoveHorizontal } from 'lucide-react';
import type { EditorModel } from '../editor/model';
import type { BatchBuilder } from '../editor/ops';
import { IntField, LengthField, TextField } from '../editor/fields';
import { formatLen, type UnitSystem } from '../editor/units';
import {
  averageColour,
  defaultTarget,
  imageSize,
  nameFromFile,
  scaleText,
  sizeText,
  spanPixels,
  targetChoices,
  textureBatch,
  wholeWidth,
  type Span,
  type UploadedAsset,
} from './calibrate';
import './materials.css';

/**
 * "Calibrate texture" (Figma FLR board, frame 13b; FLR-T-8.2, FLR-REQ-117): the photo, a span across
 * it — the whole width until one is dragged — and how long that span is in the real world. From
 * those, the size of one tile of the image (Core 18.2 `size`), a preview of the tiling at that
 * size, and where to put it. Saving is one Ops batch: the image's asset entry, the material, and
 * the finish — one undo step.
 */

/** The width, in the real world, the swatch preview shows: 4 ft, or 1.2 m. */
const PREVIEW = { imperial: 4 * 390_144, metric: 1_200 * 1280 } as const;

export interface CalibrateProps {
  asset: UploadedAsset;
  model: EditorModel;
  units: UnitSystem;
  selection: string | null;
  /** Re-size this material's texture rather than make a new material. */
  material?: string;
  onClose: () => void;
  apply: (label: string, batch: BatchBuilder) => Promise<boolean>;
}

/** The image's average colour, read through a small canvas: the material's colour where the map is not drawn. */
function readAverage(img: HTMLImageElement): string | null {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 16;
    canvas.height = 16;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (ctx === null) return null;
    ctx.drawImage(img, 0, 0, 16, 16);
    return averageColour(ctx.getImageData(0, 0, 16, 16).data);
  } catch {
    return null;
  }
}

export function CalibrateTexture({ asset, model, units, selection, material, onClose, apply }: CalibrateProps) {
  const existing = material === undefined ? undefined : ((model.document.materials ?? {})[material] as Record<string, unknown> | undefined);
  const existingSize = (existing?.['texture'] as { size?: [number, number] } | undefined)?.size;
  const [dims, setDims] = useState<{ width: number; height: number }>({ width: asset.width, height: asset.height });
  const [span, setSpan] = useState<Span | null>(null);
  const [length, setLength] = useState<number | null>(existingSize?.[0] ?? null);
  const [name, setName] = useState(typeof existing?.['name'] === 'string' ? existing['name'] : nameFromFile(asset.name));
  const [roughness, setRoughness] = useState<number | null>(null);
  const [colour, setColour] = useState<string | null>(null);
  const [broken, setBroken] = useState(false);
  const [busy, setBusy] = useState(false);
  const choices = useMemo(() => targetChoices(model, selection, units), [model, selection, units]);
  const [target, setTarget] = useState(() => defaultTarget(choices, selection));
  const imgRef = useRef<HTMLImageElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const dragging = useRef(false);
  const hintId = useId();

  const shown = span ?? (dims.width > 0 ? wholeWidth(dims.width, dims.height) : null);
  const pixels = shown === null ? 0 : spanPixels(shown);
  const size = length === null ? null : imageSize(dims.width, dims.height, pixels, length);
  const choice = choices.find((c) => c.value === target) ?? choices[0] ?? { value: 'none', label: '', target: { kind: 'none' as const } };
  const ktx2 = asset.mediaType === 'image/ktx2';

  useEffect(() => {
    const img = imgRef.current;
    if (img?.complete === true && img.naturalWidth > 0) {
      setDims({ width: img.naturalWidth, height: img.naturalHeight });
      setColour(readAverage(img));
    }
  }, []);

  /** A pointer position as image pixels, through the overlay's own transform. */
  const toImage = (e: React.PointerEvent<SVGSVGElement>): [number, number] | null => {
    const svg = svgRef.current;
    const m = svg?.getScreenCTM();
    if (svg === null || m === null || m === undefined) return null;
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return [Math.min(dims.width, Math.max(0, p.x)), Math.min(dims.height, Math.max(0, p.y))];
  };

  const save = () => {
    if (size === null) return;
    setBusy(true);
    const verb = choice.target.kind === 'none' ? (material === undefined ? 'Add the texture' : 'Calibrate') : 'Apply the texture';
    void apply(`${verb} ${name}`, textureBatch(model, { asset, ...(material === undefined ? {} : { material }), name: name === '' ? nameFromFile(asset.name) : name, color: colour, size, roughness, target: choice.target })).then((ok) => {
      setBusy(false);
      if (ok) onClose();
    });
  };

  const tileW = size?.[0] ?? 0;
  const tileH = size?.[1] ?? 0;
  const label = length === null ? null : formatLen(length, units);

  return (
    <Modal
      open
      size="lg"
      className="fs-calibrate-modal"
      onOpenChange={(o) => { if (!o) onClose(); }}
      title="Calibrate texture"
      description={
        <span className="fs-calibrate__file">
          {asset.name ?? asset.path.split('/').at(-1)} · {String(dims.width)} × {String(dims.height)} · sha256 {asset.sha256.slice(0, 4)}…{asset.sha256.slice(-4)}
        </span>
      }
      footer={
        <div className="fs-calibrate__footer">
          <p className="fs-note">Saving adds the image, the material{choice.target.kind === 'none' ? '' : ' and the finish'} as one change — undoable.</p>
          <span className="fs-spacer" />
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={<Check />} disabled={size === null || busy} onClick={save}>
            {choice.target.kind === 'none' ? 'Save' : 'Save & apply'}
          </Button>
        </div>
      }
    >
      <div className="fs-calibrate">
        <div className="fs-calibrate__photo">
          {broken || ktx2 ? (
            <p className="fs-note fs-calibrate__nopreview">
              {ktx2 ? 'A KTX2 texture is not shown here.' : 'This image could not be shown.'} The span is its whole width, {String(dims.width)} px.
            </p>
          ) : (
            <div className="fs-calibrate__frame">
              <img
                ref={imgRef}
                src={asset.href}
                alt={`The uploaded image, ${asset.name ?? 'texture'}`}
                className="fs-calibrate__img"
                draggable={false}
                onLoad={(e) => {
                  const img = e.currentTarget;
                  setDims({ width: img.naturalWidth, height: img.naturalHeight });
                  setColour(readAverage(img));
                }}
                onError={() => { setBroken(true); }}
              />
              {dims.width > 0 && shown !== null ? (
                <svg
                  ref={svgRef}
                  className="fs-calibrate__overlay"
                  viewBox={`0 0 ${String(dims.width)} ${String(dims.height)}`}
                  preserveAspectRatio="xMidYMid meet"
                  role="img"
                  aria-label={`Measured span: ${String(Math.round(pixels))} px${label === null ? '' : `, ${label}`}`}
                  data-testid="calibrate-span"
                  onPointerDown={(e) => {
                    const p = toImage(e);
                    if (p === null) return;
                    dragging.current = true;
                    e.currentTarget.setPointerCapture(e.pointerId);
                    setSpan({ a: p, b: p });
                  }}
                  onPointerMove={(e) => {
                    if (!dragging.current) return;
                    const p = toImage(e);
                    if (p !== null) setSpan((s) => (s === null ? s : { a: s.a, b: p }));
                  }}
                  onPointerUp={() => {
                    dragging.current = false;
                    // A click, not a drag: nothing was measured, so the whole width stands.
                    setSpan((s) => (s !== null && spanPixels(s) < 4 ? null : s));
                  }}
                >
                  <line x1={shown.a[0]} y1={shown.a[1]} x2={shown.b[0]} y2={shown.b[1]} className="fs-calibrate__line" vectorEffect="non-scaling-stroke" />
                  {[shown.a, shown.b].map((p, i) => (
                    <circle key={i} cx={p[0]} cy={p[1]} r={dims.width / 120} className="fs-calibrate__end" vectorEffect="non-scaling-stroke" />
                  ))}
                </svg>
              ) : null}
              {label !== null && shown !== null ? (
                <span
                  className="fs-calibrate__chip"
                  style={{ left: `${String((((shown.a[0] + shown.b[0]) / 2) / Math.max(1, dims.width)) * 100)}%`, top: `${String((Math.min(shown.a[1], shown.b[1]) / Math.max(1, dims.height)) * 100)}%` }}
                  aria-hidden="true"
                >
                  {label}
                </span>
              ) : null}
            </div>
          )}
        </div>
        <div className="fs-calibrate__side">
          <p className="fs-calibrate__hint" id={hintId}>
            Drag across one tile, then say how long that is. Until you drag, the span is the photo&rsquo;s whole width.
          </p>
          <LengthField label="This span is" value={length ?? undefined} units={units} positive placeholder={units === 'metric' ? '300 mm' : '12"'} autoFocus onCommit={(v) => { setLength(v); }} />
          {span !== null ? (
            <Button size="sm" variant="ghost" icon={<MoveHorizontal />} onClick={() => { setSpan(null); }}>
              Measure the whole width
            </Button>
          ) : null}
          <dl className="fs-calibrate__facts" aria-describedby={hintId}>
            <div>
              <dt>Repeat</dt>
              <dd data-testid="calibrate-repeat">{size === null ? '—' : `${sizeText(size, units)} (1 tile)`}</dd>
            </div>
            <div>
              <dt>Scale</dt>
              <dd>{size === null ? '—' : scaleText(size, dims.width, units)}</dd>
            </div>
            <div>
              <dt>Stored as</dt>
              <dd className="fs-mono-small" data-testid="calibrate-stored">{size === null ? '—' : `size ${size[0].toLocaleString('en-US')} × ${size[1].toLocaleString('en-US')} units`}</dd>
            </div>
          </dl>
          <TextField label="Material" value={name} maxLength={120} onCommit={setName} />
          <h3 className="fs-overline">Maps</h3>
          <ul className="fs-calibrate__maps" aria-label="Maps">
            <li><span>Base colour</span><span>{asset.name ?? asset.path.split('/').at(-1)}</span></li>
            <li><span>Normal</span><span>none · flat</span></li>
          </ul>
          <IntField label="Roughness" unit="‰" value={roughness ?? undefined} min={0} max={1000} allowEmpty placeholder="1000 (matte)" onCommit={setRoughness} />
          <div className="fs-calibrate__preview">
            <span
              className="fs-calibrate__swatch"
              role="img"
              aria-label={size === null ? 'Tiling preview: type a length first' : `Tiling preview: ${formatLen(PREVIEW[units], units)} of surface at ${sizeText(size, units)} a tile`}
              style={
                size === null || ktx2 || broken
                  ? undefined
                  : {
                      backgroundImage: `url("${asset.href}")`,
                      backgroundSize: `${String((tileW / PREVIEW[units]) * 100)}% auto`,
                      ...(colour === null ? {} : { backgroundColor: colour }),
                    }
              }
              data-testid="calibrate-preview"
              data-tile-height={tileH}
            />
            <span className="fs-note">{formatLen(PREVIEW[units], units)} of surface at this size</span>
          </div>
          <h3 className="fs-overline">Apply to</h3>
          <Select aria-label="Apply to" appearance="filled" options={choices.map((c) => ({ value: c.value, label: c.label }))} value={choice.value} onValueChange={setTarget} />
        </div>
      </div>
    </Modal>
  );
}
