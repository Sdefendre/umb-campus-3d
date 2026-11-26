import * as THREE from 'three';

export interface ArchitecturalTextures {
  glassFacade: THREE.CanvasTexture;
  masonryFacade: THREE.CanvasTexture;
  secondaryFacade: THREE.CanvasTexture;
  roofCap: THREE.CanvasTexture;
}

function makeCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  return [c, ctx];
}

function configureWorldTile(
  canvas: HTMLCanvasElement,
  tileWidthM: number,
  tileHeightM: number
): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  // ExtrudeGeometry uses world-meter UVs on side walls & top caps
  tex.repeat.set(1 / tileWidthM, 1 / tileHeightM);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Deterministic pseudo-random helper for realistic lit/unlit window variation.
 */
function hash2(a: number, b: number): number {
  const x = Math.sin(a * 127.1 + b * 311.7) * 43758.5453123;
  return x - Math.floor(x);
}

/**
 * Generates crisp, zero-network procedural architectural textures mapped in real-world
 * meters so horizontal window bands align to actual floor heights across every UMB building.
 */
export function createArchitecturalTextures(): ArchitecturalTextures {
  // 1. Modern curtain-wall glass facade (ISC, University Hall, Campus Center, West Garage)
  // Tile represents 16m wide x 14.4m tall (4 floors @ 3.6m)
  const [glassC, gCtx] = makeCanvas(256, 256);
  gCtx.fillStyle = '#15253d';
  gCtx.fillRect(0, 0, 256, 256);

  const glassFloors = 4;
  const floorH = 256 / glassFloors;
  const glassCols = 8;
  const colW = 256 / glassCols;

  for (let f = 0; f < glassFloors; f++) {
    const y0 = f * floorH;
    // Spandrel / concrete floor slab band
    gCtx.fillStyle = '#0e192b';
    gCtx.fillRect(0, y0, 256, 14);
    gCtx.fillStyle = '#2d4b73';
    gCtx.fillRect(0, y0 + 13, 256, 2);

    // Continuous curtain-wall glass ribbon
    const winY = y0 + 16;
    const winH = floorH - 20;
    for (let c = 0; c < glassCols; c++) {
      const x0 = c * colW;
      const rnd = hash2(c + 1, f + 7);
      const grad = gCtx.createLinearGradient(x0, winY, x0, winY + winH);
      if (rnd > 0.72) {
        // Softly illuminated lab / study floor
        grad.addColorStop(0, '#3e84b8');
        grad.addColorStop(0.55, '#295d8a');
        grad.addColorStop(1, '#1d4166');
      } else if (rnd > 0.35) {
        grad.addColorStop(0, '#274c74');
        grad.addColorStop(1, '#18304d');
      } else {
        grad.addColorStop(0, '#1e3a5c');
        grad.addColorStop(1, '#12243b');
      }
      gCtx.fillStyle = grad;
      gCtx.fillRect(x0 + 2, winY, colW - 3, winH);

      // Subtle vertical steel mullion highlight
      gCtx.fillStyle = 'rgba(128, 200, 255, 0.22)';
      gCtx.fillRect(x0 + 1, winY, 1, winH);
    }
  }

  // 2. Architectural masonry / brutalist ribbon facade (Healey, McCormack, Wheatley, Quinn, Res Halls)
  // Tile represents 16m wide x 13.6m tall (4 floors @ 3.4m)
  const [masonryC, mCtx] = makeCanvas(256, 256);
  mCtx.fillStyle = '#182438';
  mCtx.fillRect(0, 0, 256, 256);

  const mFloors = 4;
  const mFloorH = 256 / mFloors;
  const mCols = 6;
  const mColW = 256 / mCols;

  for (let f = 0; f < mFloors; f++) {
    const y0 = f * mFloorH;
    // Heavy horizontal precast / brick fascia course
    mCtx.fillStyle = '#111b2c';
    mCtx.fillRect(0, y0, 256, 22);
    mCtx.fillStyle = '#2a3e5c';
    mCtx.fillRect(0, y0 + 21, 256, 2);

    const winY = y0 + 25;
    const winH = mFloorH - 31;
    for (let c = 0; c < mCols; c++) {
      const x0 = c * mColW;
      const rnd = hash2(c + 13, f + 3);
      // Recessed window bay
      mCtx.fillStyle = rnd > 0.76 ? '#4684b5' : rnd > 0.42 ? '#234469' : '#14263f';
      mCtx.fillRect(x0 + 5, winY, mColW - 10, winH);

      // Crisp mullion divider inside bay
      mCtx.fillStyle = '#0e1726';
      mCtx.fillRect(x0 + mColW * 0.5 - 1, winY, 2, winH);
      // Window sill glint
      mCtx.fillStyle = 'rgba(130, 195, 255, 0.25)';
      mCtx.fillRect(x0 + 5, winY + winH - 2, mColW - 10, 2);
    }
  }

  // 3. Secondary surrounding buildings (quiet dark architectural rhythm)
  const [secC, sCtx] = makeCanvas(128, 128);
  sCtx.fillStyle = '#0e1726';
  sCtx.fillRect(0, 0, 128, 128);
  for (let f = 0; f < 4; f++) {
    const y0 = f * 32;
    sCtx.fillStyle = '#0a111c';
    sCtx.fillRect(0, y0, 128, 12);
    for (let c = 0; c < 4; c++) {
      const rnd = hash2(c + 29, f + 11);
      sCtx.fillStyle = rnd > 0.78 ? '#234063' : '#14243b';
      sCtx.fillRect(c * 32 + 4, y0 + 14, 24, 14);
    }
  }

  // 4. Rooftop architectural cap texture (subtle slate membrane + parapet/panel grid)
  const [roofC, rCtx] = makeCanvas(128, 128);
  rCtx.fillStyle = '#253d63';
  rCtx.fillRect(0, 0, 128, 128);
  rCtx.strokeStyle = 'rgba(130, 200, 255, 0.22)';
  rCtx.lineWidth = 1;
  for (let i = 0; i <= 128; i += 32) {
    rCtx.beginPath();
    rCtx.moveTo(i, 0);
    rCtx.lineTo(i, 128);
    rCtx.stroke();
    rCtx.beginPath();
    rCtx.moveTo(0, i);
    rCtx.lineTo(128, i);
    rCtx.stroke();
  }

  return {
    glassFacade: configureWorldTile(glassC, 16, 14.4),
    masonryFacade: configureWorldTile(masonryC, 16, 13.6),
    secondaryFacade: configureWorldTile(secC, 16, 14.0),
    roofCap: configureWorldTile(roofC, 20, 20),
  };
}
