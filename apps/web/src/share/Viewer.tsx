import '../editor/editor.css';
import './share.css';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AuthLayout, Avatar, Badge, Button, Card, EmptyState, SegmentedControl, Select, Spinner, StatusDot, TabPanel, Tabs, TooltipProvider } from '@d3cloud/ui';
import { House, LogIn } from 'lucide-react';
import { EditorStore, useEditor } from '../editor/store';
import { ToolController } from '../editor/tools';
import { PlanCanvas } from '../editor/Canvas';
import { Views } from '../editor/three/Views';
import { threeOf, useThreeState } from '../editor/three/mode';
import { labelOf, readModel, sortedLevels, type EditorModel } from '../editor/model';
import { zoomTo } from '../findings/Panel';
import { FindingCard, FindingsNotice } from '../findings/parts';
import { counts, findingKey, MATRIX_STATUS, severityOf, shortReason, stateOf } from '../findings/model';
import { sharedFindingsSource, useFindings } from '../findings/source';
import { labelIn } from '../findings/rooms';
import type { Finding, FindingsReport, RulePacks } from '../findings/types';
import { formatSquareFeet, plural, summarize } from '../projects/model';
import { api, messageOf } from '../lib/api';
import { navigate } from '../lib/router';
import { fetchMeta, fetchSharedModel, shareEndpoint, type ShareMeta } from './api';
import { commentsAt, type CommentsStore, type PinTarget } from './comments';
import { CommentsPanel } from './CommentsPanel';
import { CommentPins } from './CommentPins';
import { anchorIn, targetOf } from './pins';
import { toScreen } from '../editor/viewport';
import { rememberReturn } from './returnTo';
import { dateOf } from './ShareDialog';

/**
 * `/s/<token>` — the shared viewer (FLR-T-9.6, FLR-REQ-133; the board's "19 · Shared viewer — no
 * account" and "20 · Comments — architect review"). What a share link shows, read-only, with no
 * account: the plan on the editor's own canvas, the 3D view and its walkthrough from the same lazy
 * chunk, the findings under the project's profile with the notice that they are not a plan review,
 * and level switching — and nothing else: no history, no tokens, no other project, no owner email.
 * Every byte comes from `/api/share/<token>/*`; nothing here can ask for more.
 *
 * Comments (FLR-REQ-134, 167): anyone may read them; a signed-in account pins new ones to the
 * selected element. Signing in from here comes back here.
 */

type Loaded =
  | { status: 'loading' }
  | { status: 'missing' }
  | { status: 'gone'; reason: 'expired' | 'revoked' }
  | { status: 'limited' }
  | { status: 'failed'; message: string }
  | { status: 'ready'; meta: ShareMeta };

