import { useMemo } from 'react';
import { Alert, Badge, Button, IconButton, Modal, Select, Spinner } from '@d3cloud/ui';
import { Check, CircleCheck, Info, Sparkles, TriangleAlert, X } from 'lucide-react';
import { useEditor, type EditorStore, type Review } from './store';
import { labelOf, type EditorModel } from './model';
import { describeOp } from './describe';
import { diffModels, groupChanges, roomEffects } from './diff';
import { accept, closeReview, needsRebase, openReview, reject, reviewTarget } from './review';
import { timeAgo } from '../projects/model';

/**
 * The proposal panel (FLR-T-3.5), the board's "09 · Changeset review": what an agent proposed,
 * drawn over the plan, with its operations, their effect, and Accept or Reject. When the plan has
 * moved since the proposal was made, the panel says so, shows the rebased result, and Accept asks
 * a second time. A proposal that no longer applies says why, and only Reject is offered.
 */
export function ProposalPanel({ store }: { store: EditorStore }) {
  const review = useEditor(store, (s) => s.review);
  const main = useEditor(store, (s) => s.model);
  const proposals = useEditor(store, (s) => s.proposals);
  const units = useEditor(store, () => store.units);
  const target = reviewTarget(review, main);
  const effects = useMemo(() => (target === null || main === null ? null : { diff: diffModels(main, target, units), rooms: roomEffects(main, target, units) }), [main, target, units]);
  if (review === null || main === null) return null;
  const rebased = needsRebase(review, main);
  const failed = review.failure !== null && review.failure.against === main.hash;
  const name = (id: string) => (target?.index.has(id) === true ? labelOf(target, id) : main.index.has(id) ? labelOf(main, id) : id);
  const ops = review.log.flatMap((entry, i) => entry.ops.map((op, j) => ({ key: `${String(entry.seq)}-${String(j)}`, batch: i, op })));
  const status = failed ? <Badge tone="danger">Does not apply</Badge> : rebased ? <Badge tone="warning">Rebased</Badge> : <Badge tone="attention">Pending</Badge>;

  return (
    <div className="fs-inspector__body fs-review" aria-label="Proposed changes">
      <div className="fs-inspector__head">
        <span className="fs-inspector__icon fs-review__icon">
          <Sparkles />
        </span>
        <div className="fs-inspector__title">
          <h2>{review.name}</h2>
          <p>
            {review.createdBy === '' ? 'Loading…' : `${review.createdBy} · ${timeAgo(review.createdAt)} · ${String(ops.length)} ${ops.length === 1 ? 'op' : 'ops'}`}
          </p>
        </div>
        {status}
        <IconButton size="sm" label="Close the proposal" icon={<X />} onClick={() => { closeReview(store); }} />
      </div>

      {proposals.length > 1 ? (
        <Select
          aria-label="Proposal"
          appearance="filled"
          options={proposals.map((p) => ({ value: p.id, label: `${p.name} · ${p.createdBy ?? 'agent'}` }))}
          value={review.id}
          onValueChange={(id) => void openReview(store, id)}
        />
      ) : null}

      {review.loading && review.proposed === null ? <Spinner label="Loading the proposal" /> : null}

      {failed && review.failure !== null ? (
        <Alert tone="danger" title={review.failure.source === 'server' ? 'The replay failed — nothing was merged' : 'This no longer applies to the plan'}>
          <p>{review.failure.detail}</p>
          <ul className="fs-review__diags">
            {review.failure.diagnostics.map((d, i) => (
              <li key={`${d.code}-${String(i)}`}>
                <span className="fs-mono-small">{d.code}</span> {d.message}
                {d.elements.length > 0 ? (
                  <span className="fs-review__els">
                    {' '}
                    {d.elements.map((id) => (
                      <button key={id} type="button" className="fs-linkish" onClick={() => { store.select(id, { keepSide: true }); }}>
                        {name(id)}
                      </button>
                    ))}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
          <p className="fs-note">The elements are outlined on the plan. Reject it, or ask the agent to propose again against the plan as it is.</p>
        </Alert>
      ) : rebased && review.rebased !== null ? (
        <Alert tone="warning" title="The plan changed after this was proposed">
          {review.rebased.differs.length === 0
            ? 'Every operation replays onto your latest changes the same way. Review the rebased result before accepting.'
            : `${String(review.rebased.differs.length)} ${review.rebased.differs.length === 1 ? 'batch lands' : 'batches land'} differently on your latest changes (marked below). Review the rebased result before accepting.`}
        </Alert>
      ) : null}

      <section className="fs-section" aria-label="Operations">
        <div className="fs-section__head">
          <h3 className="fs-overline">Operations · {String(ops.length)}</h3>
        </div>
        <ul className="fs-review__ops">
          {ops.map(({ key, batch, op }) => {
            const [kind, what] = describeOp(op, units, name);
            const differs = review.rebased?.against === main.hash && review.rebased.differs.includes(batch);
            const broke = failed && review.failure?.failedIndex === batch;
            return (
              <li key={key} className={['fs-review__op', differs ? 'is-differs' : '', broke ? 'is-broken' : ''].join(' ')}>
                <span className="fs-review__opname">{kind}</span>
                <span className="fs-review__optarget">{what}</span>
                {differs ? <span className="fs-review__flag">landed differently</span> : broke ? <span className="fs-review__flag">fails here</span> : null}
              </li>
            );
          })}
        </ul>
      </section>

      {effects !== null && !failed ? <Effect store={store} review={review} main={main} target={target as EditorModel} effects={effects} /> : null}

      <div className="fs-review__actions">
        <Button
          variant="primary"
          icon={<Check />}
          loading={review.busy === 'accept'}
          disabled={review.busy !== null || review.loading || failed || target === null}
          onClick={() => void accept(store)}
        >
          {rebased ? 'Accept rebased' : 'Accept changeset'}
        </Button>
        <Button variant="secondary" loading={review.busy === 'reject'} disabled={review.busy !== null} onClick={() => void reject(store)}>
          Reject
        </Button>
      </div>
      <p className="fs-note">Nothing in a proposal is in the plan until you accept it. Accepting is an edit like any other: Undo takes it back.</p>

      <Modal
        open={review.confirming}
        onOpenChange={(open) => {
          if (!open) store.set({ review: { ...review, confirming: false } });
        }}
        title={`Accept “${review.name}” rebased?`}
        description="It was proposed against an earlier version of the plan. What will be merged is the rebased result now drawn on the plan — not exactly what was proposed."
        footer={
          <>
            <Button variant="ghost" onClick={() => { store.set({ review: { ...review, confirming: false } }); }}>
              Keep reviewing
            </Button>
            <Button variant="primary" autoFocus onClick={() => void accept(store, true)}>
              Accept rebased
            </Button>
          </>
        }
      >
        <p className="fs-note">
          {effects === null ? '' : `${String(effects.diff.counts.added)} added, ${String(effects.diff.counts.removed)} removed, ${String(effects.diff.counts.moved)} moved or reshaped, ${String(effects.diff.counts.changed)} changed.`}{' '}
          If the plan moves again before this lands, nothing is merged and you review it once more.
        </p>
      </Modal>
    </div>
  );
}

function Effect({ store, review, main, target, effects }: { store: EditorStore; review: Review; main: EditorModel; target: EditorModel; effects: { diff: ReturnType<typeof diffModels>; rooms: ReturnType<typeof roomEffects> } }) {
  const findingsBefore = main.diagnostics.length;
  const findingsAfter = target.diagnostics.length;
  const groups = groupChanges(effects.diff);
  return (
    <section className="fs-section" aria-label="Effect">
      <div className="fs-section__head">
        <h3 className="fs-overline">Effect</h3>
      </div>
      {effects.rooms.length > 0 ? (
        <dl className="fs-review__effects">
          {effects.rooms.map((r) => (
            <div key={r.id} className="fs-review__effect">
              <dt>{r.name}</dt>
              <dd>{r.before === null ? `new · ${r.after ?? ''}` : r.after === null ? `${r.before} · removed` : `${r.before} → ${r.after}`}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      <ul className="fs-review__checks">
        <li>
          {target.valid ? <CircleCheck className="fs-ok" aria-hidden="true" /> : <TriangleAlert className="fs-bad" aria-hidden="true" />}
          {target.valid ? 'Invariants hold — the model stays valid' : 'The result does not validate'}
        </li>
        <li>
          <Info className="fs-faint" aria-hidden="true" />
          Findings {findingsBefore === findingsAfter ? 'unchanged' : 'change'}: {String(findingsBefore)} → {String(findingsAfter)}
        </li>
      </ul>
      {groups.map((g) => (
        <div key={g.kind} className="fs-changes">
          <h4 className={`fs-changes__title fs-changes__title--${g.kind}`}>
            {g.title} · {String(g.changes.length)}
          </h4>
          <ul>
            {g.changes.map((c) => (
              <li key={c.id}>
                <button type="button" className="fs-linkish" disabled={g.kind === 'removed' || c.collection === 'project'} onClick={() => { store.select(c.id, { keepSide: true }); }}>
                  {c.label}
                </button>
                {c.detail === undefined ? null : <span className="fs-changes__detail">{c.detail}</span>}
              </li>
            ))}
          </ul>
        </div>
      ))}
      {review.loading ? <Spinner size="sm" label="Updating" /> : null}
    </section>
  );
}
