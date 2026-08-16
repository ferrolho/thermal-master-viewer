// Pure helper for the firmware log buffer.

// Keep the tail of `text` under `max` characters, cutting on a line boundary.
export function trimTo(text, max) {
  if (text.length <= max) return text;
  const cut = text.length - max;
  const nl = text.indexOf("\n", cut);
  return text.slice(nl < 0 ? cut : nl + 1);
}
