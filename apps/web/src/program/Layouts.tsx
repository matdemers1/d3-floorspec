import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Button, EmptyState, Spinner, useToast } from '@d3cloud/ui';
import { GitPullRequestArrow, RotateCcw, Sparkles, Waypoints } from 'lucide-react';
import { navigate } from '../lib/router';
import { useEditor, type EditorStore } from '../editor/store';
import { decideChangeset, fetchChangesetModel, type ChangesetRow } from '../editor/api';
import { readModel, type EditorModel } from '../editor/model';
import { formatArea } from '../editor/units';
import { PlanThumbnail } from '../components/PlanThumbnail';
import { timeAgo } from '../projects/model';
import { readProgram, type ProgramView } from './model';
import { candidateSets, letter, loadSolve, type Candidate, type Stored } from './candidates';
import { runSolve } from './solve';

const PROGRAM_LINTS = new Set(['FS-LINT-008', 'FS-LINT-009', 'FS-LINT-010', 'FS-LINT-011']);

/**
 * The layout candidates (the board's "06 · Layout candidates", FLR-T-4.3): each a pending changeset
 * the solver opened, drawn from its own head by the engine — the plan, its net area and footprint,
 * how many of the brief's lines it meets, and its findings — with the solver's brief-fit and
 * circulation scores where this browser kept its report. Opening one goes to the plan's proposal
 * review; accepting it there makes the others stop applying, and this screen offers to discard them.
 */
