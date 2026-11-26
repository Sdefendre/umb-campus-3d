import './style.css';
import { MAJOR_BUILDINGS, START_POINTS, matchOsmMajorBuilding } from './buildings';
import { LocalProjector, polygonCentroid } from './geo';
import { CampusFootwayGraph, assignEntrances } from './graph';
import { findNextClass, formatClock, leaveAdvice, walkMinutes } from './nextClass';
import { CampusScene } from './scene';
import type {
  BuildingRecord,
  CameraMode,
  CampusGeoJSON,
  ClassItem,
  EntranceRecord,
  LonLat,
  Point2D,
  RoadRecord,
  RoofPartRecord,
  RouteMode,
  SurfaceRecord,
} from './types';

let scheduleModPromise: Promise<typeof import('./schedule')> | null = null;
function loadScheduleParser(): Promise<typeof import('./schedule')> {
  if (!scheduleModPromise) {
    scheduleModPromise = import('./schedule').catch((err) => {
      scheduleModPromise = null;
      throw err;
    });
  }
  return scheduleModPromise;
}

// DOM references
const viewportEl = document.getElementById('viewport')!;
const labelLayerEl = document.getElementById('label-layer')!;
const panelEl = document.getElementById('panel')!;
const sheetToggleEl = document.getElementById('sheet-toggle')!;
const collapseBtnEl = document.getElementById('btn-collapse-mobile')!;
const statusLineEl = document.getElementById('status-line')!;
const startSelectEl = document.getElementById('start-select') as HTMLSelectElement;
const btnGpsEl = document.getElementById('btn-gps')!;
const btnRouteOutdoorEl = document.getElementById('btn-route-outdoor')!;
const btnRouteCatwalkEl = document.getElementById('btn-route-catwalk')!;
const btnChainNextEl = document.getElementById('btn-chain-next')!;

const intakeViewEl = document.getElementById('intake-view')!;
const scheduleViewEl = document.getElementById('schedule-view')!;
const classListEl = document.getElementById('class-list')!;
const scheduleCountEl = document.getElementById('schedule-count')!;
const errorBannerEl = document.getElementById('error-banner')!;
const nextCardEl = document.getElementById('next-card')!;
const nextLeaveEl = document.getElementById('next-leave')!;
const nextDetailEl = document.getElementById('next-detail')!;

const btnDemoEl = document.getElementById('btn-demo')!;
const fileInputEl = document.getElementById('file-input') as HTMLInputElement;
const fileInputInlineEl = document.getElementById('file-input-inline') as HTMLInputElement;
const btnTogglePasteEl = document.getElementById('btn-toggle-paste')!;
const btnPasteInlineEl = document.getElementById('btn-paste-inline')!;
const pasteBoxEl = document.getElementById('paste-box')!;
const pasteInputEl = document.getElementById('paste-input') as HTMLTextAreaElement;
const btnParsePasteEl = document.getElementById('btn-parse-paste')!;
const btnCancelPasteEl = document.getElementById('btn-cancel-paste')!;
const btnClearEl = document.getElementById('btn-clear')!;

const btnCamChaseEl = document.getElementById('btn-cam-chase')!;
const btnCamTopEl = document.getElementById('btn-cam-top')!;
const btnRecenterEl = document.getElementById('btn-recenter')!;

const routeHudEl = document.getElementById('route-hud')!;
const routeDestNameEl = document.getElementById('route-dest-name')!;
const routeEtaEl = document.getElementById('route-eta')!;
const routeDistEl = document.getElementById('route-dist')!;
const routeOriginLabelEl = document.getElementById('route-origin-label')!;
const routeCatwalkPillEl = document.getElementById('route-catwalk-pill')!;
const routeProgressBarEl = document.getElementById('route-progress-bar')!;
const btnPlayPauseEl = document.getElementById('btn-play-pause')!;
const iconPauseEl = document.getElementById('icon-pause')!;
const iconPlayEl = document.getElementById('icon-play')!;
const btnReplayEl = document.getElementById('btn-replay')!;

