/**
 * Pure JavaScript 2D Thin Plate Spline (TPS) and Affine X-Y Skew/Scale solver.
 * Independent of Foundry VTT and DOM APIs so it can be unit-tested standalone.
 */

/**
 * Radial basis kernel for 2D Thin Plate Spline: U(r) = r^2 * ln(r^2)
 * Uses r2 = r^2 directly to avoid an unnecessary Math.sqrt().
 * @param {number} r2 Squared Euclidean distance
 * @returns {number}
 */
export function tpsKernel(r2) {
  return r2 <= 1e-24 ? 0 : r2 * Math.log(r2);
}

/**
 * Solve a linear system A * x = b using Gaussian elimination with partial pivoting.
 * @param {Float64Array[]} matrix Square matrix of size m x m (mutated in-place)
 * @param {Float64Array} rhsX Right-hand side vector for X
 * @param {Float64Array} rhsY Right-hand side vector for Y
 * @returns {{ cx: Float64Array, cy: Float64Array } | null}
 */
function solveLinearSystem2D(matrix, rhsX, rhsY) {
  const m = matrix.length;
  const x = new Float64Array(rhsX);
  const y = new Float64Array(rhsY);

  for (let col = 0; col < m; col++) {
    let pivotRow = col;
    let maxVal = Math.abs(matrix[col][col]);
    for (let row = col + 1; row < m; row++) {
      const val = Math.abs(matrix[row][col]);
      if (val > maxVal) {
        maxVal = val;
        pivotRow = row;
      }
    }

    if (maxVal < 1e-12) {
      return null; // Singular or nearly collinear system
    }

    if (pivotRow !== col) {
      const tmpRow = matrix[col];
      matrix[col] = matrix[pivotRow];
      matrix[pivotRow] = tmpRow;

      const tmpX = x[col];
      x[col] = x[pivotRow];
      x[pivotRow] = tmpX;

      const tmpY = y[col];
      y[col] = y[pivotRow];
      y[pivotRow] = tmpY;
    }

    const pivot = matrix[col][col];
    const invPivot = 1.0 / pivot;
    const pivotRowArr = matrix[col];
    for (let j = col; j < m; j++) {
      pivotRowArr[j] *= invPivot;
    }
    x[col] *= invPivot;
    y[col] *= invPivot;

    for (let row = 0; row < m; row++) {
      if (row === col) continue;
      const factor = matrix[row][col];
      if (factor === 0) continue;
      const rowArr = matrix[row];
      for (let j = col; j < m; j++) {
        rowArr[j] -= factor * pivotRowArr[j];
      }
      x[row] -= factor * x[col];
      y[row] -= factor * y[col];
    }
  }

  return { cx: x, cy: y };
}

/**
 * Fit an exact 2-point X-Y scale/skew transformation mapping `source[0..1]` to `destination[0..1]`.
 *
 * When the two points span both X and Y (e.g. origin corner + any refine corner across a hex or across the map),
 * this applies an anisotropic X-Y scale (`scaleX`, `scaleY`) so the entire map stretches cleanly in X and Y
 * to fit the grid with just 1 refinement point.
 * When the two points are nearly horizontal or vertical, it smoothly blends in shear/skew along the active axis
 * and isotropic scale on the perpendicular axis so both points still match 100% exactly without blowing up.
 *
 * @param {Array<{x: number, y: number}>} source
 * @param {Array<{x: number, y: number}>} destination
 * @returns {(point: {x: number, y: number}) => {x: number, y: number}}
 */
