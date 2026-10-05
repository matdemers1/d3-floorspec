import '../components/screens.css';
import '../findings/findings.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, Card, EmptyState, Link, Modal, Page, PageHeader, Skeleton, Table, useToast, type TableColumn } from '@d3cloud/ui';
import { adoptionViews, domainTitle, editionsLine, parseProfile, serializeProfile, startingProfile, withdrawals, type AdoptionView, type Profile } from '@floorspec/rules-engine';
import { BookOpen, Copy, Download, ExternalLink, MapPin, Pencil, Plus, ScrollText, Trash2, Upload } from 'lucide-react';
import { api, messageOf } from '../lib/api';
import { useLocation } from '../lib/router';
import type { ProjectDetail } from '../screens/Project';
import type { RulePacks } from '../findings/types';
import { chooseProfile, createProfile, deleteProfile, listProfiles, projectProfile, updateProfile, type Profiles } from './api';
import { Builder } from './Builder';
import { fromProfile, toProfile, type Draft } from './draft';

const DEFAULT = 'default';

type Mode = { kind: 'view' } | { kind: 'new'; draft: Draft } | { kind: 'edit'; id: string; draft: Draft };

/**
 * `/jurisdictions` — jurisdiction profiles (FLR-T-6.8; the board's "12 · Jurisdiction profiles"):
 * which code editions and local amendments a project is checked against. The default is the
 * standard's "Model Codes (latest)" (Rules 10.6, FLR-REQ-099); every other profile is the
 * account's own, built here (FLR-REQ-100), imported or exported as the standard's JSON. Opened
 * from a project (`?project=<id>`), it offers "Use for <project>": the project's findings are then
 * evaluated under that profile, at once (10.7).
 */
