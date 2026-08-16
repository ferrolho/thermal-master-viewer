// Keep the screen on while the camera is streaming.
//
// A phone dimming and then locking part-way through a measurement is the most
// annoying thing about using this in the field, and it is what video players
// solve with the same API.
//
// The browser releases the lock by itself whenever the page stops being
// visible — switching tabs, the screen going off, an incoming call — and does
// not restore it afterwards, so it has to be taken again on the way back.

let sentinel = null;
let wanted = false;

const supported = () => typeof navigator !== "undefined" && "wakeLock" in navigator;

// Reported in the Controls panel. A wake lock can fail for reasons entirely
// outside the page's control — battery saver refuses them outright — and a
// silent failure is indistinguishable from a bug, so say which it is.
let status = supported() ? "off" : "unsupported";
export const wakeStatus = () => status;

async function acquire() {
  if (!wanted || sentinel || !supported()) return;
  if (document.visibilityState !== "visible") return;
  try {
    sentinel = await navigator.wakeLock.request("screen");
    status = "on";
    // Fires when the browser drops it, so the next acquire() can succeed.
    sentinel.addEventListener("release", () => {
      sentinel = null;
      if (wanted) status = "dropped";
    });
  } catch (err) {
    // Refused — battery saver is the usual reason, or the page lost
    // visibility mid-request.
    status = `refused: ${err.name}`;
  }
}

export async function keepAwake(on) {
  wanted = on;
  if (on) return acquire();

  const held = sentinel;
  sentinel = null;
  status = supported() ? "off" : "unsupported";
  try { await held?.release(); } catch {}
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") acquire();
});
