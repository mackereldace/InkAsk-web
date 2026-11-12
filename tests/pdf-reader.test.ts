import { describe, expect, it, vi } from "vitest";
import type { PDFPageProxy, PageViewport } from "pdfjs-dist";
import { boundedRenderRatio, MAX_CANVAS_PIXELS, MAX_CANVAS_SIDE, pageAtReadingPosition, startCanvasRender } from "../src/core/pdf-reader";

const viewport = { width: 600, height: 800 } as PageViewport;
function pending() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fakeCanvas() {
  const drawImage = vi.fn();
  return { width: 17, height: 23, getContext: () => ({ drawImage }), drawImage };
}
function pageJob(completion: ReturnType<typeof pending>) {
  const cancel = vi.fn(), render = vi.fn((_options: Parameters<PDFPageProxy["render"]>[0]) => ({ promise: completion.promise, cancel }));
  return { page: { render } as unknown as PDFPageProxy, render, cancel };
}

describe("PDF bitmap allocation budget", () => {
  it("keeps normal A4 DPR2 and exact budget boundaries at their requested resolution", () => {
    expect(boundedRenderRatio(595, 842, 2)).toBe(2);
    expect(boundedRenderRatio(4096, 2048, 1)).toBe(1);
    expect(boundedRenderRatio(8192, 1, 1)).toBe(1);
  });

  it("bounds ceil-rounded pixel area and side length for oversized and fractional viewports", () => {
    for (const [width, height, requested] of [[5950, 8420, 2], [12000, 10, 2], [10, 12000, 2], [4096.01, 2048.01, 1], [1e9, 1e9, 4], [1e308, 1e308, 2]]) {
      const ratio = boundedRenderRatio(width, height, requested);
      const pixelsWide = Math.max(1, Math.ceil(width * ratio)), pixelsHigh = Math.max(1, Math.ceil(height * ratio));
      expect(ratio).toBeGreaterThan(0);
      expect(ratio).toBeLessThan(requested);
      expect(pixelsWide).toBeLessThanOrEqual(MAX_CANVAS_SIDE);
      expect(pixelsHigh).toBeLessThanOrEqual(MAX_CANVAS_SIDE);
      expect(pixelsWide * pixelsHigh).toBeLessThanOrEqual(MAX_CANVAS_PIXELS);
    }
  });

  it("uses a finite default for malformed device pixel ratios and rejects invalid viewport sizes", () => {
    for (const ratio of [NaN, Infinity, -Infinity, 0, -2]) expect(boundedRenderRatio(600, 800, ratio)).toBe(1);
    for (const [width, height] of [[0, 800], [-1, 800], [600, NaN], [Infinity, 800]])
      expect(() => boundedRenderRatio(width, height, 2)).toThrow(RangeError);
  });

  it("uses the same bounded ratio for bitmap allocation and the PDF render transform", async () => {
    const oversizedViewport = { width: 6000.5, height: 8000.5 } as PageViewport;
    const output = fakeCanvas(), buffer = fakeCanvas(), completion = pending(), job = pageJob(completion);
    const ratio = boundedRenderRatio(oversizedViewport.width, oversizedViewport.height, 2);
    const frame = startCanvasRender({ page: job.page, viewport: oversizedViewport, destination: output as unknown as HTMLCanvasElement,
      isCurrent: () => true, ratio: 2, createCanvas: () => buffer as unknown as HTMLCanvasElement });
    expect(job.render.mock.calls[0][0]).toMatchObject({ viewport: oversizedViewport, transform: [ratio, 0, 0, ratio, 0, 0] });
    expect(buffer.width * buffer.height).toBeLessThanOrEqual(MAX_CANVAS_PIXELS);
    const expectedSize = [buffer.width, buffer.height];
    completion.resolve(); await frame.promise;
    expect([output.width, output.height]).toEqual(expectedSize);
    expect([oversizedViewport.width, oversizedViewport.height]).toEqual([6000.5, 8000.5]);
  });
});

