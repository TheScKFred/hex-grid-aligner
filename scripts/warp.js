import { fitBoundedTPS, fitTPS } from "./tps.js";

/**
 * Sample RGBA pixel from `src` buffer using bilinear interpolation.
 * Writes 4 bytes into `dst` at `dstOffset`.
 *
 * @param {Uint8ClampedArray|Uint8Array} src
 * @param {number} width
 * @param {number} height
 * @param {number} sx Source X coordinate (floating-point)
 * @param {number} sy Source Y coordinate (floating-point)
 * @param {Uint8ClampedArray|Uint8Array} dst
 * @param {number} dstOffset Byte index in dst (`(y * width + x) * 4`)
 */
export function sampleBilinear(src, width, height, sx, sy, dst, dstOffset) {
  if (sx < 0 || sy < 0 || sx >= width - 1 || sy >= height - 1) {
    if (sx < -0.5 || sy < -0.5 || sx >= width - 0.5 || sy >= height - 0.5) {
      return;
    }
    const cx = Math.max(0, Math.min(width - 1, Math.round(sx)));
    const cy = Math.max(0, Math.min(height - 1, Math.round(sy)));
    const si = (cy * width + cx) * 4;
    dst[dstOffset] = src[si];
    dst[dstOffset + 1] = src[si + 1];
    dst[dstOffset + 2] = src[si + 2];
    dst[dstOffset + 3] = src[si + 3];
    return;
  }

  const x0 = sx | 0;
  const y0 = sy | 0;
  const fx = sx - x0;
  const fy = sy - y0;
  const ifx = 1 - fx;
  const ify = 1 - fy;

  const w00 = ifx * ify;
  const w10 = fx * ify;
  const w01 = ifx * fy;
  const w11 = fx * fy;

  const row0 = y0 * width + x0;
  const i00 = row0 * 4;
  const i10 = i00 + 4;
  const i01 = (row0 + width) * 4;
  const i11 = i01 + 4;

  dst[dstOffset] = (src[i00] * w00 + src[i10] * w10 + src[i01] * w01 + src[i11] * w11 + 0.5) | 0;
  dst[dstOffset + 1] = (src[i00 + 1] * w00 + src[i10 + 1] * w10 + src[i01 + 1] * w01 + src[i11 + 1] * w11 + 0.5) | 0;
  dst[dstOffset + 2] = (src[i00 + 2] * w00 + src[i10 + 2] * w10 + src[i01 + 2] * w01 + src[i11 + 2] * w11 + 0.5) | 0;
  dst[dstOffset + 3] = (src[i00 + 3] * w00 + src[i10 + 3] * w10 + src[i01 + 3] * w01 + src[i11 + 3] * w11 + 0.5) | 0;
}

/**
 * Pure buffer-level image warp using an inverse Thin Plate Spline (`targetPoints -> sourcePoints`).
 * Testable in Node.js without a browser DOM.
 *
 * @param {Uint8ClampedArray|Uint8Array} srcData RGBA source pixel array of length `width * height * 4`
 * @param {number} width Image width in pixels
 * @param {number} height Image height in pixels
 * @param {Array<{x: number, y: number}>} sourcePoints Control points clicked on the original image
 * @param {Array<{x: number, y: number}>} targetPoints Corresponding ideal grid target points
 * @param {object} [options]
 * @param {number} [options.cellSize=8] Grid subdivision size for fast TPS field interpolation (1 = exact per-pixel)
 * @param {boolean} [options.bilinear=true] Whether to use bilinear pixel interpolation
 * @param {boolean} [options.bounded=true] Whether to anchor unpinned image corners smoothly
 * @returns {Uint8ClampedArray} Warped RGBA pixel buffer
 */
