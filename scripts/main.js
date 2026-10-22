import { fitBoundedTPS } from "./tps.js";
import { warpImage } from "./warp.js";
import {
  getVertexRayAngles,
  getReferenceHexCenter,
  getHexVertices,
  getDefaultSizeHandle,
  computeRadiusFromHandle,
  nearestHexVertex,
  getHexesInBounds,
  findNearestMatchingGridVertex,
  computeFoundryGridAlignment
} from "./hex-math.js";

const MODULE_ID = "hex-grid-aligner";

/**
 * Application state for the 3-step Owlbear Rodeo style Hex Grid Aligner.
 */
const state = {
  active: false,
  step: "offset", // "offset" | "size" | "refine"
  orientation: "flat", // "flat" (flat-top) | "pointy" (pointy-top)
  originParity: 0, // 0 (">-" vertex) | 1 ("-<" vertex)
  origin: null, // { x, y } in scene world coordinates
  handle: null, // { x, y } in scene world coordinates (Step 2 Size handle)
  radius: 60, // Hex circumradius R in scene world pixels
  controls: [], // Array of { key, vertexScene: {x,y}, source: {x,y}, target: {x,y}, parity: 0|1 }
  toolMode: "align", // "align" | "pan"
  loupeAlways: true,
  loupeScale: 5,

  // Dragging state
  dragging: null, // null | { type: "origin" | "size" | "refine", controlIndex?: number, startWorld?: {x,y}, startSource?: {x,y} }
  cursorWorld: null,
  cursorScreen: null,
  hoveredControlIndex: -1,
  hoveredVertex: null,

  // Cached TPS functions in image pixel space
  forwardTPS: null, // sourceImgPt -> targetImgPt
  inverseTPS: null, // targetImgPt -> sourceImgPt

  // Foundry / DOM / PIXI references
  scene: null,
  sourceImage: null,
  sourceCanvas: null,
  rootEl: null,
  dockEl: null,
  loupeCanvas: null,
  pixiContainer: null,
  bgCoverGraphics: null,
  previewMesh: null,
  meshGeometry: null,
  meshCols: 48,
  meshRows: 48,
  gridGraphics: null,
  uiGraphics: null,
  savedGridVisible: null,
  lastToggleTime: 0
};

/**
 * Determine Foundry VTT grid type constant from orientation ("flat" | "pointy").
 */
function getFoundryGridType(orientation, even = true) {
  const types = globalThis.CONST?.GRID_TYPES ?? {
    HEXODDR: 2,
    HEXEVENR: 3,
    HEXODDQ: 4,
    HEXEVENQ: 5
  };
  if (orientation === "flat") {
    return even ? types.HEXEVENQ : types.HEXODDQ;
  }
  return even ? types.HEXEVENR : types.HEXODDR;
}

/* -------------------------------------------------------------------------- */
/*  Foundry VTT Hooks (v12, v13, v14 compatible)                              */
/* -------------------------------------------------------------------------- */

Hooks.once("init", () => {
  console.info(`${MODULE_ID} | Initializing Hex Grid Aligner`);
  const mod = game.modules?.get(MODULE_ID);
  if (mod) {
    mod.api = {
      open: openAligner,
      close: closeAligner,
      toggle: toggleAligner
    };
  }
  globalThis.HexGridAligner = {
    open: openAligner,
    close: closeAligner,
    toggle: toggleAligner
  };
});

Hooks.on("canvasReady", () => {
  if (state.active) {
    closeAligner();
  }
});

Hooks.on("getSceneControlButtons", (controls) => {
  const isGM = game.user?.isGM ?? true;
  if (!isGM) return;

  const toolDef = {
    name: MODULE_ID,
    title: "Align Hex Grid (Owlbear Style)",
    icon: "fa-solid fa-hexagon-nodes",
    button: true,
    visible: true,
    onClick: () => triggerToolbarButton(),
    onChange: () => triggerToolbarButton()
  };

  // Foundry v12: `controls` is an Array of control groups, `tools` is an Array
  if (Array.isArray(controls)) {
    const group =
      controls.find((c) => c.name === "token" || c.name === "tokens") ??
      controls.find((c) => c.name === "tiles") ??
      controls[0];
    if (group && Array.isArray(group.tools)) {
      if (!group.tools.some((t) => t.name === MODULE_ID)) {
        group.tools.push(toolDef);
      }
    }
    return;
  }

  // Foundry v13 / v14: `controls` is an Object keyed by group name, `tools` is an Object
  if (controls && typeof controls === "object") {
    const group = controls.tokens ?? controls.token ?? controls.tiles ?? Object.values(controls)[0];
    if (!group) return;
    if (Array.isArray(group.tools)) {
      if (!group.tools.some((t) => t.name === MODULE_ID)) {
        group.tools.push(toolDef);
      }
    } else {
      group.tools ??= {};
      group.tools[MODULE_ID] = {
        ...toolDef,
        order: Object.keys(group.tools).length + 1
      };
    }
  }
});

function triggerToolbarButton() {
  const now = performance.now();
  if (now - state.lastToggleTime < 250) return;
  state.lastToggleTime = now;
  toggleAligner();
}

export function toggleAligner() {
  if (state.active) {
    closeAligner();
  } else {
    openAligner();
  }
}

/* -------------------------------------------------------------------------- */
/*  Coordinate Conversion Helpers                                             */
/* -------------------------------------------------------------------------- */

function getCanvasView() {
  return canvas?.app?.canvas ?? canvas?.app?.view;
}

function getSceneBounds() {
  const d = canvas?.dimensions;
  return {
    x: d?.sceneX ?? 0,
    y: d?.sceneY ?? 0,
    width: d?.sceneWidth ?? state.sourceImage?.naturalWidth ?? 1000,
    height: d?.sceneHeight ?? state.sourceImage?.naturalHeight ?? 1000
  };
}

/**
 * Convert a DOM PointerEvent / MouseEvent to Foundry scene world coordinates `{ x, y }`.
 */
function eventToWorldPoint(event) {
  const view = getCanvasView();
  const rect = view.getBoundingClientRect();
  const screenPt = new PIXI.Point(event.clientX - rect.left, event.clientY - rect.top);
  const local = canvas.stage.toLocal(screenPt);
  return { x: local.x, y: local.y };
}

/**
 * Convert Foundry scene world coordinates `{ x, y }` to source image pixel coordinates `{ x, y }`.
 */
function worldToImagePoint(worldPt) {
  const b = getSceneBounds();
  const imgW = state.sourceImage.naturalWidth || state.sourceImage.width;
  const imgH = state.sourceImage.naturalHeight || state.sourceImage.height;
  return {
    x: ((worldPt.x - b.x) * imgW) / b.width,
    y: ((worldPt.y - b.y) * imgH) / b.height
  };
}

/**
 * Convert source image pixel coordinates `{ x, y }` to Foundry scene world coordinates `{ x, y }`.
 */
function imageToWorldPoint(imgPt) {
  const b = getSceneBounds();
  const imgW = state.sourceImage.naturalWidth || state.sourceImage.width;
  const imgH = state.sourceImage.naturalHeight || state.sourceImage.height;
  return {
    x: b.x + (imgPt.x * b.width) / imgW,
    y: b.y + (imgPt.y * b.height) / imgH
  };
}

