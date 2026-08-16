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

let panel = "controls";

export function setPanel(next) {
  panel = next;
  for (const name of ["none", "controls", "log"]) {
    document.body.classList.toggle(`panel-${name}`, panel === name);
  }

  const logOpen = panel === "log";
  els("logChev").textContent = logOpen ? "▾" : "▸";
  els("logToggle").setAttribute("aria-expanded", String(logOpen));

  const controlsOpen = panel === "controls";
  els("asideChev").textContent = controlsOpen ? "▾" : "▸";
  els("asideToggle").setAttribute("aria-expanded", String(controlsOpen));

  showLog(logOpen);
}

// Each bar toggles its own panel shut, which is what reaches "none". Opening
// either closes the other, so on a phone they never split the bottom of the
// screen between them. A wide screen ignores all of this for the sidebar,
// which is always on show there.
els("asideToggle").onclick = () => setPanel(panel === "controls" ? "none" : "controls");
els("logToggle").onclick = () => setPanel(panel === "log" ? "none" : "log");

setPanel("controls");
