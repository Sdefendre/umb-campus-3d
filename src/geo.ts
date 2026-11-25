import type { LonLat, Point2D } from './types';

const EARTH_RADIUS_M = 6378137;
const DEG_TO_RAD = Math.PI / 180;

/**
 * Local tangent-plane projection (equirectangular approximation accurate to <0.1m
 * across a 2km campus). +X points East, -Z points North (Three.js right-handed Y-up).
 */
export class LocalProjector {
  private readonly originLatRad: number;
  private readonly cosOriginLat: number;
  private readonly originLon: number;
  private readonly originLat: number;

  constructor(origin: LonLat) {
    this.originLon = origin.lon;
    this.originLat = origin.lat;
    this.originLatRad = origin.lat * DEG_TO_RAD;
    this.cosOriginLat = Math.cos(this.originLatRad);
  }

  project(lon: number, lat: number): Point2D {
    const x = (lon - this.originLon) * DEG_TO_RAD * EARTH_RADIUS_M * this.cosOriginLat;
    const north = (lat - this.originLat) * DEG_TO_RAD * EARTH_RADIUS_M;
    return { x, z: -north };
  }

  projectRing(coords: number[][]): Point2D[] {
    return coords.map(([lon, lat]) => this.project(lon, lat));
  }
}

export function polygonCentroid(ring: Point2D[]): Point2D {
  if (ring.length === 0) return { x: 0, z: 0 };
  let area2 = 0;
  let cx = 0;
  let cz = 0;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const p0 = ring[i];
    const p1 = ring[(i + 1) % n];
    const cross = p0.x * p1.z - p1.x * p0.z;
    area2 += cross;
    cx += (p0.x + p1.x) * cross;
    cz += (p0.z + p1.z) * cross;
  }
  if (Math.abs(area2) < 1e-4) {
    let sx = 0;
    let sz = 0;
    for (const p of ring) {
      sx += p.x;
      sz += p.z;
    }
    return { x: sx / n, z: sz / n };
  }
  return { x: cx / (3 * area2), z: cz / (3 * area2) };
}

export function dist2D(a: Point2D, b: Point2D): number {
  return Math.hypot(b.x - a.x, b.z - a.z);
}

export function pointInRing(pt: Point2D, ring: Point2D[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].x;
    const zi = ring[i].z;
    const xj = ring[j].x;
    const zj = ring[j].z;
    const intersect =
      zi > pt.z !== zj > pt.z && pt.x < ((xj - xi) * (pt.z - zi)) / (zj - zi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export function pointInBuildingPolygons(pt: Point2D, polygons: Point2D[][][]): boolean {
  for (const poly of polygons) {
    if (poly.length === 0) continue;
    if (!pointInRing(pt, poly[0])) continue;
    let inHole = false;
    for (let h = 1; h < poly.length; h++) {
      if (pointInRing(pt, poly[h])) {
        inHole = true;
        break;
      }
    }
    if (!inHole) return true;
  }
  return false;
}