const GPS_START_ID = 'gps-live';
const PREV_CLASS_START_ID = 'prev-class';

// Campus bounding box + ~450m margin for on-campus GPS validation
const CAMPUS_GPS_BOUNDS = {
  south: 42.306,
  north: 42.323,
  west: -71.054,
  east: -71.028,
};

// App state (in-memory only; never stored in localStorage or sent over network)
let projector: LocalProjector | null = null;
let graph: CampusFootwayGraph | null = null;
const majorBuildingsMap = new Map<string, BuildingRecord>();
let classes: ClassItem[] = [];
let selectedClassId: string | null = null;
let selectedBuildingId: string | null = null;
let startPointId = START_POINTS[0].id;
let routeMode: RouteMode = 'outdoor';
let gpsLonLat: LonLat | null = null;

const scene = new CampusScene(viewportEl, labelLayerEl, {
  onSelectBuilding(buildingId) {
    // Route directly to clicked building label on the 3D map
    selectedClassId = null;
    selectedBuildingId = buildingId;
    renderClassList();
    routeToBuilding(buildingId);
  },
  onProgress(progress, isWalking) {
    routeProgressBarEl.style.width = `${Math.round(progress * 100)}%`;
    iconPauseEl.classList.toggle('is-hidden', !isWalking);
    iconPlayEl.classList.toggle('is-hidden', isWalking);
  },
});

function getMappedClasses(): ClassItem[] {
  return classes.filter((c) => Boolean(c.buildingId));
}

function populateStartPoints(): void {
  startSelectEl.innerHTML = '';

  const entrancesGroup = document.createElement('optgroup');
  entrancesGroup.label = 'Campus Entrances';
  for (const sp of START_POINTS) {
    const opt = document.createElement('option');
    opt.value = sp.id;
    opt.textContent = sp.name;
    entrancesGroup.appendChild(opt);
  }
  const gpsOpt = document.createElement('option');
  gpsOpt.value = GPS_START_ID;
  gpsOpt.textContent = gpsLonLat ? 'My Location (GPS active)' : 'My Location (GPS)';
  entrancesGroup.appendChild(gpsOpt);
  startSelectEl.appendChild(entrancesGroup);

  const mapped = getMappedClasses();
  if (mapped.length >= 2) {
    const chainGroup = document.createElement('optgroup');
    chainGroup.label = 'Class-to-Class';

    const autoOpt = document.createElement('option');
    autoOpt.value = PREV_CLASS_START_ID;
    autoOpt.textContent = 'Previous class (auto-chain)';
    chainGroup.appendChild(autoOpt);

    for (const item of mapped) {
      const opt = document.createElement('option');
      opt.value = `class:${item.id}`;
      const def = MAJOR_BUILDINGS.find((b) => b.id === item.buildingId);
      opt.textContent = `${item.title.slice(0, 22)} (${def?.shortCode ?? item.buildingName})`;
      chainGroup.appendChild(opt);
    }
    startSelectEl.appendChild(chainGroup);
  }

  const hasCurrent = [...startSelectEl.options].some((o) => o.value === startPointId);
  if (!hasCurrent) {
    startPointId = START_POINTS[0].id;
  }
  startSelectEl.value = startPointId;
  btnGpsEl.classList.toggle('is-active', startPointId === GPS_START_ID && Boolean(gpsLonLat));
  btnChainNextEl.classList.toggle('is-hidden', mapped.length < 2);
}

function showError(msg: string): void {
  errorBannerEl.textContent = msg;
  errorBannerEl.classList.remove('is-hidden');
}

function clearError(): void {
  errorBannerEl.textContent = '';
  errorBannerEl.classList.add('is-hidden');
}

function setCameraMode(mode: CameraMode): void {
  btnCamChaseEl.classList.toggle('is-active', mode === 'chase');
  btnCamTopEl.classList.toggle('is-active', mode === 'topdown');
  scene.setCameraMode(mode);
}

