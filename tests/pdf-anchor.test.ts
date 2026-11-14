import { describe, expect, it } from "vitest";
import { anchorFragments, anchorPage, anchorPagesLabel, clonePdfAnchor } from "../src/core/pdf-anchor";
import { exportMarkdown, exportProject, importProject } from "../src/core/archive";
import { createBranch } from "../src/core/branches";
import { sourceForAnchor } from "../src/core/source-location";
import type { Anchor, Project } from "../src/types";

function selected(): Anchor {
  const fragments = [
    { page: 1, rects: [[10, 10, 120, 25] as [number, number, number, number]], quote: "第一页末尾 [截图](asset:crop-one)" },
    { page: 2, rects: [[15, 700, 180, 720] as [number, number, number, number]], quote: "第二页开头" },
  ];
  return { page: 1, rects: fragments[0].rects.map(rect => [...rect]), quote: fragments.map(part => part.quote).join("\n"), fragments };
}

function fixture(): Project {
  return {
    version: 1,
    document: { id: "document", name: "cross-page.pdf", fingerprint: "pdf", pdf: new Blob(["%PDF-1.4 fixture"]), pageCount: 3, createdAt: 1, updatedAt: 1 },
    pages: [], view: { page: 1, scale: 1, rotation: 0, direction: "horizontal" },
    templates: [{ id: "template", name: "解释", task: "explain", body: "{{selected_text}}", version: 1 }],
    assets: ["crop-one", "crop-two"].map((id, index) => ({ id, name: `${id}.png`, mime: "image/png", data: new Blob([id], { type: "image/png" }), source: { page: index + 1, rect: [10, 10, 20, 20] } })),
    notes: [{ id: "note", title: "跨页便签", anchor: selected(), sourceAssetId: "crop-one", sourceAssetIds: ["crop-one", "crop-two"], inheritedHistory: [], collapsed: false, task: "explain", templateId: "template", draft: "", draftAssetIds: ["crop-one", "crop-two"], createdAt: 1,
      messages: [{ id: "answer", role: "assistant", content: "回答 [S1] [S2]", assetIds: [], status: "complete", createdAt: 1, sources: [{ id: "S1", page: 1, text: "第一页末尾", rects: [[10, 10, 120, 25]] }, { id: "S2", page: 2, text: "第二页开头", rects: [[15, 700, 180, 720]] }] }],
    }],
  };
}

describe("page-local anchor fragments", () => {
  it("keeps legacy single-page shapes and exposes every multi-page piece", () => {
    const anchor = selected(), single = { page: 2, rects: [[1, 2, 3, 4] as [number, number, number, number]], quote: "single" };
    expect(anchorFragments(single)).toEqual([single]);
    expect(anchorFragments(single)[0]).toBe(single);
    expect(anchorFragments(anchor)).toBe(anchor.fragments);
    expect(anchorPage(anchor, 2)).toBe(anchor.fragments![1]);
    expect(anchorPage(anchor, 3)).toBeUndefined();
    expect(anchorPagesLabel(single)).toBe("第 2 页");
    expect(anchorPagesLabel(anchor)).toBe("第 1–2 页");
    expect(anchorPagesLabel({ ...anchor, fragments: [anchor.fragments![0], { ...anchor.fragments![1], page: 3 }] })).toBe("第 1、3 页");
    expect(clonePdfAnchor(single)).not.toHaveProperty("fragments");
  });

  it("deep-copies coordinates and remaps both combined and page-local quotes", () => {
    const anchor = selected(), cloned = clonePdfAnchor(anchor, text => text.replace("crop-one", "new-crop"));
    expect(cloned.quote).toBe(cloned.fragments!.map(part => part.quote).join("\n"));
    expect(cloned.quote).toContain("asset:new-crop");
    expect(cloned.fragments![0].quote).toContain("asset:new-crop");
    cloned.rects[0][0] = 50; cloned.fragments![1].rects[0][0] = 75;
    expect(anchor.rects[0][0]).toBe(10);
    expect(anchor.fragments![1].rects[0][0]).toBe(15);
    expect(cloned.fragments![0].rects[0][0]).toBe(10);
  });

  it("retains all PDF pages in a nested branch without coordinate aliasing", () => {
    const project = fixture(), note = project.notes[0];
    const child = createBranch(project, note, "answer", "回答", "explain");
    expect(child.anchor).toEqual(note.anchor);
    expect(child.anchor.fragments).not.toBe(note.anchor.fragments);
    child.anchor.fragments![1].rects[0][2] = 210;
    expect(note.anchor.fragments![1].rects[0][2]).toBe(180);
    expect(child.anchor.quote).toBe(note.anchor.quote);
  });

  it("recovers a historical selected citation only from its matching page", () => {
    const anchor = selected(), source = { id: "S1", page: 2, text: "选中原文：第二页开头\n\n当前页附近：整页上下文" };
    expect(sourceForAnchor(source, anchor)).toEqual({ ...source, text: "第二页开头", rects: anchor.fragments![1].rects });
    const resolved = sourceForAnchor(source, anchor);
    expect(resolved.rects![0]).not.toBe(anchor.fragments![1].rects[0]);
    const wrongPage = { ...source, page: 3 };
    expect(sourceForAnchor(wrongPage, anchor)).toBe(wrongPage);
    const explicit = { ...source, rects: [[1, 2, 3, 4] as [number, number, number, number]] };
    expect(sourceForAnchor(explicit, anchor)).toBe(explicit);
    const unrelated = { ...source, text: anchor.quote };
    expect(sourceForAnchor(unrelated, anchor)).toBe(unrelated);
  });
});

