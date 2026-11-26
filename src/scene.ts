import * as THREE from 'three';
import { CampusControls } from './controls';
import { dist2D, pointInBuildingPolygons } from './geo';
import type { BuildingRecord, CameraMode, Point2D, RoutePoint } from './types';

interface BuildingVisual {
  record: BuildingRecord;
  mesh: THREE.Mesh;
  edges: THREE.LineSegments;
  material: THREE.MeshStandardMaterial;
  edgeMaterial: THREE.LineBasicMaterial;
  labelEl: HTMLButtonElement | null;
}

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

  private setupGround(): void {
    // Deep matte ground plane
    const groundGeo = new THREE.PlaneGeometry(3600, 3600);
    const groundMat = new THREE.MeshStandardMaterial({
      color: 0x070b13,
      roughness: 0.95,
      metalness: 0.08,
    });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.05;
    this.scene.add(ground);

    // Dual-scale FSD grid: fine 25m grid + accent 100m grid
    const fineGrid = new THREE.GridHelper(2000, 80, 0x16243a, 0x0e1726);
    fineGrid.position.y = 0.01;
    (fineGrid.material as THREE.Material).transparent = true;
    (fineGrid.material as THREE.Material).opacity = 0.55;
    this.scene.add(fineGrid);

    const macroGrid = new THREE.GridHelper(2000, 20, 0x1f3659, 0x1a2c47);
    macroGrid.position.y = 0.03;
    (macroGrid.material as THREE.Material).transparent = true;
    (macroGrid.material as THREE.Material).opacity = 0.5;
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
   * Populates the 3D scene with extruded OSM buildings, footways, and Dorchester Bay coastline.
   */
  loadCampus(
    buildings: BuildingRecord[],
    paths: { points: Point2D[]; highway: string }[],
    coastlines: Point2D[][] = []
  ): void {
    // 0. Render Dorchester Bay / Columbia Point shoreline
    if (coastlines.length > 0) {
      const coastCorePts: number[] = [];
      for (const chain of coastlines) {
        if (chain.length < 2) continue;
        for (let i = 1; i < chain.length; i++) {
          const a = chain[i - 1];
          const b = chain[i];
          coastCorePts.push(a.x, 0.14, a.z, b.x, 0.14, b.z);
        }
        const vecs = chain.map((p) => new THREE.Vector3(p.x, 0.12, p.z));
        if (vecs.length >= 2) {
          const coastCurve = new THREE.CatmullRomCurve3(vecs, false, 'centripetal', 0.2);
          const segs = Math.min(320, Math.max(24, vecs.length * 2));
          const ribbon = new THREE.Mesh(
            new THREE.TubeGeometry(coastCurve, segs, 3.2, 4, false),
            new THREE.MeshBasicMaterial({
              color: 0x0d5c8a,
              transparent: true,
              opacity: 0.26,
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
              color: 0x32a8d9,
              transparent: true,
              opacity: 0.78,
            })
          )
        );
      }

      const bayMat = new THREE.MeshBasicMaterial({
        color: 0x051428,
        transparent: true,
        opacity: 0.45,
        depthWrite: false,
      });
      const bayNorthEast = new THREE.Mesh(new THREE.PlaneGeometry(1800, 2400), bayMat);
      bayNorthEast.rotation.x = -Math.PI / 2;
      bayNorthEast.position.set(1180, -0.02, -40);
      this.scene.add(bayNorthEast);

      const bayNorth = new THREE.Mesh(new THREE.PlaneGeometry(2400, 1200), bayMat);
      bayNorth.rotation.x = -Math.PI / 2;
      bayNorth.position.set(160, -0.02, -960);
      this.scene.add(bayNorth);
    }

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
        target.push(a.x, 0.09, a.z, b.x, 0.09, b.z);
      }
    }

    if (roadPositions.length > 0) {
      const roadGeo = new THREE.BufferGeometry();
      roadGeo.setAttribute('position', new THREE.Float32BufferAttribute(roadPositions, 3));
      const roadLines = new THREE.LineSegments(
        roadGeo,
        new THREE.LineBasicMaterial({
          color: 0x1e2c42,
          transparent: true,
          opacity: 0.42,
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
          color: 0x2f4b73,
          transparent: true,
          opacity: 0.52,
        })
      );
      this.scene.add(footLines);
    }

    // 2. Extrude OSM buildings
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

      const geo = new THREE.ExtrudeGeometry(shapes, {
        depth: b.height,
        bevelEnabled: false,
      });
      geo.rotateX(-Math.PI / 2);

      const mat = new THREE.MeshStandardMaterial({
        color: b.isMajor ? 0x1a2d4c : 0x0f1828,
        emissive: b.isMajor ? 0x0c1f3d : 0x040812,
        emissiveIntensity: b.isMajor ? 0.72 : 0.32,
        roughness: b.isMajor ? 0.62 : 0.84,
        metalness: b.isMajor ? 0.28 : 0.12,
      });

      const mesh = new THREE.Mesh(geo, mat);
      this.scene.add(mesh);

      const edgesGeo = new THREE.EdgesGeometry(geo, 22);
      const edgeMat = new THREE.LineBasicMaterial({
        color: b.isMajor ? 0x5cc0ff : 0x294061,
        transparent: true,
        opacity: b.isMajor ? 0.85 : 0.45,
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
        material: mat,
        edgeMaterial: edgeMat,
        labelEl,
      });
    }

    this.frameOverview();
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
      if (vis.record.isMajor) {
        const active = id === buildingId;
        vis.material.color.setHex(active ? 0x1c4678 : 0x1a2d4c);
        vis.material.emissive.setHex(active ? 0x1050a3 : 0x0c1f3d);
        vis.material.emissiveIntensity = active ? 1.05 : 0.72;
        vis.edgeMaterial.color.setHex(active ? 0x76ecff : isXray ? 0x52ffe6 : 0x5cc0ff);
        vis.edgeMaterial.opacity = active || isXray ? 1.0 : 0.85;
        if (vis.labelEl) {
          vis.labelEl.classList.toggle('is-active', active);
        }
      }
      vis.material.transparent = isXray;
      vis.material.opacity = isXray ? 0.3 : 1.0;
      vis.material.depthWrite = !isXray;
      vis.material.needsUpdate = true;
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
