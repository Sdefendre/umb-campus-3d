export interface LonLat {
  lon: number;
  lat: number;
}

export interface Point2D {
  x: number;
  z: number;
}

export interface RoutePoint extends Point2D {
  indoor?: boolean;
}

export type RouteMode = 'outdoor' | 'catwalk';

export interface CampusGeoJSON {
  type: 'FeatureCollection';
  metadata: {
    attribution: string;
    source: string;
    fetchedAt: string;
    bbox: { south: number; west: number; north: number; east: number };
    origin: LonLat;
  };
  features: CampusFeature[];
}

export interface BuildingProperties {
  kind: 'building';
  osmId: string;
  height: number;
  name?: string;
  levels?: number;
  buildingType?: string;
}

export interface RoofPartProperties {
  kind: 'roofPart';
  osmId: string;
  parentName?: string;
  baseHeight: number;
  height: number;
}

export interface PathProperties {
  kind: 'path';
  osmId: string;
  highway: string;
  name?: string;
  covered?: boolean;
}

export interface RoadProperties {
  kind: 'road';
  osmId: string;
  highway: string;
}

export interface SurfaceProperties {
  kind: 'surface';
  osmId: string;
  surfaceType: 'green' | 'pitch' | 'parking';
  sport?: string;
}

export interface EntranceProperties {
  kind: 'entrance';
  osmId: string;
  /** OSM entrance=* value: main, yes, service, ... */
  entrance: string;
  wheelchair?: string;
}

export interface StepBarrierProperties {
  kind: 'stepBarrier';
  osmId: string;
}

export interface CoastlineProperties {
  kind: 'coastline';
  osmId: string;
}

export type CampusFeature =
  | {
      type: 'Feature';
      properties: BuildingProperties;
      geometry:
        | { type: 'Polygon'; coordinates: number[][][] }
        | { type: 'MultiPolygon'; coordinates: number[][][][] };
    }
  | {
      type: 'Feature';
      properties: RoofPartProperties;
      geometry: { type: 'Polygon'; coordinates: number[][][] };
    }
  | {
      type: 'Feature';
      properties: PathProperties;
      geometry: { type: 'LineString'; coordinates: number[][] };
    }
  | {
      type: 'Feature';
      properties: RoadProperties;
      geometry: { type: 'LineString'; coordinates: number[][] };
    }
  | {
      type: 'Feature';
      properties: SurfaceProperties;
      geometry: { type: 'Polygon'; coordinates: number[][][] };
    }
  | {
      type: 'Feature';
      properties: EntranceProperties;
      geometry: { type: 'Point'; coordinates: number[] };
    }
  | {
      type: 'Feature';
      properties: StepBarrierProperties;
      geometry: { type: 'Point'; coordinates: number[] };
    }
  | {
      type: 'Feature';
      properties: CoastlineProperties;
      geometry: { type: 'LineString'; coordinates: number[][] };
    };

export interface BuildingRecord {
  id: string;
  osmId: string;
  name: string;
  shortCode: string;
  isMajor: boolean;
  height: number;
  levels?: number;
  centroid: Point2D;
  /** Projected polygon rings: each polygon is [outerRing, ...holes] */
  polygons: Point2D[][][];
  /** OSM doors on this building's outline (empty when OSM maps none) */
  entrances?: EntranceRecord[];
}

export interface EntranceRecord extends Point2D {
  main: boolean;
  /** OSM wheelchair=* value on the door: yes, limited, no, or undefined when untagged */
  wheelchair?: string;
}

export interface RoofPartRecord {
  id: string;
  parentName?: string;
  baseHeight: number;
  height: number;
  ring: Point2D[];
}

export interface SurfaceRecord {
  surfaceType: 'green' | 'pitch' | 'parking';
  sport?: string;
  ring: Point2D[];
}

export interface RoadRecord {
  highway: string;
  points: Point2D[];
}

export interface StartPoint {
  id: string;
  name: string;
  shortLabel: string;
  lonLat: LonLat;
}

export interface ClassItem {
  id: string;
  title: string;
  timeLabel: string;
  daysLabel: string;
  rawLocation: string;
  room: string;
  buildingId: string | null;
  buildingName: string | null;
}

export interface RouteResult {
  points: RoutePoint[];
  distanceMeters: number;
  walkMinutes: number;
  startLabel: string;
  destinationName: string;
  usesCatwalks: boolean;
}

export type CameraMode = 'chase' | 'topdown';
