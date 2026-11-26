import { describe, expect, it, vi } from 'vitest';
import {
  parseIcsSchedule,
  parsePdfPages,
  parsePdfSchedule,
  parseTextSchedule,
  type PdfTextItem,
} from '../schedule';

const mockDestroy = vi.fn().mockResolvedValue(undefined);
const mockGetDocument = vi.fn();

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: (...args: unknown[]) => mockGetDocument(...args),
}));

vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({
  default: 'mock-worker.mjs',
}));

describe('parseIcsSchedule', () => {
  it('merges distinct-date non-RRULE meetings into Mon/Wed/Fri instead of collapsing to Mon', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:cs240-mon@umb',
      'DTSTART:20260907T100000',
      'DTEND:20260907T111500',
      'SUMMARY:CS 240 — Programming in C',
      'LOCATION:M-01-0408',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:cs240-wed@umb',
      'DTSTART:20260909T100000',
      'DTEND:20260909T111500',
      'SUMMARY:CS 240 — Programming in C',
      'LOCATION:M-01-0408',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:cs240-fri@umb',
      'DTSTART:20260911T100000',
      'DTEND:20260911T111500',
      'SUMMARY:CS 240 — Programming in C',
      'LOCATION:M-01-0408',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');

    const items = parseIcsSchedule(ics);
    expect(items).toHaveLength(1);
    expect(items[0].daysLabel).toBe('Mon/Wed/Fri');
    expect(items[0].buildingId).toBe('mccormack');
    expect(items[0].room).toBe('01-0408');
  });

  it('deduplicates identical events on the same date', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:dup-1@umb',
      'DTSTART:20260908T123000',
      'DTEND:20260908T134500',
      'SUMMARY:BIOL 112',
      'LOCATION:ISC 2-2003',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:dup-2@umb',
      'DTSTART:20260908T123000',
      'DTEND:20260908T134500',
      'SUMMARY:BIOL 112',
      'LOCATION:ISC 2-2003',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');

    const items = parseIcsSchedule(ics);
    expect(items).toHaveLength(1);
    expect(items[0].buildingId).toBe('isc');
  });

  it('keeps online classes unmapped even when description mentions campus words', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:soc101@umb',
      'DTSTART:20270125T100000',
      'DTEND:20270125T111500',
      'SUMMARY:SOCIOL 101 — Intro to Sociology',
      'LOCATION:Online Asynchronous',
      'DESCRIPTION:Office hours optionally in Wheatley Hall.',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');

    const items = parseIcsSchedule(ics);
    expect(items).toHaveLength(1);
    expect(items[0].buildingId).toBeNull();
  });
});

describe('parseTextSchedule', () => {
  it('parses realistic Spring 2027 lines and leaves online courses unmapped', () => {
    const text = [
      'CS 285L | M/W 11:00 AM - 12:15 PM | M-01-0408',
      'MUSIC 111 | Tu/Th 1:00 PM - 2:15 PM | University Hall 2310',
      'MATH 345 | MWF 9:00 AM - 9:50 AM | W-02-0041',
      'SOCIOL 101 | Online Asynchronous | TBA',
    ].join('\n');

    const items = parseTextSchedule(text);
    expect(items).toHaveLength(4);
    expect(items[0]).toMatchObject({ buildingId: 'mccormack', room: '01-0408' });
    expect(items[1]).toMatchObject({ buildingId: 'uhall', room: '2310' });
    expect(items[2]).toMatchObject({ buildingId: 'wheatley', room: '02-0041' });
    expect(items[3]).toMatchObject({ buildingId: null, room: '' });
  });

  it('does not invent classes from day-only or false-positive lines', () => {
    const text = [
      'W 10:00 AM',
      'ENGL 101 M 9:00',
      'Sec U 01',
      'M/W 10:00',
      'Library Science 101',
    ].join('\n');

    const items = parseTextSchedule(text);
    expect(items).toHaveLength(0);
  });

  it('keeps TBA / online lines with hour ranges unmapped instead of routing them', () => {
    const items = parseTextSchedule('ENGL 101 | W 10-12 | TBA');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ buildingId: null, room: '' });
  });
});

