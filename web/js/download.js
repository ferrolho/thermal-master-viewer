// Handing a generated file to the browser.

export const stamp = () =>
  new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

export function download(name, blob) {
  const a = document.createElement("a");
  a.download = name;
  a.href = URL.createObjectURL(blob);
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
