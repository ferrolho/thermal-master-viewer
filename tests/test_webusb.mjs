// Checks the WebUSB driver's command builder against bytes captured from the
// official Windows app. This is the implementation that ships to users, so it
// is the one that most needs verifying.
//
//   node tests/test_webusb.mjs

import { crc16, buildCommand, COMMANDS, VID, parseLogMessage } from "../web/js/usb.js";
import { trimTo } from "../web/js/text.js";

const CAPTURED = {
  read_name: "0101810001000000000000001e0000004f90",
  read_version: "0101810002000000000000000c0000001f63",
  read_part_number: "01018100060000000000000040000000654f",
  read_serial: "01018100070000000000000040000000104c",
  read_hw_version: "010181000a00000000000000400000001959",
  read_model_long: "010181000f0000000000000040000000b857",
  status: "1021810000000000000000000200000095d1",
  start_stream: "012f81000000000000000000010000004930",
  gain_low: "012f41000000000000000000000000003c3a",
  gain_high: "012f41000100000000000000000000004939",
  shutter: "01364300000000000000000000000000cd0b",
};

const hex = bytes => [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");

let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
};

check("every command matches the capture, byte for byte", () => {
  const built = Object.keys(COMMANDS).sort();
  const expected = Object.keys(CAPTURED).sort();
  if (built.join() !== expected.join()) {
    throw new Error(`command sets differ:\n        have ${built}\n        want ${expected}`);
  }
  for (const [name, want] of Object.entries(CAPTURED)) {
    const got = hex(buildCommand(...COMMANDS[name]));
    if (got !== want) {
      throw new Error(`${name}:\n        built    ${got}\n        captured ${want}`);
    }
    if (got.length !== 36) throw new Error(`${name}: ${got.length / 2} bytes, want 18`);
  }
});

check("crc is CRC-16/XMODEM", () => {
  const got = crc16(new TextEncoder().encode("123456789"));
  if (got !== 0x31c3) throw new Error(`got ${got.toString(16)}, want 31c3`);
});

check("vendor id is Thermal Master", () => {
  if (VID !== 0x3474) throw new Error(`got ${VID.toString(16)}`);
});

// A verbatim 192-byte status read from a P3 (firmware 00.00.02.18), taken just
// after a shutter command. The live message is followed by the tails of older,
// longer messages, which is exactly the trap this parsing has to avoid.
const STATUS_READ =
  "000000003430c066b0574100280000000200000001000000756c6f67206c6f638300000008264100d8574000" +
  "38d9400038d940000100ff00000000006cda40005b3334363837315d20492f6666635f7376633a2066666320" +
  "622075706461746520646f6e650a0d0a0a0d0a0a0d0a616c207469636b3a203233380a0d0a2032300a0d0a74" +
  "68206661696c65640a0d0a6c65640a0d0a000000000000000000000000000000000000000000000000000000" +
  "00000000000000000000000000000000";

const bytesFromHex = h =>
  new Uint8Array(h.match(/../g).map(b => parseInt(b, 16)));

check("log parsing keeps the live message and drops stale tails", () => {
  const raw = bytesFromHex(STATUS_READ);
  if (raw.length !== 192) throw new Error(`fixture is ${raw.length} bytes, want 192`);

  const got = parseLogMessage(raw);
  const want = "[346871] I/ffc_svc: ffc b update done";
  if (got !== want) throw new Error(`\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`);

  // The fragments that leaked through before must not come back.
  for (const junk of ["al tick", "th failed", "led", "\u0000"]) {
    if (got.includes(junk)) throw new Error(`stale fragment leaked: ${junk}`);
  }
});

check("log parsing handles the empty and short cases", () => {
  if (parseLogMessage(new Uint8Array(192)) !== "") throw new Error("all-NUL should be empty");
  if (parseLogMessage(new Uint8Array(8)) !== "") throw new Error("short read should be empty");
});

check("log buffer trims on a line boundary", () => {
  const text = "aaa\nbbb\nccc\nddd";
  const out = trimTo(text, 7);
  if (out.includes("\naaa") || out.startsWith("aa")) throw new Error(`ragged cut: ${out}`);
  if (out.length > text.length) throw new Error("grew");
  if (trimTo("short", 100) !== "short") throw new Error("trimmed when it should not");
});

console.log(`\n${failures ? `${failures} failure(s)` : "all passed"}`);
process.exit(failures ? 1 : 0);
