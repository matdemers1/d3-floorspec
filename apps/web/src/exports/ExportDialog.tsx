import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Modal, Select, StatusDot, useToast } from '@d3cloud/ui';
import { Box, Download, FileText, Layers, Ruler, BookOpen } from 'lucide-react';
import { messageOf } from '../lib/api';
import { describeJob, PAGES, requestExport, startDownload, untilFinished, type ExportJob, type PageName } from './api';
import './exports.css';

/**
 * The Export dialog (Figma: Floorspec (FLR), P9 · Handoff & sharing, 16 · Export): every format in
 * one list, the one chosen outlined. What works today: the canonical model, the dimensioned PDF
 * (a sheet per level, a 3D view, marked not for construction) and DXF drawings on National CAD
 * Standard layers. glTF, USDZ and IFC are listed with the task that builds them.
 */

type Choice = 'model' | 'pdf' | 'dxf';

interface Format {
  readonly id: Choice | 'gltf' | 'usdz' | 'ifc';
  readonly icon: ReactNode;
  readonly title: string;
  readonly detail: string;
  readonly ext: string;
  readonly later?: string;
}

const FORMATS: readonly Format[] = [
  { id: 'model', icon: <BookOpen />, title: 'Floorspec model', detail: 'model.json — the canonical bytes of this version; always free, always valid', ext: '.json' },
  { id: 'gltf', icon: <Box />, title: 'glTF 2.0', detail: '+Y up, metres, PBR materials · for Blender, three.js, AR', ext: '.glb', later: 'Arrives with FLR-T-9.2' },
  { id: 'usdz', icon: <Box />, title: 'USDZ', detail: 'View at 1:1 in AR Quick Look on iPad', ext: '.usdz', later: 'Arrives with FLR-T-9.2' },
  { id: 'pdf', icon: <FileText />, title: 'Dimensioned PDF', detail: 'Sheet per level + 3D view · marked “not for construction”', ext: '.pdf' },
  { id: 'dxf', icon: <Ruler />, title: 'DXF', detail: 'US National CAD Standard layers (A-WALL, A-DOOR, E-POWR…) · millimetres', ext: '.dxf' },
  { id: 'ifc', icon: <Layers />, title: 'IFC4 Reference View', detail: 'For your architect’s BIM tool · Floorspec IDs in a property set', ext: '.ifc', later: 'Arrives with FLR-T-9.4' },
];

export interface ExportDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly projectId: string;
  readonly projectName: string;
  /** e.g. `v42` — what the head is called. */
  readonly versionLabel: string | null;
  /** The model's levels, lowest first. */
  readonly levels: readonly { id: string; name: string }[];
  /** Where the dialog starts. */
  readonly initial?: Choice;
}

export function ExportDialog({ open, onOpenChange, projectId, projectName, versionLabel, levels, initial = 'pdf' }: ExportDialogProps) {
  const toast = useToast();
  const [choice, setChoice] = useState<Choice>(initial);
  const [page, setPage] = useState<PageName>('tabloid');
  const [level, setLevel] = useState<string>('all');
  const [job, setJob] = useState<ExportJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!open) {
      abort.current?.abort();
      setJob(null);
      setError(null);
      setBusy(false);
    } else setChoice(initial);
  }, [open, initial]);

  const chosenLevels = level === 'all' ? null : [level];
  const subtitle = [versionLabel, chosenLevels === null ? levels.map((l) => l.name).join(' + ') : levels.find((l) => l.id === level)?.name].filter((x) => x !== null && x !== undefined && x !== '').join(' · ');

  async function run(): Promise<void> {
    if (choice === 'model') {
      window.location.assign(`/api/projects/${projectId}/model.json`);
      onOpenChange(false);
      return;
    }
    setBusy(true);
    setError(null);
    abort.current = new AbortController();
    try {
      const queued = await requestExport(projectId, { kind: choice, ...(chosenLevels === null ? {} : { levels: chosenLevels }), ...(choice === 'pdf' ? { page } : {}) });
      setJob(queued);
      const finished = await untilFinished(projectId, queued, setJob, abort.current.signal);
      if (finished.status === 'done') {
        startDownload(finished);
        toast.show({ message: `Exported ${finished.result?.name ?? 'the drawings'}` });
        onOpenChange(false);
      } else if (finished.status === 'failed') setError(describeJob(finished));
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  const status: ReactNode =
    error !== null ? (
      <StatusDot tone="danger">{error}</StatusDot>
    ) : job !== null ? (
      <StatusDot tone="neutral">{describeJob(job)}</StatusDot>
    ) : choice === 'pdf' || choice === 'dxf' ? (
      <span className="fs-export-dialog__note">Drawn from this version by the worker; the same version always gives the same file.</span>
    ) : (
      <span className="fs-export-dialog__note">The canonical model: what every other format is made from.</span>
    );

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      className="fs-export-dialog"
      title={`Export ${projectName}`}
      description={subtitle === '' ? undefined : subtitle}
      footer={
        <>
          <span className="fs-export-dialog__status" aria-live="polite">
            {status}
          </span>
          <Button variant="secondary" onClick={() => { onOpenChange(false); }}>
            Cancel
          </Button>
          <Button variant="primary" icon={<Download />} loading={busy} onClick={() => void run()}>
            Export
          </Button>
        </>
      }
    >
      <div role="radiogroup" aria-label="Format" className="fs-export-dialog__formats">
        {FORMATS.map((f) => {
          const available = f.later === undefined;
          const selected = f.id === choice;
          return (
            <button
              key={f.id}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-disabled={!available}
              disabled={!available || busy}
              className="fs-export-format"
              data-selected={selected ? 'true' : undefined}
              onClick={() => { if (available) setChoice(f.id as Choice); }}
            >
              <span className="fs-export-format__icon" aria-hidden="true">{f.icon}</span>
              <span className="fs-export-format__text">
                <span className="fs-export-format__title">{f.title}</span>
                <span className="fs-export-format__detail">{available ? f.detail : `${f.detail} · ${f.later ?? ''}`}</span>
              </span>
              <span className="fs-export-format__ext">{f.ext}</span>
            </button>
          );
        })}
      </div>
      {choice === 'pdf' || choice === 'dxf' ? (
        <div className="fs-export-dialog__options">
          {levels.length > 1 ? (
            <label className="fs-export-dialog__option">
              <span>Levels</span>
              <Select
                aria-label="Levels"
                size="sm"
                value={level}
                disabled={busy}
                onValueChange={setLevel}
                options={[{ value: 'all', label: choice === 'pdf' ? 'Every level, a sheet each' : 'Every level, a file each (ZIP)' }, ...levels.map((l) => ({ value: l.id, label: l.name }))]}
              />
            </label>
          ) : null}
          {choice === 'pdf' ? (
            <label className="fs-export-dialog__option">
              <span>Paper</span>
              <Select aria-label="Paper" size="sm" value={page} disabled={busy} onValueChange={(v) => { setPage(v as PageName); }} options={PAGES} />
            </label>
          ) : null}
        </div>
      ) : null}
    </Modal>
  );
}
