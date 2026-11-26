import { describe, expect, it } from 'vitest';
import { CampusFootwayGraph, assignEntrances } from '../graph';
import type { BuildingRecord } from '../types';

describe('CampusFootwayGraph', () => {
  it('includes start-to-first-node distance in distanceMeters', () => {
    const graph = new CampusFootwayGraph([
      {
        highway: 'footway',
        points: [
          { x: 0, z: 0 },
          { x: 100, z: 0 },
        ],
      },
    ]);

    // Start is 30m north of node (0,0), goal is at node (100,0)
    const route = graph.findRoute({ x: 0, z: -30 }, { x: 100, z: 0 });
    expect(route).not.toBeNull();
    expect(route!.distanceMeters).toBeCloseTo(130, 5);
  });

  it('includes start-to-first-node distance even when start and goal snap to the same node', () => {
    const graph = new CampusFootwayGraph([
      {
        highway: 'footway',
        points: [
          { x: 0, z: 0 },
          { x: 100, z: 0 },
        ],
      },
    ]);

    const route = graph.findRoute({ x: -10, z: 0 }, { x: 0, z: 15 });
    expect(route).not.toBeNull();
    expect(route!.distanceMeters).toBeCloseTo(25, 5);
  });

  it('prefers outdoor detour in outdoor mode and sheltered catwalk shortcut in catwalk mode', () => {
    const graph = new CampusFootwayGraph([
      // Direct covered catwalk shortcut (100m)
      {
        highway: 'corridor',
        covered: true,
        points: [
          { x: 0, z: 0 },
          { x: 100, z: 0 },
        ],
      },
      // Longer outdoor walkway around building (180m)
      {
        highway: 'footway',
        points: [
          { x: 0, z: 0 },
          { x: 0, z: 40 },
          { x: 100, z: 40 },
          { x: 100, z: 0 },
        ],
      },
    ]);

    const outdoor = graph.findRoute({ x: 0, z: 0 }, { x: 100, z: 0 }, 'outdoor');
    expect(outdoor).not.toBeNull();
    expect(outdoor!.distanceMeters).toBeCloseTo(180, 3);
    expect(outdoor!.usesCatwalks).toBe(false);

    const catwalk = graph.findRoute({ x: 0, z: 0 }, { x: 100, z: 0 }, 'catwalk');
    expect(catwalk).not.toBeNull();
    expect(catwalk!.distanceMeters).toBeCloseTo(100, 3);
    expect(catwalk!.usesCatwalks).toBe(true);
    expect(catwalk!.points.some((p) => p.indoor)).toBe(true);
  });
});

describe('CampusFootwayGraph.findRouteToBuilding', () => {
  // A 20x20 m building east of a north-south footway, with one door on each side
  const building: BuildingRecord = {
    id: 'b',
    osmId: 'way/1',
    name: 'B',
    shortCode: 'B',
    isMajor: true,
    height: 10,
    centroid: { x: 20, z: 0 },
    polygons: [[[{ x: 10, z: -10 }, { x: 30, z: -10 }, { x: 30, z: 10 }, { x: 10, z: 10 }]]],
  };
  const paths = [
    { highway: 'footway', points: [{ x: 0, z: -100 }, { x: 0, z: 10 }, { x: 0, z: 100 }] },
    { highway: 'footway', points: [{ x: 0, z: 10 }, { x: 5, z: 12 }] },
  ];

  it('ends at the nearest reachable door and counts the final leg', () => {
    const graph = new CampusFootwayGraph(paths, [building]);
    assignEntrances([building], [
      { x: 10, z: 0, main: true, wheelchair: false },
      // Back door with no path anywhere near it
      { x: 30, z: 0, main: false, wheelchair: false },
    ]);
    const res = graph.findRouteToBuilding({ x: 0, z: -100 }, building)!;
    expect(res.endsAtDoor).toBe(true);
    expect(res.points[res.points.length - 1]).toMatchObject({ x: 10, z: 0 });
    // 110 m footway, 5.4 m spur to (5,12), then a 13 m straight leg to the door
    expect(res.distanceMeters).toBeCloseTo(110 + Math.hypot(5, 2) + 13, 5);
  });

  it('falls back to the centroid when the building has no mapped door', () => {
    const graph = new CampusFootwayGraph(paths, [building]);
    assignEntrances([building], []);
    const res = graph.findRouteToBuilding({ x: 0, z: -100 }, building)!;
    expect(res.endsAtDoor).toBe(false);
  });

  it('prefers the named building over a podium sharing the same outline', () => {
    const podium: BuildingRecord = { ...building, id: 'podium', isMajor: false, entrances: undefined };
    assignEntrances([podium, building], [{ x: 10, z: 0, main: false, wheelchair: false }]);
    expect(building.entrances).toHaveLength(1);
    expect(podium.entrances).toHaveLength(0);
  });
});