export default function ShareViewer({ token }: { token: string }) {
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  const key = `share:${token}`;
  const store = useMemo(() => new EditorStore(key), [key]);
  const tools = useMemo(() => new ToolController(store), [store]);
  const comments = useMemo(() => commentsAt(shareEndpoint(token)), [token]);

  const loadModel = useCallback(
    async (meta: ShareMeta) => {
      if (!meta.shows.plan && !meta.shows.threeD) {
        store.set({ status: 'ready', model: null });
        return;
      }
      const { hash, text } = await fetchSharedModel(token);
      const model = readModel(hash, text);
      const level = store.get().level;
      store.set({
        status: 'ready',
        model,
        project: { id: key, name: meta.project.name, head: { name: 'main', version: hash, updatedAt: '' }, ops: 0 },
        history: { head: hash, undo: null, redo: null, seq: meta.version?.seq ?? null },
        level: level !== null && model.levels.some((l) => l.id === level) ? level : (sortedLevels(model.document)[0]?.id ?? null),
        readOnly: 'A shared link is view-only.',
        tool: 'select',
        layers: { ...store.get().layers, findings: meta.shows.findings },
      });
    },
    [store, token, key],
  );

  const load = useCallback(() => {
    void fetchMeta(token).then(async (answer) => {
      if (answer.status !== 'ok') {
        setLoaded(answer);
        return;
      }
      const { meta } = answer;
      // Before any surface asks: the findings come from the link's route, or not at all.
      sharedFindingsSource(key, meta.shows.findings ? `/api/share/${encodeURIComponent(token)}/findings` : null);
      comments.readsThreads = meta.comments.allowed;
      const three = threeOf(store);
      if (!meta.shows.plan) three.setMode('3d');
      else if (!meta.shows.threeD) three.setMode('plan');
      else if (three.get().mode === 'split') three.setMode('plan');
      try {
        await loadModel(meta);
        setLoaded({ status: 'ready', meta });
      } catch (caught) {
        setLoaded({ status: 'failed', message: messageOf(caught) });
      }
    });
  }, [token, key, store, comments, loadModel]);
  useEffect(load, [load]);

  // The link's stream: comments (the store's own), the model moving, findings changing, the revoke.
  useEffect(() => {
    if (loaded.status !== 'ready') return;
    const meta = loaded.meta;
    comments.onNews = (news) => {
      if (news.type === 'revoked') setLoaded({ status: 'gone', reason: 'revoked' });
      else if (news.type === 'model' && meta.version?.pinned !== true && store.get().model?.hash !== news.hash) {
        void fetchMeta(token).then((answer) => {
          if (answer.status !== 'ok') {
            setLoaded(answer);
            return;
          }
          void loadModel(answer.meta).then(() => { setLoaded({ status: 'ready', meta: answer.meta }); });
          if (answer.meta.shows.findings) sharedFindingsSource(key, null).load();
        });
      } else if (news.type === 'findings' && meta.shows.findings) sharedFindingsSource(key, null).load();
    };
    const leave = comments.join();
    return () => {
      comments.onNews = null;
      leave();
    };
  }, [loaded, comments, store, token, key, loadModel]);

  // Under automation only (navigator.webdriver), as the 3D view's hook is: where on the page an
  // element of the level shown is, so the end-to-end suite can click a wall like a person would.
  useEffect(() => {
    if (!navigator.webdriver) return;
    const hook = {
      screenPoint(id: string): { x: number; y: number } | null {
        const s = store.get();
        const level = s.model?.levels.find((l) => l.id === s.level);
        const svg = document.querySelector('.fs-share .fs-canvas__svg');
        const at = level === undefined ? null : anchorIn(level, id);
        if (at === null || s.view === null || svg === null) return null;
        const box = svg.getBoundingClientRect();
        const [x, y] = toScreen(s.view, at);
        return { x: box.left + x, y: box.top + y };
      },
    };
    (window as { __floorspecShare?: typeof hook }).__floorspecShare = hook;
    return () => { delete (window as { __floorspecShare?: typeof hook }).__floorspecShare; };
  }, [store]);

  useEffect(() => {
    const robots = document.createElement('meta');
    robots.name = 'robots';
    robots.content = 'noindex, nofollow';
    document.head.appendChild(robots);
    return () => { robots.remove(); };
  }, []);

  if (loaded.status === 'loading') return <Spinner label="Opening the shared project" />;
  if (loaded.status !== 'ready') return <Unavailable loaded={loaded} onRetry={load} />;
  return (
    <TooltipProvider>
      <Frame meta={loaded.meta} token={token} store={store} tools={tools} comments={comments} />
    </TooltipProvider>
  );
}

function Unavailable({ loaded, onRetry }: { loaded: Exclude<Loaded, { status: 'ready' | 'loading' }>; onRetry: () => void }) {
  const copy =
    loaded.status === 'gone'
      ? loaded.reason === 'expired'
        ? { title: 'This link has expired', body: 'Share links last as long as their owner chose. Ask whoever sent it for a new one.' }
        : { title: 'This link was turned off', body: 'Its owner revoked it, so it no longer shows anything. Ask whoever sent it for a new one.' }
      : loaded.status === 'missing'
        ? { title: 'This link does not work', body: 'Check that it was copied whole. If it was, it no longer exists — ask whoever sent it for a new one.' }
        : loaded.status === 'limited'
          ? { title: 'Too many requests', body: 'Wait a minute, then try again.' }
          : { title: 'The shared project did not load', body: loaded.message };
  const retry = loaded.status === 'failed' || loaded.status === 'limited';
  return (
    <AuthLayout title={copy.title} description={copy.body} footer="Shared from D3 Floorspec.">
      {retry ? (
        <Card>
          <Button variant="secondary" onClick={onRetry}>
            Try again
          </Button>
        </Card>
      ) : null}
    </AuthLayout>
  );
}

