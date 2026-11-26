import * as THREE from 'three';
import { CampusControls } from './controls';
import { dist2D, pointInBuildingPolygons } from './geo';
import { createArchitecturalTextures, type ArchitecturalTextures } from './textures';
import type {
  BuildingRecord,
  CameraMode,
  Point2D,
  RoadRecord,
  RoofPartRecord,
  RoutePoint,
  SurfaceRecord,
} from './types';

interface BuildingVisual {
  record: BuildingRecord;
  mesh: THREE.Mesh;
  edges: THREE.LineSegments;
  materials: THREE.MeshStandardMaterial[];
  edgeMaterial: THREE.LineBasicMaterial;
  labelEl: HTMLButtonElement | null;
}

export interface CampusLoadPayload {
  buildings: BuildingRecord[];
  roofParts?: RoofPartRecord[];
  paths: { points: Point2D[]; highway: string }[];
  roads?: RoadRecord[];
  surfaces?: SurfaceRecord[];
  coastlines?: Point2D[][];
}

const GLASS_BUILDING_NAMES = new Set([
  'Integrated Sciences Complex',
  'University Hall',
  'Campus Center',
  'West Garage',
  'John F. Kennedy Presidential Library and Museum',
]);

const MASONRY_BUILDING_NAMES = new Set([
  'Healey Library',
  'McCormack Hall',
  'Wheatley Hall',
  'Quinn Administration Building',
  'Clark Athletic Center',
  'West Residence Hall',
  'East Residence Hall',
  'Massachusetts Archives',
  'Calf Pasture Pumping Station',
]);

interface RouteSample {
  point: Point2D;
  y: number;
  heading: number;
  cumDist: number;
}

export interface SceneCallbacks {
  onSelectBuilding?: (buildingId: string) => void;
  onProgress?: (progress: number, isWalking: boolean) => void;
}

export class CampusScene {
  private readonly container: HTMLElement;
  private readonly labelLayer: HTMLElement;
  private readonly callbacks: SceneCallbacks;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: CampusControls;

  private readonly buildings = new Map<string, BuildingVisual>();
  private readonly routeGroup = new THREE.Group();
  private readonly pulseNodes: { mesh: THREE.Mesh; offset: number }[] = [];
  private readonly avatarGroup = new THREE.Group();
  private readonly avatarLimbs: {
    leftLeg: THREE.Object3D;
    rightLeg: THREE.Object3D;
    leftArm: THREE.Object3D;
    rightArm: THREE.Object3D;
    halo: THREE.Mesh;
  };
  private readonly destBeacon = new THREE.Group();
  private destBeaconRings: THREE.Mesh[] = [];
  private readonly userMarker = new THREE.Group();
  private userMarkerPulse: THREE.Mesh | null = null;
  private xrayBuildingIds = new Set<string>();
  private textures: ArchitecturalTextures | null = null;

  private routeSamples: RouteSample[] = [];
  private routeTotalDist = 0;
  private routeCurve: THREE.CatmullRomCurve3 | null = null;
  private walkDist = 0;
  private isWalking = false;
  private walkSpeedMps = 22; // Accelerated preview walk speed (m/s)
  private activeBuildingId: string | null = null;
  private cameraMode: CameraMode = 'chase';
  private userOverrideCamera = false;

  private lastTime = 0;
  private elapsed = 0;
  private cachedSafeBottom: number | null = null;
  private readonly tmpVec = new THREE.Vector3();
  private readonly desiredCamPos = new THREE.Vector3();
  private readonly desiredTarget = new THREE.Vector3();

  constructor(container: HTMLElement, labelLayer: HTMLElement, callbacks: SceneCallbacks = {}) {
    this.container = container;
    this.labelLayer = labelLayer;
    this.callbacks = callbacks;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x060910);
    this.scene.fog = new THREE.FogExp2(0x060910, 0.00046);

    const width = container.clientWidth || window.innerWidth;
    const height = container.clientHeight || window.innerHeight;

    this.camera = new THREE.PerspectiveCamera(48, width / height, 1, 2400);
    this.camera.position.set(-220, 195, 270);

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(width, height);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    container.appendChild(this.renderer.domElement);

    this.controls = new CampusControls(this.camera, this.renderer.domElement, () => {
      if (this.cameraMode === 'chase' && this.routeSamples.length > 0) {
        this.userOverrideCamera = true;
      }
    });
    this.controls.maxPolarAngle = Math.PI * 0.465;
    this.controls.minDistance = 24;
    this.controls.maxDistance = 950;
    this.controls.target.set(0, 8, 10);

    this.setupLighting();
    this.setupSkyDome();
    this.setupGround();
    this.scene.add(this.routeGroup);

    this.avatarLimbs = this.buildAvatar();
    this.avatarGroup.visible = false;
    this.scene.add(this.avatarGroup);

    this.setupDestinationBeacon();
    this.scene.add(this.destBeacon);

    this.setupUserMarker();
    this.scene.add(this.userMarker);

