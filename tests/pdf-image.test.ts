import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("pdfjs-dist", () => ({ GlobalWorkerOptions: {} }));
import { renderImage, type PDFPageProxy } from "../src/pdf";
import { MAX_CANVAS_PIXELS, MAX_CANVAS_SIDE } from "../src/core/pdf-reader";
function fixture(width = 600, height = 800, fail = false) {
  const canvases: { width: number; height: number; getContext: () => object; toBlob: (callback: (blob: Blob) => void) => void }[] = [];
  vi.stubGlobal("document", { createElement: () => {
    const canvas = { width: 0, height: 0, getContext: () => ({}), toBlob: (callback: (blob: Blob) => void) => callback(new Blob(["crop"], { type: "image/png" })) };
    canvases.push(canvas); return canvas;
  } });
  const render = vi.fn((options: { canvas: {width: number; height: number}; transform: number[] }) => {
    const size = { width: options.canvas.width, height: options.canvas.height };
    return { promise: fail ? Promise.reject(new Error("cancelled")) : Promise.resolve(size) };
  });
  const page = { rotate: 0, getViewport: ({scale}: {scale: number}) => ({width:width*scale,height:height*scale,scale,convertToViewportRectangle: (rect: number[]) => [rect[0]*scale,(height-rect[3])*scale,rect[2]*scale,(height-rect[1])*scale]}), render } as unknown as PDFPageProxy;
  return { page, canvases, render };
}
afterEach(() => vi.unstubAllGlobals());
describe("bounded PDF source images", () => {
  it("renders just the cited crop with matching OCR offsets and releases bitmap memory", async () => {
    const { page, canvases, render } = fixture();
    const result = await renderImage(page, [10,10,110,20]);
    expect(canvases).toHaveLength(1);
    expect(result.crop).toEqual([20,1560,220,1580]);
    expect(result.viewport.scale).toBe(2);
    expect(render.mock.calls[0][0].transform).toEqual([1,0,0,1,-20,-1560]);
    expect(await (render.mock.results[0].value.promise)).toEqual({width:200,height:20});
    expect(result.blob.type).toBe("image/png");
    expect(canvases[0].width * canvases[0].height).toBe(0);
  });
  it("bounds large full-page OCR bitmaps while returning the actual coordinate viewport", async () => {
    const {page,render}=fixture(10000,20000);
    const result=await renderImage(page);
    const size=await render.mock.results[0].value.promise;
    expect(size.width*size.height).toBeLessThanOrEqual(MAX_CANVAS_PIXELS);
    expect(Math.max(size.width,size.height)).toBeLessThanOrEqual(MAX_CANVAS_SIDE);
    expect(result.viewport.scale).toBeLessThan(2);
    expect(result.crop).toEqual([0,0,result.viewport.width,result.viewport.height]);
  });
  it("releases the private crop canvas when rendering fails", async () => {
    const {page,canvases}=fixture(600,800,true);
    await expect(renderImage(page,[10,10,110,20])).rejects.toThrow("cancelled");
    expect(canvases[0].width*canvases[0].height).toBe(0);
  });
});
