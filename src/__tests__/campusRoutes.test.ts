import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { START_POINTS, matchOsmMajorBuilding } from '../buildings';
import { LocalProjector, dist2D, pointInBuildingPolygons, polygonCentroid } from '../geo';
import { CampusFootwayGraph, assignEntrances } from '../graph';
import type { BuildingRecord, CampusGeoJSON, EntranceRecord, Point2D } from '../types';

// Loads the committed campus data the same way main.ts does
const data = JSON.parse(
  readFileSync(new URL('../../public/data/umb-campus.geojson', import.meta.url), 'utf8')
) as CampusGeoJSON;
const projector = new LocalProjector(data.metadata.origin);
const buildings: BuildingRecord[] = [];
const paths: { points: Point2D[]; highway: string; covered?: boolean }[] = [];
const doors: EntranceRecord[] = [];
for (const f of data.features) {
  const p = f.properties;
  if (p.kind === 'building' && (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon')) {
    const raw = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    const polygons = raw.map((poly) => poly.map((ring) => projector.projectRing(ring)));
    const major = matchOsmMajorBuilding(p.name);
    buildings.push({
      id: major?.id ?? p.osmId,
      osmId: p.osmId,
      name: major?.canonicalName ?? p.name ?? 'Building',
      shortCode: major?.shortCode ?? '',
      isMajor: Boolean(major),
      height: p.height,
      centroid: polygonCentroid(polygons[0][0]),
      polygons,
    });
  } else if (p.kind === 'path' && f.geometry.type === 'LineString') {
    paths.push({ points: projector.projectRing(f.geometry.coordinates), highway: p.highway, covered: p.covered });
  } else if (p.kind === 'entrance' && f.geometry.type === 'Point') {
    const [lon, lat] = f.geometry.coordinates;
    doors.push({ ...projector.project(lon, lat), main: p.entrance === 'main', wheelchair: p.wheelchair === 'yes' });
  }
}
assignEntrances(buildings, doors);
const graph = new CampusFootwayGraph(paths, buildings);
const majors = [...new Map(buildings.filter((b) => b.isMajor).map((b) => [b.id, b])).values()];

describe('campus routes on committed OSM data', () => {
  it('assigns OSM doors to the major buildings OSM maps them for', () => {
    const withDoors = majors.filter((b) => b.entrances?.length).map((b) => b.id).sort();
    // Clark Athletic Center has no entrance=* nodes in OSM yet
    expect(withDoors).toEqual(['campus-center', 'healey', 'isc', 'mccormack', 'quinn', 'uhall', 'wheatley']);
  });

  // Wheatley/Healey doors open onto the plaza podium deck, which outdoor mode treats as a building
  const outdoorDoorless = new Set(['clark', 'wheatley', 'healey']);

  for (const sp of START_POINTS) {
    for (const mode of ['outdoor', 'catwalk'] as const) {
      it(`routes ${sp.id} (${mode}) to a real door where one is reachable`, () => {
        const start = projector.project(sp.lonLat.lon, sp.lonLat.lat);
        for (const b of majors) {
          const res = graph.findRouteToBuilding(start, b, mode);
          expect(res, b.id).not.toBeNull();
          const expectDoor = mode === 'catwalk' ? b.id !== 'clark' : !outdoorDoorless.has(b.id);
          expect(res!.endsAtDoor, b.id).toBe(expectDoor);
          if (!res!.endsAtDoor) continue;
          const end = res!.points[res!.points.length - 1];
          expect(Math.min(...b.entrances!.map((d) => dist2D(d, end))), b.id).toBeLessThan(0.5);
          if (mode === 'outdoor') {
            // No route segment passes through the destination building
            for (let i = 1; i < res!.points.length - 1; i++) {
              const a = res!.points[i - 1];
              const c = res!.points[i];
              expect(pointInBuildingPolygons({ x: (a.x + c.x) / 2, z: (a.z + c.z) / 2 }, b.polygons), b.id).toBe(false);
            }
          }
        }
      });
    }
  }
});
