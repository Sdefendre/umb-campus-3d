import type { ClassItem } from './types';

/** Average campus walking pace (~1.35 m/s). */
export const WALK_METERS_PER_MIN = 81;

export function walkMinutes(distanceMeters: number): number {
  return Math.max(1, Math.round(distanceMeters / WALK_METERS_PER_MIN));
}

const FULL_DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const TWO_LETTER: Record<string, number> = { Su: 0, Mo: 1, Tu: 2, We: 3, Th: 4, Fr: 5, Sa: 6 };
const ONE_LETTER: Record<string, number> = { U: 0, M: 1, T: 2, W: 3, R: 4, F: 5, S: 6 };

/**
 * Converts a day label to JS weekday numbers (0 = Sunday). Handles "Mon/Wed/Fri",
 * "MoWeFr", "TuTh", "MWF", "TR", "T/Th" and "M/W".
 */
export function parseMeetingDays(label: string): number[] {
  const days = new Set<number>();
  for (const token of label.split(/[/,\s]+/).filter(Boolean)) {
    const full = FULL_DAYS.indexOf(token.slice(0, 3).toLowerCase());
    if (full >= 0 && /^[a-z]{3,}$/i.test(token)) {
      days.add(full);
      continue;
    }
    let rest = token;
    while (rest.length > 0) {
      const two = TWO_LETTER[rest.slice(0, 2)];
      if (two !== undefined) {
        days.add(two);
        rest = rest.slice(2);
        continue;
      }
      const one = ONE_LETTER[rest[0]];
      if (one === undefined) break;
      days.add(one);
      rest = rest.slice(1);
    }
  }
  return [...days].sort((a, b) => a - b);
}

function toMinutes(hour: number, minute: number, meridian: string | undefined): number {
  const h = hour % 12;
  if (meridian?.toUpperCase() === 'PM') return (h + 12) * 60 + minute;
  if (meridian?.toUpperCase() === 'AM') return h * 60 + minute;
  // No AM/PM: 24-hour clock, with 1:00–6:59 read as afternoon classes
  return (hour >= 1 && hour < 7 ? hour + 12 : hour) * 60 + minute;
}

/** Start time in minutes after midnight, e.g. "9:30 – 10:45 AM" → 570. */
export function parseStartMinutes(timeLabel: string): number | null {
  const times = [...timeLabel.matchAll(/(\d{1,2}):(\d{2})\s*(AM|PM)?/gi)];
  if (times.length === 0) return null;
  const [, sh, sm, sMer] = times[0];
  const start = { h: Number(sh), m: Number(sm) };
  if (start.h > 23 || start.m > 59) return null;
  if (sMer || times.length < 2 || !times[1][3]) return toMinutes(start.h, start.m, sMer);

  // "11:00 – 12:15 PM": borrow the end's meridian unless that puts start after end
  const end = toMinutes(Number(times[1][1]), Number(times[1][2]), times[1][3]);
  const same = toMinutes(start.h, start.m, times[1][3]);
  return same <= end ? same : toMinutes(start.h, start.m, times[1][3].toUpperCase() === 'PM' ? 'AM' : 'PM');
}

export interface NextClass {
  item: ClassItem;
  startsAt: Date;
}

/** Classes that started less than this long ago still count as "next" (you're late). */
const LATE_GRACE_MIN = 15;

/** Finds the soonest upcoming meeting among mapped, in-person classes in the next week. */
export function findNextClass(items: ClassItem[], now: Date): NextClass | null {
  let best: NextClass | null = null;
  const cutoff = now.getTime() - LATE_GRACE_MIN * 60_000;
  for (const item of items) {
    if (!item.buildingId) continue;
    const startMin = parseStartMinutes(item.timeLabel);
    const days = parseMeetingDays(item.daysLabel);
    if (startMin === null || days.length === 0) continue;
    for (let offset = 0; offset <= 7; offset++) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
      if (!days.includes(d.getDay())) continue;
      d.setHours(Math.floor(startMin / 60), startMin % 60, 0, 0);
      if (d.getTime() < cutoff) continue;
      if (!best || d < best.startsAt) best = { item, startsAt: d };
      break;
    }
  }
  return best;
}

export function formatDuration(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 === 0 ? `${h} h` : `${h} h ${m % 60} min`;
}

/** "Leave in 12 min", "Leave now", "Started 4 min ago", or "Leave Wed 9:52 AM". */
export function leaveAdvice(startsAt: Date, walkMin: number, now: Date): string {
  const untilStart = (startsAt.getTime() - now.getTime()) / 60_000;
  if (untilStart < 0) return `Started ${formatDuration(-untilStart)} ago — go now`;
  const untilLeave = untilStart - walkMin;
  if (untilLeave <= 1) return 'Leave now';
  const leaveAt = new Date(startsAt.getTime() - walkMin * 60_000);
  if (untilLeave < 12 * 60) return `Leave in ${formatDuration(untilLeave)}`;
  return `Leave ${formatClock(leaveAt, now)}`;
}

export function formatClock(d: Date, now: Date): string {
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return time;
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  if (d.toDateString() === tomorrow.toDateString()) return `tomorrow ${time}`;
  return `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${time}`;
}