describe("virtualized PDF canvas lifecycle", () => {
  it("releases the private bitmap if PDF.js rejects before returning a render task", () => {
    const buffer = fakeCanvas(), output = fakeCanvas();
    const page = { render: () => { throw new Error("document destroyed"); } } as unknown as PDFPageProxy;
    expect(() => startCanvasRender({ page, viewport, destination: output as unknown as HTMLCanvasElement,
      isCurrent: () => true, ratio: 2, createCanvas: () => buffer as unknown as HTMLCanvasElement })).toThrow("document destroyed");
    expect(buffer.width * buffer.height).toBe(0);
    expect(output.drawImage).not.toHaveBeenCalled();
  });
  it("renders privately and copies a completed frame at the current pixel ratio", async () => {
    const output = fakeCanvas(), buffer = fakeCanvas(), completion = pending(), job = pageJob(completion);
    const frame = startCanvasRender({ page: job.page, viewport, destination: output as unknown as HTMLCanvasElement,
      isCurrent: () => true, ratio: 2, createCanvas: () => buffer as unknown as HTMLCanvasElement });
    expect(job.render.mock.calls[0][0]).toMatchObject({ canvas: buffer, transform: [2, 0, 0, 2, 0, 0] });
    expect(output.width).toBe(17);
    expect(output.drawImage).not.toHaveBeenCalled();
    completion.resolve();
    expect(await frame.promise).toBe(true);
    expect([output.width, output.height]).toEqual([1200, 1600]);
    expect(output.drawImage).toHaveBeenCalledWith(buffer, 0, 0);
  });

  it("does not touch a removed canvas after asynchronous rendering completes", async () => {
    const output = fakeCanvas(), buffer = fakeCanvas(), completion = pending(), job = pageJob(completion);
    let ownsDom = true;
    const frame = startCanvasRender({ page: job.page, viewport, destination: output as unknown as HTMLCanvasElement,
      isCurrent: () => ownsDom, ratio: 1, createCanvas: () => buffer as unknown as HTMLCanvasElement });
    ownsDom = false;
    completion.resolve();
    expect(await frame.promise).toBe(false);
    expect([output.width, output.height]).toEqual([17, 23]);
    expect(output.drawImage).not.toHaveBeenCalled();
  });

  it("keeps the newest zoom frame when a cancelled older render finishes late", async () => {
    const output = fakeCanvas(), oldBuffer = fakeCanvas(), newBuffer = fakeCanvas();
    const oldDone = pending(), newDone = pending(), oldJob = pageJob(oldDone), newJob = pageJob(newDone);
    const old = startCanvasRender({ page: oldJob.page, viewport, destination: output as unknown as HTMLCanvasElement,
      isCurrent: () => true, ratio: 1, createCanvas: () => oldBuffer as unknown as HTMLCanvasElement });
    old.cancel();
    const next = startCanvasRender({ page: newJob.page, viewport: { width: 900, height: 1200 } as PageViewport,
      destination: output as unknown as HTMLCanvasElement, isCurrent: () => true, ratio: 1, createCanvas: () => newBuffer as unknown as HTMLCanvasElement });
    expect(oldJob.cancel).toHaveBeenCalledOnce();
    expect(oldJob.render.mock.calls[0][0].canvas).not.toBe(newJob.render.mock.calls[0][0].canvas);
    newDone.resolve(); await next.promise;
    oldDone.resolve(); expect(await old.promise).toBe(false);
    expect([output.width, output.height]).toEqual([900, 1200]);
    expect(output.drawImage).toHaveBeenCalledExactlyOnceWith(newBuffer, 0, 0);
  });

  it("preserves the visible frame and propagates actual PDF rendering errors", async () => {
    const output = fakeCanvas(), completion = pending(), job = pageJob(completion);
    const frame = startCanvasRender({ page: job.page, viewport, destination: output as unknown as HTMLCanvasElement,
      isCurrent: () => true, ratio: 1, createCanvas: () => fakeCanvas() as unknown as HTMLCanvasElement });
    completion.reject(new Error("Broken PDF stream"));
    await expect(frame.promise).rejects.toThrow("Broken PDF stream");
    expect([output.width, output.height]).toEqual([17, 23]);
    expect(output.drawImage).not.toHaveBeenCalled();
  });
});

describe("continuous PDF reading direction", () => {
  const bounds = { left: 100, top: 50, right: 900, bottom: 650 };
  it("tracks vertical pages at the reading line and excludes pages outside the viewport", () => {
    expect(pageAtReadingPosition([
      { page: 1, rect: { left: 200, top: -500, right: 800, bottom: 170 } },
      { page: 2, rect: { left: 200, top: 170, right: 800, bottom: 970 } },
      { page: 3, rect: { left: 1000, top: 0, right: 1600, bottom: 800 } },
    ], bounds, "vertical")).toBe(2);
  });
  it("tracks horizontal pages by X position without requiring vertical page overlap", () => {
    expect(pageAtReadingPosition([
      { page: 1, rect: { left: -400, top: 50, right: 200, bottom: 850 } },
      { page: 2, rect: { left: 200, top: 50, right: 800, bottom: 850 } },
      { page: 3, rect: { left: 800, top: 50, right: 1400, bottom: 850 } },
    ], bounds, "horizontal")).toBe(2);
    expect(pageAtReadingPosition([], bounds, "horizontal")).toBeUndefined();
  });
});
