import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { PDFDocumentProxy, PDFPageProxy, PageViewport } from "pdfjs-dist";
import type { Anchor, PageText, Rect } from "./types";
import { boundedRenderRatio } from "./core/pdf-reader";
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
export { pdfjs };
export type { PDFDocumentProxy, PDFPageProxy, PageViewport };
export const normalizeRect = (r: number[]): Rect => [
  Math.min(r[0], r[2]),
  Math.min(r[1], r[3]),
  Math.max(r[0], r[2]),
  Math.max(r[1], r[3]),
];
export function screenRect(viewport: PageViewport, rect: Rect): Rect {
  return normalizeRect(viewport.convertToViewportRectangle(rect));
}
export async function openPdf(blob: Blob) {
  return pdfjs.getDocument({
    data: await blob.arrayBuffer(),
    cMapUrl: "/pdf-assets/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/pdf-assets/standard_fonts/",
    wasmUrl: "/pdf-assets/wasm/",
  }).promise;
}
export async function extractPage(
  pdf: PDFDocumentProxy,
  pageNumber: number,
): Promise<PageText> {
  const page = await pdf.getPage(pageNumber),
    content = await page.getTextContent(),
    viewport = page.getViewport({ scale: 1, rotation: 0 });
  const words = content.items.flatMap((item) => {
    if (!("str" in item) || !item.str.trim()) return [];
    const [a, b, , d, x, y] = item.transform,
      h = Math.abs(item.height || Math.hypot(b, d)),
      w = Math.abs(item.width || a);
    return [
      {
        text: item.str + (item.hasEOL ? "\n" : " "),
        rect: normalizeRect([x, y - h * 0.2, x + w, y + h * 0.8]),
      },
    ];
  });
  return {
    page: pageNumber,
    text: words.map((w) => w.text).join(""),
    words,
    source: "native",
    status: words.length ? "ready" : "empty",
    width: viewport.width,
    height: viewport.height,
  };
}
export async function renderImage(
  page: PDFPageProxy,
  rect?: Rect,
  rotation = 0,
): Promise<{ blob: Blob; viewport: PageViewport; crop: Rect }> {
  const angle = (page.rotate + rotation) % 360;
  let viewport = page.getViewport({ scale: 2, rotation: angle });
  const cropAt = (viewport: PageViewport): Rect => {
    const box = rect ? screenRect(viewport, rect) : [0, 0, viewport.width, viewport.height];
    return [Math.max(0, Math.min(viewport.width, box[0])), Math.max(0, Math.min(viewport.height, box[1])), Math.max(0, Math.min(viewport.width, box[2])), Math.max(0, Math.min(viewport.height, box[3]))];
  };
  let crop = cropAt(viewport);
  const ratio = boundedRenderRatio(crop[2] - crop[0], crop[3] - crop[1], 1);
  if (ratio < 1) { viewport = page.getViewport({ scale: 2 * ratio, rotation: angle }); crop = cropAt(viewport); }
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(crop[2] - crop[0]));
  canvas.height = Math.max(1, Math.ceil(crop[3] - crop[1]));
  try {
    const context = canvas.getContext("2d");
    if (!context) throw new Error("无法创建截图画布");
    // Render directly into the crop, preserving the original PDF viewport used
    // by OCR coordinates. No full-page intermediate bitmap is allocated.
    await page.render({ canvas, canvasContext: context, viewport, transform: [1, 0, 0, 1, -crop[0], -crop[1]] }).promise;
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("无法生成截图")), "image/png"));
    return { blob, viewport, crop };
  } finally { canvas.width = 0; canvas.height = 0; }
}

/** Preserve every selected page in one bounded attachment, in reading order. */
export async function renderAnchorImage(pdf: PDFDocumentProxy, anchor: Anchor, rotation = 0): Promise<Blob> {
  const parts = anchor.fragments?.length ? anchor.fragments : [anchor];
  const bounds = (rects: Rect[]): Rect | undefined => rects.length ? [
    Math.min(...rects.map((r) => r[0])), Math.min(...rects.map((r) => r[1])),
    Math.max(...rects.map((r) => r[2])), Math.max(...rects.map((r) => r[3])),
  ] : undefined;
  if (parts.length === 1) return (await renderImage(await pdf.getPage(parts[0].page), bounds(parts[0].rects), rotation)).blob;
  const sizes = [];
  for (const part of parts) {
    const page = await pdf.getPage(part.page);
    const viewport = page.getViewport({ scale: 2, rotation: (page.rotate + rotation) % 360 });
    const box = bounds(part.rects);
    const crop = box ? screenRect(viewport, box) : [0, 0, viewport.width, viewport.height];
    sizes.push({ part, box, width: Math.min(viewport.width, crop[2]) - Math.max(0, crop[0]),
      height: Math.min(viewport.height, crop[3]) - Math.max(0, crop[1]) });
  }
  const width = Math.max(...sizes.map((size) => size.width)), height = sizes.reduce((sum, size) => sum + size.height, 0);
  const ratio = boundedRenderRatio(width, height, 1), canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(width * ratio)); canvas.height = Math.max(1, Math.ceil(height * ratio));
  try {
    const context = canvas.getContext("2d");
    if (!context) throw new Error("无法创建截图画布");
    context.fillStyle = "white"; context.fillRect(0, 0, canvas.width, canvas.height);
    let offset = 0;
    // Decode and release one crop at a time: memory never grows with page count.
    for (const size of sizes) {
      const { blob } = await renderImage(await pdf.getPage(size.part.page), size.box, rotation);
      const bitmap = await createImageBitmap(blob);
      try { context.drawImage(bitmap, 0, offset, size.width * ratio, size.height * ratio); }
      finally { bitmap.close(); }
      offset += size.height * ratio;
    }
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("无法生成截图")), "image/png"));
  } finally { canvas.width = 0; canvas.height = 0; }
}
