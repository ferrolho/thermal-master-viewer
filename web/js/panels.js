// Which secondary panel is showing, for both layouts.
//
// One piece of state covers both, because the two layouts want the same thing
// expressed differently:
//
//   "controls"  desktop: sidebar showing, log closed   phone: controls drawer
//   "log"       desktop: sidebar showing, log open     phone: log drawer
//   "none"      desktop: same as "controls"            phone: neither, image fills
//
// The sidebar is permanent furniture on a desktop, so "none" only means
// anything on a phone — where the point of it is to get both drawers out of
// the way and hand the whole screen to the image.

import { els } from "./viewer.js";
import { showLog } from "./log.js";

const NARROW = "(max-width: 760px)";
const narrow = window.matchMedia(NARROW);

let panel = "controls";

export const currentPanel = () => panel;

export function setPanel(next) {
  panel = next;
  for (const name of ["none", "controls", "log"]) {
    document.body.classList.toggle(`panel-${name}`, panel === name);
  }

  const logOpen = panel === "log";
  els("logChev").textContent = logOpen ? "▾" : "▸";
  els("logToggle").setAttribute("aria-expanded", String(logOpen));

  for (const [id, name] of [["tabControls", "controls"], ["tabLog", "log"]]) {
    els(id).classList.toggle("on", panel === name);
    els(id).setAttribute("aria-pressed", String(panel === name));
  }

  showLog(logOpen);
}

// On a desktop the log bar's own chevron toggles between the log and the
// ordinary state; there is no "hide the sidebar" to fall back to.
els("logToggle").onclick = () => setPanel(panel === "log" ? "controls" : "log");

// On a phone each tab toggles: tapping the open one closes it, which is how
// you get to "none" and a full-screen image.
els("tabControls").onclick = () => setPanel(panel === "controls" ? "none" : "controls");
els("tabLog").onclick = () => setPanel(panel === "log" ? "none" : "log");

// Rotating a phone into a wide layout must not strand it with no sidebar.
narrow.addEventListener("change", e => {
  if (!e.matches && panel === "none") setPanel("controls");
});

setPanel("controls");
