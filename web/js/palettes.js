// Colour palettes, each a list of stops expanded once into a 256-entry LUT.

export const PALETTES = {
  "Ironbow":   [[0,0,0],[35,0,80],[120,0,120],[200,40,60],[245,120,10],[255,215,40],[255,255,220]],
  "White hot": [[0,0,0],[255,255,255]],
  "Black hot": [[255,255,255],[0,0,0]],
  "Rainbow":   [[0,0,60],[0,80,220],[0,200,190],[70,220,60],[240,220,0],[240,110,0],[220,0,0]],
  "Lava":      [[0,0,0],[90,0,0],[190,30,0],[245,130,0],[255,225,120],[255,255,255]],
  "Arctic":    [[8,10,30],[20,70,150],[70,170,220],[190,230,245],[255,250,210],[255,190,60]],
  "Medical":   [[0,0,0],[0,0,140],[130,0,180],[230,60,90],[255,170,50],[255,255,255]],
};

function buildLut(stops) {
  const lut = new Uint8Array(256 * 3);
  const segs = stops.length - 1;
  for (let i = 0; i < 256; i++) {
    const p = (i / 255) * segs;
    const s = Math.min(Math.floor(p), segs - 1);
    const f = p - s;
    for (let c = 0; c < 3; c++) {
      lut[i * 3 + c] = stops[s][c] + (stops[s + 1][c] - stops[s][c]) * f;
    }
  }
  return lut;
}

export const LUTS = Object.fromEntries(
  Object.entries(PALETTES).map(([name, stops]) => [name, buildLut(stops)]),
);
