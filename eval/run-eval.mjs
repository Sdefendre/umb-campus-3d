#!/usr/bin/env node
/**
 * Deterministic scored evaluation harness for UMB Campus 3D.
 * Usage: npm run eval
 *
 * Prints exactly one JSON summary line followed by `SCORE <0..100>`.
 * Exit code is 0 when all hard gates pass, non-zero otherwise.
 */

import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import lighthouse from 'lighthouse';
import { chromium } from 'playwright-core';
import { createServer as createViteServer } from 'vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT, 'dist');
const CHROME_PATH =
  process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const WEIGHTS = {
  parser: 20,
  routing: 20,
  phoneFps: 20,
  lighthousePwa: 15,
  bundleGzip: 10,
  realism: 15,
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.geojson': 'application/geo+json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.ics': 'text/calendar; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

const PRIVACY_SENTINELS = [
  'UMB_PRIVACY_SENTINEL_ICS_8812',
  'UMB_PRIVACY_SENTINEL_PDF_94821',
  'UMB_PRIVACY_SENTINEL_PASTE_7741',
  'CS 285L',
  'MUSIC 111',
  'MATH 345',
  'SOCIOL 101',
];

const PHOTO_BENCHMARKS = [
  {
    id: 'west-2025',
    file: path.join(ROOT, 'eval/reference/photos/west-2025.jpg'),
    width: 480,
    height: 320,
    evalCam: '-698,6,94,-160,14,15,53.1',
  },
  {
    id: 'isc-2025',
    file: path.join(ROOT, 'eval/reference/photos/isc-2025.jpg'),
    width: 480,
    height: 320,
    evalCam: '-667,6,167,-215,16,-35,16.1',
  },
  {
    id: 'aerial-2024',
    file: path.join(ROOT, 'eval/reference/photos/aerial-2024.jpg'),
    width: 480,
    height: 360,
    evalCam: '115,160,-155,-65,12,-265,34',
  },
];

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

function runCmdGate(cmd) {
  try {
    execSync(cmd, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8' });
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: (err.stderr || err.stdout || err.message || '').toString().slice(-600),
    };
  }
}

function startStaticServer(dir) {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const urlPath = (req.url || '/').split('?')[0];
      const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
      const fullPath = path.join(dir, rel);
      try {
        const data = await fs.readFile(fullPath);
        const ext = path.extname(fullPath);
        res.writeHead(200, {
          'Content-Type': MIME[ext] || 'application/octet-stream',
          'Cache-Control': rel.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
        });
        res.end(data);
      } catch {
        res.writeHead(404);
        res.end('Not found');
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, port: addr.port, origin: `http://127.0.0.1:${addr.port}` });
    });
  });
}

function dist2D(a, b) {
  return Math.hypot(b.x - a.x, b.z - a.z);
}

function segIntersect(a, b, c, d) {
  const ccw = (p1, p2, p3) => (p3.z - p1.z) * (p2.x - p1.x) > (p2.z - p1.z) * (p3.x - p1.x);
  return ccw(a, c, d) !== ccw(b, c, d) && ccw(a, b, c) !== ccw(a, b, d);
}

function pointToRingDist(pt, ring) {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len2 = dx * dx + dz * dz;
    const t = len2 > 1e-8 ? clamp(((pt.x - a.x) * dx + (pt.z - a.z) * dz) / len2, 0, 1) : 0;
    const d = Math.hypot(pt.x - (a.x + t * dx), pt.z - (a.z + t * dz));
    if (d < best) best = d;
  }
  return best;
}

function polygonArea2D(ring) {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p0 = ring[i];
    const p1 = ring[(i + 1) % ring.length];
    a += p0.x * p1.z - p1.x * p0.z;
  }
  return Math.abs(a) * 0.5;
}

/**
 * Independent Dijkstra shortest-path solver directly on raw GeoJSON walkable footways
 * (excluding segments inside buildings or crossing OSM coastline).
 */
