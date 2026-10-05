import { useRef, useState } from 'react';
import { Alert, Button, Modal, StatusDot } from '@d3cloud/ui';
import { FileUp, GitPullRequestArrow } from 'lucide-react';
import { messageOf } from '../lib/api';
import { navigate } from '../lib/router';
import { IFC_ACCEPT, importIfc, type ImportAnswer } from './ifcImport';
import { ImportReportList } from './ImportReport';
import './exports.css';

/**
 * "Import IFC changes" (FLR-T-9.5): bring back an IFC file exported from this project and edited in
 * another tool. What it maps lands as a proposed changeset — never in the plan until accepted — and
 * the dialog says what did not come across, then opens the changeset's review in the editor, where
 * the same report sits beside the proposal.
 */
export function IfcImportButton({ projectId, disabled = false }: { projectId: string; disabled?: boolean }) {
  const input = useRef<HTMLInputElement | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState<string | null>(null);
  const [answer, setAnswer] = useState<ImportAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function upload(f: File): Promise<void> {
    setOpen(true);
    setFile(f.name);
    setAnswer(null);
    setError(null);
    setBusy(true);
    try {
      setAnswer(await importIfc(projectId, f));
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  const edits = answer?.report.edits.length ?? 0;
  const left = answer?.report.entries.filter((e) => e.severity !== 'note').length ?? 0;
  const review = answer?.changeset ?? null;

  return (
    <>
      <Button variant="secondary" size="sm" icon={<FileUp />} disabled={disabled || busy} loading={busy} onClick={() => input.current?.click()}>
        Import IFC changes
      </Button>
      <input
        ref={input}
        type="file"
        accept={IFC_ACCEPT}
        hidden
        aria-label="An IFC file edited in another tool"
        onChange={(e) => {
          const f = e.currentTarget.files?.[0];
          e.currentTarget.value = '';
          if (f !== undefined) void upload(f);
        }}
      />
      <Modal
        open={open}
        onOpenChange={(o) => { if (!busy) setOpen(o); }}
        title="Import IFC changes"
        size="lg"
        description={file === null ? undefined : <>From <strong>{file}</strong>. Edits are matched to this project by the Floorspec ID each element was exported with, and proposed as a changeset: nothing is in the plan until you accept it.</>}
        footer={
          <>
            <Button variant="ghost" disabled={busy} onClick={() => { setOpen(false); }}>
              {review === null ? 'Close' : 'Later'}
            </Button>
            {review !== null ? (
              <Button variant="primary" icon={<GitPullRequestArrow />} autoFocus onClick={() => { navigate(`/projects/${projectId}/editor?review=${review.id}`); }}>
                Review the changes
              </Button>
            ) : null}
          </>
        }
      >
        <div className="fs-import">
          {busy ? <StatusDot tone="idle">Reading the file and matching it to the plan…</StatusDot> : null}
          {error !== null ? (
            <Alert tone="danger" dynamic>
              {error}
            </Alert>
          ) : null}
          {answer !== null ? (
            <>
              <Alert tone={review === null ? 'info' : left > 0 ? 'warning' : 'success'} title={review === null ? 'Nothing to import' : `${String(edits)} ${edits === 1 ? 'change' : 'changes'} proposed as “${review.name}”`}>
                {review === null
                  ? left === 0
                    ? 'The file matches the version it was exported from: an empty batch and an empty report.'
                    : 'None of the file’s edits could be brought across; the reasons are below.'
                  : left === 0
                    ? 'Every edit in the file came across.'
                    : `${String(left)} ${left === 1 ? 'edit' : 'edits'} could not be brought across; they are listed below, and beside the review.`}
              </Alert>
              {answer.report.edits.length > 0 ? (
                <section aria-label="Proposed">
                  <h3 className="fs-import__heading">Proposed · {String(answer.report.edits.length)}</h3>
                  <ul className="fs-import__edits">
                    {answer.report.edits.map((e, i) => (
                      <li key={`${e.element}-${String(i)}`}>{e.changes.join('; ')}</li>
                    ))}
                  </ul>
                </section>
              ) : null}
              {answer.report.entries.length > 0 ? (
                <section aria-label="Not imported">
                  <h3 className="fs-import__heading">Not brought across · {String(answer.report.entries.length)}</h3>
                  <ImportReportList report={answer.report} />
                </section>
              ) : null}
            </>
          ) : null}
        </div>
      </Modal>
    </>
  );
}
