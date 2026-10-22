/**
 * Pure hexagonal grid geometry and vertex math for Owlbear Rodeo style alignment
 * and Foundry VTT scene grid synchronization.
 */

const SQRT3 = Math.sqrt(3);
const DEG_TO_RAD = Math.PI / 180;

/**
 * Return the 3 ray angles (in radians) meeting at a hex vertex of the given orientation and parity.
 *
 * For "flat" (flat-top):
 * - parity 0 (">-" vertex, e.g. Top-Left, Bottom-Left, Right): rays at 0°, 120°, 240°
 * - parity 1 ("-<" vertex, e.g. Bottom-Right, Top-Right, Left): rays at 60°, 180°, 300°
 *
 * For "pointy" (pointy-top):
 * - parity 0: rays at 30°, 150°, 270°
 * - parity 1: rays at 90°, 210°, 330°
 *
 * @param {"flat"|"pointy"} orientation
 * @param {0|1} parity
 * @returns {[number, number, number]}
 */
export function getVertexRayAngles(orientation = "flat", parity = 0) {
  const baseDeg = orientation === "pointy" ? 30 : 0;
  const offsetDeg = parity === 1 ? 60 : 0;
  return [
    (baseDeg + offsetDeg) * DEG_TO_RAD,
    (baseDeg + offsetDeg + 120) * DEG_TO_RAD,
    (baseDeg + offsetDeg + 240) * DEG_TO_RAD
  ];
}

/**
 * Given the anchor vertex `origin` (placed in Step 1: Offset), circumradius `R`,
 * `orientation` ("flat" | "pointy"), and `originParity` (0 or 1), compute the center
 * of the primary reference hexagon shown in Step 2 (Size).
 *
 * By default (parity 0, flat-top), `origin` is the Top-Left vertex (k=4, angle 240° from center),
 * and the opposite Bottom-Right vertex (k=1, angle 60° from center) carries the Size handle,
 * matching Owlbear Rodeo 2.0's exact visual layout.
 *
 * @param {{x: number, y: number}} origin
 * @param {number} radius Circumradius R (center-to-vertex distance)
 * @param {"flat"|"pointy"} [orientation="flat"]
 * @param {0|1} [originParity=0]
 * @returns {{x: number, y: number, anchorVertexIndex: number, handleVertexIndex: number}}
 */
export function getReferenceHexCenter(origin, radius, orientation = "flat", originParity = 0) {
  // Vertex index k in [0..5] where vertex angle is (base + k*60°)
  // k even (0, 2, 4) has parity 0; k odd (1, 3, 5) has parity 1.
  // For flat-top: k=4 is Top-Left (240°), opposite k=1 is Bottom-Right (60°).
  // If originParity === 1: k=3 is Left (180°), opposite k=0 is Right (0°).
  const anchorVertexIndex = originParity === 0 ? 4 : 3;
  const handleVertexIndex = (anchorVertexIndex + 3) % 6;
  const baseDeg = orientation === "pointy" ? 30 : 0;
  const angleRad = (baseDeg + anchorVertexIndex * 60) * DEG_TO_RAD;

  return {
    x: origin.x - radius * Math.cos(angleRad),
    y: origin.y - radius * Math.sin(angleRad),
    anchorVertexIndex,
    handleVertexIndex
  };
}

/**
 * Compute the 6 vertices of a hexagon given its center, circumradius R, and orientation.
 * @param {{x: number, y: number}} center
 * @param {number} radius
 * @param {"flat"|"pointy"} [orientation="flat"]
 * @returns {Array<{x: number, y: number, index: number, parity: 0|1}>}
 */
export function getHexVertices(center, radius, orientation = "flat") {
  const baseDeg = orientation === "pointy" ? 30 : 0;
  const vertices = [];
  for (let k = 0; k < 6; k++) {
    const angle = (baseDeg + k * 60) * DEG_TO_RAD;
    vertices.push({
      x: center.x + radius * Math.cos(angle),
      y: center.y + radius * Math.sin(angle),
      index: k,
      parity: (k % 2 === 0 ? 0 : 1)
    });
  }
  return vertices;
}

