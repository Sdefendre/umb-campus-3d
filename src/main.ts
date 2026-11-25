import './style.css';
import { MAJOR_BUILDINGS, START_POINTS, matchOsmMajorBuilding } from './buildings';
import { LocalProjector, polygonCentroid } from './geo';
import { CampusFootwayGraph } from './graph';
import { CampusScene } from './scene';
import type { BuildingRecord, CameraMode, CampusGeoJSON, ClassItem, Point2D } from './types';

let scheduleModPromise: Promise<typeof import('./schedule')> | null = null;
function loadScheduleParser(): Promise<typeof import('./schedule')> {
  if (!scheduleModPromise) scheduleModPromise = import('./schedule');
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

const intakeViewEl = document.getElementById('intake-view')!;
const scheduleViewEl = document.getElementById('schedule-view')!;
const classListEl = document.getElementById('class-list')!;
const scheduleCountEl = document.getElementById('schedule-count')!;
const errorBannerEl = document.getElementById('error-banner')!;

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
const routeProgressBarEl = document.getElementById('route-progress-bar')!;
const btnPlayPauseEl = document.getElementById('btn-play-pause')!;
const iconPauseEl = document.getElementById('icon-pause')!;
const iconPlayEl = document.getElementById('icon-play')!;
const btnReplayEl = document.getElementById('btn-replay')!;

// App state (in-memory only; never stored in localStorage or sent over network)
let projector: LocalProjector | null = null;
let graph: CampusFootwayGraph | null = null;
const majorBuildingsMap = new Map<string, BuildingRecord>();
let classes: ClassItem[] = [];
let selectedClassId: string | null = null;
let selectedBuildingId: string | null = null;
let startPointId = START_POINTS[0].id;

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

function populateStartPoints(): void {
  startSelectEl.innerHTML = '';
  for (const sp of START_POINTS) {
    const opt = document.createElement('option');
    opt.value = sp.id;
    opt.textContent = sp.name;
    startSelectEl.appendChild(opt);
  }
  startSelectEl.value = startPointId;
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

function routeToBuilding(buildingId: string, customLabel?: string): void {
  if (!graph || !projector) return;
  const building = majorBuildingsMap.get(buildingId);
  const sp = START_POINTS.find((s) => s.id === startPointId) ?? START_POINTS[0];
  if (!building) return;

  const startPt = projector.project(sp.lonLat.lon, sp.lonLat.lat);
  const res = graph.findRoute(startPt, building.centroid);
  if (!res) {
    showError(`Could not compute a footway route to ${building.name}.`);
    return;
  }

  clearError();
  scene.setRoute(res.points, building.id);

  // Average walking speed ~1.35 m/s (~81 m/min)
  const walkMinutes = Math.max(1, Math.round(res.distanceMeters / 81));
  routeDestNameEl.textContent = customLabel ?? building.name;
  routeEtaEl.textContent = `${walkMinutes} min walk`;
  routeDistEl.textContent = `${Math.round(res.distanceMeters)} m`;
  routeOriginLabelEl.textContent = `from ${sp.shortLabel}`;
  routeHudEl.classList.remove('is-hidden');
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

function renderClassList(): void {
  if (classes.length === 0) {
    intakeViewEl.classList.remove('is-hidden');
    scheduleViewEl.classList.add('is-hidden');
    return;
  }

  intakeViewEl.classList.add('is-hidden');
  scheduleViewEl.classList.remove('is-hidden');

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
  renderClassList();

  const firstMatched = classes.find((c) => c.buildingId);
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
  const paths: { points: Point2D[]; highway: string; covered?: boolean }[] = [];

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
        centroid,
        polygons,
      };
      buildings.push(record);
      if (majorDef) {
        majorBuildingsMap.set(majorDef.id, record);
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
    }
  }

  graph = new CampusFootwayGraph(paths, buildings);
  scene.loadCampus(buildings, paths);

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
  void loadScheduleParser().then(({ parseTextSchedule }) => {
    applyParsedClasses(parseTextSchedule(pasteInputEl.value), 'Pasted schedule');
  });
});

btnClearEl.addEventListener('click', () => {
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
  renderClassList();
});

startSelectEl.addEventListener('change', () => {
  startPointId = startSelectEl.value;
  if (selectedClassId) {
    const item = classes.find((c) => c.id === selectedClassId);
    if (item) selectClass(item);
  } else if (selectedBuildingId) {
    routeToBuilding(selectedBuildingId);
  }
});

btnCamChaseEl.addEventListener('click', () => setCameraMode('chase'));
btnCamTopEl.addEventListener('click', () => setCameraMode('topdown'));
btnRecenterEl.addEventListener('click', () => scene.recenter());
btnPlayPauseEl.addEventListener('click', () => scene.toggleWalk());
btnReplayEl.addEventListener('click', () => scene.replayWalk());

const toggleSheet = () => {
  const collapsed = panelEl.classList.toggle('is-collapsed');
  collapseBtnEl.textContent = collapsed ? 'Classes' : 'Map';
};
sheetToggleEl.addEventListener('click', toggleSheet);
collapseBtnEl.addEventListener('click', toggleSheet);

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
