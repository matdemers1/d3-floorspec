import { Badge } from '@d3cloud/ui';
import type { ImportReport, ImportReportEntry } from './ifcImport';
import './exports.css';

const TONE = { unmapped: 'warning', ambiguous: 'attention', rejected: 'danger', note: 'neutral' } as const;
const LABEL = { unmapped: 'Not imported', ambiguous: 'Ambiguous', rejected: 'Refused', note: 'Note' } as const;

/**
 * What an IFC import did not bring across (FLR-T-9.5): each entry's change, why, and the IFC
 * GlobalId to find it by in the other tool. Shown in the import dialog and beside the changeset's
 * review in the editor.
 */
export function ImportReportList({ report, onSelect }: { report: ImportReport; onSelect?: (element: string) => void }) {
  const entries = [...report.entries].sort((a, b) => order(a) - order(b));
  if (entries.length === 0) return <p className="fs-import-report__empty">Everything the file changed came across.</p>;
  return (
    <ul className="fs-import-report" aria-label="Not imported">
      {entries.map((e, i) => (
        <li key={`${e.globalId ?? ''}-${String(i)}`} className="fs-import-report__entry">
          <div className="fs-import-report__head">
            <Badge tone={TONE[e.severity]} size="sm">
              {LABEL[e.severity]}
            </Badge>
            {e.element !== null && onSelect !== undefined && e.severity !== 'note' ? (
              <button type="button" className="fs-linkish" onClick={() => { onSelect(e.element as string); }}>
                {e.element}
              </button>
            ) : e.element !== null ? (
              <span className="fs-import-report__id">{e.element}</span>
            ) : null}
            {e.entity !== null ? <span className="fs-import-report__entity">{e.entity}</span> : null}
          </div>
          <p className="fs-import-report__change">{e.change}</p>
          <p className="fs-import-report__reason">{e.reason}</p>
          {e.globalId !== null ? <p className="fs-import-report__id">GlobalId {e.globalId}</p> : null}
        </li>
      ))}
    </ul>
  );
}

function order(e: ImportReportEntry): number {
  return { rejected: 0, ambiguous: 1, unmapped: 2, note: 3 }[e.severity];
}