describe('parsePdfSchedule', () => {
  it('passes isEvalSupported: false and calls loadingTask.destroy() in finally even on error', async () => {
    mockDestroy.mockClear();
    mockGetDocument.mockReturnValueOnce({
      promise: Promise.resolve({
        numPages: 1,
        getPage: vi.fn().mockResolvedValue({
          getTextContent: vi.fn().mockResolvedValue({
            items: [{ str: 'CS 240 | MWF 10:00 AM | M-01-0408', transform: [1, 0, 0, 1, 10, 700] }],
          }),
        }),
      }),
      destroy: mockDestroy,
    });

    const fakeFile = {
      arrayBuffer: async () => new Uint8Array([37, 80, 68, 70]).buffer,
    } as File;

    const result = await parsePdfSchedule(fakeFile);
    expect(result).toHaveLength(1);
    expect(result[0].buildingId).toBe('mccormack');
    expect(mockGetDocument).toHaveBeenCalledWith(
      expect.objectContaining({ isEvalSupported: false })
    );
    expect(mockDestroy).toHaveBeenCalledTimes(1);

    // Also verify destroy runs when getPage throws
    mockDestroy.mockClear();
    mockGetDocument.mockReturnValueOnce({
      promise: Promise.resolve({
        numPages: 1,
        getPage: vi.fn().mockRejectedValue(new Error('corrupt page')),
      }),
      destroy: mockDestroy,
    });

    await expect(parsePdfSchedule(fakeFile)).rejects.toThrow('corrupt page');
    expect(mockDestroy).toHaveBeenCalledTimes(1);
  });

  it('parses multi-column WISER weekly calendar-grid PDFs and merges Mon/Wed/Fri + Tue/Thu', () => {
    const gridPage: PdfTextItem[] = [
      // Weekday header row across X columns
      { str: 'Monday', x: 100, y: 700, width: 40 },
      { str: 'Tuesday', x: 200, y: 700, width: 42 },
      { str: 'Wednesday', x: 300, y: 700, width: 52 },
      { str: 'Thursday', x: 400, y: 700, width: 44 },
      { str: 'Friday', x: 500, y: 700, width: 32 },
      // Time axis on far left (should be ignored)
      { str: '10:00 AM', x: 20, y: 650, width: 38 },
      { str: '1:00 PM', x: 20, y: 560, width: 36 },
      // Monday: CS 240 in McCormack
      { str: 'CS 240 - 01', x: 96, y: 652 },
      { str: '10:00 AM - 10:50 AM', x: 96, y: 640 },
      { str: 'M-01-0408', x: 96, y: 628 },
      // Wednesday: same CS 240
      { str: 'CS 240 - 01', x: 296, y: 652 },
      { str: '10:00 AM - 10:50 AM', x: 296, y: 640 },
      { str: 'M-01-0408', x: 296, y: 628 },
      // Friday: same CS 240
      { str: 'CS 240 - 01', x: 496, y: 652 },
      { str: '10:00 AM - 10:50 AM', x: 496, y: 640 },
      { str: 'M-01-0408', x: 496, y: 628 },
      // Tuesday & Thursday: BIOL 112 in ISC
      { str: 'BIOL 112', x: 196, y: 570 },
      { str: '1:00 PM - 2:15 PM', x: 196, y: 558 },
      { str: 'ISC 2-2003', x: 196, y: 546 },
      { str: 'BIOL 112', x: 396, y: 570 },
      { str: '1:00 PM - 2:15 PM', x: 396, y: 558 },
      { str: 'ISC 2-2003', x: 396, y: 546 },
    ];

    const items = parsePdfPages([gridPage]);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      title: 'CS 240 - 01',
      daysLabel: 'Mon/Wed/Fri',
      buildingId: 'mccormack',
      room: '01-0408',
    });
    expect(items[1]).toMatchObject({
      title: 'BIOL 112',
      daysLabel: 'Tue/Thu',
      buildingId: 'isc',
      room: '2-2003',
    });
  });
});