    window.addEventListener('resize', this.handleResize);
    this.lastTime = performance.now();
    this.animate(this.lastTime);
  }

  private setupLighting(): void {
    const hemi = new THREE.HemisphereLight(0x9fc8ff, 0x0e182b, 1.05);
    this.scene.add(hemi);

    const key = new THREE.DirectionalLight(0xbadbff, 1.35);
    key.position.set(180, 320, 140);
    this.scene.add(key);

    const rim = new THREE.DirectionalLight(0x3a8bff, 0.9);
    rim.position.set(-240, 160, -180);
    this.scene.add(rim);
  }

  private setupSkyDome(): void {
    // Subtle vertical midnight-to-deep-cobalt horizon sky gradient
    const skyGeo = new THREE.SphereGeometry(1950, 24, 16);
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        topColor: { value: new THREE.Color(0x04070f) },
        horizonColor: { value: new THREE.Color(0x0e213d) },
        bottomColor: { value: new THREE.Color(0x050b16) },
      },
      vertexShader: `
        varying vec3 vWorldPos;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorldPos = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: `
        uniform vec3 topColor;
        uniform vec3 horizonColor;
        uniform vec3 bottomColor;
        varying vec3 vWorldPos;
        void main() {
          float h = normalize(vWorldPos).y;
          vec3 col = h >= 0.0
            ? mix(horizonColor, topColor, pow(clamp(h * 1.45, 0.0, 1.0), 0.72))
            : mix(horizonColor, bottomColor, clamp(-h * 3.0, 0.0, 1.0));
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    });
    this.scene.add(new THREE.Mesh(skyGeo, skyMat));
  }

  private setupGround(): void {
    // Dorchester Bay & Savin Hill Cove water surface spanning the entire harbor
    const waterGeo = new THREE.PlaneGeometry(4200, 4200);
    const waterMat = new THREE.MeshStandardMaterial({
      color: 0x051529,
      emissive: 0x030c18,
      emissiveIntensity: 0.55,
      roughness: 0.28,
      metalness: 0.55,
    });
    const water = new THREE.Mesh(waterGeo, waterMat);
    water.rotation.x = -Math.PI / 2;
    water.position.y = -0.38;
    this.scene.add(water);

    // Dual-scale FSD tactical grid resting lightly above the campus terrain
    const fineGrid = new THREE.GridHelper(1800, 72, 0x15243b, 0x0d1726);
    fineGrid.position.y = 0.03;
    (fineGrid.material as THREE.Material).transparent = true;
    (fineGrid.material as THREE.Material).opacity = 0.34;
    this.scene.add(fineGrid);

    const macroGrid = new THREE.GridHelper(1800, 18, 0x1e3557, 0x162944);
    macroGrid.position.y = 0.04;
    (macroGrid.material as THREE.Material).transparent = true;
    (macroGrid.material as THREE.Material).opacity = 0.32;
    this.scene.add(macroGrid);
  }

  private buildAvatar() {
    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0xe6f2ff,
      emissive: 0x133866,
      emissiveIntensity: 0.45,
      roughness: 0.35,
      metalness: 0.25,
    });
    const limbMat = new THREE.MeshStandardMaterial({
      color: 0x99c4f7,
      emissive: 0x0e2a4d,
      emissiveIntensity: 0.4,
      roughness: 0.4,
    });
    const accentMat = new THREE.MeshBasicMaterial({ color: 0x5ce1ff });

    // Ground telemetry ring around avatar (FSD pedestrian halo)
    const haloGeo = new THREE.RingGeometry(1.75, 2.35, 32);
    const haloMat = new THREE.MeshBasicMaterial({
      color: 0x38b6ff,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const halo = new THREE.Mesh(haloGeo, haloMat);
    halo.rotation.x = -Math.PI / 2;
    halo.position.y = 0.22;
    this.avatarGroup.add(halo);

    // Subtle soft disc beneath avatar
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(1.75, 24),
      new THREE.MeshBasicMaterial({
        color: 0x1f7eff,
        transparent: true,
        opacity: 0.22,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = 0.2;
    this.avatarGroup.add(disc);

    // Low-poly stylized humanoid figure (~4.2m stylized scale for clear campus legibility)
    const figure = new THREE.Group();

    const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.65, 0.48, 1.55, 6), bodyMat);
    torso.position.y = 2.35;
    figure.add(torso);

    const collar = new THREE.Mesh(new THREE.TorusGeometry(0.55, 0.1, 6, 12), accentMat);
    collar.rotation.x = Math.PI / 2;
    collar.position.y = 3.05;
    figure.add(collar);

    const head = new THREE.Mesh(new THREE.OctahedronGeometry(0.56, 1), bodyMat);
    head.position.y = 3.68;
    figure.add(head);

    // Forward-facing cyan visor (+Z is forward in avatar local space)
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.76, 0.22, 0.35), accentMat);
    visor.position.set(0, 3.72, 0.36);
    figure.add(visor);

    // Articulated legs
    const makeLimb = (x: number, y: number, len: number, r: number) => {
      const pivot = new THREE.Group();
      pivot.position.set(x, y, 0);
      const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(r, len - r * 2, 4, 6), limbMat);
      mesh.position.y = -len / 2;
      pivot.add(mesh);
      figure.add(pivot);
      return pivot;
    };

    const leftLeg = makeLimb(-0.3, 1.6, 1.55, 0.22);
    const rightLeg = makeLimb(0.3, 1.6, 1.55, 0.22);
    const leftArm = makeLimb(-0.85, 2.95, 1.35, 0.17);
    const rightArm = makeLimb(0.85, 2.95, 1.35, 0.17);

    this.avatarGroup.add(figure);
    return { leftLeg, rightLeg, leftArm, rightArm, halo };
  }

  private setupDestinationBeacon(): void {
    this.destBeacon.visible = false;
    this.destBeaconRings = [];

    for (let i = 0; i < 2; i++) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(4.5, 5.8, 40),
        new THREE.MeshBasicMaterial({
          color: 0x4cc9ff,
          transparent: true,
          opacity: 0.7,
          side: THREE.DoubleSide,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        })
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.25;
      this.destBeacon.add(ring);
      this.destBeaconRings.push(ring);
    }

    // Subtle vertical beacon beam
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.45, 2.4, 58, 12, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0x2699ff,
        transparent: true,
        opacity: 0.14,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    beam.position.y = 29;
    this.destBeacon.add(beam);
  }

  private setupUserMarker(): void {
    this.userMarker.visible = false;
    const dot = new THREE.Mesh(
      new THREE.CircleGeometry(2.2, 24),
      new THREE.MeshBasicMaterial({
        color: 0x38f2d8,
        side: THREE.DoubleSide,
      })
    );
    dot.rotation.x = -Math.PI / 2;
    dot.position.y = 0.28;
    this.userMarker.add(dot);

    const pulse = new THREE.Mesh(
      new THREE.RingGeometry(2.6, 3.8, 32),
      new THREE.MeshBasicMaterial({
        color: 0x38f2d8,
        transparent: true,
        opacity: 0.75,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    pulse.rotation.x = -Math.PI / 2;
    pulse.position.y = 0.26;
    this.userMarker.add(pulse);
    this.userMarkerPulse = pulse;
  }

  setUserLocation(pt: Point2D | null): void {
    if (!pt) {
      this.userMarker.visible = false;
      return;
    }
    this.userMarker.position.set(pt.x, 0, pt.z);
    this.userMarker.visible = true;
  }

  /**
   * Populates the 3D scene with Columbia Point peninsula landmass, Dorchester Bay shoreline,
   * campus lawns/fields/roads/trees, extruded buildings with procedural architectural facades,
   * and BPDA LoD2 roof tiers.
   */
  loadCampus(payload: CampusLoadPayload): void {
    const {
      buildings,
      roofParts = [],
      paths,
      roads = [],
      surfaces = [],
      coastlines = [],
    } = payload;

    this.textures = createArchitecturalTextures();

    // 0. Columbia Point peninsula landmass & glowing Harborwalk shoreline
    if (coastlines.length > 0) {
      // Longest coastline chain traces the Columbia Point peninsula around Dorchester Bay
      const sortedCoast = [...coastlines].sort((a, b) => b.length - a.length);
      const mainChain = sortedCoast[0];
      if (mainChain.length >= 6) {
        const landShape = new THREE.Shape();
        landShape.moveTo(mainChain[0].x, -mainChain[0].z);
        for (let i = 1; i < mainChain.length; i++) {
          landShape.lineTo(mainChain[i].x, -mainChain[i].z);
        }
        // Close peninsula inland to the west (Dorchester / Morrissey Blvd side)
        const last = mainChain[mainChain.length - 1];
        const first = mainChain[0];
        landShape.lineTo(-1650, -last.z);
        landShape.lineTo(-1650, -first.z);
        landShape.closePath();

        const landGeo = new THREE.ExtrudeGeometry(landShape, {
          depth: 0.39,
          bevelEnabled: false,
        });
        landGeo.rotateX(-Math.PI / 2);
        landGeo.translate(0, -0.38, 0);
        const landMesh = new THREE.Mesh(
          landGeo,
          new THREE.MeshStandardMaterial({
            color: 0x090f1a,
            roughness: 0.92,
            metalness: 0.08,
          })
        );
        this.scene.add(landMesh);
      }

      // Luminous Harborwalk shoreline contour along all coastline segments
      const coastCorePts: number[] = [];
      for (const chain of coastlines) {
        if (chain.length < 2) continue;
        for (let i = 1; i < chain.length; i++) {
          const a = chain[i - 1];
          const b = chain[i];
          coastCorePts.push(a.x, 0.14, a.z, b.x, 0.14, b.z);
        }
        const vecs = chain.map((p) => new THREE.Vector3(p.x, 0.08, p.z));
        if (vecs.length >= 2) {
          const coastCurve = new THREE.CatmullRomCurve3(vecs, false, 'centripetal', 0.2);
          const segs = Math.min(320, Math.max(24, vecs.length * 2));
          const ribbon = new THREE.Mesh(
            new THREE.TubeGeometry(coastCurve, segs, 3.0, 4, false),
            new THREE.MeshBasicMaterial({
              color: 0x0f6d9e,
              transparent: true,
              opacity: 0.3,
              blending: THREE.AdditiveBlending,
              depthWrite: false,
            })
          );
          ribbon.scale.y = 0.08;
          this.scene.add(ribbon);
        }
      }
      if (coastCorePts.length > 0) {
        const coastGeo = new THREE.BufferGeometry();
        coastGeo.setAttribute('position', new THREE.Float32BufferAttribute(coastCorePts, 3));
        this.scene.add(
          new THREE.LineSegments(
            coastGeo,
            new THREE.LineBasicMaterial({
              color: 0x3db5e6,
              transparent: true,
              opacity: 0.82,
            })
          )
        );
      }
    } else {
      // Fallback solid ground if coastline absent
      const fallback = new THREE.Mesh(
        new THREE.PlaneGeometry(3600, 3600),
        new THREE.MeshStandardMaterial({ color: 0x090f1a, roughness: 0.95 })
      );
      fallback.rotation.x = -Math.PI / 2;
      fallback.position.y = -0.02;
      this.scene.add(fallback);
    }

    // 0b. Merged campus terrain surfaces (1 draw call each: lawns, athletic fields, parking lots)
    this.buildTerrainSurfaces(surfaces);

    // 0c. Merged paved campus road corridors (1 draw call + faint center markings)
    this.buildRoadNetwork(roads);

    // 1. Render subtle OSM footway network on ground (FSD lane-line aesthetic)
    const footPositions: number[] = [];
    const roadPositions: number[] = [];

    for (const p of paths) {
      const isFoot =
        p.highway === 'footway' ||
        p.highway === 'path' ||
        p.highway === 'pedestrian' ||
        p.highway === 'steps' ||
        p.highway === 'cycleway';
      const target = isFoot ? footPositions : roadPositions;
      for (let i = 1; i < p.points.length; i++) {
        const a = p.points[i - 1];
        const b = p.points[i];
        target.push(a.x, 0.12, a.z, b.x, 0.12, b.z);
      }
    }

    if (roadPositions.length > 0) {
      const roadGeo = new THREE.BufferGeometry();
      roadGeo.setAttribute('position', new THREE.Float32BufferAttribute(roadPositions, 3));
      const roadLines = new THREE.LineSegments(
        roadGeo,
        new THREE.LineBasicMaterial({
          color: 0x22344f,
          transparent: true,
          opacity: 0.45,
        })
      );
      this.scene.add(roadLines);
    }

    if (footPositions.length > 0) {
      const footGeo = new THREE.BufferGeometry();
      footGeo.setAttribute('position', new THREE.Float32BufferAttribute(footPositions, 3));
      const footLines = new THREE.LineSegments(
        footGeo,
        new THREE.LineBasicMaterial({
          color: 0x355885,
          transparent: true,
          opacity: 0.56,
        })
      );
      this.scene.add(footLines);
    }

    // 2. Extrude OSM buildings with world-scale procedural architectural facades
    const tex = this.textures;
    const majorCentroids = buildings.filter((mb) => mb.isMajor).map((mb) => mb.centroid);
    for (const b of buildings) {
      const shapes: THREE.Shape[] = [];
      for (const poly of b.polygons) {
        if (poly.length === 0 || poly[0].length < 3) continue;
        const shape = new THREE.Shape();
        const outer = poly[0];
        // Map world (x, z) into shape (x, -z) so rotating X by -PI/2 restores exact (x, y=height, z)
        shape.moveTo(outer[0].x, -outer[0].z);
        for (let i = 1; i < outer.length; i++) {
          shape.lineTo(outer[i].x, -outer[i].z);
        }
        shape.closePath();

        for (let h = 1; h < poly.length; h++) {
          const holeRing = poly[h];
          if (holeRing.length < 3) continue;
          const hole = new THREE.Path();
          hole.moveTo(holeRing[0].x, -holeRing[0].z);
          for (let i = 1; i < holeRing.length; i++) {
            hole.lineTo(holeRing[i].x, -holeRing[i].z);
          }
          hole.closePath();
          shape.holes.push(hole);
        }
        shapes.push(shape);
      }

      if (shapes.length === 0) continue;

      // Render multi-building campus podium decks (e.g. UMB 2-level plaza podium enclosing
      // Quinn/Healey/McCormack/Wheatley) at their true low-rise podium height so the major
      // buildings rise crisply above them instead of being buried inside a taller box.
      const enclosesMajor =
        !b.isMajor && majorCentroids.some((mc) => pointInBuildingPolygons(mc, b.polygons));
      const renderHeight = enclosesMajor
        ? Math.min(b.height, (b.levels && b.levels <= 3 ? b.levels : 2) * 3.4)
        : b.height;

      const geo = new THREE.ExtrudeGeometry(shapes, {
        depth: renderHeight,
        bevelEnabled: false,
      });
      geo.rotateX(-Math.PI / 2);

      const isGlass = GLASS_BUILDING_NAMES.has(b.name);
      const isMasonry = MASONRY_BUILDING_NAMES.has(b.name);
      const facadeMap = isGlass
        ? tex.glassFacade
        : isMasonry
          ? tex.masonryFacade
          : tex.secondaryFacade;

      const roofMat = new THREE.MeshStandardMaterial({
        color: b.isMajor ? 0xc8e4ff : 0x7a96b8,
        map: tex.roofCap,
        emissive: b.isMajor ? 0x0e2447 : 0x050c1a,
        emissiveIntensity: b.isMajor ? 0.65 : 0.28,
        roughness: 0.72,
        metalness: 0.22,
      });

      const facadeMat = new THREE.MeshStandardMaterial({
        color: b.isMajor ? 0xffffff : isMasonry || isGlass ? 0xd0e4fa : 0xaec4de,
        map: facadeMap,
        emissive: b.isMajor ? 0x102d54 : 0x061020,
        emissiveIntensity: b.isMajor ? 0.58 : 0.28,
        roughness: isGlass ? 0.3 : 0.62,
        metalness: isGlass ? 0.44 : 0.18,
      });

      const mesh = new THREE.Mesh(geo, [roofMat, facadeMat]);
      this.scene.add(mesh);

      const edgesGeo = new THREE.EdgesGeometry(geo, 22);
      const edgeMat = new THREE.LineBasicMaterial({
        color: b.isMajor ? 0x5cc0ff : 0x2b4569,
        transparent: true,
        opacity: b.isMajor ? 0.85 : 0.44,
      });
      const edges = new THREE.LineSegments(edgesGeo, edgeMat);
      this.scene.add(edges);

      let labelEl: HTMLButtonElement | null = null;
      if (b.isMajor) {
        labelEl = document.createElement('button');
        labelEl.type = 'button';
        labelEl.className = 'building-label';
        labelEl.innerHTML = `<span class="label-code">${b.shortCode}</span><span class="label-name">${b.name}</span>`;
        labelEl.addEventListener('click', () => {
          this.callbacks.onSelectBuilding?.(b.id);
        });
        this.labelLayer.appendChild(labelEl);
      }

      this.buildings.set(b.id, {
        record: b,
        mesh,
        edges,
        materials: [roofMat, facadeMat],
        edgeMaterial: edgeMat,
        labelEl,
      });
    }

    // 2b. BPDA LoD2 stepped roof tiers & penthouses + landmark signatures
    this.buildRoofParts(roofParts, tex);
    this.buildLandmarkDetails(buildings);

    // 2c. Instanced stylized trees along campus lawns & waterfront park (clear of paths)
    this.buildInstancedTrees(surfaces, buildings, paths);

    this.frameOverview();
  }

  private buildTerrainSurfaces(surfaces: SurfaceRecord[]): void {
    const byType: Record<'green' | 'pitch' | 'parking', THREE.Shape[]> = {
      green: [],
      pitch: [],
      parking: [],
    };
    const pitchOutlinePts: number[] = [];

    for (const s of surfaces) {
      if (s.ring.length < 3) continue;
      const shape = new THREE.Shape();
      shape.moveTo(s.ring[0].x, -s.ring[0].z);
      for (let i = 1; i < s.ring.length; i++) {
        shape.lineTo(s.ring[i].x, -s.ring[i].z);
      }
      shape.closePath();
      byType[s.surfaceType].push(shape);

      if (s.surfaceType === 'pitch') {
        for (let i = 1; i < s.ring.length; i++) {
          const a = s.ring[i - 1];
          const b = s.ring[i];
          pitchOutlinePts.push(a.x, 0.09, a.z, b.x, 0.09, b.z);
        }
      }
    }

    const addLayer = (
      shapes: THREE.Shape[],
      y: number,
      color: number,
      opacity: number
    ): void => {
      if (shapes.length === 0) return;
      const geo = new THREE.ShapeGeometry(shapes);
      geo.rotateX(-Math.PI / 2);
      const mesh = new THREE.Mesh(
        geo,
        new THREE.MeshStandardMaterial({
          color,
          roughness: 0.94,
          metalness: 0.05,
          transparent: opacity < 1,
          opacity,
        })
      );
      mesh.position.y = y;
      this.scene.add(mesh);
    };

    addLayer(byType.green, 0.05, 0x0c1e22, 0.92);
    addLayer(byType.parking, 0.06, 0x101826, 0.95);
    addLayer(byType.pitch, 0.075, 0x0f2a30, 0.96);

    if (pitchOutlinePts.length > 0) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pitchOutlinePts, 3));
      this.scene.add(
        new THREE.LineSegments(
          geo,
          new THREE.LineBasicMaterial({ color: 0x357c94, transparent: true, opacity: 0.72 })
        )
      );
    }
  }

  private buildRoadNetwork(roads: RoadRecord[]): void {
    if (roads.length === 0) return;
    const positions: number[] = [];
    const centerLinePts: number[] = [];

    for (const road of roads) {
      const halfW =
        road.highway === 'primary'
          ? 5.2
          : road.highway === 'secondary' || road.highway === 'tertiary'
            ? 4.0
            : 3.1;
      for (let i = 1; i < road.points.length; i++) {
        const a = road.points[i - 1];
        const b = road.points[i];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const len = Math.hypot(dx, dz);
        if (len < 0.2) continue;
        const nx = (-dz / len) * halfW;
        const nz = (dx / len) * halfW;

        const aLx = a.x + nx;
        const aLz = a.z + nz;
        const aRx = a.x - nx;
        const aRz = a.z - nz;
        const bLx = b.x + nx;
        const bLz = b.z + nz;
        const bRx = b.x - nx;
        const bRz = b.z - nz;

        // Two triangles per road segment (counter-clockwise facing +Y)
        positions.push(
          aLx, 0.08, aLz, bLx, 0.08, bLz, bRx, 0.08, bRz,
          aLx, 0.08, aLz, bRx, 0.08, bRz, aRx, 0.08, aRz
        );
        centerLinePts.push(a.x, 0.105, a.z, b.x, 0.105, b.z);
      }
    }

    if (positions.length > 0) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geo.computeVertexNormals();
      this.scene.add(
        new THREE.Mesh(
          geo,
          new THREE.MeshStandardMaterial({
            color: 0x111a29,
            roughness: 0.88,
            metalness: 0.1,
          })
        )
      );
    }

    if (centerLinePts.length > 0) {
      const cGeo = new THREE.BufferGeometry();
      cGeo.setAttribute('position', new THREE.Float32BufferAttribute(centerLinePts, 3));
      this.scene.add(
        new THREE.LineSegments(
          cGeo,
          new THREE.LineBasicMaterial({ color: 0x264266, transparent: true, opacity: 0.55 })
        )
      );
    }
  }

  private buildRoofParts(roofParts: RoofPartRecord[], tex: ArchitecturalTextures): void {
    for (const part of roofParts) {
      const depth = part.height - part.baseHeight;
      if (depth <= 0.5 || part.ring.length < 3) continue;
      const shape = new THREE.Shape();
      shape.moveTo(part.ring[0].x, -part.ring[0].z);
      for (let i = 1; i < part.ring.length; i++) {
        shape.lineTo(part.ring[i].x, -part.ring[i].z);
      }
      shape.closePath();

      const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
      geo.rotateX(-Math.PI / 2);
      geo.translate(0, part.baseHeight, 0);

      const isGlass = part.parentName ? GLASS_BUILDING_NAMES.has(part.parentName) : false;
      const matRoof = new THREE.MeshStandardMaterial({
        color: 0xaecbe8,
        map: tex.roofCap,
        emissive: 0x0b1f3d,
        emissiveIntensity: 0.48,
        roughness: 0.72,
        metalness: 0.24,
      });
      const matSide = new THREE.MeshStandardMaterial({
        color: 0xe6f2ff,
        map: isGlass ? tex.glassFacade : tex.masonryFacade,
        emissive: 0x0c2445,
        emissiveIntensity: 0.45,
        roughness: isGlass ? 0.32 : 0.64,
        metalness: isGlass ? 0.42 : 0.2,
      });
      this.scene.add(new THREE.Mesh(geo, [matRoof, matSide]));
      this.scene.add(
        new THREE.LineSegments(
          new THREE.EdgesGeometry(geo, 22),
          new THREE.LineBasicMaterial({ color: 0x4ca6eb, transparent: true, opacity: 0.65 })
        )
      );
    }
  }

  private buildLandmarkDetails(buildings: BuildingRecord[]): void {
    // 1. Healey Library iconic rooftop observatory dome + penthouse collar
    const healey = buildings.find((b) => b.id === 'healey');
    if (healey) {
      const base = new THREE.Mesh(
        new THREE.CylinderGeometry(3.4, 3.8, 2.2, 16),
        new THREE.MeshStandardMaterial({ color: 0x1c304f, roughness: 0.65, metalness: 0.25 })
      );
      base.position.set(healey.centroid.x + 8, healey.height + 1.1, healey.centroid.z - 10);
      this.scene.add(base);

      const dome = new THREE.Mesh(
        new THREE.SphereGeometry(3.2, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.55),
        new THREE.MeshStandardMaterial({
          color: 0x5c8ab8,
          emissive: 0x123257,
          emissiveIntensity: 0.45,
          roughness: 0.35,
          metalness: 0.45,
        })
      );
      dome.position.set(healey.centroid.x + 8, healey.height + 2.1, healey.centroid.z - 10);
      this.scene.add(dome);
    }

    // 2. Integrated Sciences Complex central faceted glass atrium silhouette
    const isc = buildings.find((b) => b.id === 'isc');
    if (isc) {
      const atriumX = isc.centroid.x - 16;
      const atriumY = isc.height * 0.78;
      const atriumZ = isc.centroid.z + 6;
      const atrium = new THREE.Mesh(
        new THREE.ConeGeometry(8.5, 8.5, 4),
        new THREE.MeshStandardMaterial({
          color: 0x4db5e0,
          emissive: 0x134e70,
          emissiveIntensity: 0.55,
          roughness: 0.2,
          metalness: 0.55,
          transparent: true,
          opacity: 0.76,
        })
      );
      atrium.rotation.y = Math.PI * 0.25;
      atrium.position.set(atriumX, atriumY, atriumZ);
      this.scene.add(atrium);
      const atriumEdges = new THREE.LineSegments(
        new THREE.EdgesGeometry(atrium.geometry),
        new THREE.LineBasicMaterial({ color: 0x76ecff, transparent: true, opacity: 0.8 })
      );
      atriumEdges.rotation.y = Math.PI * 0.25;
      atriumEdges.position.set(atriumX, atriumY, atriumZ);
      this.scene.add(atriumEdges);
    }
  }

  private buildInstancedTrees(
    surfaces: SurfaceRecord[],
    buildings: BuildingRecord[],
    paths: { points: Point2D[]; highway: string }[]
  ): void {
    const candidates: Point2D[] = [];
    const minSpacing = 26;

    const isInsideBuilding = (pt: Point2D): boolean => {
      for (const b of buildings) {
        if (dist2D(pt, b.centroid) > 130) continue;
        if (pointInBuildingPolygons(pt, b.polygons)) return true;
      }
      return false;
    };

    const isNearPath = (pt: Point2D): boolean => {
      for (const p of paths) {
        for (const node of p.points) {
          if (Math.abs(pt.x - node.x) < 8 && Math.abs(pt.z - node.z) < 8) {
            if (dist2D(pt, node) < 7.5) return true;
          }
        }
      }
      return false;
    };

    for (const s of surfaces) {
      if (s.surfaceType !== 'green') continue;
      for (let i = 0; i < s.ring.length; i += 2) {
        const pt = s.ring[i];
        if (candidates.length >= 125) break;
        if (Math.abs(pt.x) > 760 || Math.abs(pt.z) > 650) continue;
        if (isInsideBuilding(pt) || isNearPath(pt)) continue;
        let tooClose = false;
        for (const existing of candidates) {
          if (dist2D(pt, existing) < minSpacing) {
            tooClose = true;
            break;
          }
        }
        if (!tooClose) candidates.push(pt);
      }
    }

    if (candidates.length === 0) return;

    const trunkGeo = new THREE.CylinderGeometry(0.24, 0.36, 2.2, 5);
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x1d2633, roughness: 0.92 });
    const crownGeo = new THREE.DodecahedronGeometry(2.3, 0);
    const crownMat = new THREE.MeshStandardMaterial({
      color: 0x184247,
      emissive: 0x071e24,
      emissiveIntensity: 0.45,
      roughness: 0.82,
      metalness: 0.08,
    });

    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, candidates.length);
    const crowns = new THREE.InstancedMesh(crownGeo, crownMat, candidates.length);
    const dummy = new THREE.Object3D();

    candidates.forEach((pt, idx) => {
      const scale = 0.72 + ((idx * 37) % 10) * 0.038;
      dummy.position.set(pt.x, 1.1 * scale, pt.z);
      dummy.scale.set(scale, scale, scale);
      dummy.rotation.set(0, idx * 1.1, 0);
      dummy.updateMatrix();
      trunks.setMatrixAt(idx, dummy.matrix);

      dummy.position.set(pt.x, 3.7 * scale, pt.z);
      dummy.scale.set(scale, scale * 1.12, scale);
      dummy.updateMatrix();
      crowns.setMatrixAt(idx, dummy.matrix);
    });

    trunks.instanceMatrix.needsUpdate = true;
    crowns.instanceMatrix.needsUpdate = true;
    this.scene.add(trunks);
    this.scene.add(crowns);
  }

  frameOverview(): void {
    this.userOverrideCamera = false;
    const isNarrow = this.container.clientWidth < 900;
    this.controls.target.set(isNarrow ? -35 : 10, 8, isNarrow ? 55 : 25);
    this.camera.position.set(isNarrow ? -265 : -225, isNarrow ? 260 : 200, isNarrow ? 345 : 290);
    this.controls.update();
  }

  /**
   * Positions the camera at a fixed viewpoint for deterministic screenshot / eval capture.
   */
  setFixedCamera(
    pos: [number, number, number],
    target: [number, number, number],
    fov?: number
  ): void {
    this.userOverrideCamera = true;
    if (typeof fov === 'number' && Number.isFinite(fov) && fov > 5 && fov < 120) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
    this.camera.position.set(pos[0], pos[1], pos[2]);
    this.controls.target.set(target[0], target[1], target[2]);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * Draws a glowing FSD blue route tube (elevating sheltered indoor catwalks to 2nd-floor
   * height with X-ray building transparency) and starts the walking avatar.
   */
  setRoute(points: RoutePoint[], destinationBuildingId: string | null): void {
    // Clear existing route geometry
    while (this.routeGroup.children.length > 0) {
      const child = this.routeGroup.children.pop()!;
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        if (Array.isArray(child.material)) child.material.forEach((m) => m.dispose());
        else child.material.dispose();
      }
    }
    this.pulseNodes.length = 0;

    // Identify buildings traversed by indoor/catwalk segments for X-ray visibility
    const traversedBuildings = new Set<string>();
    for (const pt of points) {
      if (!pt.indoor) continue;
      for (const [id, vis] of this.buildings) {
        if (pointInBuildingPolygons(pt, vis.record.polygons)) {
          traversedBuildings.add(id);
        }
      }
    }
    this.xrayBuildingIds = traversedBuildings;

    // Update destination building highlight & X-ray transparency
    this.setActiveBuilding(destinationBuildingId);

    if (points.length < 2) {
      this.routeSamples = [];
      this.routeTotalDist = 0;
      this.routeCurve = null;
      this.avatarGroup.visible = false;
      this.destBeacon.visible = false;
      this.isWalking = false;
      return;
    }

    // Deduplicate near-identical consecutive points for smooth Catmull-Rom curve
    const cleanPts: RoutePoint[] = [points[0]];
    for (let i = 1; i < points.length; i++) {
      if (dist2D(cleanPts[cleanPts.length - 1], points[i]) > 0.6) {
        cleanPts.push(points[i]);
      }
    }
    if (cleanPts.length < 2) cleanPts.push(points[points.length - 1]);

    const hasIndoor = cleanPts.some((p) => p.indoor);
    const vec3Pts = cleanPts.map((p) => new THREE.Vector3(p.x, p.indoor ? 4.4 : 0.52, p.z));
    const curve = new THREE.CatmullRomCurve3(vec3Pts, false, 'centripetal', 0.25);
    this.routeCurve = curve;

    const tubularSegments = Math.min(480, Math.max(48, cleanPts.length * 6));
    const coreColor = hasIndoor ? 0x52ffe6 : 0x70e4ff;
    const glowColor = hasIndoor ? 0x10bfa8 : 0x1a8cff;

    // 1. Bright core tube (cyan-blue outdoor / luminous teal when traversing catwalks)
    const coreMesh = new THREE.Mesh(
      new THREE.TubeGeometry(curve, tubularSegments, 0.55, 8, false),
      new THREE.MeshBasicMaterial({ color: coreColor })
    );
    this.routeGroup.add(coreMesh);

    // 2. Outer additive glow sheath
    const glowMesh = new THREE.Mesh(
      new THREE.TubeGeometry(curve, tubularSegments, 1.45, 8, false),
      new THREE.MeshBasicMaterial({
        color: glowColor,
        transparent: true,
        opacity: 0.34,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    this.routeGroup.add(glowMesh);

    // 3. Soft ground reflection ribbon under route
    const groundVecs = cleanPts.map((p) => new THREE.Vector3(p.x, 0.14, p.z));
    const groundCurve = new THREE.CatmullRomCurve3(groundVecs, false, 'centripetal', 0.25);
    const washMesh = new THREE.Mesh(
      new THREE.TubeGeometry(groundCurve, tubularSegments, 2.7, 6, false),
      new THREE.MeshBasicMaterial({
        color: glowColor,
        transparent: true,
        opacity: 0.16,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    washMesh.scale.y = 0.06;
    this.routeGroup.add(washMesh);

    // 4. Start point beacon
    const startDisc = new THREE.Mesh(
      new THREE.RingGeometry(1.8, 3.0, 28),
      new THREE.MeshBasicMaterial({
        color: coreColor,
        transparent: true,
        opacity: 0.85,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    startDisc.rotation.x = -Math.PI / 2;
    startDisc.position.set(cleanPts[0].x, cleanPts[0].indoor ? 4.2 : 0.2, cleanPts[0].z);
    this.routeGroup.add(startDisc);

    // 5. Flowing light pulses along the route
    const pulseCount = Math.min(18, Math.max(5, Math.floor(curve.getLength() / 35)));
    for (let i = 0; i < pulseCount; i++) {
      const pulse = new THREE.Mesh(
        new THREE.SphereGeometry(0.95, 10, 10),
        new THREE.MeshBasicMaterial({
          color: hasIndoor ? 0xc8fff6 : 0xc2f5ff,
          transparent: true,
          opacity: 0.9,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        })
      );
      this.routeGroup.add(pulse);
      this.pulseNodes.push({ mesh: pulse, offset: i / pulseCount });
    }

    // Sample uniformly along curve for smooth avatar walking
    const sampleCount = Math.max(40, Math.round(curve.getLength() / 1.5));
    const sampledVecs = curve.getSpacedPoints(sampleCount);
    const samples: RouteSample[] = [];
    let cumDist = 0;
    for (let i = 0; i < sampledVecs.length; i++) {
      const cur = sampledVecs[i];
      if (i > 0) {
        cumDist += Math.hypot(cur.x - sampledVecs[i - 1].x, cur.z - sampledVecs[i - 1].z);
      }
      const next = sampledVecs[Math.min(i + 1, sampledVecs.length - 1)];
      const prev = sampledVecs[Math.max(i - 1, 0)];
      const heading = Math.atan2(next.x - prev.x, next.z - prev.z);
      samples.push({ point: { x: cur.x, z: cur.z }, y: Math.max(0, cur.y - 0.52), heading, cumDist });
    }

    this.routeSamples = samples;
    this.routeTotalDist = cumDist;
    this.walkDist = 0;
    // Scale preview walk speed so routes finish smoothly in ~14-24 seconds
    this.walkSpeedMps = Math.max(14, Math.min(34, cumDist / 18));
    this.isWalking = true;
    this.userOverrideCamera = false;

    this.avatarGroup.visible = true;
    this.positionAvatarAt(0);

    // Position destination beacon at route end (or destination building entrance)
    const endPt = cleanPts[cleanPts.length - 1];
    this.destBeacon.position.set(endPt.x, 0, endPt.z);
    this.destBeacon.visible = true;

    if (this.cameraMode === 'topdown') {
      this.snapToTopDown();
    } else {
      this.snapToChase();
    }
  }

  private setActiveBuilding(buildingId: string | null): void {
    this.activeBuildingId = buildingId;
    for (const [id, vis] of this.buildings) {
      const isXray = this.xrayBuildingIds.has(id);
      const [roofMat, facadeMat] = vis.materials;
      if (vis.record.isMajor) {
        const active = id === buildingId;
        roofMat.color.setHex(active ? 0x6ad4ff : 0xc8e4ff);
        roofMat.emissive.setHex(active ? 0x1465cc : 0x0e2447);
        roofMat.emissiveIntensity = active ? 1.1 : 0.65;
        facadeMat.color.setHex(active ? 0xd8f3ff : 0xffffff);
        facadeMat.emissive.setHex(active ? 0x1462c9 : 0x102d54);
        facadeMat.emissiveIntensity = active ? 0.95 : 0.58;
        vis.edgeMaterial.color.setHex(active ? 0x76ecff : isXray ? 0x52ffe6 : 0x5cc0ff);
        vis.edgeMaterial.opacity = active || isXray ? 1.0 : 0.85;
        if (vis.labelEl) {
          vis.labelEl.classList.toggle('is-active', active);
        }
      }
      for (const m of vis.materials) {
        m.transparent = isXray;
        m.opacity = isXray ? 0.3 : 1.0;
        m.depthWrite = !isXray;
        m.needsUpdate = true;
      }
    }
  }

  setCameraMode(mode: CameraMode): void {
    this.cameraMode = mode;
    this.userOverrideCamera = false;
    if (mode === 'topdown') {
      this.snapToTopDown();
    } else if (this.routeSamples.length > 0) {
      this.snapToChase();
    } else {
      this.frameOverview();
    }
  }

  recenter(): void {
    this.userOverrideCamera = false;
    if (this.cameraMode === 'topdown') {
      this.snapToTopDown();
    } else if (this.routeSamples.length > 0) {
      this.snapToChase();
    } else {
      this.frameOverview();
    }
  }

  toggleWalk(): boolean {
    if (this.routeSamples.length === 0) return false;
    if (this.walkDist >= this.routeTotalDist - 0.5) {
      this.walkDist = 0;
      this.isWalking = true;
    } else {
      this.isWalking = !this.isWalking;
    }
    this.callbacks.onProgress?.(
      this.routeTotalDist > 0 ? this.walkDist / this.routeTotalDist : 0,
      this.isWalking
    );
    return this.isWalking;
  }

  replayWalk(): void {
    if (this.routeSamples.length === 0) return;
    this.walkDist = 0;
    this.isWalking = true;
    this.userOverrideCamera = false;
    this.positionAvatarAt(0);
    if (this.cameraMode === 'chase') this.snapToChase();
  }

  private getSampleAt(dist: number): RouteSample {
    const samples = this.routeSamples;
    if (samples.length === 0) {
      return { point: { x: 0, z: 0 }, y: 0, heading: 0, cumDist: 0 };
    }
    if (dist <= 0) return samples[0];
    if (dist >= this.routeTotalDist) return samples[samples.length - 1];

    // Binary search
    let lo = 0;
    let hi = samples.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (samples[mid].cumDist <= dist) lo = mid;
      else hi = mid;
    }
    const a = samples[lo];
    const b = samples[hi];
    const span = Math.max(1e-4, b.cumDist - a.cumDist);
    const t = (dist - a.cumDist) / span;

    // Shortest-angle interpolation
    let dAngle = b.heading - a.heading;
    while (dAngle > Math.PI) dAngle -= Math.PI * 2;
    while (dAngle < -Math.PI) dAngle += Math.PI * 2;

    return {
      point: {
        x: a.point.x + (b.point.x - a.point.x) * t,
        z: a.point.z + (b.point.z - a.point.z) * t,
      },
      y: a.y + (b.y - a.y) * t,
      heading: a.heading + dAngle * t,
      cumDist: dist,
    };
  }

  private positionAvatarAt(dist: number): RouteSample {
    const s = this.getSampleAt(dist);
    this.avatarGroup.position.set(s.point.x, s.y, s.point.z);
    this.avatarGroup.rotation.y = s.heading;
    return s;
  }

  private computeChaseCamera(sample: RouteSample): void {
    const sinH = Math.sin(sample.heading);
    const cosH = Math.cos(sample.heading);
    const isNarrow = this.container.clientWidth < 900;
    const behindDist = isNarrow ? 50 : 48;
    const height = isNarrow ? 36 : 30;
    const lookAhead = isNarrow ? 34 : 56;

    this.desiredCamPos.set(
      sample.point.x - sinH * behindDist,
      height,
      sample.point.z - cosH * behindDist
    );
    // Aim slightly downward on portrait mobile so the avatar sits cleanly in the middle window above the bottom sheet
    this.desiredTarget.set(
      sample.point.x + sinH * lookAhead,
      isNarrow ? -10 : 7,
      sample.point.z + cosH * lookAhead
    );
  }

  private snapToChase(): void {
    const sample = this.getSampleAt(this.walkDist);
    this.computeChaseCamera(sample);
    this.camera.position.copy(this.desiredCamPos);
    this.controls.target.copy(this.desiredTarget);
    this.controls.update();
  }

  private snapToTopDown(): void {
    const isDesktop = this.container.clientWidth >= 900;
    if (this.routeSamples.length > 0) {
      let minX = Infinity;
      let maxX = -Infinity;
      let minZ = Infinity;
      let maxZ = -Infinity;
      for (const s of this.routeSamples) {
        if (s.point.x < minX) minX = s.point.x;
        if (s.point.x > maxX) maxX = s.point.x;
        if (s.point.z < minZ) minZ = s.point.z;
        if (s.point.z > maxZ) maxZ = s.point.z;
      }
      // Also include major buildings so all 8 landmarks frame nicely in top-down
      for (const vis of this.buildings.values()) {
        if (!vis.record.isMajor) continue;
        const c = vis.record.centroid;
        if (c.x < minX) minX = c.x;
        if (c.x > maxX) maxX = c.x;
        if (c.z < minZ) minZ = c.z;
        if (c.z > maxZ) maxZ = c.z;
      }
      const span = Math.max(300, Math.hypot(maxX - minX, maxZ - minZ));
      const cx = (minX + maxX) / 2 - (isDesktop ? span * 0.16 : 0);
      const cz = (minZ + maxZ) / 2 + (isDesktop ? 0 : span * 0.12);
      const alt = Math.min(760, Math.max(320, span * 0.92));
      this.controls.target.set(cx, 0, cz);
      this.camera.position.set(cx, alt, cz + alt * 0.22);
    } else {
      this.controls.target.set(0, 0, 10);
      this.camera.position.set(0, 480, 120);
    }
    this.controls.update();
  }

  private animate = (now: number): void => {
    requestAnimationFrame(this.animate);
    const dt = Math.min(0.05, (now - this.lastTime) / 1000);
    this.lastTime = now;
    this.elapsed += dt;

    // 1. Advance walking avatar along route
    if (this.routeSamples.length > 0) {
      if (this.isWalking) {
        this.walkDist += this.walkSpeedMps * dt;
        if (this.walkDist >= this.routeTotalDist) {
          this.walkDist = this.routeTotalDist;
          this.isWalking = false;
        }
        this.callbacks.onProgress?.(
          this.routeTotalDist > 0 ? this.walkDist / this.routeTotalDist : 1,
          this.isWalking
        );
      }

      const sample = this.positionAvatarAt(this.walkDist);

      // Walking gait swing
      const gait = this.isWalking ? Math.sin(this.elapsed * 11.5) * 0.58 : 0;
      this.avatarLimbs.leftLeg.rotation.x = gait;
      this.avatarLimbs.rightLeg.rotation.x = -gait;
      this.avatarLimbs.leftArm.rotation.x = -gait * 0.7;
      this.avatarLimbs.rightArm.rotation.x = gait * 0.7;

      // Pulse avatar halo
      const haloScale = 1 + Math.sin(this.elapsed * 4.5) * 0.08;
      this.avatarLimbs.halo.scale.set(haloScale, haloScale, 1);

      // Chase camera follow (smoothly damped)
      if (this.cameraMode === 'chase' && !this.userOverrideCamera) {
        this.computeChaseCamera(sample);
        const damp = 1 - Math.exp(-3.4 * dt);
        this.camera.position.lerp(this.desiredCamPos, damp);
        this.controls.target.lerp(this.desiredTarget, damp * 1.15);
      }
    }

    // 2. Animate light pulses gliding forward along route
    if (this.routeCurve && this.pulseNodes.length > 0) {
      const speed = 0.14;
      for (const p of this.pulseNodes) {
        const u = (p.offset + this.elapsed * speed) % 1;
        this.routeCurve.getPointAt(u, p.mesh.position);
        p.mesh.position.y += 0.14;
        const s = 0.7 + Math.sin(u * Math.PI) * 0.5;
        p.mesh.scale.setScalar(s);
      }
    }

    // 3. Animate destination beacon rings & GPS user pulse
    if (this.destBeacon.visible) {
      this.destBeaconRings.forEach((ring, idx) => {
        const phase = (this.elapsed * 0.65 + idx * 0.5) % 1;
        const scale = 0.7 + phase * 2.4;
        ring.scale.set(scale, scale, 1);
        (ring.material as THREE.MeshBasicMaterial).opacity = (1 - phase) * 0.72;
      });
    }
    if (this.userMarker.visible && this.userMarkerPulse) {
      const phase = (this.elapsed * 0.8) % 1;
      const scale = 0.8 + phase * 1.9;
      this.userMarkerPulse.scale.set(scale, scale, 1);
      (this.userMarkerPulse.material as THREE.MeshBasicMaterial).opacity = (1 - phase) * 0.8;
    }

    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.updateLabels();
  };

  invalidateLayout(): void {
    this.cachedSafeBottom = null;
  }

  private updateLabels(): void {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    if (width === 0 || height === 0) return;

    const isNarrow = width < 900;
    if (isNarrow && this.cachedSafeBottom === null) {
      const panelEl = document.getElementById('panel');
      this.cachedSafeBottom = panelEl ? panelEl.getBoundingClientRect().top - 12 : height - 24;
    }
    const safeBottom = isNarrow ? (this.cachedSafeBottom ?? height - 24) : height - 24;
    const safeTop = 64;

    for (const vis of this.buildings.values()) {
      const el = vis.labelEl;
      if (!el) continue;

      const { centroid, height: bHeight } = vis.record;
      this.tmpVec.set(centroid.x, bHeight + 5.5, centroid.z);
      const camDist = this.camera.position.distanceTo(this.tmpVec);
      this.tmpVec.project(this.camera);

      const behind = this.tmpVec.z > 1 || this.tmpVec.z < -1;
      const sx = (this.tmpVec.x * 0.5 + 0.5) * width;
      const sy = (-this.tmpVec.y * 0.5 + 0.5) * height;
      const outOfBounds = sx < -80 || sx > width + 80 || sy < safeTop || sy > safeBottom;

      if (behind || outOfBounds) {
        el.style.opacity = '0';
        el.style.pointerEvents = 'none';
        el.style.transform = 'translate3d(-9999px, -9999px, 0)';
        continue;
      }

      const isActive = vis.record.id === this.activeBuildingId;
      const distFade = isActive ? 1 : Math.max(0.42, Math.min(1, 1 - (camDist - 380) / 550));
      el.style.opacity = distFade.toFixed(2);
      el.style.pointerEvents = 'auto';
      el.style.transform = `translate3d(${sx.toFixed(1)}px, ${sy.toFixed(1)}px, 0) translate(-50%, -100%)`;
      el.style.zIndex = isActive ? '20' : String(Math.max(1, Math.round(15 - camDist / 100)));
    }
  }

  private handleResize = (): void => {
    const width = this.container.clientWidth || window.innerWidth;
    const height = this.container.clientHeight || window.innerHeight;
    this.cachedSafeBottom = null;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  };
}