/**
 * Default handle position for Step 2 (Size) given `origin` and initial `radius`.
 * Places the handle on the vertex opposite to `origin` on the reference hexagon
 * (distance = 2 * R from origin).
 *
 * @param {{x: number, y: number}} origin
 * @param {number} radius
 * @param {"flat"|"pointy"} [orientation="flat"]
 * @param {0|1} [originParity=0]
 * @returns {{x: number, y: number, parity: 0|1}}
 */
export function getDefaultSizeHandle(origin, radius, orientation = "flat", originParity = 0) {
  const ref = getReferenceHexCenter(origin, radius, orientation, originParity);
  const vertices = getHexVertices(ref, radius, orientation);
  const v = vertices[ref.handleVertexIndex];
  return { x: v.x, y: v.y, parity: v.parity };
}

/**
 * Compute the circumradius R and snapped handle position when the user drags the Size handle.
 * In Step 2, the handle sits at the opposite vertex of the reference hex (distance = 2 * R),
 * or if the user drags to another vertex of the reference hex, we compute R so the reference
 * hex passes cleanly through `origin` and the dragged corner.
 *
 * @param {{x: number, y: number}} origin
 * @param {{x: number, y: number}} rawHandle
 * @param {"flat"|"pointy"} [orientation="flat"]
 * @param {0|1} [originParity=0]
 * @returns {{ radius: number, snappedHandle: {x: number, y: number}, handleParity: 0|1 }}
 */
export function computeRadiusFromHandle(origin, rawHandle, orientation = "flat", originParity = 0) {
  const dx = rawHandle.x - origin.x;
  const dy = rawHandle.y - origin.y;
  const dist = Math.hypot(dx, dy);
  // Distance from anchor vertex (k=4, Top-Left) to handle vertex (k=1, Bottom-Right) is 2 * R
  const radius = Math.max(10, dist / 2);
  const snapped = getDefaultSizeHandle(origin, radius, orientation, originParity);
  return {
    radius,
    snappedHandle: { x: snapped.x, y: snapped.y },
    handleParity: snapped.parity
  };
}

/**
 * Convert axial hex coordinates (q, r) to world (x, y) center relative to the reference hex center C0.
 * @param {number} q
 * @param {number} r
 * @param {{x: number, y: number}} c0
 * @param {number} radius
 * @param {"flat"|"pointy"} orientation
 * @returns {{x: number, y: number}}
 */
export function axialToCenter(q, r, c0, radius, orientation = "flat") {
  if (orientation === "flat") {
    return {
      x: c0.x + 1.5 * radius * q,
      y: c0.y + SQRT3 * radius * (r + 0.5 * q)
    };
  }
  return {
    x: c0.x + SQRT3 * radius * (q + 0.5 * r),
    y: c0.y + 1.5 * radius * r
  };
}

/**
 * Convert world (x, y) point to fractional axial coordinates (q, r) relative to C0.
 * @param {{x: number, y: number}} point
 * @param {{x: number, y: number}} c0
 * @param {number} radius
 * @param {"flat"|"pointy"} orientation
 * @returns {{q: number, r: number}}
 */
export function pointToAxial(point, c0, radius, orientation = "flat") {
  const px = point.x - c0.x;
  const py = point.y - c0.y;
  if (orientation === "flat") {
    const q = (2 / 3) * px / radius;
    const r = (-1 / 3) * px / radius + (1 / SQRT3) * py / radius;
    return axialRound(q, r);
  }
  const q = (1 / SQRT3) * px / radius - (1 / 3) * py / radius;
  const r = (2 / 3) * py / radius;
  return axialRound(q, r);
}

function axialRound(qf, rf) {
  const sf = -qf - rf;
  let q = Math.round(qf);
  let r = Math.round(rf);
  let s = Math.round(sf);
  const qDiff = Math.abs(q - qf);
  const rDiff = Math.abs(r - rf);
  const sDiff = Math.abs(s - sf);
  if (qDiff > rDiff && qDiff > sDiff) {
    q = -r - s;
  } else if (rDiff > sDiff) {
    r = -q - s;
  }
  return { q, r };
}

