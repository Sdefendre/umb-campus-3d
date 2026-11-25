#!/usr/bin/env node
/**
 * Fetches OpenStreetMap building footprints and walkable footways/paths
 * for the UMass Boston (Columbia Point) campus via the Overpass API
 * and writes a static GeoJSON file to public/data/umb-campus.geojson.
 *
 * Usage: npm run fetch-osm
 * Data: (c) OpenStreetMap contributors, ODbL
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.resolve(__dirname, '../public/data/umb-campus.geojson');

// Columbia Point / UMass Boston campus + Mt. Vernon St / JFK-UMass walkway approach
const BBOX = {
  south: 42.3102,
  west: -71.0472,
  north: 42.3188,
  east: -71.0322,
};

// Local tangent plane origin near the center of the UMB campus plaza
const ORIGIN = {
  lat: 42.3138,
  lon: -71.0378,
};

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

const QUERY = `[out:json][timeout:45];
(
  way["building"](${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east});
  relation["building"](${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east});
  way["highway"~"^(footway|path|pedestrian|steps|cycleway|corridor|service|living_street|unclassified|residential|tertiary)$"](${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east});
);
out body;
>;
out skel qt;`;

// Sensible building-specific fallback heights (meters) when OSM omits height/levels.
// Values approximate public floor counts of major UMass Boston campus structures.
const KNOWN_HEIGHTS_M = new Map([
  ['Healey Library', 42],
  ['Wheatley Hall', 24],
  ['McCormack Hall', 21],
  ['University Hall', 22],
  ['Integrated Sciences Complex', 25],
  ['Campus Center', 20],
  ['Quinn Administration Building', 15],
  ['Clark Athletic Center', 14],
  ['West Garage', 18],
  ['Service and Supply Building', 10],
  ['Utility Plant', 12],
  ['John F. Kennedy Presidential Library and Museum', 36],
  ['Massachusetts Archives', 16],
]);

const DEFAULT_BUILDING_HEIGHT_M = 11;
const METERS_PER_LEVEL = 3.6;

function roundCoord(n) {
  return Math.round(n * 1e6) / 1e6;
}

function parseHeight(tags) {
  if (tags.height) {
    const match = String(tags.height).match(/[\d.]+/);
    if (match) {
      const val = Number.parseFloat(match[0]);
      if (Number.isFinite(val) && val > 1 && val < 300) {
        return Math.round(val * 10) / 10;
      }
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
  const remaining = segments
    .filter((seg) => seg.length >= 2)
    .map((seg) => [...seg]);
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

function nodesToCoords(nodeIds, nodeMap) {
  const coords = [];
  for (const id of nodeIds) {
    const n = nodeMap.get(id);
    if (!n) return null;
    coords.push([roundCoord(n.lon), roundCoord(n.lat)]);
  }
  return coords;
}

async function fetchOverpass() {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const endpoint of OVERPASS_ENDPOINTS) {
      try {
        console.log(`Querying ${endpoint} (attempt ${attempt + 1})...`);
        const res = await fetch(endpoint, {
          method: 'POST',
          body: 'data=' + encodeURIComponent(QUERY),
          signal: AbortSignal.timeout(25000),
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'umb-campus-3d/0.1 (https://github.com/Sdefendre/umb-campus-3d)',
          },
        });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
        }
        return await res.json();
      } catch (err) {
        lastError = err;
        console.warn(`Endpoint failed (${endpoint}):`, err.message);
      }
    }
    await new Promise((r) => setTimeout(r, 2500));
  }
  throw lastError;
}

async function main() {
  const osm = await fetchOverpass();
  const nodeMap = new Map();
  const wayMap = new Map();
  const relations = [];

  for (const el of osm.elements) {
    if (el.type === 'node') nodeMap.set(el.id, el);
    else if (el.type === 'way') wayMap.set(el.id, el);
    else if (el.type === 'relation') relations.push(el);
  }

  // Track ways that are members of building relations so we don't duplicate them
  const relationBuildingWays = new Set();
  for (const rel of relations) {
    if (rel.tags?.building && Array.isArray(rel.members)) {
      for (const m of rel.members) {
        if (m.type === 'way') relationBuildingWays.add(m.ref);
      }
    }
  }

  const features = [];

  // 1. Building ways
  for (const way of wayMap.values()) {
    const tags = way.tags || {};
    if (!tags.building) continue;
    if (relationBuildingWays.has(way.id) && !tags.name) continue;
    if (!Array.isArray(way.nodes) || way.nodes.length < 4) continue;
    if (way.nodes[0] !== way.nodes[way.nodes.length - 1]) continue;

    const ring = nodesToCoords(way.nodes, nodeMap);
    if (!ring || ring.length < 4) continue;

    const props = {
      kind: 'building',
      osmId: `way/${way.id}`,
      height: parseHeight(tags),
    };
    if (tags.name) props.name = tags.name;
    if (tags['building:levels']) props.levels = Number.parseFloat(tags['building:levels']) || undefined;
    if (tags.building !== 'yes') props.buildingType = tags.building;

    features.push({
      type: 'Feature',
      properties: props,
      geometry: {
        type: 'Polygon',
        coordinates: [ring],
      },
    });
  }

  // 2. Building multipolygon relations (e.g. Integrated Sciences Complex)
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

    const outerRings = stitchRings(outerSegs)
      .map((r) => nodesToCoords(r, nodeMap))
      .filter(Boolean);
    const innerRings = stitchRings(innerSegs)
      .map((r) => nodesToCoords(r, nodeMap))
      .filter(Boolean);

    if (outerRings.length === 0) continue;

    const props = {
      kind: 'building',
      osmId: `relation/${rel.id}`,
      height: parseHeight(tags),
    };
    if (tags.name) props.name = tags.name;
    if (tags['building:levels']) props.levels = Number.parseFloat(tags['building:levels']) || undefined;

    if (outerRings.length === 1) {
      features.push({
        type: 'Feature',
        properties: props,
        geometry: {
          type: 'Polygon',
          coordinates: [outerRings[0], ...innerRings],
        },
      });
    } else {
      features.push({
        type: 'Feature',
        properties: props,
        geometry: {
          type: 'MultiPolygon',
          coordinates: outerRings.map((ring, idx) => (idx === 0 ? [ring, ...innerRings] : [ring])),
        },
      });
    }
  }

  // 3. Walkable paths / footways / campus connectors
  const WALKABLE_HIGHWAYS = new Set([
    'footway',
    'path',
    'pedestrian',
    'steps',
    'cycleway',
    'corridor',
    'service',
    'living_street',
    'unclassified',
    'residential',
    'tertiary',
  ]);

  for (const way of wayMap.values()) {
    const tags = way.tags || {};
    if (!tags.highway || !WALKABLE_HIGHWAYS.has(tags.highway)) continue;
    if (tags.access === 'private' && tags.foot !== 'yes') continue;
    if (tags.foot === 'no') continue;
    if (!Array.isArray(way.nodes) || way.nodes.length < 2) continue;

    const coords = nodesToCoords(way.nodes, nodeMap);
    if (!coords || coords.length < 2) continue;

    const props = {
      kind: 'path',
      osmId: `way/${way.id}`,
      highway: tags.highway,
    };
    if (tags.name) props.name = tags.name;
    if (tags.indoor === 'yes' || tags.covered === 'yes') props.covered = true;

    features.push({
      type: 'Feature',
      properties: props,
      geometry: {
        type: 'LineString',
        coordinates: coords,
      },
    });
  }

  const geojson = {
    type: 'FeatureCollection',
    metadata: {
      attribution: '(c) OpenStreetMap contributors, ODbL',
      source: 'OpenStreetMap via Overpass API',
      fetchedAt: new Date().toISOString(),
      bbox: BBOX,
      origin: ORIGIN,
    },
    features,
  };

  await fs.mkdir(path.dirname(OUT_PATH), { recursive: true });
  const json = JSON.stringify(geojson);
  await fs.writeFile(OUT_PATH, json, 'utf8');

  const buildingCount = features.filter((f) => f.properties.kind === 'building').length;
  const pathCount = features.filter((f) => f.properties.kind === 'path').length;
  console.log(
    `Wrote ${OUT_PATH} (${(json.length / 1024).toFixed(1)} KB): ${buildingCount} buildings, ${pathCount} paths.`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
