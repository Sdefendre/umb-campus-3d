import type { StartPoint } from './types';

export interface MajorBuildingDef {
  id: string;
  canonicalName: string;
  osmNames: string[];
  shortCode: string;
  /** Full/multi-character aliases (case-insensitive word-boundary match) */
  aliases: string[];
  /** Single-letter or short room-prefix codes matched in structured room contexts like M-01-408 */
  roomPrefixes: string[];
}

/**
 * Canonical UMass Boston campus buildings and alias table.
 * Ordered so more specific aliases are evaluated reliably.
 */
export const MAJOR_BUILDINGS: MajorBuildingDef[] = [
  {
    id: 'healey',
    canonicalName: 'Healey Library',
    osmNames: ['Healey Library'],
    shortCode: 'HL',
    aliases: ['healey library', 'healey', 'joseph p. healey library', 'hl', 'ulib', 'library'],
    roomPrefixes: ['HL', 'ULIB', 'L'],
  },
  {
    id: 'wheatley',
    canonicalName: 'Wheatley Hall',
    osmNames: ['Wheatley Hall'],
    shortCode: 'W',
    aliases: ['wheatley hall', 'wheatley', 'wh'],
    roomPrefixes: ['W', 'WH'],
  },
  {
    id: 'mccormack',
    canonicalName: 'McCormack Hall',
    osmNames: ['McCormack Hall'],
    shortCode: 'M',
    aliases: ['mccormack hall', 'mccormack', 'mc cormack', 'mcc', 'mc'],
    roomPrefixes: ['M', 'MC', 'MCC'],
  },
  {
    id: 'uhall',
    canonicalName: 'University Hall',
    osmNames: ['University Hall'],
    shortCode: 'UH',
    aliases: ['university hall', 'univ hall', 'uhall', 'u-hall', 'u hall', 'uh'],
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
    aliases: ['campus center', 'campus ctr', 'student center', 'cc'],
    roomPrefixes: ['CC'],
  },
  {
    id: 'quinn',
    canonicalName: 'Quinn Administration Building',
    osmNames: ['Quinn Administration Building'],
    shortCode: 'Q',
    aliases: [
      'quinn administration building',
      'quinn administration',
      'quinn admin',
      'quinn',
      'qa',
      'qab',
    ],
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
      'cac',
      'gym',
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

/**
 * Resolves a free-form location string (e.g. "M-01-0408", "ISC 2-2003",
 * "University Hall 2310", "W 02-0041", "Healey Library LL-12") to a major UMB building.
 */
export function resolveBuildingFromText(text: string): {
  building: MajorBuildingDef | null;
  room: string;
} {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (!cleaned) return { building: null, room: '' };

  // 1. Check multi-character aliases first (longest first to avoid partial hits)
  const aliasCandidates: { alias: string; building: MajorBuildingDef }[] = [];
  for (const b of MAJOR_BUILDINGS) {
    for (const alias of b.aliases) {
      aliasCandidates.push({ alias, building: b });
    }
  }
  aliasCandidates.sort((a, b) => b.alias.length - a.alias.length);

  for (const { alias, building } of aliasCandidates) {
    const pattern = new RegExp(`(?:^|[^a-z0-9])${escapeRegex(alias)}(?=$|[^a-z0-9])`, 'i');
    const match = pattern.exec(cleaned);
    if (match) {
      const room = extractRoomCode(cleaned, match.index + match[0].length, building);
      return { building, room };
    }
  }

  // 2. Check structured room prefix patterns (e.g. "M-01-0408", "W 02-0041", "Q-3-040", "M01-408")
  for (const b of MAJOR_BUILDINGS) {
    for (const prefix of b.roomPrefixes) {
      const rx = new RegExp(
        `(?:^|[\\s,(;/|:])${escapeRegex(prefix)}(?:[-\\s]+((?:LL|UL|PL|G|B)?\\d[\\w-]*)|[-\\s]*(0\\d[-\\dA-Z]*))`,
        'i'
      );
      const m = rx.exec(cleaned);
      if (m) {
        const room = (m[1] || m[2] || '').replace(/\s+/g, '-').toUpperCase();
        return { building: b, room };
      }
    }
  }

  // 3. Exact single-letter building token when the entire location field is just "M", "W", or "Q"
  const upper = cleaned.toUpperCase();
  for (const b of MAJOR_BUILDINGS) {
    if (b.roomPrefixes.includes(upper)) {
      return { building: b, room: '' };
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
  const after = text.slice(afterIndex);
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
    /(?:(?:rm|room|ste|suite|#)\.?\s*)?((?:LL|UL|PL|G|B)?\d{1,2}[-\s]\d{2,4}[A-Z]?|(?:LL|UL|PL|G|B)\d{2,4}[A-Z]?|\b\d{3,4}[A-Z]?\b)/i;

  const afterMatch = afterCleaned.match(roomRx);
  if (afterMatch) {
    return afterMatch[1].replace(/\s+/g, '-').toUpperCase();
  }

  // Fallback: check before the alias (e.g. "M-01-0408 (McCormack Hall)"), stripping course codes like "CS 240"
  const before = text
    .slice(0, afterIndex)
    .replace(/\b[A-Z]{2,5}\s?\d{3}[A-Z]?\b/g, ' ');
  const beforeMatch = before.match(
    /(?:(?:rm|room|ste|suite|#)\.?\s*)?((?:LL|UL|PL|G|B)?\d{1,2}-\d{2,4}[A-Z]?)/i
  );
  return beforeMatch ? beforeMatch[1].replace(/\s+/g, '-').toUpperCase() : '';
}