/**
 * Find the nearest theoretical hex vertex to `point` in the grid defined by
 * (origin, radius, orientation, originParity).
 *
 * Returns the exact vertex coordinates, its parity (0 or 1) for the 3-ray loupe reticle,
 * and its canonical lattice identifier `(q, r, vertexIndex)`.
 *
 * @param {{x: number, y: number}} point
 * @param {{ origin: {x: number, y: number}, radius: number, orientation: "flat"|"pointy", originParity?: 0|1 }} gridSpec
 * @returns {{ x: number, y: number, parity: 0|1, q: number, r: number, vertexIndex: number, distance: number, key: string }}
 */
export function nearestHexVertex(point, gridSpec) {
  const { origin, radius, orientation = "flat", originParity = 0 } = gridSpec;
  const c0 = getReferenceHexCenter(origin, radius, orientation, originParity);
  const approx = pointToAxial(point, c0, radius, orientation);

  let best = null;
  let bestDist = Infinity;

  for (let dq = -1; dq <= 1; dq++) {
    for (let dr = -1; dr <= 1; dr++) {
      const q = approx.q + dq;
      const r = approx.r + dr;
      const center = axialToCenter(q, r, c0, radius, orientation);
      const vertices = getHexVertices(center, radius, orientation);
      for (const v of vertices) {
        const d = Math.hypot(v.x - point.x, v.y - point.y);
        if (d < bestDist) {
          bestDist = d;
          best = {
            x: v.x,
            y: v.y,
            parity: v.parity,
            q,
            r,
            vertexIndex: v.index,
            distance: d,
            key: `${Math.round(v.x * 10)}:${Math.round(v.y * 10)}`
          };
        }
      }
    }
  }

  return best;
}

/**
 * Generate all hex polygons within a bounding box `[x, y, width, height]`
 * for fast rendering of the orange hex grid overlay.
 *
 * @param {{ x: number, y: number, width: number, height: number }} bounds
 * @param {{ origin: {x: number, y: number}, radius: number, orientation: "flat"|"pointy", originParity?: 0|1 }} gridSpec
 * @returns {Array<Array<{x: number, y: number, index: number, parity: 0|1}>>}
 */
export function getHexesInBounds(bounds, gridSpec) {
  const { origin, radius, orientation = "flat", originParity = 0 } = gridSpec;
  const c0 = getReferenceHexCenter(origin, radius, orientation, originParity);
  const pad = radius * 2;
  const minX = bounds.x - pad;
  const maxX = bounds.x + bounds.width + pad;
  const minY = bounds.y - pad;
  const maxY = bounds.y + bounds.height + pad;

  const hexes = [];

  if (orientation === "flat") {
    const colStep = 1.5 * radius;
    const rowStep = SQRT3 * radius;
    const qMin = Math.floor((minX - c0.x) / colStep) - 1;
    const qMax = Math.ceil((maxX - c0.x) / colStep) + 1;

    for (let q = qMin; q <= qMax; q++) {
      const yOffset = c0.y + 0.5 * SQRT3 * radius * q;
      const rMin = Math.floor((minY - yOffset) / rowStep) - 1;
      const rMax = Math.ceil((maxY - yOffset) / rowStep) + 1;
      for (let r = rMin; r <= rMax; r++) {
        const center = axialToCenter(q, r, c0, radius, orientation);
        hexes.push(getHexVertices(center, radius, orientation));
      }
    }
  } else {
    const rowStep = 1.5 * radius;
    const colStep = SQRT3 * radius;
    const rMin = Math.floor((minY - c0.y) / rowStep) - 1;
    const rMax = Math.ceil((maxY - c0.y) / rowStep) + 1;

    for (let r = rMin; r <= rMax; r++) {
      const xOffset = c0.x + 0.5 * SQRT3 * radius * r;
      const qMin = Math.floor((minX - xOffset) / colStep) - 1;
      const qMax = Math.ceil((maxX - xOffset) / colStep) + 1;
      for (let q = qMin; q <= qMax; q++) {
        const center = axialToCenter(q, r, c0, radius, orientation);
        hexes.push(getHexVertices(center, radius, orientation));
      }
    }
  }

  return hexes;
}