export function warpPixelBuffer(
  srcData,
  width,
  height,
  sourcePoints,
  targetPoints,
  options = {}
) {
  const cellSize = Math.max(1, options.cellSize ?? 8);
  const bilinear = options.bilinear ?? true;
  const bounded = options.bounded ?? true;

  const inverse = bounded
    ? fitBoundedTPS(targetPoints, sourcePoints, { x: 0, y: 0, width, height })
    : fitTPS(targetPoints, sourcePoints);

  const dstData = new Uint8ClampedArray(width * height * 4);

  if (cellSize === 1) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const p = inverse({ x, y });
        const di = (y * width + x) * 4;
        if (bilinear) {
          sampleBilinear(srcData, width, height, p.x, p.y, dstData, di);
        } else {
          const sx = Math.round(p.x);
          const sy = Math.round(p.y);
          if (sx >= 0 && sy >= 0 && sx < width && sy < height) {
            const si = (sy * width + sx) * 4;
            dstData[di] = srcData[si];
            dstData[di + 1] = srcData[si + 1];
            dstData[di + 2] = srcData[si + 2];
            dstData[di + 3] = srcData[si + 3];
          }
        }
      }
    }
    return dstData;
  }

  // Coarse grid evaluation + bilinear field interpolation within each cellSize x cellSize block
  const gridW = Math.ceil(width / cellSize) + 1;
  const gridH = Math.ceil(height / cellSize) + 1;
  const gridX = new Float32Array(gridW * gridH);
  const gridY = new Float32Array(gridW * gridH);

  for (let gy = 0; gy < gridH; gy++) {
    const py = Math.min(height, gy * cellSize);
    for (let gx = 0; gx < gridW; gx++) {
      const px = Math.min(width, gx * cellSize);
      const mapped = inverse({ x: px, y: py });
      const idx = gy * gridW + gx;
      gridX[idx] = mapped.x;
      gridY[idx] = mapped.y;
    }
  }

  for (let gy = 0; gy < gridH - 1; gy++) {
    const yStart = gy * cellSize;
    const yEnd = Math.min(height, yStart + cellSize);
    const spanY = Math.max(1, yEnd - yStart);

    for (let gx = 0; gx < gridW - 1; gx++) {
      const xStart = gx * cellSize;
      const xEnd = Math.min(width, xStart + cellSize);
      const spanX = Math.max(1, xEnd - xStart);

      const i00 = gy * gridW + gx;
      const i10 = i00 + 1;
      const i01 = i00 + gridW;
      const i11 = i01 + 1;

      const sx00 = gridX[i00], sy00 = gridY[i00];
      const sx10 = gridX[i10], sy10 = gridY[i10];
      const sx01 = gridX[i01], sy01 = gridY[i01];
      const sx11 = gridX[i11], sy11 = gridY[i11];

      for (let y = yStart; y < yEnd; y++) {
        const ty = (y - yStart) / spanY;
        const ity = 1 - ty;
        const leftX = sx00 * ity + sx01 * ty;
        const rightX = sx10 * ity + sx11 * ty;
        const leftY = sy00 * ity + sy01 * ty;
        const rightY = sy10 * ity + sy11 * ty;

        const stepX = (rightX - leftX) / spanX;
        const stepY = (rightY - leftY) / spanX;

        let sx = leftX;
        let sy = leftY;
        let di = (y * width + xStart) * 4;

        if (bilinear) {
          for (let x = xStart; x < xEnd; x++) {
            sampleBilinear(srcData, width, height, sx, sy, dstData, di);
            sx += stepX;
            sy += stepY;
            di += 4;
          }
        } else {
          for (let x = xStart; x < xEnd; x++) {
            const rx = Math.round(sx);
            const ry = Math.round(sy);
            if (rx >= 0 && ry >= 0 && rx < width && ry < height) {
              const si = (ry * width + rx) * 4;
              dstData[di] = srcData[si];
              dstData[di + 1] = srcData[si + 1];
              dstData[di + 2] = srcData[si + 2];
              dstData[di + 3] = srcData[si + 3];
            }
            sx += stepX;
            sy += stepY;
            di += 4;
          }
        }
      }
    }
  }

  return dstData;
}

/**
 * Resample a browser Image / HTMLCanvasElement into a new offscreen HTMLCanvasElement
 * using the inverse of a fitted Thin Plate Spline.
 *
 * @param {HTMLImageElement|HTMLCanvasElement} sourceImage
 * @param {Array<{x: number, y: number}>} sourcePoints Control points in image pixel coordinates
 * @param {Array<{x: number, y: number}>} targetPoints Target points in image pixel coordinates
 * @param {object} [options]
 * @param {number} [options.width] Output canvas width
 * @param {number} [options.height] Output canvas height
 * @param {number} [options.cellSize=8] TPS coarse grid step in pixels
 * @param {boolean} [options.bilinear=true] Use bilinear pixel resampling
 * @param {(progress: number) => void} [options.onProgress] Optional progress callback (0..1)
 * @returns {Promise<HTMLCanvasElement>}
 */
