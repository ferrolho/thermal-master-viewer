// Viewer state, geometry and rendering.
//
// The sensor image is always stored unrotated; rotation is applied when
// drawing, and coordinates move between sensor space and "display space" —
// the rotated image's own pixel grid — through toDisplay / fromDisplay.

import { LUTS } from "./palettes.js";

export const els = id => document.getElementById(id);

export const view = els("view");
export const overlay = els("overlay");
const vctx = view.getContext("2d", { alpha: false });
const octx = overlay.getContext("2d");
const scaleCanvas = els("scale");
const sctx = scaleCanvas.getContext("2d");

const KELVIN = 273.15;

export const state = {
  W: 0, H: 0,
  ir: null, thermal: null,       // latest frame
  celsius: null,                 // Float32Array, emissivity-corrected
  palette: "Ironbow",
  source: "thermal",
  rangeMode: "auto",
  manualLo: 20, manualHi: 40,
  rollLo: null, rollHi: null,
  unitC: true,
  frozen: false,
  markers: true, reticle: true, labels: true, smooth: false,
  rot: 0,                        // display rotation, degrees clockwise
  emissivity: 0.95, reflected: 25,
  stats: null,
  cursor: null,                  // {x, y} sensor pixel, {u, v} fraction of image
  src: null, srcCtx: null,       // offscreen sensor-resolution image
  imgData: null,
  cssW: 0, cssH: 0, dpr: 1,      // on-screen size of the image, for the overlay
  info: {},                      // device identification strings
  frames: 0, lastFpsAt: performance.now(), fps: 0,
};

export const fmt = c =>
  state.unitC ? `${c.toFixed(1)} °C` : `${(c * 9 / 5 + 32).toFixed(1)} °F`;

// ---- rotation -------------------------------------------------------------

export function rotDims() {
  return state.rot % 180 ? [state.H, state.W] : [state.W, state.H];
}

export function toDisplay(x, y) {
  const { W, H, rot } = state;
  if (rot === 90) return [H - 1 - y, x];
  if (rot === 180) return [W - 1 - x, H - 1 - y];
  if (rot === 270) return [y, W - 1 - x];
  return [x, y];
}

export function fromDisplay(dx, dy) {
  const { W, H, rot } = state;
  if (rot === 90) return [dy, H - 1 - dx];
  if (rot === 180) return [W - 1 - dx, H - 1 - dy];
  if (rot === 270) return [W - 1 - dy, dx];
  return [dx, dy];
}

export function applyRotation() {
  const [dw, dh] = rotDims();
  if (view.width !== dw || view.height !== dh) {
    view.width = dw;
    view.height = dh;
  }
  fitStage();
  redraw();
}

export function setRotation(deg) {
  state.rot = ((deg % 360) + 360) % 360;
  applyRotation();
}

// ---- layout ---------------------------------------------------------------

// Scale the image up to fill the stage, keeping its aspect ratio.
export function fitStage() {
  const stage = els("stage");
  const pad = 28;
  const availW = stage.clientWidth - pad, availH = stage.clientHeight - pad;
  const [dw, dh] = rotDims();
  if (availW <= 0 || availH <= 0 || !dw) return;

  // No lower clamp: on a phone the stage is often narrower than the sensor is
  // wide, and refusing to scale below 1:1 used to leave the canvas overflowing
  // its box, where `max-width` clamped the width alone and squashed the image.
  const k = Math.min(availW / dw, availH / dh);
  const w = Math.round(dw * k), h = Math.round(dh * k);
  const dpr = window.devicePixelRatio || 1;

  // Nothing to do, and returning early keeps the ResizeObserver below from
  // feeding itself.
  if (w === state.cssW && h === state.cssH && overlay.width === Math.round(w * dpr)) return;

  for (const cv of [view, overlay]) { cv.style.width = w + "px"; cv.style.height = h + "px"; }

  // The overlay is vector art, so give it a backing store at true screen
  // resolution rather than the sensor's. Drawing it at 256x192 and letting CSS
  // scale it up is what made the markers blocky.
  overlay.width = Math.round(w * dpr);
  overlay.height = Math.round(h * dpr);
  state.cssW = w; state.cssH = h; state.dpr = dpr;
  drawOverlay();
}

// The stage changes size for reasons that are not window resizes — opening the
// log footer, most obviously — so watch the element itself rather than the
// window. Without this the image keeps its old size and overlaps the log until
// something else happens to call fitStage.
if (window.ResizeObserver) {
  new ResizeObserver(() => fitStage()).observe(els("stage"));
}
// Still needed: moving the window to a screen with a different pixel ratio
// changes what the overlay should be drawn at without changing the stage box.
window.addEventListener("resize", fitStage);