/* -------------------------------------------------------------------------- */
/*  Lifecycle: Open & Close Aligner                                           */
/* -------------------------------------------------------------------------- */

/**
 * Retrieve the active embedded Level document on a Foundry VTT v14 Scene (if present).
 */
function getActiveSceneLevel(scene) {
  if (!scene?.levels) return null;
  return (
    (canvas?.level?.id && scene.levels.get?.(canvas.level.id)) ||
    scene.levels.get?.("defaultLevel0000") ||
    scene.levels.contents?.[0] ||
    Array.from(scene.levels)[0] ||
    null
  );
}

/**
 * Retrieve the background image source path across Foundry VTT v12, v13, and v14 (Scene Levels).
 */
function getSceneBackgroundSrc(scene) {
  const activeLevel = getActiveSceneLevel(scene);
  return (
    activeLevel?.background?.src ??
    activeLevel?._source?.background?.src ??
    scene?.background?.src ??
    scene?._source?.background?.src ??
    null
  );
}

export function openAligner() {
  if (!game.user?.isGM) {
    return ui.notifications?.warn("Only the GM can align the scene grid.");
  }
  if (!canvas?.scene) {
    return ui.notifications?.warn("No active scene.");
  }

  closeAligner();

  const scene = canvas.scene;
  const bgSrc = getSceneBackgroundSrc(scene);
  if (!bgSrc) {
    return ui.notifications?.error("The active scene does not have a background image.");
  }

  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => {
    try {
      initializeAlignerState(scene, img);
      mountDOM();
      mountPIXIOverlay();
      bindCanvasEvents();
      renderAll();
    } catch (err) {
      console.error(`${MODULE_ID} | Failed to open aligner:`, err);
      ui.notifications?.error(`Could not open Hex Grid Aligner: ${err.message}`);
      closeAligner();
    }
  };
  img.onerror = () => {
    ui.notifications?.error("Could not load the scene background image.");
  };
  img.src = bgSrc;
}

function initializeAlignerState(scene, img) {
  state.active = true;
  state.scene = scene;
  state.sourceImage = img;

  // Create an offscreen canvas of the source image for fast Loupe rendering
  const srcCanvas = document.createElement("canvas");
  srcCanvas.width = img.naturalWidth || img.width;
  srcCanvas.height = img.naturalHeight || img.height;
  const ctx = srcCanvas.getContext("2d");
  ctx.drawImage(img, 0, 0);
  state.sourceCanvas = srcCanvas;

  // Detect initial orientation and radius from the scene's existing grid
  const currentType = scene.grid?.type ?? 1;
  const types = globalThis.CONST?.GRID_TYPES ?? {};
  if (currentType === types.HEXODDR || currentType === types.HEXEVENR) {
    state.orientation = "pointy";
  } else {
    state.orientation = "flat";
  }

  const sceneGridSize = scene.grid?.size || 100;
  state.radius = Math.max(20, sceneGridSize / Math.sqrt(3));
  state.originParity = 0;
  state.step = "offset";
  state.origin = null;
  state.handle = null;
  state.controls = [];
  state.dragging = null;
  state.hoveredControlIndex = -1;
  state.hoveredVertex = null;
  state.forwardTPS = null;
  state.inverseTPS = null;
  state.toolMode = "align";
}

export function closeAligner() {
  state.active = false;
  state.dragging = null;

  unbindCanvasEvents();

  if (state.savedGridVisible !== null) {
    const gridMesh = canvas?.interface?.grid?.mesh ?? canvas?.grid;
    if (gridMesh && "visible" in gridMesh) {
      gridMesh.visible = state.savedGridVisible;
    }
    state.savedGridVisible = null;
  }

  if (state.rootEl) {
    state.rootEl.remove();
    state.rootEl = null;
  }
  if (state.dockEl) {
    state.dockEl.remove();
    state.dockEl = null;
  }
  if (state.loupeCanvas) {
    state.loupeCanvas.remove();
    state.loupeCanvas = null;
  }

  if (state.pixiContainer) {
    if (state.pixiContainer.parent) {
      state.pixiContainer.parent.removeChild(state.pixiContainer);
    }
    state.pixiContainer.destroy({ children: true });
    state.pixiContainer = null;
    state.bgCoverGraphics = null;
    state.previewMesh = null;
    state.meshGeometry = null;
    state.gridGraphics = null;
    state.uiGraphics = null;
  }
}

/* -------------------------------------------------------------------------- */
/*  DOM Mounting (Owlbear Rodeo 2.0 Top Stepper + Bottom Dock + Loupe)        */
/* -------------------------------------------------------------------------- */

function mountDOM() {
  // 1. Top Stepper Pill (Owlbear Rodeo 2.0 style)
  const stepper = document.createElement("div");
  stepper.className = "hga-stepper-pill";
  stepper.innerHTML = `
    <button type="button" class="hga-step-btn" data-step-nav="offset">
      <span class="hga-step-icon"></span>
      <span class="hga-step-label">Offset</span>
    </button>
    <div class="hga-step-line" data-line="1"></div>
    <button type="button" class="hga-step-btn" data-step-nav="size">
      <span class="hga-step-icon"></span>
      <span class="hga-step-label">Size</span>
    </button>
    <div class="hga-step-line" data-line="2"></div>
    <button type="button" class="hga-step-btn" data-step-nav="refine">
      <span class="hga-step-icon"></span>
      <span class="hga-step-label">Refine</span>
    </button>
  `;

  // 2. Bottom Floating Control Dock (Owlbear Rodeo 2.0 style)
  const dock = document.createElement("div");
  dock.className = "hga-dock";
  dock.innerHTML = `
    <div class="hga-dock-main">
      <button type="button" class="hga-icon-btn" data-action="mode-pan" title="Pan canvas (or hold Space / Right-click)">
        <i class="fa-solid fa-arrows-up-down-left-right"></i>
      </button>
      <button type="button" class="hga-icon-btn active" data-action="mode-align" title="Align tool (Left-click)">
        <i class="fa-solid fa-crosshairs"></i>
      </button>
      <div class="hga-divider"></div>
      <button type="button" class="hga-pill-btn" data-action="toggle-orientation" title="Toggle hex orientation (Flat-Top / Pointy-Top)">
        <span class="hga-orient-text">Flat-Top ⬢</span>
      </button>
      <button type="button" class="hga-pill-btn" data-action="flip-parity" title="Flip vertex corner type (>- or -<)">
        <span class="hga-parity-text">Vertex &gt;-</span>
      </button>
      <div class="hga-divider"></div>
      <span class="hga-points-badge" title="Control points count (Right-click a point on canvas to delete it)">
        0 pt
      </span>
      <button type="button" class="hga-icon-btn" data-action="undo" title="Undo last control point">
        <i class="fa-solid fa-rotate-left"></i>
      </button>
      <button type="button" class="hga-icon-btn" data-action="reset" title="Reset alignment">
        <i class="fa-solid fa-trash-can"></i>
      </button>
      <div class="hga-divider"></div>
      <button type="button" class="hga-primary-btn" data-action="primary">
        Continue
      </button>
      <button type="button" class="hga-icon-btn hga-close-btn" data-action="close" title="Close aligner (Esc)">
        <i class="fa-solid fa-xmark"></i>
      </button>
    </div>
    <div class="hga-dock-hint"></div>
  `;

  // 3. Circular Magnifying Loupe Canvas
  const loupe = document.createElement("canvas");
  loupe.className = "hga-loupe-canvas";
  loupe.width = 220;
  loupe.height = 220;
  loupe.hidden = true;

  document.body.append(stepper, dock, loupe);
  state.rootEl = stepper;
  state.dockEl = dock;
  state.loupeCanvas = loupe;

  // Stepper navigation listener
  stepper.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-step-nav]");
    if (!btn) return;
    const targetStep = btn.dataset.stepNav;
    navigateToStep(targetStep);
  });

  // Dock actions listener
  dock.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === "close") closeAligner();
    else if (action === "mode-pan") {
      state.toolMode = "pan";
      renderAll();
    } else if (action === "mode-align") {
      state.toolMode = "align";
      renderAll();
    } else if (action === "toggle-orientation") {
      state.orientation = state.orientation === "flat" ? "pointy" : "flat";
      if (state.origin) {
        state.handle = getDefaultSizeHandle(state.origin, state.radius, state.orientation, state.originParity);
      }
      if (state.step === "refine") {
        rebuildRefineBaseControl();
      }
      renderAll();
    } else if (action === "flip-parity") {
      state.originParity = state.originParity === 0 ? 1 : 0;
      if (state.origin) {
        state.handle = getDefaultSizeHandle(state.origin, state.radius, state.orientation, state.originParity);
      }
      if (state.step === "refine") {
        rebuildRefineBaseControl();
      }
      renderAll();
    } else if (action === "undo") {
      if (state.step === "refine" && state.controls.length > 1) {
        state.controls.pop();
        updateTPSAndMesh();
        renderAll();
      }
    } else if (action === "reset") {
      resetAligner();
    } else if (action === "primary") {
      onPrimaryAction();
    }
  });
}