function buildIndependentDijkstra(paths, buildings, coastlineSegs, pointInBuildingPolygons) {
  const bBoxes = buildings.map((b) => {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const poly of b.polygons) {
      if (!poly.length) continue;
      for (const p of poly[0]) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.z < minZ) minZ = p.z;
        if (p.z > maxZ) maxZ = p.z;
      }
    }
    return { minX, maxX, minZ, maxZ, polygons: b.polygons };
  });

  const insideBuilding = (pt) => {
    for (const b of bBoxes) {
      if (pt.x < b.minX || pt.x > b.maxX || pt.z < b.minZ || pt.z > b.maxZ) continue;
      if (pointInBuildingPolygons(pt, b.polygons)) return true;
    }
    return false;
  };

  const crossesWater = (a, b) => {
    for (const [c, d] of coastlineSegs) {
      if (segIntersect(a, b, c, d)) return true;
    }
    return false;
  };

  const nodes = [];
  const keyToId = new Map();
  const getNode = (pt) => {
    const key = `${Math.round(pt.x * 4)},${Math.round(pt.z * 4)}`;
    if (keyToId.has(key)) return keyToId.get(key);
    const id = nodes.length;
    nodes.push({ id, point: pt, indoor: insideBuilding(pt), edges: [] });
    keyToId.set(key, id);
    return id;
  };

  for (const p of paths) {
    if (p.covered) continue;
    for (let i = 1; i < p.points.length; i++) {
      const pa = p.points[i - 1];
      const pb = p.points[i];
      const d = dist2D(pa, pb);
      if (d < 0.05) continue;
      const mid = { x: (pa.x + pb.x) * 0.5, z: (pa.z + pb.z) * 0.5 };
      if (insideBuilding(pa) || insideBuilding(pb) || insideBuilding(mid)) continue;
      if (crossesWater(pa, pb)) continue;
      const a = getNode(pa);
      const b = getNode(pb);
      if (a === b) continue;
      nodes[a].edges.push({ to: b, dist: d });
      nodes[b].edges.push({ to: a, dist: d });
    }
  }

  // Largest connected component
  const visited = new Uint8Array(nodes.length);
  let mainComp = new Set();
  for (let i = 0; i < nodes.length; i++) {
    if (visited[i] || nodes[i].edges.length === 0) continue;
    const comp = [];
    const stack = [i];
    visited[i] = 1;
    while (stack.length) {
      const u = stack.pop();
      comp.push(u);
      for (const e of nodes[u].edges) {
        if (!visited[e.to]) {
          visited[e.to] = 1;
          stack.push(e.to);
        }
      }
    }
    if (comp.length > mainComp.size) mainComp = new Set(comp);
  }

  const nearest = (target) => {
    let best = -1, bestD = Infinity;
    for (const id of mainComp) {
      const d = dist2D(nodes[id].point, target);
      if (d < bestD) { bestD = d; best = id; }
    }
    return best;
  };

  const shortestDist = (start, goal) => {
    const s = nearest(start);
    const t = nearest(goal);
    if (s < 0 || t < 0) return null;
    const startToFirst = dist2D(start, nodes[s].point);
    if (s === t) return { distanceMeters: startToFirst + dist2D(nodes[s].point, goal), goalNodeDist: dist2D(nodes[t].point, goal) };
    const dist = new Float64Array(nodes.length).fill(Infinity);
    const done = new Uint8Array(nodes.length);
    dist[s] = 0;
    // Simple binary heap
    const heap = [{ id: s, d: 0 }];
    const push = (item) => {
      heap.push(item);
      let i = heap.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (heap[p].d <= heap[i].d) break;
        [heap[p], heap[i]] = [heap[i], heap[p]];
        i = p;
      }
    };
    const pop = () => {
      const top = heap[0];
      const last = heap.pop();
      if (heap.length) {
        heap[0] = last;
        let i = 0;
        while (true) {
          const l = (i << 1) + 1, r = l + 1;
          let m = i;
          if (l < heap.length && heap[l].d < heap[m].d) m = l;
          if (r < heap.length && heap[r].d < heap[m].d) m = r;
          if (m === i) break;
          [heap[i], heap[m]] = [heap[m], heap[i]];
          i = m;
        }
      }
      return top;
    };
    while (heap.length) {
      const cur = pop();
      if (done[cur.id]) continue;
      if (cur.id === t) break;
      done[cur.id] = 1;
      for (const e of nodes[cur.id].edges) {
        const nd = cur.d + e.dist;
        if (nd < dist[e.to]) {
          dist[e.to] = nd;
          push({ id: e.to, d: nd });
        }
      }
    }
    if (!Number.isFinite(dist[t])) return null;
    return { distanceMeters: startToFirst + dist[t], goalNodeDist: dist2D(nodes[t].point, goal) };
  };

  return { shortestDist, insideBuilding, crossesWater };
}