export async function warpImage(
  sourceImage,
  sourcePoints,
  targetPoints,
  options = {}
) {
  const width = options.width ?? sourceImage.naturalWidth ?? sourceImage.width;
  const height = options.height ?? sourceImage.naturalHeight ?? sourceImage.height;
  const cellSize = Math.max(1, options.cellSize ?? 8);
  const bilinear = options.bilinear ?? true;
  const onProgress = options.onProgress;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(sourceImage, 0, 0, width, height);

  const original = context.getImageData(0, 0, width, height);
  const output = context.createImageData(width, height);
  const srcData = original.data;
  const dstData = output.data;

  const inverse = fitBoundedTPS(targetPoints, sourcePoints, { x: 0, y: 0, width, height });

  const gridW = Math.ceil(width / cellSize) + 1;
  const gridH = Math.ceil(height / cellSize) + 1;
  const gridX = new Float32Array(gridW * gridH);
  const gridY = new Float32Array(gridW * gridH);

  for (let gy = 0; gy < gridH; gy++) {
    const py = Math.min(height, gy * cellSize);
    for (let gx = 0; gx < gridW; gx++) {
      const px = Math.min(width, gx * cellSize);
      const mapped = inverse({ x: px, y: py });
      const idx = gy * gridW + gx;
      gridX[idx] = mapped.x;
      gridY[idx] = mapped.y;
    }
  }

  const rowsPerYield = Math.max(8, Math.floor(256 / cellSize));
  for (let gy = 0; gy < gridH - 1; gy++) {
    const yStart = gy * cellSize;
    const yEnd = Math.min(height, yStart + cellSize);
    const spanY = Math.max(1, yEnd - yStart);

    for (let gx = 0; gx < gridW - 1; gx++) {
      const xStart = gx * cellSize;
      const xEnd = Math.min(width, xStart + cellSize);
      const spanX = Math.max(1, xEnd - xStart);

      const i00 = gy * gridW + gx;
      const i10 = i00 + 1;
      const i01 = i00 + gridW;
      const i11 = i01 + 1;

      const sx00 = gridX[i00], sy00 = gridY[i00];
      const sx10 = gridX[i10], sy10 = gridY[i10];
      const sx01 = gridX[i01], sy01 = gridY[i01];
      const sx11 = gridX[i11], sy11 = gridY[i11];

      for (let y = yStart; y < yEnd; y++) {
        const ty = (y - yStart) / spanY;
        const ity = 1 - ty;
        const leftX = sx00 * ity + sx01 * ty;
        const rightX = sx10 * ity + sx11 * ty;
        const leftY = sy00 * ity + sy01 * ty;
        const rightY = sy10 * ity + sy11 * ty;

        const stepX = (rightX - leftX) / spanX;
        const stepY = (rightY - leftY) / spanX;

        let sx = leftX;
        let sy = leftY;
        let di = (y * width + xStart) * 4;

        if (bilinear) {
          for (let x = xStart; x < xEnd; x++) {
            sampleBilinear(srcData, width, height, sx, sy, dstData, di);
            sx += stepX;
            sy += stepY;
            di += 4;
          }
        } else {
          for (let x = xStart; x < xEnd; x++) {
            const rx = Math.round(sx);
            const ry = Math.round(sy);
            if (rx >= 0 && ry >= 0 && rx < width && ry < height) {
              const si = (ry * width + rx) * 4;
              dstData[di] = srcData[si];
              dstData[di + 1] = srcData[si + 1];
              dstData[di + 2] = srcData[si + 2];
              dstData[di + 3] = srcData[si + 3];
            }
            sx += stepX;
            sy += stepY;
            di += 4;
          }
        }
      }
    }

    if (gy % rowsPerYield === 0 && typeof onProgress === "function") {
      onProgress(gy / (gridH - 1));
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  if (typeof onProgress === "function") onProgress(1);
  context.putImageData(output, 0, 0);
  return canvas;
}
