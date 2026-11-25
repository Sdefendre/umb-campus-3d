import type { StartPoint } from './types';

export interface MajorBuildingDef {
  id: string;
  canonicalName: string;
  osmNames: string[];
  shortCode: string;
  /** Unambiguous full/multi-word aliases (case-insensitive word-boundary match) */
  aliases: string[];
  /** Room-prefix codes matched in structured room contexts like M-01-0408, ISC 2-2003, HL-04-0012 */
  roomPrefixes: string[];
}

/**
 * Canonical UMass Boston campus buildings and alias table.
 * Broad English words ("library", "gym") and 2-letter codes ("cc", "mc", "uh", "qa", "hl", "wh")
 * are intentionally excluded from unconditional prose aliases to avoid false positives such as
 * "Library Science 101" or "QA 101".
 */
export const MAJOR_BUILDINGS: MajorBuildingDef[] = [
  {
    id: 'healey',
    canonicalName: 'Healey Library',
    osmNames: ['Healey Library'],
    shortCode: 'HL',
    aliases: [
      'joseph p. healey library',
      'healey library',
      'healey',
      'university library',
      'umb library',
    ],
    roomPrefixes: ['HL', 'ULIB', 'L'],
  },
  {
    id: 'wheatley',
    canonicalName: 'Wheatley Hall',
    osmNames: ['Wheatley Hall'],
    shortCode: 'W',
    aliases: ['wheatley hall', 'wheatley'],
    roomPrefixes: ['W', 'WH'],
  },
  {
    id: 'mccormack',
    canonicalName: 'McCormack Hall',
    osmNames: ['McCormack Hall'],
    shortCode: 'M',
    aliases: ['mccormack hall', 'mccormack', 'mc cormack'],
    roomPrefixes: ['M', 'MC', 'MCC'],
  },
  {
    id: 'uhall',
    canonicalName: 'University Hall',
    osmNames: ['University Hall'],
    shortCode: 'UH',
    aliases: ['university hall', 'univ hall', 'uhall', 'u-hall', 'u hall'],
    roomPrefixes: ['UH', 'UHALL', 'U'],
  },
  {
    id: 'isc',
    canonicalName: 'Integrated Sciences Complex',
    osmNames: ['Integrated Sciences Complex'],
    shortCode: 'ISC',
    aliases: [
      'integrated sciences complex',
      'integrated science complex',
      'integrated sciences',
      'sciences complex',
      'isc',
    ],
    roomPrefixes: ['ISC'],
  },
  {
    id: 'campus-center',
    canonicalName: 'Campus Center',
    osmNames: ['Campus Center'],
    shortCode: 'CC',
    aliases: ['campus center', 'campus ctr', 'student center'],
    roomPrefixes: ['CC'],
  },
  {
    id: 'quinn',
    canonicalName: 'Quinn Administration Building',
    osmNames: ['Quinn Administration Building'],
    shortCode: 'Q',
    aliases: ['quinn administration building', 'quinn administration', 'quinn admin', 'quinn'],
    roomPrefixes: ['Q', 'QA', 'QAB'],
  },
  {
    id: 'clark',
    canonicalName: 'Clark Athletic Center',
    osmNames: ['Clark Athletic Center'],
    shortCode: 'CAC',
    aliases: [
      'clark athletic center',
      'clark athletic',
      'clark center',
      'athletic center',
      'beacon fitness',
      'clark gym',
    ],
    roomPrefixes: ['CAC', 'CLARK'],
  },
];

export const START_POINTS: StartPoint[] = [
  {
    id: 'jfk-walkway',
    name: 'Campus Entrance (JFK/UMass Walkway)',
    shortLabel: 'JFK/UMass',
    lonLat: { lon: -71.0414, lat: 42.3149 },
  },
  {
    id: 'campus-center-shuttle',
    name: 'Campus Center Shuttle Drop-off',
    shortLabel: 'CC Shuttle Stop',
    lonLat: { lon: -71.0369, lat: 42.3137 },
  },
  {
    id: 'west-garage',
    name: 'West Garage Entrance',
    shortLabel: 'West Garage',
    lonLat: { lon: -71.0402, lat: 42.3132 },
  },
];

const ONLINE_LOCATION_RX =
  /\b(?:online|remote|virtual|zoom|asynchronous|async|web[\s-]?based|distance\s+learning|internet|tba|tbd|arranged)\b/i;

