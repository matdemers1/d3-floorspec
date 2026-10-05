import '../components/screens.css';
import './energy.css';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Button, Card, DescriptionItem, DescriptionList, EmptyState, Link, Page, PageHeader, Skeleton, Stat, StatGroup, StatusDot, Table, useToast, type TableColumn } from '@d3cloud/ui';
import {
  annualRange,
  area,
  assemblyQuantity,
  assemblyValue,
  degreeDays,
  hourText,
  loadRange,
  loss,
  percent,
  sunDay,
  temperature,
  type AssemblyRow,
  type EnergyEstimate,
  type EnergyInputs,
  type FacadeRow,
  type OptionRow,
  type UnitSystem,
} from '@floorspec/analysis';
import { ChevronRight, Flame, GitBranch, LayoutGrid, MapPin, PanelsTopLeft, Settings, Wind } from 'lucide-react';
import { api, ApiError, messageOf } from '../lib/api';
import { useLiveTick } from '../dashboard/live';
import { postBatch } from '../editor/api';
import { readModel, type EditorModel } from '../editor/model';
import { unitsOf } from '../editor/units';
import type { ProjectDetail } from '../screens/Project';
import { estimateOf, hasInputs, setInputs } from './model';
import { InputsDialog } from './InputsDialog';

type State =
  | { status: 'loading' }
  | { status: 'missing' }
  | { status: 'failed'; message: string }
  | { status: 'ready'; project: ProjectDetail; model: EditorModel | null };

const NAMES: Record<FacadeRow['orientation'], string> = { N: 'North', E: 'East', S: 'South', W: 'West' };

/**
 * `/projects/:id/energy` — the advisory energy and comfort estimate (FLR-T-12.6, FLR-REQ-153; the
 * board's "27 · Energy & comfort — advisory"): design loads and a typical year as ranges, the
 * façades by orientation, every assembly with the value assumed and where it came from, comfort
 * notes naming rooms and openings, and the design options side by side. Worked out in the browser
 * from main by @floorspec/analysis; live, like the schedules. An estimate to compare options — never
 * an energy-code calculation, and the page says so before it says anything else.
 */
