import { useMemo, useState } from 'react';
import { Button, Card, FormField, IconButton, Input, Select, Textarea } from '@d3cloud/ui';
import { CODES, domainOf, domainTitle } from '@floorspec/rules-engine';
import { BookOpen, Plus, ScrollText, Trash2 } from 'lucide-react';
import { blankAmendment, editionsFor, nextAdoption, problemsOf, saveable, type Draft } from './draft';

const OTHER = '__other';

/**
 * The profile builder (FLR-T-6.8, FLR-REQ-100; the board's "12 · Jurisdiction profiles"): a name
 * and where it applies, the date it is evaluated at (`asOf`), the editions it adopts — each code, its
 * edition and the date it took effect — and the local amendments that withdraw rules, each cited by
 * reference (who made it, where, a link). Checked as it is typed by the rules engine's own checker
 * (Rules 10.1), each problem shown on its field; saved only when there is none.
 */
export function Builder({
  initial,
  title,
  busy,
  error,
  ruleRefs,
  onSave,
  onCancel,
}: {
  initial: Draft;
  title: string;
  busy: boolean;
  error: string | null;
  /** The installed packs' rules, `pack/rule`, offered when an amendment names what it withdraws. */
  ruleRefs: readonly { pack: string; rule: string; title: string }[];
  onSave: (draft: Draft) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(initial);
  const [touched, setTouched] = useState(false);
  const problems = useMemo(() => problemsOf(draft), [draft]);
  const shown = (path: string) => (touched ? problems.get(path) : undefined);
  const set = (patch: Partial<Draft>) => { setDraft({ ...draft, ...patch }); };
  const packs = [...new Set(ruleRefs.map((r) => r.pack))];

  return (
    <form
      className="fs-builder"
      aria-label={title}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        setTouched(true);
        if (saveable(draft) !== null) onSave(draft);
      }}
    >
      <Card className="fs-section-card">
        <h3>
          <BookOpen aria-hidden="true" />
          {title}
        </h3>
        <div className="fs-builder__grid">
          <FormField label="Name" error={shown('name')}>
            <Input value={draft.name} invalid={shown('name') !== undefined} onChange={(e) => { set({ name: e.target.value }); }} />
          </FormField>
          <FormField label="Jurisdiction" optional error={shown('jurisdiction')} help="Where it applies: Town of Example, MA">
            <Input value={draft.jurisdiction} invalid={shown('jurisdiction') !== undefined} onChange={(e) => { set({ jurisdiction: e.target.value }); }} />
          </FormField>
          <FormField label="Evaluated as of" optional error={shown('asOf')} help="Empty: every adoption and amendment applies">
            <Input type="date" value={draft.asOf} invalid={shown('asOf') !== undefined} onChange={(e) => { set({ asOf: e.target.value }); }} />
          </FormField>
        </div>
      </Card>

      <Card className="fs-section-card">
        <h3>
          <BookOpen aria-hidden="true" />
          Editions adopted · {draft.adopts.length}
        </h3>
        <ul className="fs-builder__rows">
          {draft.adopts.map((a, i) => {
            const at = `adopts/${String(i)}`;
            const known = CODES.some((c) => c.code === a.code);
            const editions = editionsFor(a.code);
            const update = (patch: Partial<typeof a>) => { set({ adopts: draft.adopts.map((x, j) => (j === i ? { ...x, ...patch } : x)) }); };
            return (
              <li key={i} className="fs-builder__row" aria-label={`Adoption ${String(i + 1)}`}>
                <FormField label={known ? `Code · ${domainTitle(domainOf(a.code))}` : 'Code · your own'} error={shown(`${at}/code`)}>
                  {known ? (
                    <Select
                      aria-label={`Code of adoption ${String(i + 1)}`}
                      value={a.code}
                      options={[...CODES.map((c) => ({ value: c.code, label: `${c.code} — ${c.title}` })), { value: OTHER, label: 'Another code…' }]}
                      onValueChange={(v) => { update(v === OTHER ? { code: '', edition: '' } : { code: v, edition: editionsFor(v).at(-1) ?? a.edition }); }}
                    />
                  ) : (
                    <Input aria-label={`Code of adoption ${String(i + 1)}`} value={a.code} placeholder="TEST-CODE" invalid={shown(`${at}/code`) !== undefined} onChange={(e) => { update({ code: e.target.value.toUpperCase() }); }} />
                  )}
                </FormField>
                <FormField label="Edition" error={shown(`${at}/edition`)}>
                  {editions.length > 0 ? (
                    <Select aria-label={`Edition of adoption ${String(i + 1)}`} value={a.edition} options={editions.map((e) => ({ value: e, label: e }))} onValueChange={(v) => { update({ edition: v }); }} />
                  ) : (
                    <Input aria-label={`Edition of adoption ${String(i + 1)}`} value={a.edition} placeholder="2024" invalid={shown(`${at}/edition`) !== undefined} onChange={(e) => { update({ edition: e.target.value }); }} />
                  )}
                </FormField>
                <FormField label="Effective" optional error={shown(`${at}/effective`)}>
                  <Input aria-label={`Effective date of adoption ${String(i + 1)}`} type="date" value={a.effective} invalid={shown(`${at}/effective`) !== undefined} onChange={(e) => { update({ effective: e.target.value }); }} />
                </FormField>
                <IconButton label={`Remove adoption ${String(i + 1)}`} variant="ghost" icon={<Trash2 />} onClick={() => { set({ adopts: draft.adopts.filter((_, j) => j !== i) }); }} />
              </li>
            );
          })}
        </ul>
        <div>
          <Button type="button" size="sm" variant="secondary" icon={<Plus />} onClick={() => { set({ adopts: [...draft.adopts, nextAdoption(draft)] }); }}>
            Adopt an edition
          </Button>
        </div>
        <p className="fs-coverage-note">A jurisdiction moving to a new edition adopts both, each with the date it took effect; the one in force is the latest that applies on the evaluation date.</p>
      </Card>

      <Card className="fs-section-card">
        <h3>
          <ScrollText aria-hidden="true" />
          Local amendments · {draft.amendments.length}
        </h3>
        <datalist id="fs-rule-packs">
          {packs.map((p) => <option key={p} value={p} />)}
        </datalist>
        <datalist id="fs-rule-ids">
          {ruleRefs.map((r) => <option key={`${r.pack}/${r.rule}`} value={r.rule}>{`${r.pack}: ${r.title}`}</option>)}
        </datalist>
        {draft.amendments.length === 0 ? <p className="fs-coverage-note">No amendment: the adopted editions are checked as published.</p> : null}
        {draft.amendments.map((m, i) => {
          const at = `amendments/${String(i)}`;
          const update = (patch: Partial<typeof m>) => { set({ amendments: draft.amendments.map((x, j) => (j === i ? { ...x, ...patch } : x)) }); };
          return (
            <fieldset key={i} className="fs-builder__amendment">
              <legend className="fs-caption">Amendment {i + 1}</legend>
              <div className="fs-builder__grid">
                <FormField label="Authority" error={shown(`${at}/citation/authority`) ?? shown(`${at}/citation`)}>
                  <Input value={m.authority} placeholder="Town of Example" onChange={(e) => { update({ authority: e.target.value }); }} />
                </FormField>
                <FormField label="Reference" error={shown(`${at}/citation/reference`)} help="The ordinance, statute or code section">
                  <Input value={m.reference} placeholder="Ord. 2025-14 §3" onChange={(e) => { update({ reference: e.target.value }); }} />
                </FormField>
                <FormField label="Link" optional error={shown(`${at}/citation/link`)}>
                  <Input type="url" value={m.link} placeholder="https://" onChange={(e) => { update({ link: e.target.value }); }} />
                </FormField>
                <FormField label="Effective" optional error={shown(`${at}/effective`)}>
                  <Input type="date" value={m.effective} onChange={(e) => { update({ effective: e.target.value }); }} />
                </FormField>
              </div>
              <FormField label="What it changes" optional error={shown(`${at}/note`)} help="In your own words — a reference, never the ordinance's text">
                <Textarea rows={2} value={m.note} onChange={(e) => { update({ note: e.target.value }); }} />
              </FormField>
              <span className="fs-caption">Rules it withdraws</span>
              {m.withdraws.map((w, k) => {
                const wat = `${at}/withdraws/${String(k)}`;
                const updateW = (patch: Partial<typeof w>) => { update({ withdraws: m.withdraws.map((x, j) => (j === k ? { ...x, ...patch } : x)) }); };
                return (
                  <div key={k} className="fs-builder__withdraw">
                    <FormField label="Pack" error={shown(`${wat}/pack`) ?? (k === 0 ? shown(`${at}/withdraws`) : undefined)}>
                      <Input list="fs-rule-packs" value={w.pack} placeholder="us-model-latest" onChange={(e) => { updateW({ pack: e.target.value }); }} />
                    </FormField>
                    <FormField label="Rule" error={shown(`${wat}/rule`)}>
                      <Input list="fs-rule-ids" value={w.rule} placeholder="R314-1" onChange={(e) => { updateW({ rule: e.target.value }); }} />
                    </FormField>
                    <IconButton label={`Remove rule ${String(k + 1)} of amendment ${String(i + 1)}`} variant="ghost" icon={<Trash2 />} disabled={m.withdraws.length === 1} onClick={() => { update({ withdraws: m.withdraws.filter((_, j) => j !== k) }); }} />
                  </div>
                );
              })}
              <div className="fs-finding__actions">
                <Button type="button" size="sm" variant="ghost" icon={<Plus />} onClick={() => { update({ withdraws: [...m.withdraws, { pack: m.withdraws.at(-1)?.pack ?? '', rule: '' }] }); }}>
                  Withdraw another rule
                </Button>
                <Button type="button" size="sm" variant="danger-ghost" icon={<Trash2 />} onClick={() => { set({ amendments: draft.amendments.filter((_, j) => j !== i) }); }}>
                  Remove amendment {i + 1}
                </Button>
              </div>
            </fieldset>
          );
        })}
        <div>
          <Button type="button" size="sm" variant="secondary" icon={<Plus />} onClick={() => { set({ amendments: [...draft.amendments, blankAmendment()] }); }}>
            Add an amendment
          </Button>
        </div>
      </Card>

      {touched && problems.size > 0 ? (
        <p className="fs-coverage-note" role="alert">
          {problems.size === 1 ? 'One field needs attention' : `${String(problems.size)} fields need attention`}: {[...problems.values()][0]}
        </p>
      ) : null}
      {error === null ? null : (
        <p className="fs-coverage-note" role="alert">
          {error}
        </p>
      )}
      <div className="fs-builder__footer">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={busy}>
          Save profile
        </Button>
      </div>
    </form>
  );
}
