import { describe, expect, it } from "vitest";
import { deduplicateEvidence, rankEvidenceBlocks, selectEvidence } from "../src/core/evidence-retrieval";
import { buildContext } from "../src/core/context";
import { DEFAULT_TEMPLATES } from "../src/core/templates";
import type { EvidenceBlock } from "../src/core/evidence-types";
import type { Note, PageText, Project, Rect } from "../src/types";

const block = (id: string, text: string, start: number, role: EvidenceBlock["role"] = "body", page = 3): EvidenceBlock => ({id, page, text, start, end: start + text.length, rects: [[10, 100, 300, 120]], role, label: `${id}段落`});
function page(number: number, runs: Array<[string, number]>): PageText {
  const words = runs.map(([text, y]) => ({text: text + "\n", rect: [20, y, 500, y + 15] as Rect}));
  return {page: number, text: words.map(w => w.text).join(""), words, source: "native", status: "ready", width: 600, height: 840};
}
function fixture(): {project: Project; note: Note} {
  const p1 = page(1, [["T5：积分族的列紧性", 740], ["Pf: 由 Arzelà–Ascoli 定理，只需验证函数族一致有界和等度连续。", 700]]);
  const p3 = page(3, [["T8：不动点", 780], ["Pf: 由紧性可知最小值能够达到，故存在不动点。", 750], ["T9：一致有界与 Hölder 条件", 660], ["题目 5 (T9). 设 M 为紧度量空间，E 是一致有界的连续函数族，并满足 Hölder 条件。", 620], ["Pf: 对任意 ε 取 δ=(ε/C)^(1/α)，由 Hölder 不等式可知 E 等度连续，因此 E 列紧。", 570], ["整理者注", 450], ["1. 另一题中的条件需要核对，原稿的符号保持不变。", 420]]);
  const p6 = page(6, [["6", 810], ["原图 3 第 3 页：一致有界、Hölder 与列紧", 326]]);
  const note: Note = {id: "n", title: "一致有界", anchor: {page: 3, quote: "一致有界", rects: [[130, 620, 180, 635]]}, inheritedHistory: [], collapsed: false, task: "explain", templateId: DEFAULT_TEMPLATES[0].id, draft: "什么是一致有界，后面怎么使用这个条件", draftAssetIds: [], messages: [], createdAt: 1};
  const project: Project = {version: 1, document: {id: "p", name: "example.pdf", fingerprint: "p", pdf: new Blob(), pageCount: 6, createdAt: 1, updatedAt: 1}, pages: [p1, p3, p6], notes: [note], assets: [], templates: structuredClone(DEFAULT_TEMPLATES), view: {page: 3, scale: 1, rotation: 0}};
  return {project, note};
}

