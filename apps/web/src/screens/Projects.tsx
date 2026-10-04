import '../components/screens.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, EmptyState, Page, PageHeader, SearchField, Skeleton } from '@d3cloud/ui';
import { House, Plus, Upload } from 'lucide-react';
import { api, messageOf } from '../lib/api';
import { ImportFile } from '../projects/ImportFile';
import { eachLimited, loadModel } from '../projects/model';
import { NewProject } from '../projects/NewProject';
import { ProjectCard, type ModelState, type ProjectRow } from '../projects/ProjectCard';
import { Templates } from '../projects/TemplateCards';

export type { ProjectRow } from '../projects/ProjectCard';

/** How many head models are fetched at once while the list fills in. */
const MODEL_CONCURRENCY = 4;

type List = { status: 'loading' } | { status: 'failed'; message: string } | { status: 'ready'; rows: ProjectRow[] };

/**
 * Your projects (screen 03). Only yours: another account's projects are not listed, or reachable.
 * Each card's plan and numbers come from the project's head model, derived in the browser by
 * `@floorspec/engine` — the list endpoint knows names and dates, the engine knows the house.
 */
export function Projects() {
  const [list, setList] = useState<List>({ status: 'loading' });
  const [models, setModels] = useState<Record<string, ModelState>>({});
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const search = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    setList({ status: 'loading' });
    api
      .get<{ projects: ProjectRow[] }>('/api/projects')
      .then(({ projects }) => {
        setList({ status: 'ready', rows: projects });
        setModels(Object.fromEntries(projects.map((p) => [p.id, { status: 'loading' } as const])));
        void eachLimited(projects, MODEL_CONCURRENCY, async (p) => {
          const next: ModelState = await loadModel(p.id, p.head).then(
            (summary) => ({ status: 'ready', summary }),
            () => ({ status: 'failed' }),
          );
          setModels((current) => ({ ...current, [p.id]: next }));
        });
      })
      .catch((caught: unknown) => { setList({ status: 'failed', message: messageOf(caught) }); });
  }, []);
  useEffect(load, [load]);

  // "/" jumps to search, as the hint in the field says — unless you are already typing somewhere.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      event.preventDefault();
      search.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); };
  }, []);

  const rows = list.status === 'ready' ? list.rows : null;
  const shown = useMemo(() => {
    if (rows === null) return [];
    const q = query.trim().toLocaleLowerCase();
    if (q === '') return rows;
    return rows.filter((row) => {
      if (row.name.toLocaleLowerCase().includes(q)) return true;
      // Rooms are searchable once their model has loaded: "kitchen" finds every house with one.
      const model = models[row.id];
      const rooms = model?.status === 'ready' ? model.summary?.document?.rooms : undefined;
      return Object.values(rooms ?? {}).some((room) => room?.name?.toLocaleLowerCase().includes(q) === true);
    });
  }, [rows, query, models]);

  const newProject = (
    <Button variant="primary" icon={<Plus />} onClick={() => { setCreating(true); }}>
      New project
    </Button>
  );

  return (
    <Page className="fs-screen">
      <PageHeader
        title="Projects"
        {...(rows === null ? {} : { count: rows.length, countNoun: { one: 'project', other: 'projects' } })}
        description="Every house you are designing, with its latest version and what needs you."
        actions={newProject}
      />

      {list.status === 'failed' ? (
        <EmptyState
          kind="error"
          heading="Your projects did not load"
          action={
            <Button variant="secondary" onClick={load}>
              Try again
            </Button>
          }
        >
          {list.message}
        </EmptyState>
      ) : rows !== null && rows.length === 0 ? (
        <FirstHouse
          onNew={() => { setCreating(true); }}
          onImport={() => { setImporting(true); }}
        />
      ) : (
        <>
          <div className="fs-toolbar">
            <div className="fs-toolbar__search">
              <SearchField
                ref={search}
                aria-label="Search projects and rooms"
                placeholder="Search projects and rooms…"
                shortcut="/"
                value={query}
                onChange={(event) => { setQuery(event.target.value); }}
                disabled={rows === null}
              />
            </div>
            <span className="fs-spacer" />
            <Button variant="ghost" icon={<Upload />} onClick={() => { setImporting(true); }}>
              Import Floorspec file
            </Button>
          </div>

          {rows === null ? (
            <ul className="fs-project-grid" aria-busy="true" aria-label="Loading projects">
              {[0, 1, 2].map((i) => (
                <li key={i}>
                  <Skeleton variant="block" width="100%" height={326} />
                </li>
              ))}
            </ul>
          ) : shown.length === 0 ? (
            <EmptyState
              kind="no-results"
              size="inline"
              heading={`Nothing matches “${query.trim()}”`}
              action={
                <Button variant="secondary" size="sm" onClick={() => { setQuery(''); }}>
                  Clear the search
                </Button>
              }
            >
              Search looks at project names and the rooms in each house.
            </EmptyState>
          ) : (
            <ul className="fs-project-grid" aria-label="Projects">
              {shown.map((row) => (
                <li key={row.id}>
                  <ProjectCard project={row} model={models[row.id] ?? { status: 'loading' }} />
                </li>
              ))}
            </ul>
          )}

          <Templates onBlank={() => { setCreating(true); }} />
        </>
      )}

      <NewProject open={creating} onOpenChange={setCreating} />
      <ImportFile open={importing} onOpenChange={setImporting} />
    </Page>
  );
}

/** No projects yet: where to start, and the conversational route for those who prefer it. */
function FirstHouse({ onNew, onImport }: { onNew: () => void; onImport: () => void }) {
  return (
    <div className="fs-empty-wrap">
      <EmptyState
        kind="empty"
        icon={<House />}
        heading="Design your first house"
        action={
          <>
            <Button variant="primary" size="sm" onClick={onNew}>
              New project
            </Button>
            <Button variant="ghost" size="sm" icon={<Upload />} onClick={onImport}>
              Check a Floorspec file
            </Button>
          </>
        }
      >
        Start a blank project and draw it in the editor, or check a Floorspec file you already have.
      </EmptyState>
      <Alert tone="info" title="Prefer to talk it through?">
        Connect Claude Code with an MCP token from Account &amp; tokens. Claude proposes changes; you accept them.
      </Alert>
    </div>
  );
}
