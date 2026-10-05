import { type ChangeEvent, type DragEvent, useEffect, useRef, useState } from 'react';
import type { Diagnostic } from '@floorspec/engine';
import { Alert, Button, FormActions, Modal, Stack, StatusDot } from '@d3cloud/ui';
import { FileUp } from 'lucide-react';
import { PlanThumbnail } from '../components/PlanThumbnail';
import { describeModel, plural, summarize, type ModelSummary } from './model';
import { createFromDocument } from './fromDocument';
import { navigate } from '../lib/router';

/**
 * Import a `.floorspec.json` file. The file is read and validated here, in the browser, by the same
 * engine the server runs — nothing is uploaded to find out whether it is valid.
 *
 * Creating a project from a valid file lands it as Floorspec Ops (FLR-ADR-008): a blank project,
 * then the file's document as one batch (fromDocument.ts). Packages with assets, and IFC, are
 * FLR-T-9.1 (FLR-REQ-135).
 */

/** Large enough for any house; small enough that a wrong file does not stall the tab. */
export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;

type State =
  | { status: 'idle' }
  | { status: 'reading'; file: string }
  | { status: 'checked'; file: string; summary: ModelSummary }
  | { status: 'unreadable'; file: string; message: string };

export function ImportFile({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [state, setState] = useState<State>({ status: 'idle' });
  const [over, setOver] = useState(false);
  const [creating, setCreating] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) {
      setState({ status: 'idle' });
      setCreating({ busy: false, error: null });
    }
  }, [open]);

  const read = (file: File) => {
    if (file.size > MAX_IMPORT_BYTES) {
      setState({ status: 'unreadable', file: file.name, message: 'The file is larger than 10 MB, which no Floorspec house needs.' });
      return;
    }
    setState({ status: 'reading', file: file.name });
    file
      .text()
      .then((text) => { setState({ status: 'checked', file: file.name, summary: summarize(text) }); })
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
      description="A .floorspec.json document is checked in your browser by the Floorspec engine."
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
          <input ref={input} type="file" accept=".json,application/json" hidden onChange={onPick} />
        </div>

        {state.status === 'reading' ? <p className="fs-card-text">Checking {state.file}…</p> : null}
        {state.status === 'unreadable' ? (
          <Alert tone="danger" dynamic title={state.file}>
            {state.message}
          </Alert>
        ) : null}
        {state.status === 'checked' ? <Result file={state.file} summary={state.summary} /> : null}

        {creating.error !== null ? (
          <Alert tone="danger" dynamic>
            {creating.error}
          </Alert>
        ) : null}
        <p id="fs-import-later" className="fs-muted">
          The project is created from the file as Floorspec Ops, so the import is the first edit in its history.
        </p>
        <FormActions>
          <Button type="button" variant="secondary" onClick={() => { onOpenChange(false); }}>
            Close
          </Button>
          <Button
            type="button"
            variant="primary"
            aria-describedby="fs-import-later"
            disabled={state.status !== 'checked' || !state.summary.valid || state.summary.document === null}
            loading={creating.busy}
            onClick={() => {
              if (state.status !== 'checked' || state.summary.document === null) return;
              const name = (state.summary.name ?? state.file.replace(/\.floorspec\.json$|\.json$/, '')).slice(0, 200) || 'Imported house';
              setCreating({ busy: true, error: null });
              createFromDocument(name, state.summary.document as unknown as Record<string, unknown>)
                .then((outcome) => {
                  if (outcome.status === 'created') {
                    onOpenChange(false);
                    navigate(`/projects/${outcome.id}`);
                    return;
                  }
                  setCreating({ busy: false, error: outcome.status === 'rejected' ? `The server refused the file: ${outcome.diagnostics.map((d) => `${d.code} ${d.message}`).join('; ')}` : outcome.message });
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

function Result({ file, summary }: { file: string; summary: ModelSummary }) {
  if (summary.valid) {
    return (
      <Stack gap="12">
        <Alert tone="success" dynamic title={`${summary.name ?? file} is a valid Floorspec document`}>
          {describeModel(summary)}
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
      <Alert tone="danger" dynamic title={`${file} is not a valid Floorspec document`}>
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