export function EnergyScreen({ id }: { id: string }) {
  const [state, setState] = useState<State>({ status: 'loading' });
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const toast = useToast();
  const tick = useLiveTick(id);

  const load = useCallback(
    (quiet: boolean) => {
      if (!quiet) setState({ status: 'loading' });
      api
        .get<ProjectDetail>(`/api/projects/${id}`)
        .then(async (project) => {
          if (project.head === null) return { project, model: null };
          const res = await fetch(`/api/projects/${id}/model.json`, { credentials: 'same-origin' });
          if (!res.ok) throw new ApiError(res.status, 'the model did not load');
          return { project, model: readModel(project.head.version, await res.text()) };
        })
        .then(({ project, model }) => { setState({ status: 'ready', project, model }); })
        .catch((caught: unknown) => {
          if (caught instanceof ApiError && caught.status === 404) setState({ status: 'missing' });
          else setState({ status: 'failed', message: messageOf(caught) });
        });
    },
    [id],
  );
  useEffect(() => { load(tick > 0); }, [load, tick]);

  const model = state.status === 'ready' ? state.model : null;
  const document = model?.document ?? null;
  const units = unitsOf(document);
  const estimated = useMemo(() => estimateOf(document), [document]);

  if (state.status === 'missing') {
    return (
      <Page className="fs-screen">
        <EmptyState kind="no-results" heading="That project does not exist" action={<Link href="/">All projects</Link>}>
          It may have been deleted, or it is not yours.
        </EmptyState>
      </Page>
    );
  }
  if (state.status === 'failed') {
    return (
      <Page className="fs-screen">
        <EmptyState kind="error" heading="The estimate did not load" action={<Button variant="secondary" onClick={() => { load(false); }}>Try again</Button>}>
          {state.message}
        </EmptyState>
      </Page>
    );
  }
  if (state.status === 'loading') {
    return (
      <Page className="fs-screen" aria-busy="true" aria-label="Loading the estimate">
        <Skeleton variant="text" width={200} />
        <Skeleton variant="text" width={320} height={28} />
        <Skeleton variant="block" width="100%" height={420} />
      </Page>
    );
  }

  const { project } = state;
  const estimate = estimated.status === 'ok' ? estimated.estimate : null;

  function save(inputs: EnergyInputs) {
    if (state.status !== 'ready' || state.model === null) return;
    setSaving(true);
    setSaveError(null);
    const batch = setInputs(inputs, hasInputs(state.model.document));
    if (batch.length === 0) {
      setSaving(false);
      setEditing(false);
      return;
    }
    void postBatch(project.id, state.model.hash, batch).then((answer) => {
      setSaving(false);
      if (answer.status === 'committed') {
        setEditing(false);
        toast.show({ message: Object.keys(inputs).length === 0 ? 'Back to the typical values.' : 'Saved. Undo in the editor takes it back.' });
        load(true);
      } else if (answer.status === 'stale') {
        setSaveError('The plan changed while you were editing. It has been reloaded: save again.');
        load(true);
      } else setSaveError(answer.status === 'rejected' ? answer.detail : answer.message);
    });
  }

  return (
    <Page className="fs-screen fs-energy">
      <nav aria-label="Breadcrumb">
        <ol className="fs-breadcrumb">
          <li>
            <Link href="/" variant="muted">
              Projects
            </Link>
          </li>
          <li aria-hidden="true">
            <ChevronRight />
          </li>
          <li>
            <Link href={`/projects/${project.id}`} variant="muted">
              {project.name}
            </Link>
          </li>
          <li aria-hidden="true">
            <ChevronRight />
          </li>
          <li aria-current="page">Energy &amp; comfort</li>
        </ol>
      </nav>
      <PageHeader
        title="Energy & comfort"
        description={`An estimate to compare options — not an energy-code calculation.${estimate?.design ? ` Primary design.` : ''}`}
        actions={
          <Button variant="secondary" icon={<Settings />} disabled={estimate === null} onClick={() => { setSaveError(null); setEditing(true); }}>
            Climate &amp; assumptions
          </Button>
        }
      />
      {estimate === null ? (
        <EmptyState kind="empty" heading="No estimate yet">
          {estimated.status === 'none' ? estimated.message : ''} Draw walls, rooms and windows — the estimate follows the plan.
        </EmptyState>
      ) : (
        <Estimate estimate={estimate} units={units} />
      )}
      {estimate !== null && document !== null ? (
        <InputsDialog open={editing} onOpenChange={setEditing} document={document} estimate={estimate} units={units} saving={saving} error={saveError} onSave={save} />
      ) : null}
    </Page>
  );
}

