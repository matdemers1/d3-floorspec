import { Badge, Button, Select } from '@d3cloud/ui';
import { Sparkles } from 'lucide-react';
import { beamWords, EXTERIOR_DEFS, exteriorOf } from '@floorspec/render2d';
import { documentScenes, luminairesOf, settingOf } from '@floorspec/mesh';
import { IntField, LengthField, ReadOnlyField, Row, Section } from '../fields';
import { formatLen } from '../units';
import type { Batch } from '../ops';
import { labelOf } from '../model';
import type { SystemsCtx } from './Panels';

/**
 * An exterior light in the inspector (FLR-T-15.5, the board's "Path light · P3"): what kind it is and
 * where it goes, its beam — a picture of where its light lands, not a calculation — and how far it
 * reaches, its output and colour temperature (FS_lighting's luminaire record), and the scenes that
 * turn it on. Its circuit and its control are the sections every load has, below. Every field is an
 * Op: the beam and reach are setProperty on the element's record (`/extras/d3floorspec/exterior`), the
 * photometry setProperty of `$document` under FS_lighting.
 */

const CCTS = [2200, 2700, 3000, 3500] as const;
const FS_LIGHTING = '0.1.0';

export function ExteriorSection({ ctx }: { ctx: SystemsCtx }) {
  const { model, id, element, units, readOnly } = ctx;
  const ext = exteriorOf(element);
  if (ext === null) return null;
  const def = EXTERIOR_DEFS[ext.kind];
  const own = luminairesOf(model.document).get(id);
  const box = (element['fallback'] as { box?: { min?: number[]; max?: number[] } } | undefined)?.box;
  const run = box?.max !== undefined && box.min !== undefined ? (box.max[0] ?? 0) - (box.min[0] ?? 0) : 0;
  const bulbs = ext.kind === 'string' ? Math.max(2, Math.round(run / (2 * 390_144))) : 1;
  const lumens = own?.lumens ?? def.lumens * bulbs;
  const cct = own?.cct ?? def.cct;
  const volts = typeof element['volts'] === 'number' ? element['volts'] : def.volts;
  const height = box?.max === undefined ? 0 : (box.max[2] ?? 0);
  const label = labelOf(model, id);
  const declared = Object.hasOwn((model.document as { extensionsUsed?: object }).extensionsUsed ?? {}, 'FS_lighting');
  const photometry = (patch: { lumens?: number; cct?: number }): Batch => [
    ...(declared ? [] : [{ op: 'setProperty', id: '$document', path: '/extensionsUsed/FS_lighting', value: FS_LIGHTING }]),
    { op: 'setProperty', id: '$document', path: `/extensions/FS_lighting/luminaires/${id}`, value: { ...(own?.lumens === undefined ? {} : { lumens: own.lumens }), ...(own?.cct === undefined ? {} : { cct: own.cct }), ...(own?.dimmable === undefined ? { dimmable: true } : { dimmable: own.dimmable }), ...patch } },
  ] as Batch;
  const record = (member: 'beam' | 'reach', value: number): Batch => [{ op: 'setProperty', id, path: `/extras/d3floorspec/exterior/${member}`, value }] as Batch;
  const scenes = documentScenes(model.document).filter((s) => settingOf(s.lighting, id) !== null);
  return (
    <Section title="Exterior light">
      <div className="fs-ext-chips" aria-label="What it is">
        <Badge size="sm" tone="neutral">{def.where}</Badge>
        <Badge size="sm" tone="neutral">{String(volts)} V</Badge>
        <Badge size="sm" tone="neutral">{String(cct)} K</Badge>
        <Badge size="sm" tone="neutral">{String(lumens)} lm</Badge>
      </div>
      {ext.kind === 'path' || ext.kind === 'uplight' ? <ReadOnlyField label="Height" value={`${formatLen(height, units)} above grade`} /> : null}
      {def.beams.length > 1 ? (
        <Row label="Beam">
          <Select
            aria-label="Beam"
            appearance="filled"
            disabled={readOnly}
            options={def.beams.map((b) => ({ value: String(b), label: beamWords(b) }))}
            value={String(ext.beam)}
            onValueChange={(v) => { ctx.edit(`Set the beam of ${label} to ${beamWords(Number(v))}`, record('beam', Number(v))); }}
          />
        </Row>
      ) : (
        <ReadOnlyField label="Beam" value={ext.kind === 'path' ? `${beamWords(ext.beam)}, down · a pool` : ext.kind === 'string' ? `${String(bulbs)} bulbs, ${formatLen(run, units)} run` : beamWords(ext.beam)} />
      )}
      {ext.kind === 'uplight' || ext.kind === 'wallWash' || ext.kind === 'step' ? (
        <LengthField label="Reach" value={ext.reach} units={units} nonNegative disabled={readOnly} hint="How far ahead its beam is drawn on the plan" onCommit={(v) => { if (v !== null && v > 0) ctx.edit(`Set the reach of ${label}`, record('reach', v)); }} />
      ) : null}
      <IntField label="Output" unit="lm" value={lumens} min={1} max={100_000} disabled={readOnly} onCommit={(v) => { if (v !== null && v > 0) ctx.edit(`Set the output of ${label} to ${String(v)} lm`, photometry({ lumens: v })); }} />
      <Row label="Colour">
        <Select
          aria-label="Colour temperature"
          appearance="filled"
          disabled={readOnly}
          options={[...new Set([...CCTS, cct])].sort((a, b) => a - b).map((k) => ({ value: String(k), label: `${String(k)} K${k <= 2700 ? ' warm' : ''}` }))}
          value={String(cct)}
          onValueChange={(v) => { ctx.edit(`Set the colour of ${label} to ${v} K`, photometry({ cct: Number(v) })); }}
        />
      </Row>
      <ReadOnlyField label="Scene" value={scenes.length === 0 ? 'In no scene yet' : scenes.map((s) => s.name).join(', ')} />
      <p className="fs-note">Beams are drawn where the light lands — a pool, a cone, a fan or a half-disc — in one warm tint with a dashed edge; they are a drawing of the fixture, not a lighting calculation.</p>
      {readOnly ? null : (
        <Button
          size="sm"
          variant="secondary"
          icon={<Sparkles />}
          onClick={() => {
            // The path-light tool's panel carries the electrical assistant's exterior card, and its markers the dark stretches.
            const draw = ctx.store.get().draw;
            ctx.store.set({ draw: { ...draw, device: 'pathLight', height: null } });
            ctx.store.setTool('device');
          }}
        >
          Ask the assistant to light the walks
        </Button>
      )}
    </Section>
  );
}
