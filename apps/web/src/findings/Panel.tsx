import './findings.css';
import { useEffect, useMemo } from 'react';
import { Button, EmptyState, IconButton, Link, SegmentedControl, Spinner } from '@d3cloud/ui';
import { ClipboardList, Crosshair, X } from 'lucide-react';
import { useEditor, type EditorStore } from '../editor/store';
import { fit } from '../editor/viewport';
import { boundsOfOverlay, overlayOf } from './geometry';
import { counts, findingKey, SEVERITIES, stateOf } from './model';
import { FindingCard, FindingsNotice } from './parts';
import { labelIn } from './rooms';
import { useFindings, type FindingsSource } from './source';
import type { Finding } from './types';

/**
 * The editor's findings panel (FLR-T-6.9; the board's "11 · Findings — drawn on the plan"): main's
 * findings under the project's profile, filtered by severity, each a card with its citation and
 * edition, measured against needed, and its elements; "Zoom to it" frames it on the plan, where the
 * Findings layer draws it. The notice and the coverage link close the panel (FLR-REQ-105, 096).
 */
export function FindingsPanel({ store }: { store: EditorStore }) {
  const [state, source] = useFindings(store.projectId);
  const model = useEditor(store, (s) => s.model);
  const report = state.report;
  const label = useMemo(() => labelIn(model), [model]);
  const c = report === null ? null : counts(report.findings);
  const stale = report !== null && model !== null && report.hash !== model.hash;

  // A finding asked for by the URL (`?finding=`), zoomed to once the plan and the findings agree.
  const pending = useEditor(store, (s) => s.status === 'ready' && s.view !== null);
  useEffect(() => {
    if (!pending || report === null || stale || state.focus === null || !zoomPending.has(store)) return;
    const f = report.findings.find((x) => findingKey(x) === state.focus);
    zoomPending.delete(store);
    if (f !== undefined) zoomTo(store, f);
  }, [pending, report, stale, state.focus, store]);

  // The finding in focus — from the plan, the URL or a click — is scrolled into view in the list.
  useEffect(() => {
    if (state.focus === null) return;
    const card = [...document.querySelectorAll<HTMLElement>('.fs-fpanel [data-finding]')].find((el) => el.dataset['finding'] === state.focus);
    card?.scrollIntoView({ block: 'nearest' });
  }, [state.focus, report]);

  const close = () => { store.set({ findingsOpen: false }); };
  const head = (
    <div className="fs-fpanel__head">
      <div>
        <h2>Findings{report === null ? '' : ` · ${String(report.findings.length)}`}</h2>
        <p>{report === null ? 'Loading' : `${report.profile}${report.rulePacks.length === 0 ? '' : ` · ${String(report.evaluated?.length ?? 0)} rules evaluated`}`}</p>
      </div>
      <span className="fs-spacer" />
      <IconButton variant="ghost" label="Close the findings" icon={<X />} onClick={close} />
    </div>
  );

  if (report === null || c === null) {
    return (
      <div className="fs-fpanel">
        {head}
        {state.status === 'failed' ? (
          <EmptyState kind="error" size="inline" heading="The findings did not load" action={<Button size="sm" variant="secondary" onClick={() => { source.load(); }}>Try again</Button>}>
            {state.error ?? ''}
          </EmptyState>
        ) : (
          <Spinner label="Loading the findings" />
        )}
      </div>
    );
  }

  const s = stateOf(report);
  const shown = report.findings.map((f, i) => ({ f, index: i + 1 })).filter(({ f }) => state.show === 'all' || f.severity === state.show);
  return (
    <div className="fs-fpanel" data-testid="findings-panel">
      {head}
      {s === 'findings' ? (
        <SegmentedControl
          aria-label="Severity shown"
          size="sm"
          value={state.show}
          onValueChange={(v) => { source.set({ show: v as typeof state.show, focus: null }); }}
          items={[{ value: 'all', label: 'All', count: c.total }, ...SEVERITIES.filter((x) => c[x.id] > 0).map((x) => ({ value: x.id, label: x.plural, count: c[x.id] }))]}
        />
      ) : null}
      {stale ? <p className="fs-coverage-note" role="status">Evaluating the latest version…</p> : null}
      {s === 'none-installed' ? (
        <EmptyState kind="empty" size="inline" heading="No rule pack is installed">
          Nothing was checked, so there is nothing to draw. Findings appear here once a verified pack is installed.
        </EmptyState>
      ) : s === 'none-evaluated' ? (
        <EmptyState kind="empty" size="inline" heading={`No installed rule is in force under ${report.profile}`} action={<Link href={`/jurisdictions?project=${store.projectId}`}>Choose a profile</Link>}>
          Nothing was checked: the installed packs cite editions this profile does not adopt.
        </EmptyState>
      ) : s === 'no-findings' ? (
        <EmptyState kind="empty" size="inline" heading="No findings from the rules evaluated">
          These rules found nothing to flag. Sections no rule covers were not checked.
        </EmptyState>
      ) : (
        <ul className="fs-fpanel__list" aria-label="Findings">
          {shown.map(({ f, index }) => {
            const key = findingKey(f);
            return (
              <li key={key}>
                <FindingCard
                  finding={f}
                  index={index}
                  label={label}
                  focused={state.focus === key}
                  headingLevel={3}
                  onElement={(id) => {
                    source.set({ focus: key });
                    if (model?.index.has(id) === true) store.select(id, { keepSide: true });
                  }}
                  actions={
                    <Button size="sm" variant={state.focus === key ? 'primary' : 'secondary'} icon={<Crosshair />} disabled={stale} onClick={() => {
                      source.set({ focus: key });
                      zoomTo(store, f);
                    }}>
                      Zoom to it
                    </Button>
                  }
                />
              </li>
            );
          })}
        </ul>
      )}
      <FindingsNotice notice={report.notice} compact>
        <p className="fs-notice__link">
          <Link href={`/projects/${store.projectId}/findings`}>
            <ClipboardList aria-hidden="true" width={12} height={12} /> The full report
          </Link>
          {' · '}
          <Link href={`/jurisdictions?project=${store.projectId}`}>Jurisdiction profile</Link>
        </p>
      </FindingsNotice>
    </div>
  );
}

/** Stores whose next zoom is owed to a `?finding=` in the URL. */
const zoomPending = new WeakSet<EditorStore>();

/** Open the panel focused on a finding (from the URL), and zoom to it once it can be drawn. */
export function openAtFinding(store: EditorStore, source: FindingsSource, key: string | null): void {
  store.set({ findingsOpen: true });
  if (key === null) return;
  source.set({ focus: key, show: 'all' });
  zoomPending.add(store);
}

/** Frame a finding on the plan: its level, and its shapes with room around them. */
export function zoomTo(store: EditorStore, f: Finding): void {
  const s = store.get();
  if (s.model === null || s.view === null) return;
  const level = s.model.levels.find((l) => l.id === f.location.level) ?? null;
  const bounds = boundsOfOverlay(overlayOf(f, level));
  if (bounds === null) return;
  const frame = () => {
    const view = store.get().view;
    if (view !== null) store.set({ view: fit(bounds, view.w, view.h, 140) });
  };
  if (s.level !== f.location.level && level !== null) {
    // The canvas frames a level it switches to; frame the finding after it has.
    store.setLevel(f.location.level);
    window.setTimeout(frame, 60);
  } else frame();
}
