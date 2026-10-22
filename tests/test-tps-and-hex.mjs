import assert from "node:assert/strict";
import { fitTPS, fitBoundedTPS } from "../scripts/tps.js";
import {
  getVertexRayAngles,
  getReferenceHexCenter,
  getDefaultSizeHandle,
  computeRadiusFromHandle,
  nearestHexVertex,
  getHexesInBounds,
  computeFoundryGridAlignment
} from "../scripts/hex-math.js";
import { warpPixelBuffer } from "../scripts/warp.js";

// 1. Test TPS exactness on non-linear hand-drawn distortion across a 4000x3000 map
{
  const source = [
    { x: 210, y: 195 },
    { x: 3810, y: 205 },
    { x: 195, y: 2790 },
    { x: 3790, y: 2812 },
    { x: 2015, y: 1485 },
    { x: 1120, y: 950 }
  ];
  const target = [
    { x: 200, y: 200 },
    { x: 3800, y: 200 },
    { x: 200, y: 2800 },
    { x: 3800, y: 2800 },
    { x: 2000, y: 1500 },
    { x: 1100, y: 960 }
  ];

  const tps = fitTPS(source, target);
  for (let i = 0; i < source.length; i++) {
    const mapped = tps(source[i]);
    const err = Math.hypot(mapped.x - target[i].x, mapped.y - target[i].y);
    assert(err < 1e-2, `Expected control point ${i} error < 0.01px, got ${err}`);
  }

  // Test collinear and 1-2 point stability in fitBoundedTPS
  const onePt = fitBoundedTPS([{ x: 500, y: 500 }], [{ x: 520, y: 490 }], { width: 1000, height: 1000 });
  assert.deepEqual(onePt({ x: 100, y: 100 }), { x: 120, y: 90 });

  const twoPts = fitBoundedTPS(
    [{ x: 200, y: 500 }, { x: 800, y: 500 }],
    [{ x: 210, y: 505 }, { x: 790, y: 495 }],
    { width: 1000, height: 1000 }
  );
  const p0 = twoPts({ x: 200, y: 500 });
  const p1 = twoPts({ x: 800, y: 500 });
  assert(Math.hypot(p0.x - 210, p0.y - 505) < 1e-2);
  assert(Math.hypot(p1.x - 790, p1.y - 495) < 1e-2);

  // Test Owlbear Rodeo style 2-point global X-Y scale alignment:
  // Suppose a 3000x2000 map has hexes that are 4% narrower in X and 3% taller in Y than the target grid.
  // Aligning just 1 Refine corner at (2200, 1600) relative to Origin (200, 200) must align the ENTIRE map in X and Y!
  const origin = { x: 200, y: 200 };
  const trueScaleX = 1.04;
  const trueScaleY = 0.97;
  const mapCorner = { x: 200 + 2000 / trueScaleX, y: 200 + 1400 / trueScaleY };
  const gridCorner = { x: 2200, y: 1600 };

  const globalXY = fitBoundedTPS([origin, mapCorner], [origin, gridCorner], { width: 3000, height: 2000 });
  // Check an unpinned hex vertex at (1200, 900) and near the far edge (2800, 1900)
  for (const testGridPt of [{ x: 1200, y: 900 }, { x: 2800, y: 1900 }, { x: 1200, y: 200 }, { x: 200, y: 1600 }]) {
    const unwarpedMapPt = {
      x: 200 + (testGridPt.x - 200) / trueScaleX,
      y: 200 + (testGridPt.y - 200) / trueScaleY
    };
    const alignedPt = globalXY(unwarpedMapPt);
    const err = Math.hypot(alignedPt.x - testGridPt.x, alignedPt.y - testGridPt.y);
    assert(err < 1e-6, `Expected 2-point global X-Y scale to align entire map with 0 drift, got error=${err}`);
  }
}

