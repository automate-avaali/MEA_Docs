// Copies pdf.js runtime files into /public so the browser can load them without bundler config:
//   • pdf.worker.min.mjs
//   • pdfjs/wasm, iccs, cmaps, standard_fonts — decoders + font data. Without wasm/, pdf.js 5 drops CCITT/JBIG2
//     images (the text of most scanned contracts) and those pages render almost blank (see src/lib/pdfjs.ts).
// Runs on postinstall and before every build, so the files always match the installed pdf.js version.
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync } from "node:fs";

const dist = "node_modules/pdfjs-dist";
if (!existsSync(dist)) process.exit(0);

mkdirSync("public", { recursive: true });
copyFileSync(`${dist}/build/pdf.worker.min.mjs`, "public/pdf.worker.min.mjs");

rmSync("public/pdfjs", { recursive: true, force: true });
for (const dir of ["wasm", "iccs", "cmaps", "standard_fonts"]) {
  cpSync(`${dist}/${dir}`, `public/pdfjs/${dir}`, {
    recursive: true,
    // quickjs-eval runs JavaScript embedded in PDFs — scripting is not enabled here, so it isn't shipped.
    filter: (src) => !/quickjs-eval/.test(src),
  });
}
console.log("copied pdf.js worker + wasm/iccs/cmaps/standard_fonts → public/");
