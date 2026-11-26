import ICAL from 'ical.js';
import { isOnlineOrUnassignedLocation, resolveBuildingFromText } from './buildings';
import type { ClassItem } from './types';

const DAY_ORDER = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

function formatIcalTime(dt: ICAL.Time | null): string {
  if (!dt) return '';
  const jsDate = dt.toJSDate();
  return jsDate.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatIcalDateKey(dt: ICAL.Time | null): string {
  if (!dt) return '';
  const y = String(dt.year).padStart(4, '0');
  const m = String(dt.month).padStart(2, '0');
  const d = String(dt.day).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function extractIcalDays(vevent: ICAL.Component, start: ICAL.Time | null): string[] {
  const rruleProp = vevent.getFirstPropertyValue('rrule') as
    | { parts?: { BYDAY?: string[] } }
    | null;
  const byday = rruleProp?.parts?.BYDAY;
  if (Array.isArray(byday) && byday.length > 0) {
    const map: Record<string, string> = {
      MO: 'Mon',
      TU: 'Tue',
      WE: 'Wed',
      TH: 'Thu',
      FR: 'Fri',
      SA: 'Sat',
      SU: 'Sun',
    };
    return byday.map((d) => map[d.slice(-2)] ?? d);
  }
  if (start) {
    return [start.toJSDate().toLocaleDateString('en-US', { weekday: 'short' })];
  }
  return [];
}

function mergeDayLabels(existingLabel: string, newDays: string[]): string {
  const set = new Set<string>(
    existingLabel
      .split('/')
      .map((s) => s.trim())
      .filter(Boolean)
  );
  for (const d of newDays) {
    if (d) set.add(d);
  }
  const ordered = DAY_ORDER.filter((d) => set.has(d));
  const extras = [...set].filter((d) => !(DAY_ORDER as readonly string[]).includes(d));
  return [...ordered, ...extras].join('/');
}

/**
 * Parses an iCalendar (.ics) string completely client-side using ical.js.
 */
export function parseIcsSchedule(icsText: string): ClassItem[] {
  const jcal = ICAL.parse(icsText);
  const comp = new ICAL.Component(jcal);
  const vevents = comp.getAllSubcomponents('vevent');
  const items: ClassItem[] = [];
  const seenEvents = new Set<string>();
  const seriesByKey = new Map<string, ClassItem>();

  for (let i = 0; i < vevents.length; i++) {
    const vevent = vevents[i];
    const event = new ICAL.Event(vevent);
    const title = (event.summary || `Class ${i + 1}`).trim();
    const rawLocation = (event.location || '').trim();
    const description = (event.description || '').trim();

    // Try location field first; only fall back to summary + description if location isn't
    // explicitly online/remote/TBA.
    let resolved = resolveBuildingFromText(rawLocation);
    if (!resolved.building && !isOnlineOrUnassignedLocation(rawLocation)) {
      resolved = resolveBuildingFromText(`${title} ${description}`);
    }

    const startTime = event.startDate ? formatIcalTime(event.startDate) : '';
    const endTime = event.endDate ? formatIcalTime(event.endDate) : '';
    const timeLabel = startTime && endTime ? `${startTime} – ${endTime}` : startTime;
    const dateKey = formatIcalDateKey(event.startDate);
    const eventDays = extractIcalDays(vevent, event.startDate);

    // Dedupe identical events on the same date, while keeping distinct-date meetings so
    // non-RRULE calendars merge into the full weekday set (e.g. Mon/Wed/Fri).
    const dedupeKey = `${title.toLowerCase()}|${rawLocation.toLowerCase()}|${timeLabel}|${dateKey}`;
    if (seenEvents.has(dedupeKey)) continue;
    seenEvents.add(dedupeKey);

    const seriesKey = `${title.toLowerCase()}|${rawLocation.toLowerCase()}|${timeLabel}`;
    const existing = seriesByKey.get(seriesKey);
    if (existing) {
      existing.daysLabel = mergeDayLabels(existing.daysLabel, eventDays);
      continue;
    }

    const item: ClassItem = {
      id: `ics-${i}-${title.slice(0, 12).replace(/\W+/g, '').toLowerCase()}`,
      title,
      timeLabel,
      daysLabel: mergeDayLabels('', eventDays),
      rawLocation: rawLocation || resolved.room || 'Location not listed',
      room: resolved.room,
      buildingId: resolved.building?.id ?? null,
      buildingName: resolved.building?.canonicalName ?? null,
    };
    seriesByKey.set(seriesKey, item);
    items.push(item);
  }

  return items;
}

/**
 * Extracts text from a PDF schedule completely client-side via pdfjs-dist,
 * then parses courses and room locations.
 */
export async function parsePdfSchedule(file: File): Promise<ClassItem[]> {
  const [pdfjsLib, { default: pdfWorkerUrl }] = await Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
  ]);
  pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

  const buffer = await file.arrayBuffer();
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(buffer),
    // pdfjs-dist v6 removed the worker JS eval path; retained for API compatibility
    isEvalSupported: false,
  } as Parameters<typeof pdfjsLib.getDocument>[0]);

  try {
    const pdf = await loadingTask.promise;
    const lines: string[] = [];
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const content = await page.getTextContent();

      // Group text items into visual lines by Y coordinate
      const rowBuckets = new Map<number, { x: number; str: string }[]>();
      for (const item of content.items) {
        if (!('str' in item) || !item.str.trim()) continue;
        const tx = item.transform;
        const yKey = Math.round(tx[5] / 4) * 4;
        const bucket = rowBuckets.get(yKey) ?? [];
        bucket.push({ x: tx[4], str: item.str });
        rowBuckets.set(yKey, bucket);
      }

      const sortedRows = [...rowBuckets.entries()].sort((a, b) => b[0] - a[0]);
      for (const [, bucket] of sortedRows) {
        bucket.sort((a, b) => a.x - b.x);
        lines.push(bucket.map((b) => b.str).join(' '));
      }
    }

    return parseTextSchedule(lines.join('\n'));
  } finally {
    await loadingTask.destroy();
  }
}

