import { describe, expect, it } from 'vitest';
import { CampusFootwayGraph } from '../graph';

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
