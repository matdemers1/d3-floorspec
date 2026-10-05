/**
 * The sun study's clock (FLR-T-8.6): a local date and a time of day at the site, and the UTC offset
 * they are read in.
 *
 * Floorspec Core records a site's latitude, longitude and true north (Core 1.8) but no time zone, so
 * the offset is an assumption the panel states: this browser's own offset on that date (which follows
 * its daylight saving), unless a person picks the site's. Nothing here is stored in the document.
 */

export interface Clock {
  /** The local calendar date at the site, `YYYY-MM-DD`. */
  date: string;
  /** Minutes past local midnight, [0, 1440). */
  minutes: number;
  /** Minutes east of UTC, or `auto` for this browser's offset on that date. */
  offset: number | 'auto';
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

export function parseDate(date: string): { y: number; m: number; d: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (match === null) return null;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return null;
  return { y, m, d };
}

/** This browser's offset east of UTC, in minutes, at local noon on a date. */
export function browserOffset(date: string): number {
  const p = parseDate(date);
  const at = p === null ? new Date() : new Date(p.y, p.m - 1, p.d, 12);
  return -at.getTimezoneOffset();
}

export function offsetOf(clock: Clock): number {
  return clock.offset === 'auto' ? browserOffset(clock.date) : clock.offset;
}

/** Local midnight at the site, as UTC milliseconds. */
export function midnightOf(clock: Clock): number {
  const p = parseDate(clock.date) ?? { y: 2000, m: 1, d: 1 };
  return Date.UTC(p.y, p.m - 1, p.d) - offsetOf(clock) * 60_000;
}

/** The clock's instant, UTC milliseconds. */
export function instantOfClock(clock: Clock): number {
  return midnightOf(clock) + Math.round(clock.minutes * 60_000);
}

/** The local date and minutes at an instant, read with an offset. */
export function clockAt(ms: number, offset: number): { date: string; minutes: number } {
  const local = new Date(ms + offset * 60_000);
  return {
    date: `${pad(local.getUTCFullYear(), 4)}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`,
    minutes: local.getUTCHours() * 60 + local.getUTCMinutes(),
  };
}

/** `3:00 pm`, `12:15 am`. */
export function formatTime(minutes: number): string {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${String(h12)}:${pad(m % 60)} ${h < 12 ? 'am' : 'pm'}`;
}

/** `3 pm` on the hour, `3:15 pm` otherwise: the board's compact form. */
export function formatTimeShort(minutes: number): string {
  const full = formatTime(minutes);
  return full.replace(/:00 /, ' ');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `Oct 4`. */
export function formatDate(date: string): string {
  const p = parseDate(date);
  return p === null ? date : `${MONTHS[p.m - 1] ?? ''} ${String(p.d)}`;
}

/** `UTC−04:00`, `UTC+05:30`, `UTC`. */
export function formatOffset(offset: number): string {
  if (offset === 0) return 'UTC';
  const a = Math.abs(offset);
  return `UTC${offset < 0 ? '−' : '+'}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

/** The offsets in use around the world, minutes east of UTC. */
export const OFFSETS: readonly number[] = [
  -720, -660, -600, -570, -540, -480, -420, -360, -300, -240, -210, -180, -120, -60, 0, 60, 120, 180, 210, 240, 270, 300, 330, 345, 360, 390, 420, 480, 525, 540, 570, 600, 630, 660, 720, 765, 780, 840,
];

/** Today, and now rounded to the minute, in an offset. */
export function nowIn(offset: number | 'auto', at = Date.now()): { date: string; minutes: number } {
  if (offset !== 'auto') return clockAt(at, offset);
  const d = new Date(at);
  return { date: `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, minutes: d.getHours() * 60 + d.getMinutes() };
}

/** `Sun · Oct 4 · 3 pm`: the board's summary of the study (its 08 frame's "Shadows" row). */
export function summaryOf(clock: Clock): string {
  return `Sun · ${formatDate(clock.date)} · ${formatTimeShort(clock.minutes)}`;
}
