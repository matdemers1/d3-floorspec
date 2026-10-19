import { clockWords, timelapseSchedule, type Timelapse } from '@floorspec/mesh/sky';
import type { EditorModel } from '../../model';

/**
 * The site's place for a film's day to night (FLR-T-14.1): the document's location (Core 1.8,
 * millionths of a degree), or nothing — the timelapse then assumes the sky module's default site, as
 * the worker does.
 */
export function siteOfModel(model: EditorModel): { latitude?: number; longitude?: number } {
  const location = (model.document as { site?: { location?: { latitude?: unknown; longitude?: unknown } } }).site?.location;
  return typeof location?.latitude === 'number' && typeof location.longitude === 'number' ? { latitude: location.latitude / 1e6, longitude: location.longitude / 1e6 } : {};
}

/** Civil twilight ends with the sun this far under the horizon: dusk becomes night. */
const CIVIL = -6;

/**
 * How much of a timelapse is day, dusk and night (shares of 1, in order): the sun above the horizon,
 * between it and civil twilight's end, and below — the sun track's bands and the render dialog's.
 */
export function timelapseBands(plan: Timelapse, site: { latitude?: number; longitude?: number }): { day: number; dusk: number; night: number } {
  let s;
  try {
    s = timelapseSchedule(plan, site);
  } catch {
    return { day: 1, dusk: 0, night: 0 };
  }
  const n = 240;
  let day = 0;
  let dusk = 0;
  for (let i = 0; i < n; i++) {
    const alt = s.at((i + 0.5) / n).sun.altitude;
    if (alt > 0) day++;
    else if (alt > CIVIL) dusk++;
  }
  return { day: day / n, dusk: dusk / n, night: (n - day - dusk) / n };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Jun 21 · 3:00 pm", from a view's `at`. */
export function atWords(at: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(at);
  if (m === null) return at;
  return `${MONTHS[Number(m[1]) - 1] ?? ''} ${String(Number(m[2]))} · ${clockWords(Number(m[3]) * 60 + Number(m[4]))}`;
}