async function evalParserAndRouting() {
  const vite = await createViteServer({
    root: ROOT,
    server: { middlewareMode: true, ws: false },
    appType: 'custom',
    logLevel: 'silent',
  });
  try {
    const buildingsMod = await vite.ssrLoadModule('/src/buildings.ts');
    const scheduleMod = await vite.ssrLoadModule('/src/schedule.ts');
    const geoMod = await vite.ssrLoadModule('/src/geo.ts');
    const graphMod = await vite.ssrLoadModule('/src/graph.ts');

    // (a) Parser accuracy on 36 fixed cases + ICS fixture
    const cases = JSON.parse(
      await fs.readFile(path.join(ROOT, 'eval/fixtures/parser-cases.json'), 'utf8')
    );
    let parserPassed = 0;
    const parserFailures = [];
    for (const c of cases) {
      let actualBuildingId = null;
      let actualRoom = '';
      if (c.kind === 'text') {
        const parsed = scheduleMod.parseTextSchedule(c.input);
        if (parsed.length === 1) {
          actualBuildingId = parsed[0].buildingId;
          actualRoom = parsed[0].room;
        } else if (parsed.length === 0) {
          actualBuildingId = null;
          actualRoom = '';
        } else {
          actualBuildingId = `MULTI(${parsed.length})`;
        }
      } else {
        const r = buildingsMod.resolveBuildingFromText(c.input);
        actualBuildingId = r.building?.id ?? null;
        actualRoom = r.room;
      }

      const ok = actualBuildingId === c.expectedBuildingId && actualRoom === c.expectedRoom;
      if (ok) parserPassed++;
      else {
        parserFailures.push({
          id: c.id,
          expected: { buildingId: c.expectedBuildingId, room: c.expectedRoom },
          actual: { buildingId: actualBuildingId, room: actualRoom },
        });
      }
    }

    // Also validate ICS Spring 2027 fixture (4 courses incl. merged Mon/Wed CS 285L & unmapped SOCIOL 101 online)
    const icsText = await fs.readFile(path.join(ROOT, 'eval/fixtures/privacy-schedule.ics'), 'utf8');
    const icsItems = scheduleMod.parseIcsSchedule(icsText);
    const icsChecks = [
      icsItems.length === 4,
      icsItems.some((x) => x.title.includes('CS 285L') && x.buildingId === 'mccormack' && x.room === '01-0408' && x.daysLabel === 'Mon/Wed'),
      icsItems.some((x) => x.title.includes('MUSIC 111') && x.buildingId === 'uhall' && x.room === '2310'),
      icsItems.some((x) => x.title.includes('MATH 345') && x.buildingId === 'wheatley' && x.room === '02-0041'),
      icsItems.some((x) => x.title.includes('SOCIOL 101') && x.buildingId === null),
    ];
    const totalParserChecks = cases.length + icsChecks.length;
    const totalParserPassed = parserPassed + icsChecks.filter(Boolean).length;
    const parserScore = (totalParserPassed / totalParserChecks) * 100;

    // (b) Route correctness on 18 fixed pairs
    const campus = JSON.parse(
      await fs.readFile(path.join(ROOT, 'public/data/umb-campus.geojson'), 'utf8')
    );
    const coastline = JSON.parse(
      await fs.readFile(path.join(ROOT, 'eval/reference/osm-coastline.json'), 'utf8')
    );
    const pairs = JSON.parse(
      await fs.readFile(path.join(ROOT, 'eval/fixtures/route-pairs.json'), 'utf8')
    );

    const projector = new geoMod.LocalProjector(campus.metadata.origin);
    const buildings = [];
    const majorById = new Map();
    const paths = [];

    for (const feat of campus.features) {
      if (feat.properties.kind === 'building') {
        const majorDef = buildingsMod.matchOsmMajorBuilding(feat.properties.name);
        const rawPolys =
          feat.geometry.type === 'Polygon'
            ? [feat.geometry.coordinates]
            : feat.geometry.type === 'MultiPolygon'
              ? feat.geometry.coordinates
              : [];
        const polygons = rawPolys.map((poly) => poly.map((ring) => projector.projectRing(ring)));
        if (!polygons.length || !polygons[0].length) continue;
        const record = {
          id: majorDef ? majorDef.id : feat.properties.osmId,
          osmId: feat.properties.osmId,
          name: majorDef ? majorDef.canonicalName : feat.properties.name ?? 'Building',
          shortCode: majorDef ? majorDef.shortCode : '',
          isMajor: Boolean(majorDef),
          height: feat.properties.height,
          centroid: geoMod.polygonCentroid(polygons[0][0]),
          polygons,
        };
        buildings.push(record);
        if (majorDef && !majorById.has(majorDef.id)) {
          majorById.set(majorDef.id, record);
        }
      } else if (feat.properties.kind === 'path' && feat.geometry.type === 'LineString') {
        const pts = projector.projectRing(feat.geometry.coordinates);
        if (pts.length >= 2) {
          paths.push({ points: pts, highway: feat.properties.highway, covered: feat.properties.covered });
        }
      }
    }

    const coastlineSegs = [];
    for (const w of coastline.coastlineWays || []) {
      const pts = projector.projectRing(w.coords);
      for (let i = 1; i < pts.length; i++) coastlineSegs.push([pts[i - 1], pts[i]]);
    }

    const appGraph = new graphMod.CampusFootwayGraph(paths, buildings);
    const refSolver = buildIndependentDijkstra(
      paths,
      buildings,
      coastlineSegs,
      geoMod.pointInBuildingPolygons
    );

    let routeCredit = 0;
    let routeFullPass = 0;
    const routeIssues = [];

    for (const pair of pairs) {
      const sp = buildingsMod.START_POINTS.find((s) => s.id === pair.startId);
      const b = majorById.get(pair.buildingId);
      if (!sp || !b) {
        routeIssues.push({ pair, reason: 'missing start or building' });
        continue;
      }
      const startPt = projector.project(sp.lonLat.lon, sp.lonLat.lat);
      const res = appGraph.findRoute(startPt, b.centroid);
      const ref = refSolver.shortestDist(startPt, b.centroid);

      if (!res || res.points.length < 2) {
        routeIssues.push({ pair, reason: 'no route returned' });
        continue;
      }

      const endPt = res.points[res.points.length - 1];
      const distToBuildingEdge = Math.min(
        ...b.polygons.filter((p) => p.length > 0).map((p) => pointToRingDist(endPt, p[0]))
      );
      const reachesEntrance = distToBuildingEdge <= 45;

      const lengthWithinTol =
        !ref ||
        (res.distanceMeters >= ref.distanceMeters * 0.85 &&
          res.distanceMeters <= ref.distanceMeters * 1.35);

      let buildingCrossings = 0;
      let waterCrossings = 0;
      for (let i = 1; i < res.points.length; i++) {
        const a = res.points[i - 1];
        const c = res.points[i];
        if (refSolver.crossesWater(a, c)) waterCrossings++;
        const segLen = dist2D(a, c);
        const steps = Math.max(1, Math.ceil(segLen / 2));
        for (let k = 1; k < steps; k++) {
          const t = k / steps;
          const pt = { x: a.x + (c.x - a.x) * t, z: a.z + (c.z - a.z) * t };
          if (refSolver.insideBuilding(pt)) {
            buildingCrossings++;
            break;
          }
        }
      }

      const noObstacles = buildingCrossings === 0 && waterCrossings === 0;
      const pairScore =
        (reachesEntrance ? 0.4 : 0) + (lengthWithinTol ? 0.3 : 0) + (noObstacles ? 0.3 : 0);
      routeCredit += pairScore;
      if (reachesEntrance && lengthWithinTol && noObstacles) routeFullPass++;
      else {
        routeIssues.push({
          pair,
          distToBuildingEdge: round2(distToBuildingEdge),
          appDist: round2(res.distanceMeters),
          refDist: ref ? round2(ref.distanceMeters) : null,
          buildingCrossings,
          waterCrossings,
        });
      }
    }

    const routingScore = (routeCredit / pairs.length) * 100;

    // Height realism against cited BPDA LiDAR + OSM building:levels reference
    const heightRef = JSON.parse(
      await fs.readFile(path.join(ROOT, 'eval/reference/building-heights.json'), 'utf8')
    );
    // Group campus GeoJSON features by osmId (area-weighted average height if split into roof parts)
    const actualHeightMap = new Map();
    for (const feat of campus.features) {
      if (feat.properties.kind !== 'building') continue;
      const osmId = feat.properties.osmId;
      const rawPolys =
        feat.geometry.type === 'Polygon'
          ? [feat.geometry.coordinates]
          : feat.geometry.type === 'MultiPolygon'
            ? feat.geometry.coordinates
            : [];
      let area = 0;
      for (const poly of rawPolys) {
        if (poly.length > 0) area += polygonArea2D(projector.projectRing(poly[0]));
      }
      area = Math.max(1, area);
      const entry = actualHeightMap.get(osmId) || { weightedH: 0, totalArea: 0 };
      entry.weightedH += feat.properties.height * area;
      entry.totalArea += area;
      actualHeightMap.set(osmId, entry);
    }

    let heightSum = 0;
    let heightCount = 0;
    let totalAbsRelErr = 0;
    for (const ref of heightRef.buildings) {
      const actual = actualHeightMap.get(ref.osmId);
      if (!actual) continue;
      const actualH = actual.weightedH / actual.totalArea;
      const relErr = Math.abs(actualH - ref.referenceHeightM) / Math.max(1, ref.referenceHeightM);
      totalAbsRelErr += relErr;
      heightSum += Math.max(0, 1 - relErr);
      heightCount++;
    }
    const heightScore = heightCount > 0 ? (heightSum / heightCount) * 100 : 0;
    const meanRelHeightErr = heightCount > 0 ? totalAbsRelErr / heightCount : 1;

    return {
      parser: {
        score: round2(parserScore),
        passed: totalParserPassed,
        total: totalParserChecks,
        failures: parserFailures.slice(0, 5),
      },
      routing: {
        score: round2(routingScore),
        fullPass: routeFullPass,
        total: pairs.length,
        issues: routeIssues.slice(0, 5),
      },
      heights: {
        score: round2(heightScore),
        evaluatedBuildings: heightCount,
        meanRelErrorPct: round2(meanRelHeightErr * 100),
      },
    };
  } finally {
    await vite.close();
  }
}