export function fitTwoPointTransform(source, destination) {
  const s0 = source[0], s1 = source[1];
  const d0 = destination[0], d1 = destination[1];
  const dsx = s1.x - s0.x;
  const dsy = s1.y - s0.y;
  const ddx = d1.x - d0.x;
  const ddy = d1.y - d0.y;
  const len = Math.hypot(dsx, dsy);

  if (len < 1e-6) {
    const tx = d0.x - s0.x;
    const ty = d0.y - s0.y;
    return (point) => ({ x: point.x + tx, y: point.y + ty });
  }

  const rx = Math.abs(dsx) / len;
  const ry = Math.abs(dsy) / len;
  const minSpanRatio = 0.22;

  // Estimate primary axis scales where span is sufficient
  const rawScaleX = rx >= minSpanRatio ? ddx / dsx : null;
  const rawScaleY = ry >= minSpanRatio ? ddy / dsy : null;

  const validScaleX = rawScaleX !== null && rawScaleX > 0.35 && rawScaleX < 3.0;
  const validScaleY = rawScaleY !== null && rawScaleY > 0.35 && rawScaleY < 3.0;

  // Fast path: when both X and Y have clear span (e.g. diagonal corner), use pure X-Y scaling (zero skew)
  if (validScaleX && validScaleY) {
    const axx = rawScaleX;
    const ayy = rawScaleY;
    return (point) => ({
      x: d0.x + axx * (point.x - s0.x),
      y: d0.y + ayy * (point.y - s0.y)
    });
  }

  // Smoothly regularized X-Y scale + shear when one axis has small span (nearly horizontal or vertical pair)
  const clampedKx = validScaleX ? rawScaleX : 1.0;
  const clampedKy = validScaleY ? rawScaleY : 1.0;

  const gammaX = validScaleX ? 0 : Math.max(1e-4, (1 - Math.min(1, rx / minSpanRatio)) ** 2);
  const gammaY = validScaleY ? 0 : Math.max(1e-4, (1 - Math.min(1, ry / minSpanRatio)) ** 2);

  // If X span is tiny, borrow Y's scale as reference (isotropic fallback), and vice versa
  const refScaleX = validScaleX ? 1.0 : clampedKy;
  const refScaleY = validScaleY ? 1.0 : clampedKx;

  const denomX = dsx * dsx + gammaX * dsy * dsy;
  const remX = ddx - refScaleX * dsx;
  const axx = refScaleX + (remX * dsx) / denomX;
  const axy = (remX * gammaX * dsy) / denomX;

  const denomY = dsy * dsy + gammaY * dsx * dsx;
  const remY = ddy - refScaleY * dsy;
  const ayy = refScaleY + (remY * dsy) / denomY;
  const ayx = (remY * gammaY * dsx) / denomY;

  return (point) => {
    const ux = point.x - s0.x;
    const uy = point.y - s0.y;
    return {
      x: d0.x + axx * ux + axy * uy,
      y: d0.y + ayx * ux + ayy * uy
    };
  };
}

/**
 * Fit a global regularized 2D Affine transformation (X-Y scale, X-Y skew/shear, and translation)
 * mapping `source` points to `destination` points.
 *
 * @param {Array<{x: number, y: number}>} source
 * @param {Array<{x: number, y: number}>} destination
 * @returns {(point: {x: number, y: number}) => {x: number, y: number}}
 */
export function fitAffine2D(source, destination) {
  const n = source.length;
  if (n === 0) return (p) => ({ x: p.x, y: p.y });
  if (n === 1) {
    const dx = destination[0].x - source[0].x;
    const dy = destination[0].y - source[0].y;
    return (p) => ({ x: p.x + dx, y: p.y + dy });
  }
  if (n === 2) {
    return fitTwoPointTransform(source, destination);
  }

  let meanSx = 0, meanSy = 0, meanDx = 0, meanDy = 0;
  for (let i = 0; i < n; i++) {
    meanSx += source[i].x;
    meanSy += source[i].y;
    meanDx += destination[i].x;
    meanDy += destination[i].y;
  }
  meanSx /= n;
  meanSy /= n;
  meanDx /= n;
  meanDy /= n;

  let scale2 = 0;
  for (let i = 0; i < n; i++) {
    const ux = source[i].x - meanSx;
    const uy = source[i].y - meanSy;
    scale2 += ux * ux + uy * uy;
  }
  const sigma = Math.sqrt(scale2 / n) || 1;
  const invSigma = 1 / sigma;

  let Suu = 0, Svv = 0, Suv = 0;
  let BxU = 0, BxV = 0, ByU = 0, ByV = 0;

  for (let i = 0; i < n; i++) {
    const u = (source[i].x - meanSx) * invSigma;
    const v = (source[i].y - meanSy) * invSigma;
    // Excess displacement relative to identity scale
    const ex = ((destination[i].x - meanDx) - (source[i].x - meanSx)) * invSigma;
    const ey = ((destination[i].y - meanDy) - (source[i].y - meanSy)) * invSigma;

    Suu += u * u;
    Svv += v * v;
    Suv += u * v;

    BxU += u * ex;
    BxV += v * ex;
    ByU += u * ey;
    ByV += v * ey;
  }

  // Mild regularization on excess scale and skew so collinear point sets never explode
  const regScale = 1e-6;
  const regSkew = 1e-4;

  // Solve 2x2 for (d_axx, axy)
  const detX = (Suu + regScale) * (Svv + regSkew) - Suv * Suv;
  let axx = 1, axy = 0;
  if (Math.abs(detX) > 1e-12) {
    axx = 1 + ((Svv + regSkew) * BxU - Suv * BxV) / detX;
    axy = ((Suu + regScale) * BxV - Suv * BxU) / detX;
  }

  // Solve 2x2 for (ayx, d_ayy)
  const detY = (Suu + regSkew) * (Svv + regScale) - Suv * Suv;
  let ayx = 0, ayy = 1;
  if (Math.abs(detY) > 1e-12) {
    ayx = ((Svv + regScale) * ByU - Suv * ByV) / detY;
    ayy = 1 + ((Suu + regSkew) * ByV - Suv * ByU) / detY;
  }

  const a0x = meanDx - (axx * meanSx + axy * meanSy);
  const a0y = meanDy - (ayx * meanSx + ayy * meanSy);

  return (point) => ({
    x: a0x + axx * point.x + axy * point.y,
    y: a0y + ayx * point.x + ayy * point.y
  });
}

