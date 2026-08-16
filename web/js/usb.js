// WebUSB driver for the Thermal Master P3 / P1.
//
// Both of the camera's interfaces are vendor-specific (class 0xFF), not USB
// Video (0x0E), so WebUSB is allowed to claim them and the browser can talk to
// the camera directly — no local server, no native driver.

export const VID = 0x3474;

const MODELS = {
  0x45A2: { name: "P3", w: 256, h: 192 },
  0x45C2: { name: "P1", w: 160, h: 120 },
};

const MARKER = 12;          // frame start/end marker length
const CHUNK = 16384;        // bulk read granularity
const IFACE_CTRL = 0;
const IFACE_STREAM = 1;
const EP_IN = 1;            // endpoint 0x81

const sleep = ms => new Promise(r => setTimeout(r, ms));

export function crc16(bytes) {
  let crc = 0;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = (crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1) & 0xFFFF;
  }
  return crc;
}

// 18 bytes: cmd_type is big-endian, everything else little-endian, with a
// CRC16-CCITT over the first 16.
export function buildCommand(cmdType, param, register, respLen) {
  const b = new Uint8Array(18);
  const dv = new DataView(b.buffer);
  dv.setUint16(0, cmdType, false);
  dv.setUint16(2, param, true);
  dv.setUint16(4, register, true);
  dv.setUint16(12, respLen, true);
  dv.setUint16(16, crc16(b.subarray(0, 16)), true);
  return b;
}

export const COMMANDS = {
  read_name:        [0x0101, 0x0081, 0x0001, 30],
  read_version:     [0x0101, 0x0081, 0x0002, 12],
  read_part_number: [0x0101, 0x0081, 0x0006, 64],
  read_serial:      [0x0101, 0x0081, 0x0007, 64],
  read_hw_version:  [0x0101, 0x0081, 0x000A, 64],
  read_model_long:  [0x0101, 0x0081, 0x000F, 64],
  status:           [0x1021, 0x0081, 0x0000, 2],
  start_stream:     [0x012F, 0x0081, 0x0000, 1],
  gain_low:         [0x012F, 0x0041, 0x0000, 0],
  gain_high:        [0x012F, 0x0041, 0x0001, 0],
  shutter:          [0x0136, 0x0043, 0x0000, 0],
};

const INFO_REGISTERS = [
  ["model", "read_name"],
  ["fw_version", "read_version"],
  ["part_number", "read_part_number"],
  ["serial", "read_serial"],
  ["hw_version", "read_hw_version"],
  ["model_long", "read_model_long"],
];

// Extract the live log message from a status-register read.
//
// A real 192-byte read looks like this, from byte 64:
//
//   "[337783] I/ffc_svc: ffc b update done\n\r\n\n\r\nal tick: 238\n\r\n 20\n..."
//    \________________ the live message _______________/  \___ stale tails ___/
//
// Only one message is live at a time and it is written over a buffer that is
// never cleared, so everything past its terminator is the remains of older,
// longer messages. Reading past it produced the garbled "al tick: 238" and
// "led" fragments, so stop at the first NUL, LF or CR.
export function parseLogMessage(bytes) {
  const tail = bytes.length > 64 ? bytes.subarray(64) : bytes;
  let out = "";
  for (const b of tail) {
    if (b === 0 || b === 10 || b === 13) break;
    if (b >= 32 && b <= 126) out += String.fromCharCode(b);
  }
  return out.trim();
}

export class Camera {
  constructor(device) {
    this.dev = device;
    const m = MODELS[device.productId] || MODELS[0x45A2];
    this.name = m.name;
    this.w = m.w;
    this.h = m.h;
    this.rows = 2 * this.h + 2;
    this.frameSize = 2 * this.rows * this.w;
    this.readSize = this.frameSize + 2 * MARKER;
    this.buf = new Uint8Array(this.readSize);
    this.ir = new Uint8Array(this.w * this.h);
    this.thermal = new Uint16Array(this.w * this.h);
    this.streaming = false;
    this.frames = 0;
    this.dropped = 0;
    this.lastCnt3 = 0;
    // Control transfers share one command/status state machine on the device,
    // so they must not interleave. Everything queues behind this chain.
    this._queue = Promise.resolve();
  }

  static supported() {
    return typeof navigator !== "undefined" && !!navigator.usb;
  }

  // Must be called from a user gesture.
  static async request() {
    const dev = await navigator.usb.requestDevice({ filters: [{ vendorId: VID }] });
    return new Camera(dev);
  }

  // Devices already granted to this origin, so a return visit reconnects
  // without showing the picker again.
  static async paired() {
    if (!Camera.supported()) return [];
    const list = await navigator.usb.getDevices();
    return list.filter(d => d.vendorId === VID).map(d => new Camera(d));
  }

  async open(step = () => {}) {
    step("opening device");
    await this.dev.open();
    if (this.dev.configuration === null) {
      step("selecting configuration");
      await this.dev.selectConfiguration(1);
    }
    step("claiming control interface");
    await this.dev.claimInterface(IFACE_CTRL);
    step("claiming streaming interface");
    await this.dev.claimInterface(IFACE_STREAM);
  }

  async close() {
    this.streaming = false;
    try { await this.dev.releaseInterface(IFACE_STREAM); } catch {}
    try { await this.dev.releaseInterface(IFACE_CTRL); } catch {}
    try { await this.dev.close(); } catch {}
  }