function setRouteMode(mode: RouteMode): void {
  routeMode = mode;
  btnRouteOutdoorEl.classList.toggle('is-active', mode === 'outdoor');
  btnRouteCatwalkEl.classList.toggle('is-active', mode === 'catwalk');
  btnRouteCatwalkEl.classList.toggle('is-catwalk', mode === 'catwalk');
  recomputeActiveRoute();
}

function resolveStartPoint(destBuildingId: string): { point: Point2D; shortLabel: string } | null {
  if (!projector) return null;

  if (startPointId === GPS_START_ID && gpsLonLat) {
    return {
      point: projector.project(gpsLonLat.lon, gpsLonLat.lat),
      shortLabel: 'My GPS',
    };
  }

  if (startPointId === PREV_CLASS_START_ID && selectedClassId) {
    const mapped = getMappedClasses();
    const curIdx = mapped.findIndex((c) => c.id === selectedClassId);
    if (curIdx > 0) {
      const prev = mapped[curIdx - 1];
      const prevB = prev.buildingId ? majorBuildingsMap.get(prev.buildingId) : null;
      if (prevB && prevB.id !== destBuildingId) {
        return { point: prevB.centroid, shortLabel: prevB.shortCode || prevB.name };
      }
    }
  }

  if (startPointId.startsWith('class:')) {
    const classId = startPointId.slice('class:'.length);
    const item = classes.find((c) => c.id === classId);
    const b = item?.buildingId ? majorBuildingsMap.get(item.buildingId) : null;
    if (b) {
      return { point: b.centroid, shortLabel: b.shortCode || b.name };
    }
  }

  const sp = START_POINTS.find((s) => s.id === startPointId) ?? START_POINTS[0];
  return {
    point: projector.project(sp.lonLat.lon, sp.lonLat.lat),
    shortLabel: sp.shortLabel,
  };
}

function requestLiveGps(): void {
  clearError();
  if (!('geolocation' in navigator)) {
    showError('GPS geolocation is not supported in this browser.');
    startPointId = START_POINTS[0].id;
    populateStartPoints();
    return;
  }

  statusLineEl.textContent = 'Locating on-device via GPS…';
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude, longitude } = pos.coords;
      const onCampus =
        latitude >= CAMPUS_GPS_BOUNDS.south &&
        latitude <= CAMPUS_GPS_BOUNDS.north &&
        longitude >= CAMPUS_GPS_BOUNDS.west &&
        longitude <= CAMPUS_GPS_BOUNDS.east;

      if (!onCampus) {
        gpsLonLat = null;
        scene.setUserLocation(null);
        startPointId = START_POINTS[0].id;
        populateStartPoints();
        statusLineEl.textContent = '100% on-device · schedules never leave your device';
        recomputeActiveRoute();
        showError(
          'Your GPS position is outside UMass Boston (Columbia Point). Using Campus Entrance instead.'
        );
        return;
      }

      gpsLonLat = { lon: longitude, lat: latitude };
      startPointId = GPS_START_ID;
      if (projector) {
        scene.setUserLocation(projector.project(longitude, latitude));
      }
      populateStartPoints();
      statusLineEl.textContent = 'Live GPS active · 100% on-device';
      recomputeActiveRoute();
    },
    (err) => {
      gpsLonLat = null;
      scene.setUserLocation(null);
      startPointId = START_POINTS[0].id;
      populateStartPoints();
      statusLineEl.textContent = '100% on-device · schedules never leave your device';
      showError(`GPS unavailable (${err.message}). Using Campus Entrance instead.`);
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
  );
}

