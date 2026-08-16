// Entry point: connect to the camera and pump frames into the viewer.

import { Camera } from "./usb.js";
import { session } from "./session.js";
import { els, state, deliverFrame } from "./viewer.js";
import { startCapture, stopCapture } from "./log.js";
import "./ui.js";

const statusEl = els("status");
const connectBtn = els("connect");

function setStatus(text, cls = "") {
  statusEl.textContent = text;
  statusEl.className = cls;
}

async function run(cam) {
  session.cam = cam;
  connectBtn.hidden = true;
  try {
    await cam.open(setStatus);
    state.info = await cam.readInfo();
    els("modelName").textContent = state.info.model_long || cam.name;
    await cam.startStream(setStatus);
    setStatus("live", "live");
    startCapture();   // record the firmware log from now on, panel open or not
    startMeta();
  } catch (err) {
    setStatus(`${err.name || "error"}: ${err.message}`, "err");
    connectBtn.hidden = false;
    session.cam = null;
    return;
  }

  while (cam.streaming) {
    try {
      const f = await cam.readFrame();
      deliverFrame(f.w, f.h, f.ir, f.thermal);
    } catch (err) {
      if (!cam.streaming) break;
      if (err.name === "NotFoundError" || err.name === "NetworkError") {
        setStatus("camera disconnected", "err");
        connectBtn.hidden = false;
        stopCapture();
        stopMeta();
        session.cam = null;
        return;
      }
      // A marker mismatch just means we caught a frame mid-flight; read on.
    }
  }
}

connectBtn.onclick = async () => {
  try {
    await run(await Camera.request());
  } catch (err) {
    if (err.name !== "NotFoundError") setStatus(`${err.name}: ${err.message}`, "err");
  }
};

function showMeta(extra) {
  const rows = Object.entries({
    ...extra,
    "client fps": state.fps.toFixed(1),
    firmware: state.info?.fw_version,
    serial: state.info?.serial,
  }).filter(([, v]) => v !== undefined && v !== null && v !== "");
  els("deviceMeta").innerHTML = rows.map(([k, v]) => `<div>${k}: ${v}</div>`).join("");
}

// Only tick while a camera is attached; there is nothing to report otherwise.
let metaTimer = null;

function startMeta() {
  stopMeta();
  metaTimer = setInterval(() => {
    if (session.cam) showMeta({ frames: session.cam.frames, dropped: session.cam.dropped });
  }, 1000);
}

function stopMeta() {
  clearInterval(metaTimer);
  metaTimer = null;
}

async function start() {
  if (!Camera.supported()) {
    connectBtn.hidden = true;
    setStatus("WebUSB needed — use Chrome or Edge", "err");
    return;
  }
  // Reconnect silently if this browser already has permission for the camera.
  try {
    const [known] = await Camera.paired();
    if (known) { run(known); return; }
  } catch {}
  setStatus("not connected");
}

start();