const COURSE_CODE_RX = /\b([A-Z]{2,6})\s?(\d{3}[A-Z]?)\b/;
const TIME_RANGE_RX =
  /\b(\d{1,2}:\d{2}\s?(?:AM|PM)?(?:\s?[-–—]\s?\d{1,2}:\d{2}\s?(?:AM|PM)?)?)\b/i;
const DAYS_RX =
  /\b((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:[/,\s]+(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun))*|MoWeFr|TuTh|MoWe|MWF|MW|TR|Tu\/Th|T\/Th|M\/W\/F|M\/W)\b/i;

/**
 * Parses pasted plain-text schedules (WISER exports, syllabi, notes).
 * Handles both single-line ("CS 240 | MWF 11:00 AM | M-01-0408")
 * and multi-line blocks (course header followed by time/room lines).
 */
export function parseTextSchedule(rawText: string): ClassItem[] {
  const lines = rawText
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const items: ClassItem[] = [];
  let pendingTitle = '';
  let pendingTime = '';
  let pendingDays = '';

  const pushItem = (
    title: string,
    timeLabel: string,
    daysLabel: string,
    rawLocation: string,
    buildingId: string | null,
    buildingName: string | null,
    room: string
  ) => {
    items.push({
      id: `txt-${items.length}`,
      title: title || `Class ${items.length + 1}`,
      timeLabel,
      daysLabel,
      rawLocation,
      room,
      buildingId,
      buildingName,
    });
  };

  for (const line of lines) {
    const courseMatch = line.match(COURSE_CODE_RX);
    const timeMatch = line.match(TIME_RANGE_RX);
    const daysMatch = line.match(DAYS_RX);
    const isOnline = isOnlineOrUnassignedLocation(line);

    if (isOnline && (courseMatch || pendingTitle)) {
      let title = pendingTitle;
      if (courseMatch) {
        const beforeParts = line.split(/[|•·\t—–]/)[0]?.trim() ?? '';
        title =
          beforeParts.length >= 4 && beforeParts.length <= 56
            ? beforeParts
            : `${courseMatch[1]} ${courseMatch[2]}`;
      }
      const timeLabel = timeMatch ? timeMatch[1].trim() : pendingTime;
      const daysLabel = daysMatch ? daysMatch[1].trim() : pendingDays;
      pushItem(title, timeLabel, daysLabel, 'Online / Unassigned', null, null, '');

      pendingTitle = '';
      pendingTime = '';
      pendingDays = '';
      continue;
    }

    const resolved = isOnline ? { building: null, room: '' } : resolveBuildingFromText(line);

    if (resolved.building) {
      let title = '';
      if (courseMatch) {
        const beforeParts = line.split(/[|•·\t—–]/)[0]?.trim() ?? '';
        title =
          beforeParts.length >= 4 && beforeParts.length <= 56
            ? beforeParts
            : `${courseMatch[1]} ${courseMatch[2]}`;
      } else if (pendingTitle) {
        title = pendingTitle;
      } else {
        const cleaned = line
          .replace(TIME_RANGE_RX, '')
          .replace(DAYS_RX, '')
          .replace(/[|•·—–]+/g, ' ')
          .trim();
        title = cleaned.slice(0, 48) || resolved.building.canonicalName;
      }

      const timeLabel = timeMatch ? timeMatch[1].trim() : pendingTime;
      const daysLabel = daysMatch ? daysMatch[1].trim() : pendingDays;
      const rawLoc = resolved.room
        ? `${resolved.building.shortCode} ${resolved.room}`
        : resolved.building.canonicalName;

      pushItem(
        title,
        timeLabel,
        daysLabel,
        rawLoc,
        resolved.building.id,
        resolved.building.canonicalName,
        resolved.room
      );

      pendingTitle = '';
      pendingTime = '';
      pendingDays = '';
    } else {
      if (courseMatch) {
        pendingTitle = line.slice(0, 56);
        pendingTime = timeMatch ? timeMatch[1].trim() : '';
        pendingDays = daysMatch ? daysMatch[1].trim() : '';
      } else {
        if (timeMatch) pendingTime = timeMatch[1].trim();
        if (daysMatch) pendingDays = daysMatch[1].trim();
      }
    }
  }

  return items;
}