function navigateToStep(targetStep) {
  if (targetStep === "offset") {
    state.step = "offset";
    renderAll();
  } else if (targetStep === "size") {
    if (!state.origin) {
      const b = getSceneBounds();
      state.origin = { x: b.x + b.width * 0.5, y: b.y + b.height * 0.5 };
    }
    if (!state.handle) {
      state.handle = getDefaultSizeHandle(state.origin, state.radius, state.orientation, state.originParity);
    }
    state.step = "size";
    renderAll();
  } else if (targetStep === "refine") {
    if (!state.origin) return;
    if (!state.handle) {
      state.handle = getDefaultSizeHandle(state.origin, state.radius, state.orientation, state.originParity);
    }
    enterRefineStep();
  }
}

function enterRefineStep() {
  state.step = "refine";
  if (state.controls.length === 0) {
    rebuildRefineBaseControl();
  } else {
    updateTPSAndMesh();
  }
  renderAll();
}

function rebuildRefineBaseControl() {
  if (!state.origin) return;
  const originImg = worldToImagePoint(state.origin);
  state.controls = [
    {
      key: "origin",
      vertexScene: { x: state.origin.x, y: state.origin.y },
      source: { x: originImg.x, y: originImg.y },
      target: { x: originImg.x, y: originImg.y },
      parity: state.originParity
    }
  ];
  updateTPSAndMesh();
}

function resetAligner() {
  state.step = "offset";
  state.origin = null;
  state.handle = null;
  state.controls = [];
  state.forwardTPS = null;
  state.inverseTPS = null;
  resetMeshVertices();
  renderAll();
}

function onPrimaryAction() {
  if (state.step === "offset") {
    if (!state.origin) {
      ui.notifications?.info("Click on a hex corner intersection on the map first.");
      return;
    }
    navigateToStep("size");
  } else if (state.step === "size") {
    enterRefineStep();
  } else if (state.step === "refine") {
    applyWarpToScene();
  }
}

/* -------------------------------------------------------------------------- */
/*  PIXI Overlay & Real-Time TPS Warping Mesh                                 */
/* -------------------------------------------------------------------------- */

function mountPIXIOverlay() {
  // Temporarily hide Foundry's native grid overlay so only our orange alignment grid is visible
  const gridMesh = canvas?.interface?.grid?.mesh ?? canvas?.grid;
  if (gridMesh && "visible" in gridMesh && state.savedGridVisible === null) {
    state.savedGridVisible = gridMesh.visible;
    gridMesh.visible = false;
  }

  const container = new PIXI.Container();
  container.name = MODULE_ID;
  container.sortableChildren = true;
  // Place high on canvas.stage or canvas.primary so it renders above the scene background
  container.zIndex = 9999;

  // 0. Solid backdrop cover behind the warped previewMesh so the unwarped scene background
  // never bleeds through around the edges when the image is skewed/scaled in Refine
  const bgCoverGraphics = new PIXI.Graphics();
  bgCoverGraphics.zIndex = 0;
  container.addChild(bgCoverGraphics);
  state.bgCoverGraphics = bgCoverGraphics;

  // 1. Live-warped background preview mesh (visible during Refine when points are placed)
  const previewMesh = createLivePreviewMesh();
  if (previewMesh) {
    previewMesh.zIndex = 1;
    previewMesh.visible = false;
    container.addChild(previewMesh);
    state.previewMesh = previewMesh;
  }

  // 2. Hex grid overlay graphics
  const gridGraphics = new PIXI.Graphics();
  gridGraphics.zIndex = 2;
  container.addChild(gridGraphics);
  state.gridGraphics = gridGraphics;

  // 3. Interactive handles & control points graphics
  const uiGraphics = new PIXI.Graphics();
  uiGraphics.zIndex = 3;
  container.addChild(uiGraphics);
  state.uiGraphics = uiGraphics;

  canvas.stage.addChild(container);
  state.pixiContainer = container;
}

/**
 * Create a subdivisible PIXI Mesh over the scene bounds so the image can be
 * deformed in real time by the Thin Plate Spline during Step 3 (Refine).
 */
function createLivePreviewMesh() {
  try {
    const cols = state.meshCols;
    const rows = state.meshRows;
    const numVerts = (cols + 1) * (rows + 1);
    const positions = new Float32Array(numVerts * 2);
    const uvs = new Float32Array(numVerts * 2);
    const indices = new Uint16Array(cols * rows * 6);

    const b = getSceneBounds();
    let vIdx = 0;
    for (let r = 0; r <= rows; r++) {
      const v = r / rows;
      for (let c = 0; c <= cols; c++) {
        const u = c / cols;
        positions[vIdx] = b.x + u * b.width;
        positions[vIdx + 1] = b.y + v * b.height;
        uvs[vIdx] = u;
        uvs[vIdx + 1] = v;
        vIdx += 2;
      }
    }

    let iIdx = 0;
    const stride = cols + 1;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const tl = r * stride + c;
        const tr = tl + 1;
        const bl = tl + stride;
        const br = bl + 1;
        indices[iIdx++] = tl;
        indices[iIdx++] = tr;
        indices[iIdx++] = bl;
        indices[iIdx++] = tr;
        indices[iIdx++] = br;
        indices[iIdx++] = bl;
      }
    }

    const texture = PIXI.Texture.from(state.sourceCanvas ?? state.sourceImage);

    // PIXI v7 SimpleMesh / PIXI v8 MeshSimple / fallback PIXI.Mesh
    if (typeof PIXI.SimpleMesh === "function") {
      const mesh = new PIXI.SimpleMesh(texture, positions, uvs, indices, PIXI.DRAW_MODES?.TRIANGLES ?? 4);
      state.meshGeometry = { positions, uvs, indices, mesh };
      return mesh;
    }
    if (typeof PIXI.MeshSimple === "function") {
      const mesh = new PIXI.MeshSimple({ texture, vertices: positions, uvs, indices });
      state.meshGeometry = { positions, uvs, indices, mesh };
      return mesh;
    }
    if (typeof PIXI.MeshGeometry === "function" && typeof PIXI.Mesh === "function") {
      const geom = new PIXI.MeshGeometry(positions, uvs, indices);
      const mat = new PIXI.MeshMaterial(texture);
      const mesh = new PIXI.Mesh(geom, mat);
      state.meshGeometry = { positions, uvs, indices, geom, mesh };
      return mesh;
    }
  } catch (err) {
    console.warn(`${MODULE_ID} | Live preview mesh fallback:`, err);
  }
  return null;
}

