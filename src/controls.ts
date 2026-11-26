import { PerspectiveCamera, Vector3 } from 'three';

/**
 * Lightweight, mobile-first orbit/pan/pinch-zoom camera controller with OrbitControls-equivalent
 * exponential damping (each frame applies `k` of pending motion and retains `1 - k`, so the
 * geometric sum equals exactly 1.0x of the user's input).
 */
export class CampusControls {
  readonly target = new Vector3();
  private readonly camera: PerspectiveCamera;
  private readonly dom: HTMLElement;
  private readonly onStart?: () => void;

  minDistance = 24;
  maxDistance = 950;
  maxPolarAngle = Math.PI * 0.465;
  dampingFactor = 0.16;
  private readonly minPolarAngle = 0.08;

  private theta = 0;
  private phi = 0.8;
  private radius = 320;
  private dTheta = 0;
  private dPhi = 0;
  private logScale = 0;
  private readonly panOffset = new Vector3();
  private readonly offset = new Vector3();
  private readonly tmpA = new Vector3();
  private readonly tmpB = new Vector3();

  private pointers = new Map<number, { x: number; y: number }>();
  private lastPinchDist = 0;
  private lastMid = { x: 0, y: 0 };
  private isPanning = false;
  private active = false;

  constructor(camera: PerspectiveCamera, dom: HTMLElement, onStart?: () => void) {
    this.camera = camera;
    this.dom = dom;
    this.onStart = onStart;

    dom.addEventListener('pointerdown', this.onPointerDown);
    dom.addEventListener('pointermove', this.onPointerMove);
    dom.addEventListener('pointerup', this.onPointerUp);
    dom.addEventListener('pointercancel', this.onPointerUp);
    dom.addEventListener('wheel', this.onWheel, { passive: false });
    dom.addEventListener('contextmenu', this.onContextMenu);
  }

  get isDamping(): boolean {
    return (
      this.active ||
      Math.abs(this.dTheta) > 1e-4 ||
      Math.abs(this.dPhi) > 1e-4 ||
      Math.abs(this.logScale) > 1e-4 ||
      this.panOffset.lengthSq() > 1e-4
    );
  }

  update(): void {
    this.offset.copy(this.camera.position).sub(this.target);
    this.radius = Math.max(1e-3, this.offset.length());
    this.theta = Math.atan2(this.offset.x, this.offset.z);
    this.phi = Math.acos(Math.max(-1, Math.min(1, this.offset.y / this.radius)));

    const k = this.dampingFactor;
    const rem = 1 - k;

    this.theta += this.dTheta * k;
    this.phi = Math.max(
      this.minPolarAngle,
      Math.min(this.maxPolarAngle, this.phi + this.dPhi * k)
    );
    this.radius = Math.max(
      this.minDistance,
      Math.min(this.maxDistance, this.radius * Math.exp(this.logScale * k))
    );

    this.target.addScaledVector(this.panOffset, k);
    this.target.y = Math.max(-20, Math.min(120, this.target.y));

    const sinPhi = Math.sin(this.phi);
    this.offset.set(
      this.radius * sinPhi * Math.sin(this.theta),
      this.radius * Math.cos(this.phi),
      this.radius * sinPhi * Math.cos(this.theta)
    );
    this.camera.position.copy(this.target).add(this.offset);
    this.camera.lookAt(this.target);

    // Retain the unapplied fraction so total displacement converges to exactly 1.0x input
    this.dTheta *= rem;
    this.dPhi *= rem;
    this.logScale *= rem;
    this.panOffset.multiplyScalar(rem);

    if (Math.abs(this.dTheta) < 1e-6) this.dTheta = 0;
    if (Math.abs(this.dPhi) < 1e-6) this.dPhi = 0;
    if (Math.abs(this.logScale) < 1e-6) this.logScale = 0;
    if (this.panOffset.lengthSq() < 1e-8) this.panOffset.set(0, 0, 0);
  }

  dispose(): void {
    this.dom.removeEventListener('pointerdown', this.onPointerDown);
    this.dom.removeEventListener('pointermove', this.onPointerMove);
    this.dom.removeEventListener('pointerup', this.onPointerUp);
    this.dom.removeEventListener('pointercancel', this.onPointerUp);
    this.dom.removeEventListener('wheel', this.onWheel);
    this.dom.removeEventListener('contextmenu', this.onContextMenu);
    this.pointers.clear();
    this.active = false;
  }

  private pan(dx: number, dy: number): void {
    const h = Math.max(1, this.dom.clientHeight);
    const dist = this.camera.position.distanceTo(this.target);
    const scale = (2 * dist * Math.tan((this.camera.fov * Math.PI) / 360)) / h;

    this.tmpA.setFromMatrixColumn(this.camera.matrix, 0).multiplyScalar(-dx * scale);
    // Horizontal forward vector on ground plane
    this.tmpB.copy(this.camera.position).sub(this.target);
    this.tmpB.y = 0;
    if (this.tmpB.lengthSq() > 1e-6) this.tmpB.normalize().multiplyScalar(-dy * scale);
    this.panOffset.add(this.tmpA).add(this.tmpB);
  }

  private onContextMenu = (e: Event): void => {
    e.preventDefault();
  };

  private onPointerDown = (e: PointerEvent): void => {
    this.dom.setPointerCapture?.(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.active = true;
    this.isPanning = e.button === 2 || e.shiftKey;
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.lastPinchDist = Math.hypot(b.x - a.x, b.y - a.y);
      this.lastMid = { x: (a.x + b.x) * 0.5, y: (a.y + b.y) * 0.5 };
    }
    this.onStart?.();
  };

  private onPointerMove = (e: PointerEvent): void => {
    const prev = this.pointers.get(e.pointerId);
    if (!prev) return;
    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    prev.x = e.clientX;
    prev.y = e.clientY;

    if (this.pointers.size === 1) {
      if (this.isPanning) {
        this.pan(dx, dy);
      } else {
        const h = Math.max(1, this.dom.clientHeight);
        this.dTheta -= (2 * Math.PI * dx) / h;
        this.dPhi -= (2 * Math.PI * dy) / h;
      }
    } else if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const dist = Math.hypot(b.x - a.x, b.y - a.y);
      const mid = { x: (a.x + b.x) * 0.5, y: (a.y + b.y) * 0.5 };
      if (this.lastPinchDist > 1 && dist > 1) {
        this.logScale += Math.log(this.lastPinchDist / dist);
      }
      this.pan(mid.x - this.lastMid.x, mid.y - this.lastMid.y);
      this.lastPinchDist = dist;
      this.lastMid = mid;
    }
  };

  private onPointerUp = (e: PointerEvent): void => {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size === 0) this.active = false;
  };

  private onWheel = (e: WheelEvent): void => {
    if (e.deltaY === 0) return;
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 120 : 1;
    const scaledDy = Math.max(-180, Math.min(180, e.deltaY * unit));
    this.logScale += scaledDy * 0.0012;
    this.onStart?.();
  };
}