export function Layouts({ store, view, tick }: { store: EditorStore; view: ProgramView; tick: number }) {
  const model = useEditor(store, (s) => s.model);
  const readOnly = useEditor(store, (s) => s.readOnly);
  const toast = useToast();
  const [rows, setRows] = useState<ChangesetRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [stored, setStored] = useState<Stored | null>(() => loadSolve(store.projectId));
  const main = model?.hash ?? null;

  const load = useCallback(() => {
    fetch(`/api/projects/${store.projectId}/changesets?status=all`, { credentials: 'same-origin', cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) throw new Error(`the changesets did not load (${String(res.status)})`);
        return ((await res.json()) as { changesets: ChangesetRow[] }).changesets;
      })
      .then((list) => {
        setRows(list);
        setError(null);
      })
      .catch((caught: unknown) => { setError(caught instanceof Error ? caught.message : 'The changesets did not load.'); });
  }, [store.projectId]);
  useEffect(load, [load, tick, main]);

  const sets = useMemo(() => (rows === null ? null : candidateSets(rows, main)), [rows, main]);

  const solve = async () => {
    setBusy('solve');
    setProblem(null);
    const outcome = await runSolve(store, { count: Math.min(6, Math.max(3, sets?.current.length ?? 3)) });
    setBusy(null);
    if (outcome.status === 'problem') {
      setProblem(outcome.message);
      return;
    }
    setStored(loadSolve(store.projectId));
    if (outcome.answer.candidates.every((c) => c.reused)) toast.show({ message: 'These are already the layouts for this version of the brief.' });
    load();
  };

  const discard = async (candidates: readonly Candidate[], what: string) => {
    setBusy(`discard:${what}`);
    for (const c of candidates) await decideChangeset(store.projectId, c.row.id, 'reject');
    setBusy(null);
    toast.show({ message: candidates.length === 1 ? `${what} was discarded.` : `${String(candidates.length)} candidates were discarded.` });
    load();
  };

  if (error !== null) {
    return (
      <main className="fs-layouts" aria-label="Layouts">
        <EmptyState kind="error" heading="The candidates did not load" action={<Button variant="secondary" onClick={load}>Try again</Button>}>
          {error}
        </EmptyState>
      </main>
    );
  }
  if (sets === null || model === null) {
    return (
      <main className="fs-layouts fs-layouts--loading" aria-label="Layouts">
        <Spinner size="lg" label="Loading the candidates" />
      </main>
    );
  }

  const current = sets.current;
  const solvedHere = stored !== null && stored.solved.main === main ? stored : null;
  const summary = [
    solvedHere === null ? null : `Solved ${timeAgo(solvedHere.solvedAt)}`,
    `${String(view.items.length)} brief ${view.items.length === 1 ? 'item' : 'items'}`,
    `${String(view.edges.length)} ${view.edges.length === 1 ? 'adjacency' : 'adjacencies'}`,
    solvedHere === null || solvedHere.solved.footprint === null ? 'footprint from the brief' : `footprint ${feet(solvedHere.solved.footprint.width, store.units)} × ${feet(solvedHere.solved.footprint.depth, store.units)}`,
  ]
    .filter((x) => x !== null)
    .join(' · ');
  const editable = readOnly === null && view.version === '0.2';

  return (
    <main className="fs-layouts" aria-label="Layouts" aria-busy={busy === 'solve'}>
      <div className="fs-layouts__head">
        <div>
          <h2>{current.length === 0 ? 'Layouts from your brief' : `${String(current.length)} layouts from your brief`}</h2>
          <p>{summary}</p>
        </div>
        <span className="fs-spacer" />
        <Button variant="ghost" icon={<Waypoints />} onClick={() => { navigate(`/projects/${store.projectId}/program`); }}>
          Adjust brief
        </Button>
        <Button variant="secondary" icon={<RotateCcw />} loading={busy === 'solve'} disabled={!editable || view.items.length === 0 || busy !== null} onClick={() => void solve()}>
          {current.length === 0 ? 'Solve layouts' : 'Solve again'}
        </Button>
      </div>

      {problem === null ? null : (
        <Alert tone="warning" title="No layouts" dynamic>
          {problem}
        </Alert>
      )}

      {sets.accepted !== null ? (
        <Alert tone="info" title={`“${sets.accepted.row.name}” is in the plan`}>
          <p>
            The other {sets.accepted.superseded.length === 1 ? 'candidate was' : `${String(sets.accepted.superseded.length)} candidates were`} drawn for the plan before it, so they no longer apply: accepting one would fail its replay.
          </p>
          <Button size="sm" variant="secondary" loading={busy === 'discard:superseded'} disabled={busy !== null} onClick={() => void discard(sets.accepted?.superseded ?? [], 'superseded')}>
            Discard the other {sets.accepted.superseded.length === 1 ? 'candidate' : String(sets.accepted.superseded.length)}
          </Button>
        </Alert>
      ) : null}

      {current.length === 0 && sets.accepted !== null ? (
        <div className="fs-layouts__empty">
          <EmptyState
            kind="empty"
            heading="A candidate is in the plan"
            action={
              <Button variant="primary" icon={<GitPullRequestArrow />} onClick={() => { navigate(`/projects/${store.projectId}/editor`); }}>
                Open the plan
              </Button>
            }
          >
            Keep designing in the plan. Change the brief and solve again for fresh candidates — on a new level, since this one is drawn on.
          </EmptyState>
        </div>
      ) : current.length === 0 ? (
        <div className="fs-layouts__empty">
          <EmptyState
            kind="empty"
            heading={view.items.length === 0 ? 'Write the brief first' : 'No layouts for this version of the plan'}
            action={
              view.items.length === 0 ? (
                <Button variant="primary" icon={<Waypoints />} onClick={() => { navigate(`/projects/${store.projectId}/program`); }}>
                  Open the brief
                </Button>
              ) : editable ? (
                <Button variant="primary" icon={<Sparkles />} loading={busy === 'solve'} disabled={busy !== null} onClick={() => void solve()}>
                  Solve 3 layouts
                </Button>
              ) : undefined
            }
          >
            {view.items.length === 0
              ? 'The solver lays out a brief: the rooms the house must have, and which belong together.'
              : 'Each candidate is drawn as a changeset of its own, ranked by how well it meets the brief. Nothing changes in your plan until you accept one.'}
          </EmptyState>
        </div>
      ) : (
        <ol className="fs-layouts__grid" aria-label="Candidates, best first">
          {current.map((c, i) => (
            <CandidateCard
              key={c.row.id}
              store={store}
              candidate={c}
              position={i + 1}
              main={model}
              report={stored?.reports[c.row.id]}
              busy={busy}
              onDiscard={() => void discard([c], `Candidate ${letter(i + 1)}`)}
            />
          ))}
        </ol>
      )}

      {sets.stale.length > 0 ? (
        <section className="fs-layouts__stale" aria-label="Earlier candidates">
          <p>
            {sets.stale.length === 1 ? 'One candidate was' : `${String(sets.stale.length)} candidates were`} solved for an earlier version of the plan and still {sets.stale.length === 1 ? 'waits' : 'wait'} in the changesets.
          </p>
          <Button size="sm" variant="ghost" loading={busy === 'discard:stale'} disabled={busy !== null} onClick={() => void discard(sets.stale, 'stale')}>
            Discard {sets.stale.length === 1 ? 'it' : 'them'}
          </Button>
        </section>
      ) : null}

      <div className="fs-layouts__foot">
        <Sparkles aria-hidden="true" />
        <span>Ask Claude: “Why does A beat B on adjacency?” — floorspec_propose_layouts hands it the solver’s report, not the pixels.</span>
        <span className="fs-spacer" />
        <span className="fs-layouts__faint">Opening a candidate never overwrites your model; it becomes a changeset.</span>
      </div>
    </main>
  );
}

