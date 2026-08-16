// The camera's firmware log.
//
// The status register holds one live message at a time (see Camera.readLog),
// so this polls it and keeps every message that differs from the one before.
// That makes it a sampler, not a complete transcript: the firmware can emit
// several messages between polls and the intermediate ones are lost. Polling
// faster costs a control transfer each time, competing with the frame stream,
// so POLL_MS is the compromise — lower it if you are hunting something bursty.
//
// Capture starts as soon as the camera streams and runs whether or not the
// panel is open, because by the time you go looking for an event it has
// usually already happened.

import { session } from "./session.js";
import { els } from "./viewer.js";
import { download, stamp } from "./download.js";
import { trimTo } from "./text.js";

const POLL_MS = 150;
const MAX_CHARS = 200000;

const panel = els("logPanel");
const box = els("log");
const toggle = els("logToggle");
const chev = els("logChev");
const count = els("logCount");

let buffer = "";
let lines = 0;
let last = "";
let timer = null;
let open = false;
let dirty = false;

function render() {
  count.textContent = lines ? `${lines} lines` : "";
  if (!open || !dirty) return;
  dirty = false;
  // Only stick to the bottom if the reader is already there.
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
  box.textContent = buffer;
  if (atBottom) box.scrollTop = box.scrollHeight;
}

async function poll() {
  if (!session.cam) return;
  let msg;
  try {
    msg = await session.cam.readLog();
  } catch {
    return;   // a failed read is not worth reporting; the next usually works
  }
  if (msg && msg !== last) {
    last = msg;
    buffer = trimTo(buffer ? `${buffer}\n${msg}` : msg, MAX_CHARS);
    lines = buffer ? buffer.split("\n").length : 0;
    dirty = true;
  }
  render();
}

export function startCapture() {
  stopCapture();
  timer = setInterval(poll, POLL_MS);
  poll();
}

export function stopCapture() {
  clearInterval(timer);
  timer = null;
}

function setOpen(next) {
  open = next;
  panel.classList.toggle("open", open);
  box.hidden = !open;
  chev.textContent = open ? "▾" : "▸";
  toggle.setAttribute("aria-expanded", String(open));
  if (open) {
    dirty = true;
    render();
    box.scrollTop = box.scrollHeight;
  }
}

toggle.onclick = () => setOpen(!open);

els("logSave").onclick = e => {
  e.stopPropagation();
  download(`thermal-firmware-${stamp()}.log`, new Blob([buffer], { type: "text/plain" }));
};

els("logClear").onclick = e => {
  e.stopPropagation();
  buffer = "";
  lines = 0;
  last = "";
  dirty = true;
  box.textContent = "";
  render();
};

setOpen(false);