function resetMeshVertices() {
  if (!state.meshGeometry || !state.previewMesh) return;
  const { positions, mesh, geom } = state.meshGeometry;
  const cols = state.meshCols;
  const rows = state.meshRows;
  const b = getSceneBounds();

  let vIdx = 0;
  for (let r = 0; r <= rows; r++) {
    const v = r / rows;
    for (let c = 0; c <= cols; c++) {
      const u = c / cols;
      positions[vIdx++] = b.x + u * b.width;
      positions[vIdx++] = b.y + v * b.height;
    }
  }
  markMeshBufferDirty(mesh, geom);
  state.previewMesh.visible = false;
}

function markMeshBufferDirty(mesh, geom) {
  try {
    if (mesh?.geometry?.buffers?.[0]) {
      mesh.geometry.buffers[0].update();
    } else if (geom?.buffers?.[0]) {
      geom.buffers[0].update();
    } else if (mesh?.geometry?.getBuffer) {
      mesh.geometry.getBuffer("aVertexPosition")?.update();
    }
  } catch (_err) {
    // Ignore buffer update differences across PIXI versions
  }
}

/**
 * Recompute forward and inverse TPS from `state.controls` and deform the PIXI preview mesh in real time.
 */
function updateTPSAndMesh() {
  if (state.controls.length === 0) {
    state.forwardTPS = null;
    state.inverseTPS = null;
    resetMeshVertices();
    return;
  }

  const imgW = state.sourceImage.naturalWidth || state.sourceImage.width;
  const imgH = state.sourceImage.naturalHeight || state.sourceImage.height;
  const bounds = { x: 0, y: 0, width: imgW, height: imgH };

  const srcPts = state.controls.map((c) => c.source);
  const dstPts = state.controls.map((c) => c.target);

  state.forwardTPS = fitBoundedTPS(srcPts, dstPts, bounds);
  state.inverseTPS = fitBoundedTPS(dstPts, srcPts, bounds);

  if (!state.meshGeometry || !state.previewMesh) return;

  const { positions, mesh, geom } = state.meshGeometry;
  const cols = state.meshCols;
  const rows = state.meshRows;
  const b = getSceneBounds();

  let vIdx = 0;
  for (let r = 0; r <= rows; r++) {
    const v = r / rows;
    const srcY = v * imgH;
    for (let c = 0; c <= cols; c++) {
      const u = c / cols;
      const srcX = u * imgW;
      const warpedImgPt = state.forwardTPS({ x: srcX, y: srcY });
      positions[vIdx++] = b.x + (warpedImgPt.x / imgW) * b.width;
      positions[vIdx++] = b.y + (warpedImgPt.y / imgH) * b.height;
    }
  }

  markMeshBufferDirty(mesh, geom);
  state.previewMesh.visible = state.step === "refine";
}

/* -------------------------------------------------------------------------- */
/*  Canvas Mouse / Pointer Event Handling                                     */
/* -------------------------------------------------------------------------- */

function bindCanvasEvents() {
  const view = getCanvasView();
  if (!view) return;
  view.addEventListener("pointermove", onPointerMove, { capture: true });
  view.addEventListener("pointerdown", onPointerDown, { capture: true });
  window.addEventListener("pointerup", onPointerUp, { capture: true });
  view.addEventListener("contextmenu", onContextMenu, { capture: true });
  window.addEventListener("keydown", onKeyDown);
}

function unbindCanvasEvents() {
  const view = getCanvasView();
  if (view) {
    view.removeEventListener("pointermove", onPointerMove, { capture: true });
    view.removeEventListener("pointerdown", onPointerDown, { capture: true });
    view.removeEventListener("contextmenu", onContextMenu, { capture: true });
  }
  window.removeEventListener("pointerup", onPointerUp, { capture: true });
  window.removeEventListener("keydown", onKeyDown);
}

function isPanPassThrough(event) {
  if (state.toolMode === "pan") return true;
  if (event.button === 1 || event.button === 2) return true;
  if (event.spaceKey || event.altKey) return true;
  return false;
}

function onKeyDown(event) {
  if (!state.active) return;
  if (event.key === "Escape") {
    closeAligner();
  }
}

function onPointerDown(event) {
  if (!state.active) return;

  // Right-click in Refine step deletes a control point if hovering near one
  if (event.button === 2 && state.step === "refine") {
    const worldPt = eventToWorldPoint(event);
    const hitIdx = findControlPointNearWorld(worldPt, 18);
    if (hitIdx > 0) {
      // Prevent Foundry canvas right-click pan when deleting a control point
      event.stopPropagation();
      event.preventDefault();
      state.controls.splice(hitIdx, 1);
      state.hoveredControlIndex = -1;
      updateTPSAndMesh();
      renderAll();
      return;
    }
  }

  if (event.button !== 0 || isPanPassThrough(event)) return;

  // Stop Foundry from selecting tokens or dragging canvas on left-click in Align mode
  event.stopPropagation();
  event.preventDefault();

  const worldPt = eventToWorldPoint(event);
  state.cursorWorld = worldPt;
  state.cursorScreen = { x: event.clientX, y: event.clientY };

  if (state.step === "offset") {
    state.origin = { x: worldPt.x, y: worldPt.y };
    state.handle = getDefaultSizeHandle(state.origin, state.radius, state.orientation, state.originParity);
    state.dragging = { type: "origin" };
    renderAll();
    return;
  }

  if (state.step === "size") {
    // Check if user clicked near the origin handle vs the size handle
    if (state.origin && Math.hypot(worldPt.x - state.origin.x, worldPt.y - state.origin.y) < 16) {
      state.dragging = { type: "origin" };
    } else {
      const res = computeRadiusFromHandle(state.origin, worldPt, state.orientation, state.originParity);
      state.radius = res.radius;
      state.handle = res.snappedHandle;
      state.dragging = { type: "size" };
    }
    renderAll();
    return;
  }

  if (state.step === "refine") {
    const baseInverseTPS = state.inverseTPS || ((p) => ({ x: p.x, y: p.y }));

    // 1. Check if clicking an existing control point handle to adjust it
    const existingIdx = findControlPointNearWorld(worldPt, 20);
    if (existingIdx >= 0) {
      const ctrl = state.controls[existingIdx];
      state.dragging = {
        type: "refine",
        controlIndex: existingIdx,
        startWorld: { x: worldPt.x, y: worldPt.y },
        startSource: { x: ctrl.source.x, y: ctrl.source.y },
        baseInverseTPS
      };
      renderAll();
      return;
    }

    // 2. Otherwise, snap to the nearest theoretical hex vertex and create/update a control point!
    const nearest = nearestHexVertex(worldPt, {
      origin: state.origin,
      radius: state.radius,
      orientation: state.orientation,
      originParity: state.originParity
    });

    const clickedImgPt = worldToImagePoint(worldPt);
    // Snapshot the pre-drag inverse TPS so dragging smoothly picks the intended map corner
    // without feedback oscillation as the previewMesh deforms underneath
    const sourceImgPt = baseInverseTPS(clickedImgPt);
    const targetImgPt = worldToImagePoint({ x: nearest.x, y: nearest.y });

    // Check if we already have a control point for this exact grid vertex key
    let controlIndex = state.controls.findIndex((c) => c.key === nearest.key);
    const newControl = {
      key: nearest.key,
      vertexScene: { x: nearest.x, y: nearest.y },
      source: { x: sourceImgPt.x, y: sourceImgPt.y },
      target: { x: targetImgPt.x, y: targetImgPt.y },
      parity: nearest.parity
    };

    if (controlIndex >= 0) {
      state.controls[controlIndex] = newControl;
    } else {
      state.controls.push(newControl);
      controlIndex = state.controls.length - 1;
    }

    updateTPSAndMesh();
    state.dragging = {
      type: "refine",
      controlIndex,
      startWorld: { x: worldPt.x, y: worldPt.y },
      startSource: { x: sourceImgPt.x, y: sourceImgPt.y },
      baseInverseTPS
    };
    renderAll();
  }
}