type Side = 'overview' | 'findings' | 'comments';

function Frame({ meta, token, store, tools, comments }: { meta: ShareMeta; token: string; store: EditorStore; tools: ToolController; comments: CommentsStore }) {
  const walking = useThreeState(store, (s) => s.walking);
  const mode = useThreeState(store, (s) => s.mode);
  const model = useEditor(store, (s) => s.model);
  const [side, setSide] = useState<Side>(meta.comments.allowed && meta.comments.signedIn ? 'comments' : 'overview');
  const signIn = () => {
    rememberReturn(`/s/${token}`);
    navigate('/signin');
  };

  // What a new comment is pinned to: the selection, at the point the plan was clicked.
  const selection = useEditor(store, (s) => s.selection);
  const [target, setTarget] = useState<PinTarget | null>(null);
  useEffect(() => {
    const s = store.get();
    setTarget(targetOf(s.model, s.selection, s.cursor, threeOf(store).get().mode !== '3d'));
    // Picking something new on the plan starts a new comment rather than answering the one in focus.
    const focus = comments.get().focus;
    const thread = comments.get().threads.find((t) => t.id === focus);
    if (s.selection !== null && thread !== undefined && thread.pin?.element !== s.selection) comments.set({ focus: null });
    if (s.selection !== null && meta.comments.allowed && meta.comments.signedIn) setSide('comments');
  }, [selection, store, comments, meta.comments.allowed, meta.comments.signedIn]);

  const version = meta.version === null ? null : `v${String(meta.version.seq ?? 0)}${meta.version.pinned ? ' (pinned)' : ''}`;
  const subtitle = [`Shared by ${meta.sharedBy}`, 'view only', version].filter((x) => x !== null).join(' · ');
  const views = [
    ...(meta.shows.plan ? [{ value: 'plan', label: 'Plan' }] : []),
    ...(meta.shows.threeD ? [{ value: '3d', label: '3D' }, { value: 'walk', label: 'Walk' }] : []),
  ];
  const tabs = [
    { value: 'overview', label: 'Overview' },
    ...(meta.shows.findings ? [{ value: 'findings', label: 'Findings' }] : []),
    ...(meta.comments.allowed ? [{ value: 'comments', label: 'Comments' }] : []),
  ];

  return (
    <div className="fs-editor fs-share" tabIndex={-1} data-walk={walking ? 'on' : undefined} data-testid="shared-viewer">
      <header className="fs-share__bar">
        <span className="fs-share__mark" aria-hidden="true">
          <House />
        </span>
        <div className="fs-topbar__title fs-share__title">
          <h1>{meta.project.name}</h1>
          <p>{subtitle}</p>
        </div>
        <span className="fs-spacer" />
        {views.length > 1 && model !== null ? (
          <SegmentedControl
            aria-label="View"
            value={walking ? 'walk' : mode === 'split' ? 'plan' : mode}
            items={views}
            onValueChange={(v) => {
              const three = threeOf(store);
              if (v === 'walk') three.walk(null);
              else {
                three.stopWalking();
                three.setMode(v === '3d' ? '3d' : 'plan');
              }
            }}
          />
        ) : null}
        <span className="fs-spacer" />
        {meta.comments.you !== null ? (
          <span className="fs-share__you">
            <Avatar name={meta.comments.you.name} size="sm" tint="auto" />
            <span>{meta.comments.you.name}</span>
          </span>
        ) : meta.comments.allowed ? (
          <Button variant="primary" size="sm" icon={<LogIn />} onClick={signIn}>
            Sign in to comment
          </Button>
        ) : null}
      </header>
      <main className="fs-editor__canvas fs-share__canvas" aria-label={walking ? 'Walkthrough' : mode === '3d' ? '3D view' : 'Plan'}>
        {model === null ? (
          <div className="fs-share__nocanvas">
            <EmptyState kind="empty" size="inline" heading="This link shares the findings">
              Its owner chose not to share the plan or the 3D view.
            </EmptyState>
          </div>
        ) : (
          <>
            <Views
              store={store}
              plan={
                <>
                  <PlanCanvas store={store} tools={tools} />
                  {meta.comments.allowed ? <CommentPins editor={store} comments={comments} /> : null}
                </>
              }
            />
            <LevelPicker store={store} model={model} />
          </>
        )}
      </main>
      <aside className="fs-share__side" aria-label="About this house">
        <Tabs items={tabs} value={side} onValueChange={(v) => { setSide(v as Side); }} className="fs-share__tabs">
          <TabPanel value="overview">
            <Overview meta={meta} store={store} onFindings={() => { setSide('findings'); }} />
          </TabPanel>
          {meta.shows.findings ? (
            <TabPanel value="findings">
              <SharedFindings token={token} store={store} />
            </TabPanel>
          ) : null}
          {meta.comments.allowed ? (
            <TabPanel value="comments">
              <CommentsPanel comments={comments} editor={store} as="viewer" canWrite={meta.comments.signedIn} target={target} onSignIn={signIn} />
            </TabPanel>
          ) : null}
        </Tabs>
        <p className="fs-share__note" role="note">
          View-only link. Expires {dateOf(meta.expiresAt)}.{meta.shows.findings ? ' Findings are advisory — not a plan review.' : ''}
        </p>
      </aside>
    </div>
  );
}

