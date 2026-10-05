import './findings.css';
import { useMemo } from 'react';
import { useEditor, type EditorStore, type Viewport } from '../editor/store';
import type { LevelView } from '../editor/model';
import { toScreen } from '../editor/viewport';
import { overlayOf, type FindingOverlay, type Pt } from './geometry';
import { findingKey, shortReason } from './model';
import { useFindings } from './source';
import type { Finding, Severity } from './types';

/**
 * Findings drawn on the plan (FLR-T-6.9, FLR-REQ-102): the editor's "Findings" layer. Each finding
 * of main on the level shown draws its location (Rules 9.4) in its severity's tone — a room
 * outlined, a clearance zone hatched, an opening or an element in the way struck through — and a
 * receptacle-spacing finding draws the parts of the wall line beyond the rule's reach. Each carries
 * a numbered label with what was measured against what was needed; the finding in focus is drawn
 * strongest. Shown only while the canvas shows main at the version the findings were evaluated on:
 * a proposal or a comparison is not what they describe.
 */

const S = (v: Viewport, p: Pt) => toScreen(v, p);
const pts = (v: Viewport, ring: readonly Pt[]) => ring.map((p) => S(v, p).map((n) => n.toFixed(1)).join(',')).join(' ');
const pathOf = (v: Viewport, rings: readonly (readonly Pt[])[]) => rings.map((r) => `M${pts(v, r)}Z`).join('');

interface Drawn {
  finding: Finding;
  overlay: FindingOverlay;
  index: number;
}

/** The findings to draw on this level, if the canvas shows what they were evaluated on. */
function useDrawn(store: EditorStore, level: LevelView): { drawn: Drawn[]; focus: string | null } {
  const [state] = useFindings(store.projectId);
  const on = useEditor(store, (s) => s.layers.findings && s.compare === null && !(s.side === 'review' && s.review !== null));
  const hash = useEditor(store, (s) => s.model?.hash ?? null);
  const report = state.report;
  const drawn = useMemo(() => {
    if (report === null || !on || report.hash !== hash) return [];
    return report.findings
      .map((finding, i) => ({ finding, index: i + 1 }))
      .filter(({ finding }) => finding.location.level === level.id && (state.show === 'all' || finding.severity === state.show))
      .map(({ finding, index }) => ({ finding, index, overlay: overlayOf(finding, level) }));
  }, [report, on, hash, level, state.show]);
  return { drawn, focus: state.focus };
}

function Hatch({ severity }: { severity: Severity }) {
  return (
    <pattern id={`fs-rf-hatch-${severity}`} patternUnits="userSpaceOnUse" width="8" height="8" patternTransform="rotate(45)">
      <line className={`fs-rf__hatch fs-rf__hatch--${severity}`} x1="0" y1="0" x2="0" y2="8" />
    </pattern>
  );
}

/** The SVG half: shapes, zones and spacing runs. */
export function RuleFindingsLayer({ store, view, level }: { store: EditorStore; view: Viewport; level: LevelView }) {
  const { drawn, focus } = useDrawn(store, level);
  if (drawn.length === 0) return null;
  // The one in focus last, so it is drawn on top.
  const ordered = [...drawn].sort((a, b) => Number(a.overlay.key === focus) - Number(b.overlay.key === focus));
  return (
    <g className="fs-rule-findings" aria-hidden="true">
      <defs>
        <Hatch severity="mayNotMeet" />
        <Hatch severity="check" />
        <Hatch severity="note" />
      </defs>
      {ordered.map(({ overlay }) => (
        <g key={overlay.key} className={focus !== null && focus !== overlay.key ? 'fs-rf is-dim' : 'fs-rf'} data-severity={overlay.severity} data-finding={overlay.key}>
          {overlay.shapes.map((s, i) => {
            if (s.line !== undefined) {
              const a = S(view, s.line[0] as Pt);
              const b = S(view, s.line[s.line.length - 1] as Pt);
              return <line key={i} className={s.kind === 'opening' ? 'fs-rf__opening' : 'fs-rf__involved-line'} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} />;
            }
            const d = pathOf(view, s.rings ?? []);
            if (s.kind === 'zone') return <path key={i} className="fs-rf__zone" data-kind="zone" d={d} fillRule="evenodd" style={{ fill: `url(#fs-rf-hatch-${overlay.severity})` }} />;
            return <path key={i} className={s.kind === 'room' ? 'fs-rf__room' : s.kind === 'involved' ? 'fs-rf__involved' : 'fs-rf__element'} data-kind={s.kind} d={d} fillRule="evenodd" />;
          })}
          {overlay.spacing.map((run, i) => (
            <polyline key={`s${String(i)}`} className="fs-rf__spacing" data-kind="spacing" points={pts(view, run.line)} />
          ))}
        </g>
      ))}
    </g>
  );
}

/** The HTML half: a numbered label per finding, which focuses it and opens the findings panel. */
export function RuleFindingLabels({ store, view, level }: { store: EditorStore; view: Viewport; level: LevelView }) {
  const { drawn, focus } = useDrawn(store, level);
  const [, source] = useFindings(store.projectId);
  if (drawn.length === 0) return null;
  // Findings about one subject share its centre: their labels stack below one another.
  const stacked = new Map<string, number>();
  return (
    <div className="fs-rf-labels">
      {drawn.map(({ finding, overlay, index }) => {
        if (overlay.anchor === null) return null;
        const centre = S(view, overlay.anchor);
        const spot = `${String(Math.round(centre[0] / 8))},${String(Math.round(centre[1] / 8))}`;
        const k = stacked.get(spot) ?? 0;
        stacked.set(spot, k + 1);
        const at: Pt = [centre[0], centre[1] + 22 + k * 26];
        if (at[0] < 0 || at[1] < 0 || at[0] > view.w || at[1] > view.h) return null;
        const key = findingKey(finding);
        return (
          <button
            key={key}
            type="button"
            className={focus === key ? 'fs-rf-label is-focused' : 'fs-rf-label'}
            data-severity={finding.severity}
            style={{ left: at[0], top: at[1] }}
            title={finding.message}
            onClick={() => {
              source.set({ focus: key });
              store.set({ findingsOpen: true });
            }}
          >
            {index} · {finding.subject.id} · {shortReason(finding)}
          </button>
        );
      })}
    </div>
  );
}