function onPointerMove(event) {
  if (!state.active) return;

  const worldPt = eventToWorldPoint(event);
  state.cursorWorld = worldPt;
  state.cursorScreen = { x: event.clientX, y: event.clientY };

  if (state.dragging) {
    event.stopPropagation();
    if (state.dragging.type === "origin") {
      state.origin = { x: worldPt.x, y: worldPt.y };
      state.handle = getDefaultSizeHandle(state.origin, state.radius, state.orientation, state.originParity);
      if (state.controls.length > 0) {
        rebuildRefineBaseControl();
      }
    } else if (state.dragging.type === "size") {
      const res = computeRadiusFromHandle(state.origin, worldPt, state.orientation, state.originParity);
      state.radius = res.radius;
      state.handle = res.snappedHandle;
    } else if (state.dragging.type === "refine") {
      const ctrl = state.controls[state.dragging.controlIndex];
      if (ctrl) {
        // Map cursor movement through the pre-drag inverse TPS so moving the loupe reticle onto
        // a map corner pulls that exact map corner onto the orange grid vertex (skewing/scaling X-Y)
        const baseInv = state.dragging.baseInverseTPS || ((p) => p);
        const curImg = worldToImagePoint(worldPt);
        const startImg = worldToImagePoint(state.dragging.startWorld);
        const curSrc = baseInv(curImg);
        const startSrc = baseInv(startImg);
        ctrl.source = {
          x: state.dragging.startSource.x + (curSrc.x - startSrc.x),
          y: state.dragging.startSource.y + (curSrc.y - startSrc.y)
        };
        updateTPSAndMesh();
      }
    }
    renderAll();
    return;
  }

  // Hover state update in Refine
  if (state.step === "refine" && state.origin) {
    state.hoveredControlIndex = findControlPointNearWorld(worldPt, 20);
    state.hoveredVertex = nearestHexVertex(worldPt, {
      origin: state.origin,
      radius: state.radius,
      orientation: state.orientation,
      originParity: state.originParity
    });
  } else {
    state.hoveredControlIndex = -1;
    state.hoveredVertex = null;
  }

  renderAll();
}

function onPointerUp(event) {
  if (!state.active || !state.dragging) return;
  const dragType = state.dragging.type;
  state.dragging = null;

  // Owlbear Rodeo workflow: releasing the click in Step 1 (Offset) automatically advances to Step 2 (Size)!
  if (dragType === "origin" && state.step === "offset" && state.origin) {
    state.step = "size";
  }
  renderAll();
}

function onContextMenu(event) {
  if (!state.active) return;
  if (state.step === "refine") {
    const worldPt = eventToWorldPoint(event);
    const hitIdx = findControlPointNearWorld(worldPt, 20);
    if (hitIdx > 0) {
      event.preventDefault();
      event.stopPropagation();
    }
  }
}