async function evalInitialBundleGzip() {
  const html = await fs.readFile(path.join(DIST_DIR, 'index.html'), 'utf8');
  const refs = new Set();
  for (const m of html.matchAll(/(?:src|href)="(\.?\/?assets\/[^"]+\.(?:js|mjs))"/g)) {
    refs.add(m[1].replace(/^\.\//, ''));
  }
  let totalGzipBytes = 0;
  const files = [];
  for (const rel of refs) {
    const buf = await fs.readFile(path.join(DIST_DIR, rel));
    const gz = zlib.gzipSync(buf, { level: 9 }).length;
    totalGzipBytes += gz;
    files.push({ file: rel, gzipKb: round2(gz / 1024) });
  }
  const totalKb = totalGzipBytes / 1024;
  const score = clamp(((300 - totalKb) / (300 - 120)) * 100, 0, 100);
  return {
    score: round2(score),
    initialJsGzipKb: round2(totalKb),
    files,
  };
}

async function evalPrivacyAndInstallability(browser, origin) {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();

  const nonSameOriginRequests = [];
  const leakedRequests = [];
  const checkLeak = (str) =>
    typeof str === 'string' && PRIVACY_SENTINELS.some((s) => str.includes(s));

  page.on('request', (req) => {
    const url = req.url();
    if (!url.startsWith(origin) && !url.startsWith('data:') && !url.startsWith('blob:')) {
      nonSameOriginRequests.push(url);
    }
    if (checkLeak(url) || checkLeak(req.postData() || '')) {
      leakedRequests.push({ url, method: req.method() });
    }
  });

  await page.goto(origin + '/', { waitUntil: 'networkidle' });
  await page.waitForSelector('.building-label', { timeout: 15000 });

  // 1. Upload ICS fixture & verify online SOCIOL 101 does NOT get a route
  await page.setInputFiles('#file-input', path.join(ROOT, 'eval/fixtures/privacy-schedule.ics'));
  await page.waitForSelector('.class-card', { timeout: 10000 });
  const onlineCheck = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.class-card')];
    const soc = cards.find((c) => c.textContent?.includes('SOCIOL 101'));
    const beforeDest = document.getElementById('route-dest-name')?.textContent || '';
    if (soc) soc.click();
    const afterDest = document.getElementById('route-dest-name')?.textContent || '';
    return {
      foundOnlineCard: Boolean(soc),
      isUnmatched: soc ? soc.classList.contains('is-unmatched') : false,
      didNotRouteOnline: beforeDest === afterDest && !afterDest.toLowerCase().includes('sociol'),
    };
  });

  // 2. Upload PDF fixture
  await page.setInputFiles(
    '#file-input-inline',
    path.join(ROOT, 'eval/fixtures/privacy-schedule.pdf')
  );
  await page.waitForFunction(
    () => (document.getElementById('status-line')?.textContent || '').includes('privacy-schedule.pdf'),
    { timeout: 15000 }
  );

  // 3. Paste schedule text
  const pasteText = await fs.readFile(path.join(ROOT, 'eval/fixtures/privacy-paste.txt'), 'utf8');
  await page.click('#btn-paste-inline');
  await page.fill('#paste-input', pasteText);
  await page.click('#btn-parse-paste');
  await page.waitForFunction(
    () => (document.getElementById('status-line')?.textContent || '').includes('Pasted schedule'),
    { timeout: 10000 }
  );

  // 4. Audit localStorage, sessionStorage, IndexedDB, Cache Storage
  const storageAudit = await page.evaluate(async (sentinels) => {
    const hasSentinel = (txt) => typeof txt === 'string' && sentinels.some((s) => txt.includes(s));
    const leaks = [];

    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      const v = localStorage.getItem(k);
      if (hasSentinel(k) || hasSentinel(v)) leaks.push(`localStorage:${k}`);
    }
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      const v = sessionStorage.getItem(k);
      if (hasSentinel(k) || hasSentinel(v)) leaks.push(`sessionStorage:${k}`);
    }
    if (indexedDB.databases) {
      const dbs = await indexedDB.databases();
      for (const dbInfo of dbs) {
        if (!dbInfo.name) continue;
        if (hasSentinel(dbInfo.name)) leaks.push(`indexedDB:${dbInfo.name}`);
        await new Promise((resolve) => {
          const req = indexedDB.open(dbInfo.name);
          req.onsuccess = () => {
            const db = req.result;
            const stores = [...db.objectStoreNames];
            if (stores.length === 0) { db.close(); resolve(); return; }
            const tx = db.transaction(stores, 'readonly');
            let pending = stores.length;
            for (const sName of stores) {
              const g = tx.objectStore(sName).getAll();
              g.onsuccess = () => {
                if (hasSentinel(JSON.stringify(g.result))) leaks.push(`indexedDB:${dbInfo.name}/${sName}`);
                if (--pending === 0) { db.close(); resolve(); }
              };
              g.onerror = () => { if (--pending === 0) { db.close(); resolve(); } };
            }
          };
          req.onerror = () => resolve();
        });
      }
    }
    if ('caches' in window) {
      const cacheNames = await caches.keys();
      for (const name of cacheNames) {
        const cache = await caches.open(name);
        const reqs = await cache.keys();
        for (const r of reqs) {
          if (hasSentinel(r.url)) leaks.push(`cache-url:${r.url}`);
          const resp = await cache.match(r);
          if (resp) {
            const ct = resp.headers.get('content-type') || '';
            if (ct.includes('text') || ct.includes('json') || ct.includes('javascript') || ct.includes('calendar')) {
              const body = await resp.text();
              if (hasSentinel(body)) leaks.push(`cache-body:${r.url}`);
            }
          }
        }
      }
    }
    return {
      localStorageKeys: localStorage.length,
      sessionStorageKeys: sessionStorage.length,
      leaks,
    };
  }, PRIVACY_SENTINELS);

  // 5. Direct PWA installability + first-visit offline reload check
  const pwaChecks = await page.evaluate(async () => {
    const manifestLink = document.querySelector('link[rel="manifest"]')?.getAttribute('href');
    const themeColor = document.querySelector('meta[name="theme-color"]')?.getAttribute('content');
    let manifestOk = false;
    let iconsOk = false;
    if (manifestLink) {
      const mRes = await fetch(manifestLink);
      if (mRes.ok) {
        const m = await mRes.json();
        manifestOk = Boolean(
          m.name && m.short_name && m.start_url && m.display === 'standalone' && Array.isArray(m.icons)
        );
        const has192 = m.icons?.some((i) => i.sizes === '192x192');
        const has512 = m.icons?.some((i) => i.sizes === '512x512' && (!i.purpose || i.purpose.includes('any')));
        const hasMaskable = m.icons?.some((i) => i.purpose?.includes('maskable'));
        if (has192 && has512 && hasMaskable) {
          const iconChecks = await Promise.all(
            m.icons.map((i) => fetch(i.src).then((r) => r.ok).catch(() => false))
          );
          iconsOk = iconChecks.every(Boolean);
        }
      }
    }
    const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.ready : null;
    const cacheKeys = 'caches' in window ? await caches.keys() : [];
    const hasHashedCache = cacheKeys.some((k) => /^umb-campus-3d-[a-f0-9]{8,}$/.test(k));
    return {
      manifestOk,
      iconsOk,
      themeColorOk: Boolean(themeColor),
      swActive: Boolean(reg?.active),
      hasHashedCache,
    };
  });

  // Test offline reload immediately after first visit
  let offlineOk = false;
  try {
    await ctx.setOffline(true);
    await page.reload({ waitUntil: 'load', timeout: 10000 });
    await page.waitForSelector('.building-label', { timeout: 8000 });
    await page.click('#btn-demo');
    await page.waitForSelector('#route-hud:not(.is-hidden)', { timeout: 8000 });
    offlineOk = true;
  } catch {
    offlineOk = false;
  }

  await ctx.close();

  const privacyOk =
    nonSameOriginRequests.length === 0 &&
    leakedRequests.length === 0 &&
    storageAudit.leaks.length === 0 &&
    onlineCheck.foundOnlineCard &&
    onlineCheck.isUnmatched &&
    onlineCheck.didNotRouteOnline;

  const installItems = [
    pwaChecks.manifestOk,
    pwaChecks.iconsOk,
    pwaChecks.themeColorOk,
    pwaChecks.swActive,
    pwaChecks.hasHashedCache,
    offlineOk,
  ];
  const installabilityScore = (installItems.filter(Boolean).length / installItems.length) * 100;

  return {
    privacyGate: {
      ok: privacyOk,
      nonSameOriginRequests,
      leakedRequests,
      storageLeaks: storageAudit.leaks,
      onlineCheck,
    },
    installability: {
      score: round2(installabilityScore),
      ...pwaChecks,
      offlineAfterFirstVisit: offlineOk,
    },
  };
}

