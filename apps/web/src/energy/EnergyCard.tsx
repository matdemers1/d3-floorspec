import './energy.css';
import { useMemo } from 'react';
import { Badge, Button, StatusDot } from '@d3cloud/ui';
import { loadRange } from '@floorspec/analysis';
import { Flame } from 'lucide-react';
import { DashCard } from '../dashboard/DashCard';
import { unitsOf } from '../editor/units';
import { navigate } from '../lib/router';
import type { FloorspecDocument } from '@floorspec/engine';
import { estimateOf } from './model';

/**
 * The dashboard's Energy & comfort card (FLR-T-12.6; the board's "04 · Project dashboard — energy
 * card"): the design loads as ranges, the first comfort notes, and the way to the estimate — labelled
 * advisory, as an estimate to compare options and never an energy-code calculation.
 */
export function EnergyCard({ projectId, document }: { projectId: string; document: FloorspecDocument | null }) {
  const estimated = useMemo(() => estimateOf(document), [document]);
  const units = unitsOf(document);
  const open = () => { navigate(`/projects/${projectId}/energy`); };
  if (estimated.status !== 'ok') {
    return (
      <DashCard region="energy" icon={<Flame aria-hidden="true" />} title="Energy & comfort" aside={<Badge size="sm" tone="neutral">Advisory</Badge>}>
        <p className="fs-card-text">{estimated.message} The estimate follows the plan once it has walls, rooms and windows.</p>
      </DashCard>
    );
  }
  const e = estimated.estimate;
  const heating = loadRange(e.loads.heating, units);
  const cooling = loadRange(e.loads.cooling, units);
  const shown = [...e.notes.filter((n) => n.severity === 'warning'), ...e.notes.filter((n) => n.severity !== 'warning')].slice(0, 2);
  return (
    <DashCard
      region="energy"
      icon={<Flame aria-hidden="true" />}
      title="Energy & comfort"
      aside={
        <>
          <Badge size="sm" tone="neutral">
            Advisory
          </Badge>
          <Button size="sm" variant="ghost" onClick={open}>
            Open estimate
          </Button>
        </>
      }
    >
      <div className="fs-energy-card__loads">
        <p className="fs-energy-card__line">{`Heating ${heating.text} ${heating.unit} · Cooling ${cooling.text} ${cooling.unit}`}</p>
        <p className="fs-energy__detail">{`Design loads ±20% · zone ${e.climate.zone} ${e.climate.source === 'custom' ? 'with your values' : e.climate.source === 'preset' ? 'preset' : 'preset (assumed)'}`}</p>
      </div>
      {shown.length > 0 ? (
        <ul className="fs-energy__notes">
          {shown.map((n) => (
            <li key={`${n.kind}:${n.rooms.join(',')}:${n.openings.join(',')}`}>
              <StatusDot tone={n.severity === 'warning' ? 'warning' : 'neutral'}>{n.title}</StatusDot>
              <span className="fs-energy__detail">{n.detail}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="fs-caption">{`${String(e.notes.length)} comfort ${e.notes.length === 1 ? 'note' : 'notes'} · an estimate to compare options, not an energy-code calculation.`}</p>
    </DashCard>
  );
}