function LevelPicker({ store, model }: { store: EditorStore; model: EditorModel }) {
  const level = useEditor(store, (s) => s.level);
  const walking = useThreeState(store, (s) => s.walking);
  const levels = sortedLevels(model.document);
  if (levels.length === 0 || walking) return null;
  return (
    <div className="fs-share__level">
      <Select aria-label="Level" value={level ?? ''} options={levels.map(({ id }) => ({ value: id, label: labelOf(model, id) }))} onValueChange={(v) => { store.setLevel(v); }} />
    </div>
  );
}

function Overview({ meta, store, onFindings }: { meta: ShareMeta; store: EditorStore; onFindings: () => void }) {
  const model = useEditor(store, (s) => s.model);
  const summary = useMemo(() => (model === null ? null : summarize(model.document)), [model]);
  return (
    <div className="fs-share__overview">
      {summary === null ? null : (
        <section aria-labelledby="fs-share-glance">
          <h2 id="fs-share-glance" className="fs-share__h">At a glance</h2>
          <dl className="fs-share__facts">
            <div>
              <dt>Net room area</dt>
              <dd>{summary.valid ? `${formatSquareFeet(summary.area2)} ft²` : '—'}</dd>
            </div>
            <div>
              <dt>Rooms</dt>
              <dd>{String(summary.rooms)}</dd>
            </div>
            <div>
              <dt>Levels</dt>
              <dd>{String(summary.levels.length)}</dd>
            </div>
            <div>
              <dt>Doors and windows</dt>
              <dd>{String(summary.openings)}</dd>
            </div>
          </dl>
        </section>
      )}
      {meta.shows.findings ? <FindingsSummary store={store} onFindings={onFindings} /> : null}
    </div>
  );
}

