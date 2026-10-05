import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, StatusDot } from '@d3cloud/ui';
import { Download, FileBox, FileText, Layers, Ruler } from 'lucide-react';
import { DashCard } from '../dashboard/DashCard';
import { messageOf } from '../lib/api';
import { describeJob, listExports, requestExport, startDownload, untilFinished, type ExportJob, type ExportKind } from './api';
import './exports.css';

/**
 * Exports on the dashboard (FLR-T-9.3): the canonical model, and the drawings — a dimensioned PDF
 * (a sheet per level) and DXF drawings — made from the head version on the server's job queue,
 * with the latest few kept to download again; and the IFC4 Reference View model (FLR-T-9.4).
 * glTF and USDZ follow in FLR-P-9.
 */
export function ExportsCard({ projectId, hasModel }: { projectId: string; hasModel: boolean }) {
  const [jobs, setJobs] = useState<ExportJob[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState<ExportKind | null>(null);

  const upsert = useCallback((job: ExportJob) => {
    setJobs((list) => [job, ...list.filter((j) => j.id !== job.id)].slice(0, 4));
  }, []);

  useEffect(() => {
    if (!hasModel) return;
    let live = true;
    listExports(projectId)
      .then((list) => {
        if (!live) return;
        setJobs(list.slice(0, 4));
        // Anything still being drawn is followed until it finishes.
        for (const j of list) if (j.status === 'queued' || j.status === 'running') void untilFinished(projectId, j, (u) => { if (live) upsert(u); });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [projectId, hasModel, upsert]);

  async function ask(kind: ExportKind): Promise<void> {
    setAsking(kind);
    setError(null);
    try {
      const job = await requestExport(projectId, { kind });
      upsert(job);
      const done = await untilFinished(projectId, job, upsert);
      if (done.status === 'done') startDownload(done);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setAsking(null);
    }
  }

  return (
    <DashCard region="exports" icon={<FileBox aria-hidden="true" />} title="Exports">
      <ul className="fs-list">
        <li className="fs-export">
          <span>
            <span className="fs-mono">model.json</span> · the canonical model
          </span>
          {/* A navigation, not a fetch: the API answers Content-Disposition: attachment. */}
          <Button variant="secondary" size="sm" icon={<Download />} disabled={!hasModel} onClick={() => { window.location.assign(`/api/projects/${projectId}/model.json`); }}>
            Download
          </Button>
        </li>
        <li className="fs-export">
          <span>Dimensioned PDF · a sheet per level, marked not for construction</span>
          <Button variant="secondary" size="sm" icon={<FileText />} disabled={!hasModel || asking !== null} loading={asking === 'pdf'} onClick={() => void ask('pdf')}>
            PDF
          </Button>
        </li>
        <li className="fs-export">
          <span>DXF drawings · National CAD Standard layers</span>
          <Button variant="secondary" size="sm" icon={<Ruler />} disabled={!hasModel || asking !== null} loading={asking === 'dxf'} onClick={() => void ask('dxf')}>
            DXF
          </Button>
        </li>
        <li className="fs-export">
          <span>IFC4 Reference View · for your architect’s BIM tool</span>
          <Button variant="secondary" size="sm" icon={<Layers />} disabled={!hasModel || asking !== null} loading={asking === 'ifc'} onClick={() => void ask('ifc')}>
            IFC
          </Button>
        </li>
        <li className="fs-export">
          <span>Floorspec package, glTF, USDZ</span>
          <Badge tone="neutral" size="sm">
            Phase 9
          </Badge>
        </li>
      </ul>
      {error !== null ? (
        <p className="fs-exports-card__error">
          <StatusDot tone="danger">{error}</StatusDot>
        </p>
      ) : null}
      {jobs.length > 0 ? (
        <ul className="fs-exports-card__recent" aria-label="Recent exports">
          {jobs.map((j) => (
            <li key={j.id}>
              <StatusDot tone={j.status === 'failed' ? 'danger' : j.status === 'done' ? 'neutral' : 'idle'}>{describeJob(j)}</StatusDot>
              {j.status === 'done' ? (
                <Button variant="ghost" size="sm" icon={<Download />} onClick={() => { startDownload(j); }}>
                  Download
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </DashCard>
  );
}
