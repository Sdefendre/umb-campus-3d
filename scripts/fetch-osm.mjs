#!/usr/bin/env node
/**
 * Fetches OpenStreetMap building footprints & walkable footways for the
 * UMass Boston (Columbia Point) campus and enriches building heights with
 * City of Boston Planning Department (BPDA) 2010 LiDAR roof heights
 * (Boston_Buildings FeatureServer Layer 9) where available.
 *
 * Usage: npm run fetch-osm
 * Data: (c) OpenStreetMap contributors, ODbL; BPDA Boston_Buildings (public open data)
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.resolve(__dirname, '../public/data/umb-campus.geojson');

const BBOX = {
  south: 42.3102,
  west: -71.0472,
  north: 42.3188,
  east: -71.0322,
};

const ORIGIN = {
  lat: 42.3138,
  lon: -71.0378,
};

const FT_TO_M = 0.3048;
const METERS_PER_LEVEL = 3.2;
const DEFAULT_BUILDING_HEIGHT_M = 11;

// Post-2010 buildings where BPDA BLDG_HGT_2010 holds 35ft placeholders or berm artifacts
const BPDA_SKIP_NAMES = new Set([
  'Integrated Sciences Complex',
  'University Hall',
  'Massachusetts Archives',
  'Calf Pasture Pumping Station',
]);

// Documented fallback heights (m) for campus buildings lacking BPDA LiDAR or OSM levels
const KNOWN_HEIGHTS_M = new Map([
  ['Healey Library', 43.0],
  ['Wheatley Hall', 23.7],
  ['McCormack Hall', 26.3],
  ['University Hall', 22.0],
  ['Integrated Sciences Complex', 25.0],
  ['Campus Center', 12.3],
  ['Quinn Administration Building', 20.4],
  ['Clark Athletic Center', 11.5],
  ['West Garage', 21.3],
  ['Service and Supply Building', 7.1],
  ['Utility Plant', 12.0],
  ['John F. Kennedy Presidential Library and Museum', 10.5],
  ['Massachusetts Archives', 16.0],
]);

function roundCoord(n) {
  return Math.round(n * 1e6) / 1e6;
}

function curlJson(url) {
  const out = execFileSync(
    'curl',
    [
      '-4',
      '-sS',
      '--max-time',
      '30',
      '-H',
      'Accept: application/json',
      '-A',
      'umb-campus-3d/0.2 (https://github.com/Sdefendre/umb-campus-3d)',
      url,
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  );
  return JSON.parse(out);
}

function ringCentroid(ring) {
  let sx = 0;
  let sy = 0;
  for (const [x, y] of ring) {
    sx += x;
    sy += y;
  }
  return [sx / ring.length, sy / ring.length];
}

function pip(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (
      yi > pt[1] !== yj > pt[1] &&
      pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi + 1e-12) + xi
    ) {
      inside = !inside;
    }
  }
  return inside;
}

function inGeom(pt, geom) {
  if (!geom) return false;
  if (geom.type === 'Polygon') return pip(pt, geom.coordinates[0]);
  if (geom.type === 'MultiPolygon') return geom.coordinates.some((p) => pip(pt, p[0]));
  return false;
}

function resolveBpdaHeight(geom, name, bpdaFeatures) {
  if (name && BPDA_SKIP_NAMES.has(name)) return null;
  const outer = geom.type === 'Polygon' ? geom.coordinates[0] : geom.coordinates[0][0];
  const c = ringCentroid(outer);
  const hits = bpdaFeatures.filter((bf) => {
    const p = bf.properties;
    if (p.Added !== null) return false;
    if (typeof p.BLDG_HGT_2010 !== 'number' || p.BLDG_HGT_2010 < 8 || p.Shape__Area > 200000) {
      return false;
    }
    const bc =
      bf.geometry?.type === 'Polygon'
        ? ringCentroid(bf.geometry.coordinates[0])
        : bf.geometry?.type === 'MultiPolygon'
          ? ringCentroid(bf.geometry.coordinates[0][0])
          : null;
    return inGeom(c, bf.geometry) || (bc && inGeom(bc, geom));
  });
  if (hits.length === 0) return null;
  const areaSum = hits.reduce((s, h) => s + (h.properties.Shape__Area || 1), 0);
  const wAvgM =
    hits.reduce((s, h) => s + h.properties.BLDG_HGT_2010 * FT_TO_M * (h.properties.Shape__Area || 1), 0) /
    areaSum;
  return Math.round(wAvgM * 10) / 10;
}

function parseOsmHeight(tags) {
  if (tags.height) {
    const match = String(tags.height).match(/[\d.]+/);
    if (match) {
      const val = Number.parseFloat(match[0]);
      if (Number.isFinite(val) && val > 1 && val < 300) return Math.round(val * 10) / 10;
    }
  }
  if (tags['building:levels']) {
    const levels = Number.parseFloat(String(tags['building:levels']));
    if (Number.isFinite(levels) && levels > 0 && levels < 100) {
      return Math.round(levels * METERS_PER_LEVEL * 10) / 10;
    }
  }
  if (tags.name && KNOWN_HEIGHTS_M.has(tags.name)) {
    return KNOWN_HEIGHTS_M.get(tags.name);
  }
  return DEFAULT_BUILDING_HEIGHT_M;
}

function stitchRings(segments) {
  const remaining = segments.filter((seg) => seg.length >= 2).map((seg) => [...seg]);
  const rings = [];
  while (remaining.length > 0) {
    let ring = remaining.shift();
    let changed = true;
    while (changed && ring[0] !== ring[ring.length - 1]) {
      changed = false;
      const head = ring[0];
      const tail = ring[ring.length - 1];
      for (let i = 0; i < remaining.length; i++) {
        const seg = remaining[i];
        if (seg[0] === tail) {
          ring = ring.concat(seg.slice(1));
          remaining.splice(i, 1);
          changed = true;
          break;
        }
        if (seg[seg.length - 1] === tail) {
          ring = ring.concat(seg.slice(0, -1).reverse());
          remaining.splice(i, 1);
          changed = true;
          break;
        }
        if (seg[seg.length - 1] === head) {
          ring = seg.slice(0, -1).concat(ring);
          remaining.splice(i, 1);
          changed = true;
          break;
        }
        if (seg[0] === head) {
          ring = seg.slice(1).reverse().concat(ring);
          remaining.splice(i, 1);
          changed = true;
          break;
        }
      }
    }
    if (ring.length >= 4 && ring[0] === ring[ring.length - 1]) {
      rings.push(ring);
    }
  }
  return rings;
}

function stitchPolylines(segments) {
  const remaining = segments.filter((s) => s.length >= 2).map((s) => [...s]);
  const chains = [];
  while (remaining.length > 0) {
    let chain = remaining.shift();
    let changed = true;
    while (changed) {
      changed = false;
      const head = chain[0];
      const tail = chain[chain.length - 1];
      for (let i = 0; i < remaining.length; i++) {
        const seg = remaining[i];
        if (seg[0] === tail) {
          chain = chain.concat(seg.slice(1));
          remaining.splice(i, 1);
          changed = true;
          break;
        }
        if (seg[seg.length - 1] === head) {
          chain = seg.slice(0, -1).concat(chain);
          remaining.splice(i, 1);
          changed = true;
          break;
        }
      }
    }
    chains.push(chain);
  }
  return chains;
}

const BPDA_ROOFPRINTS_URL =
  'https://gis.bostonplans.org/hosting/rest/services/Boston_Building_Roofprints/FeatureServer/15/query';

function polygonAreaMeters2(ring) {
  let area = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const x1 = ring[j][0] * 82200;
    const y1 = ring[j][1] * 111100;
    const x2 = ring[i][0] * 82200;
    const y2 = ring[i][1] * 111100;
    area += x1 * y2 - x2 * y1;
  }
  return Math.abs(area) * 0.5;
}

function roundRingCoords(ring) {
  return ring.map(([lon, lat]) => [roundCoord(lon), roundCoord(lat)]);
}

function nodesToCoords(nodeIds, nodeMap) {
  const coords = [];
  for (const id of nodeIds) {
    const n = nodeMap.get(id);
    if (!n) return null;
    coords.push([roundCoord(n.lon), roundCoord(n.lat)]);
  }
  return coords;
}

async function main() {
  console.log('Fetching OSM map data...');
  const osmUrl = `https://api.openstreetmap.org/api/0.6/map?bbox=${BBOX.west},${BBOX.south},${BBOX.east},${BBOX.north}`;
  const osm = curlJson(osmUrl);

  console.log('Fetching City of Boston BPDA LiDAR building heights & LoD2 roofprints...');
  const bpdaUrl =
    `https://gis.bostonplans.org/hosting/rest/services/Boston_Buildings/FeatureServer/9/query` +
    `?where=1%3D1&geometry=${BBOX.west},${BBOX.south},${BBOX.east},${BBOX.north}` +
    `&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects` +
    `&outFields=OBJECTID,BLDG_HGT_2010,Added,Shape__Area&outSR=4326&f=geojson`;
  const bpda = curlJson(bpdaUrl);
  const bpdaFeatures = bpda.features || [];

  let roofprintFeatures = [];
  try {
    const roofUrl =
      `${BPDA_ROOFPRINTS_URL}?where=Status%3D%27Existing%27` +
      `&geometry=${BBOX.west},${BBOX.south},${BBOX.east},${BBOX.north}` +
      `&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects` +
      `&outFields=OBJECTID,BLD_ID,BLD_PART_ID,Bld_Height_Ft,Shape__Area&outSR=4326&f=geojson`;
    roofprintFeatures = curlJson(roofUrl).features || [];
  } catch (err) {
    console.warn('BPDA Roofprints fetch skipped:', err.message);
  }

  const nodeMap = new Map();
  const wayMap = new Map();
  const relations = [];
  for (const el of osm.elements) {
    if (el.type === 'node') nodeMap.set(el.id, el);
    else if (el.type === 'way') wayMap.set(el.id, el);
    else if (el.type === 'relation') relations.push(el);
  }

  const relationBuildingWays = new Set();
  for (const rel of relations) {
    if (rel.tags?.building && Array.isArray(rel.members)) {
      for (const m of rel.members) {
        if (m.type === 'way') relationBuildingWays.add(m.ref);
      }
    }
  }

  const features = [];

  for (const way of wayMap.values()) {
    const tags = way.tags || {};
    if (!tags.building) continue;
    if (relationBuildingWays.has(way.id) && !tags.name) continue;
    if (!Array.isArray(way.nodes) || way.nodes.length < 4) continue;
    if (way.nodes[0] !== way.nodes[way.nodes.length - 1]) continue;
    const ring = nodesToCoords(way.nodes, nodeMap);
    if (!ring || ring.length < 4) continue;

    const geom = { type: 'Polygon', coordinates: [ring] };
    const bpdaH = resolveBpdaHeight(geom, tags.name, bpdaFeatures);
    const props = {
      kind: 'building',
      osmId: `way/${way.id}`,
      height: bpdaH ?? parseOsmHeight(tags),
    };
    if (tags.name) props.name = tags.name;
    if (tags['building:levels']) props.levels = Number.parseFloat(tags['building:levels']) || undefined;
    if (tags.building !== 'yes') props.buildingType = tags.building;
    features.push({ type: 'Feature', properties: props, geometry: geom });
  }

  for (const rel of relations) {
    const tags = rel.tags || {};
    if (!tags.building || !Array.isArray(rel.members)) continue;
    const outerSegs = [];
    const innerSegs = [];
    for (const m of rel.members) {
      if (m.type !== 'way') continue;
      const w = wayMap.get(m.ref);
      if (!w || !Array.isArray(w.nodes) || w.nodes.length < 2) continue;
      if (m.role === 'inner') innerSegs.push(w.nodes);
      else outerSegs.push(w.nodes);
    }
    const outerRings = stitchRings(outerSegs).map((r) => nodesToCoords(r, nodeMap)).filter(Boolean);
    const innerRings = stitchRings(innerSegs).map((r) => nodesToCoords(r, nodeMap)).filter(Boolean);
    if (outerRings.length === 0) continue;

    const geom =
      outerRings.length === 1
        ? { type: 'Polygon', coordinates: [outerRings[0], ...innerRings] }
        : {
            type: 'MultiPolygon',
            coordinates: outerRings.map((ring, idx) => (idx === 0 ? [ring, ...innerRings] : [ring])),
          };
    const bpdaH = resolveBpdaHeight(geom, tags.name, bpdaFeatures);
    const props = {
      kind: 'building',
      osmId: `relation/${rel.id}`,
      height: bpdaH ?? parseOsmHeight(tags),
    };
    if (tags.name) props.name = tags.name;
    if (tags['building:levels']) props.levels = Number.parseFloat(tags['building:levels']) || undefined;
    features.push({ type: 'Feature', properties: props, geometry: geom });
  }

  const WALKABLE_HIGHWAYS = new Set([
    'footway', 'path', 'pedestrian', 'steps', 'cycleway', 'corridor',
    'service', 'living_street', 'unclassified', 'residential', 'tertiary',
  ]);
  for (const way of wayMap.values()) {
    const tags = way.tags || {};
    if (!tags.highway || !WALKABLE_HIGHWAYS.has(tags.highway)) continue;
    if (tags.access === 'private' && tags.foot !== 'yes') continue;
    if (tags.foot === 'no') continue;
    if (!Array.isArray(way.nodes) || way.nodes.length < 2) continue;
    const coords = nodesToCoords(way.nodes, nodeMap);
    if (!coords || coords.length < 2) continue;
    const props = { kind: 'path', osmId: `way/${way.id}`, highway: tags.highway };
    if (tags.name) props.name = tags.name;
    if (tags.indoor === 'yes' || tags.covered === 'yes' || tags.highway === 'corridor') {
      props.covered = true;
    }
    features.push({ type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates: coords } });
  }

  // Building doors (OSM entrance=*), so routes end at a real door instead of a centroid.
  // The app assigns each door to the building whose outline it sits on.
  for (const node of nodeMap.values()) {
    const ent = node.tags?.entrance;
    if (!ent || ent === 'no' || ent === 'room' || ent === 'emergency') continue;
    const props = { kind: 'entrance', osmId: `node/${node.id}`, entrance: ent };
    if (node.tags.wheelchair) props.wheelchair = node.tags.wheelchair;
    features.push({
      type: 'Feature',
      properties: props,
      geometry: { type: 'Point', coordinates: [roundCoord(node.lon), roundCoord(node.lat)] },
    });
  }

  // Dorchester Bay / Columbia Point coastline (stitched OSM natural=coastline ways)
  const coastSegs = [];
  for (const way of wayMap.values()) {
    if (way.tags?.natural === 'coastline' && Array.isArray(way.nodes) && way.nodes.length >= 2) {
      coastSegs.push(way.nodes);
    }
  }
  stitchPolylines(coastSegs).forEach((chain, idx) => {
    const coords = nodesToCoords(chain, nodeMap);
    if (!coords || coords.length < 2) return;
    features.push({
      type: 'Feature',
      properties: { kind: 'coastline', osmId: `coastline/${idx}` },
      geometry: { type: 'LineString', coordinates: coords },
    });
  });

  // Campus terrain surfaces (lawns/parks, athletic pitches/courts, surface parking lots)
  for (const way of wayMap.values()) {
    const tags = way.tags || {};
    if (tags.building) continue;
    if (!Array.isArray(way.nodes) || way.nodes.length < 4) continue;
    if (way.nodes[0] !== way.nodes[way.nodes.length - 1]) continue;

    let surfaceType = null;
    if (tags.leisure === 'pitch') surfaceType = 'pitch';
    else if (tags.amenity === 'parking') surfaceType = 'parking';
    else if (
      tags.landuse === 'grass' ||
      tags.leisure === 'park' ||
      tags.landuse === 'recreation_ground' ||
      tags.natural === 'scrub'
    ) {
      surfaceType = 'green';
    }
    if (!surfaceType) continue;

    const ring = nodesToCoords(way.nodes, nodeMap);
    if (!ring || ring.length < 4) continue;
    const minArea = surfaceType === 'pitch' ? 60 : 180;
    if (polygonAreaMeters2(ring) < minArea) continue;

    features.push({
      type: 'Feature',
      properties: {
        kind: 'surface',
        osmId: `way/${way.id}`,
        surfaceType,
        sport: tags.sport || undefined,
      },
      geometry: { type: 'Polygon', coordinates: [ring] },
    });
  }

  // Primary vehicle roads outside walkable set (Morrissey Blvd / ramps) for road network visual
  const ROAD_HIGHWAYS = new Set(['primary', 'primary_link', 'secondary', 'tertiary', 'unclassified', 'residential']);
  for (const way of wayMap.values()) {
    const tags = way.tags || {};
    if (!tags.highway || !ROAD_HIGHWAYS.has(tags.highway)) continue;
    if (!Array.isArray(way.nodes) || way.nodes.length < 2) continue;
    const coords = nodesToCoords(way.nodes, nodeMap);
    if (!coords || coords.length < 2) continue;
    features.push({
      type: 'Feature',
      properties: { kind: 'road', osmId: `road/${way.id}`, highway: tags.highway },
      geometry: { type: 'LineString', coordinates: coords },
    });
  }

  // BPDA LoD2 taller stepped roof tiers & penthouses for major/named buildings
  const namedBuildings = features.filter((f) => f.properties.kind === 'building' && f.properties.name);
  for (const b of namedBuildings) {
    const baseH = b.properties.height;
    for (const rf of roofprintFeatures) {
      const hFt = Number(rf.properties?.Bld_Height_Ft);
      if (!Number.isFinite(hFt)) continue;
      const hM = Math.round(hFt * FT_TO_M * 10) / 10;
      if (hM <= baseH + 1.8 || hM > 72) continue;
      const r0 =
        rf.geometry?.type === 'Polygon'
          ? rf.geometry.coordinates[0]
          : rf.geometry?.type === 'MultiPolygon'
            ? rf.geometry.coordinates[0]?.[0]
            : null;
      if (!r0 || r0.length < 4) continue;
      const c = ringCentroid(r0);
      if (!inGeom(c, b.geometry)) continue;
      features.push({
        type: 'Feature',
        properties: {
          kind: 'roofPart',
          osmId: `bpda-roof/${rf.properties.OBJECTID}`,
          parentName: b.properties.name,
          baseHeight: baseH,
          height: hM,
        },
        geometry: {
          type: 'Polygon',
          coordinates: [roundRingCoords(r0)],
        },
      });
    }
  }

  const geojson = {
    type: 'FeatureCollection',
    metadata: {
      attribution: '(c) OpenStreetMap contributors, ODbL; BPDA Boston_Buildings & Roofprints LiDAR',
      source: 'OpenStreetMap v0.6 API + City of Boston BPDA Open Data',
      fetchedAt: new Date().toISOString(),
      bbox: BBOX,
      origin: ORIGIN,
    },
    features,
  };

  await fs.mkdir(path.dirname(OUT_PATH), { recursive: true });
  const json = JSON.stringify(geojson);
  await fs.writeFile(OUT_PATH, json, 'utf8');
  const bCount = features.filter((f) => f.properties.kind === 'building').length;
  const pCount = features.filter((f) => f.properties.kind === 'path').length;
  const cCount = features.filter((f) => f.properties.kind === 'coastline').length;
  const sCount = features.filter((f) => f.properties.kind === 'surface').length;
  const rCount = features.filter((f) => f.properties.kind === 'roofPart').length;
  const eCount = features.filter((f) => f.properties.kind === 'entrance').length;
  console.log(
    `Wrote ${OUT_PATH} (${(json.length / 1024).toFixed(1)} KB): ${bCount} buildings, ${rCount} roofParts, ${eCount} entrances, ${pCount} paths, ${sCount} surfaces, ${cCount} coastlines.`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
