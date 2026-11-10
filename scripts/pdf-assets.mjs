import { cp, mkdir } from "node:fs/promises";
for (const directory of ["cmaps", "standard_fonts", "wasm"]) {
  await mkdir("public/pdf-assets", { recursive: true });
  await cp(
    `node_modules/pdfjs-dist/${directory}`,
    `public/pdf-assets/${directory}`,
    { recursive: true },
  );
}
await mkdir("public/ocr-assets/lang", { recursive: true });
await cp(
  "node_modules/tesseract.js/dist/worker.min.js",
  "public/ocr-assets/worker.min.js",
);
await cp("node_modules/tesseract.js-core", "public/ocr-assets/core", {
  recursive: true,
});
for (const language of ["eng", "chi_sim"])
  await cp(
    `node_modules/@tesseract.js-data/${language}/4.0.0_best_int/${language}.traineddata.gz`,
    `public/ocr-assets/lang/${language}.traineddata.gz`,
  );