/**
 * Fit a 2D Thin Plate Spline (TPS) mapping `source` points to `destination` points.
 * Normalizes coordinates internally for numerical stability across large image dimensions.
 *
 * Gracefully handles < 3 points or collinear point sets.
 *
 * @param {Array<{x: number, y: number}>} source Array of source points
 * @param {Array<{x: number, y: number}>} destination Array of destination points
 * @param {object} [options]
 * @param {number} [options.regularization=1e-7] Tikhonov regularization parameter (in normalized units)
 * @returns {(point: {x: number, y: number}) => {x: number, y: number}} Mapping function
 */
export function fitTPS(source, destination, options = {}) {
  if (!Array.isArray(source) || !Array.isArray(destination) || source.length !== destination.length) {
    throw new Error("fitTPS requires source and destination arrays of equal length.");
  }

  const regularization = options.regularization ?? 1e-7;
  const n = source.length;

  if (n === 0) {
    return (point) => ({ x: point.x, y: point.y });
  }

  if (n === 1) {
    const dx = destination[0].x - source[0].x;
    const dy = destination[0].y - source[0].y;
    return (point) => ({ x: point.x + dx, y: point.y + dy });
  }

  if (n === 2) {
    return fitTwoPointTransform(source, destination);
  }

  // Coordinate normalization for numerical stability
  let meanX = 0;
  let meanY = 0;
  for (let i = 0; i < n; i++) {
    meanX += source[i].x;
    meanY += source[i].y;
  }
  meanX /= n;
  meanY /= n;

  let scale = 0;
  for (let i = 0; i < n; i++) {
    const dx = source[i].x - meanX;
    const dy = source[i].y - meanY;
    scale += dx * dx + dy * dy;
  }
  scale = Math.sqrt(scale / n) || 1;
  const invScale = 1.0 / scale;

  const normSrcX = new Float64Array(n);
  const normSrcY = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    normSrcX[i] = (source[i].x - meanX) * invScale;
    normSrcY[i] = (source[i].y - meanY) * invScale;
  }

  const size = n + 3;
  const matrix = Array.from({ length: size }, () => new Float64Array(size));
  const rhsX = new Float64Array(size);
  const rhsY = new Float64Array(size);

  for (let i = 0; i < n; i++) {
    const xi = normSrcX[i];
    const yi = normSrcY[i];
    const row = matrix[i];

    for (let j = i; j < n; j++) {
      if (i === j) {
        row[j] = regularization;
      } else {
        const dx = xi - normSrcX[j];
        const dy = yi - normSrcY[j];
        const k = tpsKernel(dx * dx + dy * dy);
        row[j] = k;
        matrix[j][i] = k;
      }
    }

    row[n] = 1.0;
    row[n + 1] = xi;
    row[n + 2] = yi;

    matrix[n][i] = 1.0;
    matrix[n + 1][i] = xi;
    matrix[n + 2][i] = yi;

    rhsX[i] = destination[i].x;
    rhsY[i] = destination[i].y;
  }

  // Tiny stabilizer on the affine block diagonal in case points are nearly collinear
  const affineStabilizer = options.allowCollinear ? 1e-8 : 0;
  if (affineStabilizer > 0) {
    matrix[n][n] = -affineStabilizer;
    matrix[n + 1][n + 1] = -affineStabilizer;
    matrix[n + 2][n + 2] = -affineStabilizer;
  }

  const solved = solveLinearSystem2D(matrix, rhsX, rhsY);
  if (!solved) {
    if (!options.allowCollinear) {
      return fitTPS(source, destination, { ...options, allowCollinear: true, regularization: Math.max(regularization, 1e-4) });
    }
    return fitAffine2D(source, destination);
  }

  const { cx, cy } = solved;
  const a0x = cx[n];
  const a1x = cx[n + 1];
  const a2x = cx[n + 2];
  const a0y = cy[n];
  const a1y = cy[n + 1];
  const a2y = cy[n + 2];

  return (point) => {
    const px = (point.x - meanX) * invScale;
    const py = (point.y - meanY) * invScale;
    let x = a0x + a1x * px + a2x * py;
    let y = a0y + a1y * px + a2y * py;

    for (let i = 0; i < n; i++) {
      const dx = px - normSrcX[i];
      const dy = py - normSrcY[i];
      const r2 = dx * dx + dy * dy;
      if (r2 > 1e-24) {
        const k = r2 * Math.log(r2);
        x += cx[i] * k;
        y += cy[i] * k;
      }
    }
    return { x, y };
  };
}

