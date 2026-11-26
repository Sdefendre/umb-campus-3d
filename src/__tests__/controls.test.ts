import { PerspectiveCamera } from 'three';
import { describe, expect, it, vi } from 'vitest';
import { CampusControls } from '../controls';

function makeMockDom(height = 800) {
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  return {
    clientHeight: height,
    addEventListener(type: string, fn: (e: unknown) => void) {
      const set = listeners.get(type) ?? new Set();
      set.add(fn);
      listeners.set(type, set);
    },
    removeEventListener(type: string, fn: (e: unknown) => void) {
      listeners.get(type)?.delete(fn);
    },
    dispatch(type: string, ev: Record<string, unknown>) {
      for (const fn of listeners.get(type) ?? []) fn(ev);
    },
    listenerCount(type: string) {
      return listeners.get(type)?.size ?? 0;
    },
  };
}

describe('CampusControls', () => {
  it('converges damped rotation to 1.0x input (1 full turn per screen height drag)', () => {
    const cam = new PerspectiveCamera(48, 1, 1, 2400);
    cam.position.set(0, 100, 200);
    const dom = makeMockDom(800);
    const controls = new CampusControls(cam, dom as unknown as HTMLElement);
    controls.target.set(0, 0, 0);
    controls.update();

    // Drag 200px horizontally (= 0.25 of screen height = PI/2 radians)
    dom.dispatch('pointerdown', { pointerId: 1, clientX: 100, clientY: 100, button: 0, shiftKey: false });
    dom.dispatch('pointermove', { pointerId: 1, clientX: 300, clientY: 100 });
    dom.dispatch('pointerup', { pointerId: 1 });

    for (let i = 0; i < 120; i++) controls.update();

    const angle = Math.atan2(cam.position.x, cam.position.z);
    // Expected: -PI/2 (not -7.1x over-rotated)
    expect(angle).toBeCloseTo(-Math.PI / 2, 2);
  });

  it('converges damped 2-finger pinch spread (2x distance) to ~2x zoom in', () => {
    const cam = new PerspectiveCamera(48, 1, 1, 2400);
    cam.position.set(0, 0, 400);
    const dom = makeMockDom(800);
    const controls = new CampusControls(cam, dom as unknown as HTMLElement);
    controls.target.set(0, 0, 0);
    controls.update();

    // Two pointers 100px apart -> spread to 200px apart (2x)
    dom.dispatch('pointerdown', { pointerId: 1, clientX: 100, clientY: 200, button: 0, shiftKey: false });
    dom.dispatch('pointerdown', { pointerId: 2, clientX: 200, clientY: 200, button: 0, shiftKey: false });
    dom.dispatch('pointermove', { pointerId: 1, clientX: 50, clientY: 200 });
    dom.dispatch('pointermove', { pointerId: 2, clientX: 250, clientY: 200 });
    dom.dispatch('pointerup', { pointerId: 1 });
    dom.dispatch('pointerup', { pointerId: 2 });

    for (let i = 0; i < 120; i++) controls.update();

    const finalDist = cam.position.distanceTo(controls.target);
    // 400 / 2 = 200 (not 400 / 9 = 44!)
    expect(finalDist).toBeGreaterThan(190);
    expect(finalDist).toBeLessThan(210);
  });

  it('ignores horizontal wheel scroll (deltaY === 0) and scales smoothly by deltaY', () => {
    const cam = new PerspectiveCamera(48, 1, 1, 2400);
    cam.position.set(0, 0, 300);
    const dom = makeMockDom(800);
    const controls = new CampusControls(cam, dom as unknown as HTMLElement);
    controls.update();

    const preventDefault = vi.fn();
    dom.dispatch('wheel', { deltaY: 0, deltaX: 50, deltaMode: 0, preventDefault });
    for (let i = 0; i < 40; i++) controls.update();
    expect(preventDefault).not.toHaveBeenCalled();
    expect(cam.position.distanceTo(controls.target)).toBeCloseTo(300, 4);

    // Standard scroll-down notch (deltaY = 100) zooms out modestly (~1.13x)
    dom.dispatch('wheel', { deltaY: 100, deltaX: 0, deltaMode: 0, preventDefault });
    for (let i = 0; i < 120; i++) controls.update();
    expect(preventDefault).toHaveBeenCalledTimes(1);
    const dist = cam.position.distanceTo(controls.target);
    expect(dist).toBeGreaterThan(330);
    expect(dist).toBeLessThan(350);
  });

  it('removes all DOM listeners on dispose()', () => {
    const cam = new PerspectiveCamera(48, 1, 1, 2400);
    const dom = makeMockDom(800);
    const controls = new CampusControls(cam, dom as unknown as HTMLElement);
    expect(dom.listenerCount('pointerdown')).toBe(1);
    expect(dom.listenerCount('wheel')).toBe(1);
    controls.dispose();
    expect(dom.listenerCount('pointerdown')).toBe(0);
    expect(dom.listenerCount('wheel')).toBe(0);
  });
});