function routeToBuilding(buildingId: string, customLabel?: string): void {
  if (!graph || !projector) return;
  const building = majorBuildingsMap.get(buildingId);
  if (!building) return;

  const origin = resolveStartPoint(buildingId);
  if (!origin) return;

  const res = graph.findRouteToBuilding(origin.point, building, routeMode);
  if (!res) {
    showError(`Could not compute a footway route to ${building.name}.`);
    return;
  }

  clearError();
  scene.setRoute(res.points, building.id);

  routeDestNameEl.textContent = customLabel ?? building.name;
  routeEtaEl.textContent = `${walkMinutes(res.distanceMeters)} min walk`;
  routeDistEl.textContent = `${Math.round(res.distanceMeters)} m`;
  routeOriginLabelEl.textContent = `from ${origin.shortLabel}`;
  routeCatwalkPillEl.classList.toggle('is-hidden', !res.usesCatwalks);
  routeHudEl.classList.remove('is-hidden');
  renderNextClass();
}

/** Refreshes the "Next class" card: soonest upcoming meeting and when to leave for it. */
function renderNextClass(): void {
  const now = new Date();
  const next = findNextClass(classes, now);
  const building = next?.item.buildingId ? majorBuildingsMap.get(next.item.buildingId) : null;
  const origin = building ? resolveStartPoint(building.id) : null;
  const route = building && origin && graph ? graph.findRouteToBuilding(origin.point, building, routeMode) : null;
  if (!next || !building || !origin || !route) {
    nextCardEl.classList.add('is-hidden');
    return;
  }
  const walk = walkMinutes(route.distanceMeters);
  const where = next.item.room ? `${building.shortCode} ${next.item.room}` : building.name;
  nextLeaveEl.textContent = leaveAdvice(next.startsAt, walk, now);
  // "CS 240 — Programming in C" → "CS 240" so the walk time fits on a phone
  const course = next.item.title.split(/\s+[—–-]\s+/)[0];
  nextDetailEl.textContent = `${course} · ${formatClock(next.startsAt, now)} · ${where} · ${walk} min walk`;
  nextCardEl.title = `${next.item.title} — ${walk} min walk from ${origin.shortLabel}`;
  nextCardEl.dataset.classId = next.item.id;
  nextCardEl.classList.remove('is-hidden');
}

function recomputeActiveRoute(): void {
  if (selectedClassId) {
    const item = classes.find((c) => c.id === selectedClassId);
    if (item) {
      selectClass(item);
      return;
    }
  }
  if (selectedBuildingId) {
    routeToBuilding(selectedBuildingId);
  }
}

function selectClass(item: ClassItem): void {
  if (!item.buildingId) return;
  selectedClassId = item.id;
  selectedBuildingId = item.buildingId;
  renderClassList();
  const label = item.room
    ? `${item.buildingName} · ${item.room}`
    : item.buildingName ?? item.title;
  routeToBuilding(item.buildingId, label);
}

function stepToNextClass(): void {
  const mapped = getMappedClasses();
  if (mapped.length < 2) return;
  const curIdx = mapped.findIndex((c) => c.id === selectedClassId);
  const nextIdx = curIdx >= 0 ? (curIdx + 1) % mapped.length : 0;

  if (nextIdx > 0) {
    startPointId = PREV_CLASS_START_ID;
    populateStartPoints();
  } else if (startPointId === PREV_CLASS_START_ID) {
    startPointId = START_POINTS[0].id;
    populateStartPoints();
  }
  selectClass(mapped[nextIdx]);
}