export function Jurisdictions() {
  const toast = useToast();
  const { search } = useLocation();
  const projectId = useMemo(() => new URLSearchParams(search).get('project'), [search]);
  const [data, setData] = useState<Profiles | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string>(DEFAULT);
  const [mode, setMode] = useState<Mode>({ kind: 'view' });
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [project, setProject] = useState<{ detail: ProjectDetail; profileId: string | null } | null>(null);
  const [ruleRefs, setRuleRefs] = useState<{ pack: string; rule: string; title: string }[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    listProfiles().then(
      (d) => {
        setData(d);
        setError(null);
      },
      (caught: unknown) => { setError(messageOf(caught)); },
    );
  }, []);
  useEffect(load, [load]);
  useEffect(() => {
    api.get<RulePacks>('/api/rule-packs').then((r) => { setRuleRefs(r.matrix.rules.map((x) => ({ pack: x.pack, rule: x.rule, title: x.title }))); }, () => undefined);
  }, []);
  useEffect(() => {
    if (projectId === null) {
      setProject(null);
      return;
    }
    Promise.all([api.get<ProjectDetail>(`/api/projects/${projectId}`), projectProfile(projectId)]).then(
      ([detail, chosen]) => {
        setProject({ detail, profileId: chosen.id });
        setSelected(chosen.id ?? DEFAULT);
      },
      () => { setProject(null); },
    );
  }, [projectId]);

  if (error !== null) {
    return (
      <Page className="fs-screen">
        <EmptyState kind="error" heading="The profiles did not load" action={<Button variant="secondary" onClick={load}>Try again</Button>}>
          {error}
        </EmptyState>
      </Page>
    );
  }
  if (data === null) {
    return (
      <Page className="fs-screen" aria-busy="true" aria-label="Loading the profiles">
        <Skeleton variant="text" width={320} height={28} />
        <Skeleton variant="block" width="100%" height={360} />
      </Page>
    );
  }

  const rows = [{ id: DEFAULT, profile: data.default.profile, projects: data.default.projects }, ...data.profiles];
  const current = rows.find((r) => r.id === selected) ?? rows[0];
  const isDefault = current?.id === DEFAULT;

  const save = (draft: Draft) => {
    const profile = toProfile(draft);
    setBusy(true);
    setSaveError(null);
    const done = mode.kind === 'edit' ? updateProfile(mode.id, profile) : createProfile(profile);
    done
      .then((row) => {
        toast.show({ message: mode.kind === 'edit' ? `${row.profile.name} was saved.` : `${row.profile.name} was created.` });
        setMode({ kind: 'view' });
        setSelected(row.id);
        load();
      })
      .catch((caught: unknown) => { setSaveError(messageOf(caught)); })
      .finally(() => { setBusy(false); });
  };

  const use = (id: string | null) => {
    if (projectId === null) return;
    setBusy(true);
    chooseProfile(projectId, id)
      .then((chosen) => {
        toast.show({ message: `${project?.detail.name ?? 'The project'} is now evaluated under ${chosen.profile.name}.` });
        setProject(project === null ? null : { ...project, profileId: chosen.id });
        load();
      })
      .catch((caught: unknown) => { toast.show({ message: `The profile was not changed: ${messageOf(caught)}` }); })
      .finally(() => { setBusy(false); });
  };

  const importFile = (f: File) => {
    void f.text().then((text) => {
      const parsed = parseProfile(text);
      if (!parsed.ok) {
        toast.show({ message: `${f.name} is not a profile that can be imported: ${parsed.problems[0]?.path === '' ? '' : `${parsed.problems[0]?.path ?? ''}: `}${parsed.problems[0]?.message ?? ''}` });
        return;
      }
      setSaveError(null);
      setMode({ kind: 'new', draft: fromProfile(parsed.profile) });
    });
  };

  const exportProfile = (p: Profile) => {
    const blob = new Blob([serializeProfile(p)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${p.name.replace(/[^\w.-]+/g, '-')}.profile.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Page className="fs-screen">
      <PageHeader
        title="Jurisdiction profiles"
        count={rows.length}
        countNoun={{ one: 'profile', other: 'profiles' }}
        description="Which code editions and local amendments a project's findings are evaluated against. Every value cites its source; no code text is copied."
        actions={
          <>
            <input ref={file} type="file" accept="application/json,.json" hidden aria-hidden="true" tabIndex={-1} onChange={(e) => {
              const f = e.target.files?.[0];
              if (f !== undefined) importFile(f);
              e.target.value = '';
            }} />
            <Button variant="secondary" icon={<Upload />} onClick={() => { file.current?.click(); }}>
              Import JSON
            </Button>
            <Button
              variant="primary"
              icon={<Plus />}
              onClick={() => {
                setSaveError(null);
                setMode({ kind: 'new', draft: fromProfile(startingProfile('New profile')) });
              }}
            >
              New profile
            </Button>
          </>
        }
      />
      {project === null ? null : (
        <p className="fs-coverage-note">
          Choosing for <Link href={`/projects/${project.detail.id}/findings`}>{project.detail.name}</Link>, now evaluated under{' '}
          {rows.find((r) => r.id === (project.profileId ?? DEFAULT))?.profile.name ?? 'the default'}.
        </p>
      )}
      <div className="fs-profiles">
        <ul className="fs-profile-list" aria-label="Profiles">
          {rows.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                className="fs-profile-item"
                aria-current={r.id === current?.id && mode.kind === 'view' ? 'true' : undefined}
                onClick={() => {
                  setSelected(r.id);
                  setMode({ kind: 'view' });
                }}
              >
                <span className="fs-profile-item__name">
                  <MapPin aria-hidden="true" width={14} height={14} /> {r.profile.name}
                </span>
                <span className="fs-profile-item__line">{editionsLine(r.profile) || 'No edition adopted'}</span>
                <span className="fs-profile-item__line">
                  {r.id === DEFAULT ? (data.default.source === 'standard' ? 'The standard’s default' : 'This server’s default') : `${String(r.profile.amendments?.length ?? 0)} ${r.profile.amendments?.length === 1 ? 'amendment' : 'amendments'}`} ·{' '}
                  {r.projects.length === 1 ? 'used by 1 project' : `used by ${String(r.projects.length)} projects`}
                </span>
                {r.id === DEFAULT ? <Badge size="sm" tone="attention">Default</Badge> : null}
              </button>
            </li>
          ))}
        </ul>
        <div className="fs-profile-detail">
          {mode.kind !== 'view' ? (
            <Builder
              key={mode.kind === 'edit' ? mode.id : 'new'}
              initial={mode.draft}
              title={mode.kind === 'edit' ? `Edit ${mode.draft.name}` : 'New profile'}
              busy={busy}
              error={saveError}
              ruleRefs={ruleRefs}
              onSave={save}
              onCancel={() => { setMode({ kind: 'view' }); }}
            />
          ) : current === undefined ? null : (
            <>
              <div className="fs-profile-detail__head">
                <div>
                  <h2>{current.profile.name}</h2>
                  <p>
                    {[
                      current.profile.jurisdiction,
                      isDefault ? 'Model codes as published, with no amendment (Floorspec Rules 10.6)' : null,
                      current.profile.asOf === undefined ? 'no evaluation date: every adoption applies' : `evaluated as of ${current.profile.asOf}`,
                      current.projects.length === 1 ? 'used by 1 project' : `used by ${String(current.projects.length)} projects`,
                    ]
                      .filter((x): x is string => typeof x === 'string')
                      .join(' · ')}
                  </p>
                </div>
                <div className="fs-profile-detail__actions">
                  {projectId !== null && project !== null ? (
                    <Button
                      variant="primary"
                      loading={busy}
                      disabled={(project.profileId ?? DEFAULT) === current.id}
                      onClick={() => { use(isDefault ? null : current.id); }}
                    >
                      {(project.profileId ?? DEFAULT) === current.id ? `Used for ${project.detail.name}` : `Use for ${project.detail.name}`}
                    </Button>
                  ) : null}
                  {isDefault ? null : (
                    <Button variant="secondary" icon={<Pencil />} onClick={() => {
                      setSaveError(null);
                      setMode({ kind: 'edit', id: current.id, draft: fromProfile(current.profile) });
                    }}>
                      Edit
                    </Button>
                  )}
                  <Button variant="secondary" icon={<Copy />} onClick={() => {
                    setSaveError(null);
                    setMode({ kind: 'new', draft: { ...fromProfile(current.profile), name: `${current.profile.name} (copy)` } });
                  }}>
                    Duplicate
                  </Button>
                  <Button variant="ghost" icon={<Download />} onClick={() => { exportProfile(current.profile); }}>
                    Export JSON
                  </Button>
                  {isDefault ? null : (
                    <Button variant="danger-ghost" icon={<Trash2 />} onClick={() => { setConfirmDelete(true); }}>
                      Delete
                    </Button>
                  )}
                </div>
              </div>
              <Editions profile={current.profile} />
              <Amendments profile={current.profile} />
              {current.projects.length === 0 ? null : (
                <p className="fs-coverage-note">
                  Used by{' '}
                  {current.projects.map((p, i) => (
                    <span key={p.id}>
                      {i === 0 ? '' : ', '}
                      <Link href={`/projects/${p.id}/findings`}>{p.name}</Link>
                    </span>
                  ))}
                  .
                </p>
              )}
              <p className="fs-coverage-note">
                A profile is your own data: it names editions and cites amendments by reference. It decides which rules are evaluated, never whether a design meets a code — the authority having jurisdiction decides that.
              </p>
            </>
          )}
        </div>
      </div>
      <Modal
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        destructive
        title={`Delete ${current?.profile.name ?? 'this profile'}?`}
        footer={
          <>
            <Button variant="secondary" onClick={() => { setConfirmDelete(false); }}>
              Keep it
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                if (current === undefined || isDefault) return;
                deleteProfile(current.id)
                  .then(() => {
                    toast.show({ message: `${current.profile.name} was deleted.` });
                    setConfirmDelete(false);
                    setSelected(DEFAULT);
                    load();
                    if (project !== null && project.profileId === current.id) setProject({ ...project, profileId: null });
                  })
                  .catch((caught: unknown) => { toast.show({ message: messageOf(caught) }); });
              }}
            >
              Delete
            </Button>
          </>
        }
      >
        {current !== undefined && current.projects.length > 0
          ? `${current.projects.map((p) => p.name).join(', ')} ${current.projects.length === 1 ? 'goes' : 'go'} back to the default profile, and ${current.projects.length === 1 ? 'its' : 'their'} findings are evaluated again.`
          : 'No project uses it. The audit trail keeps a copy.'}
      </Modal>
    </Page>
  );
}

