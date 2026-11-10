import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { PDFDocumentProxy, PDFPageProxy, PageViewport } from "pdfjs-dist";
import type { PageText, Rect } from "./types";
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
): Promise<{ blob: Blob; viewport: PageViewport; crop: Rect }> {
  const viewport = page.getViewport({ scale: 2, rotation: 0 }),
    canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  await page.render({
    canvas,
    canvasContext: canvas.getContext("2d")!,
    viewport,
  }).promise;
  const crop = rect
    ? screenRect(viewport, rect)
    : ([0, 0, canvas.width, canvas.height] as Rect);
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.ceil(crop[2] - crop[0]));
  out.height = Math.max(1, Math.ceil(crop[3] - crop[1]));
  out
    .getContext("2d")!
    .drawImage(
      canvas,
      crop[0],
      crop[1],
      out.width,
      out.height,
      0,
      0,
      out.width,
      out.height,
    );
  const blob = await new Promise<Blob>((resolve, reject) =>
    out.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("无法生成截图"))),
      "image/png",
    ),
  );
  return { blob, viewport, crop };
}
