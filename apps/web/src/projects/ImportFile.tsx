import { type ChangeEvent, type DragEvent, useEffect, useRef, useState } from 'react';
import type { Diagnostic } from '@floorspec/engine';
import { Alert, Button, FormActions, Modal, Stack, StatusDot } from '@d3cloud/ui';
import { FileUp } from 'lucide-react';
import { PlanThumbnail } from '../components/PlanThumbnail';
import { describeModel, plural, type ModelSummary } from './model';
import { importToServer, MAX_DOCUMENT_BYTES, readImportFile, type ReadImport } from './importPackage';
import { navigate } from '../lib/router';

/**
 * Import a `.floorspec.json` document or a `.floorspec` package (FLR-T-9.1, FLR-REQ-135) of Core
 * 0.1, 0.2 or 0.3. The file is read and validated here, in the browser, by the same engine and
 * package reader the server runs — nothing is uploaded to find out whether it is valid
 * (importPackage.ts).
 *
 * Creating the project sends the file to the server, which checks it again, stores a package's
 * files in the asset store and lands the document as Floorspec Ops (FLR-ADR-008): a blank project,
 * then the document as one batch. A file with errors is refused, with them shown; warnings and
 * notes are kept.
 */

/** Large enough for any house; small enough that a wrong file does not stall the tab. */
export const MAX_IMPORT_BYTES = MAX_DOCUMENT_BYTES;

type State =
  | { status: 'idle' }
  | { status: 'reading'; file: string }
  | { status: 'checked'; file: string; read: ReadImport }
  | { status: 'unreadable'; file: string; message: string };

export function ImportFile({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [state, setState] = useState<State>({ status: 'idle' });
  const [over, setOver] = useState(false);
  const [creating, setCreating] = useState<{ busy: boolean; error: string | null; diagnostics?: readonly Diagnostic[] }>({ busy: false, error: null });
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) {
      setState({ status: 'idle' });
      setCreating({ busy: false, error: null });
    }
  }, [open]);

  const read = (file: File) => {
    setState({ status: 'reading', file: file.name });
    setCreating({ busy: false, error: null });
    readImportFile(file)
      .then((outcome) => {
        setState(outcome.status === 'read' ? { status: 'checked', file: file.name, read: outcome.read } : { status: 'unreadable', file: file.name, message: outcome.message });
      })
      .catch(() => { setState({ status: 'unreadable', file: file.name, message: 'The file could not be read.' }); });
  };

  const onPick = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file !== undefined) read(file);
    event.target.value = '';
  };
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setOver(false);
    const file = event.dataTransfer.files[0];
    if (file !== undefined) read(file);
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Import a Floorspec file"
      description="A .floorspec.json document or a .floorspec package is checked in your browser by the Floorspec engine."
      size="md"
      className="fs-dialog"
    >
      <Stack gap="16">
        <div
          className="fs-import-drop"
          data-over={over}
          onDragOver={(event) => { event.preventDefault(); setOver(true); }}
          onDragLeave={() => { setOver(false); }}
          onDrop={onDrop}
        >
          <FileUp aria-hidden="true" />
          <span>Drop a file here, or</span>
          <Button variant="secondary" size="sm" onClick={() => input.current?.click()}>
            Choose a file
          </Button>
          <input ref={input} type="file" accept=".json,.floorspec,application/json,application/zip" hidden onChange={onPick} />
        </div>

        {state.status === 'reading' ? <p className="fs-card-text">Checking {state.file}…</p> : null}
        {state.status === 'unreadable' ? (
          <Alert tone="danger" dynamic title={state.file}>
            {state.message}
          </Alert>
        ) : null}
        {state.status === 'checked' ? <Result file={state.file} read={state.read} /> : null}

        {creating.error !== null ? (
          <Stack gap="12">
            <Alert tone="danger" dynamic>
              {creating.error}
            </Alert>
            {creating.diagnostics !== undefined && creating.diagnostics.length > 0 ? <Diagnostics diagnostics={creating.diagnostics} /> : null}
          </Stack>
        ) : null}
        <p id="fs-import-later" className="fs-muted">
          The project is created from the file as Floorspec Ops, so the import is the first edit in its history. A package’s textures come with it.
        </p>
        <FormActions>
          <Button type="button" variant="secondary" onClick={() => { onOpenChange(false); }}>
            Close
          </Button>
          <Button
            type="button"
            variant="primary"
            aria-describedby="fs-import-later"
            disabled={state.status !== 'checked' || !state.read.summary.valid || state.read.summary.document === null}
            loading={creating.busy}
            onClick={() => {
              if (state.status !== 'checked' || state.read.summary.document === null) return;
              const name = (state.read.summary.name ?? state.file.replace(/\.floorspec\.json$|\.floorspec$|\.json$/, '')).slice(0, 200) || 'Imported house';
              setCreating({ busy: true, error: null });
              importToServer(state.read.bytes, name)
                .then((outcome) => {
                  if (outcome.status === 'created') {
                    onOpenChange(false);
                    navigate(`/projects/${outcome.answer.id}`);
                    return;
                  }
                  setCreating({ busy: false, error: outcome.status === 'rejected' ? `The server refused the file. ${outcome.message}` : outcome.message, ...(outcome.status === 'rejected' ? { diagnostics: outcome.diagnostics } : {}) });
                })
                .catch(() => { setCreating({ busy: false, error: 'The project could not be created. Try again.' }); });
            }}
          >
            Create project
          </Button>
        </FormActions>
      </Stack>
    </Modal>
  );
}