// 2. Test Hex Math (Reference Hex, Handle, Vertex Snapping, Ray Angles)
{
  const origin = { x: 400, y: 300 };
  const radius = 80;
  const handle = getDefaultSizeHandle(origin, radius, "flat", 0);
  // Distance from Top-Left vertex (k=4) to Bottom-Right vertex (k=1) of the reference hex must be 2 * R = 160
  const dist = Math.hypot(handle.x - origin.x, handle.y - origin.y);
  assert(Math.abs(dist - 160) < 1e-6, `Expected handle distance 160, got ${dist}`);

  const recovered = computeRadiusFromHandle(origin, handle, "flat", 0);
  assert(Math.abs(recovered.radius - radius) < 1e-6);

  // Snapping near origin and handle
  const snapOrigin = nearestHexVertex({ x: origin.x + 4, y: origin.y - 3 }, {
    origin,
    radius,
    orientation: "flat",
    originParity: 0
  });
  assert(Math.hypot(snapOrigin.x - origin.x, snapOrigin.y - origin.y) < 1e-5);
  assert.equal(snapOrigin.parity, 0);

  const snapHandle = nearestHexVertex({ x: handle.x - 2, y: handle.y + 3 }, {
    origin,
    radius,
    orientation: "flat",
    originParity: 0
  });
  assert(Math.hypot(snapHandle.x - handle.x, snapHandle.y - handle.y) < 1e-5);
  assert.equal(snapHandle.parity, 1);

  const rays0 = getVertexRayAngles("flat", 0).map((r) => Math.round((r * 180) / Math.PI));
  assert.deepEqual(rays0, [0, 120, 240]);
  const rays1 = getVertexRayAngles("flat", 1).map((r) => Math.round((r * 180) / Math.PI));
  assert.deepEqual(rays1, [60, 180, 300]);

  const hexes = getHexesInBounds({ x: 0, y: 0, width: 1000, height: 800 }, { origin, radius, orientation: "flat" });
  assert(hexes.length > 20);

  const alignment = computeFoundryGridAlignment({ radius: 66.2, orientation: "flat", origin });
  assert(Number.isInteger(alignment.foundryGridSize));

  // Mock Foundry v12/v13/v14 HexagonalGrid where getOffsetRange returns [i0, j0, i1, j1]
  class MockFoundryHexGrid {
    constructor({ size, columns }) {
      this.size = size;
      this.columns = columns;
      this.radius = size / Math.sqrt(3);
    }
    getOffsetRange(bounds) {
      const colStep = 1.5 * this.radius;
      const rowStep = Math.sqrt(3) * this.radius;
      return [
        Math.floor(bounds.y / rowStep) - 1,
        Math.floor(bounds.x / colStep) - 1,
        Math.ceil((bounds.y + bounds.height) / rowStep) + 1,
        Math.ceil((bounds.x + bounds.width) / colStep) + 1
      ];
    }
    getCenterPoint({ i, j }) {
      return {
        x: 1.5 * this.radius * j,
        y: Math.sqrt(3) * this.radius * (i + 0.5 * (j & 1))
      };
    }
    getVertices(offset) {
      const c = this.getCenterPoint(offset);
      const verts = [];
      for (let k = 0; k < 6; k++) {
        const ang = (k * 60 * Math.PI) / 180;
        verts.push({
          x: c.x + this.radius * Math.cos(ang),
          y: c.y + this.radius * Math.sin(ang)
        });
      }
      return verts;
    }
  }

  const alignWithMock = computeFoundryGridAlignment({
    radius: 58.1,
    orientation: "flat",
    origin: { x: 412, y: 318 },
    originParity: 0,
    HexagonalGridClass: MockFoundryHexGrid
  });
  const mappedOrigin = alignWithMock.mapTargetToFoundry({ x: 412, y: 318 }, 0);
  // Verify that mappedOrigin lands on an actual vertex of MockFoundryHexGrid!
  const mockGrid = alignWithMock.nativeGrid;
  const [i0, j0, i1, j1] = mockGrid.getOffsetRange({ x: 300, y: 200, width: 250, height: 250 });
  let minVertDist = Infinity;
  for (let i = i0; i <= i1; i++) {
    for (let j = j0; j <= j1; j++) {
      for (const v of mockGrid.getVertices({ i, j })) {
        const d = Math.hypot(v.x - mappedOrigin.x, v.y - mappedOrigin.y);
        if (d < minVertDist) minVertDist = d;
      }
    }
  }
  assert(minVertDist < 1e-6, `Expected mapped origin to land on exact Foundry HexagonalGrid vertex, dist=${minVertDist}`);
}

// 3. Test Image Buffer Warping (warpPixelBuffer)
{
  const width = 120;
  const height = 100;
  const src = new Uint8ClampedArray(width * height * 4);

  // Paint a bright red dot at source (45, 52) and green dot at (83, 28)
  const setPixel = (x, y, r, g, b, a = 255) => {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const idx = ((y + dy) * width + (x + dx)) * 4;
        src[idx] = r;
        src[idx + 1] = g;
        src[idx + 2] = b;
        src[idx + 3] = a;
      }
    }
  };
  setPixel(45, 52, 255, 0, 0);
  setPixel(83, 28, 0, 255, 0);

  const sourcePoints = [
    { x: 45, y: 52 },
    { x: 83, y: 28 },
    { x: 20, y: 80 },
    { x: 100, y: 80 }
  ];
  const targetPoints = [
    { x: 40, y: 50 },
    { x: 80, y: 30 },
    { x: 20, y: 80 },
    { x: 100, y: 80 }
  ];

  const warped = warpPixelBuffer(src, width, height, sourcePoints, targetPoints, {
    cellSize: 4,
    bilinear: true
  });

  // Check that target (40, 50) now has the bright red pixel from source (45, 52)!
  const redIdx = (50 * width + 40) * 4;
  assert(warped[redIdx] > 200 && warped[redIdx + 1] < 30, `Expected red at warped target (40,50), got R=${warped[redIdx]}`);

  // Check that target (80, 30) now has the bright green pixel from source (83, 28)!
  const greenIdx = (30 * width + 80) * 4;
  assert(warped[greenIdx + 1] > 200 && warped[greenIdx] < 30, `Expected green at warped target (80,30), got G=${warped[greenIdx + 1]}`);
}

console.log("All TPS, Hex Math, and Image Warp tests passed successfully!");
