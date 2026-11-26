import { dist2D, distToRing, pointInBuildingPolygons } from './geo';
import type { BuildingRecord, EntranceRecord, Point2D, RouteMode, RoutePoint } from './types';

interface GraphEdge {
  to: number;
  rawDist: number;
  baseMult: number;
  /** True when the edge is covered, a corridor, or crosses inside a building footprint */
  sheltered: boolean;
  /** True for OSM highway=steps */
  steps: boolean;
}

interface GraphNode {
  id: number;
  point: Point2D;
  indoor: boolean;
  /** Raised kerb or wheelchair=no node, impassable in step-free mode */
  stepBarrier: boolean;
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

/** A door counts as part of a building when it sits within this distance of its outline. */
const DOOR_SNAP_M = 3;
/** Longest straight walk allowed from the last footway node to a door. */
const MAX_DOOR_LEG_M = 25;

export interface BuildingRoute {
  points: RoutePoint[];
  distanceMeters: number;
  usesCatwalks: boolean;
  /** True when the route ends at a mapped OSM door rather than the building centroid. */
  endsAtDoor: boolean;
}

/**
 * Attaches each OSM entrance to the building whose outline it lies on (or inside),
 * writing the result to `building.entrances`.
 */
export function assignEntrances(buildings: BuildingRecord[], doors: EntranceRecord[]): void {
  for (const b of buildings) b.entrances = [];
  for (const door of doors) {
    let best: BuildingRecord | null = null;
    let bestDist = DOOR_SNAP_M;
    for (const b of buildings) {
      for (const poly of b.polygons) {
        if (poly.length === 0) continue;
        const d = pointInBuildingPolygons(door, [poly]) ? 0 : distToRing(door, poly[0]);
        // Plaza towers share outline edges with the podium: on a tie, the named campus building wins
        if (d < bestDist || (d === bestDist && b.isMajor && !best?.isMajor)) {
          bestDist = d;
          best = b;
        }
      }
    }
    best?.entrances!.push(door);
  }
}

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
  /** Largest connected component per (outdoorOnly, stepFree) filter, built on first use */
  private readonly components = new Map<string, Set<number>>();