function renderClassList(): void {
  if (classes.length === 0) {
    intakeViewEl.classList.remove('is-hidden');
    scheduleViewEl.classList.add('is-hidden');
    scene.invalidateLayout();
    return;
  }

  intakeViewEl.classList.add('is-hidden');
  scheduleViewEl.classList.remove('is-hidden');
  scene.invalidateLayout();

  const matchedCount = classes.filter((c) => c.buildingId).length;
  scheduleCountEl.textContent = `${matchedCount}/${classes.length} mapped`;

  classListEl.innerHTML = '';
  for (const item of classes) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'class-card';
    if (item.id === selectedClassId) btn.classList.add('is-selected');
    if (!item.buildingId) btn.classList.add('is-unmatched');

    const buildingDef = MAJOR_BUILDINGS.find((b) => b.id === item.buildingId);
    const badgeText = buildingDef
      ? item.room
        ? `${buildingDef.shortCode} ${item.room}`
        : buildingDef.shortCode
      : 'Unmapped';

    const metaParts = [item.daysLabel, item.timeLabel, item.buildingName ?? item.rawLocation].filter(
      Boolean
    );

    btn.innerHTML = `
      <div class="class-info">
        <div class="class-title"></div>
        <div class="class-meta"></div>
      </div>
      <span class="class-badge"></span>
    `;
    btn.querySelector('.class-title')!.textContent = item.title;
    btn.querySelector('.class-meta')!.textContent = metaParts.join(' · ');
    btn.querySelector('.class-badge')!.textContent = badgeText;

    if (item.buildingId) {
      btn.addEventListener('click', () => selectClass(item));
    }
    classListEl.appendChild(btn);
  }
}

function applyParsedClasses(parsed: ClassItem[], sourceLabel: string): void {
  clearError();
  if (parsed.length === 0) {
    showError(
      'No classes detected. Include a UMB building name or code like M-01-0408, ISC 2-2003, UHall, W-02-0041, or Healey Library.'
    );
    return;
  }

  classes = parsed;
  pasteBoxEl.classList.add('is-hidden');
  statusLineEl.textContent = `${sourceLabel} · parsed locally`;
  populateStartPoints();
  renderClassList();

  const firstMatched = findNextClass(classes, new Date())?.item ?? classes.find((c) => c.buildingId);
  if (firstMatched) {
    selectClass(firstMatched);
  } else {
    showError('Schedule loaded, but no UMass Boston buildings matched.');
  }
}