function Estimate({ estimate: e, units }: { estimate: EnergyEstimate; units: UnitSystem }) {
  const heating = loadRange(e.loads.heating, units);
  const cooling = loadRange(e.loads.cooling, units);
  const yearH = annualRange(e.loads.annualHeating);
  const yearC = annualRange(e.loads.annualCooling);
  const c = e.climate;
  return (
    <div className="fs-dashboard-wrap">
      <div className="fs-dashboard">
        <div className="fs-dashboard__col fs-dashboard__col--main">
          <StatGroup role="group" aria-label="Loads" className="fs-energy__stats">
            <Stat label="Heating design load" value={heating.text} unit={heating.unit} footnote={`${temperature(c.heatingDesign, units)} out · ${temperature(c.indoorWinter, units)} in`} />
            <Stat label="Cooling design load" value={cooling.text} unit={cooling.unit} footnote={`${temperature(c.coolingDesign, units)} out · ${hourText(e.loads.coolingHour)} sun`} />
            <Stat label="Heating, typical year" value={yearH.text} unit={yearH.unit} footnote={`${degreeDays(c.hdd, units)} · heat, not fuel`} />
            <Stat label="Cooling, typical year" value={yearC.text} unit={yearC.unit} footnote={`${degreeDays(c.cdd, units)} · sun not included`} />
          </StatGroup>
          <Facades estimate={e} units={units} />
          <Assemblies estimate={e} units={units} />
        </div>
        <div className="fs-dashboard__col">
          <Alert tone="info" title="Advisory — for comparing options">
            From the walls, windows and orientation you drew, by a simple steady-state method. Not a Manual J load or an energy-code calculation, and never a statement that the house meets a code.
          </Alert>
          {e.problems.length > 0 ? (
            <Alert tone="warning" title="Some saved values were not used">
              {e.problems.map((p) => p.message).join('; ')}. Open Climate &amp; assumptions to set them again.
            </Alert>
          ) : null}
          <Card as="section" className="fs-card" aria-labelledby="fs-energy-climate">
            <div className="fs-card-head">
              <MapPin aria-hidden="true" />
              <h2 id="fs-energy-climate" className="fs-card-head__title">
                Climate
              </h2>
              <span className="fs-spacer" />
              {c.source === 'assumed' ? <Badge size="sm" tone="warning">Assumed</Badge> : null}
            </div>
            <p className="fs-energy__lead">{c.label}</p>
            <DescriptionList>
              <DescriptionItem term="Design temperatures">{`${temperature(c.heatingDesign, units)} / ${temperature(c.coolingDesign, units)} out · ${temperature(c.indoorWinter, units)} / ${temperature(c.indoorSummer, units)} in`}</DescriptionItem>
              <DescriptionItem term="Degree days, heat / cool">{`${degreeDays(c.hdd, units)} / ${degreeDays(c.cdd, units)}`}</DescriptionItem>
              <DescriptionItem term="Latitude, for the sun">{`${c.latitude.toFixed(1)}° ${c.latitude >= 0 ? 'N' : 'S'} (${c.latitudeSource === 'site' ? 'site' : 'assumed'})`}</DescriptionItem>
            </DescriptionList>
            <p className="fs-caption">Presets are rounded values for one city in each zone; set your site’s own from ASHRAE climatic design data.</p>
          </Card>
          <Notes estimate={e} />
          {e.options !== undefined ? <Options rows={e.options} units={units} /> : null}
          <Card as="section" className="fs-card" aria-labelledby="fs-energy-assumed">
            <div className="fs-card-head">
              <PanelsTopLeft aria-hidden="true" />
              <h2 id="fs-energy-assumed" className="fs-card-head__title">
                What this assumes
              </h2>
            </div>
            <ul className="fs-energy__assumed">
              {e.assumptions.map((a) => (
                <li key={a.key}>{a.text}</li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Facades({ estimate: e, units }: { estimate: EnergyEstimate; units: UnitSystem }) {
  const total = e.facades.reduce((s, f) => ({ wall: s.wall + f.wallArea, win: s.win + f.windowArea, july: s.july + f.solarJuly, jan: s.jan + f.solarJanuary }), { wall: 0, win: 0, july: 0, jan: 0 });
  type Row = { key: string; name: string; wall: string; win: string; wwr: string; july: string; jan: string };
  const rows: Row[] = [
    ...e.facades.map((f) => ({ key: f.orientation, name: NAMES[f.orientation], wall: area(f.wallArea, units), win: area(f.windowArea, units), wwr: percent(f.wwr), july: sunDay(f.solarJuly), jan: sunDay(f.solarJanuary) })),
    { key: 'all', name: 'Whole house', wall: area(total.wall, units), win: area(total.win, units), wwr: percent(total.wall > 0 ? total.win / total.wall : null), july: sunDay(total.july), jan: sunDay(total.jan) },
  ];
  const columns: TableColumn<Row>[] = [
    { key: 'name', header: 'Façade', cell: (r) => <strong className="fs-energy__strong">{r.name}</strong> },
    { key: 'wall', header: 'Wall', numeric: true },
    { key: 'win', header: 'Windows', numeric: true },
    { key: 'wwr', header: 'Window-to-wall', numeric: true },
    { key: 'july', header: 'Sun on glass, July', numeric: true },
    { key: 'jan', header: 'January', numeric: true },
  ];
  return (
    <Card as="section" className="fs-card" aria-labelledby="fs-energy-facades">
      <div className="fs-card-head">
        <LayoutGrid aria-hidden="true" />
        <h2 id="fs-energy-facades" className="fs-card-head__title">
          Façades
        </h2>
      </div>
      <Table columns={columns} rows={rows} rowKey={(r) => r.key} caption="Wall and window area by the way each wall faces" captionHidden />
      <p className="fs-caption">Gross wall area by the way each wall faces true north. Sun on glass: clear-sky solar heat gain through the windows on the 21st, after their SHGC.</p>
    </Card>
  );
}

function Assemblies({ estimate: e, units }: { estimate: EnergyEstimate; units: UnitSystem }) {
  const columns: TableColumn<AssemblyRow>[] = [
    { key: 'label', header: 'Assembly', cell: (a) => <strong className="fs-energy__strong">{a.label}</strong>, width: '30%' },
    { key: 'quantity', header: 'Area', numeric: true, cell: (a) => assemblyQuantity(a, units) },
    { key: 'value', header: 'Assumed', numeric: true, cell: (a) => assemblyValue(a, units) },
    { key: 'ua', header: 'Loss', numeric: true, cell: (a) => loss(a.ua, units) },
    { key: 'source', header: 'Where it came from', cell: (a) => (a.source === 'yours' ? <span>{a.sourceText}</span> : <span className="fs-energy__muted">{a.sourceText}</span>), width: '34%' },
  ];
  return (
    <Card as="section" className="fs-card" aria-labelledby="fs-energy-envelope">
      <div className="fs-card-head">
        <Flame aria-hidden="true" />
        <h2 id="fs-energy-envelope" className="fs-card-head__title">
          Envelope · what was assumed
        </h2>
        <span className="fs-spacer" />
        <span className="fs-energy__muted">{`Whole house ${loss(e.loads.ua, units)}`}</span>
      </div>
      <Table className="fs-energy__envelope" columns={columns} rows={e.assemblies} rowKey={(a) => `${a.kind}:${a.key}`} caption="Each assembly's area, the value assumed for it, its heat loss and where the value came from" captionHidden />
    </Card>
  );
}

function Notes({ estimate: e }: { estimate: EnergyEstimate }) {
  return (
    <Card as="section" className="fs-card" aria-labelledby="fs-energy-notes">
      <div className="fs-card-head">
        <Wind aria-hidden="true" />
        <h2 id="fs-energy-notes" className="fs-card-head__title">
          Comfort notes
        </h2>
        <span className="fs-spacer" />
        <Badge size="sm" tone="neutral">
          {String(e.notes.length)}
        </Badge>
      </div>
      {e.notes.length === 0 ? (
        <p className="fs-card-text">Nothing to note: no large west glass, and every room people spend time in has windows that open on two sides.</p>
      ) : (
        <ul className="fs-energy__notes">
          {e.notes.map((n) => (
            <li key={`${n.kind}:${n.rooms.join(',')}:${n.openings.join(',')}`}>
              <StatusDot tone={n.severity === 'warning' ? 'warning' : 'neutral'}>{n.title}</StatusDot>
              <span className="fs-energy__detail">{n.detail}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Options({ rows, units }: { rows: OptionRow[]; units: UnitSystem }) {
  const base = rows[0];
  if (base === undefined) return null;
  const delta = (a: number, b: number): string => {
    if (b === 0) return '';
    const d = Math.round(((a - b) / b) * 100);
    return d === 0 ? ' · same' : ` · ${d > 0 ? '+' : '−'}${String(Math.abs(d))}%`;
  };
  const columns: TableColumn<OptionRow>[] = [
    { key: 'label', header: 'Design', cell: (o) => <strong className="fs-energy__strong">{o.label}</strong> },
    { key: 'heating', header: 'Heating', numeric: true, cell: (o) => `${loadRange(o.heating, units).text}${o === base ? '' : delta(o.heating, base.heating)}` },
    { key: 'cooling', header: 'Cooling', numeric: true, cell: (o) => `${loadRange(o.cooling, units).text}${o === base ? '' : delta(o.cooling, base.cooling)}` },
  ];
  return (
    <Card as="section" className="fs-card" aria-labelledby="fs-energy-options">
      <div className="fs-card-head">
        <GitBranch aria-hidden="true" />
        <h2 id="fs-energy-options" className="fs-card-head__title">
          Design options
        </h2>
      </div>
      <Table columns={columns} rows={rows} rowKey={(o) => o.tag ?? 'primary'} caption={`Design loads, ${loadRange(base.heating, units).unit}, each design against the primary`} captionHidden />
      <p className="fs-caption">Each design estimated on its own walls and windows, with the same climate and assumptions.</p>
    </Card>
  );
}