function findControlPointNearWorld(worldPt, maxDistPx = 20) {
  const scale = canvas?.stage?.scale?.x || 1;
  const threshold = maxDistPx / scale;
  let bestIdx = -1;
  let bestDist = threshold;

  for (let i = 0; i < state.controls.length; i++) {
    const v = state.controls[i].vertexScene;
    const d = Math.hypot(v.x - worldPt.x, v.y - worldPt.y);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/* -------------------------------------------------------------------------- */
/*  Rendering: DOM Stepper/Dock, PIXI Grid Overlay, and Circular Loupe        */
/* -------------------------------------------------------------------------- */

function renderAll() {
  renderDOM();
  renderPIXIOverlay();
  renderLoupe();
}

function renderDOM() {
  if (!state.rootEl || !state.dockEl) return;

  const stepsOrder = ["offset", "size", "refine"];
  const currentIdx = stepsOrder.indexOf(state.step);

  // Update top stepper buttons
  state.rootEl.querySelectorAll("[data-step-nav]").forEach((btn) => {
    const s = btn.dataset.stepNav;
    const sIdx = stepsOrder.indexOf(s);
    const isActive = sIdx === currentIdx;
    const isDone = sIdx < currentIdx;

    btn.classList.toggle("active", isActive);
    btn.classList.toggle("done", isDone);

    const iconEl = btn.querySelector(".hga-step-icon");
    if (isDone) {
      iconEl.innerHTML = `<svg viewBox="0 0 16 16" width="12" height="12"><path fill="currentColor" d="M6.2 11.8L2.7 8.3l1.4-1.4 2.1 2.1 5.7-5.7 1.4 1.4z"/></svg>`;
    } else if (isActive) {
      iconEl.innerHTML = `<span class="hga-dot"></span>`;
    } else {
      iconEl.innerHTML = ``;
    }
  });

  // Update connecting lines
  const line1 = state.rootEl.querySelector('[data-line="1"]');
  const line2 = state.rootEl.querySelector('[data-line="2"]');
  if (line1) line1.classList.toggle("done", currentIdx >= 1);
  if (line2) line2.classList.toggle("done", currentIdx >= 2);

  // Update dock buttons
  state.dockEl.querySelector('[data-action="mode-pan"]')?.classList.toggle("active", state.toolMode === "pan");
  state.dockEl.querySelector('[data-action="mode-align"]')?.classList.toggle("active", state.toolMode === "align");

  const orientBtn = state.dockEl.querySelector('[data-action="toggle-orientation"]');
  const orientEl = state.dockEl.querySelector(".hga-orient-text");
  if (orientEl) {
    orientEl.textContent = state.orientation === "flat" ? "Flat-Top ⬢" : "Pointy-Top ⬡";
  }
  if (orientBtn) {
    orientBtn.disabled = state.step === "refine";
  }

  const parityBtn = state.dockEl.querySelector('[data-action="flip-parity"]');
  const parityEl = state.dockEl.querySelector(".hga-parity-text");
  if (parityEl) {
    parityEl.textContent = state.originParity === 0 ? "Vertex >-" : "Vertex -<";
  }
  if (parityBtn) {
    parityBtn.disabled = state.step === "refine";
  }

  const badgeEl = state.dockEl.querySelector(".hga-points-badge");
  if (badgeEl) {
    const count = state.controls.length;
    badgeEl.textContent = `${count} pt${count > 1 ? "s" : ""}`;
  }

  const undoBtn = state.dockEl.querySelector('[data-action="undo"]');
  if (undoBtn) {
    undoBtn.disabled = state.step !== "refine" || state.controls.length <= 1;
  }

  const primaryBtn = state.dockEl.querySelector('[data-action="primary"]');
  if (primaryBtn) {
    if (state.step === "offset") {
      primaryBtn.textContent = "Next: Size →";
      primaryBtn.disabled = !state.origin;
    } else if (state.step === "size") {
      primaryBtn.textContent = "Next: Refine →";
      primaryBtn.disabled = !state.origin || !state.handle;
    } else {
      primaryBtn.textContent = "✓ Apply to Scene";
      primaryBtn.disabled = state.controls.length < 1;
    }
  }

  const hintEl = state.dockEl.querySelector(".hga-dock-hint");
  if (hintEl) {
    const hints = {
      offset: "Step 1 (Offset): Aim the 3-ray loupe crosshair at a hex corner on the map and click.",
      size: "Step 2 (Size): Drag the ⤡ handle onto the opposite corner of that hex to set the initial grid size.",
      refine: "Step 3 (Refine): Click & drag an orange grid corner (⊕) onto the matching map corner (global X-Y skew/scale + local TPS). Right-click a point to remove it."
    };
    hintEl.textContent = hints[state.step];
  }
}

function renderPIXIOverlay() {
  if (!state.gridGraphics || !state.uiGraphics) return;
  const gGrid = state.gridGraphics;
  const gUI = state.uiGraphics;
  const gCover = state.bgCoverGraphics;
  gGrid.clear();
  gUI.clear();
  if (gCover) gCover.clear();

  const showPreviewMesh = state.step === "refine" && state.controls.length > 0;
  if (state.previewMesh) {
    state.previewMesh.visible = showPreviewMesh;
  }

  const sceneBounds = getSceneBounds();
  if (gCover && showPreviewMesh) {
    gCover.beginFill(0x181a20, 1.0);
    gCover.drawRect(sceneBounds.x, sceneBounds.y, sceneBounds.width, sceneBounds.height);
    gCover.endFill();
  }

  const scale = canvas?.stage?.scale?.x || 1;
  const invScale = 1 / scale;

  // In Step 1 (Offset), only draw the origin handle if already placed
  if (state.step === "offset") {
    if (state.origin) {
      drawHandleBadge(gUI, state.origin.x, state.origin.y, "origin", invScale);
    }
    return;
  }

  if (!state.origin) return;

  const gridSpec = {
    origin: state.origin,
    radius: state.radius,
    orientation: state.orientation,
    originParity: state.originParity
  };

  // Draw the full theoretical hexagonal grid overlay in orange (#ff6a00)
  const hexes = getHexesInBounds(sceneBounds, gridSpec);
  const gridAlpha = state.step === "size" ? 0.35 : 0.78;
  const gridLineWidth = Math.max(1.2, 2.0 * invScale);
  gGrid.lineStyle(gridLineWidth, 0xff6a00, gridAlpha);

  for (const vertices of hexes) {
    gGrid.moveTo(vertices[0].x, vertices[0].y);
    for (let k = 1; k < 6; k++) {
      gGrid.lineTo(vertices[k].x, vertices[k].y);
    }
    gGrid.lineTo(vertices[0].x, vertices[0].y);
  }

  // In Step 2 (Size): highlight the primary Reference Hexagon in bold orange (like Owlbear 083435.png)
  if (state.step === "size") {
    const refCenter = getReferenceHexCenter(state.origin, state.radius, state.orientation, state.originParity);
    const refVerts = getHexVertices(refCenter, state.radius, state.orientation);
    gGrid.lineStyle(Math.max(3, 4.5 * invScale), 0xff6a00, 1.0);
    gGrid.moveTo(refVerts[0].x, refVerts[0].y);
    for (let k = 1; k < 6; k++) {
      gGrid.lineTo(refVerts[k].x, refVerts[k].y);
    }
    gGrid.lineTo(refVerts[0].x, refVerts[0].y);

    // Draw Origin pin + Resize Handle (⤡) on opposite vertex
    drawHandleBadge(gUI, state.origin.x, state.origin.y, "origin", invScale);
    if (state.handle) {
      drawHandleBadge(gUI, state.handle.x, state.handle.y, "size", invScale);
    }
    return;
  }

  // In Step 3 (Refine): draw all placed control point handles (⊕) and hovered vertex preview
  if (state.step === "refine") {
    if (state.hoveredVertex && state.hoveredControlIndex < 0 && !state.dragging) {
      if (state.cursorWorld) {
        gUI.lineStyle(1.5 * invScale, 0xff6a00, 0.55);
        gUI.moveTo(state.hoveredVertex.x, state.hoveredVertex.y);
        gUI.lineTo(state.cursorWorld.x, state.cursorWorld.y);
      }
      drawHandleBadge(gUI, state.hoveredVertex.x, state.hoveredVertex.y, "hover", invScale);
    }

    if (state.dragging?.type === "refine" && state.cursorWorld) {
      const draggedCtrl = state.controls[state.dragging.controlIndex];
      if (draggedCtrl) {
        gUI.lineStyle(2 * invScale, 0xff6a00, 0.85);
        gUI.moveTo(draggedCtrl.vertexScene.x, draggedCtrl.vertexScene.y);
        gUI.lineTo(state.cursorWorld.x, state.cursorWorld.y);
      }
    }

    for (let i = 0; i < state.controls.length; i++) {
      const ctrl = state.controls[i];
      const isHovered = i === state.hoveredControlIndex;
      const isOrigin = i === 0;
      drawHandleBadge(
        gUI,
        ctrl.vertexScene.x,
        ctrl.vertexScene.y,
        isOrigin ? "origin-locked" : isHovered ? "refine-active" : "refine",
        invScale
      );
    }
  }
}

/**
 * Draw Owlbear Rodeo style circular dark handle badges with vector icons (`⤡` for Size, `⊕` for Refine).
 */
function drawHandleBadge(g, x, y, type, invScale) {
  const r = 13 * invScale;
  const strokeW = 2 * invScale;

  if (type === "hover") {
    g.lineStyle(strokeW, 0xff6a00, 0.9);
    g.beginFill(0x2b303c, 0.85);
    g.drawCircle(x, y, r * 0.9);
    g.endFill();
    const d = r * 0.48;
    g.lineStyle(1.6 * invScale, 0xff6a00, 0.95);
    g.drawCircle(x, y, r * 0.3);
    g.moveTo(x - d, y);
    g.lineTo(x + d, y);
    g.moveTo(x, y - d);
    g.lineTo(x, y + d);
    return;
  }

  // Outer dark pill circle (#2b303c)
  const fillColor = type === "refine-active" ? 0x7c5cff : 0x2b303c;
  const borderColor = type === "origin" || type === "origin-locked" ? 0x9b7aff : 0xffffff;
  g.lineStyle(strokeW, borderColor, 0.9);
  g.beginFill(fillColor, 0.95);
  g.drawCircle(x, y, r);
  g.endFill();

  // Inner icon
  g.lineStyle(1.8 * invScale, 0xffffff, 0.95);
  if (type === "size") {
    // Diagonal resize arrow ⤡
    const d = r * 0.45;
    g.moveTo(x - d, y - d);
    g.lineTo(x + d, y + d);
    // Arrowheads
    g.moveTo(x - d, y - d + d * 0.6);
    g.lineTo(x - d, y - d);
    g.lineTo(x - d + d * 0.6, y - d);

    g.moveTo(x + d, y + d - d * 0.6);
    g.lineTo(x + d, y + d);
    g.lineTo(x + d - d * 0.6, y + d);
  } else if (type === "refine" || type === "refine-active") {
    // 4-way target crosshair ⊕ (like Owlbear 083516.png)
    const d = r * 0.55;
    g.drawCircle(x, y, r * 0.35);
    g.moveTo(x - d, y);
    g.lineTo(x + d, y);
    g.moveTo(x, y - d);
    g.lineTo(x, y + d);
  } else {
    // Origin center dot
    g.beginFill(0xffffff, 1);
    g.drawCircle(x, y, r * 0.3);
    g.endFill();
  }
}

/**
 * Render the circular magnifying Loupe directly centered on the cursor (Owlbear Rodeo style),
 * complete with the 5x zoomed map and the 3-branch orange hex vertex reticle (`>-` or `-<`).
 */
function renderLoupe() {
  const loupe = state.loupeCanvas;
  if (!loupe || !state.sourceCanvas || !state.cursorWorld || !state.cursorScreen) {
    if (loupe) loupe.hidden = true;
    return;
  }

  // Owlbear Rodeo 2.0 behavior:
  // - In Step 1 (Offset): show loupe while aiming/dragging the origin corner
  // - In Step 2 (Size) & Step 3 (Refine): only show loupe while actively pressing/dragging a handle
  //   so the 220px loupe never blocks the orange hex grid and ⊕ handles while browsing the map!
  const shouldShow =
    state.toolMode === "align" &&
    (state.step === "offset" ||
      (state.step === "size" && Boolean(state.dragging)) ||
      (state.step === "refine" && Boolean(state.dragging)));

  if (!shouldShow) {
    loupe.hidden = true;
    return;
  }

  loupe.hidden = false;
  const size = loupe.width; // 220px
  const half = size / 2;

  // Position the loupe centered directly on the cursor (like Owlbear Rodeo 083237.png & 083524.png)
  loupe.style.left = `${state.cursorScreen.x}px`;
  loupe.style.top = `${state.cursorScreen.y}px`;

  const ctx = loupe.getContext("2d");
  ctx.clearRect(0, 0, size, size);

  ctx.save();
  ctx.beginPath();
  ctx.arc(half, half, half - 3, 0, Math.PI * 2);
  ctx.clip();

  // Background fill inside loupe
  ctx.fillStyle = "#181a20";
  ctx.fillRect(0, 0, size, size);

  // Determine which image point is at the center of the loupe and which vertex parity to display
  let focusWorld = state.cursorWorld;
  let parity = state.originParity;

  if (state.step === "size" && state.handle && state.dragging?.type === "size") {
    focusWorld = state.handle;
    parity = state.originParity === 0 ? 1 : 0;
  } else if (state.step === "refine") {
    if (state.dragging?.type === "refine") {
      const ctrl = state.controls[state.dragging.controlIndex];
      if (ctrl) {
        parity = ctrl.parity;
      }
    } else if (state.hoveredVertex) {
      parity = state.hoveredVertex.parity;
    }
  }

  // Determine source image coordinates to magnify
  const rawImgPt = worldToImagePoint(focusWorld);
  let centerImgPt = rawImgPt;
  if (state.step === "refine") {
    if (state.dragging?.type === "refine") {
      const ctrl = state.controls[state.dragging.controlIndex];
      if (ctrl) centerImgPt = ctrl.source;
    } else if (state.inverseTPS) {
      centerImgPt = state.inverseTPS(rawImgPt);
    }
  }

  const zoom = state.loupeScale; // 5x magnification
  const srcRegionW = size / zoom;
  const srcRegionH = size / zoom;
  const sx = centerImgPt.x - srcRegionW / 2;
  const sy = centerImgPt.y - srcRegionH / 2;

  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(
    state.sourceCanvas,
    sx,
    sy,
    srcRegionW,
    srcRegionH,
    0,
    0,
    size,
    size
  );

  // Draw the 3-branch orange hex vertex reticle (`>-` or `-<`) at the center of the loupe
  const rayAngles = getVertexRayAngles(state.orientation, parity);
  const rayLength = state.step === "offset" ? 36 : half;

  ctx.strokeStyle = "#ff6a00";
  ctx.lineWidth = 4;
  ctx.lineCap = "round";
  ctx.beginPath();
  for (const angle of rayAngles) {
    ctx.moveTo(half, half);
    ctx.lineTo(half + Math.cos(angle) * rayLength, half + Math.sin(angle) * rayLength);
  }
  ctx.stroke();

  ctx.restore();

  // Outer orange ring border
  ctx.strokeStyle = "#ff6a00";
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.arc(half, half, half - 2.5, 0, Math.PI * 2);
  ctx.stroke();
}

/* -------------------------------------------------------------------------- */
/*  Final Step: Bake TPS Warped PNG, Upload, and Update Foundry Scene         */
/* -------------------------------------------------------------------------- */

async function applyWarpToScene() {
  if (state.controls.length < 1 || !state.origin) return;

  const primaryBtn = state.dockEl?.querySelector('[data-action="primary"]');
  if (primaryBtn) {
    primaryBtn.disabled = true;
    primaryBtn.textContent = "Fitting TPS... 0%";
  }

  try {
    const HexGridClass = foundry?.grid?.HexagonalGrid ?? null;
    const gridType = getFoundryGridType(state.orientation, true);
    const oldBounds = getSceneBounds();
    const imgW = state.sourceImage.naturalWidth || state.sourceImage.width;
    const imgH = state.sourceImage.naturalHeight || state.sourceImage.height;

    // 1. Determine integer foundryGridSize first
    const preAlign = computeFoundryGridAlignment({
      radius: state.radius,
      orientation: state.orientation,
      origin: state.origin,
      originParity: state.originParity,
      HexagonalGridClass: HexGridClass
    });
    const foundryGridSize = preAlign.foundryGridSize;

    // 2. Predict the exact sceneX / sceneY that Foundry VTT will compute when grid.type and grid.size
    // are updated (since Foundry recalculates padded sceneX/sceneY to whole hex rows/columns)
    let newBounds = { ...oldBounds };
    try {
      if (typeof state.scene.clone === "function") {
        const cloned = state.scene.clone(
          {
            grid: { type: gridType, size: foundryGridSize },
            background: { offsetX: 0, offsetY: 0 }
          },
          { keepId: true }
        );
        const dims = cloned.getDimensions?.();
        if (dims && typeof dims.sceneX === "number" && typeof dims.sceneY === "number") {
          newBounds = {
            x: dims.sceneX,
            y: dims.sceneY,
            width: dims.sceneWidth || oldBounds.width,
            height: dims.sceneHeight || oldBounds.height
          };
        }
      } else if (preAlign.nativeGrid?.calculateDimensions) {
        const padding = state.scene.padding ?? 0.25;
        const calc = preAlign.nativeGrid.calculateDimensions(oldBounds.width, oldBounds.height, padding);
        if (calc && typeof calc.x === "number" && typeof calc.y === "number") {
          newBounds = {
            x: calc.x,
            y: calc.y,
            width: oldBounds.width,
            height: oldBounds.height
          };
        }
      }
    } catch (_err) {
      // Fallback to oldBounds; post-update live check below will still correct any offsetX/Y shift
    }

    const shiftX = newBounds.x - oldBounds.x;
    const shiftY = newBounds.y - oldBounds.y;
    const originInNewScene = {
      x: state.origin.x + shiftX,
      y: state.origin.y + shiftY
    };

    // 3. Compute exact vertex alignment against Foundry's nativeGrid in the new scene coordinate space
    const alignment = computeFoundryGridAlignment({
      radius: state.radius,
      orientation: state.orientation,
      origin: originInNewScene,
      originParity: state.originParity,
      HexagonalGridClass: HexGridClass
    });

    // Map each control point's target vertex to match Foundry's integer-sized HexagonalGrid
    // so there is zero cumulative rounding drift across large maps
    const sourcePoints = state.controls.map((c) => c.source);
    const targetPoints = state.controls.map((c) => {
      const cWorldNew = {
        x: c.vertexScene.x + shiftX,
        y: c.vertexScene.y + shiftY
      };
      const alignedWorld = alignment.mapTargetToFoundry(cWorldNew, c.parity);
      return {
        x: ((alignedWorld.x - newBounds.x) * imgW) / newBounds.width,
        y: ((alignedWorld.y - newBounds.y) * imgH) / newBounds.height
      };
    });

    const warpedCanvas = await warpImage(state.sourceImage, sourcePoints, targetPoints, {
      cellSize: 8,
      bilinear: true,
      onProgress: (pct) => {
        if (primaryBtn) {
          primaryBtn.textContent = `Warping... ${Math.round(pct * 100)}%`;
        }
      }
    });

    if (primaryBtn) {
      primaryBtn.textContent = "Saving PNG...";
    }

    const blob = await new Promise((resolve, reject) => {
      warpedCanvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Canvas toBlob failed"))), "image/png");
    });

    const safeSceneName = (state.scene.name || "scene").replace(/[^a-z0-9-_]/gi, "_").toLowerCase();
    const fileName = `${safeSceneName}-hex-aligned-${Date.now()}.png`;
    const file = new File([blob], fileName, { type: "image/png" });

    const uploadDir = `worlds/${game.world.id}/hex-grid-aligner`;
    await ensureDirectoryExists("data", uploadDir);

    const FilePickerImpl = foundry?.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker;
    const uploadResult = await FilePickerImpl.upload("data", uploadDir, file, {}, { notify: false });
    const uploadedPath = uploadResult?.path;
    if (!uploadedPath) {
      throw new Error("Failed to upload the warped map PNG.");
    }

    // Preload texture into Foundry's cache so the canvas renders the new background immediately
    try {
      const loadTex = foundry?.canvas?.loadTexture ?? globalThis.loadTexture;
      if (typeof loadTex === "function") {
        await loadTex(uploadedPath);
      }
    } catch (_err) {
      // Ignore preload errors
    }

    // In Foundry VTT v14+, scenes use embedded Level documents (`scene.levels`) for background images!
    const activeLevel = getActiveSceneLevel(state.scene);
    if (activeLevel && typeof activeLevel.update === "function") {
      await activeLevel.update({
        "background.src": uploadedPath,
        "background.offsetX": 0,
        "background.offsetY": 0
      });
    }

    const sceneUpdate = {
      "background.src": uploadedPath,
      "background.offsetX": 0,
      "background.offsetY": 0,
      "grid.type": gridType,
      "grid.size": foundryGridSize
    };

    await state.scene.update(sceneUpdate);

    // 4. Post-update verification against the live `canvas.grid` and `canvas.dimensions`:
    // If Foundry shifted `canvas.dimensions.sceneX/Y` or `canvas.grid` when rebuilding the scene,
    // snap `background.offsetX/Y` so our baked origin vertex sits dead-on the live Foundry hex vertex.
    try {
      const liveBounds = getSceneBounds();
      const bakedOriginImg = targetPoints[0];
      const liveOriginWorld = {
        x: liveBounds.x + (bakedOriginImg.x * liveBounds.width) / imgW,
        y: liveBounds.y + (bakedOriginImg.y * liveBounds.height) / imgH
      };
      const liveVertex = findNearestMatchingGridVertex(
        canvas?.grid,
        liveOriginWorld,
        state.orientation,
        state.originParity,
        foundryGridSize
      );
      if (liveVertex) {
        const residualX = Math.round(liveVertex.x - liveOriginWorld.x);
        const residualY = Math.round(liveVertex.y - liveOriginWorld.y);
        if (Math.abs(residualX) >= 1 || Math.abs(residualY) >= 1) {
          const postLevel = getActiveSceneLevel(state.scene);
          if (postLevel && typeof postLevel.update === "function") {
            await postLevel.update({
              "background.offsetX": residualX,
              "background.offsetY": residualY
            });
          }
          await state.scene.update({
            "background.offsetX": residualX,
            "background.offsetY": residualY
          });
        }
      }
    } catch (_err) {
      // Ignore post-update check errors
    }

    // Ensure the canvas reflects the new level/scene background texture immediately
    const currentBgSrc = getSceneBackgroundSrc(canvas.scene);
    const primaryBgSrc = canvas?.primary?.background?.texture?.baseTexture?.resource?.src ?? "";
    if (currentBgSrc && primaryBgSrc && !primaryBgSrc.includes(fileName)) {
      await canvas.draw();
    }

    closeAligner();
    ui.notifications?.info(
      `Map warped (${state.controls.length} point${state.controls.length > 1 ? "s" : ""}) and Foundry hex grid aligned (${foundryGridSize}px).`
    );
  } catch (err) {
    console.error(`${MODULE_ID} | Failed to apply warp:`, err);
    ui.notifications?.error(`Alignment failed: ${err.message}`);
    if (primaryBtn) {
      primaryBtn.disabled = false;
      primaryBtn.textContent = "✓ Apply to Scene";
    }
  }
}

async function ensureDirectoryExists(source, targetDir) {
  const FilePickerImpl = foundry?.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker;
  if (!FilePickerImpl?.createDirectory) return;
  const parts = targetDir.split("/");
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    try {
      await FilePickerImpl.createDirectory(source, current, {});
    } catch (_err) {
      // Directory already exists
    }
  }
}
