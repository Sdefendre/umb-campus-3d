import { dist2D, pointInBuildingPolygons } from './geo';
import type { BuildingRecord, Point2D, RouteMode, RoutePoint } from './types';

interface GraphEdge {
  to: number;
  rawDist: number;
  baseMult: number;
  /** True when the edge is covered, a corridor, or crosses inside a building footprint */
  sheltered: boolean;
}

interface GraphNode {
  id: number;
  point: Point2D;
  indoor: boolean;
  edges: GraphEdge[];
}

interface BuildingBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  polygons: Point2D[][][];
}

export interface WalkPathInput {
  points: Point2D[];
  highway: string;
  covered?: boolean;
}

const HIGHWAY_WEIGHT_MULTIPLIER: Record<string, number> = {
  footway: 1.0,
  path: 1.0,
  pedestrian: 1.0,
  steps: 1.15,
  cycleway: 1.1,
  corridor: 1.0,
  living_street: 1.2,
  service: 1.35,
  residential: 1.4,
  unclassified: 1.45,
  tertiary: 1.6,
};

/**
 * Min-heap priority queue for A* pathfinding.
 */
class MinHeap {
  private readonly items: { id: number; f: number }[] = [];

  get size(): number {
    return this.items.length;
  }

  push(id: number, f: number): void {
    this.items.push({ id, f });
    let idx = this.items.length - 1;
    while (idx > 0) {
      const parent = (idx - 1) >> 1;
      if (this.items[parent].f <= this.items[idx].f) break;
      [this.items[parent], this.items[idx]] = [this.items[idx], this.items[parent]];
      idx = parent;
    }
  }

  pop(): { id: number; f: number } | undefined {
    if (this.items.length === 0) return undefined;
    const top = this.items[0];
    const last = this.items.pop()!;
    if (this.items.length > 0) {
      this.items[0] = last;
      let idx = 0;
      const n = this.items.length;
      while (true) {
        const left = (idx << 1) + 1;
        const right = left + 1;
        let smallest = idx;
        if (left < n && this.items[left].f < this.items[smallest].f) smallest = left;
        if (right < n && this.items[right].f < this.items[smallest].f) smallest = right;
        if (smallest === idx) break;
        [this.items[idx], this.items[smallest]] = [this.items[smallest], this.items[idx]];
        idx = smallest;
      }
    }
    return top;
  }
}

export class CampusFootwayGraph {
  private readonly nodes: GraphNode[] = [];
  private readonly outdoorComponent = new Set<number>();
  private readonly fullComponent = new Set<number>();

  constructor(paths: WalkPathInput[], buildings: BuildingRecord[] = []) {
    const bBounds: BuildingBounds[] = buildings.map((b) => {
      let minX = Infinity;
      let maxX = -Infinity;
      let minZ = Infinity;
      let maxZ = -Infinity;
      for (const poly of b.polygons) {
        if (poly.length === 0) continue;
        for (const p of poly[0]) {
          if (p.x < minX) minX = p.x;
          if (p.x > maxX) maxX = p.x;
          if (p.z < minZ) minZ = p.z;
          if (p.z > maxZ) maxZ = p.z;
        }
      }
      return { minX, maxX, minZ, maxZ, polygons: b.polygons };
    });

    const isInsideAnyBuilding = (pt: Point2D): boolean => {
      for (const b of bBounds) {
        if (pt.x < b.minX || pt.x > b.maxX || pt.z < b.minZ || pt.z > b.maxZ) continue;
        if (pointInBuildingPolygons(pt, b.polygons)) return true;
      }
      return false;
    };

    const keyToId = new Map<string, number>();

    const getOrCreate = (pt: Point2D): number => {
      // Snap coordinates within 0.25m so shared OSM nodes join reliably
      const key = `${Math.round(pt.x * 4)},${Math.round(pt.z * 4)}`;
      const existing = keyToId.get(key);
      if (existing !== undefined) return existing;
      const id = this.nodes.length;
      this.nodes.push({ id, point: pt, indoor: isInsideAnyBuilding(pt), edges: [] });
      keyToId.set(key, id);
      return id;
    };

    const segmentCrossesBuilding = (pa: Point2D, pb: Point2D, segLen: number): boolean => {
      if (isInsideAnyBuilding(pa) || isInsideAnyBuilding(pb)) return true;
      const steps = Math.max(2, Math.ceil(segLen / 2));
      for (let k = 1; k < steps; k++) {
        const t = k / steps;
        if (isInsideAnyBuilding({ x: pa.x + (pb.x - pa.x) * t, z: pa.z + (pb.z - pa.z) * t })) {
          return true;
        }
      }
      return false;
    };

    for (const path of paths) {
      const baseMult = HIGHWAY_WEIGHT_MULTIPLIER[path.highway] ?? 1.25;
      const pathCovered = Boolean(path.covered || path.highway === 'corridor');
      for (let i = 1; i < path.points.length; i++) {
        const rawA = path.points[i - 1];
        const rawB = path.points[i];
        const d = dist2D(rawA, rawB);
        if (d < 0.05) continue;

        const crosses = segmentCrossesBuilding(rawA, rawB, d);
        const sheltered = pathCovered || crosses;

        const a = getOrCreate(rawA);
        const b = getOrCreate(rawB);
        if (a === b) continue;

        this.nodes[a].edges.push({ to: b, rawDist: d, baseMult, sheltered });
        this.nodes[b].edges.push({ to: a, rawDist: d, baseMult, sheltered });
      }
    }

    this.computeLargestComponents();
  }