describe("evidence relevance and containment", () => {
  it("requires content relevance and does not promote captions through their label alone", () => {
    const headingOnly = {...block("T9 一致有界", "An unrelated sentence.", 0), section: "一致有界"};
    expect(rankEvidenceBlocks([headingOnly], "一致有界")).toEqual([]);
    expect(rankEvidenceBlocks([block("a", "the what how 条件", 0)], "the what how 条件")).toEqual([]);
    expect(rankEvidenceBlocks([block("b", "原文在此处需要核对。", 0)], "原文引用 S2，第3页")).toEqual([]);
    const caption = block("image", "原图：一致有界与 Hölder", 0, "caption", 6);
    expect(rankEvidenceBlocks([caption], "一致有界")).toEqual([]);
    expect(rankEvidenceBlocks([caption], "解释原图中的一致有界")).toHaveLength(1);
  });
  it("prefers direct theorem evidence over a long notes section with one extra generic keyword", () => {
    const theorem = block("theorem", "设 E 一致有界且满足 Hölder 不等式。", 0, "theorem");
    const notes = block("notes", `一致有界，条件。${"这里讨论另一题的原稿内容。".repeat(25)}`, 100, "note");
    expect(rankEvidenceBlocks([notes, theorem], "一致有界\n后面怎么使用这个条件")[0].block.id).toBe("theorem");
  });
  it("respects explicit theorem IDs without converting section-only matches into evidence", () => {
    const t9 = {...block("t9", "题设中函数族一致有界，结合连续性可得结论。", 100, "theorem"), section: "T9", label: "T9 · 题设"};
    const t5 = {...block("t5", "整理者注：原稿一致有界并且等度连续，由 AA 定理得到列紧；条件需要核对。", 300, "note"), section: "T5", label: "整理者注 · T5 · 4"};
    const query = "T9 题设给出一致有界；整理者注指出原稿条件需要核对。";
    expect(rankEvidenceBlocks([t5, t9], query)[0].block.id).toBe("t9");
    const metadataOnly = {...t9, text: "A completely unrelated sentence."};
    expect(rankEvidenceBlocks([metadataOnly], "T9 一致有界")).toEqual([]);
    expect(rankEvidenceBlocks([t9], "T9")).toEqual([]);
    const english = {...t9, id: "english", section: "Theorem 2.1", text: "The family is uniformly bounded.", label: "Theorem 2.1 · statement"};
    const other = {...english, id: "other", section: "Theorem 7.2", label: "Theorem 7.2 · statement"};
    expect(rankEvidenceBlocks([other, english], "Theorem 2.1: uniformly bounded")[0].block.id).toBe("english");
  });
  it("collapses nested windows while retaining separate same-page theorem and proof", () => {
    const parent = block("window", "x".repeat(1400), 0);
    const theorem = block("theorem", "t".repeat(200), 100, "theorem");
    const proof = block("proof", "p".repeat(300), 600, "proof");
    expect(deduplicateEvidence([parent, theorem, proof]).map(b => b.id)).toEqual(["theorem", "proof"]);
    expect(deduplicateEvidence([theorem, {...theorem, id: "again"}, proof]).map(b => b.id)).toEqual(["theorem", "proof"]);
    expect(deduplicateEvidence([block("plus", "$x+y$", 10), block("minus", "$x-y$", 100), block("upper", "$X-y$", 200)]).map(b => b.id)).toEqual(["plus", "minus", "upper"]);
  });
});

describe("unified context evidence", () => {
  it("selects local theorem and proof plus cross-page premise, without a repeated page window", () => {
    const {project, note} = fixture();
    const selected = selectEvidence(project, note, note.draft);
    expect(selected.length).toBeLessThanOrEqual(3);
    expect(selected.some(b => b.page === 3 && b.role === "theorem")).toBe(true);
    expect(selected.some(b => b.page === 3 && b.role === "proof")).toBe(true);
    expect(selected.some(b => b.page === 1)).toBe(true);
    expect(selected.some(b => b.page === 6 || b.role === "caption")).toBe(false);
    for (const value of selected) expect(project.pages.find(p => p.page === value.page)!.text.slice(value.start, value.end)).toBe(value.text);
    const context = buildContext({project, note, question: note.draft, template: project.templates[0]});
    expect(context.sources[0]).toEqual({id: "S1", page: 3, text: "一致有界", rects: note.anchor.rects});
    expect(context.sources.slice(1).every(s => s.blockId && s.label && s.textRange)).toBe(true);
    expect(context.sources.map(s => s.id)).toEqual(context.sources.map((_, i) => `S${i + 1}`));
    expect(context.prompt).toContain("具体证据段");
  });
  it("does not mutate stored answers and keeps branch inputs/history protected under budget pressure", () => {
    const {project, note} = fixture();
    note.parentId = "parent"; note.branchQuote = "如何理解这个回答中的一步";
    note.inheritedHistory = [{role: "user", content: "old history ".repeat(500)}];
    note.messages = [{id: "a", role: "assistant", content: "Historical answer [S8]", assetIds: [], status: "complete", createdAt: 1, sources: [{id: "S8", page: 3, text: "original context"}]}];
    const before = JSON.stringify(note);
    const result = buildContext({project, note, question: "这个条件的作用是什么", template: project.templates[0], budget: 100});
    expect(result.sources).toHaveLength(1);
    expect(result.history).toHaveLength(0);
    expect(result.truncated).toBe(true);
    expect(result.prompt).toContain(note.branchQuote);
    expect(result.prompt).toContain("当前选文来自该回答，不是 PDF 原文");
    expect(result.prompt).toContain("这个条件的作用是什么");
    expect(JSON.stringify(note)).toBe(before);
  });
});