function FindingsSummary({ store, onFindings }: { store: EditorStore; onFindings: () => void }) {
  const [state, source] = useFindings(store.projectId);
  const report = state.report;
  if (report === null) return state.status === 'failed' ? <p className="fs-note">The findings did not load.</p> : <Spinner size="sm" label="Loading the findings" />;
  const c = counts(report.findings);
  return (
    <section aria-labelledby="fs-share-findings-sum">
      <dl className="fs-share__facts">
        <div>
          <dt>Checked against</dt>
          <dd>{report.profile}</dd>
        </div>
      </dl>
      <h2 id="fs-share-findings-sum" className="fs-share__h">
        Findings · {c.total}
      </h2>
      {report.findings.length === 0 ? (
        <p className="fs-note">{summaryNote(report)}</p>
      ) : (
        <ul className="fs-share__findings">
          {report.findings.slice(0, 8).map((f) => (
            <li key={findingKey(f)}>
              <button
                type="button"
                className="fs-share__finding"
                onClick={() => {
                  source.set({ focus: findingKey(f) });
                  zoomTo(store, f);
                  onFindings();
                }}
              >
                <StatusDot tone={severityOf(f.severity).tone} size="sm">
                  {shortReason(f) === '' ? f.title : `${f.title}: ${shortReason(f)}`}
                </StatusDot>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** What an empty list of findings means — never that the house passed anything. */
function summaryNote(report: FindingsReport): string {
  switch (stateOf(report)) {
    case 'none-installed':
      return 'Nothing was checked: no rule pack is installed on this server.';
    case 'none-evaluated':
      return `No installed rule is in force under ${report.profile}, so nothing was checked.`;
    default:
      return 'The rules evaluated found nothing to flag. Sections they do not cover were not checked.';
  }
}

function SharedFindings({ token, store }: { token: string; store: EditorStore }) {
  const [state, source] = useFindings(store.projectId);
  const model = useEditor(store, (s) => s.model);
  const label = useMemo(() => labelIn(model), [model]);
  const [coverage, setCoverage] = useState(false);
  const report = state.report;
  if (report === null) {
    return state.status === 'failed' ? (
      <EmptyState kind="error" size="inline" heading="The findings did not load" action={<Button variant="secondary" size="sm" onClick={() => { source.load(); }}>Try again</Button>}>
        {state.error ?? ''}
      </EmptyState>
    ) : (
      <Spinner label="Loading the findings" />
    );
  }
  const open = (f: Finding) => {
    source.set({ focus: findingKey(f) });
    zoomTo(store, f);
  };
  const situation = stateOf(report);
  return (
    <div className="fs-share__report">
      <FindingsNotice
        notice={report.notice}
        compact
        coverageLink={
          <button type="button" className="fs-linkish" aria-expanded={coverage} onClick={() => { setCoverage(!coverage); }}>
            What the installed rule packs check, and what they do not
          </button>
        }
      >
        <p className="fs-notice__text">Evaluated under {report.profile}.</p>
      </FindingsNotice>
      {coverage ? <SharedCoverage token={token} /> : null}
      {situation === 'none-installed' ? (
        <p className="fs-note">{report.note}</p>
      ) : situation === 'none-evaluated' ? (
        <p className="fs-note">No installed rule is in force under {report.profile}, so nothing was checked.</p>
      ) : situation === 'no-findings' ? (
        <p className="fs-note">The {plural(report.evaluated?.length ?? 0, 'rule')} evaluated found nothing to flag. Sections they do not cover were not checked, and the authority having jurisdiction decides.</p>
      ) : (
        <ol className="fs-share__cards">
          {report.findings.map((f, i) => (
            <li key={findingKey(f)}>
              <FindingCard finding={f} index={i + 1} label={label} focused={state.focus === findingKey(f)} onElement={() => { open(f); }} headingLevel={3} />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** The installed packs' coverage, from the link's own route: what is checked and what is not (FLR-REQ-096). */
function SharedCoverage({ token }: { token: string }) {
  const [data, setData] = useState<RulePacks | null | 'failed'>(null);
  useEffect(() => {
    api.get<RulePacks>(`/api/share/${encodeURIComponent(token)}/coverage`).then(setData, () => { setData('failed'); });
  }, [token]);
  if (data === null) return <Spinner size="sm" label="Loading the coverage" />;
  if (data === 'failed') return <p className="fs-note">The coverage did not load.</p>;
  if (data.installed === 0) return <p className="fs-note">No rule pack is installed on this server, so nothing is checked.</p>;
  const m = data.matrix;
  return (
    <section className="fs-share__coverage" aria-label="Coverage of the installed rule packs">
      <ul className="fs-share__packs">
        {data.packs.map((p) => (
          <li key={p.name}>
            <strong>{p.title}</strong> <span className="fs-mono-small">{p.name} {p.version} · {p.license}</span>
          </li>
        ))}
      </ul>
      <table className="fs-share__matrix">
        <caption className="fs-note">{plural(m.rows.length, 'section')} of the cited editions, and how far the packs cover each.</caption>
        <thead>
          <tr>
            <th scope="col">Section</th>
            <th scope="col">Covered</th>
          </tr>
        </thead>
        <tbody>
          {m.rows.slice(0, 200).map((r, i) => (
            <tr key={i}>
              <td className="fs-mono-small">
                {r.code} {r.edition} {r.section}
              </td>
              <td>
                <Badge size="sm" tone={MATRIX_STATUS[r.status].tone}>
                  {MATRIX_STATUS[r.status].label}
                </Badge>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
