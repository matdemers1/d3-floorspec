import { useMemo, useState } from 'react';
import { Button } from '@d3cloud/ui';
import { GitPullRequestArrow, Sparkles } from 'lucide-react';
import { analyseGaps, proposeElectrical, DEFAULTS, type Gap } from '@floorspec/assistant-electrical';
import type { EditorStore } from '../store';
import { useEditor } from '../store';
import type { EditorModel, LevelView, Point } from '../model';
import type { Viewport } from '../store';
import { toScreen } from '../viewport';
import { labelOf } from '../model';
import { formatLen, type UnitSystem } from '../units';
import { api, messageOf } from '../../lib/api';
import { openReview, refreshProposals } from '../review';
import { facePoint } from './placement';
import { leftNormal } from '../geometry';

/**
 * The electrical assistant in the editor (FLR-T-5.8, the board's "23"): what it finds — wall runs
 * longer than Floorspec's spacing default without a receptacle — drawn on the plan and said on a
 * card, and what it would propose, worked out here by the same package the server runs. "Review
 * as changeset" asks the server to open it as a pending changeset, which then opens for review;
 * nothing touches main until it is accepted (FLR-ADR-016). It advises from Floorspec's defaults and
 * says so: no code is checked or cited here — that arrives with the rules packs.
 */

interface Reading {
  gaps: Gap[];
  counts: { receptacles: number; switches: number; lights: number; circuits: number; upgraded: number };
  error: string | null;
}

/** What the assistant finds and would propose, on the level shown; recomputed when the model moves. */
export function useAssistant(model: EditorModel | null, level: string | null): Reading | null {
  return useMemo(() => {
    if (model === null || !model.valid || level === null) return null;
    try {
      const gaps = analyseGaps(model.document, { level });
      const p = proposeElectrical(model.document, { level });
      return {
        gaps,
        counts: { receptacles: p.added.receptacles.length, switches: p.added.switches.length, lights: p.added.lights.length, circuits: p.circuits.length, upgraded: p.upgraded.length },
        error: null,
      };
    } catch (error) {
      return { gaps: [], counts: { receptacles: 0, switches: 0, lights: 0, circuits: 0, upgraded: 0 }, error: error instanceof Error ? error.message : 'the assistant could not read this plan' };
    }
  }, [model, level]);
}

const plural = (n: number, one: string, many = `${one}s`) => `${String(n)} ${n === 1 ? one : many}`;