  private computeLargestComponents(): void {
    const findLargest = (outdoorOnly: boolean): Set<number> => {
      const visited = new Uint8Array(this.nodes.length);
      let best: number[] = [];

      for (let i = 0; i < this.nodes.length; i++) {
        if (visited[i]) continue;
        const hasEdge = this.nodes[i].edges.some((e) => !outdoorOnly || !e.sheltered);
        if (!hasEdge) continue;
        const comp: number[] = [];
        const stack = [i];
        visited[i] = 1;
        while (stack.length > 0) {
          const u = stack.pop()!;
          comp.push(u);
          for (const e of this.nodes[u].edges) {
            if (outdoorOnly && e.sheltered) continue;
            if (!visited[e.to]) {
              visited[e.to] = 1;
              stack.push(e.to);
            }
          }
        }
        if (comp.length > best.length) best = comp;
      }
      return new Set(best);
    };

    const outdoor = findLargest(true);
    for (const id of outdoor) this.outdoorComponent.add(id);

    const full = findLargest(false);
    for (const id of full) this.fullComponent.add(id);
  }

  findNearestNode(target: Point2D, preferOutdoor = true): number {
    const primaryPool =
      preferOutdoor && this.outdoorComponent.size > 0
        ? this.outdoorComponent
        : this.fullComponent.size > 0
          ? this.fullComponent
          : this.nodes.map((n) => n.id);

    let bestId = -1;
    let bestDist = Infinity;
    for (const id of primaryPool) {
      const d = dist2D(this.nodes[id].point, target);
      if (d < bestDist) {
        bestDist = d;
        bestId = id;
      }
    }
    return bestId;
  }

  /**
   * Computes shortest walking path using A* over the OSM footway graph.
   * - mode='outdoor' (default): strictly uses outdoor walkways that never cross building footprints.
   * - mode='catwalk': enables and favors UMB's covered catwalk & indoor skybridge shortcuts.
   */
  findRoute(
    start: Point2D,
    goal: Point2D,
    mode: RouteMode = 'outdoor'
  ): { points: RoutePoint[]; distanceMeters: number; usesCatwalks: boolean } | null {
    const outdoorOnly = mode === 'outdoor';
    const startId = this.findNearestNode(start, outdoorOnly);
    const goalId = this.findNearestNode(goal, outdoorOnly);
    if (startId < 0 || goalId < 0) return null;

    const startToFirst = dist2D(start, this.nodes[startId].point);

    if (startId === goalId) {
      const indoor = !outdoorOnly && this.nodes[startId].indoor;
      return {
        points: [
          { ...this.nodes[startId].point, indoor },
          { ...goal, indoor },
        ],
        distanceMeters: startToFirst + dist2D(this.nodes[startId].point, goal),
        usesCatwalks: indoor,
      };
    }

    const n = this.nodes.length;
    const gScore = new Float64Array(n).fill(Infinity);
    const distScore = new Float64Array(n).fill(Infinity);
    const cameFrom = new Int32Array(n).fill(-1);
    const viaSheltered = new Uint8Array(n);
    const closed = new Uint8Array(n);

    const goalPt = this.nodes[goalId].point;
    // Scale heuristic to stay admissible when sheltered edges have a 0.85x bonus in catwalk mode
    const hScale = outdoorOnly ? 1.0 : 0.8;

    gScore[startId] = 0;
    distScore[startId] = 0;

    const open = new MinHeap();
    open.push(startId, dist2D(this.nodes[startId].point, goalPt) * hScale);

    while (open.size > 0) {
      const current = open.pop()!;
      const u = current.id;
      if (closed[u]) continue;
      if (u === goalId) break;
      closed[u] = 1;

      for (const edge of this.nodes[u].edges) {
        if (outdoorOnly && edge.sheltered) continue;
        const v = edge.to;
        if (closed[v]) continue;

        const shelterMult = !outdoorOnly && edge.sheltered ? 0.85 : 1.0;
        const tentativeG = gScore[u] + edge.rawDist * edge.baseMult * shelterMult;
        if (tentativeG < gScore[v]) {
          cameFrom[v] = u;
          viaSheltered[v] = edge.sheltered ? 1 : 0;
          gScore[v] = tentativeG;
          distScore[v] = distScore[u] + edge.rawDist;
          const h = dist2D(this.nodes[v].point, goalPt) * hScale;
          open.push(v, tentativeG + h);
        }
      }
    }

    if (cameFrom[goalId] === -1) return null;

    const nodeIds: number[] = [];
    let cur = goalId;
    while (cur !== -1) {
      nodeIds.push(cur);
      cur = cameFrom[cur];
    }
    nodeIds.reverse();

    let usesCatwalks = false;
    const pathPoints: RoutePoint[] = nodeIds.map((id, idx) => {
      if (outdoorOnly) {
        return {
          x: this.nodes[id].point.x,
          z: this.nodes[id].point.z,
          indoor: false,
        };
      }
      const nextSheltered = idx + 1 < nodeIds.length && viaSheltered[nodeIds[idx + 1]] === 1;
      const indoor = this.nodes[id].indoor || viaSheltered[id] === 1 || nextSheltered;
      if (indoor) usesCatwalks = true;
      return {
        x: this.nodes[id].point.x,
        z: this.nodes[id].point.z,
        indoor,
      };
    });

    return {
      points: pathPoints,
      distanceMeters: startToFirst + distScore[goalId],
      usesCatwalks,
    };
  }
}