export function isOnlineOrUnassignedLocation(text: string): boolean {
  return ONLINE_LOCATION_RX.test(text);
}

export function matchOsmMajorBuilding(osmName: string | undefined): MajorBuildingDef | null {
  if (!osmName) return null;
  const lower = osmName.trim().toLowerCase();
  for (const b of MAJOR_BUILDINGS) {
    if (b.osmNames.some((n) => n.toLowerCase() === lower)) {
      return b;
    }
  }
  return null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const TIME_TOKEN_RX = /\b\d{1,2}:\d{2}(?:\s*(?:am|pm))?\b/gi;
const TERM_YEAR_RX = /\b(?:fall|spring|summer|winter)\s+20\d{2}\b/gi;

// Pre-sorted alias & prefix lookup tables
const ALIAS_CANDIDATES: { alias: string; building: MajorBuildingDef }[] = [];
const PREFIX_CANDIDATES: { prefix: string; building: MajorBuildingDef }[] = [];

for (const b of MAJOR_BUILDINGS) {
  for (const alias of b.aliases) {
    ALIAS_CANDIDATES.push({ alias, building: b });
  }
  for (const prefix of b.roomPrefixes) {
    PREFIX_CANDIDATES.push({ prefix, building: b });
  }
}
ALIAS_CANDIDATES.sort((a, b) => b.alias.length - a.alias.length);
PREFIX_CANDIDATES.sort((a, b) => b.prefix.length - a.prefix.length);

const HEALEY_DEF = MAJOR_BUILDINGS.find((b) => b.id === 'healey')!;

/**
 * Resolves a free-form location string (e.g. "M-01-0408", "ISC 2-2003",
 * "University Hall 2310", "W 02-0041", "Healey Library LL-12") to a major UMB building.
 *
 * Single-letter prefixes (W, M, U, Q, L) strictly require the structured UMB floor-room
 * pattern (e.g. M-01-0408, W 02-0041, Q-3-040, L-LL-12, M01-408) and never match day
 * abbreviations like "W 10:00 AM", "ENGL 101 M 9:00", "Sec U 01", or "M/W 10:00".
 */
export function resolveBuildingFromText(text: string): {
  building: MajorBuildingDef | null;
  room: string;
} {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (!cleaned) return { building: null, room: '' };

  // 1. Check unambiguous full/multi-word aliases first (longest first)
  for (const { alias, building } of ALIAS_CANDIDATES) {
    const pattern = new RegExp(`(?:^|[^a-z0-9])${escapeRegex(alias)}(?=$|[^a-z0-9])`, 'i');
    const match = pattern.exec(cleaned);
    if (match) {
      const room = extractRoomCode(cleaned, match.index + match[0].length, building);
      return { building, room };
    }
  }

  // 1b. "Library" only matches Healey Library when immediately followed by a room or floor code
  // (never "Library Science 101").
  const libRoomMatch =
    /(?:^|[^a-z0-9])library(?:\s+(?:rm|room|#)\.?)?[\s-]+((?:LL|UL|PL|G|B)[-\s]?\d{1,4}[A-Z]?|\d{1,2}-\d{2,4}[A-Z]?|\d{3,4}[A-Z]?)(?!\s*:|\s*(?:am|pm)\b|[0-9a-z-])/i.exec(
      cleaned
    );
  if (libRoomMatch) {
    const room = libRoomMatch[1].replace(/\s+/g, '-').toUpperCase();
    return { building: HEALEY_DEF, room };
  }

  // 2. Check structured room prefix patterns (longest prefix first).
  // Note: "/" is deliberately excluded from the leading boundary so "M/W" never triggers W.
  for (const { prefix, building } of PREFIX_CANDIDATES) {
    const escaped = escapeRegex(prefix);
    let rx: RegExp;

    if (prefix.length === 1) {
      // Single-letter prefixes (W, M, U, Q, L) require structured floor-hyphen-room form:
      // e.g. M-01-0408, W 02-0041, Q-3-040, L-LL-12, M01-408
      rx = new RegExp(
        `(?:^|[\\s,(;|:])${escaped}(?:[-\\s]+((?:LL|UL|PL|G|B|\\d{1,2})-\\d{2,4}[A-Z]?)|(0\\d-\\d{2,4}[A-Z]?))(?!\\s*:|\\s*(?:am|pm)\\b|[0-9a-z-])`,
        'gi'
      );
    } else if (prefix.length === 2) {
      // 2-letter prefixes (HL, WH, MC, UH, CC, QA) require hyphenated room, LL/UL/etc.,
      // floor-room, or 4-digit room so course codes like "QA 101" or "CC 101" don't false-match.
      rx = new RegExp(
        `(?:^|[\\s,(;|:])${escaped}(?:-\\s*((?:LL|UL|PL|G|B)-?\\d{1,4}[A-Z]?|\\d{1,2}-\\d{2,4}[A-Z]?|\\d{3,4}[A-Z]?)|\\s+((?:LL|UL|PL|G|B)-?\\d{1,4}[A-Z]?|\\d{1,2}-\\d{2,4}[A-Z]?|\\d{4}[A-Z]?))(?!\\s*:|\\s*(?:am|pm)\\b|[0-9a-z-])`,
        'gi'
      );
    } else {
      // 3+ letter prefixes (ISC, ULIB, MCC, UHALL, QAB, CAC, CLARK)
      rx = new RegExp(
        `(?:^|[\\s,(;|:])${escaped}[-\\s]+((?:LL|UL|PL|G|B)-?\\d{1,4}[A-Z]?|\\d{1,2}-\\d{2,4}[A-Z]?|\\d{3,4}[A-Z]?)(?!\\s*:|\\s*(?:am|pm)\\b|[0-9a-z-])`,
        'gi'
      );
    }

    let m: RegExpExecArray | null;
    while ((m = rx.exec(cleaned)) !== null) {
      const rawRoom = m[1] || m[2] || '';
      if (!rawRoom) continue;
      // Defensive check: never match if immediately followed by a time pattern
      const tail = cleaned.slice(m.index + m[0].length);
      if (/^\s*:\d{2}/.test(tail)) continue;
      const room = rawRoom.replace(/\s+/g, '-').toUpperCase();
      return { building, room };
    }
  }

  // 3. Exact multi-letter building code when the entire location field is e.g. "ISC", "CC", "HL"
  // (never single-letter day tokens like "W" or "M").
  const upper = cleaned.toUpperCase();
  if (upper.length >= 2) {
    for (const b of MAJOR_BUILDINGS) {
      if (b.roomPrefixes.some((p) => p.length >= 2 && p === upper)) {
        return { building: b, room: '' };
      }
    }
  }

  return { building: null, room: '' };
}

function extractRoomCode(
  text: string,
  afterIndex: number,
  building: MajorBuildingDef
): string {
  // Prefer room numbers immediately following the matched building name
  const after = text
    .slice(afterIndex)
    .replace(TIME_TOKEN_RX, ' ')
    .replace(TERM_YEAR_RX, ' ');

  const prefixStrip = building.roomPrefixes
    .slice()
    .sort((a, b) => b.length - a.length)
    .map(escapeRegex)
    .join('|');
  const afterCleaned = after.replace(
    new RegExp(`^\\s*(?:${prefixStrip})(?:[-\\s]+|(?=[0-9]))`, 'i'),
    ' '
  );

  const roomRx =
    /(?:(?:rm|room|ste|suite|#)\.?\s*)?((?:LL|UL|PL|G|B)[-\s]\d{1,4}[A-Z]?|(?:LL|UL|PL|G|B)\d{2,4}[A-Z]?|\d{1,2}-\d{2,4}[A-Z]?|\b\d{3,4}[A-Z]?\b)(?!\s*:)/i;

  const afterMatch = afterCleaned.match(roomRx);
  if (afterMatch) {
    return afterMatch[1].replace(/\s+/g, '-').toUpperCase();
  }

  // Fallback: check before the alias (e.g. "M-01-0408 (McCormack Hall)"), stripping course codes like "CS 240"
  const before = text
    .slice(0, afterIndex)
    .replace(TIME_TOKEN_RX, ' ')
    .replace(TERM_YEAR_RX, ' ')
    .replace(/\b[A-Z]{2,6}\s?\d{3}[A-Z]?\b/g, ' ');
  const beforeMatch = before.match(
    /(?:(?:rm|room|ste|suite|#)\.?\s*)?((?:LL|UL|PL|G|B)[-\s]\d{1,4}[A-Z]?|(?:LL|UL|PL|G|B)?\d{1,2}-\d{2,4}[A-Z]?)(?!\s*:)/i
  );
  return beforeMatch ? beforeMatch[1].replace(/\s+/g, '-').toUpperCase() : '';
}