/**
 * Find the nearest vertex of a given parity (`0` for `>-`, `1` for `-<`) on a Foundry VTT
 * `HexagonalGrid` instance around `targetPt`.
 *
 * Compatible with Foundry VTT v12, v13, and v14 (`getOffset` + `getOffsetRange([i0, j0, i1, j1])`).
 *
 * @param {object} gridInstance Instance of `foundry.grid.HexagonalGrid` (or `canvas.grid`)
 * @param {{x: number, y: number}} targetPt World coordinates to search near
 * @param {"flat"|"pointy"} [orientation="flat"]
 * @param {0|1} [parity=0]
 * @param {number} [gridSize=100]
 * @returns {{x: number, y: number} | null}
 */
export function findNearestMatchingGridVertex(
  gridInstance,
  targetPt,
  orientation = "flat",
  parity = 0,
  gridSize = 100
) {
  if (!gridInstance || typeof gridInstance.getVertices !== "function") return null;

  const candidateOffsets = [];
  if (typeof gridInstance.getOffset === "function") {
    try {
      const centerOffset = gridInstance.getOffset({ x: targetPt.x, y: targetPt.y });
      if (centerOffset && typeof centerOffset.i === "number" && typeof centerOffset.j === "number") {
        for (let di = -2; di <= 2; di++) {
          for (let dj = -2; dj <= 2; dj++) {
            candidateOffsets.push({ i: centerOffset.i + di, j: centerOffset.j + dj });
          }
        }
      }
    } catch (_err) {
      // Fallback to getOffsetRange below
    }
  }

  if (candidateOffsets.length === 0 && typeof gridInstance.getOffsetRange === "function") {
    try {
      const range = gridInstance.getOffsetRange({
        x: targetPt.x - gridSize * 2,
        y: targetPt.y - gridSize * 2,
        width: gridSize * 4,
        height: gridSize * 4
      });
      if (Array.isArray(range) && range.length === 4 && typeof range[0] === "number") {
        const [i0, j0, i1, j1] = range;
        for (let i = i0; i <= i1; i++) {
          for (let j = j0; j <= j1; j++) {
            candidateOffsets.push({ i, j });
          }
        }
      } else if (range && typeof range[Symbol.iterator] === "function") {
        for (const item of range) {
          if (item && typeof item === "object" && "i" in item && "j" in item) {
            candidateOffsets.push(item);
          }
        }
      }
    } catch (_err) {
      // Ignore
    }
  }

  const baseDeg = orientation === "pointy" ? 30 : 0;
  let bestDist = Infinity;
  let bestVertex = null;

  for (const offset of candidateOffsets) {
    try {
      const center = gridInstance.getCenterPoint(offset);
      const verts = gridInstance.getVertices(offset);
      if (!center || !Array.isArray(verts)) continue;
      for (const v of verts) {
        const angDeg = (((Math.atan2(v.y - center.y, v.x - center.x) * 180) / Math.PI) % 360 + 360) % 360;
        const relDeg = ((angDeg - baseDeg) % 360 + 360) % 360;
        const sector = Math.round(relDeg / 60) % 6;
        const vParity = sector % 2 === 0 ? 0 : 1;
        if (vParity !== parity) continue;

        const d = Math.hypot(v.x - targetPt.x, v.y - targetPt.y);
        if (d < bestDist) {
          bestDist = d;
          bestVertex = { x: v.x, y: v.y };
        }
      }
    } catch (_err) {
      // Ignore individual offset errors
    }
  }

  return bestVertex;
}

/**
 * Compute the exact Foundry VTT integer `grid.size` and transform target vertices so that
 * the warped image aligns with Foundry's native integer-sized HexagonalGrid with zero drift.
 *
 * In Foundry VTT:
 * - `scene.grid.size` is an integer >= 20 representing the flat-to-flat distance (`sqrt(3) * R`),
 *   or if runtime `foundry.grid.HexagonalGrid` is provided, we query its exact vertex radius ratio.
 *
 * @param {object} params
 * @param {number} params.radius Theoretical circumradius R in scene pixels
 * @param {"flat"|"pointy"} params.orientation
 * @param {{x: number, y: number}} params.origin Theoretical origin vertex in scene pixels
 * @param {0|1} [params.originParity=0]
 * @param {Function} [params.HexagonalGridClass] Optional `foundry.grid.HexagonalGrid` class at runtime
 * @returns {{
 *   foundryGridSize: number,
 *   scaleFactor: number,
 *   offsetX: number,
 *   offsetY: number,
 *   nativeGrid: object | null,
 *   mapTargetToFoundry: (targetScenePt: {x: number, y: number}, pointParity?: 0|1) => {x: number, y: number}
 * }}
 */
