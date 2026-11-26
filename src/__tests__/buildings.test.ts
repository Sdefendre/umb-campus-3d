import { describe, expect, it } from 'vitest';
import { isOnlineOrUnassignedLocation, resolveBuildingFromText } from '../buildings';

describe('resolveBuildingFromText — Opus P1/P2 false-positive regressions', () => {
  it('does NOT match single-letter day tokens followed by times or section numbers', () => {
    expect(resolveBuildingFromText('W 10:00 AM')).toEqual({ building: null, room: '' });
    expect(resolveBuildingFromText('ENGL 101 M 9:00')).toEqual({ building: null, room: '' });
    expect(resolveBuildingFromText('Sec U 01')).toEqual({ building: null, room: '' });
    expect(resolveBuildingFromText('M/W 10:00')).toEqual({ building: null, room: '' });
    expect(resolveBuildingFromText('M/W/F 11:30 AM')).toEqual({ building: null, room: '' });
    expect(resolveBuildingFromText('W')).toEqual({ building: null, room: '' });
    expect(resolveBuildingFromText('M')).toEqual({ building: null, room: '' });
    expect(resolveBuildingFromText('Q 10:00 AM')).toEqual({ building: null, room: '' });
    expect(resolveBuildingFromText('L 2:30 PM')).toEqual({ building: null, room: '' });
    expect(resolveBuildingFromText('Office hours: M 9-10, W 2-4')).toEqual({
      building: null,
      room: '',
    });
    expect(resolveBuildingFromText('W 10-12')).toEqual({ building: null, room: '' });
    expect(resolveBuildingFromText('L 10-12')).toEqual({ building: null, room: '' });
    expect(resolveBuildingFromText('Sec W 01-02')).toEqual({ building: null, room: '' });
  });

  it('handles M/W day pattern alongside a real structured room code', () => {
    const res = resolveBuildingFromText('MATH 345 | M/W 10:00 AM | M-01-0408');
    expect(res.building?.id).toBe('mccormack');
    expect(res.room).toBe('01-0408');

    const res2 = resolveBuildingFromText('CS 285L | M/W 2:00 PM | W-02-0041');
    expect(res2.building?.id).toBe('wheatley');
    expect(res2.room).toBe('02-0041');
  });

  it('does NOT false-positive on broad "library", "gym", or 2-letter course codes', () => {
    expect(resolveBuildingFromText('Library Science 101')).toEqual({ building: null, room: '' });
    expect(resolveBuildingFromText('Library 101 Intro')).toEqual({ building: null, room: '' });
    expect(resolveBuildingFromText('QA 101 Quality Assurance')).toEqual({ building: null, room: '' });
    expect(resolveBuildingFromText('CC 101 Community Colloquium')).toEqual({ building: null, room: '' });
    expect(resolveBuildingFromText('MC 201 Media Communications')).toEqual({ building: null, room: '' });
    expect(resolveBuildingFromText('UH 101 Urban History')).toEqual({ building: null, room: '' });
    expect(resolveBuildingFromText('Gymnastics 101')).toEqual({ building: null, room: '' });
    expect(resolveBuildingFromText('Morning Gym Session')).toEqual({ building: null, room: '' });
  });

  it('supports Healey Library LL-12 and lower/upper-level rooms', () => {
    expect(resolveBuildingFromText('Healey Library LL-12')).toMatchObject({
      building: { id: 'healey' },
      room: 'LL-12',
    });
    expect(resolveBuildingFromText('Healey Library LL 12')).toMatchObject({
      building: { id: 'healey' },
      room: 'LL-12',
    });
    expect(resolveBuildingFromText('HL LL-12')).toMatchObject({
      building: { id: 'healey' },
      room: 'LL-12',
    });
    expect(resolveBuildingFromText('Library LL-12')).toMatchObject({
      building: { id: 'healey' },
      room: 'LL-12',
    });
    expect(resolveBuildingFromText('L-LL-12')).toMatchObject({
      building: { id: 'healey' },
      room: 'LL-12',
    });
  });

  it('resolves all structured UMB building & room formats accurately', () => {
    expect(resolveBuildingFromText('M-01-0408')).toMatchObject({
      building: { id: 'mccormack' },
      room: '01-0408',
    });
    expect(resolveBuildingFromText('M01-408')).toMatchObject({
      building: { id: 'mccormack' },
      room: '01-408',
    });
    expect(resolveBuildingFromText('W-02-0041')).toMatchObject({
      building: { id: 'wheatley' },
      room: '02-0041',
    });
    expect(resolveBuildingFromText('W 02-0041')).toMatchObject({
      building: { id: 'wheatley' },
      room: '02-0041',
    });
    expect(resolveBuildingFromText('Q-3-040')).toMatchObject({
      building: { id: 'quinn' },
      room: '3-040',
    });
    expect(resolveBuildingFromText('ISC 2-2003')).toMatchObject({
      building: { id: 'isc' },
      room: '2-2003',
    });
    expect(resolveBuildingFromText('University Hall 2310')).toMatchObject({
      building: { id: 'uhall' },
      room: '2310',
    });
    expect(resolveBuildingFromText('UHall 2-2310')).toMatchObject({
      building: { id: 'uhall' },
      room: '2-2310',
    });
    expect(resolveBuildingFromText('CC-01-1300 (Campus Center)')).toMatchObject({
      building: { id: 'campus-center' },
      room: '01-1300',
    });
    expect(resolveBuildingFromText('HL-04-0012 (Healey Library)')).toMatchObject({
      building: { id: 'healey' },
      room: '04-0012',
    });
    expect(resolveBuildingFromText('Clark Athletic Center 101')).toMatchObject({
      building: { id: 'clark' },
      room: '101',
    });
  });

  it('identifies online / remote / TBA locations and never maps them to buildings', () => {
    expect(isOnlineOrUnassignedLocation('Online')).toBe(true);
    expect(isOnlineOrUnassignedLocation('SOCIOL 101 | Remote Asynchronous')).toBe(true);
    expect(isOnlineOrUnassignedLocation('TBA')).toBe(true);
    expect(resolveBuildingFromText('SOCIOL 101 | Online')).toEqual({ building: null, room: '' });
  });
});
