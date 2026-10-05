import { useMemo, useState } from 'react';
import { Alert, Button, FormField, Input, Modal, Select } from '@d3cloud/ui';
import { estimateEnergy, parseInputs, type AssemblyRow, type EnergyEstimate, type EnergyInputs, type UnitSystem } from '@floorspec/analysis';
import { assemblyIn, assemblyOut, assemblyUnit, ddIn, ddOut, presetOptions, tempIn, tempOut } from './model';

/**
 * Climate & assumptions (FLR-T-12.6): the climate the estimate is made for — a zone's preset, or the
 * site's own design temperatures and degree days — the air leakage, and any assembly's R-value (or
 * U) and the windows' SHGC. A field left empty keeps the typical value, shown as its placeholder.
 * Saved as one change to the document's extras: undoable, in the history like any edit.
 */

const CLIMATE_FIELDS = ['heatingDesign', 'coolingDesign', 'hdd', 'cdd', 'indoorWinter', 'indoorSummer'] as const;
type ClimateField = (typeof CLIMATE_FIELDS)[number];

interface Draft {
  zone: string;
  climate: Record<ClimateField, string>;
  ach: string;
  assemblies: Record<string, string>;
  shgc: string;
}

const show = (n: number | undefined): string => (n === undefined ? '' : String(n));