async function handleFile(file: File): Promise<void> {
  clearError();
  const lower = file.name.toLowerCase();
  try {
    const { parseIcsSchedule, parsePdfSchedule, parseTextSchedule } = await loadScheduleParser();
    if (lower.endsWith('.ics') || file.type === 'text/calendar') {
      const text = await file.text();
      applyParsedClasses(parseIcsSchedule(text), file.name);
    } else if (lower.endsWith('.pdf') || file.type === 'application/pdf') {
      statusLineEl.textContent = 'Reading PDF locally…';
      const parsed = await parsePdfSchedule(file);
      applyParsedClasses(parsed, file.name);
    } else {
      const text = await file.text();
      applyParsedClasses(parseTextSchedule(text), file.name);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unable to read schedule file.';
    showError(`Parse error: ${msg}`);
  }
}

async function loadDemoSchedule(): Promise<void> {
  clearError();
  try {
    const [res, { parseIcsSchedule }] = await Promise.all([
      fetch('./data/demo-schedule.ics'),
      loadScheduleParser(),
    ]);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const icsText = await res.text();
    const parsed = parseIcsSchedule(icsText);
    applyParsedClasses(parsed, 'Demo schedule');
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to load demo schedule.';
    showError(msg);
  }
}

async function loadCampusData(): Promise<void> {
  const res = await fetch('./data/umb-campus.geojson');
  if (!res.ok) throw new Error(`Failed to load campus map (HTTP ${res.status})`);
  const data = (await res.json()) as CampusGeoJSON;

  projector = new LocalProjector(data.metadata.origin);
  const buildings: BuildingRecord[] = [];
  const roofParts: RoofPartRecord[] = [];
  const paths: { points: Point2D[]; highway: string; covered?: boolean }[] = [];
  const roads: RoadRecord[] = [];
  const surfaces: SurfaceRecord[] = [];
  const coastlines: Point2D[][] = [];
  const doors: EntranceRecord[] = [];

  for (const feat of data.features) {
    if (feat.properties.kind === 'building') {
      const majorDef = matchOsmMajorBuilding(feat.properties.name);
      const rawPolys: number[][][][] =
        feat.geometry.type === 'Polygon'
          ? [feat.geometry.coordinates]
          : feat.geometry.type === 'MultiPolygon'
            ? feat.geometry.coordinates
            : [];

      const polygons = rawPolys.map((poly) => poly.map((ring) => projector!.projectRing(ring)));
      if (polygons.length === 0 || polygons[0].length === 0) continue;

      const centroid = polygonCentroid(polygons[0][0]);
      const record: BuildingRecord = {
        id: majorDef ? majorDef.id : feat.properties.osmId,
        osmId: feat.properties.osmId,
        name: majorDef ? majorDef.canonicalName : feat.properties.name ?? 'Building',
        shortCode: majorDef ? majorDef.shortCode : '',
        isMajor: Boolean(majorDef),
        height: feat.properties.height,
        levels: feat.properties.levels,
        centroid,
        polygons,
      };
      buildings.push(record);
      if (majorDef) {
        majorBuildingsMap.set(majorDef.id, record);
      }
    } else if (feat.properties.kind === 'roofPart' && feat.geometry.type === 'Polygon') {
      const ring = projector.projectRing(feat.geometry.coordinates[0] ?? []);
      if (ring.length >= 3) {
        roofParts.push({
          id: feat.properties.osmId,
          parentName: feat.properties.parentName,
          baseHeight: feat.properties.baseHeight,
          height: feat.properties.height,
          ring,
        });
      }
    } else if (feat.properties.kind === 'path' && feat.geometry.type === 'LineString') {
      const pts = projector.projectRing(feat.geometry.coordinates);
      if (pts.length >= 2) {
        paths.push({
          points: pts,
          highway: feat.properties.highway,
          covered: feat.properties.covered,
        });
      }
    } else if (feat.properties.kind === 'road' && feat.geometry.type === 'LineString') {
      const pts = projector.projectRing(feat.geometry.coordinates);
      if (pts.length >= 2) {
        roads.push({ highway: feat.properties.highway, points: pts });
      }
    } else if (feat.properties.kind === 'surface' && feat.geometry.type === 'Polygon') {
      const ring = projector.projectRing(feat.geometry.coordinates[0] ?? []);
      if (ring.length >= 3) {
        surfaces.push({
          surfaceType: feat.properties.surfaceType,
          sport: feat.properties.sport,
          ring,
        });
      }
    } else if (feat.properties.kind === 'entrance' && feat.geometry.type === 'Point') {
      const [lon, lat] = feat.geometry.coordinates;
      doors.push({
        ...projector.project(lon, lat),
        main: feat.properties.entrance === 'main',
        wheelchair: feat.properties.wheelchair === 'yes',
      });
    } else if (feat.properties.kind === 'coastline' && feat.geometry.type === 'LineString') {
      const pts = projector.projectRing(feat.geometry.coordinates);
      if (pts.length >= 2) {
        coastlines.push(pts);
      }
    }
  }

  assignEntrances(buildings, doors);
  graph = new CampusFootwayGraph(paths, buildings);
  scene.loadCampus({ buildings, roofParts, paths, roads, surfaces, coastlines });

  const params = new URLSearchParams(window.location.search);
  if (params.get('evalView') === '1') {
    document.querySelector('.hud-top')?.classList.add('is-hidden');
    panelEl.classList.add('is-hidden');
    routeHudEl.classList.add('is-hidden');
    labelLayerEl.classList.add('is-hidden');
    document.querySelector('.osm-credit')?.classList.add('is-hidden');
  }
  const evalCam = params.get('evalCam');
  if (evalCam) {
    const nums = evalCam.split(',').map(Number);
    if (nums.length >= 6 && nums.every(Number.isFinite)) {
      scene.setFixedCamera(
        [nums[0], nums[1], nums[2]],
        [nums[3], nums[4], nums[5]],
        nums.length >= 7 ? nums[6] : undefined
      );
    }
  }
}

// Event bindings
populateStartPoints();

btnDemoEl.addEventListener('click', () => void loadDemoSchedule());

const onFileChange = (ev: Event) => {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file) void handleFile(file);
  input.value = '';
};
fileInputEl.addEventListener('change', onFileChange);
fileInputInlineEl.addEventListener('change', onFileChange);