/** A length in whole or half feet (or metres to a tenth), as the candidates' footprints read: `72′`. */
function feet(value: number, units: 'imperial' | 'metric'): string {
  if (units === 'metric') return `${(Math.round(value / 128_000) / 10).toFixed(1)} m`;
  return `${String(Math.round((value / 390_144) * 2) / 2)}′`;
}

/** The level a candidate drew on: the one where its head has rooms main has not. */
function levelOf(candidate: EditorModel, main: EditorModel, wanted: string | undefined): string | undefined {
  if (wanted !== undefined && candidate.levels.some((l) => l.id === wanted)) return wanted;
  return candidate.levels.find((l) => l.rooms.some((r) => !main.index.has(r.id)))?.id ?? candidate.levels[0]?.id;
}

function CandidateCard({
  store,
  candidate,
  position,
  main,
  report,
  busy,
  onDiscard,
}: {
  store: EditorStore;
  candidate: Candidate;
  position: number;
  main: EditorModel;
  report: Stored['reports'][string] | undefined;
  busy: string | null;
  onDiscard: () => void;
}) {
  const units = useEditor(store, () => store.units);
  const [model, setModel] = useState<EditorModel | null | 'failed'>(null);
  const head = candidate.row.head;
  useEffect(() => {
    let live = true;
    fetchChangesetModel(store.projectId, candidate.row.id)
      .then((m) => { if (live) setModel(m === null ? 'failed' : readModel(m.hash, m.text)); })
      .catch(() => { if (live) setModel('failed'); });
    return () => { live = false; };
  }, [store.projectId, candidate.row.id, head]);

  const name = `Candidate ${letter(position)}`;
  const ready = model !== null && model !== 'failed' ? model : null;
  const program = ready === null ? null : readProgram(ready);
  const level = ready === null ? undefined : levelOf(ready, main, report?.level);
  const levelView = ready?.levels.find((l) => l.id === level);
  const area2 = levelView?.rooms.reduce((sum, r) => sum + r.area2, 0n) ?? 0n;
  const bounds = levelView?.bounds ?? null;
  const findings = ready === null ? 0 : ready.diagnostics.filter((d) => d.severity === 'warning' && !PROGRAM_LINTS.has(d.code)).length;
  const met = program?.edges.filter((e) => e.met === true).length ?? 0;
  const lines = program?.edges.length ?? 0;
  const items = program?.items ?? [];
  const briefFit = report?.score.briefFit ?? (items.length === 0 ? null : items.filter((i) => i.need.met).length / items.length);
  const circulation = report?.score.circulation ?? reach(ready);
  const best = position === 1;
  const description = [report?.label ?? candidate.label, ready === null ? null : formatArea(area2, units), bounds === null ? null : `${feet(bounds.maxX - bounds.minX, units)} × ${feet(bounds.maxY - bounds.minY, units)}`]
    .filter((x) => x !== null)
    .join(' · ');

  return (
    <li className={`fs-candidate${best ? ' is-best' : ''}`} aria-label={`${name}: ${candidate.row.name}`}>
      <div className="fs-candidate__plan">
        {ready !== null && ready.derived !== null ? (
          <PlanThumbnail document={ready.document} derived={ready.derived} level={level} title={`${name}: plan of ${levelView?.name ?? 'the level'}`} />
        ) : model === 'failed' ? (
          <p className="fs-note">The plan did not load.</p>
        ) : (
          <Spinner label={`Loading ${name}`} />
        )}
      </div>
      <div className="fs-candidate__body">
        <div className="fs-candidate__title">
          <h3>{name}</h3>
          {best ? (
            <Badge size="sm" tone="attention">
              Best fit
            </Badge>
          ) : null}
          <span className="fs-spacer" />
          {ready === null ? null : (
            <Badge size="sm" tone={findings > 0 ? 'warning' : 'neutral'}>
              {findings === 0 ? 'No findings' : findings === 1 ? '1 finding' : `${String(findings)} findings`}
            </Badge>
          )}
        </div>
        <p className="fs-candidate__desc">{description}</p>
        <Bar label="Brief fit" value={briefFit} text={briefFit === null ? '—' : `${String(Math.round(briefFit * 100))}%`} strong={best} />
        <Bar label="Adjacency" value={lines === 0 ? null : met / lines} text={program === null ? '—' : `${String(met)} / ${String(lines)}`} strong={best} />
        <Bar label="Circulation" value={circulation} text={circulation === null ? '—' : `${String(Math.round(circulation * 100))}%`} strong={best} />
        <p className="fs-candidate__score">Score {candidate.total.toFixed(1)} of 100</p>
        {report === undefined ? null : (
          <details className="fs-candidate__why">
            <summary>What the solver says</summary>
            <ul>
              {report.explanation.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
          </details>
        )}
        <span className="fs-spacer" />
        <div className="fs-candidate__actions">
          <Button size="sm" variant={best ? 'primary' : 'secondary'} icon={<GitPullRequestArrow />} onClick={() => { navigate(`/projects/${store.projectId}/editor?review=${candidate.row.id}`); }}>
            Open as changeset
          </Button>
          <Button size="sm" variant="ghost" loading={busy === `discard:${name}`} disabled={busy !== null} onClick={onDiscard}>
            Discard<span className="fs-visually-hidden"> {name}</span>
          </Button>
        </div>
      </div>
    </li>
  );
}

/** Circulation as the engine derives it (14.3): rooms reachable from an entry, none only through a bedroom. */
function reach(model: EditorModel | null): number | null {
  const rooms = Object.values(model?.derived?.circulation ?? {});
  if (rooms.length === 0) return null;
  return rooms.filter((r) => r.reachable && r.throughSleeping !== true).length / rooms.length;
}

function Bar({ label, value, text, strong }: { label: string; value: number | null; text: string; strong: boolean }) {
  return (
    <div className="fs-bar">
      <div className="fs-bar__row">
        <span>{label}</span>
        <span className="fs-spacer" />
        <span className="fs-bar__value">{text}</span>
      </div>
      <div className={`fs-bar__track${strong ? ' is-strong' : ''}`} aria-hidden="true">
        <div className="fs-bar__fill" style={{ width: `${String(Math.round(Math.max(0, Math.min(1, value ?? 0)) * 100))}%` }} />
      </div>
    </div>
  );
}