export function computeFoundryGridAlignment({
  radius,
  orientation = "flat",
  origin,
  originParity = 0,
  HexagonalGridClass = null
}) {
  // Determine Foundry's exact ratio between `grid.size` and circumradius `R`
  let radiusPerGridSize = 1 / SQRT3; // Standard Foundry HexagonalGrid: size = flat-to-flat = sqrt(3)*R
  if (typeof HexagonalGridClass === "function") {
    try {
      const testGrid = new HexagonalGridClass({
        size: 100,
        columns: orientation === "flat",
        even: true
      });
      const center0 = testGrid.getCenterPoint?.({ i: 0, j: 0 });
      const testVerts = testGrid.getVertices({ i: 0, j: 0 });
      if (center0 && Array.isArray(testVerts) && testVerts.length >= 1) {
        const r = Math.hypot(testVerts[0].x - center0.x, testVerts[0].y - center0.y);
        if (r > 10) {
          radiusPerGridSize = r / 100;
        }
      } else if (Array.isArray(testVerts) && testVerts.length >= 2) {
        const edgeLen = Math.hypot(testVerts[1].x - testVerts[0].x, testVerts[1].y - testVerts[0].y);
        if (edgeLen > 10) {
          radiusPerGridSize = edgeLen / 100;
        }
      }
    } catch (_err) {
      // Fallback to standard flat-to-flat formula
    }
  }

  const rawFoundrySize = radius / radiusPerGridSize;
  const foundryGridSize = Math.max(20, Math.round(rawFoundrySize));
  const exactFoundryRadius = foundryGridSize * radiusPerGridSize;
  const scaleFactor = exactFoundryRadius / radius;

  let nativeGrid = null;
  if (typeof HexagonalGridClass === "function") {
    try {
      nativeGrid = new HexagonalGridClass({
        size: foundryGridSize,
        columns: orientation === "flat",
        even: true
      });

      const bestVertex = findNearestMatchingGridVertex(
        nativeGrid,
        origin,
        orientation,
        originParity,
        foundryGridSize
      );

      if (bestVertex) {
        const anchorX = bestVertex.x;
        const anchorY = bestVertex.y;
        return {
          foundryGridSize,
          scaleFactor,
          offsetX: 0,
          offsetY: 0,
          nativeGrid,
          mapTargetToFoundry(targetScenePt, pointParity = null) {
            const scaledPt = {
              x: anchorX + (targetScenePt.x - origin.x) * scaleFactor,
              y: anchorY + (targetScenePt.y - origin.y) * scaleFactor
            };
            if (pointParity === 0 || pointParity === 1) {
              const snapped = findNearestMatchingGridVertex(
                nativeGrid,
                scaledPt,
                orientation,
                pointParity,
                foundryGridSize
              );
              if (snapped && Math.hypot(snapped.x - scaledPt.x, snapped.y - scaledPt.y) < foundryGridSize * 0.35) {
                return snapped;
              }
            }
            return scaledPt;
          }
        };
      }
    } catch (_err) {
      // Ignore if outside Foundry environment
    }
  }

  return {
    foundryGridSize,
    scaleFactor,
    offsetX: 0,
    offsetY: 0,
    nativeGrid,
    mapTargetToFoundry(targetScenePt) {
      // Scale distance from origin by scaleFactor so inter-hex spacing matches integer foundryGridSize
      return {
        x: origin.x + (targetScenePt.x - origin.x) * scaleFactor,
        y: origin.y + (targetScenePt.y - origin.y) * scaleFactor
      };
    }
  };
}
