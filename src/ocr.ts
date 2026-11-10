import { createWorker, type Worker } from "tesseract.js";
import { normalizeRect, renderImage, type PDFPageProxy } from "./pdf";
import type { PageText, Rect, WordBox } from "./types";
let worker: Worker | undefined;
let preparing: Promise<Worker> | undefined;
let generation = 0;
let report: (value: number) => void = () => {};
export async function cancelOcr() {
  generation++;
  const active = worker;
  worker = undefined;
  preparing = undefined;
  await active?.terminate();
}
export async function recognizePage(
  page: PDFPageProxy,
  rect: Rect | undefined,
  onProgress: (n: number) => void,
): Promise<PageText> {
  report = onProgress;
  if (!worker) {
    const current = generation;
    preparing ??= createWorker(["chi_sim", "eng"], 1, {
      workerPath: "/ocr-assets/worker.min.js",
      corePath: "/ocr-assets/core",
      langPath: "/ocr-assets/lang",
      logger: (m) => {
        if (m.status === "recognizing text") report(m.progress);
      },
    });
    const created = await preparing;
    if (current !== generation) {
      await created.terminate();
      throw new Error("已取消识别");
    }
    worker = created;
  }
  const image = await renderImage(page, rect);
  const result = await worker.recognize(image.blob, {}, { blocks: true });
  const words: WordBox[] = [];
  for (const block of result.data.blocks ?? [])
    for (const paragraph of block.paragraphs)
      for (const line of paragraph.lines)
        for (const word of line.words) {
          const { x0, y0, x1, y1 } = word.bbox;
          const p1 = image.viewport.convertToPdfPoint(
              x0 + image.crop[0],
              y0 + image.crop[1],
            ),
            p2 = image.viewport.convertToPdfPoint(
              x1 + image.crop[0],
              y1 + image.crop[1],
            );
          words.push({
            text: word.text,
            confidence: word.confidence,
            rect: normalizeRect([...p1, ...p2]),
          });
        }
  const viewport = page.getViewport({ scale: 1, rotation: 0 });
  return {
    page: page.pageNumber,
    text: result.data.text,
    words,
    source: "ocr",
    status: words.length ? "ready" : "empty",
    width: viewport.width,
    height: viewport.height,
  };
}