describe("multi-page archive compatibility", () => {
  it("exports/imports every fragment and crop, remapping independent-copy asset references", async () => {
    const project = fixture(), before = structuredClone(project.notes);
    const restored = await importProject(await exportProject(project));
    expect(project.notes).toEqual(before);
    const note = restored.notes[0];
    expect(restored.document.id).not.toBe(project.document.id);
    expect(note.id).not.toBe(project.notes[0].id);
    expect(note.anchor.fragments?.map(part => [part.page, part.rects])).toEqual(project.notes[0].anchor.fragments!.map(part => [part.page, part.rects]));
    expect(note.sourceAssetIds).toEqual(restored.assets.map(asset => asset.id));
    expect(note.sourceAssetId).toBe(note.sourceAssetIds![0]);
    expect(note.draftAssetIds).toEqual(note.sourceAssetIds);
    expect(note.anchor.quote).toContain(`asset:${note.sourceAssetIds![0]}`);
    expect(note.anchor.fragments![0].quote).toContain(`asset:${note.sourceAssetIds![0]}`);
    expect(note.anchor.quote).toBe(note.anchor.fragments!.map(part => part.quote).join("\n"));
    expect(note.messages[0].sources?.map(source => [source.page, source.rects])).toEqual([[1, [[10, 10, 120, 25]]], [2, [[15, 700, 180, 720]]]]);
    const markdown = exportMarkdown(project);
    expect(markdown).toContain("- 定位：第 1–2 页");
    expect(markdown).toContain("- 原文（第 1 页）：第一页末尾");
    expect(markdown).toContain("- 原文（第 2 页）：第二页开头");
  });

  it("keeps old single-page projects and their single source image compatible", async () => {
    const project = fixture(), note = project.notes[0];
    delete note.anchor.fragments; note.anchor.quote = "old selected text";
    delete note.sourceAssetIds;
    const restored = await importProject(await exportProject(project));
    expect(restored.notes[0].anchor).not.toHaveProperty("fragments");
    expect(restored.notes[0]).not.toHaveProperty("sourceAssetIds");
    expect(restored.notes[0].sourceAssetId).toBe(restored.assets[0].id);
    expect(exportMarkdown(project)).toContain("- 定位：第 1 页\n- 原文：old selected text");
  });

  const malformed: Array<[string, (anchor: Anchor) => void]> = [
    ["empty fragment list", anchor => { anchor.fragments = []; }],
    ["duplicate pages", anchor => { anchor.fragments![1].page = 1; }],
    ["reversed pages", anchor => { anchor.fragments!.reverse(); }],
    ["fractional page", anchor => { anchor.fragments![1].page = 1.5; }],
    ["out-of-range page", anchor => { anchor.fragments![1].page = 4; }],
    ["empty page rectangles", anchor => { anchor.fragments![1].rects = []; }],
    ["invalid rectangle", anchor => { anchor.fragments![1].rects[0] = [1, 2, 1, 4]; }],
    ["different first page", anchor => { anchor.page = 2; }],
    ["different first coordinates", anchor => { anchor.rects[0][0] = 11; }],
    ["lost trailing quote", anchor => { anchor.quote = anchor.fragments![0].quote; }],
    ["non-string fragment quote", anchor => { (anchor.fragments![1] as unknown as { quote: number }).quote = 42; }],
    ["invalid legacy page", anchor => { anchor.page = 1.5; }],
  ];
  for (const [label, mutate] of malformed) it(`rejects ${label} rather than silently dropping pages`, async () => {
    const project = fixture(); mutate(project.notes[0].anchor);
    await expect(importProject(await exportProject(project))).rejects.toThrow();
  });

  it("rejects missing, duplicated or inconsistent source crop references", async () => {
    for (const mode of ["missing", "duplicate", "first", "empty"] as const) {
      const project = fixture(), note = project.notes[0];
      if (mode === "missing") note.sourceAssetIds = ["crop-one", "absent"];
      if (mode === "duplicate") note.sourceAssetIds = ["crop-one", "crop-one"];
      if (mode === "first") note.sourceAssetIds = ["crop-two", "crop-one"];
      if (mode === "empty") note.sourceAssetIds = [];
      await expect(importProject(await exportProject(project))).rejects.toThrow();
    }
  });
});