export function AssistantCard({ store, model, units }: { store: EditorStore; model: EditorModel; units: UnitSystem }) {
  const level = useEditor(store, (s) => s.level);
  const readOnly = useEditor(store, (s) => s.readOnly !== null);
  const reading = useAssistant(model, level);
  const [busy, setBusy] = useState(false);
  if (reading === null) return null;
  const worst = reading.gaps.reduce<Gap | null>((a, g) => (a === null || g.length > a.length ? g : a), null);
  const c = reading.counts;
  const total = c.receptacles + c.switches + c.lights + c.circuits + c.upgraded;
  const parts = [
    c.receptacles > 0 && plural(c.receptacles, 'receptacle'),
    c.switches > 0 && plural(c.switches, 'switch', 'switches'),
    c.lights > 0 && plural(c.lights, 'light'),
    c.circuits > 0 && plural(c.circuits, 'circuit'),
    c.upgraded > 0 && `GFCI on ${plural(c.upgraded, 'receptacle')}`,
  ].filter((x): x is string => typeof x === 'string');
  const review = async () => {
    setBusy(true);
    try {
      const answer = await api.post<{ changeset: { id: string } | null }>(`/api/projects/${store.projectId}/assistants/electrical`, { level });
      if (answer.changeset === null) store.set({ notice: { tone: 'info', text: 'Nothing to propose: the plan already meets the assistant’s defaults.' } });
      else {
        await refreshProposals(store);
        await openReview(store, answer.changeset.id);
      }
    } catch (error) {
      store.set({ notice: { tone: 'danger', text: messageOf(error) } });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="fs-assistant" aria-label="Electrical assistant">
      <h3 className="fs-assistant__title">
        <Sparkles aria-hidden="true" />
        Electrical assistant
      </h3>
      {reading.error !== null ? (
        <p>{reading.error.charAt(0).toUpperCase() + reading.error.slice(1)}.</p>
      ) : (
        <>
          <p>
            {worst === null
              ? 'Every wall run on this level is within Floorspec’s receptacle spacing default.'
              : `${labelOf(model, worst.room)}’s wall ${worst.wall} has ${formatLen(worst.length, units)} ${worst.kind === 'between' ? 'between receptacles' : 'without a receptacle'}${reading.gaps.length > 1 ? `, and ${plural(reading.gaps.length - 1, 'other stretch', 'other stretches')} longer than the spacing` : ''}.`}{' '}
            {total === 0 ? 'Nothing to propose.' : `Would propose ${parts.join(', ')}.`}
          </p>
          <p className="fs-assistant__note">
            From Floorspec’s layout defaults — receptacles {formatLen(DEFAULTS.receptacleSpacing, units)} apart, {formatLen(DEFAULTS.spacingByFunction['kitchen'] ?? DEFAULTS.receptacleSpacing, units)} in kitchens; GFCI in wet rooms; AFCI on habitable circuits. Advisory, not a code check: code findings arrive with the rules packs.
          </p>
          {readOnly ? null : (
            <Button size="sm" variant="primary" icon={<GitPullRequestArrow />} loading={busy} disabled={total === 0} onClick={() => void review()}>
              Review as changeset
            </Button>
          )}
        </>
      )}
    </section>
  );
}

/** The gaps on the plan: each stretch drawn along its wall face, the worst labelled. */
export function GapMarkers({ store, view, level, model, units }: { store: EditorStore; view: Viewport; level: LevelView; model: EditorModel; units: UnitSystem }) {
  const reading = useAssistant(model, useEditor(store, (s) => s.level));
  if (reading === null || reading.gaps.length === 0) return null;
  const worst = reading.gaps.reduce((a, g) => (g.length > a.length ? g : a));
  return (
    <g className="fs-gaps" aria-hidden="true">
      {reading.gaps.map((g, i) => {
        const wall = level.walls.find((w) => w.id === g.wall);
        if (wall === undefined) return null;
        const a = toScreen(view, facePoint(wall, g.side, g.from));
        const b = toScreen(view, facePoint(wall, g.side, g.to));
        return <line key={i} className="fs-gap" x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} />;
      })}
      {(() => {
        const wall = level.walls.find((w) => w.id === worst.wall);
        if (wall === undefined) return null;
        const mid: Point = facePoint(wall, worst.side, (worst.from + worst.to) / 2);
        // Into the room, off the wall, and kept on the canvas.
        const n = leftNormal(wall.a, wall.b);
        const inward: Point = worst.side === 'left' ? n : [-n[0], -n[1]];
        const at = toScreen(view, mid);
        const text = `${formatLen(worst.length, units)} ${worst.kind === 'between' ? 'between receptacles' : 'without a receptacle'}`;
        const w = text.length * 6.6 + 14;
        const cx = Math.min(view.w - w / 2 - 6, Math.max(w / 2 + 6, at[0] + inward[0] * (w / 2 + 12)));
        const cy = Math.min(view.h - 16, Math.max(16, at[1] - inward[1] * 22));
        const p: Point = [cx, cy + 10];
        return (
          <g>
            <rect className="fs-gap__tag" x={p[0] - w / 2} y={p[1] - 20} width={w} height={20} rx={4} />
            <text className="fs-gap__text" x={p[0]} y={p[1] - 6} textAnchor="middle">
              {text}
            </text>
          </g>
        );
      })()}
    </g>
  );
}