  constructor(paths: WalkPathInput[], buildings: BuildingRecord[] = [], stepBarriers: Point2D[] = []) {
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
    // Snap coordinates within 0.25m so shared OSM nodes join reliably
    const snapKey = (pt: Point2D) => `${Math.round(pt.x * 4)},${Math.round(pt.z * 4)}`;
    const barrierKeys = new Set(stepBarriers.map(snapKey));

    const getOrCreate = (pt: Point2D): number => {
      const key = snapKey(pt);
      const existing = keyToId.get(key);
      if (existing !== undefined) return existing;
      const id = this.nodes.length;
      this.nodes.push({ id, point: pt, indoor: isInsideAnyBuilding(pt), stepBarrier: barrierKeys.has(key), edges: [] });
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

        const steps = path.highway === 'steps';
        this.nodes[a].edges.push({ to: b, rawDist: d, baseMult, sheltered, steps });
        this.nodes[b].edges.push({ to: a, rawDist: d, baseMult, sheltered, steps });
      }
    }
  }

  private edgeAllowed(from: number, edge: GraphEdge, outdoorOnly: boolean, stepFree: boolean): boolean {
    if (outdoorOnly && edge.sheltered) return false;
    if (stepFree && (edge.steps || this.nodes[from].stepBarrier || this.nodes[edge.to].stepBarrier)) {
      return false;
    }
    return true;
  }

  private component(outdoorOnly: boolean, stepFree: boolean): Set<number> {
    const key = `${outdoorOnly}|${stepFree}`;
    const cached = this.components.get(key);
    if (cached) return cached;

    const visited = new Uint8Array(this.nodes.length);
    let best: number[] = [];
    for (let i = 0; i < this.nodes.length; i++) {
      if (visited[i]) continue;
      if (!this.nodes[i].edges.some((e) => this.edgeAllowed(i, e, outdoorOnly, stepFree))) continue;
      const comp: number[] = [];
      const stack = [i];
      visited[i] = 1;
      while (stack.length > 0) {
        const u = stack.pop()!;
        comp.push(u);
        for (const e of this.nodes[u].edges) {
          if (!visited[e.to] && this.edgeAllowed(u, e, outdoorOnly, stepFree)) {
            visited[e.to] = 1;
            stack.push(e.to);
          }
        }
      }
      if (comp.length > best.length) best = comp;
    }
    const set = new Set(best);
    this.components.set(key, set);
    return set;
  }

  findNearestNode(target: Point2D, preferOutdoor = true, stepFree = false): number {
    const outdoor = preferOutdoor ? this.component(true, stepFree) : null;
    const full = this.component(false, stepFree);
    const primaryPool =
      outdoor && outdoor.size > 0 ? outdoor : full.size > 0 ? full : this.nodes.map((n) => n.id);

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
   * Routes to the building's nearest reachable door. Falls back to the centroid when OSM
   * maps no usable door, so every building stays routable. Step-free routes skip doors
   * tagged wheelchair=no and use only wheelchair=yes doors when the building has any.
   */
  findRouteToBuilding(
    start: Point2D,
    building: BuildingRecord,
    mode: RouteMode = 'outdoor',
    stepFree = false
  ): BuildingRoute | null {
    let doors = building.entrances ?? [];
    if (stepFree) {
      doors = doors.filter((d) => d.wheelchair !== 'no');
      const accessible = doors.filter((d) => d.wheelchair === 'yes');
      if (accessible.length > 0) doors = accessible;
    }
    let best: BuildingRoute | null = null;
    for (const door of doors) {
      const res = this.findRoute(start, door, mode, stepFree);
      if (!res) continue;
      const last = res.points[res.points.length - 1];
      // Catwalk routes may already arrive inside the building through a corridor
      const arrivedInside = Boolean(last.indoor) && pointInBuildingPolygons(last, building.polygons);
      const leg = arrivedInside ? 0 : dist2D(last, door);
      if (leg > MAX_DOOR_LEG_M || (leg > 0.5 && legEntersBuilding(last, door, building))) continue;
      const points = leg > 0.5 ? [...res.points, { x: door.x, z: door.z, indoor: false }] : res.points;
      const distanceMeters = res.distanceMeters + leg;
      if (!best || distanceMeters < best.distanceMeters) {
        best = { points, distanceMeters, usesCatwalks: res.usesCatwalks, endsAtDoor: true };
      }
    }
    if (best) return best;
    const res = this.findRoute(start, building.centroid, mode, stepFree);
    return res ? { ...res, endsAtDoor: false } : null;
  }

  /**
   * Computes shortest walking path using A* over the OSM footway graph.
   * - mode='outdoor' (default): strictly uses outdoor walkways that never cross building footprints.
   * - mode='catwalk': enables and favors UMB's covered catwalk & indoor skybridge shortcuts.
   * - stepFree: skips stairs (highway=steps) and raised-kerb / wheelchair=no nodes.
   */
  findRoute(
    start: Point2D,
    goal: Point2D,
    mode: RouteMode = 'outdoor',
    stepFree = false
  ): { points: RoutePoint[]; distanceMeters: number; usesCatwalks: boolean } | null {
    const outdoorOnly = mode === 'outdoor';
    const startId = this.findNearestNode(start, outdoorOnly, stepFree);
    const goalId = this.findNearestNode(goal, outdoorOnly, stepFree);
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
        if (!this.edgeAllowed(u, edge, outdoorOnly, stepFree)) continue;
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

/** True when the straight leg to a door passes through the building interior. */
function legEntersBuilding(from: Point2D, door: Point2D, building: BuildingRecord): boolean {
  const len = dist2D(from, door);
  // Stop short of the door itself, which sits on the outline
  const steps = Math.max(2, Math.ceil(len / 1.5));
  for (let k = 1; k < steps; k++) {
    const t = (k / steps) * Math.max(0, 1 - 1.5 / Math.max(len, 1.5));
    if (pointInBuildingPolygons({ x: from.x + (door.x - from.x) * t, z: from.z + (door.z - from.z) * t }, building.polygons)) {
      return true;
    }
  }
  return false;
}