function resize(w, h) {
  if (state.W === w && state.H === h) return;
  state.W = w; state.H = h;

  // Frames land here at sensor resolution; the visible canvas then draws this
  // through the rotation transform.
  state.src = document.createElement("canvas");
  state.src.width = w; state.src.height = h;
  state.srcCtx = state.src.getContext("2d", { alpha: false });
  state.imgData = state.srcCtx.createImageData(w, h);
  state.celsius = new Float32Array(w * h);

  applyRotation();
}

// ---- frames ---------------------------------------------------------------

export function deliverFrame(w, h, ir, thermal) {
  resize(w, h);
  state.ir = ir;
  state.thermal = thermal;

  state.frames++;
  const now = performance.now();
  if (now - state.lastFpsAt > 1000) {
    state.fps = state.frames * 1000 / (now - state.lastFpsAt);
    state.frames = 0; state.lastFpsAt = now;
  }
  if (!state.frozen) recompute();
}

// Convert raw -> Celsius with emissivity correction, and gather statistics.
export function recompute() {
  const { thermal, celsius } = state;
  if (!thermal || !celsius) return;

  const e = state.emissivity;
  const applyE = e > 0 && e < 1;
  const refl4 = Math.pow(state.reflected + KELVIN, 4);

  let lo = Infinity, hi = -Infinity, loI = 0, hiI = 0, sum = 0;
  for (let i = 0; i < thermal.length; i++) {
    let k = thermal[i] / 64;
    if (applyE) {
      const v = (Math.pow(k, 4) - (1 - e) * refl4) / e;
      k = v > 0 ? Math.pow(v, 0.25) : 0;
    }
    const c = k - KELVIN;
    celsius[i] = c;
    sum += c;
    if (c < lo) { lo = c; loI = i; }
    if (c > hi) { hi = c; hiI = i; }
  }
  state.stats = {
    lo, hi, loI, hiI,
    avg: sum / thermal.length,
    centre: celsius[(state.H >> 1) * state.W + (state.W >> 1)],
  };
  redraw();
}

function displayRange() {
  const s = state.stats;
  if (!s) return [20, 40];
  if (state.rangeMode === "manual") {
    return state.manualHi > state.manualLo
      ? [state.manualLo, state.manualHi]
      : [state.manualLo, state.manualLo + 1];
  }
  if (state.rangeMode === "rolling") {
    // Ease towards the frame range so the palette stops flickering.
    const a = 0.08;
    state.rollLo = state.rollLo === null ? s.lo : state.rollLo + (s.lo - state.rollLo) * a;
    state.rollHi = state.rollHi === null ? s.hi : state.rollHi + (s.hi - state.rollHi) * a;
    return [state.rollLo, Math.max(state.rollHi, state.rollLo + 0.5)];
  }
  return [s.lo, Math.max(s.hi, s.lo + 0.5)];
}

export function redraw() {
  if (!state.stats || !state.imgData) return;
  const { W, celsius, ir } = state;
  const lut = LUTS[state.palette];
  const [lo, hi] = displayRange();
  const inv = 255 / (hi - lo);
  const px = state.imgData.data;

  if (state.source === "ir") {
    for (let i = 0, j = 0; i < ir.length; i++, j += 4) {
      const v = ir[i];
      px[j] = px[j + 1] = px[j + 2] = v; px[j + 3] = 255;
    }
  } else {
    const blend = state.source === "blend";
    for (let i = 0, j = 0; i < celsius.length; i++, j += 4) {
      let t = (celsius[i] - lo) * inv;
      t = t < 0 ? 0 : t > 255 ? 255 : t;
      const k = (t & 255) * 3;
      let r = lut[k], g = lut[k + 1], b = lut[k + 2];
      if (blend) {
        // Modulate palette colour by IR detail: keeps edges the thermal sensor
        // cannot resolve, without inventing temperatures.
        const m = 0.55 + (ir[i] / 255) * 0.7;
        r = Math.min(255, r * m); g = Math.min(255, g * m); b = Math.min(255, b * m);
      }
      px[j] = r; px[j + 1] = g; px[j + 2] = b; px[j + 3] = 255;
    }
  }
  state.srcCtx.putImageData(state.imgData, 0, 0);

  // Blit the sensor image onto the visible canvas through the rotation.
  const [dw, dh] = rotDims();
  vctx.setTransform(1, 0, 0, 1, 0, 0);
  vctx.imageSmoothingEnabled = false;
  if (state.rot === 90) { vctx.translate(dw, 0); vctx.rotate(Math.PI / 2); }
  else if (state.rot === 180) { vctx.translate(dw, dh); vctx.rotate(Math.PI); }
  else if (state.rot === 270) { vctx.translate(0, dh); vctx.rotate(-Math.PI / 2); }
  vctx.drawImage(state.src, 0, 0);
  vctx.setTransform(1, 0, 0, 1, 0, 0);

  view.style.imageRendering = state.smooth ? "auto" : "pixelated";

  drawScale(lo, hi);
  drawOverlay();
  updateReadout();
}

