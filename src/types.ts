export interface LonLat {
  lon: number;
  lat: number;
}

export interface Point2D {
  x: number;
  z: number;
}

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

export interface PathProperties {
  kind: 'path';
  osmId: string;
  highway: string;
  name?: string;
  covered?: boolean;
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
      properties: PathProperties;
      geometry: { type: 'LineString'; coordinates: number[][] };
    };

export interface BuildingRecord {
  id: string;
  osmId: string;
  name: string;
  shortCode: string;
  isMajor: boolean;
  height: number;
  centroid: Point2D;
  /** Projected polygon rings: each polygon is [outerRing, ...holes] */
  polygons: Point2D[][][];
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
  points: Point2D[];
  distanceMeters: number;
  walkMinutes: number;
  startLabel: string;
  destinationName: string;
}

export type CameraMode = 'chase' | 'topdown';
