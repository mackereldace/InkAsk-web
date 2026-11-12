import type { PDFPageProxy, PageViewport } from "pdfjs-dist";

export const MAX_CANVAS_PIXELS = 8 * 1024 * 1024;
export const MAX_CANVAS_SIDE = 8192;

/** Preserve CSS dimensions while keeping the backing bitmap inside Safari's canvas budget. */
export function boundedRenderRatio(width: number, height: number, requestedRatio: number): number {
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0)
    throw new RangeError("页面尺寸必须是有限正数。");
  const requested = Number.isFinite(requestedRatio) && requestedRatio > 0 ? requestedRatio : 1;
  const pixelsWide = Math.ceil(width * requested), pixelsHigh = Math.ceil(height * requested);
  if (pixelsWide <= MAX_CANVAS_SIDE && pixelsHigh <= MAX_CANVAS_SIDE && pixelsWide * pixelsHigh <= MAX_CANVAS_PIXELS)
    return requested;
  // Reserve one pixel on each side before ceil. The area reserve covers the
  // extra row/column even for a very wide or tall page, without width*height overflow.
  return Math.min(requested, (MAX_CANVAS_SIDE - 1) / width, (MAX_CANVAS_SIDE - 1) / height,
    Math.sqrt(MAX_CANVAS_PIXELS - 2 * MAX_CANVAS_SIDE - 1) / Math.sqrt(width) / Math.sqrt(height));
}

export type ReadingDirection = "vertical" | "horizontal";
interface Bounds { left: number; top: number; right: number; bottom: number }

/** Choose a page on the reading axis, excluding pages outside either viewport axis. */
export function pageAtReadingPosition(pages: { page: number; rect: Bounds }[], bounds: Bounds, direction: ReadingDirection): number | undefined {
  const horizontal = direction === "horizontal";
  const start = horizontal ? bounds.left : bounds.top;
  const extent = horizontal ? bounds.right - bounds.left : bounds.bottom - bounds.top;
  const line = start + Math.min(160, extent * 0.3);
  const distance = (rect: Bounds) => {
    const from = horizontal ? rect.left : rect.top, to = horizontal ? rect.right : rect.bottom;
    return line < from ? from - line : line >= to ? line - to + 0.001 : 0;
  };
  return pages.filter(({ rect }) => rect.right > bounds.left && rect.left < bounds.right && rect.bottom > bounds.top && rect.top < bounds.bottom)
    .sort((a, b) => distance(a.rect) - distance(b.rect) || a.page - b.page)[0]?.page;
}

interface CanvasRenderOptions {
  page: PDFPageProxy;
  viewport: PageViewport;
  destination: HTMLCanvasElement;
  isCurrent: () => boolean;
  ratio: number;
  createCanvas?: () => HTMLCanvasElement;
}

/** PDF.js owns a private canvas until completion; cancelled generations never touch the visible one. */
export function startCanvasRender({ page, viewport, destination, isCurrent, ratio, createCanvas = () => document.createElement("canvas") }: CanvasRenderOptions) {
  ratio = boundedRenderRatio(viewport.width, viewport.height, ratio);
  const buffer = createCanvas();
  buffer.width = Math.max(1, Math.ceil(viewport.width * ratio));
  buffer.height = Math.max(1, Math.ceil(viewport.height * ratio));
  const context = buffer.getContext("2d");
  if (!context) { buffer.width = 0; buffer.height = 0; throw new Error("无法创建页面画布。"); }
  let cancelled = false;
  let rendering: ReturnType<PDFPageProxy["render"]>;
  try {
    rendering = page.render({ canvas: buffer, canvasContext: context, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] });
  } catch (error) { buffer.width = 0; buffer.height = 0; throw error; }
  const promise = rendering.promise.then(() => {
    if (cancelled || !isCurrent()) return false;
    const output = destination.getContext("2d");
    if (!output) throw new Error("无法显示页面画布。");
    // No asynchronous boundary between the ownership check and the bitmap copy.
    destination.width = buffer.width;
    destination.height = buffer.height;
    output.drawImage(buffer, 0, 0);
    return true;
  }).finally(() => { buffer.width = 0; buffer.height = 0; });
  return { promise, cancel() { cancelled = true; rendering.cancel(); } };
}