async function evalPhoneFps(browser, origin) {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);

  await page.goto(origin + '/', { waitUntil: 'networkidle' });
  await page.waitForSelector('.building-label', { timeout: 15000 });
  await page.click('#btn-demo');
  await page.waitForSelector('#route-hud:not(.is-hidden)', { timeout: 10000 });

  // Apply 4x CPU throttle and measure 10s of scripted route animation
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.waitForTimeout(300);

  const stats = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const deltas = [];
        let last = performance.now();
        const start = last;
        function tick(now) {
          const dt = now - last;
          last = now;
          if (dt > 0.5 && dt < 2000) deltas.push(dt);
          if (now - start >= 10000) {
            deltas.sort((a, b) => a - b);
            const medMs = deltas[Math.floor(deltas.length * 0.5)] || 1000;
            const p95Ms = deltas[Math.min(deltas.length - 1, Math.floor(deltas.length * 0.95))] || 1000;
            resolve({
              frames: deltas.length,
              medianFps: 1000 / medMs,
              p5Fps: 1000 / p95Ms,
            });
          } else {
            requestAnimationFrame(tick);
          }
        }
        requestAnimationFrame(tick);
      })
  );

  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  await ctx.close();

  const medianScore = clamp((stats.medianFps / 60) * 100, 0, 100);
  const p5Score = clamp((stats.p5Fps / 45) * 100, 0, 100);
  const score = 0.6 * medianScore + 0.4 * p5Score;

  return {
    score: round2(score),
    medianFps: round2(stats.medianFps),
    p5Fps: round2(stats.p5Fps),
    frames: stats.frames,
  };
}