/** "1 asset file" — what a package brings besides its model. */
function packageLine(read: ReadImport): string {
  const parts = [plural(read.files, 'asset file')];
  if (read.ignored.length > 0) parts.push(`${plural(read.ignored.length, 'other file')} left out`);
  return parts.join(' · ');
}

function Result({ file, read }: { file: string; read: ReadImport }) {
  const summary: ModelSummary = read.summary;
  const what = read.kind === 'package' ? 'package' : 'document';
  if (summary.valid) {
    return (
      <Stack gap="12">
        <Alert tone="success" dynamic title={`${summary.name ?? file} is a valid Floorspec ${what}`}>
          {describeModel(summary)}
          {read.kind === 'package' ? ` · ${packageLine(read)}` : ''}
          {summary.diagnostics.length > 0 ? ` · ${plural(summary.diagnostics.length, 'note')}` : ''}
        </Alert>
        {summary.document !== null && summary.derived !== null && !summary.empty ? (
          <div className="fs-plan-well fs-import-preview">
            <PlanThumbnail document={summary.document} derived={summary.derived} title={`Plan of ${summary.name ?? file}`} />
          </div>
        ) : null}
        {summary.diagnostics.length > 0 ? <Diagnostics diagnostics={summary.diagnostics} /> : null}
      </Stack>
    );
  }
  const errors = summary.diagnostics.filter((d) => d.severity === 'error').length;
  return (
    <Stack gap="12">
      <Alert tone="danger" dynamic title={`${file} is not a valid Floorspec ${what}`}>
        The engine found {plural(errors, 'error')}. Fix them and choose the file again.
      </Alert>
      <Diagnostics diagnostics={summary.diagnostics} />
    </Stack>
  );
}

const TONE = { error: 'danger', warning: 'warning', info: 'neutral' } as const;
const SHOWN = 50;

export function Diagnostics({ diagnostics }: { diagnostics: readonly Diagnostic[] }) {
  return (
    <ul className="fs-diagnostics" aria-label="Diagnostics">
      {diagnostics.slice(0, SHOWN).map((d, i) => (
        <li key={`${d.code}-${String(i)}`}>
          <StatusDot tone={TONE[d.severity]}>{d.message}</StatusDot>
          <span className="fs-caption fs-mono">
            {d.code}
            {d.location.pointer === undefined || d.location.pointer === '' ? '' : ` · ${d.location.pointer}`}
          </span>
        </li>
      ))}
      {diagnostics.length > SHOWN ? <li className="fs-caption">…and {String(diagnostics.length - SHOWN)} more</li> : null}
    </ul>
  );
}