const STATUS: Record<AdoptionView['status'], { label: string; tone: 'attention' | 'neutral' | 'warning' }> = {
  inForce: { label: 'In force', tone: 'attention' },
  superseded: { label: 'Superseded', tone: 'neutral' },
  notYet: { label: 'Not yet in effect', tone: 'warning' },
};

function Editions({ profile }: { profile: Profile }) {
  const views = adoptionViews(profile);
  const columns: TableColumn<AdoptionView>[] = [
    { key: 'domain', header: 'Domain', width: '8rem', cell: (v) => domainTitle(v.domain) },
    { key: 'code', header: 'Code · edition', cell: (v) => (
      <span>
        <span className="fs-mono">
          {v.adoption.code} {v.adoption.edition}
        </span>
        {v.title === undefined ? null : <span className="fs-profile-item__line"> · {v.title}</span>}
      </span>
    ) },
    { key: 'effective', header: 'Effective', width: '8rem', cell: (v) => <span className="fs-mono">{v.adoption.effective ?? 'not stated'}</span> },
    {
      key: 'status',
      header: 'Status',
      width: '10rem',
      cell: (v) => (
        <Badge size="sm" tone={STATUS[v.status].tone}>
          {STATUS[v.status].label}
        </Badge>
      ),
    },
  ];
  return (
    <Card className="fs-section-card">
      <h3>
        <BookOpen aria-hidden="true" />
        Editions
      </h3>
      {views.length === 0 ? (
        <p className="fs-coverage-note">No edition adopted: no rule is in force under this profile.</p>
      ) : (
        <Table caption="Editions" captionHidden density="compact" columns={columns} rows={views} rowKey={(v) => String(v.index)} />
      )}
    </Card>
  );
}