async function evalLighthouse(origin) {
  // Spawn a dedicated headless Chrome on an ephemeral debugging port for Lighthouse
  const debugPort = 9322 + Math.floor(Math.random() * 400);
  const userDataDir = `/tmp/umb-lh-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const proc = spawn(
    CHROME_PATH,
    [
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${userDataDir}`,
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--use-gl=angle',
      '--use-angle=metal',
      '--enable-webgl',
      '--ignore-gpu-blocklist',
      'about:blank',
    ],
    { stdio: 'ignore' }
  );

  // Wait for debugging port to be ready
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
      if (r.ok) break;
    } catch {
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  try {
    // Warm up Chrome + JIT once, then take median of 3 Lighthouse runs for determinism
    const perfRuns = [];
    const a11yRuns = [];
    for (let run = 0; run < 3; run++) {
      const result = await lighthouse(origin + '/', {
        port: debugPort,
        output: 'json',
        logLevel: 'error',
        onlyCategories: ['performance', 'accessibility'],
        formFactor: 'mobile',
        screenEmulation: {
          mobile: true,
          width: 390,
          height: 844,
          deviceScaleFactor: 2,
          disabled: false,
        },
      });
      perfRuns.push(Math.round((result?.lhr?.categories?.performance?.score ?? 0) * 100));
      a11yRuns.push(Math.round((result?.lhr?.categories?.accessibility?.score ?? 0) * 100));
    }
    perfRuns.sort((a, b) => a - b);
    a11yRuns.sort((a, b) => a - b);
    return { performance: perfRuns[1], accessibility: a11yRuns[1] };
  } finally {
    proc.kill('SIGTERM');
    await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function evalPhotoEdgeSsim(browser, origin) {
  const ctx = await browser.newContext({
    viewport: { width: 480, height: 360 },
    deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();

  const perPhoto = [];
  for (const spot of PHOTO_BENCHMARKS) {
    await page.setViewportSize({ width: spot.width, height: spot.height });
    const url = `${origin}/?evalView=1&evalCam=${encodeURIComponent(spot.evalCam)}`;
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.waitForSelector('canvas', { timeout: 15000 });
    await page.waitForTimeout(450);

    const shotBuf = await page.screenshot({ type: 'png' });
    const refBuf = await fs.readFile(spot.file);

    const renderDataUrl = `data:image/png;base64,${shotBuf.toString('base64')}`;
    const refDataUrl = `data:image/jpeg;base64,${refBuf.toString('base64')}`;

    const ssim = await page.evaluate(
      async ({ renderUrl, refUrl, w, h }) => {
        const loadImg = (src) =>
          new Promise((res, rej) => {
            const img = new Image();
            img.onload = () => res(img);
            img.onerror = rej;
            img.src = src;
          });

        const [imgA, imgB] = await Promise.all([loadImg(renderUrl), loadImg(refUrl)]);

        const toSobelEdges = (img) => {
          const c = document.createElement('canvas');
          c.width = w;
          c.height = h;
          const g = c.getContext('2d');
          g.drawImage(img, 0, 0, w, h);
          const { data } = g.getImageData(0, 0, w, h);
          const gray = new Float32Array(w * h);
          for (let i = 0; i < w * h; i++) {
            gray[i] = (0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]) / 255;
          }
          // 3x3 Sobel gradient magnitude
          const mag = new Float32Array(w * h);
          let maxM = 1e-6;
          for (let y = 1; y < h - 1; y++) {
            for (let x = 1; x < w - 1; x++) {
              const tl = gray[(y - 1) * w + (x - 1)];
              const tc = gray[(y - 1) * w + x];
              const tr = gray[(y - 1) * w + (x + 1)];
              const ml = gray[y * w + (x - 1)];
              const mr = gray[y * w + (x + 1)];
              const bl = gray[(y + 1) * w + (x - 1)];
              const bc = gray[(y + 1) * w + x];
              const br = gray[(y + 1) * w + (x + 1)];
              const gx = -tl - 2 * ml - bl + tr + 2 * mr + br;
              const gy = -tl - 2 * tc - tr + bl + 2 * bc + br;
              const m = Math.hypot(gx, gy);
              mag[y * w + x] = m;
              if (m > maxM) maxM = m;
            }
          }
          for (let i = 0; i < mag.length; i++) mag[i] /= maxM;
          return mag;
        };

        const eA = toSobelEdges(imgA);
        const eB = toSobelEdges(imgB);

        // Windowed SSIM (8x8 blocks) on Sobel edge maps
        const C1 = 0.01 * 0.01;
        const C2 = 0.03 * 0.03;
        const win = 8;
        let ssimSum = 0;
        let winCount = 0;
        for (let y = 0; y <= h - win; y += win) {
          for (let x = 0; x <= w - win; x += win) {
            let muA = 0, muB = 0;
            const n = win * win;
            for (let dy = 0; dy < win; dy++) {
              for (let dx = 0; dx < win; dx++) {
                const idx = (y + dy) * w + (x + dx);
                muA += eA[idx];
                muB += eB[idx];
              }
            }
            muA /= n;
            muB /= n;
            let varA = 0, varB = 0, cov = 0;
            for (let dy = 0; dy < win; dy++) {
              for (let dx = 0; dx < win; dx++) {
                const idx = (y + dy) * w + (x + dx);
                const da = eA[idx] - muA;
                const db = eB[idx] - muB;
                varA += da * da;
                varB += db * db;
                cov += da * db;
              }
            }
            varA /= n;
            varB /= n;
            cov /= n;
            const num = (2 * muA * muB + C1) * (2 * cov + C2);
            const den = (muA * muA + muB * muB + C1) * (varA + varB + C2);
            ssimSum += num / den;
            winCount++;
          }
        }
        return ssimSum / Math.max(1, winCount);
      },
      { renderUrl: renderDataUrl, refUrl: refDataUrl, w: spot.width, h: spot.height }
    );

    perPhoto.push({ id: spot.id, edgeSsim: round2(ssim) });
  }

  await ctx.close();
  const meanSsim = perPhoto.reduce((s, p) => s + p.edgeSsim, 0) / perPhoto.length;
  const score = clamp(((meanSsim - 0.15) / 0.65) * 100, 0, 100);
  return {
    score: round2(score),
    meanEdgeSsim: round2(meanSsim),
    photos: perPhoto,
  };
}

async function main() {
  // 1. Hard gates: typecheck, build, unit tests
  const typecheck = runCmdGate('npm run typecheck');
  const build = typecheck.ok ? runCmdGate('npm run build') : { ok: false, error: 'skipped' };
  const unitTests = build.ok ? runCmdGate('npm test') : { ok: false, error: 'skipped' };

  if (!typecheck.ok || !build.ok || !unitTests.ok) {
    const out = {
      score: 0,
      gates: { typecheck, build, unitTests, privacy: { ok: false, error: 'skipped' } },
      metrics: {},
    };
    console.log(JSON.stringify(out));
    console.log('SCORE 0.00');
    process.exit(1);
  }

  // 2. Non-browser metrics: parser, routing, heights, initial JS gzip
  const [prh, bundleGzip] = await Promise.all([evalParserAndRouting(), evalInitialBundleGzip()]);

  // 3. Browser metrics: privacy gate, installability, phone FPS, photo edge-SSIM, Lighthouse
  const { server, origin } = await startStaticServer(DIST_DIR);
  let privacyGate, installability, phoneFps, photoSsim, lh;
  try {
    const browser = await chromium.launch({
      executablePath: CHROME_PATH,
      headless: true,
      args: ['--use-gl=angle', '--use-angle=metal', '--enable-webgl', '--ignore-gpu-blocklist'],
    });
    try {
      ({ privacyGate, installability } = await evalPrivacyAndInstallability(browser, origin));
      phoneFps = await evalPhoneFps(browser, origin);
      photoSsim = await evalPhotoEdgeSsim(browser, origin);
    } finally {
      await browser.close();
    }

    // Run Lighthouse after Playwright Chrome is closed to avoid CPU contention
    lh = await evalLighthouse(origin);

    const lighthousePwaScore = round2(
      0.4 * lh.performance + 0.35 * lh.accessibility + 0.25 * installability.score
    );
    const realismScore = round2(0.6 * prh.heights.score + 0.4 * photoSsim.score);

    const allGatesPassed = typecheck.ok && build.ok && unitTests.ok && privacyGate.ok;

    const weightedScore = allGatesPassed
      ? round2(
          (prh.parser.score * WEIGHTS.parser +
            prh.routing.score * WEIGHTS.routing +
            phoneFps.score * WEIGHTS.phoneFps +
            lighthousePwaScore * WEIGHTS.lighthousePwa +
            bundleGzip.score * WEIGHTS.bundleGzip +
            realismScore * WEIGHTS.realism) /
            100
        )
      : 0;

    const summary = {
      score: weightedScore,
      gates: {
        typecheck: typecheck.ok,
        build: build.ok,
        unitTests: unitTests.ok,
        privacy: privacyGate.ok,
        privacyDetails: privacyGate.ok ? undefined : privacyGate,
      },
      weights: WEIGHTS,
      metrics: {
        parser: prh.parser,
        routing: prh.routing,
        phoneFps,
        lighthousePwa: {
          score: lighthousePwaScore,
          performance: lh.performance,
          accessibility: lh.accessibility,
          installability,
        },
        bundleGzip,
        realism: {
          score: realismScore,
          heights: prh.heights,
          photoEdgeSsim: photoSsim,
        },
      },
    };

    console.log(JSON.stringify(summary));
    console.log(`SCORE ${weightedScore.toFixed(2)}`);
    process.exit(allGatesPassed ? 0 : 1);
  } finally {
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  console.log(JSON.stringify({ score: 0, error: String(err) }));
  console.log('SCORE 0.00');
  process.exit(1);
});
