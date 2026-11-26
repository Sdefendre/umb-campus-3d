import { describe, expect, it } from 'vitest';
import { findNextClass, leaveAdvice, parseMeetingDays, parseStartMinutes } from '../nextClass';
import type { ClassItem } from '../types';

const item = (id: string, daysLabel: string, timeLabel: string, buildingId: string | null = 'mccormack'): ClassItem => ({
  id,
  title: id,
  timeLabel,
  daysLabel,
  rawLocation: '',
  room: '',
  buildingId,
  buildingName: buildingId,
});

describe('parseMeetingDays', () => {
  it.each([
    ['Mon/Wed/Fri', [1, 3, 5]],
    ['Tue/Thu', [2, 4]],
    ['MoWeFr', [1, 3, 5]],
    ['TuTh', [2, 4]],
    ['MWF', [1, 3, 5]],
    ['TR', [2, 4]],
    ['T/Th', [2, 4]],
    ['M/W', [1, 3]],
    ['Saturday', [6]],
    ['', []],
  ])('%s', (label, days) => {
    expect(parseMeetingDays(label)).toEqual(days);
  });
});

describe('parseStartMinutes', () => {
  it.each([
    ['10:00 AM – 11:15 AM', 600],
    ['2:00 PM – 3:15 PM', 840],
    ['9:30-10:45 AM', 570],
    ['2:00-3:15 PM', 840],
    ['11:00 – 12:15 PM', 660],
    ['12:30 PM', 750],
    ['14:00', 840],
    ['2:00', 840],
    ['8:00', 480],
    ['TBA', null],
  ])('%s', (label, minutes) => {
    expect(parseStartMinutes(label)).toBe(minutes);
  });
});

describe('findNextClass', () => {
  // Wednesday 25 Nov 2026, 9:00 local time
  const wed9 = new Date(2026, 10, 25, 9, 0);
  const classes = [
    item('mwf10', 'Mon/Wed/Fri', '10:00 AM – 11:15 AM'),
    item('tt1230', 'Tue/Thu', '12:30 PM – 1:45 PM'),
    item('online', 'Wed', '9:30 AM', null),
  ];

  it('picks the next in-person meeting today and skips unmapped online classes', () => {
    const next = findNextClass(classes, wed9)!;
    expect(next.item.id).toBe('mwf10');
    expect(next.startsAt).toEqual(new Date(2026, 10, 25, 10, 0));
  });

  it('still returns a class that started within the late grace window', () => {
    expect(findNextClass(classes, new Date(2026, 10, 25, 10, 10))!.item.id).toBe('mwf10');
  });

  it('rolls over to the next day once today is done', () => {
    const next = findNextClass(classes, new Date(2026, 10, 25, 18, 0))!;
    expect(next.item.id).toBe('tt1230');
    expect(next.startsAt).toEqual(new Date(2026, 10, 26, 12, 30));
  });

  it('returns null when no class has parseable days and times', () => {
    expect(findNextClass([item('x', '', 'TBA')], wed9)).toBeNull();
  });
});

describe('leaveAdvice', () => {
  const now = new Date(2026, 10, 25, 9, 0);
  it('counts down to the leave time', () => {
    expect(leaveAdvice(new Date(2026, 10, 25, 10, 0), 6, now)).toBe('Leave in 54 min');
    expect(leaveAdvice(new Date(2026, 10, 25, 11, 30), 6, now)).toBe('Leave in 2 h 24 min');
  });
  it('says leave now when the walk takes all the remaining time', () => {
    expect(leaveAdvice(new Date(2026, 10, 25, 9, 5), 6, now)).toBe('Leave now');
  });
  it('flags a class that already started', () => {
    expect(leaveAdvice(new Date(2026, 10, 25, 8, 55), 6, now)).toBe('Started 5 min ago — go now');
  });
  it('shows a clock time for tomorrow', () => {
    expect(leaveAdvice(new Date(2026, 10, 26, 10, 0), 6, now)).toBe('Leave tomorrow 9:54 AM');
  });
});
