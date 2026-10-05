import type { LevelView, Point } from '../editor/model';
import type { Batch } from '../editor/ops';
import { moveDevice, type HostRef } from '../editor/systems/ops';
import type { DeviceView } from '../editor/systems/view';

/**
 * Arrow-key nudging of an extension element (FLR-T-8.3; FLR-T-3.7's nudge for walls and openings):
 * an item on a floor or standing free moves its host's position one step that way; an item on a
 * wall face moves along the wall — the arrow's component along it picks the direction — keeping
 * its height. Either is the moveElement a drag sends (Ops 0.2 4.10), so it follows the same rules.
 */
export function nudgeDevice(level: LevelView, device: DeviceView, d: Point, step: number): Batch | null {
  const host = device.host;
  if (host === null) return null;
  if (host['mode'] === 'surface' || host['mode'] === 'free') {
    const p = host['position'] as [number, number] | undefined;
    if (!Array.isArray(p)) return null;
    const at: [number, number] = [p[0] + d[0] * step, p[1] + d[1] * step];
    const rotation = typeof host['rotation'] === 'number' ? host['rotation'] : 0;
    const next: HostRef =
      host['mode'] === 'surface'
        ? { mode: 'surface', room: String(host['room']), surface: host['surface'] === 'ceiling' ? 'ceiling' : 'floor', at, rotation }
        : { mode: 'free', level: String(host['level']), at, rotation };
    return moveDevice(device.id, next);
  }
  if (host['mode'] === 'wallFace') {
    const wall = level.walls.find((w) => w.id === host['wall']);
    if (wall === undefined) return null;
    const along: Point = [wall.b[0] - wall.a[0], wall.b[1] - wall.a[1]];
    const l = Math.hypot(along[0], along[1]) || 1;
    const k = (d[0] * along[0] + d[1] * along[1]) / l;
    if (Math.abs(k) < 0.38) return null;
    const offset = Math.min(Math.floor(l), Math.max(0, Number(host['offset']) + (k > 0 ? step : -step)));
    return moveDevice(device.id, { mode: 'wallFace', wall: wall.id, side: host['side'] === 'left' ? 'left' : 'right', at: offset, height: Number(host['height']) });
  }
  return null;
}
