import ICAL from 'ical.js';
import { isOnlineOrUnassignedLocation, resolveBuildingFromText } from './buildings';
import type { ClassItem } from './types';

const DAY_ORDER = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

export interface PdfTextItem {
  str: string;
  x: number;
  y: number;
  width?: number;
}

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

const WEEKDAY_HEADER_MAP: Record<string, (typeof DAY_ORDER)[number]> = {
  mon: 'Mon',
  monday: 'Mon',
  tue: 'Tue',
  tues: 'Tue',
  tuesday: 'Tue',
  wed: 'Wed',
  wednesday: 'Wed',
  thu: 'Thu',
  thur: 'Thu',
  thurs: 'Thu',
  thursday: 'Thu',
  fri: 'Fri',
  friday: 'Fri',
  sat: 'Sat',
  saturday: 'Sat',
  sun: 'Sun',
  sunday: 'Sun',
};

const AXIS_TIME_ONLY_RX = /^\d{1,2}(?::\d{2})?\s*(?:AM|PM)$/i;

/**
 * Attempts to parse multi-column weekly calendar-grid PDFs (e.g. WISER Weekly Schedule)
 * where Mon..Fri headers sit across a top row and each class block occupies a vertical box
 * inside its weekday column. Returns null if the page is not a weekly grid.
 */
function tryParseWeeklyGridPage(pageItems: PdfTextItem[]): ClassItem[] | null {
  // 1. Find weekday header candidates grouped by approximate Y row
  const headerCandidates: { day: (typeof DAY_ORDER)[number]; x: number; y: number }[] = [];
  for (const it of pageItems) {
    const token = it.str.trim().toLowerCase().replace(/[.:,]/g, '');
    const day = WEEKDAY_HEADER_MAP[token];
    if (!day) continue;
    const centerX = it.x + (it.width ? it.width * 0.5 : it.str.length * 3);
    headerCandidates.push({ day, x: centerX, y: it.y });
  }
  if (headerCandidates.length < 3) return null;

  // Pick the Y row containing the most distinct weekdays separated in X
  let bestRow: { day: (typeof DAY_ORDER)[number]; x: number; y: number }[] = [];
  for (const anchor of headerCandidates) {
    const row = headerCandidates.filter((c) => Math.abs(c.y - anchor.y) <= 12);
    const uniqueDays = new Map<string, (typeof row)[number]>();
    for (const c of row) {
      if (!uniqueDays.has(c.day)) uniqueDays.set(c.day, c);
    }
    if (uniqueDays.size > bestRow.length) {
      bestRow = [...uniqueDays.values()];
    }
  }
  if (bestRow.length < 3) return null;

  bestRow.sort((a, b) => a.x - b.x);
  // Ensure headers are genuinely laid out in horizontal columns (at least 45pt apart on average)
  const avgSpacing = (bestRow[bestRow.length - 1].x - bestRow[0].x) / (bestRow.length - 1);
  if (avgSpacing < 45) return null;

  const headerY = bestRow.reduce((sum, c) => sum + c.y, 0) / bestRow.length;
  const colBounds = bestRow.map((col, idx) => {
    const left =
      idx === 0
        ? col.x - avgSpacing * 0.48
        : (bestRow[idx - 1].x + col.x) * 0.5;
    const right =
      idx === bestRow.length - 1
        ? col.x + avgSpacing * 0.55
        : (col.x + bestRow[idx + 1].x) * 0.5;
    return { day: col.day, left, right, items: [] as PdfTextItem[] };
  });

  // 2. Bucket items below the header row into weekday columns
  for (const it of pageItems) {
    if (it.y >= headerY - 4) continue;
    const text = it.str.trim();
    if (!text) continue;
    // Ignore left-margin time axis labels (e.g. "9:00 AM") outside first column
    if (it.x < colBounds[0].left && AXIS_TIME_ONLY_RX.test(text)) continue;

    const itemX = it.x + (it.width ? Math.min(it.width * 0.25, 20) : 6);
    const col = colBounds.find((c) => itemX >= c.left && itemX < c.right);
    if (col) col.items.push(it);
  }

  // 3. Within each column, group vertically adjacent lines into event cards
  const seriesByKey = new Map<string, ClassItem>();
  const results: ClassItem[] = [];

  for (const col of colBounds) {
    if (col.items.length === 0) continue;

    // Group items inside this column into visual lines first (|dy| <= 4)
    const lineBuckets = new Map<number, PdfTextItem[]>();
    for (const it of col.items) {
      const yKey = Math.round(it.y / 4) * 4;
      const list = lineBuckets.get(yKey) ?? [];
      list.push(it);
      lineBuckets.set(yKey, list);
    }
    const colLines = [...lineBuckets.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([y, items]) => {
        items.sort((a, b) => a.x - b.x);
        return { y, text: items.map((i) => i.str.trim()).join(' ') };
      });

    // Cluster lines into discrete class cards when vertical gap > 18pt or a new course code starts
    const cards: string[][] = [];
    let currentCard: string[] = [];
    let prevY: number | null = null;

    for (const line of colLines) {
      const startsNewCourse =
        currentCard.length > 0 &&
        COURSE_CODE_RX.test(line.text) &&
        currentCard.some((l) => COURSE_CODE_RX.test(l));
      const largeGap = prevY !== null && prevY - line.y > 18;

      if (currentCard.length > 0 && (largeGap || startsNewCourse)) {
        cards.push(currentCard);
        currentCard = [];
      }
      currentCard.push(line.text);
      prevY = line.y;
    }
    if (currentCard.length > 0) cards.push(currentCard);

    for (const cardLines of cards) {
      const combined = cardLines.join(' ').replace(/\s+/g, ' ').trim();
      const courseMatch = combined.match(COURSE_CODE_RX);
      const timeMatch = combined.match(TIME_RANGE_RX);
      const isOnline = isOnlineOrUnassignedLocation(combined);
      const resolved = isOnline ? { building: null, room: '' } : resolveBuildingFromText(combined);

      if (!resolved.building && !(isOnline && courseMatch)) continue;

      const titleLine = cardLines.find((l) => COURSE_CODE_RX.test(l)) ?? cardLines[0] ?? '';
      const title =
        titleLine.length >= 4 && titleLine.length <= 56
          ? titleLine
          : courseMatch
            ? `${courseMatch[1]} ${courseMatch[2]}`
            : resolved.building?.canonicalName ?? 'Class';
      const timeLabel = timeMatch ? timeMatch[1].trim() : '';
      const buildingId = resolved.building?.id ?? null;
      const buildingName = resolved.building?.canonicalName ?? null;
      const rawLocation = resolved.building
        ? resolved.room
          ? `${resolved.building.shortCode} ${resolved.room}`
          : resolved.building.canonicalName
        : 'Online / Unassigned';

      const seriesKey = `${title.toLowerCase()}|${buildingId ?? 'none'}|${resolved.room}|${timeLabel}`;
      const existing = seriesByKey.get(seriesKey);
      if (existing) {
        existing.daysLabel = mergeDayLabels(existing.daysLabel, [col.day]);
        continue;
      }

      const item: ClassItem = {
        id: `pdf-grid-${results.length}`,
        title,
        timeLabel,
        daysLabel: col.day,
        rawLocation,
        room: resolved.room,
        buildingId,
        buildingName,
      };
      seriesByKey.set(seriesKey, item);
      results.push(item);
    }
  }

  return results.length > 0 ? results : null;
}

