// DOM wiring for the controls, the pointer, and the PNG/CSV exports.

import { PALETTES } from "./palettes.js";
import { download, stamp } from "./download.js";
import { session } from "./session.js";
import {
  els, state, view, overlay,
  redraw, recompute, drawOverlay,
  rotDims, fromDisplay, setRotation,
} from "./viewer.js";

// ---- display controls -----------------------------------------------------

const paletteSel = els("palette");
for (const name of Object.keys(PALETTES)) {
  const opt = document.createElement("option");
  opt.value = opt.textContent = name;
  paletteSel.appendChild(opt);
}
paletteSel.value = state.palette;
paletteSel.onchange = () => { state.palette = paletteSel.value; redraw(); };

els("source").onchange = e => { state.source = e.target.value; redraw(); };

els("rangeMode").onchange = e => {
  state.rangeMode = e.target.value;
  els("manualRange").hidden = state.rangeMode !== "manual";
  state.rollLo = state.rollHi = null;
  redraw();
};
els("rangeLo").value = state.manualLo;
els("rangeHi").value = state.manualHi;
els("rangeLo").oninput = e => { state.manualLo = +e.target.value; redraw(); };
els("rangeHi").oninput = e => { state.manualHi = +e.target.value; redraw(); };

const unitBtn = els("unit");
unitBtn.onclick = () => {
  state.unitC = !state.unitC;
  unitBtn.textContent = state.unitC ? "°C" : "°F";
  redraw();
};

const freezeBtn = els("freeze");
freezeBtn.onclick = () => {
  state.frozen = !state.frozen;
  freezeBtn.classList.toggle("on", state.frozen);
  freezeBtn.textContent = state.frozen ? "Frozen" : "Freeze";
};

function toggle(id, key) {
  const btn = els(id);
  btn.onclick = () => {
    state[key] = !state[key];
    btn.classList.toggle("on", state[key]);
    redraw();
  };
}
toggle("tMarkers", "markers");
toggle("tReticle", "reticle");
toggle("tLabels", "labels");
toggle("tSmooth", "smooth");

els("rotCCW").onclick = () => setRotation(state.rot - 90);
els("rotCW").onclick = () => setRotation(state.rot + 90);

els("emis").oninput = e => {
  state.emissivity = +e.target.value;
  els("emisVal").textContent = state.emissivity.toFixed(2);
  recompute();
};
els("refl").oninput = e => {
  state.reflected = +e.target.value;
  els("reflVal").textContent = `${state.reflected} °C`;
  recompute();
};
els("emisVal").textContent = state.emissivity.toFixed(2);
els("reflVal").textContent = `${state.reflected} °C`;

// ---- pointer --------------------------------------------------------------

// The exact pointer position drives the crosshair; the sensor pixel it lands
// in drives the temperature reading. Only the reading has to be quantised.
function sensorPos(ev) {
  const r = view.getBoundingClientRect();
  const [dw, dh] = rotDims();
  if (!dw || !r.width) return null;

  const px = ev.clientX - r.left, py = ev.clientY - r.top;
  if (px < 0 || py < 0 || px > r.width || py > r.height) return null;

  // Kept as a fraction of the image, not pixels, so the crosshair stays put
  // when the window is resized.
  const u = px / r.width, v = py / r.height;
  const dx = Math.min(dw - 1, Math.floor(u * dw));
  const dy = Math.min(dh - 1, Math.floor(v * dh));
  const [x, y] = fromDisplay(dx, dy);
  return { x, y, u, v };
}

view.addEventListener("mousemove", ev => { state.cursor = sensorPos(ev); drawOverlay(); });
view.addEventListener("mouseleave", () => { state.cursor = null; drawOverlay(); });

// ---- camera controls ------------------------------------------------------

els("shutter").onclick = () => session.cam?.shutter().catch(() => {});

const gainBtn = els("gainHigh");
gainBtn.onclick = () => {
  const high = !gainBtn.classList.contains("on");
  gainBtn.classList.toggle("on", high);
  gainBtn.textContent = high ? "High gain" : "Low gain";
  session.cam?.setGain(high).catch(() => {});
};

// ---- exports --------------------------------------------------------------

els("save").onclick = () => {
  // Export at the overlay's resolution so labels and markers stay sharp.
  const out = document.createElement("canvas");
  out.width = overlay.width; out.height = overlay.height;
  const c = out.getContext("2d");
  c.imageSmoothingEnabled = state.smooth;
  c.drawImage(view, 0, 0, out.width, out.height);
  c.drawImage(overlay, 0, 0);
  out.toBlob(b => download(`thermal-${stamp()}.png`, b), "image/png");
};

// Every pixel's temperature in °C, laid out to match what is on screen so the
// CSV and the PNG line up. Values include the emissivity correction.
els("saveCsv").onclick = () => {
  if (!state.celsius) return;
  const [dw, dh] = rotDims();
  const rows = new Array(dh);
  for (let dy = 0; dy < dh; dy++) {
    const row = new Array(dw);
    for (let dx = 0; dx < dw; dx++) {
      const [x, y] = fromDisplay(dx, dy);
      row[dx] = state.celsius[y * state.W + x].toFixed(2);
    }
    rows[dy] = row.join(",");
  }
  download(`thermal-${stamp()}.csv`, new Blob([rows.join("\n")], { type: "text/csv" }));
};
