import { dist2D, pointInBuildingPolygons } from './geo';
import type { BuildingRecord, Point2D } from './types';

interface GraphNode {
  id: number;
  point: Point2D;
  indoor: boolean;
  edges: { to: number; weight: number; rawDist: number }[];
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
  corridor: 2.2,
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
  private readonly mainComponent = new Set<number>();

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

    for (const path of paths) {
      const baseMult = HIGHWAY_WEIGHT_MULTIPLIER[path.highway] ?? 1.25;
      const coveredMult = path.covered ? 3.5 : 1.0;
      for (let i = 1; i < path.points.length; i++) {
        const a = getOrCreate(path.points[i - 1]);
        const b = getOrCreate(path.points[i]);
        if (a === b) continue;
        const pa = this.nodes[a].point;
        const pb = this.nodes[b].point;
        const d = dist2D(pa, pb);
        if (d < 0.05) continue;

        const mid = { x: (pa.x + pb.x) * 0.5, z: (pa.z + pb.z) * 0.5 };
        const indoorPenalty =
          this.nodes[a].indoor || this.nodes[b].indoor || isInsideAnyBuilding(mid) ? 12.0 : 1.0;

        const w = d * baseMult * coveredMult * indoorPenalty;
        this.nodes[a].edges.push({ to: b, weight: w, rawDist: d });
        this.nodes[b].edges.push({ to: a, weight: w, rawDist: d });
      }
    }

    this.computeLargestComponent();
  }

  private computeLargestComponent(): void {
    const visited = new Uint8Array(this.nodes.length);
    let best: number[] = [];

    for (let i = 0; i < this.nodes.length; i++) {
      if (visited[i] || this.nodes[i].edges.length === 0) continue;
      const comp: number[] = [];
      const stack = [i];
      visited[i] = 1;
      while (stack.length > 0) {
        const u = stack.pop()!;
        comp.push(u);
        for (const e of this.nodes[u].edges) {
          if (!visited[e.to]) {
            visited[e.to] = 1;
            stack.push(e.to);
          }
        }
      }
      if (comp.length > best.length) best = comp;
    }

    for (const id of best) this.mainComponent.add(id);
  }

  get nodeCount(): number {
    return this.nodes.length;
  }

  get mainComponentSize(): number {
    return this.mainComponent.size;
  }

  findNearestNode(target: Point2D, preferOutdoor = true): number {
    let bestId = -1;
    let bestDist = Infinity;
    let bestOutdoorId = -1;
    let bestOutdoorDist = Infinity;
    const pool = this.mainComponent.size > 0 ? this.mainComponent : this.nodes.map((n) => n.id);

    for (const id of pool) {
      const node = this.nodes[id];
      const d = dist2D(node.point, target);
      if (d < bestDist) {
        bestDist = d;
        bestId = id;
      }
      if (!node.indoor && d < bestOutdoorDist) {
        bestOutdoorDist = d;
        bestOutdoorId = id;
      }
    }
    return preferOutdoor && bestOutdoorId >= 0 ? bestOutdoorId : bestId;
  }

  /**
   * Computes shortest walking path using A* over the OSM footway graph.
   */
  findRoute(start: Point2D, goal: Point2D): { points: Point2D[]; distanceMeters: number } | null {
    const startId = this.findNearestNode(start);
    const goalId = this.findNearestNode(goal);
    if (startId < 0 || goalId < 0) return null;

    if (startId === goalId) {
      return {
        points: [this.nodes[startId].point, goal],
        distanceMeters: dist2D(this.nodes[startId].point, goal),
      };
    }

    const n = this.nodes.length;
    const gScore = new Float64Array(n).fill(Infinity);
    const distScore = new Float64Array(n).fill(Infinity);
    const cameFrom = new Int32Array(n).fill(-1);
    const closed = new Uint8Array(n);

    const goalPt = this.nodes[goalId].point;
    gScore[startId] = 0;
    distScore[startId] = 0;

    const open = new MinHeap();
    open.push(startId, dist2D(this.nodes[startId].point, goalPt));

    while (open.size > 0) {
      const current = open.pop()!;
      const u = current.id;
      if (closed[u]) continue;
      if (u === goalId) break;
      closed[u] = 1;

      for (const edge of this.nodes[u].edges) {
        const v = edge.to;
        if (closed[v]) continue;
        const tentativeG = gScore[u] + edge.weight;
        if (tentativeG < gScore[v]) {
          cameFrom[v] = u;
          gScore[v] = tentativeG;
          distScore[v] = distScore[u] + edge.rawDist;
          const h = dist2D(this.nodes[v].point, goalPt);
          open.push(v, tentativeG + h);
        }
      }
    }

    if (cameFrom[goalId] === -1) return null;

    const pathPoints: Point2D[] = [];
    let cur = goalId;
    while (cur !== -1) {
      pathPoints.push(this.nodes[cur].point);
      cur = cameFrom[cur];
    }
    pathPoints.reverse();

    return {
      points: pathPoints,
      distanceMeters: distScore[goalId],
    };
  }
}