const openPasteBox = () => {
  pasteBoxEl.classList.remove('is-hidden');
  pasteInputEl.focus();
};
btnTogglePasteEl.addEventListener('click', openPasteBox);
btnPasteInlineEl.addEventListener('click', openPasteBox);
btnCancelPasteEl.addEventListener('click', () => pasteBoxEl.classList.add('is-hidden'));

btnParsePasteEl.addEventListener('click', () => {
  void loadScheduleParser()
    .then(({ parseTextSchedule }) => {
      applyParsedClasses(parseTextSchedule(pasteInputEl.value), 'Pasted schedule');
    })
    .catch((err) => {
      const msg = err instanceof Error ? err.message : 'Unable to load schedule parser.';
      showError(`Parse error: ${msg}`);
    });
});

nextCardEl.addEventListener('click', () => {
  const item = classes.find((c) => c.id === nextCardEl.dataset.classId);
  if (item) selectClass(item);
});
// Keep the "leave in" countdown current while the app is open
setInterval(() => {
  if (classes.length > 0 && !document.hidden) renderNextClass();
}, 30_000);

btnClearEl.addEventListener('click', () => {
  nextCardEl.classList.add('is-hidden');
  classes = [];
  selectedClassId = null;
  selectedBuildingId = null;
  pasteInputEl.value = '';
  pasteBoxEl.classList.add('is-hidden');
  routeHudEl.classList.add('is-hidden');
  statusLineEl.textContent = '100% on-device · schedules never leave your device';
  clearError();
  scene.setRoute([], null);
  scene.frameOverview();
  populateStartPoints();
  renderClassList();
});

startSelectEl.addEventListener('change', () => {
  startPointId = startSelectEl.value;
  if (startPointId === GPS_START_ID) {
    if (!gpsLonLat) {
      requestLiveGps();
      return;
    }
  } else {
    btnGpsEl.classList.remove('is-active');
  }
  recomputeActiveRoute();
});

btnGpsEl.addEventListener('click', () => requestLiveGps());
btnRouteOutdoorEl.addEventListener('click', () => setRouteMode('outdoor'));
btnRouteCatwalkEl.addEventListener('click', () => setRouteMode('catwalk'));
btnChainNextEl.addEventListener('click', () => stepToNextClass());

btnCamChaseEl.addEventListener('click', () => setCameraMode('chase'));
btnCamTopEl.addEventListener('click', () => setCameraMode('topdown'));
btnRecenterEl.addEventListener('click', () => scene.recenter());
btnPlayPauseEl.addEventListener('click', () => scene.toggleWalk());
btnReplayEl.addEventListener('click', () => scene.replayWalk());

const toggleSheet = () => {
  const collapsed = panelEl.classList.toggle('is-collapsed');
  const expanded = String(!collapsed);
  collapseBtnEl.textContent = collapsed ? 'Classes' : 'Map';
  collapseBtnEl.setAttribute('aria-expanded', expanded);
  sheetToggleEl.setAttribute('aria-expanded', expanded);
  scene.invalidateLayout();
};
sheetToggleEl.addEventListener('click', toggleSheet);
collapseBtnEl.addEventListener('click', toggleSheet);

// Prompt user to refresh if a stale tab requests a pre-deploy lazy chunk
window.addEventListener('vite:preloadError', (ev) => {
  ev.preventDefault();
  showError('App was updated — please reload the page to load your schedule.');
});

// Drag-and-drop file support
window.addEventListener('dragover', (e) => {
  e.preventDefault();
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const file = e.dataTransfer?.files?.[0];
  if (file) void handleFile(file);
});

// Boot campus map + register PWA service worker
void loadCampusData().catch((err) => {
  const msg = err instanceof Error ? err.message : 'Unable to initialize 3D map.';
  showError(msg);
});

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('./sw.js').catch(() => {
      // Service worker registration is non-fatal
    });
  });
}