/**
 * Fit an Affine-First + Residual Thin Plate Spline (TPS) for hex map alignment:
 *
 * 1. First fits a global 2D Affine transformation (`fitAffine2D`) that captures the global
 *    X-Y scale, aspect-ratio stretch, and skew across the entire map (so even 1 or 2 Refine
 *    corners immediately align the entire map in X and Y, just like Owlbear Rodeo).
 * 2. When 4+ points (or non-affine local hand-drawn distortions) are present, fits a smooth
 *    residual TPS on the non-affine residuals `target[i] - affine(source[i])`, while softly
 *    anchoring unpinned image corners to the global affine plane (`residual = 0`) so corners
 *    never fight the global X-Y scale/skew or fold over.
 *
 * @param {Array<{x: number, y: number}>} sourcePoints
 * @param {Array<{x: number, y: number}>} targetPoints
 * @param {{ x?: number, y?: number, width: number, height: number }} bounds
 * @param {object} [options]
 * @returns {(point: {x: number, y: number}) => {x: number, y: number}}
 */
export function fitBoundedTPS(sourcePoints, targetPoints, bounds, options = {}) {
  const n = sourcePoints.length;
  if (n === 0) return (p) => ({ x: p.x, y: p.y });
  if (n === 1) {
    const dx = targetPoints[0].x - sourcePoints[0].x;
    const dy = targetPoints[0].y - sourcePoints[0].y;
    return (p) => ({ x: p.x + dx, y: p.y + dy });
  }
  if (n === 2) {
    return fitTwoPointTransform(sourcePoints, targetPoints);
  }

  // Step 1: Fit global X-Y scale + skew affine transform
  const affine = fitAffine2D(sourcePoints, targetPoints);

  // Step 2: Compute non-affine residuals at each control point
  const residuals = new Array(n);
  let maxResidual = 0;
  for (let i = 0; i < n; i++) {
    const pred = affine(sourcePoints[i]);
    const rx = targetPoints[i].x - pred.x;
    const ry = targetPoints[i].y - pred.y;
    residuals[i] = { x: rx, y: ry };
    const err = Math.hypot(rx, ry);
    if (err > maxResidual) maxResidual = err;
  }

  // If the global X-Y affine transform already matches all points (e.g. n=3 non-collinear points),
  // return the exact fast affine transform directly!
  if (maxResidual < 1e-3) {
    return affine;
  }

  // Step 3: Fit residual TPS on the local non-affine deviations, anchoring far unpinned corners
  // to the global affine plane (residual = 0) so edges scale/skew globally without extreme bending.
  const bx = bounds?.x ?? 0;
  const by = bounds?.y ?? 0;
  const bw = bounds?.width ?? 1000;
  const bh = bounds?.height ?? 1000;
  const minCornerDist = Math.hypot(bw, bh) * 0.22;

  const srcAll = [...sourcePoints];
  const resAll = [...residuals];

  const corners = [
    { x: bx, y: by },
    { x: bx + bw, y: by },
    { x: bx, y: by + bh },
    { x: bx + bw, y: by + bh }
  ];

  for (const corner of corners) {
    let minDist = Infinity;
    for (let i = 0; i < n; i++) {
      const dist = Math.hypot(corner.x - sourcePoints[i].x, corner.y - sourcePoints[i].y);
      if (dist < minDist) minDist = dist;
    }
    if (minDist > minCornerDist) {
      srcAll.push(corner);
      resAll.push({ x: 0, y: 0 });
    }
  }

  const residualTPS = fitTPS(srcAll, resAll, {
    regularization: options.regularization ?? 1e-6,
    allowCollinear: true
  });

  return (point) => {
    const a = affine(point);
    const r = residualTPS(point);
    return {
      x: a.x + r.x,
      y: a.y + r.y
    };
  };
}
