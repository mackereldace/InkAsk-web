import { describe, expect, it } from "vitest";
import { sourceAnchor } from "../src/core/source-location";
import { buildContext } from "../src/core/context";
import { DEFAULT_TEMPLATES } from "../src/core/templates";
import type { Note, PageText, Project, WordBox } from "../src/types";
function page(runs: Array<[string, number]>, source: PageText["source"] = "native"): PageText {
  return {page: 1, text: runs.map(([text]) => text).join("\n\n"), words: runs.map(([text, y]) => ({text, rect: [10, y, 300, y + 15]} as WordBox)), width: 600, height: 800, source, status: "ready"};
}
const cite = (text: string) => ({ id: "S1", page: 1, text });
describe("precise source paragraph resolution", () => {
  it("finds a lower paragraph without substituting the page heading", () => {
    const text = page([["Introduction", 740], ["The derivative measures change.", 300], ["Conclusion", 100]]);
    expect(sourceAnchor(cite("The derivative measures change."), text)?.rects).toEqual([text.words[1].rect]);
  });
  it("rejects an ambiguous repeated phrase and accepts unique surrounding context", () => {
    const text = page([["First example: identical phrase.", 700], ["Second example: identical phrase.", 200]]);
    expect(sourceAnchor(cite("identical phrase"), text)).toBeUndefined();
    expect(sourceAnchor(cite("Second example: identical phrase."), text)?.rects).toEqual([text.words[1].rect]);
  });
  it("normalizes OCR punctuation, ligatures and line-end hyphenation without losing coordinates", () => {
    const text = page([["The co-", 700], ["efficient，is ﬁnite。", 680]], "ocr");
    expect(sourceAnchor(cite("The coefficient, is finite."), text)?.rects).toEqual(text.words.map((word) => word.rect));
  });
  it("matches legacy TeX delimiters and common math commands against extracted symbols", () => {
    const text = page([["For θ ≤ π, the result follows.", 200]]);
    expect(sourceAnchor(cite("For $\\theta \\leq \\pi$, the result follows."), text)?.rects).toEqual([text.words[0].rect]);
  });
  it("preserves explicit coordinates even when extraction differs, and rejects wrong-page text", () => {
    const text = page([["same words", 200]]);
    expect(sourceAnchor({...cite("OCR differs"), rects: [[1, 2, 3, 4]]}, text)?.rects).toEqual([[1, 2, 3, 4]]);
    expect(sourceAnchor({...cite("same words"), page: 2}, text)).toBeUndefined();
  });
  it("keeps each selected page's text and coordinates together and enriches retrieved paragraphs", () => {
    const p1 = page([["Selected derivative", 700], ["Derivative change in lower paragraph", 200]]);
    const p2 = {...page([["Second selected passage", 600]]), page: 2};
    const note: Note = {id: "n", title: "n", anchor: {page: 1, quote: "Selected derivative\nSecond selected passage", rects: [p1.words[0].rect], fragments: [{page: 1, quote: "Selected derivative", rects: [p1.words[0].rect]}, {page: 2, quote: "Second selected passage", rects: [p2.words[0].rect]}]}, inheritedHistory: [], collapsed: false, task: "explain", templateId: DEFAULT_TEMPLATES[0].id, draft: "", draftAssetIds: [], messages: [], createdAt: 1};
    const project: Project = {version: 1, document: {id: "d", name: "d", fingerprint: "d", pdf: new Blob(), pageCount: 2, createdAt: 1, updatedAt: 1}, pages: [p1, p2], notes: [note], assets: [], templates: DEFAULT_TEMPLATES, view: {page: 1, scale: 1, rotation: 0}};
    const result = buildContext({project, note, question: "derivative change", template: DEFAULT_TEMPLATES[0]});
    expect(result.sources.slice(0, 2)).toEqual([{id: "S1", page: 1, text: "Selected derivative", rects: [p1.words[0].rect]}, {id: "S2", page: 2, text: "Second selected passage", rects: [p2.words[0].rect]}]);
    const lower = result.sources.find((source) => source.text === "Derivative change in lower paragraph");
    expect(lower?.rects).toEqual([p1.words[1].rect]);
  });
});