  // --- control transfers, serialised ---

  _serial(fn) {
    const run = this._queue.then(fn, fn);
    this._queue = run.then(() => {}, () => {});
    return run;
  }

  async _sendRaw(name) {
    const [t, p, r, n] = COMMANDS[name];
    await this.dev.controlTransferOut(
      { requestType: "vendor", recipient: "interface", request: 0x20, value: 0, index: IFACE_CTRL },
      buildCommand(t, p, r, n));
  }

  async _respRaw(len) {
    const r = await this.dev.controlTransferIn(
      { requestType: "vendor", recipient: "interface", request: 0x21, value: 0, index: IFACE_CTRL }, len);
    return new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
  }

  async _statusRaw(len = 1) {
    const r = await this.dev.controlTransferIn(
      { requestType: "vendor", recipient: "interface", request: 0x22, value: 0, index: IFACE_CTRL }, len);
    return new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
  }

  // Write pattern: send, then one status ACK.
  write(name) {
    return this._serial(async () => {
      await this._sendRaw(name);
      await this._statusRaw();
    });
  }

  // Read pattern: send, ACK, payload, ACK.
  read(name) {
    return this._serial(async () => {
      const len = COMMANDS[name][3];
      await this._sendRaw(name);
      await this._statusRaw();
      const data = await this._respRaw(len);
      await this._statusRaw();
      return new TextDecoder().decode(data).replace(/\0.*$/, "").trim();
    });
  }

  async readInfo() {
    const out = {};
    for (const [key, cmd] of INFO_REGISTERS) {
      try { out[key] = await this.read(cmd); } catch { out[key] = ""; }
    }
    return out;
  }

  // The status register doubles as a firmware log: read more than one byte and
  // the current message appears from about byte 64 on, looking like
  // "[91403] I/shutter: === Shutter close ===".
  //
  // Only one message is live at a time, and it is written over a buffer that is
  // never cleared, so whatever follows its terminator is the tail of an older,
  // longer message. Reading past that terminator is what produced garbled
  // output like "e ===" and "k: 298172" — fragments of previous lines. So stop
  // at the first NUL or newline and keep just the current message.
  readLog(length = 192) {
    return this._serial(async () => parseLogMessage(await this._statusRaw(length)));
  }

  // --- streaming ---

  // The sleeps mirror the official app; without them the camera accepts every
  // command and then never sends a frame.
  async startStream(step = () => {}) {
    step("starting stream");
    await this.read("start_stream");

    await sleep(1000);
    step("switching to streaming interface");
    await this.dev.selectAlternateInterface(IFACE_STREAM, 1);
    await this.dev.controlTransferOut(
      { requestType: "vendor", recipient: "device", request: 0xEE, value: 0, index: 1 });

    step("waiting for camera");
    await sleep(2000);
    try { await this.dev.transferIn(EP_IN, this.frameSize); } catch {}

    await this.read("start_stream");
    this.streaming = true;
    step("streaming");
  }

  async stopStream() {
    this.streaming = false;
    try { await this.dev.selectAlternateInterface(IFACE_STREAM, 0); } catch {}
  }

  shutter() { return this.write("shutter"); }
  setGain(high) { return this.write(high ? "gain_high" : "gain_low"); }

  // A frame always ends with a short 12-byte transfer, which is what lets us
  // find the boundary; anything inconsistent means start over.
  async readFrame() {
    const total = this.readSize, buf = this.buf;
    let pos = 0;
    while (pos < total) {
      if (!this.streaming) throw new Error("stopped");
      const res = await this.dev.transferIn(EP_IN, CHUNK);
      if (res.status === "stall") { await this.dev.clearHalt("in", EP_IN); pos = 0; continue; }
      if (res.status !== "ok" || !res.data || !res.data.byteLength) continue;

      const n = res.data.byteLength, end = pos + n;
      if ((n === MARKER && end < total) || (end >= total && n !== MARKER) || end > total) {
        pos = 0;
        continue;
      }
      buf.set(new Uint8Array(res.data.buffer, res.data.byteOffset, n), pos);
      pos = end;
    }

    const dv = new DataView(buf.buffer);
    if (dv.getUint32(2, true) !== dv.getUint32(total - MARKER + 2, true)) {
      throw new Error("frame marker mismatch");
    }

    // cnt3 advances ~40 per frame and wraps at 2048; a gap means dropped frames.
    const cnt3 = dv.getUint16(total - MARKER + 10, true);
    if (this.frames > 0) {
      const gap = (cnt3 - ((this.lastCnt3 + 40) % 2048) + 2048) % 2048;
      if (gap > 20 && gap < 2048 - 40) this.dropped += Math.floor(gap / 40);
    }
    this.lastCnt3 = cnt3;
    this.frames++;

    return this._split();
  }

  // rows 0..h-1 IR (8-bit in the low byte), 2 metadata rows, then thermal.
  _split() {
    const { w, h } = this;
    const words = new Uint16Array(this.buf.buffer, MARKER, this.rows * w);
    const n = w * h;
    for (let i = 0; i < n; i++) this.ir[i] = words[i] & 0xFF;
    this.thermal.set(words.subarray((h + 2) * w, (2 * h + 2) * w));
    return { ir: this.ir, thermal: this.thermal, w, h };
  }
}