function drawScale(lo, hi) {
  const lut = LUTS[state.palette];
  const { width: w, height: h } = scaleCanvas;
  const img = sctx.createImageData(w, h);
  for (let x = 0; x < w; x++) {
    const k = Math.round(x / (w - 1) * 255) * 3;
    for (let y = 0; y < h; y++) {
      const j = (y * w + x) * 4;
      img.data[j] = lut[k]; img.data[j + 1] = lut[k + 1];
      img.data[j + 2] = lut[k + 2]; img.data[j + 3] = 255;
    }
  }
  sctx.putImageData(img, 0, 0);
  els("scaleLo").textContent = fmt(lo);
  els("scaleHi").textContent = fmt(hi);
}

// Drawn in CSS pixels over the displayed image, at screen resolution.
export function drawOverlay() {
  const { W, stats, cssW, cssH } = state;
  if (!stats || !cssW) return;

  const [dw] = rotDims();
  const k = cssW / dw;                       // sensor pixel -> CSS pixel
  const toScreen = (x, y) => {
    const [dx, dy] = toDisplay(x, y);
    return [(dx + 0.5) * k, (dy + 0.5) * k];
  };

  octx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
  octx.clearRect(0, 0, cssW, cssH);
  octx.font = "600 11px ui-sans-serif, -apple-system, system-ui, sans-serif";
  octx.textBaseline = "alphabetic";
  octx.lineWidth = 1.5;

  if (state.markers) {
    mark(stats.hiI % W, (stats.hiI / W) | 0, "#ff5a44", stats.hi);
    mark(stats.loI % W, (stats.loI / W) | 0, "#4aa8ff", stats.lo);
  }

  if (state.reticle) {
    const [px, py] = toScreen(W >> 1, state.H >> 1);
    const r = 9;
    octx.strokeStyle = "rgba(255,255,255,.9)";
    octx.beginPath();
    octx.moveTo(px - r, py); octx.lineTo(px - 3, py);
    octx.moveTo(px + 3, py); octx.lineTo(px + r, py);
    octx.moveTo(px, py - r); octx.lineTo(px, py - 3);
    octx.moveTo(px, py + 3); octx.lineTo(px, py + r);
    octx.stroke();
    if (state.labels) label(px + r + 4, py - 4, fmt(stats.centre), "#ffffff");
  }

  if (state.cursor) {
    // Exact pointer position, not snapped to the sensor grid.
    const px = state.cursor.u * cssW, py = state.cursor.v * cssH;
    octx.strokeStyle = "rgba(255,255,255,.85)";
    octx.lineWidth = 1;
    octx.beginPath();
    octx.moveTo(0, py); octx.lineTo(cssW, py);
    octx.moveTo(px, 0); octx.lineTo(px, cssH);
    octx.stroke();
    if (state.labels) {
      label(px + 8, py - 8, fmt(state.celsius[state.cursor.y * W + state.cursor.x]), "#ffe08a");
    }
  }

  function mark(x, y, colour, temp) {
    const [px, py] = toScreen(x, y);
    const r = 7;
    octx.strokeStyle = colour;
    octx.lineWidth = 1.5;
    octx.beginPath();
    octx.arc(px, py, r, 0, Math.PI * 2);
    octx.stroke();
    octx.beginPath();
    octx.moveTo(px - r * 1.9, py); octx.lineTo(px - r * 0.8, py);
    octx.moveTo(px + r * 0.8, py); octx.lineTo(px + r * 1.9, py);
    octx.stroke();
    if (state.labels) label(px + r + 5, py - r, fmt(temp), colour);
  }

  // A readable chip, nudged to stay inside the image.
  function label(x, y, text, colour) {
    const padX = 5, h = 16;
    const w = octx.measureText(text).width + padX * 2;
    const lx = Math.min(Math.max(2, x), cssW - w - 2);
    const ly = Math.min(Math.max(h + 2, y), cssH - 2);
    octx.fillStyle = "rgba(0,0,0,.62)";
    if (octx.roundRect) {
      octx.beginPath();
      octx.roundRect(lx, ly - h, w, h, 4);
      octx.fill();
    } else {
      octx.fillRect(lx, ly - h, w, h);
    }
    octx.fillStyle = colour;
    octx.fillText(text, lx + padX, ly - 4);
  }
}

function updateReadout() {
  const s = state.stats;
  els("maxTemp").textContent = fmt(s.hi);
  els("minTemp").textContent = fmt(s.lo);
  els("avgTemp").textContent = fmt(s.avg);
  els("centreTemp").textContent = fmt(s.centre);
  els("cursorTemp").textContent = state.cursor
    ? fmt(state.celsius[state.cursor.y * state.W + state.cursor.x])
    : "--";
}