function Amendments({ profile }: { profile: Profile }) {
  const amendments = profile.amendments ?? [];
  const applies = new Map(withdrawals(profile).map((w) => [w.amendment, w.applies]));
  return (
    <Card className="fs-section-card">
      <h3>
        <ScrollText aria-hidden="true" />
        Local amendments · {amendments.length}
      </h3>
      {amendments.length === 0 ? (
        <p className="fs-coverage-note">None: the adopted editions are evaluated as published.</p>
      ) : (
        <ul className="fs-amendments">
          {amendments.map((m, i) => (
            <li key={i}>
              <span>
                <span className="fs-amendments__ref">{m.citation.reference}</span> · {m.citation.authority}
                {m.citation.link === undefined ? null : (
                  <>
                    {' '}
                    <a className="fs-viewer-link" href={m.citation.link} target="_blank" rel="noopener noreferrer">
                      Source
                      <ExternalLink aria-hidden="true" />
                      <span className="fs-visually-hidden"> (opens in a new tab)</span>
                    </a>
                  </>
                )}
              </span>
              <span className="fs-amendments__meta">
                Withdraws <span className="fs-mono">{m.withdraws.map((w) => `${w.pack}/${w.rule}`).join(', ')}</span>
                {m.effective === undefined ? '' : ` · effective ${m.effective}`}
                {applies.get(i) === false ? ' · not yet in effect' : ''}
              </span>
              {m.note === undefined ? null : <span>{m.note}</span>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
