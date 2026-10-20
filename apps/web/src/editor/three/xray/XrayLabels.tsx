import { useEffect, useRef } from 'react';
import type { SectionRig } from '../section/rig';
import type { XrayLabel } from './labels';

/**
 * X-ray's callouts over the view (FLR-T-14.5): a leader label pinned to each thing in the selected
 * wall — its framing, its fixtures' supply and drain, its circuits — moved every frame as the camera
 * moves (the exploded view's labels, FLR-T-14.6). Decorative: the inspector's X-ray section says the
 * same in words.
 */
/** A leader's least length, the dot under it and the gap kept between pills, CSS pixels. */
const LEADER = 20;
const DOT = 7;
const GAP = 4;

export function XrayLabels({ rig, labels }: { rig: SectionRig; labels: readonly XrayLabel[] }) {
  const pins = useRef<(HTMLDivElement | null)[]>([]);
  const pills = useRef<(HTMLDivElement | null)[]>([]);
  const leaders = useRef<(HTMLSpanElement | null)[]>([]);
  useEffect(() => {
    const update = () => {
      // Each pill as low over its pin as it can be without covering one placed before it, left to right.
      const placed: { x0: number; x1: number; y0: number; y1: number }[] = [];
      const order = labels.map((l, i) => ({ i, p: rig.project(l.at) })).sort((a, b) => a.p.x - b.p.x || a.i - b.i);
      for (const { i, p } of order) {
        const el = pins.current[i];
        if (el === null || el === undefined) continue;
        el.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px)`;
        el.style.visibility = p.front ? '' : 'hidden';
        const pill = pills.current[i];
        const leader = leaders.current[i];
        if (!p.front || pill === null || pill === undefined || leader === null || leader === undefined) continue;
        const w = pill.offsetWidth;
        const h = pill.offsetHeight;
        let lift = LEADER;
        for (let k = 0; k < 8; k++) {
          const r = { x0: p.x - w / 2, x1: p.x + w / 2, y1: p.y - lift - DOT, y0: p.y - lift - DOT - h };
          if (!placed.some((q) => r.x0 < q.x1 + GAP && q.x0 < r.x1 + GAP && r.y0 < q.y1 + GAP && q.y0 < r.y1 + GAP)) {
            placed.push(r);
            break;
          }
          lift += h + GAP;
        }
        leader.style.height = `${String(lift)}px`;
      }
    };
    rig.overlays.add(update);
    rig.invalidate();
    return () => { rig.overlays.delete(update); };
  }, [rig, labels]);
  return (
    <div className="fs-xray__overlay" aria-hidden="true">
      {labels.map((l, i) => (
        <div key={l.key} ref={(el) => { pins.current[i] = el; }} className="fs-explode__pin" data-label={l.key}>
          <div className="fs-explode__label">
            <div ref={(el) => { pills.current[i] = el; }} className="fs-explode__pill">
              <span className="fs-explode__title">{l.title}</span>
              {l.sub === '' ? null : <span className="fs-explode__sub">{l.sub}</span>}
            </div>
            <span ref={(el) => { leaders.current[i] = el; }} className="fs-explode__leader" />
            <span className="fs-explode__dot" />
          </div>
        </div>
      ))}
    </div>
  );
}