/**
 * Pure parser for positioned PDF text items. Automatically handles both multi-column
 * weekly calendar grids (WISER Weekly Schedule) and standard row-based schedule lists.
 */
export function parsePdfPages(pages: PdfTextItem[][]): ClassItem[] {
  const gridItems: ClassItem[] = [];
  const fallbackLines: string[] = [];

  for (const pageItems of pages) {
    const gridResult = tryParseWeeklyGridPage(pageItems);
    if (gridResult) {
      gridItems.push(...gridResult);
      continue;
    }

    // Standard row-grouped line extraction
    const rowBuckets = new Map<number, { x: number; str: string }[]>();
    for (const item of pageItems) {
      if (!item.str.trim()) continue;
      const yKey = Math.round(item.y / 4) * 4;
      const bucket = rowBuckets.get(yKey) ?? [];
      bucket.push({ x: item.x, str: item.str });
      rowBuckets.set(yKey, bucket);
    }

    const sortedRows = [...rowBuckets.entries()].sort((a, b) => b[0] - a[0]);
    for (const [, bucket] of sortedRows) {
      bucket.sort((a, b) => a.x - b.x);
      fallbackLines.push(bucket.map((b) => b.str).join(' '));
    }
  }

  if (gridItems.length > 0 && fallbackLines.length === 0) {
    return gridItems;
  }
  return [...gridItems, ...parseTextSchedule(fallbackLines.join('\n'))];
}

/**
 * Extracts text from a PDF schedule completely client-side via pdfjs-dist,
 * then parses courses and room locations (supporting both list and weekly-grid PDFs).
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
    const pages: PdfTextItem[][] = [];
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const content = await page.getTextContent();
      const pageItems: PdfTextItem[] = [];
      for (const item of content.items) {
        if (!('str' in item) || !item.str.trim()) continue;
        const tx = item.transform;
        pageItems.push({
          str: item.str,
          x: tx[4],
          y: tx[5],
          width: 'width' in item && typeof item.width === 'number' ? item.width : undefined,
        });
      }
      pages.push(pageItems);
    }

    return parsePdfPages(pages);
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