export function InputsDialog({
  open,
  onOpenChange,
  document,
  estimate,
  units,
  saving,
  error,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  document: object;
  estimate: EnergyEstimate;
  units: UnitSystem;
  saving: boolean;
  error: string | null;
  onSave: (inputs: EnergyInputs) => void;
}) {
  const inputs = estimate.inputs;
  const initial = (): Draft => ({
    zone: inputs.zone ?? estimate.climate.zone,
    climate: {
      heatingDesign: inputs.heatingDesign === undefined ? '' : show(tempIn(inputs.heatingDesign, units)),
      coolingDesign: inputs.coolingDesign === undefined ? '' : show(tempIn(inputs.coolingDesign, units)),
      hdd: inputs.hdd === undefined ? '' : show(ddIn(inputs.hdd, units)),
      cdd: inputs.cdd === undefined ? '' : show(ddIn(inputs.cdd, units)),
      indoorWinter: inputs.indoorWinter === undefined ? '' : show(tempIn(inputs.indoorWinter, units)),
      indoorSummer: inputs.indoorSummer === undefined ? '' : show(tempIn(inputs.indoorSummer, units)),
    },
    ach: show(inputs.ach),
    assemblies: Object.fromEntries(
      estimate.assemblies.flatMap((a) => {
        const u = a.kind === 'air' ? undefined : inputs.assemblies?.[a.key]?.u;
        return u === undefined ? [] : [[a.key, show(assemblyIn({ kind: a.kind, value: u }, units))]];
      }),
    ),
    shgc: show(inputs.assemblies?.['window']?.shgc),
  });
  const [draft, setDraft] = useState<Draft>(initial);
  const [problem, setProblem] = useState<string | null>(null);

  // What each field would be without the user's value: the preset's and the typical assemblies.
  const typical = useMemo(() => {
    try {
      return estimateEnergy(document, { inputs: { zone: draft.zone }, compare: false });
    } catch {
      return estimate;
    }
  }, [document, draft.zone, estimate]);
  const rows = useMemo(() => {
    const seen = new Set<string>();
    return typical.assemblies.filter((a) => a.kind !== 'air' && !seen.has(a.key) && seen.add(a.key));
  }, [typical]);
  const c = typical.climate;
  const tUnit = units === 'imperial' ? '°F' : '°C';
  const ddUnit = units === 'imperial' ? '°F·days' : '°C·days';
  const placeholders: Record<ClimateField, string> = {
    heatingDesign: show(tempIn(c.heatingDesign, units)),
    coolingDesign: show(tempIn(c.coolingDesign, units)),
    hdd: show(ddIn(c.hdd, units)),
    cdd: show(ddIn(c.cdd, units)),
    indoorWinter: show(tempIn(c.indoorWinter, units)),
    indoorSummer: show(tempIn(c.indoorSummer, units)),
  };
  const labels: Record<ClimateField, string> = {
    heatingDesign: `Heating design, outside (${tUnit})`,
    coolingDesign: `Cooling design, outside (${tUnit})`,
    hdd: `Heating degree days (${ddUnit})`,
    cdd: `Cooling degree days (${ddUnit})`,
    indoorWinter: `Indoors in winter (${tUnit})`,
    indoorSummer: `Indoors in summer (${tUnit})`,
  };

  function build(): EnergyInputs | string {
    const num = (s: string): number | undefined | null => {
      const t = s.trim();
      if (t === '') return undefined;
      const n = Number(t.replace(/,/g, ''));
      return Number.isFinite(n) ? n : null;
    };
    const out: Record<string, unknown> = { zone: draft.zone };
    for (const f of CLIMATE_FIELDS) {
      const v = num(draft.climate[f]);
      if (v === null) return `${labels[f]} is not a number.`;
      if (v !== undefined) out[f] = f === 'hdd' || f === 'cdd' ? ddOut(v, units) : tempOut(v, units);
    }
    const ach = num(draft.ach);
    if (ach === null) return 'Air changes an hour is not a number.';
    if (ach !== undefined) out['ach'] = ach;
    const assemblies: Record<string, { u?: number; shgc?: number }> = {};
    for (const a of rows) {
      const v = num(draft.assemblies[a.key] ?? '');
      if (v === null || (v !== undefined && v <= 0)) return `${a.label}: the value is not a positive number.`;
      if (v !== undefined) assemblies[a.key] = { u: assemblyOut(a.kind, v, units) };
    }
    const shgc = num(draft.shgc);
    if (shgc === null) return 'The windows’ SHGC is not a number.';
    if (shgc !== undefined) assemblies['window'] = { ...assemblies['window'], shgc };
    if (Object.keys(assemblies).length) out['assemblies'] = assemblies;
    const checked = parseInputs(out);
    if (checked.problems.length) return `Out of range: ${checked.problems.map((p) => p.message).join('; ')}.`;
    return checked.inputs;
  }

  const row = (a: AssemblyRow) => (
    <FormField key={a.key} label={a.label.replace(/^(Exterior walls|Walls to unconditioned rooms) · /, 'Walls · ')} help={`${assemblyUnit(a.kind, units)} · typical ${String(assemblyIn(a, units))}`} optional>
      <Input
        inputMode="decimal"
        value={draft.assemblies[a.key] ?? ''}
        placeholder={String(assemblyIn(a, units))}
        onChange={(e) => { setDraft({ ...draft, assemblies: { ...draft.assemblies, [a.key]: e.target.value } }); }}
      />
    </FormField>
  );

  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        if (o) {
          setDraft(initial());
          setProblem(null);
        }
        onOpenChange(o);
      }}
      size="lg"
      title="Climate & assumptions"
      description="What the estimate is made for. Leave a field empty to keep the typical value shown in it. Saved as one change to the plan — undo takes it back."
      footer={
        <>
          <Button
            variant="ghost"
            disabled={saving}
            onClick={() => {
              onSave({});
            }}
          >
            Reset to typical
          </Button>
          <span className="fs-spacer" />
          <Button variant="secondary" disabled={saving} onClick={() => { onOpenChange(false); }}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={saving}
            onClick={() => {
              const built = build();
              if (typeof built === 'string') setProblem(built);
              else {
                setProblem(null);
                onSave(built);
              }
            }}
          >
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="fs-energy-form">
        {problem !== null || error !== null ? (
          <Alert tone="danger" dynamic>
            {problem ?? error}
          </Alert>
        ) : null}
        <FormField label="Climate zone" help="Rounded values for one city in each IECC zone. Set your site’s own from ASHRAE climatic design data where you know them.">
          <Select options={presetOptions} value={draft.zone} onValueChange={(zone) => { setDraft({ ...draft, zone }); }} appearance="filled" />
        </FormField>
        <div className="fs-energy-form__grid">
          {CLIMATE_FIELDS.map((f) => (
            <FormField key={f} label={labels[f]} optional>
              <Input inputMode="decimal" value={draft.climate[f]} placeholder={placeholders[f]} onChange={(e) => { setDraft({ ...draft, climate: { ...draft.climate, [f]: e.target.value } }); }} />
            </FormField>
          ))}
        </div>
        <h3 className="fs-heading-14">Assemblies</h3>
        <div className="fs-energy-form__grid">
          {rows.map(row)}
          {rows.some((a) => a.kind === 'window') ? (
            <FormField label="Windows · SHGC" help="Solar heat gain coefficient, 0.05–0.95" optional>
              <Input inputMode="decimal" value={draft.shgc} placeholder={String(typical.assemblies.find((a) => a.kind === 'window')?.shgc ?? '')} onChange={(e) => { setDraft({ ...draft, shgc: e.target.value }); }} />
            </FormField>
          ) : null}
          <FormField label="Air changes an hour" help="Natural leakage; a typical new house is about 0.35" optional>
            <Input inputMode="decimal" value={draft.ach} placeholder={String(typical.assemblies.find((a) => a.kind === 'air')?.value ?? '')} onChange={(e) => { setDraft({ ...draft, ach: e.target.value }); }} />
          </FormField>
        </div>
      </div>
    </Modal>
  );
}
