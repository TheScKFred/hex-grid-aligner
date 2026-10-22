# Hex Grid Aligner (Owlbear Rodeo 2.0 Style) — Foundry VTT (v12 / v13 / v14)

A Foundry VTT module that aligns and warps hand-drawn or imperfectly scaled hexagonal maps (PNG/WebP/JPG) to a perfect Foundry VTT hexagonal grid in 3 intuitive steps (**Offset**, **Size**, **Refine**), combining a **Global 2D Affine Transform (X-Y Skew & Scale)** with a **Residual Thin Plate Spline (TPS)** deformation field.

## Features

- **3-Step Owlbear Rodeo 2.0 Workflow**:
  1. **Offset**: Place the origin anchor on any 3-way hex corner intersection using a **5x magnifying loupe** with a 3-branch hex vertex reticle (`>-` or `-<`).
  2. **Size**: Drag the opposite corner handle (`⤡`) on the reference hexagon to set the initial hex scale while viewing the live orange grid overlay.
  3. **Refine**: Click and drag any corner handle (`⊕`) on the orange grid onto the corresponding hex corner on the map.
     - Placing **1 Refine corner** immediately stretches/scales the entire map in **X and Y** (`scaleX`, `scaleY`).
     - Placing **2+ Refine corners** fits a full **2D Affine X-Y Skew/Scale** across the entire map and applies a smooth **Thin Plate Spline (TPS)** warp for local hand-drawn distortions on a real-time **PIXI Mesh**.
- **Zero-Drift Foundry Grid Sync**:
  - Automatically computes Foundry VTT's integer `grid.size`, matches `foundry.grid.HexagonalGrid` vertices exactly, and updates both `scene.background` (v12/v13) and embedded `scene.levels` backgrounds (v14).
  - Non-destructive: your original map image is never overwritten; a new warped PNG is saved in `worlds/<world-id>/hex-grid-aligner/`.

## Project Structure

- `module.json` — Foundry VTT module manifest (compatible with v12, v13, and v14).
- `scripts/tps.js` — Standalone 2D Affine (X-Y Scale/Skew) + Thin Plate Spline (TPS) solver (`fitTwoPointTransform`, `fitAffine2D`, `fitTPS`, `fitBoundedTPS`).
- `scripts/hex-math.js` — Hexagonal geometry (`flat-top` and `pointy-top`), vertex parities (`>-` and `-<`), nearest vertex snapping, and `foundry.grid.HexagonalGrid` vertex synchronization.
- `scripts/warp.js` — High-performance offscreen canvas image warping (`warpPixelBuffer`, `warpImage`) using inverse TPS + bilinear interpolation.
- `scripts/main.js` — Foundry VTT integration (scene controls, Owlbear Rodeo stepper & dock UI, 5x circular loupe, real-time PIXI Mesh preview, PNG upload, and scene/level update).
- `styles/aligner.css` — Floating UI styling inspired by Owlbear Rodeo 2.0.
- `tests/test-tps-and-hex.mjs` — Standalone Node.js unit test suite (`node tests/test-tps-and-hex.mjs`).

## Installation

In Foundry VTT, go to **Add-on Modules → Install Module**, paste this **Manifest URL** at the bottom, and click **Install**:

```
https://github.com/TheScKFred/hex-grid-aligner/releases/latest/download/module.json
```

Foundry will then notify you of updates automatically whenever a new release is published.

<details>
<summary>Manual installation</summary>

Download `module.zip` from the [latest release](https://github.com/TheScKFred/hex-grid-aligner/releases/latest) and extract it into `Data/modules/hex-grid-aligner/`.
</details>

### Publishing a new version (maintainers)

1. Bump `version` in `module.json` (optional — the workflow stamps it from the tag).
2. Create a GitHub Release tagged `vX.Y.Z`. The `Release` workflow (`.github/workflows/release.yml`) runs the tests, builds `module.zip`, and attaches `module.json` + `module.zip` to the release.

## Usage in Foundry VTT

1. Enable **Hex Grid Aligner (Owlbear Style)** in your world (**Manage Modules**).
2. Open the scene containing your hex map and click the **Align Hex Grid** button (hexagon icon in the Token controls toolbar on the left, or run `HexGridAligner.open()` in the console).
3. **Step 1 — Offset**:
   - Choose the hex orientation (**Flat-Top ⬢** or **Pointy-Top ⬡**) and vertex type (**Vertex >-** or **Vertex -<**) in the bottom dock.
   - Aim at a 3-way corner intersection on your map using the **5x circular loupe** and click: this places the origin and automatically advances to **Size**.
4. **Step 2 — Size**:
   - Drag the `⤡` handle onto the opposite corner of the reference hexagon on your map to match its size, then click **Next: Refine →**.
5. **Step 3 — Refine**:
   - Hover over a hex corner on the orange grid (e.g., on the opposite side of the map) where the grid drifts from the map artwork, then **click and drag the `⊕` handle** until the 3-ray loupe crosshair sits on the map's drawn hex corner.
   - Right-click any placed `⊕` point to remove it.
   - Click **✓ Apply to Scene** to generate the aligned PNG, update the scene/level background automatically, and synchronize the Foundry hex grid.
