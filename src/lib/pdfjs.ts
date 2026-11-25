// pdf.js in the browser, loaded on first use (keeps the app bundle small). Shared by ingestion (reading pages,
// Tesseract OCR) and the source viewer in chat.
//
// pdf.js 5 decodes CCITT/JBIG2 images (the black text layer of most scanned contracts), JPEG 2000 and ICC
// colour with WebAssembly modules it loads from `wasmUrl`. Without these URLs it silently drops those images and
// scanned pages render almost blank. The files are copied from node_modules to /public/pdfjs by
// scripts/copy-assets.mjs (postinstall + build), so they always match the installed pdf.js version.

let lib: Promise<typeof import("pdfjs-dist")> | null = null;

export function loadPdfjs() {
  lib ??= import("pdfjs-dist").then((m) => {
    m.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
    return m;
  });
  return lib;
}

/** getDocument() options pointing pdf.js at its decoders and font data (absolute URLs: the worker resolves them). */
export function pdfAssetOptions() {
  const base = new URL("/pdfjs/", window.location.origin).href;
  return {
    wasmUrl: `${base}wasm/`,
    iccUrl: `${base}iccs/`,
    cMapUrl: `${base}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${base}standard_fonts/`,
  };
}
